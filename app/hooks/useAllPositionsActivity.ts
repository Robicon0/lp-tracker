"use client";

import { useState, useEffect, useRef } from "react";
import type { AerodromePosition } from "../lib/aerodrome";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ActivityEvent {
  type: string;
  timestamp: number; // unix seconds
  amount0: number;
  amount1: number;
  usdAtTime: number | null;
  // EVM routes populate these; Solana/Sui routes leave them null.
  price0AtTime?: number | null;
  price1AtTime?: number | null;
  // Every activity route emits this — used to dedupe when per-position and
  // wallet-scope scans both observe the same fee claim.
  txHash?: string;
}

interface ActivityResponse {
  events: ActivityEvent[];
}

export interface PositionPerformance {
  actualAPR: number | null;   // null = no data, fall back to estimated
  actualDaily: number | null;
  claimedUSD: number;
  daysActive: number;
  isEstimated: boolean;       // true when falling back to pool APY
}

// ── NFT manager lookup for HyperEVM ─────────────────────────────────────────

const HYPEREVM_NFT_MANAGERS: Record<string, string> = {
  HyperSwap: "0x6eda206207c09e5428f281761ddc0d300851fbc8",
  KittenSwap: "0xb9201e89f94a01ff13ad4caecf43a2e232513754",
  ProjectX: "0xead19ae861c29bbb2101e834922b2feee69b9091",
};

const HYPEREVM_PROTOCOLS = new Set(["HyperSwap", "KittenSwap", "ProjectX"]);

// ── Supported protocols (those with activity APIs) ──────────────────────────

const ACTIVITY_PROTOCOLS = new Set([
  "Aerodrome", "Bluefin", "Cetus", "Orca", "Raydium",
  "HyperSwap", "KittenSwap", "ProjectX",
  "Uniswap V3", "Velodrome", "PancakeSwap V3",
]);

// ── Cache (localStorage, 5 min TTL) ────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000;

// v3 key: invalidates entries cached during two prior buggy windows —
//   v1→v2 (commit ca03ce2): a duplicate ETHERSCAN_API_KEY line in .env.local
//     caused the second (invalid) key to override the first (valid) one —
//     dotenv keeps the LAST definition. The hyperswap activity route's Tier 1
//     (Etherscan) silently failed on every call.
//   v2→v3 (this commit): Etherscan free tier is 5 req/sec; analytics fetches
//     N positions × 3 topic calls in parallel, so a single rate-limited topic
//     call discarded the OTHER successful topic results for that position and
//     tanked it to DRPC, which can't reach old closed positions. The route
//     now retries failed topics individually and aggregates partial successes;
//     this bump forces a fresh fetch so browsers with empty cached entries
//     pick up the new behaviour.
// Bumped v4 → v5: same reason as lp-pnl-events-v2 — Uniswap V3 closed
// positions had cached events whose usdAtTime was computed against bad
// ticks (int24 sign-extension bug in /api/uniswap/v3). Fresh fetches
// after the fix flow through automatically.
// Bumped v5 → v6: Cetus per-position activity now flows through this hook
// (added to ACTIVITY_PROTOCOLS). Cetus route now returns coinTypeA/coinTypeB
// on the position object so the activity URL receives them; previously
// cached Cetus entries (if any browser happened to fetch them under a
// future code path) would have empty-events because the route returned
// 400 on missing coinTypeA — bump invalidates them defensively.
// Bumped v6 → v7: Sui activity routes (Cetus + Bluefin) now value
// fee_claim / reward_claim events against historical SUI price at the
// claim's date (CoinGecko coins/sui/history) instead of today's spot.
// Cached events from v6 carry wrong-era SUI valuations.
// Bumped v7 → v8: EVM V3 activity routes (Aerodrome, Velodrome, Uniswap,
// HyperSwap, PancakeSwap) now resolve historical sqrtPriceX96 at the
// block of EVERY event (deposits + withdrawals + fee claims). Cached
// events from v7 carry wrong USD values for single-sided deposits and
// withdrawals where the old tick-boundary estimate was off.
// Bumped v8 → v9: parity bump with useLpPnl's v12 → v13. useLpPnl was
// missing the `pool` query param, but useAllPositionsActivity always
// had `setPool()` wired — so cached v8 entries are technically
// correct. Bumping anyway so analytics & lp-pnl refresh in lockstep
// (avoids a window where lifetime fees show one number on the chart
// and a different number on the LP P&L card).
// Bumped v13 → v14: parity with useLpPnl's v21 → v22. HyperEVM fee claims that
// miss the historical price cache are now left UNRESOLVED (usdAtTime null)
// instead of valued at current spot (pricing-invariants Rule 1). v13 entries
// carry the old spot-valued usdAtTime; bump flushes them so claims re-fetch
// under the corrected ladder and analytics/LP-P&L stay in lockstep.
function cacheKey(id: string) { return `analytics-activity-v14-${id}`; }

