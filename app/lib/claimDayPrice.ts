// app/lib/claimDayPrice.ts
//
// ONE price per (coin, UTC day) for fee and reward CLAIMS, from DeFiLlama
// historical prices by coin address (pricing-invariants Rule 1).
//
// Why a separate module from `defillamaPriceHistory.ts`: that one asks for the
// point nearest the claim's own timestamp and remembers it under the claim's
// day, so which claim asked first decides the day's price, and the stored value
// expires after 30 days. Here the day's price is the point nearest NOON UTC of
// that day (searchWidth 12h, and the point must fall inside the same UTC day),
// so every claim of a day gets the same price on every instance, on every load.
//
// Store: one key per coin, `claim_day_px_v1:{chain}:{coin}` → { YYYYMMDD: price },
// no expiry (a finished day's price never changes). Read once per coin per
// instance; written once per prewarm that found a new finished day. A day whose
// noon has not passed yet is answered from the latest point and kept in this
// process for 10 minutes only, never stored.
//
// Fallback (rule 2 of the rewards commit): when the claim's own day has no
// price, or its request failed, the nearest EARLIER day with a price, at most 3
// days back, is used and the result says so (`basis: 'nearby-day'`); the page
// then marks Fees `≈` with a counted notice. Beyond that the claim stays
// unpriced (`null`): never spot, never $0.
//
// One attempt per request (10 s). A failed request is not remembered, so the
// next load asks again; the client's bounded retry schedule applies.

import { type Chain, DEFILLAMA_CHAIN, normalizeIdentifier, defillamaRequestId } from './tokenConstants';
import { createSharedRedis } from './sharedStore';

export type ClaimDayBasis = 'claim-day' | 'nearby-day';
/**
 * The chains claims are priced on. BNB is not a resolver chain (`Chain`): its
 * PancakeSwap / Uniswap claims are priced here by contract address only.
 */
export type ClaimChain = Chain | 'bnb';
const LLAMA_CHAIN: Record<ClaimChain, string> = { ...DEFILLAMA_CHAIN, bnb: 'bsc' };
const normCoin = (chain: ClaimChain, coin: string) => (chain === 'bnb' ? coin.trim().toLowerCase() : normalizeIdentifier(chain, coin));
const requestId = (chain: ClaimChain, coin: string) => (chain === 'bnb' ? coin.trim().toLowerCase() : defillamaRequestId(chain, coin));
export interface ClaimDayPrice { price: number; basis: ClaimDayBasis; day: string }

const KEY_PREFIX = 'claim_day_px_v1';
const ENDPOINT = 'https://coins.llama.fi/batchHistorical';
export const NEARBY_DAYS = 3;
const DAY = 86_400;
const PROVISIONAL_MS = 10 * 60_000;
const MISSING_MS = 6 * 60 * 60_000;
const MAX_TS_PER_REQUEST = 120;

const store = createSharedRedis('claimDayPrice');

// coinKey → day → price (finished days; permanent in this process)
const known = new Map<string, Map<string, number>>();
// coinKey → day → { price, until } (today's day, before its noon)
const provisional = new Map<string, Map<string, { price: number; until: number }>>();
// coinKey → day → until (the request answered and had no point for that day)
const missing = new Map<string, Map<string, number>>();
// coinKey → promise of the stored map having been read
const loaded = new Map<string, Promise<void>>();

const stats = { storeReads: 0, storeWrites: 0, requests: 0, requestErrors: 0 };
/** Process-wide counters (tests and diagnostics). */
export function claimDayStats() { return { ...stats }; }
/** Test hook: forget everything held in this process. */
export function resetClaimDayPricesForTest() { known.clear(); provisional.clear(); missing.clear(); loaded.clear(); for (const k of Object.keys(stats) as (keyof typeof stats)[]) stats[k] = 0; }

export function utcDay(ts: number): string {
  const d = new Date(Math.floor(ts) * 1000);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}
function dayStart(day: string): number {
  return Date.UTC(+day.slice(0, 4), +day.slice(4, 6) - 1, +day.slice(6, 8)) / 1000;
}
function shiftDay(day: string, n: number): string { return utcDay(dayStart(day) + n * DAY + 1); }

const coinKey = (chain: ClaimChain, coin: string) => `${chain}:${normCoin(chain, coin)}`;
const storeKey = (ck: string) => `${KEY_PREFIX}:${ck}`;

