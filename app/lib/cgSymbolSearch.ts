// Shared CoinGecko symbol → id resolver for position routes.
//
// Every chain integration has a curated hardcoded `KNOWN_TOKENS` (or
// equivalent) map of token-address → CoinGecko ID for the zero-latency fast
// path. When a wallet holds a position pair with a token NOT in that map
// (e.g. a new USDC variant on HyperEVM, a Solana memecoin Helius DAS doesn't
// price, a brand-new Sui coin type), the route used to leave the price at 0
// and the position got excluded from P&L with a "Current price data
// unavailable" reason.
//
// This module resolves the long-tail tokens at runtime: given the token's
// on-chain symbol, search CoinGecko for a matching listing, take the first
// EXACT case-insensitive symbol match preferring market-cap-ranked coins,
// and return the CoinGecko ID. Callers then feed that ID into the existing
// CoinGecko simple-price pipeline to get a real USD price — so the position
// renders correctly without code changes per token.
//
// **Purely additive**: callers consult their hardcoded map FIRST and only
// fall through here on a miss. A null return leaves the price at 0 and the
// position still renders with value=0 (never excluded by missing pricing,
// never throws).
//
// **Cache**: module-level Map keyed by uppercased symbol with a 24h TTL.
// Negative hits (null) are cached too, so an unindexed or typo'd symbol is
// never re-searched within the window. Shared across all routes in the
// server process — Cetus and Bluefin both resolving "WAL" hit one HTTP call.
//
// **Why not the existing `/api/prices` proxy**: the proxy is browser-CORS
// only and would need an absolute-URL construction (origin from request.url)
// to call server-to-server, with no observable benefit. We follow the same
// direct-CoinGecko pattern as `app/lib/priceCache.ts` and
// `app/lib/cgPriceHistory.ts` which both call CoinGecko directly.

import { logPrice } from './priceLogger';

const cache = new Map<string, { id: string | null; expiresAt: number }>();
const inFlight = new Map<string, Promise<string | null>>();
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export async function resolveCgId(symbol: string | null | undefined): Promise<string | null> {
  if (!symbol) return null;
  const key = symbol.toUpperCase().trim();
  if (!key) return null;

  const cached = cache.get(key);
  if (cached && Date.now() < cached.expiresAt) {
    logPrice({
      event: 'price_lookup',
      caller: 'cgSymbolSearch',
      token: key,
      targetTimestamp: 'now',
      attempts: [{ source: 'symbol-search', token: key, result: null, reason: cached.id ? `resolved_id=${cached.id}` : 'symbol_not_found' }],
      finalPrice: null,
      finalSource: cached.id ? 'symbol-search' : null,
      status: cached.id ? 'ok' : 'failed',
    });
    return cached.id;
  }

  const pending = inFlight.get(key);
  if (pending) return pending;

  const promise: Promise<string | null> = (async () => {
    let id: string | null = null;
    try {
      const res = await fetch(
        `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(key)}`,
        { cache: 'no-store', headers: { Accept: 'application/json' } },
      );
      if (res.ok) {
        const data = (await res.json()) as {
          coins?: Array<{ id: string; symbol: string; market_cap_rank?: number | null }>;
        };
        const coins = data.coins ?? [];
        // CoinGecko's search is already market-cap ordered. Prefer the
        // first ranked coin with an exact symbol match (filters out unranked
        // dust that squats a popular ticker); fall back to any exact match.
        const ranked = coins.find(
          (c) => c.symbol?.toUpperCase() === key && c.market_cap_rank != null,
        );
        const anyMatch = coins.find((c) => c.symbol?.toUpperCase() === key);
        id = ranked?.id ?? anyMatch?.id ?? null;
      }
    } catch {
      id = null;
    }
    cache.set(key, { id, expiresAt: Date.now() + TTL_MS });
    logPrice({
      event: 'price_lookup',
      caller: 'cgSymbolSearch',
      token: key,
      targetTimestamp: 'now',
      attempts: [{ source: 'symbol-search', token: key, result: null, reason: id ? `resolved_id=${id}` : 'symbol_not_found' }],
      finalPrice: null,
      finalSource: id ? 'symbol-search' : null,
      status: id ? 'ok' : 'failed',
    });
    inFlight.delete(key);
    return id;
  })();

  inFlight.set(key, promise);
  return promise;
}

// Batch helper: resolve many symbols in parallel. Returns a map of
// uppercased-symbol → CoinGecko ID (entries are omitted for misses, never
// included as null — saves callers a defensive check). Order-independent.
export async function resolveCgIds(
  symbols: Iterable<string | null | undefined>,
): Promise<Record<string, string>> {
  const uniq = new Set<string>();
  for (const s of symbols) {
    if (!s) continue;
    const key = s.toUpperCase().trim();
    if (key) uniq.add(key);
  }
  if (uniq.size === 0) return {};
  const entries = await Promise.all(
    [...uniq].map(async (key) => [key, await resolveCgId(key)] as const),
  );
  const out: Record<string, string> = {};
  for (const [key, id] of entries) {
    if (id) out[key] = id;
  }
  return out;
}
