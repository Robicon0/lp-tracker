// Generic CoinGecko historical daily price cache, keyed by (coingeckoId, date).
//
// Background: every EVM activity route (Aerodrome / Velodrome / Uniswap V3 /
// HyperSwap / PancakeSwap) used to value fee_claim events against the pool's
// historical sqrtPriceX96 at the claim block. That gives the LP pool's
// INTERNAL price ratio, which can drift meaningfully from the actual spot
// market price the user would receive when converting claimed tokens. The
// authoritative claim-time USD is the asset's market price on the day of the
// claim — exactly what CoinGecko's /coins/{id}/history?date=DD-MM-YYYY
// endpoint returns (free, no API key, immutable past data).
//
// This module is a generic version of app/lib/suiPriceHistory.ts. The Sui
// module is kept in place (Bluefin / Cetus routes import it directly); this
// new module can be used by ANY route on ANY chain by passing a CoinGecko
// token id.
//
// Cache has NO TTL — historical daily prices are immutable; once fetched they
// stay valid for the life of the server instance. The negative cache prevents
// re-hammering CoinGecko for token/date pairs the API can't fulfil (e.g. a
// date predating the token's CG listing).
//
// Rate-limit handling: CoinGecko's free tier caps at ~5-30 req/min. A single
// HyperEVM closed position can imply ~10 unique fee_claim dates; firing all
// of those in parallel via Promise.all reliably trips a 429 on the latter
// half. The prewarm path therefore runs at bounded concurrency (default 3
// in-flight), and individual fetches retry once with backoff on transient
// failures (429, 5xx, network errors). 404s and 200-with-no-price are
// permanently cached as misses.

import { logPrice } from './priceLogger';

const cache = new Map<string, number>();              // `${id}:${DD-MM-YYYY}` → price
const inFlight = new Map<string, Promise<number | null>>();
const negativeCache = new Set<string>();              // permanent misses

// Concurrency = 1: CoinGecko's free tier reliably 429s on parallel bursts
// (e.g. a ProjectX position with 9 unique fee_claim dates would have most
// of its later dates throttled at concurrency=3, causing the route to fall
// back to current-spot prices). Sequential pacing keeps us inside the
// per-minute envelope.
const MAX_CONCURRENT_PREWARM = 1;
// Retry delays for transient failures (429 / 5xx / network). Progressive
// backoff — by the fourth retry the per-minute window has rolled over
// even from sustained pressure. Worst case ~56s wait per failed date,
// but only when CG is actively rate-limiting.
const RETRY_DELAYS_MS = [3000, 8000, 15000, 30000];

// ── PROCESS-WIDE rate limiter for ALL CoinGecko history calls ────────────────
// Sequential prewarm within a single route was not enough: when the analytics
// page fires Aerodrome + Bluefin + Cetus + Orca + HyperSwap activity routes in
// parallel, each route runs its OWN sequential prewarm chain. That sums to
// N×54 req/min on CoinGecko's free tier and the latter half of every chain
// gets 429'd, wiping usdAtTime to 0 for those fee_claim events — which the
// analytics fee-income filter drops as `usd <= 0`. The result is Aerodrome
// and Orca silently disappearing from the protocol breakdown and ProjectX
// fees over-counting (some dates fell back to current spot).
//
// Fix: every CG history HTTP call passes through ONE process-wide FIFO queue
// with a minimum gap between successive calls. Concurrency 1, no matter how
// many routes are running in parallel. Retries (3s/8s/15s/30s) also flow
// through the queue — their long backoffs absorb naturally without blocking
// other workers (each worker gets its turn in line; a worker waiting on
// retry doesn't prevent later workers from making progress).
//
// Cost: in the WORST case (12 unique HYPE/USDC fee dates from one wallet +
// nothing else in flight) cold-cache prewarm = ~13s. With Aerodrome + Orca +
// Bluefin + Cetus events also flowing through the queue, total cold-cache
// across the whole analytics page might hit 30-60s — but every date succeeds
// instead of half-failing, and once cached they're instant forever after.
const GLOBAL_CG_GAP_MS = 1100;
let globalCgQueueTail: Promise<void> = Promise.resolve();
let lastGlobalCgCallAt = 0;