function mapOf<V>(m: Map<string, Map<string, V>>, ck: string): Map<string, V> {
  let x = m.get(ck);
  if (!x) { x = new Map(); m.set(ck, x); }
  return x;
}

async function loadStored(ck: string): Promise<void> {
  let p = loaded.get(ck);
  if (!p) {
    p = (async () => {
      if (!store) return;
      try {
        stats.storeReads += 1;
        const raw = await store.get<Record<string, number> | string | null>(storeKey(ck));
        const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (obj && typeof obj === 'object') {
          const k = mapOf(known, ck);
          for (const [day, v] of Object.entries(obj as Record<string, unknown>)) {
            const n = Number(v);
            if (/^\d{8}$/.test(day) && Number.isFinite(n) && n > 0) k.set(day, n);
          }
        }
      } catch {
        // An unreadable store is a miss: the prices are fetched again.
        loaded.delete(ck);
      }
    })();
    loaded.set(ck, p);
  }
  await p;
}

function dayState(ck: string, day: string, now: number): number | 'missing' | undefined {
  const k = known.get(ck)?.get(day);
  if (k != null) return k;
  const pv = provisional.get(ck)?.get(day);
  if (pv && pv.until > now) return pv.price;
  const ms = missing.get(ck)?.get(day);
  if (ms != null && ms > now) return 'missing';
  return undefined;
}

interface Want { chain: ClaimChain; ck: string; coin: string; day: string }

