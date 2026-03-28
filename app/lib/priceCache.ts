// Shared module-level CoinGecko price cache for server-side API routes.
// All position routes import fetchCachedCoinGeckoPrices() instead of calling
// CoinGecko directly, so concurrent route invocations share one cached response.
//
// Cache key: CoinGecko token ID (e.g. "ethereum", "hyperliquid")
// Returns: { [geckoId]: usdPrice }

const cache = new Map<string, { usd: number; cachedAt: number }>();
const TTL_MS = 60_000; // 60 seconds

export async function fetchCachedCoinGeckoPrices(
  ids: string[],
): Promise<Record<string, number>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return {};

  const now = Date.now();
  const stale = unique.filter((id) => {
    const entry = cache.get(id);
    return !entry || now - entry.cachedAt > TTL_MS;
  });

  if (stale.length > 0) {
    try {
      const res = await fetch(
        `https://api.coingecko.com/api/v3/simple/price?ids=${stale.join(",")}&vs_currencies=usd`,
        { cache: "no-store" },
      );
      if (res.ok) {
        const data = await res.json();
        const fetchedAt = Date.now();
        for (const [id, val] of Object.entries(data)) {
          cache.set(id, { usd: (val as { usd: number })?.usd || 0, cachedAt: fetchedAt });
        }
      }
      // On 429 or non-ok: fall through and return whatever stale values exist
    } catch {
      // Network error: fall through and return stale values
    }
  }

  const result: Record<string, number> = {};
  for (const id of unique) {
    result[id] = cache.get(id)?.usd || 0;
  }
  return result;
}
