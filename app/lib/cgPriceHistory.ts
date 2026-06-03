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

const cache = new Map<string, number>();              // `${id}:${DD-MM-YYYY}` → price
const inFlight = new Map<string, Promise<number | null>>();
const negativeCache = new Set<string>();              // permanent misses

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

export async function fetchTokenPriceAtDate(
  coingeckoId: string,
  timestampSeconds: number,
): Promise<number | null> {
  if (!coingeckoId) return null;
  if (!Number.isFinite(timestampSeconds) || timestampSeconds <= 0) return null;
  const date = tsToCoinGeckoDate(timestampSeconds);
  const k = keyOf(coingeckoId, date);

  const cached = cache.get(k);
  if (cached != null) return cached;
  if (negativeCache.has(k)) return null;

  const pending = inFlight.get(k);
  if (pending) return pending;

  const promise: Promise<number | null> = (async () => {
    try {
      const url = `https://api.coingecko.com/api/v3/coins/${coingeckoId}/history?date=${date}&localization=false`;
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) {
        // 404 = no historical data for that date — record permanently so we
        // don't hammer the API. Other status codes (429, 5xx) are transient;
        // don't poison the cache.
        if (res.status === 404) negativeCache.add(k);
        return null;
      }
      const json = await res.json();
      const price = json?.market_data?.current_price?.usd;
      if (typeof price === 'number' && price > 0) {
        cache.set(k, price);
        return price;
      }
      // Valid 200 with no price field (token existed but no market data that
      // day) is also a permanent miss.
      negativeCache.add(k);
      return null;
    } catch {
      return null;
    } finally {
      inFlight.delete(k);
    }
  })();

  inFlight.set(k, promise);
  return promise;
}

// Pre-warm the cache for every unique (coingeckoId, date) combination implied
// by the given pairs. Issues one CoinGecko request per unique combo IN
// PARALLEL. After this resolves, getCachedTokenPriceForTimestamp() returns
// synchronously for any of those pairs — letting the event-build loop stay
// synchronous.
export async function prewarmTokenPrices(
  pairs: Array<{ coingeckoId: string; timestamps: number[] }>,
): Promise<void> {
  const seen = new Set<string>();
  const tasks: Array<Promise<unknown>> = [];
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
      tasks.push(fetchTokenPriceAtDate(coingeckoId, repTs));
    }
  }
  if (tasks.length > 0) await Promise.all(tasks);
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
