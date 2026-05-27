"use client";

import { useState, useEffect, useRef } from "react";
import type { AerodromePosition } from "../lib/aerodrome";
import { computePositionPnL, type PositionPnLData, type ActivityEventForPnL } from "../lib/positionPnl";

// ── Result shape ────────────────────────────────────────────────────────────

export interface ExcludedPosition {
  id: string;
  pair: string;
  protocol: string;
  chain: string;
  /** User-friendly reason — already mapped from the technical code. */
  reason: string;
}

export interface LpPnlResult {
  initialValue: number;
  /** Mark-to-market value of OPEN positions only (closed positions contribute 0). */
  currentValue: number;
  /** Realised value at close, summed across CLOSED positions only (open positions contribute 0). */
  closingValue: number;
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
  // Every position that's NOT contributing to the totals — surfaced verbatim
  // in the analytics warning banner so the user knows why their totals look
  // lower than expected. Includes: unsupported protocols (Cetus, Momentum),
  // missing-data positions (no_deposits, missing_deposit_prices), and
  // transport-error positions after all retries failed.
  excludedPositions: ExcludedPosition[];
  // Count of positions that ARE included in the totals but used the
  // HyperEVM-style fallback (current value as proxy for initial value
  // because deposit history wasn't recoverable from RPC). The analytics
  // page prefixes the "Total Deposited" card with "~" when this is > 0.
  estimatedPositionCount: number;
}

const EMPTY: LpPnlResult = {
  initialValue: 0, currentValue: 0, closingValue: 0, feesCollected: 0, feesUnclaimed: 0,
  ilUSD: 0, netPnl: 0, netPnlPct: 0, included: 0, excluded: 0,
  errored: 0, errorReasons: [], isLoading: false,
  perPosition: {},
  excludedPositions: [],
  estimatedPositionCount: 0,
};

// Map technical exclusion reasons to user-friendly text shown in the warning
// banner. Keep these terse but informative — the user doesn't need to know
// what computePositionPnL returns internally.
function userFriendlyReason(reason: string, protocol: string): string {
  if (reason === "no_deposits" || reason === "no events") {
    if (protocol === "HyperSwap" || protocol === "KittenSwap" || protocol === "ProjectX") {
      // HyperEVM positions taking this branch DESPITE the fallback below
      // means the position has 0 value — fallback only kicks in when value > 0.
      return "Deposit history unavailable on HyperEVM RPC";
    }
    return "No deposit events found on-chain";
  }
  if (reason === "missing_deposit_prices") return "Deposit price data unavailable";
  if (reason === "missing_current_prices") return "Current price data unavailable";
  if (reason === "value_overflow") return "Calculation overflow — implausible USD value (likely decimals mismatch)";
  if (reason === "no activity URL") return "P&L calculation not yet supported for this protocol";
  if (reason === "unsupported protocol") return "P&L calculation not yet supported for this protocol";
  if (reason.startsWith("HTTP ")) return `Failed to load — ${reason} after 3 attempts`;
  if (reason === "timeout") return "Failed to load — RPC timeout after 3 attempts";
  if (reason === "fetch error") return "Failed to load — network error after 3 attempts";
  return reason;
}

// HyperEVM doesn't have an archival eth_getLogs source we can rely on, so
// when the activity scan returns 0 deposit events the position would normally
// be silently excluded. Instead we synthesize a PnL data point using the
// CURRENT position value as a proxy for the deposit value. The result is
// included in totals (so TOTAL DEPOSITED + CURRENT VALUE both reflect the
// position) but flagged with `fallback: true` so the UI can mark it.
//
// Net P&L for a fallback position = unclaimed fees only (since current ===
// initial by definition, and we have no claimed-fees history). IL is
// non-computable without entry prices, so it's reported as 0 with
// ilAvailable: false.
// Sum fee_claim / reward_claim events' claim-time USD. Used by the HyperEVM
// fallback so a position with successfully-fetched fee events still
// contributes its claimed fees to the totals even when computePositionPnL
// rejects the events for lacking deposit history.
//
// RULE (site-wide): feesCollected always uses CLAIM-TIME USD price — never
// current price. Activity routes populate `usdAtTime` from on-chain V3
// historical sqrtPrice at each claim's block. If `usdAtTime` is null we fall
// back to amount × per-token price at claim time (also historical) before
// finally defaulting to 0 — never to current price.
function sumFeeClaimUsd(events: ActivityEventForPnL[]): number {
  let sum = 0;
  for (const e of events) {
    if (e.type !== "fee_claim" && e.type !== "reward_claim") continue;
    if (e.usdAtTime != null && Number.isFinite(e.usdAtTime) && e.usdAtTime > 0) {
      sum += e.usdAtTime;
      continue;
    }
    // Secondary: claim-time per-token prices (still historical, not current).
    const v0 = (e.amount0 ?? 0) * (e.price0AtTime ?? 0);
    const v1 = (e.amount1 ?? 0) * (e.price1AtTime ?? 0);
    const v = v0 + v1;
    if (Number.isFinite(v) && v > 0) sum += v;
  }
  return sum;
}