/** Asks DeFiLlama for every (coin, day) in `wants`; records prices and misses. */
async function fetchDays(wants: Want[], now: number): Promise<Set<string>> {
  const newlyStored = new Set<string>(); // coinKeys that gained a finished day
  const byReq = new Map<string, { want: Want; ts: number }[]>();
  for (const w of wants) {
    const dl = LLAMA_CHAIN[w.chain];
    if (!dl) continue;
    const noon = dayStart(w.day) + DAY / 2;
    const ts = noon * 1000 <= now - 60_000 ? noon : Math.floor(now / 1000) - 60;
    const id = `${dl}:${requestId(w.chain, w.coin)}`;
    const list = byReq.get(id) ?? byReq.set(id, []).get(id)!;
    list.push({ want: w, ts });
  }
  // Chunk so one URL stays short; coins are batched together.
  const chunks: Array<Array<[string, { want: Want; ts: number }[]]>> = [];
  let cur: Array<[string, { want: Want; ts: number }[]]> = [];
  let n = 0;
  for (const [id, list] of byReq) {
    for (let i = 0; i < list.length; i += MAX_TS_PER_REQUEST) {
      const part = list.slice(i, i + MAX_TS_PER_REQUEST);
      if (n + part.length > MAX_TS_PER_REQUEST && cur.length > 0) { chunks.push(cur); cur = []; n = 0; }
      cur.push([id, part]); n += part.length;
    }
  }
  if (cur.length > 0) chunks.push(cur);

  for (const chunk of chunks) {
    const coins: Record<string, number[]> = {};
    for (const [id, part] of chunk) (coins[id] ??= []).push(...part.map((p) => p.ts));
    stats.requests += 1;
    let json: { coins?: Record<string, { prices?: Array<{ timestamp?: number; price?: number }> }> } | null = null;
    try {
      const res = await fetch(`${ENDPOINT}?coins=${encodeURIComponent(JSON.stringify(coins))}&searchWidth=12h`, {
        cache: 'no-store', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) json = await res.json();
    } catch { json = null; }
    if (!json || typeof json !== 'object') { stats.requestErrors += 1; continue; } // not remembered: asked again next load
    const answers = json.coins ?? {};
    // DeFiLlama echoes the key it was asked with; match case-insensitively to be safe.
    const lower = new Map(Object.entries(answers).map(([k, v]) => [k.toLowerCase(), v]));
    for (const [id, part] of chunk) {
      const pts = (answers[id] ?? lower.get(id.toLowerCase()))?.prices ?? [];
      const byDay = new Map<string, number>();
      for (const p of pts) {
        if (typeof p?.timestamp !== 'number' || typeof p.price !== 'number' || !Number.isFinite(p.price) || p.price <= 0) continue;
        const d = utcDay(p.timestamp);
        if (!byDay.has(d)) byDay.set(d, p.price);
      }
      for (const { want, ts } of part) {
        const price = byDay.get(want.day);
        const finished = (dayStart(want.day) + DAY / 2) * 1000 <= now - 60_000 && ts === dayStart(want.day) + DAY / 2;
        if (price != null) {
          if (finished) { mapOf(known, want.ck).set(want.day, price); newlyStored.add(want.ck); }
          else mapOf(provisional, want.ck).set(want.day, { price, until: now + PROVISIONAL_MS });
        } else {
          mapOf(missing, want.ck).set(want.day, now + (finished ? MISSING_MS : PROVISIONAL_MS));
        }
      }
    }
  }
  return newlyStored;
}

async function writeStored(ck: string): Promise<void> {
  if (!store) return;
  const k = known.get(ck);
  if (!k || k.size === 0) return;
  // Merge with what another instance may have written since this one read.
  try {
    const raw = await store.get<Record<string, number> | string | null>(storeKey(ck));
    stats.storeReads += 1;
    const obj = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, number> | null;
    const merged: Record<string, number> = { ...(obj && typeof obj === 'object' ? obj : {}) };
    for (const [d, v] of k) merged[d] = v;
    stats.storeWrites += 1;
    await store.set(storeKey(ck), merged);
  } catch (err) {
    console.warn('[claimDayPrice] store write failed (ignored):', String(err).slice(0, 80));
  }
}

/**
 * Makes `getClaimDayPrice` answer for every (coin, claim timestamp) given.
 * Never throws. Two DeFiLlama passes at most: the claim days, then up to
 * `NEARBY_DAYS` earlier days for the ones that had no price.
 */
export async function prewarmClaimDayPrices(items: Array<{ chain: ClaimChain; coin: string; timestamps: number[] }>): Promise<void> {
  try {
    const now = Date.now();
    const days = new Map<string, Want>();
    for (const { chain, coin, timestamps } of items) {
      if (!coin || !LLAMA_CHAIN[chain]) continue;
      const ck = coinKey(chain, coin);
      for (const ts of timestamps) {
        if (!Number.isFinite(ts) || ts <= 0) continue;
        const day = utcDay(ts);
        days.set(`${ck}|${day}`, { chain, ck, coin, day });
      }
    }
    if (days.size === 0) return;
    await Promise.all([...new Set([...days.values()].map((w) => w.ck))].map(loadStored));

    const firstPass = [...days.values()].filter((w) => dayState(w.ck, w.day, now) === undefined);
    const gained = firstPass.length ? await fetchDays(firstPass, now) : new Set<string>();

    // Days still without a price (missing, or their request failed): earlier days.
    const second = new Map<string, Want>();
    for (const w of days.values()) {
      const s = dayState(w.ck, w.day, now);
      if (typeof s === 'number') continue;
      for (let i = 1; i <= NEARBY_DAYS; i++) {
        const d = shiftDay(w.day, -i);
        const st = dayState(w.ck, d, now);
        if (typeof st === 'number') break;
        if (st === undefined) second.set(`${w.ck}|${d}`, { ...w, day: d });
      }
    }
    if (second.size > 0) for (const ck of await fetchDays([...second.values()], now)) gained.add(ck);
    await Promise.all([...gained].map(writeStored));
  } catch (err) {
    console.warn('[claimDayPrice] prewarm failed (claims stay unpriced):', String(err).slice(0, 80));
  }
}

/**
 * The claim day's price, or the nearest earlier day's (at most `NEARBY_DAYS`
 * back, `basis: 'nearby-day'`), or null. Synchronous: call after
 * `prewarmClaimDayPrices`.
 */
export function getClaimDayPrice(chain: ClaimChain, coin: string, ts: number): ClaimDayPrice | null {
  if (!coin || !Number.isFinite(ts) || ts <= 0 || !LLAMA_CHAIN[chain]) return null;
  const ck = coinKey(chain, coin);
  const now = Date.now();
  const day = utcDay(ts);
  const own = dayState(ck, day, now);
  if (typeof own === 'number') return { price: own, basis: 'claim-day', day };
  for (let i = 1; i <= NEARBY_DAYS; i++) {
    const d = shiftDay(day, -i);
    const st = dayState(ck, d, now);
    if (typeof st === 'number') return { price: st, basis: 'nearby-day', day: d };
  }
  return null;
}
