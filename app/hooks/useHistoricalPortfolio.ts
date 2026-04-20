"use client";

// Replaces the localStorage-snapshot-based portfolio P&L with an on-chain /
// market-data approach that works for any wallet on the very first load.
//
// For each range (1D / 7D / 30D / 1Y) we compute:
//   historical total value = Σ(current_amount × historical_price_at_T)
// across:
//   - every open LP position's token0 and token1 (uses p.amount0/p.amount1,
//     p.token0Symbol/p.token1Symbol, p.price0/p.price1)
//   - every idle wallet token (uses t.balance, t.symbol, t.usdValue)
//   - AAVE debt is subtracted (isDebt rows reduce net worth)
//
// Historical prices come from CoinGecko `/coins/{id}/market_chart` via the
// existing `/api/prices` proxy. Stablecoins use a constant $1. Tokens we can't
// resolve to a CoinGecko ID (or whose market_chart fetch fails) are dropped
// from that range — if they account for >20% of today's portfolio value we
// mark the range `available:false` so the UI can show "Data unavailable"
// instead of a wrong number.
//
// No localStorage. No snapshots. Works for any wallet on page load.

import { useEffect, useMemo, useRef, useState } from "react";
import type { AerodromePosition } from "../lib/aerodrome";
import type { TokenItem } from "./useWalletTokens";

export type HistRangeKey = "1D" | "7D" | "30D" | "1Y";

export interface HistRangeResult {
  /** Historical total portfolio value at T. 0 when unavailable. */
  value: number;
  /** Today-minus-T dollar change. 0 when unavailable. */
  pnlDollar: number;
  /** % change vs now. 0 when unavailable. */
  pnlPct: number;
  /** true → we have enough coverage to display a P&L number. */
  available: boolean;
}

export interface HistoricalPortfolio {
  byRange: Record<HistRangeKey, HistRangeResult>;
  isLoading: boolean;
}

const RANGE_DAYS: Record<HistRangeKey, number> = {
  "1D": 1,
  "7D": 7,
  "30D": 30,
  "1Y": 365,
};

// Symbol → CoinGecko ID. Only covers majors + the chain tokens this app can
// surface (HYPE, SUI, MATIC, ARB, OP, BNB, AVAX, …). Wrapped variants map to
// the same id as the underlying (WETH→ethereum, cbBTC→bitcoin, etc.).
const CG_IDS: Record<string, string> = {
  // ETH family
  ETH: "ethereum",
  WETH: "ethereum",
  STETH: "staked-ether",
  WSTETH: "wrapped-steth",
  EZETH: "renzo-restaked-eth",
  WEETH: "wrapped-eeth",
  // BTC family
  BTC: "bitcoin",
  WBTC: "wrapped-bitcoin",
  CBBTC: "coinbase-wrapped-btc",
  TBTC: "tbtc",
  UBTC: "universal-btc",
  // Solana
  SOL: "solana",
  WSOL: "solana",
  JITOSOL: "jito-staked-sol",
  MSOL: "msol",
  // Sui
  SUI: "sui",
  // HyperEVM
  HYPE: "hyperliquid",
  WHYPE: "hyperliquid",
  KHYPE: "hyperliquid",
  BEHYPE: "hyperliquid",
  // Chain-native / governance
  MATIC: "matic-network",
  POL: "matic-network",
  ARB: "arbitrum",
  OP: "optimism",
  BNB: "binancecoin",
  WBNB: "wbnb",
  AVAX: "avalanche-2",
  WAVAX: "wrapped-avax",
  // DeFi bluechips
  LINK: "chainlink",
  UNI: "uniswap",
  AAVE: "aave",
  CRV: "curve-dao-token",
  MKR: "maker",
  LDO: "lido-dao",
  RPL: "rocket-pool",
  // Meme / popular
  PEPE: "pepe",
  SHIB: "shiba-inu",
  DOGE: "dogecoin",
};

const STABLES = new Set([
  "USDC", "USDT", "DAI", "USDbC", "USDC.E", "USDC.e", "USDS", "FRAX",
  "LUSD", "BUSD", "GUSD", "USDE", "USDe", "SUSDE", "sUSDe", "USDHL", "USR",
  "USDH", "USDT0", "USD0", "USDa", "PYUSD", "TUSD",
]);