export async function withCgPacing<T>(fn: () => Promise<T>): Promise<T> {
  const prev = globalCgQueueTail;
  let release: () => void = () => {};
  globalCgQueueTail = new Promise<void>((resolve) => { release = resolve; });
  try {
    await prev;
    const gap = lastGlobalCgCallAt + GLOBAL_CG_GAP_MS - Date.now();
    if (gap > 0) await sleep(gap);
    lastGlobalCgCallAt = Date.now();
    return await fn();
  } finally {
    release();
  }
}

export function tsToCoinGeckoDate(timestampSeconds: number): string {
  const d = new Date(timestampSeconds * 1000);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = d.getUTCFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

function keyOf(coingeckoId: string, date: string): string {
  return `${coingeckoId}:${date}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface FetchOutcome {
  // 'price' = success with USD; 'permanent_miss' = 404 / valid-200-no-price,
  // populate negativeCache so we never re-fetch; 'transient' = retryable.
  kind: 'price' | 'permanent_miss' | 'transient';
  price?: number;
}

async function fetchOnce(coingeckoId: string, date: string): Promise<FetchOutcome> {
  // Every CG history HTTP call passes through the process-wide queue so
  // parallel route invocations can't burst CG and trip rate limits. See
  // withCgPacing comment above.
  return withCgPacing(async () => {
    try {
      const url = `https://api.coingecko.com/api/v3/coins/${coingeckoId}/history?date=${date}&localization=false`;
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) {
        // 404 → token doesn't exist or date is pre-listing → permanent
        if (res.status === 404) return { kind: 'permanent_miss' };
        // 429 / 5xx / etc. → transient
        return { kind: 'transient' };
      }
      const json = await res.json();
      const price = json?.market_data?.current_price?.usd;
      if (typeof price === 'number' && price > 0) return { kind: 'price', price };
      // 200 OK but no market_data — token existed but no data that day.
      return { kind: 'permanent_miss' };
    } catch {
      return { kind: 'transient' };
    }
  });
}

export async function fetchTokenPriceAtDate(
  coingeckoId: string,
  timestampSeconds: number,
): Promise<number | null> {
  if (!coingeckoId) return null;
  if (!Number.isFinite(timestampSeconds) || timestampSeconds <= 0) return null;
  const date = tsToCoinGeckoDate(timestampSeconds);
  const k = keyOf(coingeckoId, date);

  const cached = cache.get(k);
  if (cached != null) {
    logPrice({
      event: 'price_lookup',
      caller: 'cgPriceHistory',
      token: coingeckoId,
      targetTimestamp: timestampSeconds,
      attempts: [{ source: 'cg-historical-cache', token: coingeckoId, result: cached }],
      finalPrice: cached,
      finalSource: 'cg-historical-cache',
      status: 'ok',
    });
    return cached;
  }
  if (negativeCache.has(k)) {
    logPrice({
      event: 'price_lookup',
      caller: 'cgPriceHistory',
      token: coingeckoId,
      targetTimestamp: timestampSeconds,
      attempts: [{ source: 'cg-historical-cache', token: coingeckoId, result: null, reason: 'negative_cache' }],
      finalPrice: null,
      finalSource: null,
      status: 'failed',
    });
    return null;
  }

  const pending = inFlight.get(k);
  if (pending) return pending;

  const promise: Promise<number | null> = (async () => {
    const __t0 = Date.now();
    try {
      let outcome = await fetchOnce(coingeckoId, date);
      // Retry on transient failures (429 rate-limit, 5xx, network errors) with
      // progressive backoff. Stops as soon as we get a definitive answer
      // (price or permanent_miss).
      for (const delay of RETRY_DELAYS_MS) {
        if (outcome.kind !== 'transient') break;
        await sleep(delay);
        outcome = await fetchOnce(coingeckoId, date);
      }
      if (outcome.kind === 'price' && typeof outcome.price === 'number') {
        cache.set(k, outcome.price);
        logPrice({
          event: 'price_lookup',
          caller: 'cgPriceHistory',
          token: coingeckoId,
          targetTimestamp: timestampSeconds,
          attempts: [{ source: 'cg-historical-fetch', token: coingeckoId, result: outcome.price, ms: Date.now() - __t0 }],
          finalPrice: outcome.price,
          finalSource: 'cg-historical-fetch',
          status: 'ok',
        });
        return outcome.price;
      }
      if (outcome.kind === 'permanent_miss') {
        negativeCache.add(k);
      }
      logPrice({
        event: 'price_lookup',
        caller: 'cgPriceHistory',
        token: coingeckoId,
        targetTimestamp: timestampSeconds,
        attempts: [{ source: 'cg-historical-fetch', token: coingeckoId, result: null, ms: Date.now() - __t0, reason: outcome.kind === 'permanent_miss' ? '404_or_no_data' : 'rate_limit_or_transient' }],
        finalPrice: null,
        finalSource: null,
        status: 'failed',
      });
      // 'transient' after all retries → return null but DO NOT poison the
      // cache, so a future request can try again.
      return null;
    } finally {
      inFlight.delete(k);
    }
  })();

  inFlight.set(k, promise);
  return promise;
}