function readCache(id: string): ActivityResponse | null {
  try {
    const raw = localStorage.getItem(cacheKey(id));
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) return null;
    return entry.data;
  } catch { return null; }
}

function writeCache(id: string, data: ActivityResponse) {
  try {
    localStorage.setItem(cacheKey(id), JSON.stringify({ data, fetchedAt: Date.now() }));
  } catch { /* quota */ }
}

// ── Build fetch URL for each protocol ───────────────────────────────────────

function buildActivityUrl(pos: AerodromePosition): string | null {
  const params = new URLSearchParams();

  // Pool address enables historical fee-price derivation (pool.slot0() at the
  // fee claim's block → exact prices at that block). Routes that receive a
  // `pool` param compute per-event USD historically; routes that don't fall
  // back to current-price × amounts.
  const setPool = () => {
    if (pos.poolAddress) params.set("pool", pos.poolAddress);
  };

  if (pos.protocol === "Aerodrome") {
    const tokenId = pos.id.replace("aero-", "");
    params.set("positionId", tokenId);
    params.set("t0d", String(pos.token0Decimals ?? 18));
    params.set("t1d", String(pos.token1Decimals ?? 18));
    if (pos.token0Address) params.set("token0", pos.token0Address);
    if (pos.token1Address) params.set("token1", pos.token1Address);
    if (pos.price0 != null) params.set("p0", String(pos.price0));
    if (pos.price1 != null) params.set("p1", String(pos.price1));
    setPool();
    return `/api/aerodrome/activity?${params}`;
  }

  if (pos.protocol === "Bluefin") {
    const objId = pos.id.replace("bluefin-", "");
    params.set("positionId", objId);
    params.set("decimalsA", String(pos.token0Decimals ?? 9));
    params.set("decimalsB", String(pos.token1Decimals ?? 6));
    if (pos.coinTypeA) params.set("coinTypeA", pos.coinTypeA);
    if (pos.coinTypeB) params.set("coinTypeB", pos.coinTypeB);
    if (pos.price0 != null) params.set("priceA", String(pos.price0));
    if (pos.price1 != null) params.set("priceB", String(pos.price1));
    if (pos.walletAddress) params.set("account", pos.walletAddress);
    return `/api/bluefin/activity?${params}`;
  }

  if (pos.protocol === "Cetus") {
    const objId = pos.id.replace("cetus-", "");
    params.set("positionId", objId);
    params.set("decimalsA", String(pos.token0Decimals ?? 9));
    params.set("decimalsB", String(pos.token1Decimals ?? 6));
    if (pos.coinTypeA) params.set("coinTypeA", pos.coinTypeA);
    if (pos.coinTypeB) params.set("coinTypeB", pos.coinTypeB);
    if (pos.price0 != null) params.set("priceA", String(pos.price0));
    if (pos.price1 != null) params.set("priceB", String(pos.price1));
    if (pos.walletAddress) params.set("account", pos.walletAddress);
    if (pos.tickLower != null) params.set("tickLower", String(pos.tickLower));
    if (pos.tickUpper != null) params.set("tickUpper", String(pos.tickUpper));
    return `/api/cetus/activity?${params}`;
  }

  if (pos.protocol === "Orca") {
    const posId = pos.id.replace("orca-", "");
    params.set("positionId", posId);
    params.set("t0d", String(pos.token0Decimals ?? 9));
    params.set("t1d", String(pos.token1Decimals ?? 6));
    if (pos.token0Address) params.set("mintA", pos.token0Address);
    if (pos.token1Address) params.set("mintB", pos.token1Address);
    if (pos.price0 != null) params.set("priceA", String(pos.price0));
    if (pos.price1 != null) params.set("priceB", String(pos.price1));
    if (pos.walletAddress) params.set("account", pos.walletAddress);
    return `/api/orca/activity?${params}`;
  }

  if (pos.protocol === "Raydium") {
    const posId = pos.id.replace("ray-", "");
    params.set("positionId", posId);
    params.set("t0d", String(pos.token0Decimals ?? 9));
    params.set("t1d", String(pos.token1Decimals ?? 6));
    if (pos.token0Address) params.set("mintA", pos.token0Address);
    if (pos.token1Address) params.set("mintB", pos.token1Address);
    if (pos.price0 != null) params.set("priceA", String(pos.price0));
    if (pos.price1 != null) params.set("priceB", String(pos.price1));
    if (pos.walletAddress) params.set("account", pos.walletAddress);
    return `/api/raydium/activity?${params}`;
  }

  if (HYPEREVM_PROTOCOLS.has(pos.protocol)) {
    const tokenId = pos.id.replace(/^hyperswap-[^-]+-/, "");
    const nftManager = HYPEREVM_NFT_MANAGERS[pos.protocol];
    if (!nftManager) return null;
    params.set("positionId", tokenId);
    params.set("nftManager", nftManager);
    params.set("t0d", String(pos.token0Decimals ?? 18));
    params.set("t1d", String(pos.token1Decimals ?? 6));
    if (pos.token0Address) params.set("token0", pos.token0Address);
    if (pos.token1Address) params.set("token1", pos.token1Address);
    if (pos.price0 != null) params.set("p0", String(pos.price0));
    if (pos.price1 != null) params.set("p1", String(pos.price1));
    setPool();
    return `/api/hyperswap/activity?${params}`;
  }

  if (pos.protocol === "Uniswap V3") {
    const match = pos.id.match(/^uni3-([a-z]+)-(\d+)$/);
    if (!match) return null;
    params.set("chain", match[1]);
    params.set("tokenId", match[2]);
    params.set("t0d", String(pos.token0Decimals ?? 18));
    params.set("t1d", String(pos.token1Decimals ?? 18));
    if (pos.token0Address) params.set("token0", pos.token0Address);
    if (pos.token1Address) params.set("token1", pos.token1Address);
    if (pos.price0 != null) params.set("p0", String(pos.price0));
    if (pos.price1 != null) params.set("p1", String(pos.price1));
    setPool();
    return `/api/uniswap/activity?${params}`;
  }

  if (pos.protocol === "Velodrome") {
    const tokenId = pos.id.replace("velo-", "");
    params.set("positionId", tokenId);
    params.set("t0d", String(pos.token0Decimals ?? 18));
    params.set("t1d", String(pos.token1Decimals ?? 18));
    if (pos.token0Address) params.set("token0", pos.token0Address);
    if (pos.token1Address) params.set("token1", pos.token1Address);
    if (pos.price0 != null) params.set("p0", String(pos.price0));
    if (pos.price1 != null) params.set("p1", String(pos.price1));
    setPool();
    return `/api/velodrome/activity?${params}`;
  }

  if (pos.protocol === "PancakeSwap V3") {
    const tokenId = pos.id.replace("cake3-bsc-", "");
    params.set("positionId", tokenId);
    params.set("t0d", String(pos.token0Decimals ?? 18));
    params.set("t1d", String(pos.token1Decimals ?? 18));
    if (pos.token0Address) params.set("token0", pos.token0Address);
    if (pos.token1Address) params.set("token1", pos.token1Address);
    if (pos.price0 != null) params.set("p0", String(pos.price0));
    if (pos.price1 != null) params.set("p1", String(pos.price1));
    setPool();
    return `/api/pancakeswap/activity?${params}`;
  }

  return null;
}

