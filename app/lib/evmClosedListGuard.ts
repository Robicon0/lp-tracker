// Closed EVM position lists never shrink (Methodology rule (b), for EVM).
//
// The Aerodrome / Velodrome closed lists used to be rebuilt on every request
// from the wallet's history and held nowhere: when a request built a shorter
// list (an enumeration that failed part-way, a holder check that could not be
// read, or the route skipping the closed half altogether, as it did for any
// wallet whose last open position had just closed), the positions simply
// vanished from the page, their Capital G/L and fees with them. A closed
// position never reopens, so a list with fewer positions than an earlier one
// is a short scan, not news.
//
// Stored per wallet as `closed_pos_evm_v1:{protocol}:{chain}:{wallet}` (no
// expiry): the union of every closed position ever found. A fresh build is
// merged into it by id; a stored position the fresh build lacks is still
// served, counted in a `lookup-kept-stored` notice (the totals show `≈`) and
// logged. Per position the fresh record wins unless it lost its pool context
// (a minimal "Aerodrome Position" record) and the stored one has it. Outside
// production nothing is written (app/lib/sharedStore.ts).

import { createSharedRedis } from './sharedStore';
import { keptStoredNotice, type RouteTruncation } from './enumerationTruncation';

const KEY_PREFIX = 'closed_pos_evm_v1';
const sharedRedis = createSharedRedis('evmClosedListGuard');

export interface ClosedRecordLike { id: string; status?: string; poolAddress?: string; [k: string]: unknown }

export interface GuardedClosedList<T> { positions: T[]; notice: RouteTruncation | null; kept: number }

export const closedListKey = (protocol: string, chain: string, wallet: string) =>
  `${KEY_PREFIX}:${protocol}:${chain}:${wallet.toLowerCase()}`;

/** Pure merge, exported for the tests. */
export function mergeClosedLists<T extends ClosedRecordLike>(stored: readonly T[], fresh: readonly T[]): { merged: T[]; kept: T[] } {
  const storedById = new Map(stored.filter((r) => r && typeof r.id === 'string').map((r) => [r.id, r]));
  const freshIds = new Set(fresh.map((r) => r.id));
  const merged = fresh.map((r) => {
    const old = storedById.get(r.id);
    return !r.poolAddress && old?.poolAddress ? old : r;
  });
  const kept = [...storedById.values()].filter((r) => !freshIds.has(r.id) && r.status === 'Closed');
  return { merged: [...merged, ...kept], kept };
}

export async function guardClosedList<T extends ClosedRecordLike>(opts: {
  protocol: string;
  chain: string;
  wallet: string;
  /** Notice scope, e.g. "Base closed-position recovery". */
  scope: string;
  fresh: T[];
  /** For tests: a store with get / set (defaults to the shared store). */
  store?: { get: (k: string) => Promise<unknown>; set: (k: string, v: string) => Promise<unknown> } | null;
}): Promise<GuardedClosedList<T>> {
  const fresh = opts.fresh.filter((r) => r.status === 'Closed');
  const redis = opts.store !== undefined ? opts.store : sharedRedis;
  if (!redis) return { positions: fresh, notice: null, kept: 0 };
  const key = closedListKey(opts.protocol, opts.chain, opts.wallet);
  let stored: T[] = [];
  try {
    const v = await redis.get(key);
    const parsed = typeof v === 'string' ? JSON.parse(v) : v;
    if (Array.isArray(parsed)) stored = parsed as T[];
  } catch (err) {
    // A failed read of the stored list leaves this request with the fresh list
    // only; it is never written over (nothing is written without a read).
    console.warn(`[evmClosedListGuard] ${opts.protocol} ${opts.chain}: stored list could not be read (${err instanceof Error ? err.message : 'error'}); serving the fresh list`);
    return { positions: fresh, notice: null, kept: 0 };
  }
  const { merged, kept } = mergeClosedLists(stored, fresh);
  if (kept.length > 0) {
    console.warn(`[evmClosedListGuard] ${opts.protocol} ${opts.chain} ${opts.wallet}: fresh list has ${fresh.length} closed positions, stored ${stored.length}; keeping ${kept.length} from the store`);
  }
  // Written only when the list grows or a position gains its pool context;
  // records carry live prices, so a field-by-field comparison would rewrite the
  // list on every request.
  const storedById = new Map(stored.map((r) => [r.id, r]));
  const changed = merged.some((r) => !storedById.has(r.id) || (!!r.poolAddress && !storedById.get(r.id)?.poolAddress));
  if (changed && merged.length >= stored.length) {
    redis.set(key, JSON.stringify(merged)).catch((err) => console.warn(`[evmClosedListGuard] write failed (ignored): ${String(err)}`));
  }
  return {
    positions: merged,
    notice: kept.length > 0 ? keptStoredNotice(opts.scope, kept.length, merged.length) : null,
    kept: kept.length,
  };
}
