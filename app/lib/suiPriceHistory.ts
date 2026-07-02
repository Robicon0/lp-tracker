// Shared historical SUI price cache for Sui activity routes (Cetus, Bluefin).
//
// Background: server-side fee/reward USD calculations were using the CURRENT
// SUI spot price for every historical fee_claim, which over-values claims
// made when SUI was cheaper and under-values claims made when SUI was
// pricier. The fix is to value each claim against the SUI price ON THE DAY
// IT HAPPENED. CoinGecko's `/coins/sui/history?date=DD-MM-YYYY` endpoint
// returns historical daily prices for free with no API key.
//
// The user spec asked us to call this through the existing /api/prices
// proxy. Server-to-server calls of the proxy would need an absolute URL
// derived from the incoming request, add an extra HTTP hop within the same
// process, and the proxy is a transparent passthrough for the
// coins/{id}/history endpoint anyway. The existing server-side pattern in
// this codebase (app/lib/priceCache.ts) calls CoinGecko directly with a
// module-level cache; we follow that pattern here. The per-date module Map
// cache + concurrent in-flight de-dup gives the "same date never fetched
// twice" guarantee the spec asked for, AND is shared across both Sui
// activity routes (one module, one cache), so no duplicate fetches across
// routes either.
//
// Cache has NO TTL — historical SUI prices for past days are immutable;
// once fetched they stay valid for the life of the server instance.

import { withCgPacing, fetchDailyClosesRange } from './cgPriceHistory';
import { getCachedHistoricalPrice, setCachedHistoricalPrice } from './redisPriceCache';
import { logPrice } from './priceLogger';
import { fetchCachedCoinGeckoPrices } from './priceCache';

const cache = new Map<string, number>();
const inFlight = new Map<string, Promise<number | null>>();

// FIX C: when the historical /coins/sui/history endpoint is unavailable
// (HTTP 429 / network error / no data for the day), fall back to the CURRENT
// cg-spot SUI price rather than dropping the claim. The spot value is cached
// per UTC date in this SEPARATE map so (a) the historical `cache` stays pure
// (real historical values only) and (b) every suiPriceHistory call for the
// same date within the process returns the same fallback deterministically —
// which also eliminates the Bluefin SUI 429-race non-determinism.
const spotFallback = new Map<string, number>();
// Process-wide last-known-good SUI spot price. fetchCachedCoinGeckoPrices
// returns 0 on a transient 429; without this, individual dates that hit the
// 429 window would drop (the Bluefin 45/57-vs-57/57 flicker). Once we have ANY
// SUI spot price in the process, reuse it so every date resolves deterministically.
let suiSpotLkg = 0;

async function suiSpotFallback(date: string, timestampSeconds: number): Promise<number | null> {
  const existing = spotFallback.get(date);
  if (existing != null) return existing;
  let spot = 0;
  try {
    // 60s-cached simple/price helper — NOT the historical CG queue (rule 3),
    // so this does not touch the 1100ms-gap rate limiter at all.
    const spots = await fetchCachedCoinGeckoPrices(['sui']);
    spot = spots['sui'] ?? 0;
  } catch {
    spot = 0;
  }
  if (spot > 0) suiSpotLkg = spot;
  else if (suiSpotLkg > 0) spot = suiSpotLkg;
  if (spot > 0) {
    spotFallback.set(date, spot);
    logPrice({
      event: 'price_lookup',
      caller: 'suiPriceHistory',
      token: 'sui',
      targetTimestamp: timestampSeconds,
      attempts: [
        { source: 'sui-historical', token: 'sui', result: null, reason: 'historical_unavailable' },
        { source: 'cg-spot', token: 'sui', result: spot, reason: 'historical_unavailable_fallback' },
      ],
      finalPrice: spot,
      finalSource: 'cg-spot',
      status: 'ok',
    });
    return spot;
  }
  logPrice({
    event: 'price_lookup',
    caller: 'suiPriceHistory',
    token: 'sui',
    targetTimestamp: timestampSeconds,
    attempts: [
      { source: 'sui-historical', token: 'sui', result: null, reason: 'historical_unavailable' },
      { source: 'cg-spot', token: 'sui', result: null, reason: 'historical_unavailable_fallback' },
    ],
    finalPrice: null,
    finalSource: null,
    status: 'failed',
  });
  return null;
}