// ── Compute actual APR from activity events ─────────────────────────────────

function computePerformance(
  events: ActivityEvent[],
  pos: AerodromePosition,
): PositionPerformance {
  const feeClaims = events.filter((e) => e.type === "fee_claim" || e.type === "reward_claim");
  const deposits = events.filter((e) => e.type === "deposit");

  const claimedUSD = feeClaims.reduce((sum, e) => {
    if (e.usdAtTime != null) return sum + e.usdAtTime;
    return sum + e.amount0 * (pos.price0 ?? 0) + e.amount1 * (pos.price1 ?? 0);
  }, 0);

  const firstDeposit = deposits.length > 0 ? deposits[deposits.length - 1] : null;
  const firstTs = firstDeposit?.timestamp ?? 0;
  const nowTs = Math.floor(Date.now() / 1000);
  const daysActive = firstTs > 0 ? (nowTs - firstTs) / 86400 : 0;

  const actualAPR =
    daysActive >= 1 && pos.value > 0 && claimedUSD > 0
      ? ((claimedUSD / pos.value) / (daysActive / 365)) * 100
      : null;

  const actualDaily =
    daysActive >= 1 && claimedUSD > 0 ? claimedUSD / daysActive : null;

  return {
    actualAPR,
    actualDaily,
    claimedUSD,
    daysActive,
    isEstimated: actualAPR == null,
  };
}

