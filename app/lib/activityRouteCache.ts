// app/lib/activityRouteCache.ts
//
// Server-side cache + in-flight dedup for the activity routes (Sprint 1.13).
//
// THE PROBLEM (measured): the analytics page fetches every position's activity
// route 2-3x — useAllPositionsActivity, useLpPnl, and (for Sui) useWalletLevelFees
// each build the SAME URL and fetch independently. The activity routes had NO
// server-side cache, so on a cold instance each redundant fetch re-ran the full
// expensive path: the HyperEVM Etherscan/archive deposit scan AND every
// CoinGecko-historical claim lookup (all funneled through the process-wide
// concurrency-1 `withCgPacing` queue). That 2-3x amplification, multiplied across
// every position and pushed into CoinGecko's free-tier rate limit (429 retry
// storms), is the dominant cause of the 3-5 min cold first-load. The WARM path is
// already fast (~8s) because Redis short-circuits the CoinGecko work — the first
// user just pays the full uncached, un-deduped, multi-hook price.
//
// THE FIX (additive, this module): wrap each activity route's GET handler so that
//   1. IN-FLIGHT DEDUP — when 2-3 hooks fetch the same route near-simultaneously
//      (exactly what happens on mount), only the FIRST runs the work; the others
//      await the same in-flight promise. This is the dominant win: it collapses
//      the simultaneous multi-hook burst into ONE deposit scan + ONE set of
//      CoinGecko calls.
//   2. TTL RESULT CACHE — a completed result is served from memory for a short
//      window (cache-versioning Rule 3: 5 min success, 60 s empty, errors never
//      cached), so React re-renders and quick refetches don't recompute.
//
// Scope: in-process (module-scope Map), per Vercel instance. Fluid Compute reuses
// an instance across a user's concurrent requests, so the simultaneous multi-hook
// burst dedups on one instance. A future sprint can add a Redis tier if
// cross-instance/user sharing proves worthwhile; this sprint targets the measured
// dominant cost (the within-load multi-hook amplification) with the lowest-risk,
// fully-additive change. The pricing/instrumentation invariants are untouched —
// a cache HIT returns the exact JSON the route produced (claims still valued
// claim-date-only, Rule 1a; no new CoinGecko/spot calls).
//
// Defensive contract: NEVER changes a route's output shape, NEVER caches errors,
// NEVER throws of its own accord (a handler throw propagates unchanged).

import { NextResponse } from 'next/server';
import { logPrice } from './priceLogger';

const SUCCESS_TTL_MS = 5 * 60_000; // cache-versioning Rule 3 — success
const EMPTY_TTL_MS = 60_000;       // cache-versioning Rule 3 — empty result
const MAX_ENTRIES = 1000;          // bound memory; keys include volatile spot prices

interface CachedResponse {
  status: number;
  body: unknown;
}
interface Entry {
  res: CachedResponse;
  expiresAt: number;
}

const cache = new Map<string, Entry>();
const inFlight = new Map<string, Promise<CachedResponse>>();

// Stable cache key: pathname + sorted search params (param order must not create
// distinct keys for identical requests; the three hooks build params in the same
// order today, but sorting makes the dedup robust to any future drift).
function makeKey(rawUrl: string): string {
  const u = new URL(rawUrl);
  const entries = [...u.searchParams.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  );
  return u.pathname + '?' + entries.map(([k, v]) => `${k}=${v}`).join('&');
}

function routeOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).pathname;
  } catch {
    return 'unknown';
  }
}

// An "empty" result (wallet/position has no activity) is cached briefly so a
// genuinely-empty position doesn't stampede a slow chain, but not so long that a
// freshly-opened position stays invisible (cache-versioning Rule 3).
function isEmptyPayload(body: unknown): boolean {
  if (body && typeof body === 'object' && 'events' in body) {
    const ev = (body as { events?: unknown }).events;
    return Array.isArray(ev) && ev.length === 0;
  }
  return false;
}

// An error result must NEVER be cached (cache-versioning Rule 3): a transient RPC
// failure or CoinGecko rate-limit should not poison the next request.
function isErrorPayload(status: number, body: unknown): boolean {
  if (status !== 200) return true;
  if (body == null) return true;
  if (typeof body === 'object' && 'error' in (body as object)) return true;
  return false;
}

function prune(): void {
  if (cache.size <= MAX_ENTRIES) return;
  const now = Date.now();
  for (const [k, e] of cache) {
    if (e.expiresAt <= now) cache.delete(k);
  }
  // Map preserves insertion order — evict oldest until under the cap.
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * Wrap an activity-route GET handler with in-flight dedup + a short TTL result
 * cache. Drop-in: `export const GET = withActivityRouteCache(GET_impl)`.
 */
export function withActivityRouteCache(
  handler: (request: Request) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    let key: string;
    try {
      key = makeKey(request.url);
    } catch {
      // Malformed URL — never our problem to fix; just pass through uncached.
      return handler(request);
    }
    const route = routeOf(request.url);
    const t0 = Date.now();

    // 1. TTL result cache.
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      logPrice({ event: 'activity_cache', route, status: 'hit', ms: Date.now() - t0 });
      return NextResponse.json(cached.res.body, { status: cached.res.status });
    }

    // 2. In-flight dedup — the dominant win for the simultaneous multi-hook burst.
    const pending = inFlight.get(key);
    if (pending) {
      const r = await pending;
      logPrice({ event: 'activity_cache', route, status: 'dedup', ms: Date.now() - t0 });
      return NextResponse.json(r.body, { status: r.status });
    }

    // 3. Miss — compute once, share the promise with any concurrent callers.
    const promise: Promise<CachedResponse> = (async () => {
      const res = await handler(request);
      // Activity routes always return NextResponse.json; clone so the original
      // Response stays consumable and read the body once for caching.
      const body = await res.clone().json().catch(() => null);
      return { status: res.status, body };
    })();
    inFlight.set(key, promise);

    let result: CachedResponse;
    try {
      result = await promise;
    } finally {
      inFlight.delete(key);
    }

    if (!isErrorPayload(result.status, result.body)) {
      const ttl = isEmptyPayload(result.body) ? EMPTY_TTL_MS : SUCCESS_TTL_MS;
      cache.set(key, { res: result, expiresAt: Date.now() + ttl });
      prune();
    }
    logPrice({ event: 'activity_cache', route, status: 'miss', ms: Date.now() - t0 });
    return NextResponse.json(result.body, { status: result.status });
  };
}
