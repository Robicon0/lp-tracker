// Never-shrink guard for the closed-position caches (Sui + Solana).
//
// A closed position is immutable: once it has been found it stays true forever.
// The history scan that finds it is NOT reliable forever — a provider can stop
// serving old transactions (the Sui endpoint went from full history to about one
// week) and a short answer looks exactly like a wallet with little history. So
// this module owns three rules for both chains:
//
//   1. NEVER SHRINK. A rescan may add positions to a cached list. It can never
//      remove one, and it can never replace a cached position with a version
//      that carries fewer events. Merge is by position id.
//   2. NO EXPIRY ON FOUND POSITIONS. A non-empty list is stored without a TTL.
//      The 30-day mark only triggers a refresh ATTEMPT; a failed or short
//      attempt leaves the stored list exactly as it was.
//   3. A SHORT SCAN IS NEVER WRITTEN. Its positions are returned for this
//      request (merged over the cached list) with `incomplete: true`, which the
//      routes turn into the existing "couldn't verify" notice.
//
// The stored VALUE of a position key stays a plain JSON array, byte-compatible
// with what older deployments read. Bookkeeping lives in a sibling meta key so a
// deployment that predates this module can still read the list.
//
// No imports on purpose: the B7 script loads this file directly under Node.

export interface ClosedCacheBackend {
  get(key: string): Promise<unknown>;
  set(key: string, value: string, opts?: { ex: number }): Promise<unknown>;
  /** Seconds to expiry; -1 = no expiry, -2 = no such key. */
  ttl(key: string): Promise<number>;
  persist(key: string): Promise<unknown>;
}

export interface ClosedCacheSlot { name: string; key: string }

export interface ClosedScanResult<T> {
  bySlot: Record<string, T[]>;
  /** False when the scan could not prove it saw the wallet's whole history. */
  complete: boolean;
}

export interface ClosedCacheMeta {
  /** Last time a COMPLETE scan confirmed this list (ms). */
  refreshedAt: number;
  /** Last time any refresh was attempted (ms). */
  lastAttemptAt?: number;
  lastAttemptComplete?: boolean;
  /** The history mark the list was last built from (see GuardedLoadOptions.mark). */
  mark?: string;
}

export interface GuardedClosedResult<T> {
  bySlot: Record<string, T[]>;
  /** True when the newest scan for this wallet was short or failed. */
  incomplete: boolean;
  scanned: boolean;
}

