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
  /**
   * Realised gain/loss from CLOSED positions: Σ (closingValue − initialValue)
   * across positions where `data.isClosed === true` AND the position's chain
   * is in the EVM whitelist. Solana / Sui closed positions are excluded
   * because their on-chain close artefacts (NFT burn / Move object destroy)
   * make exit-value reconstruction unreliable — including them would mis-
   * report as a near-100% loss (closingValue=0, initialValue>0).
   * Sign: positive = realised gain, negative = realised loss.
   */
  capitalGL: number;
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
  // lower than expected. Includes: unsupported protocols (Momentum),
  // missing-data positions (no_deposits, missing_deposit_prices), and
  // transport-error positions after all retries failed.
  excludedPositions: ExcludedPosition[];
  // Count of positions that ARE included in the totals but used the
  // HyperEVM-style fallback (current value as proxy for initial value
  // because deposit history wasn't recoverable from RPC). The analytics
  // page prefixes the "Total Deposited" card with "~" when this is > 0.
  estimatedPositionCount: number;
  // Total number of fee claims across all included positions that have NO
  // historical USD valuation — the activity route left them unresolved rather
  // than fall back to current spot (pricing-invariants Rule 1). Surfaced in the
  // analytics UI as "N claims pending price resolution" so the user knows a
  // fee figure is incomplete (vs. silently understated). 0 in the happy path.
  pendingClaimCount: number;
}

const EMPTY: LpPnlResult = {
  initialValue: 0, currentValue: 0, closingValue: 0, feesCollected: 0, feesUnclaimed: 0,
  ilUSD: 0, capitalGL: 0, netPnl: 0, netPnlPct: 0, included: 0, excluded: 0,
  errored: 0, errorReasons: [], isLoading: false,
  perPosition: {},
  excludedPositions: [],
  estimatedPositionCount: 0,
  pendingClaimCount: 0,
};

