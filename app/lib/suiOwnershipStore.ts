// Ownership verdicts for Sui positions (standing rule (k)), stored once.
//
// Key `sui_pos_owner_v1:{protocol}:{wallet}` → { [positionId]: verdict }. No
// expiry: a "held" verdict never changes (a wallet that held a position once has
// held it), and a "not held" verdict for a CLOSED position cannot change either
// (the object no longer exists). A "not held" verdict for a position that was
// still open is stored with `open: true` and is read from the chain again on
// every scan until it closes.
//
// Written only from a successful chain read (positionOwnership.ts); a failed read
// stores nothing and is asked again on a later scan. Not written while
// CLOSED_POS_CACHE_READONLY=1 (a local run keeps it in memory).

import { Redis } from '@upstash/redis';
import type { OwnershipVerdict } from './positionOwnership';

/** `open`: the position still existed when this was read (re-read on the next scan). */
export type StoredVerdict = { held: true; open?: undefined } | (Extract<OwnershipVerdict, { held: false }> & { open?: true });
type VerdictMap = Record<string, StoredVerdict>;

const _url = process.env.PRICE_CACHE_KV_REST_API_URL;
const _token = process.env.PRICE_CACHE_KV_REST_API_TOKEN;
let _redis: Redis | null = null;
if (_url && _token) {
  try { _redis = new Redis({ url: _url, token: _token }); }
  catch (err) { console.warn('[suiOwnershipStore] Redis client construction failed; no-op stub:', err); _redis = null; }
}
const readOnly = () => process.env.CLOSED_POS_CACHE_READONLY === '1';
const keyOf = (protocol: string, wallet: string) => `sui_pos_owner_v1:${protocol}:${wallet.toLowerCase()}`;

// Process memory: everything learned here, stored or not (open positions,
// read-only runs). Read on top of the store.
const _memory = new Map<string, VerdictMap>();

export async function readOwnershipVerdicts(protocol: string, wallet: string): Promise<VerdictMap> {
  const key = keyOf(protocol, wallet);
  let stored: VerdictMap = {};
  if (_redis) {
    try {
      const v = await _redis.get<VerdictMap | string>(key);
      if (typeof v === 'string') { try { stored = JSON.parse(v) as VerdictMap; } catch { stored = {}; } }
      else if (v && typeof v === 'object') stored = v;
    } catch (err) { console.warn('[suiOwnershipStore] read failed (treated as none):', String(err).slice(0, 120)); }
  }
  return { ...stored, ...(_memory.get(key) ?? {}) };
}

export async function recordOwnershipVerdicts(protocol: string, wallet: string, verdicts: VerdictMap): Promise<void> {
  const ids = Object.keys(verdicts);
  if (ids.length === 0) return;
  const key = keyOf(protocol, wallet);
  _memory.set(key, { ...(_memory.get(key) ?? {}), ...verdicts });
  if (!_redis || readOnly()) return;
  const toStore = verdicts;
  try {
    const cur = await _redis.get<VerdictMap | string>(key);
    const base: VerdictMap = typeof cur === 'string' ? JSON.parse(cur) : (cur ?? {});
    await _redis.set(key, { ...base, ...toStore });
  } catch (err) { console.warn('[suiOwnershipStore] write failed (ignored):', String(err).slice(0, 120)); }
}

/** Tests only. */
export function _resetOwnershipMemory(): void { _memory.clear(); }