export interface GuardedLoadOptions<T> {
  backend: ClosedCacheBackend | null;
  slots: ClosedCacheSlot[];
  /**
   * `cached` is what is stored per slot right now. A scan may use it to skip
   * work for positions that are already stored (they are kept by the merge
   * whatever the scan returns for them).
   */
  scan: (cached: Record<string, T[]>) => Promise<ClosedScanResult<T>>;
  idOf: (p: T) => string;
  /** Size of a position record; a rescan only replaces a cached record with a strictly larger one. */
  weightOf: (p: T) => number;
  isValid: (p: unknown) => boolean;
  /** TTL for a provably-complete EMPTY list, or null to never store an empty list. */
  emptyTtlSeconds: number | null;
  /** TTL older deployments wrote non-empty lists with; used to date a list that has no meta yet. */
  legacyTtlSeconds: number;
  /**
   * Identifies the history the caller would scan now (e.g. "how many
   * transactions with position events, and the newest one"). When it differs
   * from the mark stored with a list, the list is rebuilt and merged — this is
   * how a position closed today appears today without waiting for the 30-day
   * refresh. Omit it for a source that cannot tell cheaply whether history grew.
   */
  mark?: string;
  refreshAfterSeconds?: number;
  retryAfterSeconds?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

const DAY = 24 * 60 * 60;
export const CLOSED_REFRESH_AFTER_SECONDS = 30 * DAY;
export const CLOSED_RETRY_AFTER_SECONDS = 6 * 60 * 60;

/** Test knobs. READONLY keeps a local run from writing to the shared store. */
function envReadOnly(): boolean {
  return typeof process !== 'undefined' && process.env?.CLOSED_POS_CACHE_READONLY === '1';
}
function envRefreshAfter(): number | null {
  const raw = typeof process !== 'undefined' ? process.env?.CLOSED_POS_REFRESH_AFTER_SECONDS : undefined;
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function closedMetaKey(positionsKey: string): string {
  return `closed_pos_meta_v1:${positionsKey}`;
}

/**
 * Union of cached and fresh by position id. Cached order is kept and new
 * positions are appended. The result always contains every cached id, and a
 * cached record is replaced only by a fresh one that carries MORE events.
 */
export function mergeClosedPositions<T>(
  cached: readonly T[],
  fresh: readonly T[],
  idOf: (p: T) => string,
  weightOf: (p: T) => number,
): T[] {
  const freshById = new Map<string, T>();
  for (const p of fresh) freshById.set(idOf(p), p);
  const seen = new Set<string>();
  const out: T[] = [];
  for (const c of cached) {
    const id = idOf(c);
    seen.add(id);
    const f = freshById.get(id);
    out.push(f !== undefined && weightOf(f) > weightOf(c) ? f : c);
  }
  for (const p of fresh) {
    const id = idOf(p);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(p);
  }
  return out;
}

function parseList<T>(raw: unknown, isValid: (p: unknown) => boolean): T[] | null {
  if (raw == null) return null;
  let arr: unknown = raw;
  if (typeof raw === 'string') { try { arr = JSON.parse(raw); } catch { return null; } }
  if (!Array.isArray(arr) || !arr.every(isValid)) return null;
  return arr as T[];
}

function parseMeta(raw: unknown): ClosedCacheMeta | null {
  if (raw == null) return null;
  let m: unknown = raw;
  if (typeof raw === 'string') { try { m = JSON.parse(raw); } catch { return null; } }
  if (!m || typeof m !== 'object') return null;
  const r = (m as { refreshedAt?: unknown }).refreshedAt;
  return typeof r === 'number' && Number.isFinite(r) ? (m as ClosedCacheMeta) : null;
}

interface SlotState<T> {
  slot: ClosedCacheSlot;
  cached: T[] | null;
  meta: ClosedCacheMeta | null;
}

/**
 * Read every slot, decide whether a scan is due, and apply the three rules.
 * Reads never throw (a failed read is a miss). A scan failure propagates only
 * when there is nothing cached to fall back on.
 */
export async function loadClosedPositionsGuarded<T>(opts: GuardedLoadOptions<T>): Promise<GuardedClosedResult<T>> {
  const now = (opts.now ?? Date.now)();
  const readOnly = envReadOnly();
  const refreshAfterMs = (opts.refreshAfterSeconds ?? envRefreshAfter() ?? CLOSED_REFRESH_AFTER_SECONDS) * 1000;
  const retryAfterMs = (opts.retryAfterSeconds ?? CLOSED_RETRY_AFTER_SECONDS) * 1000;
  const log = opts.log ?? (() => {});
  const backend = opts.backend;

  const write = (fn: () => Promise<unknown>): Promise<void> =>
    readOnly || !backend ? Promise.resolve() : fn().then(() => undefined, (err) => log(`write failed (ignored): ${String(err)}`));

  const states: SlotState<T>[] = await Promise.all(opts.slots.map(async (slot): Promise<SlotState<T>> => {
    if (!backend) return { slot, cached: null, meta: null };
    try {
      const cached = parseList<T>(await backend.get(slot.key), opts.isValid);
      if (!cached || cached.length === 0) return { slot, cached, meta: null };
      let meta = parseMeta(await backend.get(closedMetaKey(slot.key)));
      // Rule 2 — a found position must not drop off. A list written by an older
      // deployment still carries a TTL: date it from that TTL, then remove it.
      const ttl = await backend.ttl(slot.key);
      if (!meta) {
        const age = ttl > 0 ? Math.max(0, opts.legacyTtlSeconds - ttl) * 1000 : 0;
        meta = { refreshedAt: now - age };
        await write(() => backend.set(closedMetaKey(slot.key), JSON.stringify(meta)));
      }
      if (ttl > 0) await write(() => backend.persist(slot.key));
      return { slot, cached, meta };
    } catch {
      return { slot, cached: null, meta: null };
    }
  }));

  const isStale = (s: SlotState<T>) => !!s.meta && now - s.meta.refreshedAt > refreshAfterMs;
  const isDue = (s: SlotState<T>) => isStale(s) && now - (s.meta?.lastAttemptAt ?? 0) > retryAfterMs;
  const markMoved = (s: SlotState<T>) =>
    opts.mark !== undefined && (s.cached?.length ?? 0) > 0 && s.meta?.mark !== opts.mark;
  const needScan = states.some((s) => s.cached === null || isDue(s) || markMoved(s));

  if (!needScan) {
    const bySlot: Record<string, T[]> = {};
    for (const s of states) bySlot[s.slot.name] = s.cached ?? [];
    // Stale, and the last attempt came back short: still the best list we have,
    // but say so on every load, not only on the load that ran the scan.
    const incomplete = states.some((s) => isStale(s) && s.meta?.lastAttemptComplete === false);
    return { bySlot, incomplete, scanned: false };
  }

  const haveCached = states.some((s) => (s.cached?.length ?? 0) > 0);
  let scan: ClosedScanResult<T>;
  try {
    const cachedBySlot: Record<string, T[]> = {};
    for (const s of states) cachedBySlot[s.slot.name] = s.cached ?? [];
    scan = await opts.scan(cachedBySlot);
  } catch (err) {
    if (!haveCached) throw err;
    log(`scan failed, serving cached list: ${String(err)}`);
    scan = { bySlot: {}, complete: false };
  }

  const bySlot: Record<string, T[]> = {};
  for (const s of states) {
    const cached = s.cached ?? [];
    const merged = mergeClosedPositions(cached, scan.bySlot[s.slot.name] ?? [], opts.idOf, opts.weightOf);
    bySlot[s.slot.name] = merged;

    if (!scan.complete) {
      // Rule 3 — nothing about a short scan reaches the positions key. Only the
      // attempt is recorded, so a stale list is not rescanned on every load.
      if (cached.length > 0 && s.meta) {
        const meta: ClosedCacheMeta = { ...s.meta, lastAttemptAt: now, lastAttemptComplete: false };
        await write(() => backend!.set(closedMetaKey(s.slot.key), JSON.stringify(meta)));
      }
      continue;
    }
    if (merged.length === 0) {
      if (opts.emptyTtlSeconds != null) {
        const ex = opts.emptyTtlSeconds;
        await write(() => backend!.set(s.slot.key, '[]', { ex }));
      }
      continue;
    }
    // Rule 1 holds by construction: `merged` contains every cached id.
    const meta: ClosedCacheMeta = {
      refreshedAt: now, lastAttemptAt: now, lastAttemptComplete: true,
      ...(opts.mark !== undefined ? { mark: opts.mark } : {}),
    };
    await write(() => backend!.set(s.slot.key, JSON.stringify(merged)));
    await write(() => backend!.set(closedMetaKey(s.slot.key), JSON.stringify(meta)));
  }
  return { bySlot, incomplete: !scan.complete, scanned: true };
}