function resolveCgId(sym: string): string | null {
  if (!sym) return null;
  // Try case-insensitive first
  const u = sym.toUpperCase();
  if (CG_IDS[u]) return CG_IDS[u];
  // Then exact case (cbBTC vs CBBTC, etc.)
  if (CG_IDS[sym]) return CG_IDS[sym];
  return null;
}

function isStable(sym: string): boolean {
  return STABLES.has(sym) || STABLES.has(sym.toUpperCase());
}

// market_chart returns { prices: [[ms, price], ...] }. For days≤90 CoinGecko
// returns hourly data; for days>90 it's daily. Either way we just do a binary
// search to find the closest timestamp to our target.
async function fetchMarketChart(cgId: string, days: number): Promise<Array<[number, number]> | null> {
  try {
    const r = await fetch(
      `/api/prices?endpoint=coins/${cgId}/market_chart&vs_currency=usd&days=${days}`,
    );
    if (!r.ok) return null;
    const j = (await r.json()) as { prices?: Array<[number, number]>; error?: string };
    if (!j.prices || j.prices.length === 0) return null;
    return j.prices;
  } catch {
    return null;
  }
}

function priceAt(series: Array<[number, number]>, targetMs: number): number | null {
  if (!series.length) return null;
  // Binary search for first index with ts >= target, then pick whichever
  // neighbor is closest.
  let lo = 0, hi = series.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid][0] < targetMs) lo = mid + 1;
    else hi = mid;
  }
  const pick = (() => {
    const at = series[lo];
    const prev = lo > 0 ? series[lo - 1] : null;
    if (!prev) return at;
    return Math.abs(at[0] - targetMs) < Math.abs(prev[0] - targetMs) ? at : prev;
  })();
  return pick?.[1] ?? null;
}

interface Holding {
  symbol: string;
  amount: number;
  currentPrice: number; // used for coverage weighting
  sign: 1 | -1;          // debt = -1, everything else = +1
}

const EMPTY: HistoricalPortfolio = {
  byRange: {
    "1D": { value: 0, pnlDollar: 0, pnlPct: 0, available: false },
    "7D": { value: 0, pnlDollar: 0, pnlPct: 0, available: false },
    "30D": { value: 0, pnlDollar: 0, pnlPct: 0, available: false },
    "1Y": { value: 0, pnlDollar: 0, pnlPct: 0, available: false },
  },
  isLoading: false,
};

