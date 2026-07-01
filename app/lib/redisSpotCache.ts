// Sprint SPOT-RESILIENCE — cross-instance Redis tier for CURRENT (spot) prices.
//
// WHY THIS EXISTS
// The shared spot helper (priceCache.ts `fetchCachedCoinGeckoPrices`) had only a
// 60 s in-process Map cache. On a cold Vercel instance under the analytics page's
// concurrent multi-route load, CoinGecko's free-tier per-IP budget 429s and the
// helper returned 0 — which makes an OPEN position's price0/price1 = 0 and fires
// the bogus "Current price data unavailable" banner (positionPnl.ts
// missing_current_prices guard). The historical price path already has a Sprint
// 1.6 Redis tier (redisPriceCache.ts); SPOT had none. This module is the spot
// analogue: a cross-instance last-known-good (LKG) store so a transient 429
// returns a stale-but-valid price instead of 0.
//
// CONTRACT (mirrors redisPriceCache.ts / the Sprint 1.6 + 1.14 immutable-cache
// pattern): own client, same PRICE_CACHE_KV_* env, no-op stub if unset, NEVER
// throws into the hot path, fire-and-forget writes. Distinct key namespace
// `cg_spot_v1:` so it never collides with the historical (`price:historical:*`)
// keys. A spot entry carries its capture time so the caller can tell "fresh"
// (use directly) from "stale" (LKG fallback only when a live fetch fails).

import { Redis } from '@upstash/redis';

// LKG retention. Long enough that a token priced earlier in the day survives a
// CoinGecko outage across cold starts; freshness is judged by the entry's `at`,
// NOT this TTL (a 5-min "fresh" window is applied by the caller). 24h is a
// retention ceiling, not a staleness budget.
const TTL_SECONDS = 24 * 60 * 60;
const KEY_PREFIX = 'cg_spot_v1:';

export interface SpotEntry {
  usd: number;
  at: number; // ms epoch when this price was captured from CoinGecko
}

// Same env as the Sprint 1.6 historical cache (database `defidesh-price-cache`).
// The @upstash/redis client only auto-reads UPSTASH_*/KV_*, so pass explicitly.
const REST_URL = process.env.PRICE_CACHE_KV_REST_API_URL;
const REST_TOKEN = process.env.PRICE_CACHE_KV_REST_API_TOKEN;

let redis: Redis | null = null;
if (REST_URL && REST_TOKEN) {
  try {
    redis = new Redis({ url: REST_URL, token: REST_TOKEN });
  } catch (err) {
    console.warn('[redisSpotCache] Redis client construction failed; no-op stub:', err);
    redis = null;
  }
}

let _hits = 0, _misses = 0, _errors = 0;
export function spotCacheSnapshot(): { hits: number; misses: number; errors: number; enabled: boolean } {
  return { hits: _hits, misses: _misses, errors: _errors, enabled: redis != null };
}
export function isSpotCacheEnabled(): boolean {
  return redis != null;
}

// Batch read (one Redis round-trip via MGET). Returns a SpotEntry per id, or null
// for a miss. Never throws — a Redis failure degrades to all-null (the caller
// then fetches CoinGecko, exactly as before this cache existed).
export async function getSpotPrices(cgIds: string[]): Promise<Record<string, SpotEntry | null>> {
  const out: Record<string, SpotEntry | null> = {};
  if (!redis || cgIds.length === 0) {
    for (const id of cgIds) out[id] = null;
    return out;
  }
  try {
    const vals = await redis.mget<(SpotEntry | string | null)[]>(...cgIds.map((id) => KEY_PREFIX + id));
    cgIds.forEach((id, i) => {
      let v: SpotEntry | string | null = vals?.[i] ?? null;
      if (typeof v === 'string') { try { v = JSON.parse(v) as SpotEntry; } catch { v = null; } }
      const entry = v && typeof (v as SpotEntry).usd === 'number' && (v as SpotEntry).usd > 0 ? (v as SpotEntry) : null;
      out[id] = entry;
      if (entry) _hits++; else _misses++;
    });
  } catch (err) {
    _errors++;
    console.warn('[redisSpotCache] mget failed (degraded to miss):', err);
    for (const id of cgIds) out[id] = null;
  }
  return out;
}

// Fire-and-forget batch write (never blocks the hot path, never throws). Only
// writes positive prices; a 0 is never persisted (so LKG can never be a bad 0).
export function setSpotPrices(prices: Record<string, number>): void {
  if (!redis) return;
  const at = Date.now();
  for (const [id, usd] of Object.entries(prices)) {
    if (!(usd > 0)) continue;
    redis
      .set(KEY_PREFIX + id, { usd, at } as SpotEntry, { ex: TTL_SECONDS })
      .catch((err) => console.warn('[redisSpotCache] set failed (ignored):', err));
  }
}
