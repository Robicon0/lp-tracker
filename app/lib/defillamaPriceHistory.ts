// app/lib/defillamaPriceHistory.ts
//
// SECONDARY claim-date historical price source (Sprint 1.12), parallel to
// app/lib/cgPriceHistory.ts (CoinGecko, PRIMARY). It resolves a token's USD
// price on the day of a fee/reward claim by CONTRACT/MINT/COIN-TYPE via
// DeFiLlama's free historical-by-contract endpoint:
//
//   GET https://coins.llama.fi/prices/historical/{unixTs}/{dlChain}:{contract}
//   → { coins: { "{dlChain}:{contract}": { price, timestamp, decimals, symbol, confidence } } }
//
// WHY THIS EXISTS: CoinGecko's coverage of long-tail tokens on Sui/Solana is
// incomplete. A claim token that isn't listed on CoinGecko (or whose contract
// isn't mapped to a CoinGecko id) gets no historical price there and the claim
// stays "pending price resolution" forever. DeFiLlama keys by on-chain contract
// (not by a CoinGecko id), so it fills that gap for the broad long-tail. It is
// consulted ONLY AFTER CoinGecko misses (see the route call sites); when both
// miss, the claim stays pending — never spot-valued.
//
// RULE 1a (pricing-invariants) IS PRESERVED: this module ONLY calls the
// DeFiLlama *historical* endpoint with the claim's OWN timestamp. There is no
// current/spot path here. A genuinely-unpriceable claim date returns null and
// the caller leaves the claim pending. DeFiLlama *current* price (used elsewhere
// only as a tokenResolver coverage check) is NOT a claim source.
//
// CACHE LAYERS mirror cgPriceHistory / redisPriceCache (Sprint 1.6):
//   Tier 1  Upstash Redis  key `price:historical:defillama:{chain}:{normId}:{YYYYMMDD}`
//           (own "defillama:" namespace so CoinGecko and DeFiLlama values stay
//            separate), 30-day TTL, fire-and-forget writes, no-op stub if env
//            vars missing.
//   Tier 2  in-process Map (+ negative cache for permanent misses, + in-flight
//           dedup) so the synchronous getCachedOnlyDefillamaPrice() reader works
//           after an awaited prewarm, exactly like cgPriceHistory.
//
// Defensive contract: NEVER throws, NEVER blocks the response. All fetches flow
// through a polite per-process rate gate (<=5 concurrent, >=200ms between
// dispatches) — DeFiLlama's limits are generous, but we stay courteous.

import { Redis } from '@upstash/redis';
import { logPrice } from './priceLogger';
import { type Chain, DEFILLAMA_CHAIN, normalizeIdentifier, defillamaRequestId } from './tokenConstants';

export type { Chain } from './tokenConstants';

// 30 days — historical daily prices are effectively immutable; the TTL only lets
// an eventual correction propagate and bounds the free-tier keyspace. Matches
// the CoinGecko Redis tier (redisPriceCache.ts).
const TTL_SECONDS = 30 * 24 * 60 * 60;

// Accept a returned data point only if it lands within the SAME UTC day window
// of the requested timestamp (DeFiLlama returns the nearest available point).
// Observed drift in practice is seconds-to-minutes; >24h means DeFiLlama had no
// point near the claim date and we treat it as missing (never use a far-off
// price for a claim).
const MAX_TS_DRIFT_SEC = 24 * 60 * 60;

const ENDPOINT = 'https://coins.llama.fi/prices/historical';

// ── Redis client (own client; same PRICE_CACHE_KV_* env, no-op stub) ──────────
const REST_URL = process.env.PRICE_CACHE_KV_REST_API_URL;
const REST_TOKEN = process.env.PRICE_CACHE_KV_REST_API_TOKEN;
let redis: Redis | null = null;
if (REST_URL && REST_TOKEN) {
  try {
    redis = new Redis({ url: REST_URL, token: REST_TOKEN });
  } catch (err) {
    console.warn('[defillamaPriceHistory] Redis client construction failed; no-op stub:', err);
    redis = null;
  }
}

