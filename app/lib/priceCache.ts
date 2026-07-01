// Shared module-level CoinGecko SPOT-price cache for server-side API routes.
// All position routes import fetchCachedCoinGeckoPrices() instead of calling
// CoinGecko directly, so concurrent route invocations share one cached response.
//
// Cache key: CoinGecko token ID (e.g. "ethereum", "hyperliquid")
// Returns: { [geckoId]: usdPrice }   (0 ONLY for a genuinely-unpriceable id)
//
// Sprint SPOT-RESILIENCE — tiered resilience so a transient CoinGecko 429 under
// the analytics page's concurrent multi-route load no longer returns 0 (which
// fired the bogus "Current price data unavailable" banner via positionPnl.ts's
// missing_current_prices guard). Three additions, all CONTAINED here so the ~20
// callers (which consume `Record<string, number>` via `|| 0`) are unchanged:
//   1. Cross-instance Redis tier (redisSpotCache.ts) — last-known-good survives
//      cold starts, mirroring the Sprint 1.6 historical Redis cache.
//   2. A small concurrency-2 spot-fetch queue — deliberately SEPARATE from the
//      historical `withCgPacing` (concurrency-1) queue to avoid a nesting
//      deadlock (tokenResolver already calls CoinGecko inside withCgPacing).
//   3. Tiered last-known-good policy:
//        Tier A — stablecoin cgIds → always $1 (pricing-invariants Rule 3; also
//                 removes them from the CoinGecko request, cutting 429 pressure).
//        Tier B/C — on a live-fetch miss, return the last-known price (in-process
//                 or Redis), of ANY age, instead of 0. A 0 is therefore returned
//                 ONLY when no price has EVER been seen for the id — i.e. it is
//                 genuinely unpriceable, which is exactly when positionPnl's
//                 missing_current_prices guard SHOULD apply. No plumbing change.

import { getSpotPrices, setSpotPrices } from './redisSpotCache';

const cache = new Map<string, { usd: number; cachedAt: number }>();
const MAP_TTL_MS = 60_000;          // in-process L1 freshness (unchanged behaviour)
const REDIS_FRESH_MS = 5 * 60_000;  // L2 Redis entry treated as "fresh" (Part 1)

// Tier A — stablecoin CoinGecko ids anchored at $1 (matches the platform's
// canonical STABLE_CGIDS used in tokenConstants/suiClosedPositions). Extensible.
const STABLE_CGIDS = new Set(['usd-coin', 'tether', 'dai']);

// Part 2 — concurrency-limited spot fetch. A standalone semaphore (NOT the
// shared withCgPacing concurrency-1 chain, which would deadlock if reached from
// inside a tokenResolver withCgPacing block). Caps simultaneous CoinGecko
// simple/price calls so the parallel analytics load can't burst the free tier.
const SPOT_CONCURRENCY = 2;
let __activeSpotFetches = 0;
const __spotWaiters: Array<() => void> = [];
async function withSpotSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (__activeSpotFetches >= SPOT_CONCURRENCY) {
    await new Promise<void>((resolve) => __spotWaiters.push(resolve));
  }
  __activeSpotFetches++;
  try {
    return await fn();
  } finally {
    __activeSpotFetches--;
    const next = __spotWaiters.shift();
    if (next) next();
  }
}

// Lightweight observability for the B7 perf check (not wired into routes).
let _servedFresh = 0, _servedLkg = 0, _fetched = 0, _stable = 0, _unpriced = 0;
export function spotResilienceSnapshot(): {
  servedFresh: number; servedLkg: number; fetched: number; stable: number; unpriced: number;
} {
  return { servedFresh: _servedFresh, servedLkg: _servedLkg, fetched: _fetched, stable: _stable, unpriced: _unpriced };
}

async function fetchSpotBatch(ids: string[]): Promise<Record<string, number>> {
  return withSpotSlot(async () => {
    const out: Record<string, number> = {};
    try {
      const res = await fetch(
        `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=usd`,
        { cache: 'no-store' },
      );
      if (res.ok) {
        const data = await res.json();
        for (const [id, val] of Object.entries(data)) {
          const px = (val as { usd?: number })?.usd;
          if (typeof px === 'number' && px > 0) out[id] = px;
        }
      }
      // On 429/non-ok: return {} → caller falls through to LKG.
    } catch {
      // Network error: return {} → caller falls through to LKG.
    }
    return out;
  });
}

export async function fetchCachedCoinGeckoPrices(
  ids: string[],
): Promise<Record<string, number>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return {};

  const now = Date.now();
  const result: Record<string, number> = {};
  const needLookup: string[] = [];

  // Tier A (stablecoins) + L1 in-process fresh.
  for (const id of unique) {
    if (STABLE_CGIDS.has(id)) { result[id] = 1; _stable++; continue; }
    const m = cache.get(id);
    if (m && now - m.cachedAt <= MAP_TTL_MS) { result[id] = m.usd; _servedFresh++; continue; }
    needLookup.push(id);
  }
  if (needLookup.length === 0) return result;

  // L2 Redis: a FRESH entry (< 5 min) is served directly; a STALE entry is kept
  // as last-known-good for the fetch-miss fallback below.
  const redisEntries = await getSpotPrices(needLookup);
  const toFetch: string[] = [];
  for (const id of needLookup) {
    const e = redisEntries[id];
    if (e && now - e.at <= REDIS_FRESH_MS) {
      result[id] = e.usd;
      cache.set(id, { usd: e.usd, cachedAt: now });
      _servedFresh++;
    } else {
      toFetch.push(id);
    }
  }
  if (toFetch.length === 0) return result;

  // Live CoinGecko fetch (paced). Success → populate L1 + L2. Miss → LKG.
  const fetched = await fetchSpotBatch(toFetch);
  const freshWrites: Record<string, number> = {};
  for (const id of toFetch) {
    const px = fetched[id];
    if (px > 0) {
      result[id] = px;
      cache.set(id, { usd: px, cachedAt: Date.now() });
      freshWrites[id] = px;
      _fetched++;
    } else {
      // Tier B/C last-known-good: a transient miss returns the last price we ever
      // saw (Redis stale, else in-process), NEVER 0 for an id we've priced before.
      // A 0 here means we have NO record anywhere → genuinely unpriceable.
      const lkg = redisEntries[id]?.usd ?? cache.get(id)?.usd ?? 0;
      result[id] = lkg > 0 ? lkg : 0;
      if (lkg > 0) _servedLkg++; else _unpriced++;
    }
  }
  if (Object.keys(freshWrites).length > 0) setSpotPrices(freshWrites); // fire-and-forget L2 write

  return result;
}
