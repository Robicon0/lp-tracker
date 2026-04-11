"use client";

import { useState, useEffect, useRef } from "react";
import type { AerodromePosition } from "../lib/aerodrome";
import { computePositionPnL, type PositionPnLData, type ActivityEventForPnL } from "../lib/positionPnl";

// ── Result shape ────────────────────────────────────────────────────────────

export interface LpPnlResult {
  initialValue: number;
  currentValue: number;
  feesCollected: number;
  feesUnclaimed: number;
  ilUSD: number;
  netPnl: number;
  netPnlPct: number;
  included: number;
  excluded: number;
  isLoading: boolean;
}

const EMPTY: LpPnlResult = {
  initialValue: 0, currentValue: 0, feesCollected: 0, feesUnclaimed: 0,
  ilUSD: 0, netPnl: 0, netPnlPct: 0, included: 0, excluded: 0, isLoading: false,
};

// ── NFT manager lookup ──────────────────────────────────────────────────────

const HYPEREVM_NFT_MANAGERS: Record<string, string> = {
  HyperSwap: "0x6eda206207c09e5428f281761ddc0d300851fbc8",
  KittenSwap: "0xb9201e89f94a01ff13ad4caecf43a2e232513754",
  ProjectX: "0xead19ae861c29bbb2101e834922b2feee69b9091",
};

// ── Supported protocols ─────────────────────────────────────────────────────

const ACTIVITY_PROTOCOLS = new Set([
  "Aerodrome", "Bluefin", "Orca", "Raydium",
  "HyperSwap", "KittenSwap", "ProjectX",
  "Uniswap V3", "Velodrome", "PancakeSwap V3",
]);

// ── Build activity API URL ──────────────────────────────────────────────────

function buildActivityUrl(pos: AerodromePosition): string | null {
  const p = new URLSearchParams();

  if (pos.protocol === "Aerodrome") {
    p.set("positionId", pos.id.replace("aero-", ""));
    p.set("t0d", String(pos.token0Decimals ?? 18));
    p.set("t1d", String(pos.token1Decimals ?? 18));
    if (pos.token0Address) p.set("token0", pos.token0Address);
    if (pos.token1Address) p.set("token1", pos.token1Address);
    if (pos.price0 != null) p.set("p0", String(pos.price0));
    if (pos.price1 != null) p.set("p1", String(pos.price1));
    return `/api/aerodrome/activity?${p}`;
  }
  if (pos.protocol === "Bluefin") {
    p.set("positionId", pos.id.replace("bluefin-", ""));
    p.set("decimalsA", String(pos.token0Decimals ?? 9));
    p.set("decimalsB", String(pos.token1Decimals ?? 6));
    if (pos.coinTypeA) p.set("coinTypeA", pos.coinTypeA);
    if (pos.coinTypeB) p.set("coinTypeB", pos.coinTypeB);
    if (pos.price0 != null) p.set("priceA", String(pos.price0));
    if (pos.price1 != null) p.set("priceB", String(pos.price1));
    if (pos.walletAddress) p.set("account", pos.walletAddress);
    return `/api/bluefin/activity?${p}`;
  }
  if (pos.protocol === "Orca") {
    p.set("positionId", pos.id.replace("orca-", ""));
    p.set("t0d", String(pos.token0Decimals ?? 9));
    p.set("t1d", String(pos.token1Decimals ?? 6));
    if (pos.token0Address) p.set("mintA", pos.token0Address);
    if (pos.token1Address) p.set("mintB", pos.token1Address);
    if (pos.price0 != null) p.set("priceA", String(pos.price0));
    if (pos.price1 != null) p.set("priceB", String(pos.price1));
    if (pos.walletAddress) p.set("account", pos.walletAddress);
    return `/api/orca/activity?${p}`;
  }
  if (pos.protocol === "Raydium") {
    p.set("positionId", pos.id.replace("ray-", ""));
    p.set("t0d", String(pos.token0Decimals ?? 9));
    p.set("t1d", String(pos.token1Decimals ?? 6));
    if (pos.token0Address) p.set("mintA", pos.token0Address);
    if (pos.token1Address) p.set("mintB", pos.token1Address);
    if (pos.price0 != null) p.set("priceA", String(pos.price0));
    if (pos.price1 != null) p.set("priceB", String(pos.price1));
    if (pos.walletAddress) p.set("account", pos.walletAddress);
    return `/api/raydium/activity?${p}`;
  }
  if (HYPEREVM_NFT_MANAGERS[pos.protocol]) {
    p.set("positionId", pos.id.replace(/^hyperswap-[^-]+-/, ""));
    p.set("nftManager", HYPEREVM_NFT_MANAGERS[pos.protocol]);
    p.set("t0d", String(pos.token0Decimals ?? 18));
    p.set("t1d", String(pos.token1Decimals ?? 6));
    if (pos.token0Address) p.set("token0", pos.token0Address);
    if (pos.token1Address) p.set("token1", pos.token1Address);
    if (pos.price0 != null) p.set("p0", String(pos.price0));
    if (pos.price1 != null) p.set("p1", String(pos.price1));
    return `/api/hyperswap/activity?${p}`;
  }
  if (pos.protocol === "Uniswap V3") {
    const m = pos.id.match(/^uni3-([a-z]+)-(\d+)$/);
    if (!m) return null;
    p.set("chain", m[1]);
    p.set("tokenId", m[2]);
    p.set("t0d", String(pos.token0Decimals ?? 18));
    p.set("t1d", String(pos.token1Decimals ?? 18));
    if (pos.token0Address) p.set("token0", pos.token0Address);
    if (pos.token1Address) p.set("token1", pos.token1Address);
    if (pos.price0 != null) p.set("p0", String(pos.price0));
    if (pos.price1 != null) p.set("p1", String(pos.price1));
    return `/api/uniswap/activity?${p}`;
  }
  if (pos.protocol === "Velodrome") {
    p.set("positionId", pos.id.replace("velo-", ""));
    p.set("t0d", String(pos.token0Decimals ?? 18));
    p.set("t1d", String(pos.token1Decimals ?? 18));
    if (pos.token0Address) p.set("token0", pos.token0Address);
    if (pos.token1Address) p.set("token1", pos.token1Address);
    if (pos.price0 != null) p.set("p0", String(pos.price0));
    if (pos.price1 != null) p.set("p1", String(pos.price1));
    return `/api/velodrome/activity?${p}`;
  }
  if (pos.protocol === "PancakeSwap V3") {
    p.set("positionId", pos.id.replace("cake3-bsc-", ""));
    p.set("t0d", String(pos.token0Decimals ?? 18));
    p.set("t1d", String(pos.token1Decimals ?? 18));
    if (pos.token0Address) p.set("token0", pos.token0Address);
    if (pos.token1Address) p.set("token1", pos.token1Address);
    if (pos.price0 != null) p.set("p0", String(pos.price0));
    if (pos.price1 != null) p.set("p1", String(pos.price1));
    return `/api/pancakeswap/activity?${p}`;
  }
  return null;
}