export function useHistoricalPortfolio(
  positions: AerodromePosition[],
  walletTokens: TokenItem[],
  currentTotalValue: number,
): HistoricalPortfolio {
  const [state, setState] = useState<HistoricalPortfolio>(EMPTY);

  // Stable fetch key — avoid re-running every render.
  const fetchKey = useMemo(() => {
    const pos = positions
      .filter((p) => p.status !== "Closed" && p.value > 0)
      .map((p) =>
        [
          p.id,
          p.token0Symbol ?? "",
          (p.amount0 ?? 0).toFixed(6),
          p.token1Symbol ?? "",
          (p.amount1 ?? 0).toFixed(6),
        ].join(":"),
      )
      .sort()
      .join("|");
    const tok = walletTokens
      .filter((t) => t.balance > 0)
      .map((t) => `${t.chain}:${t.symbol}:${t.balance.toFixed(6)}:${t.isDebt ? "d" : "s"}`)
      .sort()
      .join("|");
    return `${pos}::${tok}::${currentTotalValue.toFixed(2)}`;
  }, [positions, walletTokens, currentTotalValue]);

  const runIdRef = useRef(0);

  useEffect(() => {
    if (!fetchKey || fetchKey === "::::0.00") {
      setState(EMPTY);
      return;
    }

    const runId = ++runIdRef.current;
    setState((prev) => ({ ...prev, isLoading: true }));

    (async () => {
      // Build holdings from current state
      const holdings: Holding[] = [];

      for (const p of positions) {
        if (p.status === "Closed" || p.value <= 0) continue;
        if (p.token0Symbol && p.amount0 && p.price0 != null) {
          holdings.push({
            symbol: p.token0Symbol,
            amount: p.amount0,
            currentPrice: p.price0,
            sign: 1,
          });
        }
        if (p.token1Symbol && p.amount1 && p.price1 != null) {
          holdings.push({
            symbol: p.token1Symbol,
            amount: p.amount1,
            currentPrice: p.price1,
            sign: 1,
          });
        }
      }

      for (const t of walletTokens) {
        if (t.balance <= 0) continue;
        holdings.push({
          symbol: t.symbol,
          amount: t.balance,
          currentPrice: t.price,
          sign: t.isDebt ? -1 : 1,
        });
      }

      // Unique non-stable symbols → fetch 365d market_chart once each (covers
      // every range). Batch-parallel.
      const uniqueSymbols = Array.from(new Set(holdings.map((h) => h.symbol)));
      const idBySymbol: Record<string, string> = {};
      const unresolvedSymbols = new Set<string>();
      for (const s of uniqueSymbols) {
        if (isStable(s)) continue;
        const id = resolveCgId(s);
        if (id) idBySymbol[s] = id;
        else unresolvedSymbols.add(s);
      }
      const uniqueIds = Array.from(new Set(Object.values(idBySymbol)));
      const chartEntries = await Promise.all(
        uniqueIds.map(async (id) => [id, await fetchMarketChart(id, 365)] as const),
      );
      if (runIdRef.current !== runId) return;

      const chartById: Record<string, Array<[number, number]>> = {};
      for (const [id, chart] of chartEntries) if (chart) chartById[id] = chart;

      // Snapshot total of today's portfolio derived from these holdings —
      // used as the denominator for "covered weight" checks. We use the
      // current holdings' USD value rather than currentTotalValue so the
      // ratio is internally consistent.
      const byRange: Record<HistRangeKey, HistRangeResult> = {
        "1D": { value: 0, pnlDollar: 0, pnlPct: 0, available: false },
        "7D": { value: 0, pnlDollar: 0, pnlPct: 0, available: false },
        "30D": { value: 0, pnlDollar: 0, pnlPct: 0, available: false },
        "1Y": { value: 0, pnlDollar: 0, pnlPct: 0, available: false },
      };

      const now = Date.now();
      for (const key of Object.keys(RANGE_DAYS) as HistRangeKey[]) {
        const targetMs = now - RANGE_DAYS[key] * 86_400_000;

        let historicalTotal = 0;
        let coveredWeightUsd = 0;
        let missingWeightUsd = 0;

        for (const h of holdings) {
          const currentUsd = h.amount * h.currentPrice;
          if (!isFinite(currentUsd) || currentUsd === 0) continue;

          let historicalPrice: number | null = null;
          if (isStable(h.symbol)) {
            historicalPrice = 1;
          } else {
            const id = idBySymbol[h.symbol];
            const series = id ? chartById[id] : null;
            historicalPrice = series ? priceAt(series, targetMs) : null;
          }

          if (historicalPrice == null) {
            missingWeightUsd += Math.abs(currentUsd);
            continue;
          }

          historicalTotal += h.sign * h.amount * historicalPrice;
          coveredWeightUsd += Math.abs(currentUsd);
        }

        const totalWeight = coveredWeightUsd + missingWeightUsd;
        const coverage = totalWeight > 0 ? coveredWeightUsd / totalWeight : 0;

        if (coverage < 0.8 || historicalTotal <= 0) {
          byRange[key] = { value: 0, pnlDollar: 0, pnlPct: 0, available: false };
          continue;
        }

        const pnlDollar = currentTotalValue - historicalTotal;
        const pnlPct = historicalTotal > 0 ? (pnlDollar / historicalTotal) * 100 : 0;
        byRange[key] = {
          value: historicalTotal,
          pnlDollar,
          pnlPct,
          available: true,
        };
      }

      if (runIdRef.current !== runId) return;
      setState({ byRange, isLoading: false });
    })().catch(() => {
      if (runIdRef.current !== runId) return;
      setState({ ...EMPTY, isLoading: false });
    });
  }, [fetchKey, positions, walletTokens, currentTotalValue]);

  return state;
}