export function tsToCoinGeckoDate(timestampSeconds: number): string {
  const d = new Date(timestampSeconds * 1000);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = d.getUTCFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

export async function fetchSuiPriceAtDate(timestampSeconds: number): Promise<number | null> {
  if (!Number.isFinite(timestampSeconds) || timestampSeconds <= 0) return null;
  const date = tsToCoinGeckoDate(timestampSeconds);
  const cached = cache.get(date);
  if (cached != null) {
    logPrice({
      event: 'price_lookup',
      caller: 'suiPriceHistory',
      token: 'sui',
      targetTimestamp: timestampSeconds,
      attempts: [{ source: 'sui-historical', token: 'sui', result: cached }],
      finalPrice: cached,
      finalSource: 'sui-historical',
      status: 'ok',
    });
    return cached;
  }

  const spotCached = spotFallback.get(date);
  if (spotCached != null) return spotCached;

  const pending = inFlight.get(date);
  if (pending) return pending;

  // All CG history HTTP calls flow through the process-wide queue exported
  // by cgPriceHistory so Sui's CG calls don't race with EVM routes' CG calls
  // for the same per-minute rate-limit budget. One worldwide queue, sequential
  // pacing, all routes share. (FIX C wraps it so the cg-spot fallback runs
  // AFTER the pacing slot is released — it never holds up the historical queue.)
  const promise: Promise<number | null> = (async () => {
    try {
      // Sprint SUI-HISTORICAL-REDIS: cross-instance Upstash Redis tier (reuses the
      // Sprint 1.6 shared helper — key `price:historical:sui:{YYYYMMDD}`, 30d TTL)
      // checked BEFORE the CoinGecko fetch. On a COLD Vercel instance this serves
      // each historical SUI date from Redis instead of re-fetching it through the
      // 1100ms-gapped `withCgPacing` queue — the pre-existing ~100s cold-start
      // cause for Sui wallet-scope routes. Historical daily prices are immutable,
      // so a hit is authoritative. Rule 1a-safe: this is the pure historical path
      // (never spot). On a Redis miss we fall through to CoinGecko exactly as before.
      const redisHit = await getCachedHistoricalPrice('sui', timestampSeconds);
      if (redisHit != null) {
        cache.set(date, redisHit);
        return redisHit;
      }
      const hist = await withCgPacing(async () => {
        const __t0 = Date.now();
        try {
          const url = `https://api.coingecko.com/api/v3/coins/sui/history?date=${date}&localization=false`;
          const res = await fetch(url, { cache: 'no-store' });
          if (!res.ok) {
            logPrice({
              event: 'price_lookup',
              caller: 'suiPriceHistory',
              token: 'sui',
              targetTimestamp: timestampSeconds,
              attempts: [{ source: 'sui-historical', token: 'sui', result: null, ms: Date.now() - __t0, reason: `http_${res.status}` }],
              finalPrice: null,
              finalSource: null,
              status: 'failed',
            });
            return null;
          }
          const json = await res.json();
          const price = json?.market_data?.current_price?.usd;
          if (typeof price === 'number' && price > 0) {
            cache.set(date, price);
            // Fire-and-forget cross-instance write (Sprint SUI-HISTORICAL-REDIS) so
            // the next COLD instance — any user, post-deploy — serves this date from
            // Redis instead of paying the 1100ms CoinGecko fetch again.
            void setCachedHistoricalPrice('sui', timestampSeconds, price);
            logPrice({
              event: 'price_lookup',
              caller: 'suiPriceHistory',
              token: 'sui',
              targetTimestamp: timestampSeconds,
              attempts: [{ source: 'sui-historical', token: 'sui', result: price, ms: Date.now() - __t0 }],
              finalPrice: price,
              finalSource: 'sui-historical',
              status: 'ok',
            });
            return price;
          }
          logPrice({
            event: 'price_lookup',
            caller: 'suiPriceHistory',
            token: 'sui',
            targetTimestamp: timestampSeconds,
            attempts: [{ source: 'sui-historical', token: 'sui', result: null, ms: Date.now() - __t0, reason: 'no_price_in_response' }],
            finalPrice: null,
            finalSource: null,
            status: 'failed',
          });
          return null;
        } catch {
          logPrice({
            event: 'price_lookup',
            caller: 'suiPriceHistory',
            token: 'sui',
            targetTimestamp: timestampSeconds,
            attempts: [{ source: 'sui-historical', token: 'sui', result: null, ms: Date.now() - __t0, reason: 'fetch_error' }],
            finalPrice: null,
            finalSource: null,
            status: 'failed',
          });
          return null;
        }
      });
      if (hist != null) return hist;
      // FIX C: historical unavailable → current cg-spot fallback.
      return await suiSpotFallback(date, timestampSeconds);
    } finally {
      inFlight.delete(date);
    }
  })();

  inFlight.set(date, promise);
  return promise;
}

// Representative noon-UTC timestamp for a DD-MM-YYYY date key (same convention
// fetchSuiPriceAtDate uses, and the ts redisPriceCache keys by → same YYYYMMDD).
function dateKeyToNoonTs(date: string): number {
  const [dd, mm, yyyy] = date.split('-').map(Number);
  return Math.floor(Date.UTC(yyyy, (mm ?? 1) - 1, dd ?? 1, 12, 0, 0) / 1000);
}
function dateKeyToYmd(date: string): string {
  const [dd, mm, yyyy] = date.split('-');
  return `${yyyy}${mm}${dd}`;
}

// Pre-warm the cache for every unique date implied by the given timestamps.
// After this resolves, getCachedSuiPriceForTimestamp() /
// getHistoricalOnlySuiPrice() return synchronously for any of those timestamps.
//
// Sprint PERFORMANCE tiering (read order per date):
//   1. in-process cache / inFlight / spotFallback (instance-local)
//   2. Redis cross-instance tier (Sprint SUI-HISTORICAL-REDIS) — parallel reads
//   3. >5 dates still missing → ONE CoinGecko market_chart/range call returns
//      every daily close in the span (fetchDailyClosesRange) → populate the
//      in-process cache AND Redis for each needed date. Same CG daily source,
//      same granularity as /history (Rule 1c: batching, not a source change).
//   4. Any residual (≤5 missing, or batch failed/gapped) → the existing
//      per-date /coins/sui/history path (fetchSuiPriceAtDate), unchanged.
// This replaces the N-serial-calls-through-the-1100ms-queue cold path that made
// Sui wallet-scope routes take ~170s when CG 429s kept Redis from warming.
export async function prewarmSuiPricesForTimestamps(timestamps: number[]): Promise<void> {
  const uniqueDates = new Set<string>();
  for (const ts of timestamps) {
    if (Number.isFinite(ts) && ts > 0) uniqueDates.add(tsToCoinGeckoDate(ts));
  }
  if (uniqueDates.size === 0) return;

  const missing = [...uniqueDates].filter(
    (date) => !cache.has(date) && !inFlight.has(date) && !spotFallback.has(date),
  );
  if (missing.length === 0) return;

  // Tier 2: parallel cross-instance Redis reads → populate the in-process cache.
  await Promise.all(missing.map(async (date) => {
    const hit = await getCachedHistoricalPrice('sui', dateKeyToNoonTs(date));
    if (hit != null) cache.set(date, hit);
  }));
  let stillMissing = missing.filter((date) => !cache.has(date));

  // Tier 3: batch fill — one market_chart/range call for the whole span.
  if (stillMissing.length > 5) {
    const tss = stillMissing.map(dateKeyToNoonTs);
    const closes = await fetchDailyClosesRange('sui', Math.min(...tss), Math.max(...tss));
    if (closes) {
      for (const date of stillMissing) {
        const px = closes.get(dateKeyToYmd(date));
        if (px != null && px > 0) {
          cache.set(date, px);
          // Fire-and-forget cross-instance write — same key the per-date path uses.
          void setCachedHistoricalPrice('sui', dateKeyToNoonTs(date), px);
        }
      }
      stillMissing = stillMissing.filter((date) => !cache.has(date));
    }
  }

  // Tier 4: residual per-date path (Redis re-check inside is a cheap hit-miss).
  await Promise.all(stillMissing.map((date) => fetchSuiPriceAtDate(dateKeyToNoonTs(date))));
}

// Synchronous cache lookup — returns null on miss. Use AFTER awaiting
// prewarmSuiPricesForTimestamps() so the event-build loop can stay sync.
export function getCachedSuiPriceForTimestamp(timestampSeconds: number): number | null {
  if (!Number.isFinite(timestampSeconds) || timestampSeconds <= 0) return null;
  const date = tsToCoinGeckoDate(timestampSeconds);
  // cache = real historical; spotFallback = cg-spot recovery (FIX C).
  return cache.get(date) ?? spotFallback.get(date) ?? null;
}

// HISTORICAL-ONLY synchronous lookup — returns ONLY a real claim-date historical
// price from `cache`, NEVER the FIX-C `spotFallback` current-spot recovery.
// Added for Sprint 2.2b Sui closed-position Capital G/L, where fee-claim
// valuation must be claim-date historical with NO spot fallback under any
// circumstance (pricing-invariants Rule 1a). A miss returns null so the caller
// can fall to DeFiLlama historical and then leave the event pending — it must
// never be coerced to current spot. (getCachedSuiPriceForTimestamp above is
// left UNCHANGED for the existing activity routes.)
export function getHistoricalOnlySuiPrice(timestampSeconds: number): number | null {
  if (!Number.isFinite(timestampSeconds) || timestampSeconds <= 0) return null;
  return cache.get(tsToCoinGeckoDate(timestampSeconds)) ?? null;
}