// ── In-process caches ─────────────────────────────────────────────────────────
const cache = new Map<string, number>();              // memKey → price
const negativeCache = new Set<string>();              // permanent misses (404 / empty / zero / far-off)
const inFlight = new Map<string, Promise<number | null>>();

// ── Polite rate gate: <=5 concurrent, >=200ms between dispatch starts ─────────
const MAX_CONCURRENT = 5;
const MIN_GAP_MS = 200;
let active = 0;
let lastDispatch = 0;
const waiters: Array<() => void> = [];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function gate<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) {
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  active++;
  const gap = lastDispatch + MIN_GAP_MS - Date.now();
  if (gap > 0) await sleep(gap);
  lastDispatch = Date.now();
  try {
    return await fn();
  } finally {
    active--;
    const next = waiters.shift();
    if (next) next();
  }
}

// ── Key builders ──────────────────────────────────────────────────────────────
// UTC YYYYMMDD so any timestamp on the same calendar day maps to one key.
function ymd(timestampSec: number): string {
  const d = new Date(timestampSec * 1000);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

// normalizeIdentifier keeps Solana mints case-sensitive (base58), lowercases EVM
// addresses, and normalizes Sui coin types — so the cache key dedups correctly
// across calls without ever corrupting a mint.
function memKey(chain: Chain, contract: string, ts: number): string {
  return `${chain}:${normalizeIdentifier(chain, contract)}:${ymd(ts)}`;
}
function redisKey(chain: Chain, contract: string, ts: number): string {
  return `price:historical:defillama:${chain}:${normalizeIdentifier(chain, contract)}:${ymd(ts)}`;
}

// ── Redis read/write (never throw) ─────────────────────────────────────────────
async function redisGet(key: string): Promise<number | null> {
  if (!redis) return null;
  try {
    const raw = await redis.get<number | string | null>(key);
    if (raw === null || raw === undefined) return null;
    const price = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch {
    return null; // miss on error
  }
}
function redisSet(key: string, priceUsd: number): void {
  if (!redis) return;
  void redis
    .set(key, priceUsd, { ex: TTL_SECONDS })
    .catch((err) => console.warn('[defillamaPriceHistory] Redis write failed (ignored):', err));
}

// ── Result type ─────────────────────────────────────────────────────────────--
export interface DefillamaHistoricalResult {
  price: number | null;
  timestamp: number; // unix ts DeFiLlama returned (or the requested ts on miss)
  source: 'defillama-historical' | 'defillama-historical-error' | 'defillama-historical-missing';
}

type FetchKind = 'price' | 'missing' | 'error';
interface FetchOutcome {
  kind: FetchKind;
  price?: number;
  dlTs?: number;
  reason?: string;
}

// Single HTTP attempt through the rate gate. Classifies into price / missing /
// error. NEVER throws.
async function fetchOnce(chain: Chain, contract: string, ts: number): Promise<FetchOutcome> {
  const dlChain = DEFILLAMA_CHAIN[chain];
  if (!dlChain) return { kind: 'missing' };
  return gate(async () => {
    try {
      // searchWidth=24h (2026-07-19, Krishna DEEP/SUI pending-claim fix):
      // DeFiLlama's DEFAULT nearest-point search is narrower than our documented
      // ±24h acceptance window (MAX_TS_DRIFT_SEC), so a token with a sparse
      // series returned {coins:{}} even when a same-day point existed (live
      // repro: DEEP @ 2025-07-03 01:06 — default query empty, but a point
      // exists 6.1 h later; CG can't rescue claims >365 d old on the free
      // tier). Widening the SERVER-side search to 24h simply lets DeFiLlama
      // return that nearest point; the drift validation below still rejects
      // anything outside ±24h, so Rule 1c (same-UTC-day historical, never
      // spot) is unchanged.
      // A Sui coin type is sent with its address in full: DeFiLlama returns
      // nothing for one whose leading zero was stripped (the CETUS cause).
      const url = `${ENDPOINT}/${Math.floor(ts)}/${dlChain}:${defillamaRequestId(chain, contract)}?searchWidth=24h`;
      const res = await fetch(url, {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        // 404 → no data for this contract/date → permanent miss.
        if (res.status === 404) return { kind: 'missing' };
        // 429 / 5xx / etc. → transient (not negative-cached).
        return { kind: 'error', reason: `http_${res.status}` };
      }
      const json = (await res.json()) as {
        coins?: Record<string, { price?: number; timestamp?: number }>;
      };
      // We queried exactly one coin; take the single entry robustly (DeFiLlama
      // echoes the requested key, but reading the only value is case-proof).
      const entry = json?.coins ? Object.values(json.coins)[0] : undefined;
      if (!entry || typeof entry.price !== 'number' || !Number.isFinite(entry.price) || entry.price <= 0) {
        // Empty {coins:{}} / zero / NaN → missing. Never cache a zero as a price.
        return { kind: 'missing' };
      }
      // Reject a data point too far from the requested claim date.
      if (typeof entry.timestamp === 'number' && Math.abs(entry.timestamp - ts) > MAX_TS_DRIFT_SEC) {
        return { kind: 'missing' };
      }
      return { kind: 'price', price: entry.price, dlTs: entry.timestamp ?? ts };
    } catch (err) {
      // Timeout / network / parse → transient.
      return { kind: 'error', reason: String(err).slice(0, 80) };
    }
  });
}

// ── Public: resolve a single (chain, contract, timestamp) ─────────────────────
export async function fetchDefillamaPriceAtDate(
  chain: Chain,
  contract: string,
  unixTimestamp: number,
): Promise<DefillamaHistoricalResult> {
  if (!contract || !Number.isFinite(unixTimestamp) || unixTimestamp <= 0) {
    return { price: null, timestamp: unixTimestamp, source: 'defillama-historical-missing' };
  }
  if (!DEFILLAMA_CHAIN[chain]) {
    return { price: null, timestamp: unixTimestamp, source: 'defillama-historical-missing' };
  }

  const k = memKey(chain, contract, unixTimestamp);
  const date = ymd(unixTimestamp);

  // Tier 2 in-process hit.
  const cached = cache.get(k);
  if (cached != null) {
    return { price: cached, timestamp: unixTimestamp, source: 'defillama-historical' };
  }
  if (negativeCache.has(k)) {
    return { price: null, timestamp: unixTimestamp, source: 'defillama-historical-missing' };
  }

  // Tier 1 Redis hit (seed the in-process cache so the sync reader finds it).
  const rk = redisKey(chain, contract, unixTimestamp);
  const redisHit = await redisGet(rk);
  if (redisHit != null) {
    cache.set(k, redisHit);
    return { price: redisHit, timestamp: unixTimestamp, source: 'defillama-historical' };
  }

  // In-flight dedup: many positions / both pool sides may request the same key.
  const pending = inFlight.get(k);
  if (pending) {
    const p = await pending;
    return p != null
      ? { price: p, timestamp: unixTimestamp, source: 'defillama-historical' }
      : { price: null, timestamp: unixTimestamp, source: 'defillama-historical-missing' };
  }

  const promise: Promise<number | null> = (async () => {
    const t0 = Date.now();
    try {
      const outcome = await fetchOnce(chain, contract, unixTimestamp);
      if (outcome.kind === 'price' && typeof outcome.price === 'number') {
        cache.set(k, outcome.price);
        redisSet(rk, outcome.price); // fire-and-forget cross-instance write-back
        logPrice({
          event: 'defillama_historical_used',
          chain,
          contract,
          date,
          price: outcome.price,
          latencyMs: Date.now() - t0,
        });
        return outcome.price;
      }
      if (outcome.kind === 'missing') {
        negativeCache.add(k);
        logPrice({ event: 'defillama_historical_missing', chain, contract, date });
        return null;
      }
      // 'error' → transient; DO NOT negative-cache (retry next request).
      logPrice({ event: 'defillama_historical_error', chain, contract, date, reason: outcome.reason ?? 'unknown' });
      return null;
    } finally {
      inFlight.delete(k);
    }
  })();

  inFlight.set(k, promise);
  const result = await promise;
  return result != null
    ? { price: result, timestamp: unixTimestamp, source: 'defillama-historical' }
    : { price: null, timestamp: unixTimestamp, source: 'defillama-historical-missing' };
}

// ── Public: prewarm many (chain, contract, timestamps) so the resolution loop
// can read synchronously afterwards (mirrors prewarmTokenPrices / Sui prewarm).
// The rate gate caps concurrency, so a flat Promise.all over the deduped work is
// safe. Awaited by the caller before its synchronous events.map().
export async function prewarmDefillamaPrices(
  items: Array<{ chain: Chain; contract: string; timestamps: number[] }>,
): Promise<void> {
  const seen = new Set<string>();
  const work: Array<{ chain: Chain; contract: string; ts: number }> = [];
  for (const { chain, contract, timestamps } of items) {
    if (!contract || !DEFILLAMA_CHAIN[chain]) continue;
    for (const ts of timestamps) {
      if (!Number.isFinite(ts) || ts <= 0) continue;
      const k = memKey(chain, contract, ts);
      if (seen.has(k) || cache.has(k) || negativeCache.has(k) || inFlight.has(k)) continue;
      seen.add(k);
      work.push({ chain, contract, ts });
    }
  }
  if (work.length === 0) return;
  await Promise.all(
    work.map((w) => fetchDefillamaPriceAtDate(w.chain, w.contract, w.ts).catch(() => {})),
  );
}

// ── Public: synchronous cache-only read — returns null on miss. Use AFTER
// awaiting prewarmDefillamaPrices() so the event-build loop stays synchronous.
export function getCachedOnlyDefillamaPrice(
  chain: Chain,
  contract: string,
  timestampSeconds: number,
): number | null {
  if (!contract || !Number.isFinite(timestampSeconds) || timestampSeconds <= 0) return null;
  if (!DEFILLAMA_CHAIN[chain]) return null;
  return cache.get(memKey(chain, contract, timestampSeconds)) ?? null;
}

// ── EXACT-TIME prices (Sprint 2b) ────────────────────────────────────────────
// The lookups above are keyed by UTC DAY: the first timestamp asked for on a day
// fixes the price every other event of that day gets. That is the documented
// basis for FEE CLAIMS (pricing-invariants Rule 1: the claim date's price) and
// they stay on it. It is the wrong basis for a position's DEPOSIT and
// WITHDRAWAL legs: a position opened and closed on one day got one price on
// both sides and a Capital G/L of exactly 0.00, with the whole move landing on
// the neighbouring leg (measured on Account 1: 13 one-sided Orca legs total
// −728.48 on the day basis and −842.03 at each leg's own time).
//
// `…AtTime` asks DeFiLlama for the point nearest the event's OWN timestamp and
// accepts it only within ±1 hour; outside that window it is a miss and the
// caller falls back to the day price. Historical only, never current (Rule 1a).
// Own keys (`price:historical:defillama_t:{chain}:{contract}:{unix}`), so a day
// price and an exact price can never be read for one another.
const EXACT_MAX_DRIFT_SEC = 60 * 60;
const exactCache = new Map<string, number>();
const exactMissing = new Set<string>();
const exactInFlight = new Map<string, Promise<number | null>>();
const exactStats = { hit: 0, missing: 0, error: 0 };
/** Process-wide counts for the exact-time tier (diagnostics). */
export function defillamaExactStats() { return { ...exactStats }; }

function exactKey(chain: Chain, contract: string, ts: number): string {
  return `${chain}:${normalizeIdentifier(chain, contract)}:t${Math.floor(ts)}`;
}
function exactRedisKey(chain: Chain, contract: string, ts: number): string {
  return `price:historical:defillama_t:${chain}:${normalizeIdentifier(chain, contract)}:${Math.floor(ts)}`;
}

async function fetchExactOnce(chain: Chain, contract: string, ts: number): Promise<FetchOutcome> {
  const dlChain = DEFILLAMA_CHAIN[chain];
  if (!dlChain) return { kind: 'missing' };
  return gate(async () => {
    try {
      const res = await fetch(`${ENDPOINT}/${Math.floor(ts)}/${dlChain}:${defillamaRequestId(chain, contract)}?searchWidth=1h`, {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return res.status === 404 ? { kind: 'missing' } : { kind: 'error', reason: `http_${res.status}` };
      const json = (await res.json()) as { coins?: Record<string, { price?: number; timestamp?: number }> };
      const entry = json?.coins ? Object.values(json.coins)[0] : undefined;
      if (!entry || typeof entry.price !== 'number' || !Number.isFinite(entry.price) || entry.price <= 0) return { kind: 'missing' };
      // The point must be the event's own hour. Without a timestamp the point cannot be placed: a miss.
      if (typeof entry.timestamp !== 'number' || Math.abs(entry.timestamp - ts) > EXACT_MAX_DRIFT_SEC) return { kind: 'missing' };
      return { kind: 'price', price: entry.price, dlTs: entry.timestamp };
    } catch (err) {
      return { kind: 'error', reason: String(err).slice(0, 80) };
    }
  });
}

/** Price at the event's own time (±1 h), or null. `'error'` results are not remembered. */
export async function fetchDefillamaPriceAtTime(chain: Chain, contract: string, ts: number): Promise<number | null> {
  if (!contract || !Number.isFinite(ts) || ts <= 0 || !DEFILLAMA_CHAIN[chain]) return null;
  const k = exactKey(chain, contract, ts);
  const hit = exactCache.get(k);
  if (hit != null) return hit;
  if (exactMissing.has(k)) return null;
  const running = exactInFlight.get(k);
  if (running) return running;
  const p = (async (): Promise<number | null> => {
    const rk = exactRedisKey(chain, contract, ts);
    const stored = await redisGet(rk);
    if (stored != null) { exactCache.set(k, stored); exactStats.hit += 1; return stored; }
    const outcome = await fetchExactOnce(chain, contract, ts);
    if (outcome.kind === 'price' && typeof outcome.price === 'number') { const px: number = outcome.price; exactCache.set(k, px); redisSet(rk, px); exactStats.hit += 1; return px; }
    if (outcome.kind === 'missing') { exactMissing.add(k); exactStats.missing += 1; } else exactStats.error += 1;
    return null;
  })();
  exactInFlight.set(k, p);
  try { return await p; } finally { exactInFlight.delete(k); }
}

export async function prewarmDefillamaPricesAtTime(
  items: Array<{ chain: Chain; contract: string; timestamps: number[] }>,
): Promise<void> {
  const seen = new Set<string>();
  const work: Array<Promise<unknown>> = [];
  for (const { chain, contract, timestamps } of items) {
    if (!contract || !DEFILLAMA_CHAIN[chain]) continue;
    for (const ts of timestamps) {
      if (!Number.isFinite(ts) || ts <= 0) continue;
      const k = exactKey(chain, contract, ts);
      if (seen.has(k) || exactCache.has(k) || exactMissing.has(k)) continue;
      seen.add(k);
      work.push(fetchDefillamaPriceAtTime(chain, contract, ts).catch(() => null));
    }
  }
  await Promise.all(work);
}

/**
 * Synchronous read after `prewarmDefillamaPricesAtTime`.
 * `price` — the exact-time price; `known` — false when the lookup neither found
 * a price nor established that none exists (a transient failure: ask again).
 */
export function getCachedOnlyDefillamaPriceAtTime(chain: Chain, contract: string, ts: number): { price: number | null; known: boolean } {
  if (!contract || !Number.isFinite(ts) || ts <= 0 || !DEFILLAMA_CHAIN[chain]) return { price: null, known: true };
  const k = exactKey(chain, contract, ts);
  const hit = exactCache.get(k);
  if (hit != null) return { price: hit, known: true };
  return { price: null, known: exactMissing.has(k) };
}

