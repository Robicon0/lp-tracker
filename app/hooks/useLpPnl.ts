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
  excluded: number;   // positions with no deposits / no on-chain history
  errored: number;    // positions whose fetch failed (timeout, HTTP error, etc.)
  errorReasons: string[]; // first-seen unique error reasons (for UI display)
  isLoading: boolean;
  // Per-position results keyed by position.id — lets per-row UI (dashboard
  // positions table) read EXACTLY the same on-chain P&L numbers that flow
  // into the aggregated totals. A position appears here ONLY when its
  // computePositionPnL() returned ok; pending / excluded / errored positions
  // are absent and callers should fall back to a placeholder ("—" / fees-only).
  perPosition: Record<string, PositionPnLData>;
}

const EMPTY: LpPnlResult = {
  initialValue: 0, currentValue: 0, feesCollected: 0, feesUnclaimed: 0,
  ilUSD: 0, netPnl: 0, netPnlPct: 0, included: 0, excluded: 0,
  errored: 0, errorReasons: [], isLoading: false,
  perPosition: {},
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

  // Helper: append tick params if available (used by V3 price derivation)
  const appendTicks = () => {
    if (pos.tickLower != null) p.set("tickLower", String(pos.tickLower));
    if (pos.tickUpper != null) p.set("tickUpper", String(pos.tickUpper));
  };

  if (pos.protocol === "Aerodrome") {
    p.set("positionId", pos.id.replace("aero-", ""));
    p.set("t0d", String(pos.token0Decimals ?? 18));
    p.set("t1d", String(pos.token1Decimals ?? 18));
    if (pos.token0Address) p.set("token0", pos.token0Address);
    if (pos.token1Address) p.set("token1", pos.token1Address);
    if (pos.price0 != null) p.set("p0", String(pos.price0));
    if (pos.price1 != null) p.set("p1", String(pos.price1));
    appendTicks();
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
    appendTicks();
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
    appendTicks();
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
    appendTicks();
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
    appendTicks();
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
    appendTicks();
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
    appendTicks();
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
    appendTicks();
    return `/api/pancakeswap/activity?${p}`;
  }
  return null;
}

// ── localStorage cache for on-chain events (5 min TTL) ──────────────────────
// We only cache the slow part — the on-chain fetch result (events array).
// Live values (pos.value, pos.price0/1, pos.fees) are always taken from the
// latest positions snapshot, so prices stay fresh while history loads instantly.

const CACHE_KEY_PREFIX = "lp-pnl-events-v1-";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CachedEntry {
  ts: number;
  events: Array<Record<string, unknown>> | null; // null = previous fetch returned no events
  reason?: string; // populated when events is null and we want to remember why
}

function cacheGet(posId: string): CachedEntry | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(CACHE_KEY_PREFIX + posId);
    if (!raw) return null;
    const entry = JSON.parse(raw) as CachedEntry;
    if (Date.now() - entry.ts > CACHE_TTL_MS) return null;
    return entry;
  } catch {
    return null;
  }
}

