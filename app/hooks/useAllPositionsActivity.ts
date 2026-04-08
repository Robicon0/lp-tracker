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
  "Aerodrome", "Bluefin", "Orca", "Raydium",
  "HyperSwap", "KittenSwap", "ProjectX",
  "Uniswap V3", "Velodrome", "PancakeSwap V3",
]);

// ── Cache (localStorage, 5 min TTL) ────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000;

function cacheKey(id: string) { return `analytics-activity-${id}`; }

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

  if (pos.protocol === "Aerodrome") {
    const tokenId = pos.id.replace("aero-", "");
    params.set("positionId", tokenId);
    params.set("t0d", String(pos.token0Decimals ?? 18));
    params.set("t1d", String(pos.token1Decimals ?? 18));
    if (pos.token0Address) params.set("token0", pos.token0Address);
    if (pos.token1Address) params.set("token1", pos.token1Address);
    if (pos.price0 != null) params.set("p0", String(pos.price0));
    if (pos.price1 != null) params.set("p1", String(pos.price1));
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

export function useAllPositionsActivity(
  positions: AerodromePosition[],
): {
  perfMap: Map<string, PositionPerformance>;
  eventsMap: Map<string, ActivityEvent[]>;
  isLoading: boolean;
} {
  const [perfMap, setPerfMap] = useState<Map<string, PositionPerformance>>(new Map());
  const [eventsMap, setEventsMap] = useState<Map<string, ActivityEvent[]>>(new Map());
  const [isLoading, setIsLoading] = useState(false);
  // Track which set of position IDs we've already fetched for
  const fetchedForRef = useRef<string>("");

  useEffect(() => {
    // Fetch for ALL positions with supported activity protocols (including closed)
    const eligible = positions.filter((p) => ACTIVITY_PROTOCOLS.has(p.protocol));

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

    const fetches = eligible.map(async (pos): Promise<FetchResult> => {
      // Check cache first
      const cached = readCache(pos.id);
      if (cached) {
        return [pos.id, computePerformance(cached.events, pos), cached.events];
      }

      const url = buildActivityUrl(pos);
      if (!url) {
        return [pos.id, emptyPerf, []];
      }

      try {
        const res = await fetch(url);
        const json = await res.json();
        if (json.error || !json.events) {
          return [pos.id, emptyPerf, []];
        }
        writeCache(pos.id, json);
        return [pos.id, computePerformance(json.events, pos), json.events];
      } catch {
        return [pos.id, emptyPerf, []];
      }
    });

    Promise.all(fetches).then((results) => {
      if (cancelled) return;
      setPerfMap(new Map(results.map(([id, perf]) => [id, perf])));
      setEventsMap(new Map(results.map(([id, , events]) => [id, events])));
      setIsLoading(false);
    });

    return () => { cancelled = true; };
  }, [positions]);

  return { perfMap, eventsMap, isLoading };
}
