// DeFiLlama's yields pool list, read ONCE and shared (fee APR / TVL for seven
// position routes: aerodrome, uniswap/v3, velodrome, pancakeswap, hyperswap,
// cetus, pool-stats).
//
// WHY: every one of those routes downloaded `yields.llama.fi/pools` (11.6 MB,
// 16,853 pools) on every request; Next's data cache refuses items over 2 MB, so
// `revalidate: 300` did nothing. Measured 2026-10-15 on a local build: one
// Account 1 dashboard load pulled the list 9-10 times, 99-110 MB, and the
// server peaked at 413-505 MB. The routes read nine fields of about a dozen
// projects: 4,701 pools, 1.38 MB.
//
// HOW: the list is fetched, cut to the tracked projects and the nine fields, and
// stored per project in the shared store (`defillama_pools_v1:{project}` →
// { at, pools }), fresh for 30 minutes. Each instance keeps what it read in
// memory for the same 30 minutes, so the store is read about once per project
// per instance per half hour (the free plan has 10 GB of bandwidth a month).
// Values are kept 7 days as the LAST KNOWN answer: when DeFiLlama cannot be
// read, the stored pools are served and the route says "last known"; with none,
// the route says the figures are unavailable. Neither is ever silent.
//
// Store limits checked 2026-10-15: plan 10 MB per request, 100 MB per record;
// a 1.38 MB value written and read back intact (2.0 s / 3.1 s from a laptop).

import { Redis } from '@upstash/redis';
import { POOL_STATS_UNAVAILABLE, POOL_STATS_LAST_KNOWN, type RouteTruncation } from './enumerationTruncation';
import { createSharedRedis } from './sharedStore';

export interface LlamaPool {
  project: string;
  chain: string;
  symbol: string;
  pool: string;
  underlyingTokens?: string[] | null;
  apy?: number | null;
  apyBase?: number | null;
  tvlUsd?: number | null;
  volumeUsd1d?: number | null;
}

/** Every project a route reads. A route asking for one not listed here gets nothing. */
export const TRACKED_PROJECTS = [
  'aerodrome-slipstream', 'aerodrome-v1', 'velodrome-slipstream', 'velodrome-v1',
  'uniswap-v3', 'pancakeswap-v3', 'pancakeswap-amm-v3', 'hyperswap-v3', 'kittenswap', 'project-x',
  'cetus-clmm', 'bluefin-spot', 'orca-dex', 'raydium-amm',
] as const;

const LIST_URL = 'https://yields.llama.fi/pools';
const FRESH_MS = 30 * 60_000;
const KEEP_SECONDS = 7 * 24 * 60 * 60;
const FETCH_TIMEOUT_MS = 25_000;
const KEY = (project: string) => `defillama_pools_v1:${project}`;

type Entry = { at: number; pools: LlamaPool[] };
export type LlamaBasis = 'live' | 'last-known' | 'unavailable';

const _url = process.env.PRICE_CACHE_KV_REST_API_URL;
const _token = process.env.PRICE_CACHE_KV_REST_API_TOKEN;
let _redis: Redis | null = null;
if (_url && _token) {
  try { _redis = createSharedRedis('defillamaPools'); }
  catch (err) { console.warn('[defillamaPools] Redis client construction failed; no-op stub:', err); _redis = null; }
}
const readOnly = () => process.env.CLOSED_POS_CACHE_READONLY === '1';

const memory = new Map<string, Entry>();
/** How each project was last answered in this process (read by `llamaPoolsNotices`). */
const lastBasis = new Map<string, LlamaBasis>();
let refreshing: Promise<boolean> | null = null;

const fresh = (e: Entry | undefined) => !!e && Date.now() - e.at < FRESH_MS;

