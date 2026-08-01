// vfat / Sickle resolution cache (`vfat_sickles_v1`).
//
// WHY THE TWO TTLs ARE DIFFERENT — this is the whole point of the module.
//
//   DEPLOYED  -> cached LONG. A Sickle is deployed once per user per chain via
//                CREATE2 and its address never changes afterwards. The mapping
//                is immutable, so re-resolving it on every page load is pure
//                waste (4 eth_calls per EVM wallet per load).
//   NOT FOUND -> cached SHORT (~5 min). "This owner has no Sickle" is NOT
//                immutable: the moment the user opens their first vfat position
//                it becomes false. A long TTL here would hide a brand-new
//                position for the length of the TTL, which is exactly the
//                invisible-position failure this sprint exists to remove.
//
// CONTRACT (mirrors redisSpotCache.ts / the Sprint 1.6 + 1.14 pattern): own
// client, same PRICE_CACHE_KV_* env, no-op stub when unset, NEVER throws into
// the hot path, fire-and-forget writes. Distinct key namespace so it cannot
// collide with the price caches.
//
// This key is VERSIONED (`_v1`) because it caches a resolved/computed result.
// Bump it if the resolution semantics ever change. Note that adding Sickle
// positions does NOT bump `lp-pnl-events` / `analytics-activity`: those cache
// per-position entries keyed by the position's own id/URL, and a Sickle-held
// position is simply a NEW entry — no existing cached entry changes shape.
// (Same reasoning as DefiTuna Phase 1's "no cache bumps".)

import { Redis } from '@upstash/redis';

const KEY_PREFIX = 'vfat_sickles_v1:';
const TTL_DEPLOYED_SECONDS = 30 * 24 * 60 * 60; // 30d — immutable once created
const TTL_EMPTY_SECONDS = 5 * 60;               // 5m — must not hide a new Sickle

export interface SickleRef {
  chain: string;
  address: string;
}

const REST_URL = process.env.PRICE_CACHE_KV_REST_API_URL;
const REST_TOKEN = process.env.PRICE_CACHE_KV_REST_API_TOKEN;

let redis: Redis | null = null;
if (REST_URL && REST_TOKEN) {
  try {
    redis = new Redis({ url: REST_URL, token: REST_TOKEN });
  } catch (err) {
    console.warn('[vfatSickleCache] Redis client construction failed; no-op stub:', err);
    redis = null;
  }
}

export function isSickleCacheEnabled(): boolean {
  return redis != null;
}

/** Cached resolution for an owner, or null on miss. Never throws. */
export async function getCachedSickles(owner: string): Promise<SickleRef[] | null> {
  if (!redis) return null;
  try {
    const v = await redis.get<SickleRef[] | string>(KEY_PREFIX + owner.toLowerCase());
    if (v == null) return null;
    const parsed = typeof v === 'string' ? (JSON.parse(v) as SickleRef[]) : v;
    return Array.isArray(parsed) ? parsed : null;
  } catch (err) {
    console.warn('[vfatSickleCache] get failed (degraded to miss):', err);
    return null;
  }
}

/**
 * Fire-and-forget write. TTL depends on whether anything was found — see the
 * header. `complete` is false when at least one chain's RPC failed this load:
 * a PARTIAL empty must never be cached, or a transient RPC blip would freeze in
 * as "no Sickle" for the empty TTL (the Sprint 1.14 immutable-cache lesson).
 */
export function setCachedSickles(owner: string, sickles: SickleRef[], complete: boolean): void {
  if (!redis) return;
  if (sickles.length === 0 && !complete) return; // partial empty: never cache
  const ttl = sickles.length > 0 ? TTL_DEPLOYED_SECONDS : TTL_EMPTY_SECONDS;
  redis
    .set(KEY_PREFIX + owner.toLowerCase(), sickles, { ex: ttl })
    .catch((err) => console.warn('[vfatSickleCache] set failed (ignored):', err));
}