function cacheSet(posId: string, entry: CachedEntry): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(CACHE_KEY_PREFIX + posId, JSON.stringify(entry));
  } catch {
    // Quota or serialization failure — silently skip caching.
  }
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

  // Try cache first.
  let rawEvents: Array<Record<string, unknown>> | null = null;
  const cached = cacheGet(pos.id);
  if (cached) {
    if (cached.events === null) {
      console.log(`${tag} cache hit — empty (${cached.reason ?? "no events"})`);
      return { ok: false, reason: cached.reason ?? "no events" };
    }
    rawEvents = cached.events;
    console.log(`${tag} cache hit — ${rawEvents.length} events`);
  } else {
    let json: { events?: Array<Record<string, unknown>>; error?: string };
    // Activity routes can chain through multiple RPC providers (Tenderly →
    // LlamaRPC → publicnode). If they all slow-fail, the fetch can hang
    // indefinitely. Cap at 30s per position so the LP P&L section never
    // gets stuck on one slow position — the error surfaces in `errored`
    // and the rest of the portfolio still aggregates correctly.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error(`${tag} HTTP ${res.status} ${body.slice(0, 300)}`);
        return { ok: false, reason: `HTTP ${res.status}` };
      }
      json = await res.json();
    } catch (err) {
      clearTimeout(timer);
      const isAbort = err instanceof Error && err.name === "AbortError";
      console.error(`${tag} fetch ${isAbort ? "timed out" : "threw"}:`, err);
      return { ok: false, reason: isAbort ? "timeout" : "fetch error" };
    }

    if (json.error) {
      console.error(`${tag} route error: ${json.error}`);
      return { ok: false, reason: json.error };
    }
    if (!json.events || json.events.length === 0) {
      console.warn(`${tag} 0 events — no on-chain history found`);
      cacheSet(pos.id, { ts: Date.now(), events: null, reason: "no events" });
      return { ok: false, reason: "no events" };
    }
    rawEvents = json.events;
    cacheSet(pos.id, { ts: Date.now(), events: rawEvents });
  }

  const events: ActivityEventForPnL[] = rawEvents.map((e) => ({
    type: e.type as ActivityEventForPnL["type"],
    timestamp: e.timestamp as number,
    amount0: e.amount0 as number,
    amount1: e.amount1 as number,
    usdAtTime: (e.usdAtTime as number | null) ?? null,
    price0AtTime: (e.price0AtTime as number | null) ?? null,
    price1AtTime: (e.price1AtTime as number | null) ?? null,
    txHash: (e.txHash as string | undefined) ?? undefined,
  }));

  const result = computePositionPnL({
    currentValue: pos.value,
    unclaimedFeesUSD: pos.fees,
    price0: pos.price0 ?? 0,
    price1: pos.price1 ?? 0,
    events,
    isClosed: pos.status === "Closed",
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

// ── Aggregate per-position results into totals ─────────────────────────────

type PosResult =
  | { ok: true; data: PositionPnLData }
  | { ok: false; reason: string };

// Error reasons that indicate a transport failure (vs. legitimate "no data"
// like `no_deposits`). These should surface to the UI so the user knows the
// fetch failed rather than the position just having no on-chain history.
const ERROR_REASONS = new Set([
  "timeout", "fetch error", "no activity URL",
]);
function isTransportError(reason: string): boolean {
  return ERROR_REASONS.has(reason) || reason.startsWith("HTTP ");
}

function aggregate(resultsMap: Map<string, PosResult>, inflight: number): LpPnlResult {
  let initialValue = 0, currentValue = 0, feesCollected = 0, feesUnclaimed = 0, ilUSD = 0;
  let included = 0, excluded = 0, errored = 0;
  const errorReasons = new Set<string>();
  // Per-position record built from the same map the totals come from — any
  // consumer that reads perPosition[id] gets a number that, summed across
  // every present id, EXACTLY equals the aggregated total. No drift possible.
  const perPosition: Record<string, PositionPnLData> = {};

  for (const [id, r] of resultsMap) {
    if (r.ok) {
      initialValue += r.data.initialValue;
      currentValue += r.data.currentValue;
      feesCollected += r.data.feesCollected;
      feesUnclaimed += r.data.feesUnclaimed;
      ilUSD += r.data.ilUSD;
      included += 1;
      perPosition[id] = r.data;
    } else if (isTransportError(r.reason)) {
      errored += 1;
      errorReasons.add(r.reason);
    } else {
      excluded += 1;
    }
  }

  const netPnl = currentValue + feesCollected + feesUnclaimed - initialValue;
  const netPnlPct = initialValue > 0 ? (netPnl / initialValue) * 100 : 0;

  return {
    initialValue, currentValue, feesCollected, feesUnclaimed,
    ilUSD, netPnl, netPnlPct, included, excluded,
    errored, errorReasons: Array.from(errorReasons),
    isLoading: inflight > 0,
    perPosition,
  };
}

// ── Hook ────────────────────────────────────────────────────────────────────
// Positions arrive in waves as different chains load. Instead of cancelling
// and restarting all fetches on every wave, we accumulate per-position results
// incrementally. Already-fetched positions keep their result; only new
// positions trigger fetches. This prevents the race condition where late-
// arriving chains cancel in-flight fetches from earlier chains.

export function useLpPnl(positions: AerodromePosition[]): LpPnlResult {
  const [result, setResult] = useState<LpPnlResult>({ ...EMPTY });
  // Per-position results map — persists across renders, never reset.
  const resultsRef = useRef<Map<string, PosResult>>(new Map());
  // IDs currently being fetched — prevents duplicate fetches.
  const inflightRef = useRef<Set<string>>(new Set());
  // Stale-detection: track the generation so unmount can stop state updates.
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    // Analytics shows the CURRENT state of the portfolio — closed positions
    // contribute nothing to today's totals (Initial / Current / Fees / IL / Net P&L).
    // Filter them out before any aggregation. Closed = status "Closed" OR value === 0.
    const seen = new Set<string>();
    const eligible = positions.filter((p) => {
      if (!ACTIVITY_PROTOCOLS.has(p.protocol)) return false;
      if (p.status === "Closed") return false;
      if (p.value <= 0) return false;
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });

    // Evict any prior results / inflight markers for positions that are no
    // longer eligible (e.g. one transitioned to Closed). Without this, their
    // stale initialValue / currentValue / IL would keep contributing to totals.
    const eligibleIds = new Set(eligible.map((p) => p.id));
    for (const id of Array.from(resultsRef.current.keys())) {
      if (!eligibleIds.has(id)) resultsRef.current.delete(id);
    }
    for (const id of Array.from(inflightRef.current)) {
      if (!eligibleIds.has(id)) inflightRef.current.delete(id);
    }

    if (eligible.length === 0) {
      setResult({ ...EMPTY });
      return;
    }

    // Find positions we haven't fetched or started fetching yet.
    const toFetch = eligible.filter(
      (p) => !resultsRef.current.has(p.id) && !inflightRef.current.has(p.id),
    );

    if (toFetch.length === 0) {
      // All positions already fetched — just recompute totals (in case
      // positions array changed order but same IDs).
      setResult(aggregate(resultsRef.current, inflightRef.current.size));
      return;
    }

    // Mark as inflight and update loading state.
    for (const p of toFetch) inflightRef.current.add(p.id);
    setResult(aggregate(resultsRef.current, inflightRef.current.size));

    // Fire fetches — each one lands independently.
    for (const pos of toFetch) {
      fetchAndCompute(pos).then((r) => {
        if (!mountedRef.current) return;
        inflightRef.current.delete(pos.id);
        resultsRef.current.set(pos.id, r);
        setResult(aggregate(resultsRef.current, inflightRef.current.size));
      });
    }
  }, [positions]);

  return result;
}