// The whole list, once, cut down and stored per project. True when it was read.
async function refresh(): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(LIST_URL, { cache: 'no-store', signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { data?: Array<Record<string, unknown>> };
    const rows = Array.isArray(json.data) ? json.data : [];
    if (rows.length < 1000) throw new Error(`only ${rows.length} pools`); // a short answer is not the list
    const tracked = new Set<string>(TRACKED_PROJECTS);
    const by = new Map<string, LlamaPool[]>(TRACKED_PROJECTS.map((p) => [p, []]));
    for (const p of rows) {
      const project = p.project as string;
      if (!tracked.has(project)) continue;
      by.get(project)!.push({
        project, chain: p.chain as string, symbol: p.symbol as string, pool: p.pool as string,
        underlyingTokens: (p.underlyingTokens as string[] | null) ?? null,
        apy: (p.apy as number | null) ?? null, apyBase: (p.apyBase as number | null) ?? null,
        tvlUsd: (p.tvlUsd as number | null) ?? null, volumeUsd1d: (p.volumeUsd1d as number | null) ?? null,
      });
    }
    const at = Date.now();
    for (const [project, pools] of by) memory.set(project, { at, pools });
    if (_redis && !readOnly()) {
      await Promise.all([...by].map(([project, pools]) =>
        _redis!.set(KEY(project), { at, pools }, { ex: KEEP_SECONDS }).catch((err) =>
          console.warn(`[defillamaPools] store write failed for ${project} (ignored):`, String(err).slice(0, 100)))));
    }
    return true;
  } catch (err) {
    console.error('[defillamaPools] pool list could not be read:', String(err).slice(0, 160));
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The pools of the given projects. `basis`: `live` (read within 30 minutes),
 * `last-known` (DeFiLlama could not be read; the newest stored copy, `at`),
 * `unavailable` (nothing to serve). Never throws.
 */
export async function getLlamaPools(projects: readonly string[]): Promise<{ pools: LlamaPool[]; basis: LlamaBasis; at: number | null }> {
  // 1. This instance's copy.
  if (!projects.every((p) => fresh(memory.get(p)))) {
    // 2. The shared store.
    const missing = projects.filter((p) => !fresh(memory.get(p)));
    if (_redis && missing.length > 0) {
      try {
        const vals = await _redis.mget<(Entry | null)[]>(...missing.map(KEY));
        missing.forEach((p, i) => {
          const v = vals?.[i];
          if (v && Array.isArray(v.pools) && typeof v.at === 'number' && (!memory.get(p) || memory.get(p)!.at < v.at)) memory.set(p, v);
        });
      } catch (err) { console.warn('[defillamaPools] store read failed (treated as a miss):', String(err).slice(0, 100)); }
    }
    // 3. DeFiLlama itself, once per instance at a time.
    if (!projects.every((p) => fresh(memory.get(p)))) {
      refreshing ??= refresh().finally(() => { refreshing = null; });
      await refreshing;
    }
  }
  const entries = projects.map((p) => memory.get(p));
  const basis: LlamaBasis = entries.every((e) => fresh(e)) ? 'live'
    : entries.some((e) => e) ? 'last-known' : 'unavailable';
  for (const p of projects) lastBasis.set(p, basis);
  const at = entries.reduce<number | null>((m, e) => (e ? (m == null ? e.at : Math.min(m, e.at)) : m), null);
  return { pools: entries.flatMap((e) => e?.pools ?? []), basis, at };
}

/**
 * The notice a route adds for its projects: nothing when the figures are live,
 * `pool-stats-last-known` or `pool-stats-unavailable` otherwise (information
 * lines: no position, value or fee is missing).
 */
export function llamaPoolsNotices(projects: readonly string[]): RouteTruncation[] {
  const b = projects.map((p) => lastBasis.get(p));
  if (b.includes('unavailable')) return [{ scope: 'pool statistics', cap: 0, returned: 0, knownTotal: null, reason: POOL_STATS_UNAVAILABLE }];
  if (b.includes('last-known')) return [{ scope: 'pool statistics', cap: 0, returned: 0, knownTotal: null, reason: POOL_STATS_LAST_KNOWN }];
  return [];
}

/** Tests only. */
export function _resetLlamaPoolsMemory(): void { memory.clear(); lastBasis.clear(); refreshing = null; }