function buildFallbackPnL(pos: AerodromePosition): PositionPnLData {
  const value = pos.value;
  const unclaimed = pos.fees;
  const isClosed = pos.status === "Closed";
  return {
    initialValue: value,
    currentValue: value,
    closingValue: value,
    feesCollected: 0,
    feesUnclaimed: unclaimed,
    netPnlUSD: unclaimed,
    netPnlPct: value > 0 ? (unclaimed / value) * 100 : 0,
    ilPct: 0,
    ilUSD: 0,
    hodlValue: value,
    feesOffsetIL: true,
    entryPrice0: pos.price0 ?? 0,
    entryPrice1: pos.price1 ?? 0,
    currentPrice0: pos.price0 ?? 0,
    currentPrice1: pos.price1 ?? 0,
    depositCount: 0,
    firstDepositTs: 0,
    isClosed,
    totalAmount0: 0,
    totalAmount1: 0,
    entryRatio: 0,
    currentRatio: 0,
    priceRatioR: 0,
    ilAvailable: false,
    depositTxHashes: [],
  };
}

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

// Bumped v1 → v2: the v1 entries for Uniswap V3 closed positions cached
// events whose usdAtTime had been computed against a broken tickLower /
// tickUpper (the int24 decoder in /api/uniswap/v3 sign-extended into the
// upper uint256 instead of int24, so ticks came through as ~2^256 →
// parseInt truncated to 1 → deriveDepositPrices produced a 10^12 pool
// price → cached usdAtTime ≈ $10^12 → value_overflow). Bumping forces a
// fresh fetch with the fixed decoder.
const CACHE_KEY_PREFIX = "lp-pnl-events-v2-";
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

// Error reasons that indicate a transport failure (vs. legitimate "no data"
// like `no_deposits`). These should retry on flaky RPCs and eventually
// surface to the UI so the user knows the fetch failed rather than the
// position just having no on-chain history.
const ERROR_REASONS = new Set([
  "timeout", "fetch error", "no activity URL",
]);
function isTransportError(reason: string): boolean {
  return ERROR_REASONS.has(reason) || reason.startsWith("HTTP ");
}

// Retry policy: 1 initial attempt + up to 2 retries (per user spec).
// Backoff: 1s, 2s. Per-attempt timeouts: 30s, 30s, 45s — last attempt
// gets the most patience to handle slow archival RPCs (Tenderly chain).
const ATTEMPT_TIMEOUTS_MS = [30_000, 30_000, 45_000];
const ATTEMPT_BACKOFF_MS  = [0,      1_000,  2_000];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function fetchEventsAttempt(
  url: string, tag: string, timeoutMs: number,
): Promise<
  | { ok: true; events: Array<Record<string, unknown>> }
  | { ok: false; reason: string; cacheable: boolean }
> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`${tag} HTTP ${res.status} ${body.slice(0, 300)}`);
      return { ok: false, reason: `HTTP ${res.status}`, cacheable: false };
    }
    const json: { events?: Array<Record<string, unknown>>; error?: string } = await res.json();
    if (json.error) {
      console.error(`${tag} route error: ${json.error}`);
      return { ok: false, reason: json.error, cacheable: false };
    }
    if (!json.events || json.events.length === 0) {
      // Definitive empty result — cache so we don't re-hit the route.
      console.warn(`${tag} 0 events — no on-chain history found`);
      return { ok: false, reason: "no events", cacheable: true };
    }
    return { ok: true, events: json.events };
  } catch (err) {
    clearTimeout(timer);
    const isAbort = err instanceof Error && err.name === "AbortError";
    console.error(`${tag} fetch ${isAbort ? "timed out" : "threw"}:`, err);
    return { ok: false, reason: isAbort ? "timeout" : "fetch error", cacheable: false };
  }
}

async function fetchAndCompute(
  pos: AerodromePosition,
): Promise<
  | { ok: true; data: PositionPnLData; fallback?: true }
  | { ok: false; reason: string }
