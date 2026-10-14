// Orca fee APR + TVL per pool (used by app/api/orca/route.ts).

export interface OrcaPoolStats {
  feeAprWeek: number; // annualized decimal (e.g. 0.458 = 45.8%)
  tvl: number;        // USD
}

// Fee APR + TVL for the wallet's OWN pools, asked for by pool address.
//
// This used to download Orca's whole pool list (`api.mainnet.orca.so/v1/whirlpool/list`):
// 17-24 MB of JSON on every request, and, measured 2026-10-15, a FROZEN list:
// one page (`hasMore: true`) of 14,983 pools whose newest change is
// 2025-03-31. Pools created since (Account 1's ZEC / USDC among them) were not
// in it, so their APR was silently 0, and the rest carried 18-month-old figures.
// The v2 by-address endpoint answers about 3.2 KB per pool with live figures.
// Fee APR here is the v1 meaning: 7-day fees / TVL, annualized (fees only,
// rewards not included).
//
// Pool statistics are decoration: a failed lookup NEVER fails the route. The
// positions are returned without a fee APR and the response says so.
const ORCA_POOLS_URL = 'https://api.orca.so/v2/solana/pools';
const POOL_ADDRESSES_PER_REQUEST = 25;
const POOL_STATS_TIMEOUT_MS = 8_000;
const POOL_STATS_TTL_MS = 5 * 60_000;
const POOL_STATS_MAX_REPLY_CHARS = 2_000_000; // 25 pools is about 80 KB
const POOL_STATS_CACHE_MAX = 2_000;

const poolStatsCache = new Map<string, { stats: OrcaPoolStats | null; expiresAt: number }>();
const poolStatsInFlight = new Map<string, Promise<boolean>>();

async function requestOrcaPoolStats(addresses: string[]): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POOL_STATS_TIMEOUT_MS);
  try {
    let res: Response | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      res = await fetch(`${ORCA_POOLS_URL}?addresses=${addresses.join(',')}`, { cache: 'no-store', signal: controller.signal });
      if (res.status !== 429) break;
      await new Promise((r) => setTimeout(r, 800)); // one retry after a throttle
    }
    if (!res || !res.ok) throw new Error(`HTTP ${res?.status}`);
    const text = await res.text();
    if (text.length > POOL_STATS_MAX_REPLY_CHARS) throw new Error(`reply too large (${text.length} chars)`);
    const json = JSON.parse(text) as { data?: Array<{ address?: string; tvlUsdc?: string; stats?: { '7d'?: { fees?: string | null } } } | null> };
    if (!Array.isArray(json.data)) throw new Error('unexpected reply');
    const found = new Map<string, OrcaPoolStats>();
    for (const pool of json.data) {
      const tvl = Number(pool?.tvlUsdc);
      const fees7d = Number(pool?.stats?.['7d']?.fees);
      if (pool?.address && Number.isFinite(tvl) && tvl > 0 && Number.isFinite(fees7d)) {
        found.set(pool.address, { feeAprWeek: (fees7d / tvl) * (365 / 7), tvl });
      }
    }
    const expiresAt = Date.now() + POOL_STATS_TTL_MS;
    for (const a of addresses) poolStatsCache.set(a, { stats: found.get(a) ?? null, expiresAt });
    while (poolStatsCache.size > POOL_STATS_CACHE_MAX) {
      const oldest = poolStatsCache.keys().next().value;
      if (oldest === undefined) break;
      poolStatsCache.delete(oldest);
    }
    return true;
  } catch (error) {
    console.error(`[Orca] pool statistics could not be read for ${addresses.length} pool(s):`, String(error));
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchOrcaPoolStats(pools: string[]): Promise<{ stats: Record<string, OrcaPoolStats>; failed: boolean }> {
  const now = Date.now();
  const need = pools.filter((a) => { const hit = poolStatsCache.get(a); return !hit || hit.expiresAt <= now; });
  // A pool already being asked for by another request is awaited, not asked for again.
  const waits = new Set<Promise<boolean>>();
  const ask: string[] = [];
  for (const a of need) {
    const pending = poolStatsInFlight.get(a);
    if (pending) waits.add(pending); else ask.push(a);
  }
  for (let i = 0; i < ask.length; i += POOL_ADDRESSES_PER_REQUEST) {
    const batch = ask.slice(i, i + POOL_ADDRESSES_PER_REQUEST);
    const p = requestOrcaPoolStats(batch).finally(() => { for (const a of batch) poolStatsInFlight.delete(a); });
    for (const a of batch) poolStatsInFlight.set(a, p);
    waits.add(p);
  }
  const answers = await Promise.all(waits);
  const stats: Record<string, OrcaPoolStats> = {};
  for (const a of pools) {
    const hit = poolStatsCache.get(a);
    if (hit?.stats) stats[a] = hit.stats;
  }
  return { stats, failed: answers.some((ok) => !ok) };
}

/** Tests only. */
export function _resetOrcaPoolStats(): void { poolStatsCache.clear(); poolStatsInFlight.clear(); }
