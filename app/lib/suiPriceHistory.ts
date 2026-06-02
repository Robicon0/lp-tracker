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

const cache = new Map<string, number>();
const inFlight = new Map<string, Promise<number | null>>();

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
  if (cached != null) return cached;

  const pending = inFlight.get(date);
  if (pending) return pending;

  const promise: Promise<number | null> = (async () => {
    try {
      const url = `https://api.coingecko.com/api/v3/coins/sui/history?date=${date}&localization=false`;
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) return null;
      const json = await res.json();
      const price = json?.market_data?.current_price?.usd;
      if (typeof price === 'number' && price > 0) {
        cache.set(date, price);
        return price;
      }
      return null;
    } catch {
      return null;
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
    if (cache.has(date) || inFlight.has(date)) return Promise.resolve();
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
  return cache.get(tsToCoinGeckoDate(timestampSeconds)) ?? null;
}
