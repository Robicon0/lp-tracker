// Dynamic CoinGecko symbol → ID resolver with a long-lived in-memory cache.
// Used as the LAST-RESORT price fallback by every protocol route after the
// route's existing hardcoded KNOWN_TOKENS map and any chain-specific
// fallback (Helius DAS for Solana, etc.) fail to produce a price.
//
// Why symbol-based: per-chain address-based CoinGecko endpoints exist
// (/coins/{platform}/contract/{address}) but require maintaining a
// CHAIN → CoinGecko-platform-id map AND fire 1 request per token. The
// /search endpoint accepts a free-text query and returns up to a few
// dozen candidates ordered by market cap, so we get one request per
// UNIQUE symbol (across all chains) and pick the top exact match.
//
// Symbol uniqueness caveat: a memecoin can squat a popular ticker. We
// take the FIRST exact-symbol-match (case-insensitive) from CoinGecko's
// search results, which are ordered by market cap → top result is the
// legit token in practice. If a future user reports a wrong-token match
// for symbol X, upgrade to address-based lookup ONLY for that chain via
// per-chain CoinGecko platform IDs.
//
// Failure mode: returns null / 0 on any error (CG 429, network failure,
// no match, empty symbol). NEVER throws. Caller treats null as
// "unknown — leave price=0, position still surfaces" rather than
// excluding the position.

import { fetchCachedCoinGeckoPrices } from "./priceCache";

// Cache: UPPER(symbol) → { id: string | null, expiresAt }
// `id: null` is cached intentionally — repeat searches for typo / unindexed
// tokens shouldn't keep hitting CoinGecko.
const cgIdCache = new Map<string, { id: string | null; expiresAt: number }>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours per user spec

interface CgSearchResponse {
  coins?: Array<{
    id: string;
    symbol: string;
    name: string;
    market_cap_rank?: number | null;
  }>;
}

/**
 * Resolve a token symbol (e.g. "RENDER", "FARTCOIN") to its CoinGecko ID
 * (e.g. "render-token", "fartcoin"). Returns null when no exact-symbol-match
 * is found, the request fails, or the symbol is empty.
 *
 * Cached for 24 hours per symbol (both hits AND misses) so the same symbol
 * is never searched twice per server-instance lifetime.
 */
export async function resolveCgIdBySymbol(symbol: string): Promise<string | null> {
  const key = symbol.toUpperCase().trim();
  if (!key) return null;

  const cached = cgIdCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.id;

  let id: string | null = null;
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(key)}`,
      { cache: "no-store", headers: { Accept: "application/json" } },
    );
    if (res.ok) {
      const data = (await res.json()) as CgSearchResponse;
      const coins = data.coins ?? [];
      // CoinGecko search is ordered by market_cap_rank (best first).
      // Take the first coin whose symbol matches exactly. Filter out
      // unranked coins (market_cap_rank null) AFTER falling back — a low-
      // cap legit token may still be the only match for a niche symbol.
      const ranked = coins.find(
        (c) => c.symbol.toUpperCase() === key && c.market_cap_rank != null,
      );
      const anyMatch = coins.find((c) => c.symbol.toUpperCase() === key);
      id = ranked?.id ?? anyMatch?.id ?? null;
    } else {
      console.warn(`[cgSymbolResolve] search HTTP ${res.status} for symbol=${key}`);
    }
  } catch (err) {
    console.warn(`[cgSymbolResolve] search threw for symbol=${key}:`, err);
    id = null;
  }

  cgIdCache.set(key, { id, expiresAt: Date.now() + CACHE_TTL_MS });
  if (id) {
    console.log(`[cgSymbolResolve] resolved ${key} → ${id}`);
  } else {
    console.log(`[cgSymbolResolve] no match for ${key} (cached for 24h)`);
  }
  return id;
}

/**
 * Resolve a list of (key, symbol) pairs to USD prices, keyed by the same
 * key the caller supplied. Useful when each protocol route has its own
 * addressing scheme (Solana mint, EVM address, Sui coin type, …) but
 * wants prices for tokens that aren't in its hardcoded KNOWN_TOKENS map.
 *
 * Skips entries with empty symbols. Returns an empty Record when nothing
 * resolves — the caller should merge with its existing price map and
 * treat missing entries as 0 (do NOT exclude positions).
 */
export async function fetchPricesByUnknownTokens(
  tokens: Array<{ key: string; symbol: string }>,
): Promise<Record<string, number>> {
  const dedupedBySymbol = new Map<string, string[]>(); // UPPER(symbol) → keys
  for (const t of tokens) {
    const sym = t.symbol.toUpperCase().trim();
    if (!sym) continue;
    const list = dedupedBySymbol.get(sym) ?? [];
    list.push(t.key);
    dedupedBySymbol.set(sym, list);
  }
  if (dedupedBySymbol.size === 0) return {};

  const symbolList = [...dedupedBySymbol.keys()];
  const ids = await Promise.all(symbolList.map((s) => resolveCgIdBySymbol(s)));
  const symbolToId = new Map<string, string>();
  for (let i = 0; i < symbolList.length; i++) {
    if (ids[i]) symbolToId.set(symbolList[i], ids[i]!);
  }
  if (symbolToId.size === 0) return {};

  const priceData = await fetchCachedCoinGeckoPrices([...symbolToId.values()]);

  const result: Record<string, number> = {};
  for (const [sym, id] of symbolToId) {
    const price = priceData[id];
    if (!price || price <= 0) continue;
    const keys = dedupedBySymbol.get(sym) ?? [];
    for (const key of keys) {
      result[key] = price;
    }
  }
  return result;
}