// ── Hook ────────────────────────────────────────────────────────────────────

export interface PositionMeta { protocol: string; chain: string; }

export function useAllPositionsActivity(
  positions: AerodromePosition[],
): {
  perfMap: Map<string, PositionPerformance>;
  eventsMap: Map<string, ActivityEvent[]>;
  // Defensive parallel map populated alongside eventsMap. Lets callers
  // attribute events to their protocol/chain even if the live `positions`
  // array briefly drops the id between the eventsMap fetch and the consumer
  // memo's render (e.g. wallet disconnect-reconnect race).
  metaMap: Map<string, PositionMeta>;
  isLoading: boolean;
} {
  const [perfMap, setPerfMap] = useState<Map<string, PositionPerformance>>(new Map());
  const [eventsMap, setEventsMap] = useState<Map<string, ActivityEvent[]>>(new Map());
  const [metaMap, setMetaMap] = useState<Map<string, PositionMeta>>(new Map());
  const [isLoading, setIsLoading] = useState(false);
  // Track which set of position IDs we've already fetched for
  const fetchedForRef = useRef<string>("");

  useEffect(() => {
    // Fetch for ALL positions with supported activity protocols (including closed).
    // Deduplicate by pos.id so a position that appears twice in the input array
    // (e.g. returned from multiple concurrent wallet sources) is only fetched
    // and counted once.
    const seen = new Set<string>();
    const eligible = positions.filter((p) => {
      if (!ACTIVITY_PROTOCOLS.has(p.protocol)) return false;
      // Closed Aerodrome positions are recovered via the wallet-scope
      // positionId=all scan (useWalletLevelFees), not per-position — skip them
      // here so their fees aren't double-scanned/mis-priced. Mirrors how
      // Cetus/Bluefin closed positions are wallet-scope only. (Open Aerodrome
      // positions are still scanned per-position for accurate pricing; the
      // wallet-scope pass dedupes against them by protocol::txHash::amounts.)
      if (p.protocol === "Aerodrome" && p.status === "Closed") return false;
      // Velodrome (original Slipstream, Optimism): same as Aerodrome — closed
      // positions are recovered via the wallet-scope positionId=all scan, so
      // skip them per-position to avoid double-scan/mis-pricing.
      if (p.protocol === "Velodrome" && p.status === "Closed") return false;
      // Uniswap V3: skip only BURNED positions (recovered via wallet-scope
      // positionId=all). Closed-but-not-burned positions (held, liquidity=0)
      // still exist on-chain and keep their accurate per-position scan, so the
      // currently-held baseline is fully preserved.
      if (p.protocol === "Uniswap V3" && (p as AerodromePosition & { burned?: boolean }).burned) return false;
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });

    if (eligible.length === 0) {
      setPerfMap(new Map());
      setEventsMap(new Map());
      return;
    }

    // Build a stable key from position IDs to avoid re-fetching
    const key = eligible.map((p) => p.id).sort().join("|");
    if (key === fetchedForRef.current) return;
    fetchedForRef.current = key;

    let cancelled = false;
    setIsLoading(true);

    type FetchResult = [string, PositionPerformance, ActivityEvent[]];
    const emptyPerf: PositionPerformance = {
      actualAPR: null, actualDaily: null, claimedUSD: 0, daysActive: 0, isEstimated: true,
    };

    // HyperEVM sequential chain — Etherscan V2's free tier is 5 req/sec, and
    // each /api/hyperswap/activity call fires 3 parallel topic requests
    // (Increase / Decrease / Collect) that take 2-3s wall time per call. A
    // fixed-interval stagger isn't enough because concurrent route calls
    // still overlap at the Etherscan layer — verified live: 4 positions ×
    // 3 topics with even a 700ms stagger leaves the last 2 positions empty.
    //
    // Solution: serialise HyperEVM fetches behind a shared promise chain so
    // the next position only fires after the previous one's Etherscan calls
    // are done. Total wall time matches the pure-sequential ground truth
    // (~9s for 4 positions) — same as before but with EVERY position
    // returning correct data instead of 2 of 4 returning empty.
    //
    // Non-HyperEVM positions are NOT serialised — they don't hit Etherscan
    // the same way and benefit from the parallel fan-out.
    let hyperEvmChain: Promise<unknown> = Promise.resolve();

    const fetches = eligible.map(async (pos): Promise<FetchResult> => {
      const tag = `[activity] ${pos.protocol} ${pos.chain} ${pos.id}`;
      // Check cache first — serialising doesn't apply when we'd skip the
      // network anyway. Cache TTL is 5 min; subsequent loads in that window
      // serve instantly and incur zero Etherscan pressure.
      const cached = readCache(pos.id);
      if (cached) {
        return [pos.id, computePerformance(cached.events, pos), cached.events];
      }

      // Queue HyperEVM positions behind the previous one in the chain.
      // Non-HyperEVM positions skip this and fetch immediately in parallel.
      if (HYPEREVM_PROTOCOLS.has(pos.protocol)) {
        const previous = hyperEvmChain;
        let releaseChain!: () => void;
        hyperEvmChain = new Promise<void>((resolve) => { releaseChain = resolve; });
        try {
          await previous;
          if (cancelled) return [pos.id, emptyPerf, []];
          return await runFetch(pos, tag);
        } finally {
          releaseChain();
        }
      }

      return runFetch(pos, tag);
    });

    // Hoisted so both the HyperEVM-chained path and the parallel path call
    // the same logic. Returns the canonical FetchResult tuple.
    async function runFetch(pos: typeof eligible[number], tag: string): Promise<FetchResult> {
      const url = buildActivityUrl(pos);
      if (!url) {
        console.error(`${tag} no activity URL — protocol not wired into buildActivityUrl or missing required fields`);
        return [pos.id, emptyPerf, []];
      }

      try {
        const res = await fetch(url);
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          console.error(`${tag} HTTP ${res.status} ${res.statusText} — ${body.slice(0, 300)}`);
          return [pos.id, emptyPerf, []];
        }
        const json = await res.json();
        if (json.error) {
          console.error(`${tag} route returned error: ${json.error}`, json.details ?? "");
          return [pos.id, emptyPerf, []];
        }
        if (!json.events) {
          console.error(`${tag} route returned no events field`, json);
          return [pos.id, emptyPerf, []];
        }
        if (json.events.length === 0) {
          console.warn(`${tag} 0 events from activity route — no on-chain deposits found in scan window`);
        } else {
          const depositCount = json.events.filter((e: ActivityEvent) => e.type === "deposit").length;
          console.log(`${tag} ${json.events.length} events (${depositCount} deposits)`);
        }
        writeCache(pos.id, json);
        return [pos.id, computePerformance(json.events, pos), json.events];
      } catch (err) {
        console.error(`${tag} fetch threw:`, err);
        return [pos.id, emptyPerf, []];
      }
    }

    // Snapshot protocol/chain per eligible position at fetch time so the
    // metaMap survives downstream positions-array changes that drop ids
    // before the consumer memo re-runs.
    const metaSnapshot = new Map<string, PositionMeta>();
    for (const p of eligible) {
      metaSnapshot.set(p.id, { protocol: p.protocol, chain: p.chain });
    }

    Promise.all(fetches).then((results) => {
      if (cancelled) return;
      setPerfMap(new Map(results.map(([id, perf]) => [id, perf])));
      setEventsMap(new Map(results.map(([id, , events]) => [id, events])));
      setMetaMap(metaSnapshot);
      setIsLoading(false);
    });

    return () => { cancelled = true; };
  }, [positions]);

  return { perfMap, eventsMap, metaMap, isLoading };
}