// Map technical exclusion reasons to user-friendly text shown in the warning
// banner. Keep these terse but informative — the user doesn't need to know
// what computePositionPnL returns internally.
function userFriendlyReason(reason: string, protocol: string): string {
  if (reason === "no_deposits" || reason === "no events") {
    if (protocol === "HyperSwap" || protocol === "KittenSwap" || protocol === "ProjectX") {
      // HyperEVM positions taking this branch DESPITE the fallback below
      // means the position has 0 value — fallback only kicks in when value > 0.
      // Keep the user-facing text simple; the technical cause (which tier
      // failed, rate-limit vs timeout) lives in the deposit_retrieval
      // [PRICE_LOG] event for debugging.
      return "Deposit history could not be retrieved for this position";
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

// Count fee_claim / reward_claim events with NO historical valuation — neither
// usdAtTime nor claim-time per-token prices. These are NOT valued at current
// spot (pricing-invariants Rule 1); they're surfaced as "pending price
// resolution". Mirrors the skip-conditions in sumFeeClaimUsd so the count and
// the sum stay consistent. Used on the HyperEVM fallback path, where
// buildFallbackPnL constructs its own PnL object (computePositionPnL — which
// also tracks pendingClaimCount — didn't run).
function countPendingFeeClaims(events: ActivityEventForPnL[]): number {
  let n = 0;
  for (const e of events) {
    if (e.type !== "fee_claim" && e.type !== "reward_claim") continue;
    const hasUsd = e.usdAtTime != null && Number.isFinite(e.usdAtTime) && e.usdAtTime > 0;
    const perToken = (e.amount0 ?? 0) * (e.price0AtTime ?? 0) + (e.amount1 ?? 0) * (e.price1AtTime ?? 0);
    const hasPerToken = Number.isFinite(perToken) && perToken > 0;
    if (!hasUsd && !hasPerToken) n += 1;
  }
  return n;
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
  "Aerodrome", "Bluefin", "Cetus", "Momentum", "Orca", "Raydium",
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
    if (pos.poolAddress) p.set("pool", pos.poolAddress);
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
  if (pos.protocol === "Cetus") {
    p.set("positionId", pos.id.replace("cetus-", ""));
    p.set("decimalsA", String(pos.token0Decimals ?? 9));
    p.set("decimalsB", String(pos.token1Decimals ?? 6));
    if (pos.coinTypeA) p.set("coinTypeA", pos.coinTypeA);
    if (pos.coinTypeB) p.set("coinTypeB", pos.coinTypeB);
    if (pos.price0 != null) p.set("priceA", String(pos.price0));
    if (pos.price1 != null) p.set("priceB", String(pos.price1));
    if (pos.walletAddress) p.set("account", pos.walletAddress);
    appendTicks();
    return `/api/cetus/activity?${p}`;
  }
  if (pos.protocol === "Momentum") {
    p.set("positionId", pos.id.replace("momentum-", ""));
    p.set("decimalsA", String(pos.token0Decimals ?? 9));
    p.set("decimalsB", String(pos.token1Decimals ?? 6));
    if (pos.coinTypeA) p.set("coinTypeA", pos.coinTypeA);
    if (pos.coinTypeB) p.set("coinTypeB", pos.coinTypeB);
    if (pos.price0 != null) p.set("priceA", String(pos.price0));
    if (pos.price1 != null) p.set("priceB", String(pos.price1));
    if (pos.walletAddress) p.set("account", pos.walletAddress);
    appendTicks();
    return `/api/momentum/activity?${p}`;
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
    if (pos.poolAddress) p.set("pool", pos.poolAddress);
    appendTicks();
    // Sprint 1.14: closed HyperEVM positions have an immutable deposit history;
    // the route persists it in Redis so a throttled Etherscan can't drop it.
    if (pos.status === "Closed") p.set("closed", "1");
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
    if (pos.poolAddress) p.set("pool", pos.poolAddress);
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
    if (pos.poolAddress) p.set("pool", pos.poolAddress);
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
    if (pos.poolAddress) p.set("pool", pos.poolAddress);
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
// Bumped v2 → v3: Orca SOL/RENDER and SOL/Fartcoin positions had cached
// events computed when those tokens had no price (excluded with
// missing_current_prices). Adding them to Orca's KNOWN_TOKENS fixes the
// price; the bump forces every user worldwide to re-fetch fresh events
// without manually clearing localStorage.
// Bumped v3 → v4: HyperEVM positions (e.g. ProjectX token 393471) cached
// a `no_deposits` exclusion from BEFORE the Tier-2 archive RPC swap to
// Chainstack — their deposit event was older than the prior DRPC ~40h
// window and unretrievable. The deposit is now fetchable and computes
// cleanly (single-sided AND two-sided deposits were already handled
// correctly by deriveDepositPrices + computePositionPnL). The bump
// discards the stale exclusion so the position re-fetches and is included.
// Bumped v4 → v5: HYPE/USDC positions on the third Circle-native USDC
// contract (0x3061caa1…) cached events with price=0 for the USDC side
// (contract wasn't in hyperswap KNOWN_TOKENS) → missing_current_prices
// exclusion. Adding the contract + a dynamic CG symbol-search fallback
// fixes the price; the bump forces a fresh fetch worldwide.
// Bumped v5 → v7: Cetus per-position activity is now supported (Bluefin-pattern
// route at /api/cetus/activity with the verified 3-package allowlist + V2 event
// names + reward_claim parsing). Skipping v6 — destination version per spec to
// keep CLAUDE.md/the changelog aligned with the user's mental model of the bump.
// Bumped v7 → v8: Cetus + Bluefin wallet-scope routes now filter fee/reward
// events to positions the wallet currently owns (suix_getOwnedObjects-backed),
// rejecting router/aggregator-emitted events against OTHER users' positions.
// Cached pre-fix wallet-scope entries may include those foreign-position fees,
// so we force a fresh fetch worldwide.
// Bumped v8 → v9: useCetusActivity per-position cache bumped v1→v2 to force
// fresh fetches after pagination + wallet-scope ownership fix. useLpPnl uses
// its own activity-fetch path (buildActivityUrl), so bump here too so any
// stale lp-pnl Cetus event caches are discarded alongside the hook caches.
// Bumped v9 → v10: Cetus wallet-scope fee scan now uses per-wallet pool
// context (real coinTypeA/B from open positions) instead of the
// SUI(A)/USDC(B) static fallback that mis-priced USDC/SUI pools and
// inflated USD values by orders of magnitude. Bump invalidates any
// lp-pnl event caches that captured those wrong USD values.
// Bumped v10 → v11: Sui activity routes (Cetus + Bluefin) now value
// fee_claim and reward_claim events against historical SUI price at the
// claim's date (CoinGecko coins/sui/history), not today's spot. Any cached
// events that captured wrong-era SUI prices need a fresh fetch.
// Bumped v11 → v12: EVM V3 activity routes (Aerodrome, Velodrome, Uniswap,
// HyperSwap, PancakeSwap) now resolve historical sqrtPriceX96 at the
// block of EVERY event (deposits + withdrawals + fee claims), not just
// fee claims. Previously deposits/withdrawals fell through to
// deriveDepositPrices's tick-boundary estimate which is wildly wrong for
// single-sided events (one amount is 0). Bump invalidates any cached
// events that captured those wrong USD values.
// Bumped v12 → v13: useLpPnl's buildActivityUrl was NOT forwarding the
// position's `poolAddress` to EVM V3 activity routes — only
// useAllPositionsActivity was. As a result every analytics LP P&L fetch
// hit the route without a `pool` param, so the route skipped the
// historical sqrtPriceX96 resolver and ALL events (including fee claims)
// fell back to current-price × amounts. Cached entries from v12 carry
// that wrong-USD history; bump forces a fresh fetch where the resolver
// runs and populates accurate per-block prices.
// Bumped v20 → v21: one-time flush of stale entries that were cached as
// `{events: null}` / empty during a transient route failure (cold serverless,
// RPC flake) and then shadowed now-healthy route data under the 5-min TTL —
// the root cause of the Aerodrome + Cetus exclusions in the analytics LP P&L
// section. Paired with the differentiated-TTL change below so empties expire
// in 60s instead of 5min going forward.
// Bumped v21 → v22: HyperEVM fee claims that miss the historical price cache
// are now left UNRESOLVED (usdAtTime/price0/1AtTime all null) instead of being
// valued at current spot (pricing-invariants Rule 1). v21 entries cached the
// old spot-valued usdAtTime (which over-reported, e.g. Account 2 ProjectX
// $2,243 vs manual $1,780); the bump flushes them so claims re-fetch under the
// corrected ladder.
// Bumped v22 → v23: Sprint 1.6 adds a Tier-1 Upstash Redis persistent price
// cache above the in-process historical-price cache. Claim valuation FORMULA is
// unchanged, but the resolution PATH changed — some HyperEVM claims that
// previously timed out to UNRESOLVED now resolve from warm Redis — so flush v22
// entries to re-resolve under the new ladder.
// Bumped v23 → v24: Sprint 2.1b parity with analytics-activity v15 → v16. The
// Aerodrome/Velodrome activity routes now (a) emit `logIndex` on every event
// (shape change) and (b) value fee claims historical-only — sqrtPriceX96 →
// CoinGecko-historical → DeFiLlama-historical → pending — with the cg-spot last
// resort REMOVED (Rule 1a). useLpPnl's per-position Capital-G/L / Fees-Collected
// values were already correct (it never used the wallet-scope path), but flush
// v23 so analytics & LP-P&L refresh in lockstep under the new event shape.
// Bumped v24 → v25: Sprint NEW parity with analytics-activity v16 → v17. The
// Bluefin activity route now values FEE claims historical-ONLY (stable → $1;
// SUI → CoinGecko-historical → DeFiLlama-historical → pending; other non-stable
// → DeFiLlama-historical → pending) — the current-spot fallbackA/fallbackB last
// resort was REMOVED for Bluefin fee claims (Rule 1a, mirrors Cetus 1.15). v24
// entries carry spot-contaminated cold-cache Bluefin fee values; flush so
// Fees-Collected re-resolves under the new cascade in lockstep with analytics.
// Bumped v25 → v26: Sprint 2.2c parity with analytics-activity v17 → v18. Cetus +
// Bluefin fee-claim SUI side now reads getHistoricalOnlySuiPrice (pure historical)
// instead of getCachedSuiPriceForTimestamp, which could return the FIX-C cg-spot
// fallback on a CoinGecko-historical miss (Rule 1a leak). v25 entries may carry
// spot-contaminated fee values; flush so they re-resolve via DeFiLlama / pending.
// Bumped v26 → v27: Sprint MOMENTUM parity with analytics-activity v18 → v19.
// Momentum is now an ACTIVITY_PROTOCOL (open positions route to
// /api/momentum/activity instead of being surfaced as unsupported rejections)
// AND its closed positions fold into Capital G/L via /api/sui-closed-positions.
// Both change cached LP-P&L output, so flush v26 so every user re-resolves.
const CACHE_KEY_PREFIX = "lp-pnl-events-v27-";
const CACHE_TTL_MS = 5 * 60 * 1000;       // 5 min — successful fetch with events
const EMPTY_RESULT_TTL_MS = 60 * 1000;    // 60s — legitimately-empty result (retry soon)

interface CachedEntry {
  ts: number;
  events: Array<Record<string, unknown>> | null; // null = previous fetch returned no events
  reason?: string; // populated when events is null and we want to remember why
  // Per-entry TTL so an empty result expires fast (60s) while a real events
  // payload lives the full 5min. Read path uses `ttl ?? CACHE_TTL_MS` so any
  // legacy entry without the field falls back to the 5min default (moot after
  // the v21 prefix bump flushes all old entries). Uniform across all chains.
  ttl?: number;
}

function cacheGet(posId: string): CachedEntry | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(CACHE_KEY_PREFIX + posId);
    if (!raw) return null;
    const entry = JSON.parse(raw) as CachedEntry;
    if (Date.now() - entry.ts > (entry.ttl ?? CACHE_TTL_MS)) return null;
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

// Retry policy (Sprint PERFORMANCE): ONE patient attempt with a 150s ceiling,
// plus at most one retry that fires ONLY on a network error or HTTP 5xx —
// NEVER on a timeout. The previous 60/60/90s abort-and-retry pattern was a
// self-inflicted amplifier: aborting the client fetch does NOT stop the
// server-side route (the lambda keeps computing), so a slow-but-healthy route
// (e.g. a Sui activity scan crawling the CoinGecko-historical queue) spawned up
// to 3 duplicate server executions per position — tripling the very contention
// that made it slow — and burned ~213s of client wall-clock before surfacing a
// healthy position as errored. A single patient attempt lets the route finish
// once; while it runs the position stays in the inflight ("still loading")
// state, not an error state. Uniform across ALL chains — no per-chain override.
const ATTEMPT_TIMEOUTS_MS = [150_000, 150_000];
const ATTEMPT_BACKOFF_MS  = [0,       1_000];

// Retry ONLY these failures: transient transport problems where a second
// attempt can genuinely change the answer. A timeout is explicitly NOT here —
// the server is still working; re-sending the request just duplicates its work.
function isRetryableFailure(reason: string): boolean {
  return reason === "fetch error" || /^HTTP 5\d\d/.test(reason);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── Per-endpoint client-side concurrency limiter ────────────────────────────
// Caps concurrent fetches PER activity endpoint pathname (e.g.
// /api/hyperswap/activity, /api/aerodrome/activity, /api/cetus/activity). Keying
// by pathname makes it per-chain in EFFECT without a single `if (chain === …)`
// branch — query params (nftManager distinguishing HyperSwap/KittenSwap/
// ProjectX, etc.) hit the SAME provider's rate budget so they share one queue.
// Endpoints on different chains have independent slots and run in parallel.
//
// Replaces the prior global concurrency-5 worker pool, which removed the
// HyperEVM serialization and re-triggered Etherscan-burst empties (4 ProjectX
// positions firing at once → 12 topic calls → 5 req/sec limit → empty/timeout).
// MAX_PER_ENDPOINT=2 is uniform across all chains and conservative enough for
// HyperEVM's Etherscan budget; other chains simply never hit the cap.
//
// Module-scope so concurrent hook instances / renders share one fair queue.
// Race-free semaphore: on release the slot is handed DIRECTLY to the next
// waiter (count unchanged) rather than decrement-then-reacquire, so the in-use
// count can never transiently exceed MAX_PER_ENDPOINT.
const MAX_PER_ENDPOINT = 2;
const endpointInUse = new Map<string, number>();
const endpointWaiters = new Map<string, Array<() => void>>();

function endpointKeyOf(activityUrl: string): string {
  const q = activityUrl.indexOf("?");
  return q === -1 ? activityUrl : activityUrl.slice(0, q);
}

async function paceByEndpoint<R>(key: string, fn: () => Promise<R>): Promise<R> {
  const inUse = endpointInUse.get(key) ?? 0;
  if (inUse < MAX_PER_ENDPOINT) {
    endpointInUse.set(key, inUse + 1);
  } else {
    // At capacity — park until an in-flight fetch on this endpoint hands us its slot.
    await new Promise<void>((resolve) => {
      const w = endpointWaiters.get(key) ?? [];
      w.push(resolve);
      endpointWaiters.set(key, w);
    });
    // Slot inherited without decrement — count stays the same.
  }
  try {
    return await fn();
  } finally {
    const w = endpointWaiters.get(key);
    if (w && w.length > 0) {
      // Hand our slot straight to the next waiter (count unchanged).
      w.shift()!();
    } else {
      endpointInUse.set(key, (endpointInUse.get(key) ?? 1) - 1);
    }
  }
}

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
    // Retry loop (Sprint PERFORMANCE): one patient 150s attempt; at most one
    // retry, fired ONLY for a retryable transport failure (network error /
    // HTTP 5xx — see isRetryableFailure). A TIMEOUT never retries: the server
    // is still computing the aborted request, and re-sending it just spawns a
    // duplicate execution that worsens the contention that made it slow.
    // Definitive failures (HTTP 4xx, route error, empty events) also skip
    // retries — retrying won't change the answer.
    let lastFailure: { reason: string } = { reason: "no attempts" };
    for (let attempt = 0; attempt < ATTEMPT_TIMEOUTS_MS.length; attempt++) {
      if (attempt > 0) {
        console.log(`${tag} retry ${attempt + 1}/${ATTEMPT_TIMEOUTS_MS.length} after ${ATTEMPT_BACKOFF_MS[attempt]}ms`);
        await sleep(ATTEMPT_BACKOFF_MS[attempt]);
      }
      const result = await fetchEventsAttempt(url, tag, ATTEMPT_TIMEOUTS_MS[attempt]);
      if (result.ok) {
        rawEvents = result.events;
        // Successful fetch with events → full 5min TTL.
        cacheSet(pos.id, { ts: Date.now(), events: rawEvents, ttl: CACHE_TTL_MS });
        break;
      }
      lastFailure = { reason: result.reason };
      // Cache definitive empty results so we don't re-fetch — but with a SHORT
      // 60s TTL (not 5min) so a transient empty (cold serverless / RPC flake)
      // self-heals on the next reload instead of shadowing healthy data for
      // 5 minutes. Errors/timeouts are never cached (result.cacheable is false
      // for them), so the next load always retries those fresh.
      if (result.cacheable) {
        cacheSet(pos.id, { ts: Date.now(), events: null, reason: result.reason, ttl: EMPTY_RESULT_TTL_MS });
        // HyperEVM fallback for fresh empty result — same rationale as the
        // cached-empty branch above.
        if (isHyperEvm && pos.value > 0) {
          console.log(`${tag} HyperEVM fallback (fresh empty) — using current value $${pos.value.toFixed(2)} as deposit estimate`);
          return { ok: true, data: buildFallbackPnL(pos), fallback: true };
        }
        return { ok: false, reason: result.reason };
      }
      // Only a retryable transport failure earns the second attempt. Timeouts
      // and definitive failures (HTTP 4xx etc.) surface immediately.
      if (!isRetryableFailure(result.reason)) {
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
      fallback.pendingClaimCount = countPendingFeeClaims(events);
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
  // Sprint 2.2b: closed Sui (Cetus/Bluefin) positions, reconstructed from events
  // and pre-computed via computePositionPnL in the hook's Sui effect. Kept in a
  // SEPARATE map (not resultsMap) so the positions-array eviction can't drop them;
  // merged here so they flow through the IDENTICAL per-position loop as EVM.
  suiClosed: Map<string, PosResult> = new Map(),
  suiClosedMeta: Map<string, PositionMeta> = new Map(),
  // Sprint 3-FREE: closed Solana (Orca) positions, reconstructed from wallet tx
  // history (burned NFTs) and pre-computed via computePositionPnL in the hook's
  // Solana effect. Same disjoint-map contract as suiClosed — distinct ids
  // (solana-closed-*), chain "Solana", folded into Capital G/L identically.
  solanaClosed: Map<string, PosResult> = new Map(),
  solanaClosedMeta: Map<string, PositionMeta> = new Map(),
): LpPnlResult {
  // Merge the external-closed map/meta (Sui + Solana) into the inputs the loop
  // iterates. Both sets are disjoint from resultsMap (destroyed objects / burned
  // NFTs, distinct ids) and from each other, so no override.
  const externalClosed = suiClosed.size || solanaClosed.size ? new Map([...suiClosed, ...solanaClosed]) : suiClosed;
  const externalClosedMeta = suiClosedMeta.size || solanaClosedMeta.size ? new Map([...suiClosedMeta, ...solanaClosedMeta]) : suiClosedMeta;
  const results = externalClosed.size ? new Map([...resultsMap, ...externalClosed]) : resultsMap;
  const meta = externalClosedMeta.size ? new Map([...positionMeta, ...externalClosedMeta]) : positionMeta;
  let initialValue = 0, currentValue = 0, closingValue = 0, feesCollected = 0, feesUnclaimed = 0, ilUSD = 0;
  let capitalGL = 0;
  let included = 0, excluded = 0, errored = 0, estimatedPositionCount = 0;
  let pendingClaimCount = 0;
  // Chains whose closed-position withdrawal events we trust on-chain.
  // EVM routes emit withdrawal events from DecreaseLiquidity logs with
  // historically-derived USD (via deriveDepositPrices), so closingValue
  // is reliable. Solana destroys position NFTs on close and Sui destroys
  // Move position objects → no readable withdrawal artifact → skip.
  // Chain literals match exactly what each position route emits in pos.chain
  // (e.g. "HyperEVM" — NOT "Hyperliquid L1" which is only the DefiLlama
  // project lookup string in app/api/hyperswap/route.ts).
  // Sprint 2.2b: "Sui" added — closed Cetus/Bluefin positions are reconstructed
  // from on-chain events (their objects are destroyed on close) and injected via
  // the separate suiClosedResults map below; they carry chain "Sui" and a reliable
  // historically-valued closingValue/initialValue, so they fold into Capital G/L
  // exactly like EVM closed positions. Sprint 3-FREE: "Solana" added — closed
  // Orca positions (burned NFTs) are reconstructed from wallet tx history (scanned
  // via the free Alchemy endpoint) and injected via the separate solanaClosed map,
  // carrying chain "Solana" and a reliable historically-valued closingValue/
  // initialValue, so they fold into Capital G/L exactly like EVM + Sui closed.
  const CAPITAL_GL_CHAINS = new Set([
    "HyperEVM", "Base", "Arbitrum", "Optimism", "Polygon", "Ethereum", "BNB Chain", "Sui", "Solana",
  ]);
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

  for (const [id, r] of results) {
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
        const m = meta.get(id);
        console.error(
          `[useLpPnl] overflow guard rejected ${id} — ` +
          `initial=${d.initialValue} current=${d.currentValue} closing=${d.closingValue} ` +
          `ilUSD=${d.ilUSD} netPnl=${d.netPnlUSD}`,
        );
        if (m) {
          excludedPositions.push({
            id, pair: m.pair, protocol: m.protocol, chain: m.chain,
            reason: userFriendlyReason("value_overflow", m.protocol),
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
      } else {
        // Realised capital G/L from CLOSED positions on EVM chains only —
        // see CAPITAL_GL_CHAINS at the top of aggregate() for the chain
        // whitelist rationale. positionMeta is populated for every
        // position that passed the eligibility filter, so meta should
        // always be present here; defensive `?.` keeps us safe if a
        // future code path ever bypasses metadata.
        const chain = meta.get(id)?.chain;
        if (chain && CAPITAL_GL_CHAINS.has(chain)) {
          capitalGL += d.closingValue - d.initialValue;
        }
      }
      included += 1;
      perPosition[id] = d;
      pendingClaimCount += d.pendingClaimCount ?? 0;
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

  // Append unsupported-protocol rejections (Momentum, etc.) — these
  // never make it through the eligibility filter so they have no entry in
  // resultsMap, but the user still deserves to see them in the warning.
  excludedPositions.push(...unsupportedRejections);

  // Net P&L mirrors the analytics LP P&L card formula:
  //   open Current + lifetime Fees + open Unclaimed + realised capitalGL
  //   − open Initial.
  // capitalGL folds closed-position outcomes (closingValue − initialValue
  // on EVM only) into the headline so a wallet that's churned its open
  // positions still sees its realised gains/losses in Net P&L — without
  // having to also bake closed-position initials into Total Deposited or
  // closing values into Current Value.
  const netPnl = currentValue + feesCollected + feesUnclaimed + capitalGL - initialValue;
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
      `closing=$${closingValue.toFixed(2)} ilUSD=$${ilUSD.toFixed(2)} ` +
      `capitalGL=$${capitalGL.toFixed(2)} netPnl=$${netPnl.toFixed(2)}`,
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
    ilUSD, capitalGL, netPnl, netPnlPct, included, excluded,
    errored, errorReasons: Array.from(errorReasons),
    isLoading: inflight > 0,
    perPosition,
    excludedPositions,
    estimatedPositionCount,
    pendingClaimCount,
  };
}

// ── Hook ────────────────────────────────────────────────────────────────────
// Positions arrive in waves as different chains load. Instead of cancelling
// and restarting all fetches on every wave, we accumulate per-position results
// incrementally. Already-fetched positions keep their result; only new
// positions trigger fetches. This prevents the race condition where late-
// arriving chains cancel in-flight fetches from earlier chains.

// Sprint 2.2b — shape of one closed Sui position returned by
// /api/sui-closed-positions (the JSON wire form of SuiClosedPosition). Declared
// locally so the client hook never imports the SERVER lib (which pulls in Redis).
interface SuiClosedPositionDTO {
  positionId: string;
  protocol: "cetus" | "bluefin" | "momentum";
  pair: string;
  events: ActivityEventForPnL[];
}

// Closed Sui position protocol → display label (used for the Capital G/L
// breakdown / warning banner metadata).
const SUI_CLOSED_PROTOCOL_LABEL: Record<SuiClosedPositionDTO["protocol"], string> = {
  cetus: "Cetus",
  bluefin: "Bluefin",
  momentum: "Momentum",
};

// Sprint 3-FREE — shape of one closed Solana (Orca) position returned by
// /api/solana-closed-positions (the JSON wire form of SolanaClosedPosition).
// Declared locally so the client hook never imports the SERVER lib (Redis + web3).
interface SolanaClosedPositionDTO {
  positionId: string;
  protocol: "orca" | "raydium";
  pair: string;
  events: ActivityEventForPnL[];
}
const SOLANA_CLOSED_PROTOCOL_LABEL: Record<SolanaClosedPositionDTO["protocol"], string> = {
  orca: "Orca",
  raydium: "Raydium",
};

// Sprint 2.2b — optional Sui addresses (connected + watched) whose CLOSED
// Cetus/Bluefin positions should be folded into Capital G/L. The analytics page
// already builds this list (it passes the same to useWalletLevelFees). Omitted /
// empty → no Sui closed-position fetch (e.g. the dashboard caller).
export function useLpPnl(positions: AerodromePosition[], suiWalletAddresses: string[] = [], solanaWalletAddresses: string[] = []): LpPnlResult {
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
  // (Momentum, anything not in ACTIVITY_PROTOCOLS). Surfaced in the
  // warning banner so the user knows P&L isn't calculated for them.
  const unsupportedRejectionsRef = useRef<ExcludedPosition[]>([]);
  // Sprint 2.2b — CLOSED Sui (Cetus/Bluefin) positions, reconstructed server-side
  // and pre-computed via computePositionPnL. Kept SEPARATE from resultsRef so the
  // positions-array eviction can't drop them; merged in aggregate().
  const suiClosedRef = useRef<Map<string, PosResult>>(new Map());
  const suiClosedMetaRef = useRef<Map<string, PositionMeta>>(new Map());
  // Sprint 3-FREE — CLOSED Solana (Orca) positions, reconstructed server-side
  // (burned NFTs) and pre-computed via computePositionPnL. Same SEPARATE-map
  // contract as suiClosedRef so positions-array eviction can't drop them.
  const solanaClosedRef = useRef<Map<string, PosResult>>(new Map());
  const solanaClosedMetaRef = useRef<Map<string, PositionMeta>>(new Map());

  // Fetch + value closed Sui positions whenever the Sui address set changes.
  // Disjoint from the open/closed positions in `positions` (destroyed objects),
  // so this runs independently of the per-position fetch effect below.
  useEffect(() => {
    const addrs = suiWalletAddresses.filter(Boolean);
    if (addrs.length === 0) {
      if (suiClosedRef.current.size > 0) {
        suiClosedRef.current = new Map();
        suiClosedMetaRef.current = new Map();
        setResult(aggregate(resultsRef.current, inflightRef.current.size, positionMetaRef.current, unsupportedRejectionsRef.current, suiClosedRef.current, suiClosedMetaRef.current, solanaClosedRef.current, solanaClosedMetaRef.current));
      }
      return;
    }
    let cancelled = false;
    (async () => {
      const newMap = new Map<string, PosResult>();
      const newMeta = new Map<string, PositionMeta>();
      await Promise.all(addrs.map(async (addr) => {
        try {
          const res = await fetch(`/api/sui-closed-positions?account=${encodeURIComponent(addr)}`);
          if (!res.ok) return;
          const json = await res.json();
          for (const sp of (json.positions ?? []) as SuiClosedPositionDTO[]) {
            // Value via the SAME pure engine EVM closed positions use, so the
            // injected closingValue/initialValue/fees are byte-identical in shape.
            const pnl = computePositionPnL({ currentValue: 0, unclaimedFeesUSD: 0, price0: 0, price1: 0, events: sp.events, isClosed: true });
            if (!pnl.ok) continue;
            const id = `sui-closed-${sp.protocol}-${sp.positionId}`;
            newMap.set(id, pnl);
            newMeta.set(id, { pair: sp.pair, protocol: SUI_CLOSED_PROTOCOL_LABEL[sp.protocol], chain: "Sui" });
          }
        } catch { /* graceful — a Sui address that fails contributes nothing */ }
      }));
      if (cancelled || !mountedRef.current) return;
      suiClosedRef.current = newMap;
      suiClosedMetaRef.current = newMeta;
      setResult(aggregate(resultsRef.current, inflightRef.current.size, positionMetaRef.current, unsupportedRejectionsRef.current, suiClosedRef.current, suiClosedMetaRef.current, solanaClosedRef.current, solanaClosedMetaRef.current));
    })();
    return () => { cancelled = true; };
  }, [suiWalletAddresses.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sprint 3-FREE — fetch + value closed Solana (Orca) positions whenever the
  // Solana address set changes. Mirrors the Sui effect above exactly: burned-NFT
  // positions are disjoint from `positions`, reconstructed server-side, valued via
  // the SAME computePositionPnL engine, kept in a separate ref, merged in aggregate.
  useEffect(() => {
    const addrs = solanaWalletAddresses.filter(Boolean);
    if (addrs.length === 0) {
      if (solanaClosedRef.current.size > 0) {
        solanaClosedRef.current = new Map();
        solanaClosedMetaRef.current = new Map();
        setResult(aggregate(resultsRef.current, inflightRef.current.size, positionMetaRef.current, unsupportedRejectionsRef.current, suiClosedRef.current, suiClosedMetaRef.current, solanaClosedRef.current, solanaClosedMetaRef.current));
      }
      return;
    }
    let cancelled = false;
    (async () => {
      const newMap = new Map<string, PosResult>();
      const newMeta = new Map<string, PositionMeta>();
      await Promise.all(addrs.map(async (addr) => {
        try {
          const res = await fetch(`/api/solana-closed-positions?account=${encodeURIComponent(addr)}`);
          if (!res.ok) return;
          const json = await res.json();
          for (const sp of (json.positions ?? []) as SolanaClosedPositionDTO[]) {
            const pnl = computePositionPnL({ currentValue: 0, unclaimedFeesUSD: 0, price0: 0, price1: 0, events: sp.events, isClosed: true });
            if (!pnl.ok) continue;
            const id = `solana-closed-${sp.protocol}-${sp.positionId}`;
            newMap.set(id, pnl);
            newMeta.set(id, { pair: sp.pair, protocol: SOLANA_CLOSED_PROTOCOL_LABEL[sp.protocol], chain: "Solana" });
          }
        } catch { /* graceful — a Solana address that fails contributes nothing */ }
      }));
      if (cancelled || !mountedRef.current) return;
      solanaClosedRef.current = newMap;
      solanaClosedMetaRef.current = newMeta;
      setResult(aggregate(resultsRef.current, inflightRef.current.size, positionMetaRef.current, unsupportedRejectionsRef.current, suiClosedRef.current, suiClosedMetaRef.current, solanaClosedRef.current, solanaClosedMetaRef.current));
    })();
    return () => { cancelled = true; };
  }, [solanaWalletAddresses.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

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
        // Surface unsupported protocols (Momentum, etc.) ONLY if the
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
      setResult(aggregate(resultsRef.current, inflightRef.current.size, positionMetaRef.current, unsupportedRejectionsRef.current, suiClosedRef.current, suiClosedMetaRef.current, solanaClosedRef.current, solanaClosedMetaRef.current));
      return;
    }

    // Mark as inflight and update loading state.
    for (const p of toFetch) inflightRef.current.add(p.id);
    setResult(aggregate(resultsRef.current, inflightRef.current.size, positionMetaRef.current, unsupportedRejectionsRef.current, suiClosedRef.current, suiClosedMetaRef.current, solanaClosedRef.current, solanaClosedMetaRef.current));

    // Fetch each position, paced PER activity endpoint (paceByEndpoint /
    // MAX_PER_ENDPOINT). A wallet with many positions on one provider — e.g. 4
    // HyperEVM positions all on /api/hyperswap/activity sharing Etherscan's
    // 5 req/sec budget — never bursts: at most MAX_PER_ENDPOINT fetch that
    // endpoint at once, the rest queue. Endpoints on different chains have
    // independent slots, so Aerodrome / Cetus / etc. run fully in parallel with
    // (and during) the throttled HyperEVM window. Each fetch still lands
    // independently → incremental aggregate, so totals fill in progressively.
    //
    // Order-independence: results key into resultsRef by pos.id and the hook
    // returns sums + a per-id Record (never an ordered array; the UI sorts the
    // positions table itself), so submission order is irrelevant — no need to
    // restore it. A NEW chain/protocol/token added at buildActivityUrl inherits
    // this automatically: it's just another item in `toFetch`, keyed by its own
    // endpoint pathname, with no special-casing.
    for (const pos of toFetch) {
      const activityUrl = buildActivityUrl(pos);
      // Positions with no activity URL still flow through fetchAndCompute (it
      // returns {ok:false}); only paced when there's a real endpoint to gate.
      const run = activityUrl
        ? () => paceByEndpoint(endpointKeyOf(activityUrl), () => fetchAndCompute(pos))
        : () => fetchAndCompute(pos);
      run().then((r) => {
        if (!mountedRef.current) return;
        inflightRef.current.delete(pos.id);
        resultsRef.current.set(pos.id, r);
        setResult(aggregate(resultsRef.current, inflightRef.current.size, positionMetaRef.current, unsupportedRejectionsRef.current, suiClosedRef.current, suiClosedMetaRef.current, solanaClosedRef.current, solanaClosedMetaRef.current));
      });
    }
  }, [positions]);

  return result;
}