> {
  const tag = `[lpPnl] ${pos.protocol} ${pos.chain} ${pos.id}`;

  const url = buildActivityUrl(pos);
  if (!url) {
    console.error(`${tag} no activity URL — protocol not wired`);
    return { ok: false, reason: "no activity URL" };
  }

  const isHyperEvm = HYPEREVM_NFT_MANAGERS[pos.protocol] !== undefined;

  // Try cache first.
  let rawEvents: Array<Record<string, unknown>> | null = null;
  const cached = cacheGet(pos.id);
  if (cached) {
    if (cached.events === null) {
      console.log(`${tag} cache hit — empty (${cached.reason ?? "no events"})`);
      // HyperEVM fallback path on cached-empty: synthesize PnL from current
      // value rather than silently excluding. See buildFallbackPnL header.
      if (isHyperEvm && pos.value > 0) {
        console.log(`${tag} HyperEVM fallback (cached empty) — using current value $${pos.value.toFixed(2)} as deposit estimate`);
        return { ok: true, data: buildFallbackPnL(pos), fallback: true };
      }
      return { ok: false, reason: cached.reason ?? "no events" };
    }
    rawEvents = cached.events;
    console.log(`${tag} cache hit — ${rawEvents.length} events`);
  } else {
    // Retry loop: per-position transient failures (timeout / fetch error /
    // HTTP 5xx) get up to 2 retries with backoff before being surfaced as
    // `errored`. Definitive failures (HTTP 4xx, route error, empty events)
    // skip retries — retrying won't change the answer.
    let lastFailure: { reason: string } = { reason: "no attempts" };
    for (let attempt = 0; attempt < ATTEMPT_TIMEOUTS_MS.length; attempt++) {
      if (attempt > 0) {
        console.log(`${tag} retry ${attempt + 1}/${ATTEMPT_TIMEOUTS_MS.length} after ${ATTEMPT_BACKOFF_MS[attempt]}ms`);
        await sleep(ATTEMPT_BACKOFF_MS[attempt]);
      }
      const result = await fetchEventsAttempt(url, tag, ATTEMPT_TIMEOUTS_MS[attempt]);
      if (result.ok) {
        rawEvents = result.events;
        cacheSet(pos.id, { ts: Date.now(), events: rawEvents });
        break;
      }
      lastFailure = { reason: result.reason };
      // Cache definitive empty results so we don't re-fetch.
      if (result.cacheable) {
        cacheSet(pos.id, { ts: Date.now(), events: null, reason: result.reason });
        // HyperEVM fallback for fresh empty result — same rationale as the
        // cached-empty branch above.
        if (isHyperEvm && pos.value > 0) {
          console.log(`${tag} HyperEVM fallback (fresh empty) — using current value $${pos.value.toFixed(2)} as deposit estimate`);
          return { ok: true, data: buildFallbackPnL(pos), fallback: true };
        }
        return { ok: false, reason: result.reason };
      }
      // Stop retrying if this isn't a transport error (HTTP 4xx etc.).
      if (!isTransportError(result.reason)) {
        return { ok: false, reason: result.reason };
      }
    }
    if (rawEvents === null) {
      console.error(`${tag} all ${ATTEMPT_TIMEOUTS_MS.length} attempts failed — last reason: ${lastFailure.reason}`);
      return { ok: false, reason: lastFailure.reason };
    }
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
    // HyperEVM fallback for compute failures (no_deposits /
    // missing_deposit_prices). The activity route may have returned events
    // that include fee_claim records but no deposit records — pull the
    // claimed fees out of those events so they still land in the totals,
    // and build a synthetic PnL using current value as the deposit estimate.
    if (isHyperEvm && pos.value > 0) {
      const feesFromEvents = sumFeeClaimUsd(events);
      const fallback = buildFallbackPnL(pos);
      fallback.feesCollected = feesFromEvents;
      fallback.netPnlUSD = feesFromEvents + pos.fees;
      fallback.netPnlPct = pos.value > 0 ? ((feesFromEvents + pos.fees) / pos.value) * 100 : 0;
      console.log(
        `${tag} HyperEVM fallback (compute failed: ${result.reason}) — using current value $${pos.value.toFixed(2)} as deposit estimate, fees from events: $${feesFromEvents.toFixed(2)}`,
      );
      return { ok: true, data: fallback, fallback: true };
    }
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
  | { ok: true; data: PositionPnLData; fallback?: true }
  | { ok: false; reason: string };

interface PositionMeta {
  pair: string;
  protocol: string;
  chain: string;
}

// `isTransportError` and `ERROR_REASONS` are defined above (next to
// fetchEventsAttempt) so the retry loop can use them too.

function aggregate(
  resultsMap: Map<string, PosResult>,
  inflight: number,
  positionMeta: Map<string, PositionMeta>,
  unsupportedRejections: ExcludedPosition[],
): LpPnlResult {
  let initialValue = 0, currentValue = 0, closingValue = 0, feesCollected = 0, feesUnclaimed = 0, ilUSD = 0;
  let included = 0, excluded = 0, errored = 0, estimatedPositionCount = 0;
  const errorReasons = new Set<string>();
  // Per-position record built from the same map the totals come from — any
  // consumer that reads perPosition[id] gets a number that, summed across
  // every present id, EXACTLY equals the aggregated total. No drift possible.
  const perPosition: Record<string, PositionPnLData> = {};
  const excludedPositions: ExcludedPosition[] = [];

  // Belt-and-braces overflow guard at the aggregation boundary. computePositionPnL
  // already rejects implausible values with `value_overflow`, but if a bad number
  // ever sneaks past (e.g. a future protocol path returns ok:true with a raw
  // uint256 in initialValue), this second gate prevents trillions from showing
  // up in Total Deposited / IL / Net P&L. Threshold matches positionPnl.ts's
  // SINGLE_POSITION_USD_CEILING — kept duplicated rather than imported so the
  // hook is self-contained.
  const AGG_USD_CEILING = 10_000_000;
  const isPlausible = (v: number) => Number.isFinite(v) && Math.abs(v) <= AGG_USD_CEILING;

  for (const [id, r] of resultsMap) {
    if (r.ok) {
      const d = r.data;
      const componentsOk =
        isPlausible(d.initialValue) &&
        isPlausible(d.currentValue) &&
        isPlausible(d.closingValue) &&
        isPlausible(d.ilUSD) &&
        isPlausible(d.netPnlUSD);
      if (!componentsOk) {
        // Treat as an excluded position with a calculation-overflow reason.
        // We DO NOT touch feesCollected here — fees aggregation lives in the
        // separate feeIncome pipeline (analytics page) and has its own checks.
        const meta = positionMeta.get(id);
        console.error(
          `[useLpPnl] overflow guard rejected ${id} — ` +
          `initial=${d.initialValue} current=${d.currentValue} closing=${d.closingValue} ` +
          `ilUSD=${d.ilUSD} netPnl=${d.netPnlUSD}`,
        );
        if (meta) {
          excludedPositions.push({
            id, pair: meta.pair, protocol: meta.protocol, chain: meta.chain,
            reason: userFriendlyReason("value_overflow", meta.protocol),
          });
        }
        excluded += 1;
        continue;
      }

      // LP P&L scoping (per analytics-page card semantics):
      //   - Fees Collected: ALL positions (open + closed lifetime).
      //   - Everything else (initial / current / unclaimed / IL): OPEN ONLY.
      //
      // Closed positions are realised — once you've withdrawn, the "loss vs
      // HODL" is locked in (no longer impermanent), the "current value" is
      // zero by definition, the "initial deposited" was returned to you at
      // close, and there are no pending unclaimed fees. Including them in the
      // headline numbers conflates the present open-portfolio state with
      // historical-price-drift artefacts (e.g. closing $5k of HYPE when HYPE
      // was $30 and HYPE is now $60 inflates the HODL basis). Only fees stay
      // lifetime because that's the natural lifetime measure of LP earnings.
      // `closingValue` aggregate is intentionally not summed here — the
      // per-position `perPosition[id].closingValue` still carries the close-
      // event value for any per-position UI that needs it (e.g. dashboard row).
      feesCollected += d.feesCollected;
      if (!d.isClosed) {
        initialValue += d.initialValue;
        currentValue += d.currentValue;
        feesUnclaimed += d.feesUnclaimed;
        ilUSD += d.ilUSD;
      }
      included += 1;
      perPosition[id] = d;
      if (r.fallback) estimatedPositionCount += 1;
    } else {
      const meta = positionMeta.get(id);
      if (meta) {
        excludedPositions.push({
          id, pair: meta.pair, protocol: meta.protocol, chain: meta.chain,
          reason: userFriendlyReason(r.reason, meta.protocol),
        });
      }
      if (isTransportError(r.reason)) {
        errored += 1;
        errorReasons.add(r.reason);
      } else {
        excluded += 1;
      }
    }
  }

  // Append unsupported-protocol rejections (Cetus, Momentum, etc.) — these
  // never make it through the eligibility filter so they have no entry in
  // resultsMap, but the user still deserves to see them in the warning.
  excludedPositions.push(...unsupportedRejections);

  // Net P&L derived strictly from the displayed fields per the LP P&L card
  // semantics: open Current + lifetime Fees + open Unclaimed − open Initial.
  // closingValue is no longer a term (closed positions don't contribute their
  // realised value to the headline either).
  const netPnl = currentValue + feesCollected + feesUnclaimed - initialValue;
  const netPnlPct = initialValue > 0 ? (netPnl / initialValue) * 100 : 0;

  // Per-position contribution log — fires every time `aggregate()` runs (every
  // landed fetch + every refresh tick). Lets you trace EXACTLY which position
  // is adding what to Total Deposited / Net P&L when those numbers look off.
  // Logs only when there's at least one included position (avoids log spam
  // during the empty-state loading phase before any fetch lands).
  if (inflight === 0 && included > 0) {
    const breakdown = Object.entries(perPosition).map(([id, d]) => ({
      id,
      isClosed: d.isClosed,
      initial: Number(d.initialValue.toFixed(2)),
      current: Number(d.currentValue.toFixed(2)),
      closing: Number(d.closingValue.toFixed(2)),
      feesClaimed: Number(d.feesCollected.toFixed(2)),
      ilUSD: Number(d.ilUSD.toFixed(2)),
      netPnl: Number(d.netPnlUSD.toFixed(2)),
    }));
    console.log(
      `[useLpPnl] aggregate — included=${included} excluded=${excluded} errored=${errored} ` +
      `initial=$${initialValue.toFixed(2)} current=$${currentValue.toFixed(2)} ` +
      `closing=$${closingValue.toFixed(2)} ilUSD=$${ilUSD.toFixed(2)} netPnl=$${netPnl.toFixed(2)}`,
    );
    console.table(breakdown);
    if (excludedPositions.length > 0) {
      console.log(
        `[useLpPnl] excluded positions:`,
        excludedPositions.map((ep) => `${ep.id} (${ep.protocol}/${ep.chain}) — ${ep.reason}`),
      );
    }
  }

  return {
    initialValue, currentValue, closingValue, feesCollected, feesUnclaimed,
    ilUSD, netPnl, netPnlPct, included, excluded,
    errored, errorReasons: Array.from(errorReasons),
    isLoading: inflight > 0,
    perPosition,
    excludedPositions,
    estimatedPositionCount,
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
  // Per-position metadata (pair, protocol, chain) tracked so the warning
  // banner can reference excluded positions by name. Updated each useEffect.
  const positionMetaRef = useRef<Map<string, PositionMeta>>(new Map());
  // Positions rejected at the eligibility step for "unsupported protocol"
  // (Cetus, Momentum, anything not in ACTIVITY_PROTOCOLS). Surfaced in the
  // warning banner so the user knows P&L isn't calculated for them.
  const unsupportedRejectionsRef = useRef<ExcludedPosition[]>([]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    // Analytics now shows BOTH current state AND lifetime realised P&L —
    // CLOSED positions are included in the aggregation so their realised
    // initialValue / closingValue / feesCollected (and realised IL at close)
    // contribute to the totals. Net P&L = currentValue + closingValue + fees
    // − initialValue captures both unrealised (open) and realised (closed)
    // performance. Zero-value OPEN positions are still excluded — they have
    // no meaningful state to compute.
    const seen = new Set<string>();
    const meta = new Map<string, PositionMeta>();
    const unsupported: ExcludedPosition[] = [];

    const eligible = positions.filter((p) => {
      const isClosed = p.status === "Closed";

      if (!ACTIVITY_PROTOCOLS.has(p.protocol)) {
        // Surface unsupported protocols (Cetus, Momentum, etc.) ONLY if the
        // position is active — closed/zero-value rejected ones aren't
        // interesting to flag. Prevents the warning from listing dust.
        if (!isClosed && p.value > 0) {
          unsupported.push({
            id: p.id, pair: p.pair, protocol: p.protocol, chain: p.chain,
            reason: userFriendlyReason("unsupported protocol", p.protocol),
          });
        }
        return false;
      }
      // Reject zero-value OPEN positions (no state). Closed positions with
      // pos.value === 0 are EXPECTED (their liquidity is fully withdrawn) —
      // accept them so their realised closingValue + feesCollected contribute.
      if (!isClosed && p.value <= 0) return false;
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      // Track metadata for every eligible position (open + closed) so the
      // excluded-warning banner can reference them by name if their fetch fails.
      meta.set(p.id, { pair: p.pair, protocol: p.protocol, chain: p.chain });
      return true;
    });

    positionMetaRef.current = meta;
    unsupportedRejectionsRef.current = unsupported;

    // Evict any prior results / inflight markers for positions that are no
    // longer eligible (e.g. one filtered out as zero-value open). Without
    // this, their stale initialValue / currentValue / IL would keep
    // contributing to totals.
    const eligibleIds = new Set(eligible.map((p) => p.id));
    for (const id of Array.from(resultsRef.current.keys())) {
      if (!eligibleIds.has(id)) resultsRef.current.delete(id);
    }
    for (const id of Array.from(inflightRef.current)) {
      if (!eligibleIds.has(id)) inflightRef.current.delete(id);
    }

    // Evict cached results whose `isClosed` no longer matches the current
    // position status. Happens when a position transitions Open → Closed
    // (or vice versa) between refreshes — the cached `currentValue` /
    // `closingValue` were computed for the wrong state and need recomputing.
    // We don't re-fetch events (those are still valid); fetchAndCompute will
    // hit its localStorage event cache and re-run computePositionPnL with
    // the updated isClosed flag.
    for (const p of eligible) {
      const cached = resultsRef.current.get(p.id);
      if (cached && cached.ok && cached.data.isClosed !== (p.status === "Closed")) {
        resultsRef.current.delete(p.id);
      }
    }

    if (eligible.length === 0) {
      // Even with no eligible positions we may have unsupported ones to
      // surface — emit a result that includes them rather than EMPTY.
      setResult({
        ...EMPTY,
        excludedPositions: [...unsupportedRejectionsRef.current],
      });
      return;
    }

    // Find positions we haven't fetched or started fetching yet.
    const toFetch = eligible.filter(
      (p) => !resultsRef.current.has(p.id) && !inflightRef.current.has(p.id),
    );

    if (toFetch.length === 0) {
      // All positions already fetched — just recompute totals (in case
      // positions array changed order but same IDs).
      setResult(aggregate(resultsRef.current, inflightRef.current.size, positionMetaRef.current, unsupportedRejectionsRef.current));
      return;
    }

    // Mark as inflight and update loading state.
    for (const p of toFetch) inflightRef.current.add(p.id);
    setResult(aggregate(resultsRef.current, inflightRef.current.size, positionMetaRef.current, unsupportedRejectionsRef.current));

    // HyperEVM sequential chain — Etherscan V2 free tier is 5 req/sec, and
    // each /api/hyperswap/activity call fires 3 parallel topic requests that
    // take ~2-3s wall time. A fixed-interval stagger isn't sufficient because
    // concurrent route calls still overlap at the Etherscan layer — verified
    // live: 4 positions × 3 topics with even a 700ms stagger leaves 2 of 4
    // positions empty. Serialise HyperEVM fetches behind a shared promise
    // chain so the next one only fires after the previous one's Etherscan
    // calls finish. Non-HyperEVM protocols fire in parallel as before.
    //
    // This hook AND useAllPositionsActivity both call /api/hyperswap/activity
    // on the same wallet load — each independently serialises its own
    // fan-out, and each call carries its own 5-min localStorage cache so
    // they share upstream pressure only on the very first cold load.
    let hyperEvmChain: Promise<unknown> = Promise.resolve();

    // Fire fetches — each one lands independently.
    for (const pos of toFetch) {
      const isHyperEvm = HYPEREVM_NFT_MANAGERS[pos.protocol] !== undefined;
      const run = async () => {
        if (isHyperEvm) {
          const previous = hyperEvmChain;
          let releaseChain!: () => void;
          hyperEvmChain = new Promise<void>((resolve) => { releaseChain = resolve; });
          try {
            await previous;
            return await fetchAndCompute(pos);
          } finally {
            releaseChain();
          }
        }
        return fetchAndCompute(pos);
      };
      run().then((r) => {
        if (!mountedRef.current) return;
        inflightRef.current.delete(pos.id);
        resultsRef.current.set(pos.id, r);
        setResult(aggregate(resultsRef.current, inflightRef.current.size, positionMetaRef.current, unsupportedRejectionsRef.current));
      });
    }
  }, [positions]);

  return result;
}
