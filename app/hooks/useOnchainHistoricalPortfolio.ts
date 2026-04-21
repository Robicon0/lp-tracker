"use client";

// On-chain historical LP portfolio value via Uniswap V3-style pool oracle
// observations. No snapshots, no localStorage, no external price APIs —
// every price comes from the pool's own observation ring buffer read via
// the standard `observe()` call on chain.
//
// For each range (1D / 7D / 30D / 1Y):
//   1. Each eligible LP position is queried at `secondsAgo` = range in
//      seconds. The endpoint returns a 60-second TWAP tick near that
//      historical timestamp, then applies stablecoin anchoring to produce
//      (price0Usd, price1Usd).
//   2. Historical position value = amount0 * price0Usd + amount1 * price1Usd
//      using the position's CURRENT token amounts and the HISTORICAL prices.
//   3. Sum across positions. If any position returns null (oracle ring too
//      short, no stablecoin in pair, or RPC failure), it is excluded from
//      that range only. Other ranges / other positions are unaffected.
//   4. A range is `available` when at least one position contributed. The
//      `excluded` count surfaces how many positions dropped out so the UI
//      can show "Some positions excluded — historical data unavailable".
//
// The identity `pnlPct === (pnlDollar / historicalValue) * 100` holds by
// construction, so the percentage and dollar amount can never contradict.

import { useEffect, useMemo, useRef, useState } from "react";
import type { AerodromePosition } from "../lib/aerodrome";

export type HistRangeKey = "1D" | "7D" | "30D" | "1Y";

export interface HistRangeResult {
  /** Historical total LP value at T. 0 when range is unavailable. */
  value: number;
  /** Current LP value - historical LP value. */
  pnlDollar: number;
  /** (pnlDollar / historicalValue) * 100. Always consistent with pnlDollar. */
  pnlPct: number;
  /** true = range has ≥1 position with historical data. */
  available: boolean;
  /** How many eligible LP positions were excluded from this range. */
  excluded: number;
  /** How many eligible LP positions were included in this range. */
  included: number;
}

export interface OnchainHistoricalPortfolio {
  byRange: Record<HistRangeKey, HistRangeResult>;
  isLoading: boolean;
  /** Total number of LP positions that were candidates (open, value > 0). */
  totalEligible: number;
}

const RANGE_SECONDS: Record<HistRangeKey, number> = {
  "1D": 86_400,
  "7D": 7 * 86_400,
  "30D": 30 * 86_400,
  "1Y": 365 * 86_400,
};

const EMPTY_RANGE: HistRangeResult = {
  value: 0,
  pnlDollar: 0,
  pnlPct: 0,
  available: false,
  excluded: 0,
  included: 0,
};

const EMPTY: OnchainHistoricalPortfolio = {
  byRange: { "1D": EMPTY_RANGE, "7D": EMPTY_RANGE, "30D": EMPTY_RANGE, "1Y": EMPTY_RANGE },
  isLoading: false,
  totalEligible: 0,
};

interface ApiQuery {
  chain: string;
  poolAddress: string;
  secondsAgo: number[];
  tickLower: number;
  tickUpper: number;
  token0: string;
  token1: string;
  token0Decimals: number;
  token1Decimals: number;
}

interface ApiResultRow {
  bySecondsAgo: Record<
    string,
    { tick: number; price0Usd: number | null; price1Usd: number | null } | null
  >;
}

interface ApiResponse {
  results: ApiResultRow[];
}

function isEligible(p: AerodromePosition): boolean {
  if (p.status === "Closed") return false;
  if (p.value <= 0) return false;
  if (!p.poolAddress) return false;
  if (!p.token0Address || !p.token1Address) return false;
  if (p.tickLower == null || p.tickUpper == null) return false;
  if (p.token0Decimals == null || p.token1Decimals == null) return false;
  if (!p.amount0 || !p.amount1) {
    // A position must have at least one non-zero side. Allow if one side > 0.
    const a0 = p.amount0 ?? 0;
    const a1 = p.amount1 ?? 0;
    if (a0 <= 0 && a1 <= 0) return false;
  }
  return true;
}

