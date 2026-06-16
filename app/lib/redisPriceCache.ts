// app/lib/redisPriceCache.ts
//
// Tier 1 of the historical-price cache: a persistent, cross-instance,
// cross-user store backed by Upstash Redis (REST). It sits ABOVE the existing
// in-process `Map` in cgPriceHistory.ts and the CoinGecko source of truth.
//
// NOTE ON NAMING: the originally-specced filename `priceCache.ts` was already
// taken by the CoinGecko SPOT-price cache (fetchCachedCoinGeckoPrices), a
// load-bearing module imported by many routes. This Redis HISTORICAL-price
// layer therefore lives here, in its own file, to avoid clobbering it.
//
// Why this exists (Sprint 1.6): every Vercel function instance had its own
// in-process cache only. Cold starts re-fetched CoinGecko historical prices,
// and several users hitting /analytics concurrently each fired their own
// fetches, saturating CoinGecko's per-IP budget. Under that pressure the
// HyperEVM closed-position prewarm (60s cap) timed out, leaving ProjectX HYPE
// fee claims UNRESOLVED ("pending price resolution" banner). A persistent
// shared cache means the FIRST request that ever prices a given (token, day)
// warms it; every subsequent request — any instance, any user — gets an
// instant hit and never touches CoinGecko.
//
// Scope / exclusions (intentional, achieved by WHERE this wraps rather than by
// per-chain branches — see architecture-principles Rule 2):
//   - Only fetchTokenPriceAtDate() in cgPriceHistory.ts calls this. The Sui
//     historical path (suiPriceHistory.ts) and the CETUS spot+LKG path are
//     SEPARATE modules that never call fetchTokenPriceAtDate, so they are
//     excluded automatically. CETUS must stay process-local by design
//     (pricing-invariants Rule 1 exception, commit 26fd213).
//   - Stablecoins never reach fetchTokenPriceAtDate (callers anchor them at
//     $1 upstream), so they are never cached here either.
//
// Keyed by CoinGecko id (the actual dedup unit in cgPriceHistory), NOT by
// (chain, tokenAddress): a CoinGecko id is globally unique and chain-agnostic,
// so the same asset shares one entry across every chain.
//
// Defensive contract: this module NEVER throws and NEVER blocks. Reads return
// null on miss OR error (caller falls through to CoinGecko). Writes are
// fire-and-forget. If the env vars are missing the module degrades to a no-op
// stub so local dev still works.

import { Redis } from '@upstash/redis';
import { logPrice } from './priceLogger';

// 30 days. Historical daily prices are immutable in practice; the TTL exists
// only so an eventual CoinGecko correction can propagate, and so the free-tier
// keyspace can't grow without bound.
const TTL_SECONDS = 30 * 24 * 60 * 60; // 2,592,000

// ── Client construction ──────────────────────────────────────────────────────
// The Upstash client auto-reads UPSTASH_* / KV_* env names, but our vars are
// prefixed PRICE_CACHE_KV_* (the database is `defidesh-price-cache`), so we
// pass url + token explicitly. If either is absent we run as a no-op stub.
const REST_URL = process.env.PRICE_CACHE_KV_REST_API_URL;
const REST_TOKEN = process.env.PRICE_CACHE_KV_REST_API_TOKEN;

let redis: Redis | null = null;
if (REST_URL && REST_TOKEN) {
  try {
    redis = new Redis({ url: REST_URL, token: REST_TOKEN });
  } catch (err) {
    // Construction should never throw with a valid url/token, but stay defensive.
    console.warn('[redisPriceCache] Redis client construction failed; running as no-op stub:', err);
    redis = null;
  }
}

let warnedDisabled = false;
function warnDisabledOnce(): void {
  if (warnedDisabled) return;
  warnedDisabled = true;
  console.warn(
    '[redisPriceCache] PRICE_CACHE_KV_REST_API_URL / _TOKEN not set — Redis ' +
      'price cache disabled (no-op stub). Historical prices still resolve via ' +
      'the in-process cache + CoinGecko. Set both env vars to enable persistence.',
  );
}

export function isPriceCacheEnabled(): boolean {
  if (!redis) {
    warnDisabledOnce();
    return false;
  }
  return true;
}

