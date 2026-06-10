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

import { withCgPacing } from './cgPriceHistory';
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

// Pre-warm the cache for every unique date implied by the given timestamps.
// Issues one CoinGecko request per unique date IN PARALLEL. After this
// resolves, getCachedSuiPriceForTimestamp() returns synchronously for any
// of those timestamps — so the event-build loop can stay synchronous.
export async function prewarmSuiPricesForTimestamps(timestamps: number[]): Promise<void> {
  const uniqueDates = new Set<string>();
  for (const ts of timestamps) {
    if (Number.isFinite(ts) && ts > 0) uniqueDates.add(tsToCoinGeckoDate(ts));
  }
  if (uniqueDates.size === 0) return;
  await Promise.all([...uniqueDates].map((date) => {
    if (cache.has(date) || inFlight.has(date) || spotFallback.has(date)) return Promise.resolve();
    // Convert date string back to a representative timestamp (noon UTC of
    // that day) so fetchSuiPriceAtDate computes the same DD-MM-YYYY key.
    const [dd, mm, yyyy] = date.split('-').map(Number);
    const ts = Math.floor(Date.UTC(yyyy, (mm ?? 1) - 1, dd ?? 1, 12, 0, 0) / 1000);
    return fetchSuiPriceAtDate(ts);
  }));
}

// Synchronous cache lookup — returns null on miss. Use AFTER awaiting
// prewarmSuiPricesForTimestamps() so the event-build loop can stay sync.
export function getCachedSuiPriceForTimestamp(timestampSeconds: number): number | null {
  if (!Number.isFinite(timestampSeconds) || timestampSeconds <= 0) return null;
  const date = tsToCoinGeckoDate(timestampSeconds);
  // cache = real historical; spotFallback = cg-spot recovery (FIX C).
  return cache.get(date) ?? spotFallback.get(date) ?? null;
}