export function useOnchainHistoricalPortfolio(
  positions: AerodromePosition[],
  currentLpValue: number,
): OnchainHistoricalPortfolio {
  const [state, setState] = useState<OnchainHistoricalPortfolio>(EMPTY);
  const runIdRef = useRef(0);

  // Build the pool of eligible positions and a stable fetchKey.
  const eligible = useMemo(() => positions.filter(isEligible), [positions]);

  const fetchKey = useMemo(() => {
    const parts = eligible
      .map((p) =>
        [
          p.id,
          p.poolAddress,
          p.chain,
          (p.amount0 ?? 0).toFixed(6),
          (p.amount1 ?? 0).toFixed(6),
          p.tickLower,
          p.tickUpper,
        ].join(":"),
      )
      .sort()
      .join("|");
    return `${parts}::${currentLpValue.toFixed(2)}`;
  }, [eligible, currentLpValue]);

  useEffect(() => {
    if (eligible.length === 0 || currentLpValue <= 0) {
      setState({ ...EMPTY, totalEligible: eligible.length });
      return;
    }

    const runId = ++runIdRef.current;
    setState((prev) => ({ ...prev, isLoading: true, totalEligible: eligible.length }));

    const secondsAgoList = (Object.keys(RANGE_SECONDS) as HistRangeKey[]).map(
      (k) => RANGE_SECONDS[k],
    );

    const queries: ApiQuery[] = eligible.map((p) => ({
      chain: p.chain,
      poolAddress: p.poolAddress!,
      secondsAgo: secondsAgoList,
      tickLower: p.tickLower!,
      tickUpper: p.tickUpper!,
      token0: p.token0Address!,
      token1: p.token1Address!,
      token0Decimals: p.token0Decimals ?? 18,
      token1Decimals: p.token1Decimals ?? 18,
    }));

    (async () => {
      try {
        const res = await fetch("/api/onchain-historical-price", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ queries }),
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const json = (await res.json()) as ApiResponse;
        if (runIdRef.current !== runId) return;

        const byRange: Record<HistRangeKey, HistRangeResult> = {
          "1D": { ...EMPTY_RANGE },
          "7D": { ...EMPTY_RANGE },
          "30D": { ...EMPTY_RANGE },
          "1Y": { ...EMPTY_RANGE },
        };

        for (const key of Object.keys(RANGE_SECONDS) as HistRangeKey[]) {
          const secondsAgo = RANGE_SECONDS[key];
          let histTotal = 0;
          let included = 0;
          let excluded = 0;

          for (let i = 0; i < eligible.length; i++) {
            const p = eligible[i];
            const row = json.results[i];
            const prices = row?.bySecondsAgo?.[secondsAgo] ?? row?.bySecondsAgo?.[String(secondsAgo)];

            if (!prices || prices.price0Usd == null || prices.price1Usd == null) {
              excluded++;
              continue;
            }

            const amt0 = p.amount0 ?? 0;
            const amt1 = p.amount1 ?? 0;
            const histValue = amt0 * prices.price0Usd + amt1 * prices.price1Usd;
            if (!Number.isFinite(histValue) || histValue <= 0) {
              excluded++;
              continue;
            }
            histTotal += histValue;
            included++;
          }

          const available = included > 0 && histTotal > 0;
          const pnlDollar = available ? currentLpValue - histTotal : 0;
          const pnlPct = available && histTotal > 0 ? (pnlDollar / histTotal) * 100 : 0;
          byRange[key] = {
            value: histTotal,
            pnlDollar,
            pnlPct,
            available,
            included,
            excluded,
          };
        }

        setState({ byRange, isLoading: false, totalEligible: eligible.length });
      } catch (err) {
        console.error("[useOnchainHistoricalPortfolio] failed:", err);
        if (runIdRef.current !== runId) return;
        setState({ ...EMPTY, totalEligible: eligible.length, isLoading: false });
      }
    })();
  }, [fetchKey, eligible, currentLpValue]);

  return state;
}