// ── Fetch one position's activity and compute P&L ───────────────────────────

async function fetchAndCompute(
  pos: AerodromePosition,
): Promise<{ ok: true; data: PositionPnLData } | { ok: false; reason: string }> {
  const tag = `[lpPnl] ${pos.protocol} ${pos.chain} ${pos.id}`;

  const url = buildActivityUrl(pos);
  if (!url) {
    console.error(`${tag} no activity URL — protocol not wired`);
    return { ok: false, reason: "no activity URL" };
  }

  let json: { events?: Array<Record<string, unknown>>; error?: string };
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`${tag} HTTP ${res.status} ${body.slice(0, 300)}`);
      return { ok: false, reason: `HTTP ${res.status}` };
    }
    json = await res.json();
  } catch (err) {
    console.error(`${tag} fetch threw:`, err);
    return { ok: false, reason: "fetch error" };
  }

  if (json.error) {
    console.error(`${tag} route error: ${json.error}`);
    return { ok: false, reason: json.error };
  }
  if (!json.events || json.events.length === 0) {
    console.warn(`${tag} 0 events — no on-chain history found`);
    return { ok: false, reason: "no events" };
  }

  const events: ActivityEventForPnL[] = json.events.map((e) => ({
    type: e.type as ActivityEventForPnL["type"],
    timestamp: e.timestamp as number,
    amount0: e.amount0 as number,
    amount1: e.amount1 as number,
    usdAtTime: (e.usdAtTime as number | null) ?? null,
    price0AtTime: (e.price0AtTime as number | null) ?? null,
    price1AtTime: (e.price1AtTime as number | null) ?? null,
  }));

  const result = computePositionPnL({
    currentValue: pos.value,
    unclaimedFeesUSD: pos.fees,
    price0: pos.price0 ?? 0,
    price1: pos.price1 ?? 0,
    events,
  });

  if (!result.ok) {
    console.warn(`${tag} excluded: ${result.reason}`);
    return { ok: false, reason: result.reason };
  }

  const d = result.data;
  console.log(
    `${tag} initial=$${d.initialValue.toFixed(2)} current=$${d.currentValue.toFixed(2)} ` +
    `feesClaimed=$${d.feesCollected.toFixed(2)} feesUnclaimed=$${d.feesUnclaimed.toFixed(2)} ` +
    `IL=$${d.ilUSD.toFixed(2)} netPnl=$${d.netPnlUSD.toFixed(2)} (${d.depositCount} deposits)`,
  );

  return { ok: true, data: d };
}

// ── Hook ────────────────────────────────────────────────────────────────────

export function useLpPnl(positions: AerodromePosition[]): LpPnlResult {
  const [result, setResult] = useState<LpPnlResult>({ ...EMPTY, isLoading: false });
  const fetchedForRef = useRef<string>("");

  useEffect(() => {
    // Deduplicate, filter active + supported
    const seen = new Set<string>();
    const eligible = positions.filter((p) => {
      if (p.status === "Closed" || p.value <= 0) return false;
      if (!ACTIVITY_PROTOCOLS.has(p.protocol)) return false;
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });

    if (eligible.length === 0) {
      setResult({ ...EMPTY });
      return;
    }

    const key = eligible.map((p) => p.id).sort().join("|");
    if (key === fetchedForRef.current) return;
    fetchedForRef.current = key;

    let cancelled = false;
    setResult((prev) => ({ ...prev, isLoading: true }));

    Promise.all(eligible.map((pos) => fetchAndCompute(pos))).then((results) => {
      if (cancelled) return;

      let initialValue = 0, currentValue = 0, feesCollected = 0, feesUnclaimed = 0, ilUSD = 0;
      let included = 0, excluded = 0;

      for (const r of results) {
        if (r.ok) {
          initialValue += r.data.initialValue;
          currentValue += r.data.currentValue;
          feesCollected += r.data.feesCollected;
          feesUnclaimed += r.data.feesUnclaimed;
          ilUSD += r.data.ilUSD;
          included += 1;
        } else {
          excluded += 1;
        }
      }

      const netPnl = currentValue + feesCollected + feesUnclaimed - initialValue;
      const netPnlPct = initialValue > 0 ? (netPnl / initialValue) * 100 : 0;

      setResult({
        initialValue, currentValue, feesCollected, feesUnclaimed,
        ilUSD, netPnl, netPnlPct, included, excluded, isLoading: false,
      });
    });

    return () => { cancelled = true; };
  }, [positions]);

  return result;
}