// Pre-warm the cache for every unique (coingeckoId, date) combination implied
// by the given pairs. Runs at bounded concurrency (MAX_CONCURRENT_PREWARM in
// flight at once) — uncapped Promise.all reliably triggered 429s on
// CoinGecko's free tier when a single position implied >5 unique dates.
// After this resolves, getCachedTokenPriceForTimestamp() returns synchronously
// for any of those pairs — letting the event-build loop stay synchronous.
export async function prewarmTokenPrices(
  pairs: Array<{ coingeckoId: string; timestamps: number[] }>,
): Promise<void> {
  const seen = new Set<string>();
  const work: Array<{ coingeckoId: string; ts: number }> = [];
  for (const { coingeckoId, timestamps } of pairs) {
    if (!coingeckoId) continue;
    for (const ts of timestamps) {
      if (!Number.isFinite(ts) || ts <= 0) continue;
      const date = tsToCoinGeckoDate(ts);
      const k = keyOf(coingeckoId, date);
      if (seen.has(k) || cache.has(k) || negativeCache.has(k) || inFlight.has(k)) continue;
      seen.add(k);
      // Convert date back to a representative noon-UTC timestamp so
      // fetchTokenPriceAtDate computes the same DD-MM-YYYY key.
      const [dd, mm, yyyy] = date.split('-').map(Number);
      const repTs = Math.floor(Date.UTC(yyyy, (mm ?? 1) - 1, dd ?? 1, 12, 0, 0) / 1000);
      work.push({ coingeckoId, ts: repTs });
    }
  }
  if (work.length === 0) return;

  // Bounded-concurrency worker pool. The per-worker inter-request gap was
  // removed when the process-wide CG queue (withCgPacing) was introduced —
  // the global queue paces ALL CG calls across ALL routes, so any extra
  // sleep here would just double-count latency.
  let nextIdx = 0;
  const workers = Array.from({ length: Math.min(MAX_CONCURRENT_PREWARM, work.length) }, async () => {
    while (true) {
      const my = nextIdx++;
      if (my >= work.length) return;
      const { coingeckoId, ts } = work[my];
      await fetchTokenPriceAtDate(coingeckoId, ts);
    }
  });
  await Promise.all(workers);
}

// Synchronous cache lookup — returns null on miss. Use AFTER awaiting
// prewarmTokenPrices() so the event-build loop can stay sync.
export function getCachedTokenPriceForTimestamp(
  coingeckoId: string,
  timestampSeconds: number,
): number | null {
  if (!coingeckoId) return null;
  if (!Number.isFinite(timestampSeconds) || timestampSeconds <= 0) return null;
  return cache.get(keyOf(coingeckoId, tsToCoinGeckoDate(timestampSeconds))) ?? null;
}

// Explicit cache-only lookup — semantically identical to
// getCachedTokenPriceForTimestamp but named to make intent obvious at the
// call site: "I will NOT fetch from CoinGecko if this misses; the route
// must respond within its timeout regardless." Routes that use this should
// kick off background warming via `void prewarmTokenPrices(...)` so the
// next request's cache is warm. First-load cold-cache calls fall through
// to the histPrices (sqrtPriceX96 archive) path, which is also accurate
// historical pricing — just pool-internal price instead of CG market price.
export const getCachedOnlyTokenPrice = getCachedTokenPriceForTimestamp;