// ── Per-process hit/miss/error counters ──────────────────────────────────────
// route_summary.redis_cache_hits / redis_cache_misses are computed by routes as
// a snapshot DELTA around their work (see redisCacheSnapshot). Counting lives
// here (one place) even though the redis-cache-miss [PRICE_LOG] *emission* lives
// in the caller (cgPriceHistory) per the Sprint 1.6 division of responsibility.
// Under the parallel-route analytics load a single route's delta also absorbs
// other concurrent routes' lookups, so per-route counts are APPROXIMATE; the
// process-wide hit rate (the Sprint 1.6 success metric) is exact.
let hits = 0;
let misses = 0;
let errors = 0;

export function redisCacheSnapshot(): { hits: number; misses: number; errors: number } {
  return { hits, misses, errors };
}

// ── Key builder ──────────────────────────────────────────────────────────────
// Deterministic, debuggable, chain-agnostic. The timestamp collapses to a
// UTC-midnight YYYYMMDD date so any timestamp on the same calendar day maps to
// the same key (UTC chosen so the key is identical regardless of server TZ).
function tsToUtcYmd(timestampSec: number): string {
  const d = new Date(timestampSec * 1000);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

export function buildCacheKey(coingeckoId: string, timestampSec: number): string {
  return `price:historical:${coingeckoId.toLowerCase()}:${tsToUtcYmd(timestampSec)}`;
}

// ── Read ─────────────────────────────────────────────────────────────────────
// Returns the cached USD price, or null on miss OR on any error (caller falls
// through to CoinGecko). Never throws. Emits a [PRICE_LOG] price_lookup event
// with source "redis-cache-hit" on a hit, or "redis-cache-error" on error.
// A clean miss returns null silently here — the caller emits "redis-cache-miss"
// (it owns the miss→CoinGecko fallthrough). Garbage/non-positive values are
// treated as a miss.
export async function getCachedHistoricalPrice(
  coingeckoId: string,
  timestampSec: number,
): Promise<number | null> {
  if (!redis || !coingeckoId || !Number.isFinite(timestampSec) || timestampSec <= 0) {
    return null;
  }
  const key = buildCacheKey(coingeckoId, timestampSec);
  const t0 = Date.now();
  try {
    const raw = await redis.get<number | string | null>(key);
    if (raw === null || raw === undefined) {
      misses++;
      return null;
    }
    const price = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(price) || price <= 0) {
      // Garbage data (corruption / unexpected shape) — treat as a miss.
      misses++;
      return null;
    }
    hits++;
    logPrice({
      event: 'price_lookup',
      caller: 'redisPriceCache',
      token: coingeckoId,
      targetTimestamp: timestampSec,
      attempts: [{ source: 'redis-cache-hit', token: coingeckoId, result: price, ms: Date.now() - t0 }],
      finalPrice: price,
      finalSource: 'redis-cache-hit',
      status: 'ok',
    });
    return price;
  } catch (err) {
    errors++;
    logPrice({
      event: 'price_lookup',
      caller: 'redisPriceCache',
      token: coingeckoId,
      targetTimestamp: timestampSec,
      attempts: [{ source: 'redis-cache-error', token: coingeckoId, result: null, ms: Date.now() - t0, reason: String(err) }],
      finalPrice: null,
      finalSource: null,
      status: 'failed',
    });
    return null;
  }
}

// ── Write ────────────────────────────────────────────────────────────────────
// Fire-and-forget — callers do NOT await this (it must never delay returning a
// CoinGecko price to the user). Never throws; logs and continues on error.
export async function setCachedHistoricalPrice(
  coingeckoId: string,
  timestampSec: number,
  priceUsd: number,
): Promise<void> {
  if (!redis || !coingeckoId) return;
  if (!Number.isFinite(timestampSec) || timestampSec <= 0) return;
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return;
  const key = buildCacheKey(coingeckoId, timestampSec);
  try {
    await redis.set(key, priceUsd, { ex: TTL_SECONDS });
  } catch (err) {
    console.warn('[redisPriceCache] Redis write failed (ignored):', err);
  }
}
