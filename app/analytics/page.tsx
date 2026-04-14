"use client";

import { useMemo, useEffect, useState } from "react";
import Navbar from "../Navbar";
import { usePositions } from "../contexts/PositionsContext";
import { useLendingPositions, type ExternalLendingPosition } from "../hooks/useLendingPositions";
import { usePortfolioHistory } from "../hooks/usePortfolioHistory";
import { useAllPositionsActivity } from "../hooks/useAllPositionsActivity";
import { useLpPnl } from "../hooks/useLpPnl";
import { useWalletTokens } from "../hooks/useWalletTokens";
import { useAccount } from "wagmi";
import { useWalletAuth } from "../contexts/WalletAuthContext";
import { useWatchedWallets } from "../contexts/WatchedWalletsContext";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
  LineChart,
  Line,
  Area,
  AreaChart,
} from "recharts";

// ── Constants ────────────────────────────────────────────────────────────────

const PROTOCOL_COLORS: Record<string, string> = {
  Aerodrome:    "#22c55e",
  "Uniswap V3": "#a855f7",
  Velodrome:    "#3b82f6",
  Orca:         "#f59e0b",
  Raydium:      "#ef4444",
  Cetus:        "#06b6d4",
  Bluefin:      "#0ea5e9",
  Momentum:     "#84cc16",
  HyperSwap:    "#f97316",
  KittenSwap:   "#ec4899",
  ProjectX:     "#8b5cf6",
  PRJX:         "#8b5cf6",
  PancakeSwap:  "#fbbf24",
  Dolomite:     "#6366f1",
  "Jupiter Lend": "#9333ea",
  AlphaFi:      "#14b8a6",
  Suilend:      "#0891b2",
  HyperLend:    "#10b981",
  "AAVE V3":    "#b6509e",
};

const CHAIN_COLORS: Record<string, string> = {
  Base:        "#0052ff",
  Ethereum:    "#627eea",
  Arbitrum:    "#2d9cdb",
  Optimism:    "#ff0420",
  Polygon:     "#8247e5",
  Avalanche:   "#e84142",
  Solana:      "#9945ff",
  Sui:         "#6fbcf0",
  HyperEVM:    "#00d4aa",
  "BNB Chain": "#f0b90b",
};

const PIE_COLORS = ["#10B981", "#3B82F6", "#F59E0B", "#EF4444", "#8B5CF6", "#EC4899", "#06B6D4", "#F97316", "#84CC16", "#6366F1"];

const TIME_RANGES = [
  { key: "1D",  ms: 1   * 24 * 3_600_000, label: "24h",    xFmt: (d: Date) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) },
  { key: "7D",  ms: 7   * 24 * 3_600_000, label: "7 days", xFmt: (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) },
  { key: "30D", ms: 30  * 24 * 3_600_000, label: "30 days",xFmt: (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) },
  { key: "90D", ms: 90  * 24 * 3_600_000, label: "90 days",xFmt: (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) },
  { key: "1Y",  ms: 365 * 24 * 3_600_000, label: "1 year", xFmt: (d: Date) => d.toLocaleDateString("en-US", { month: "short", year: "2-digit" }) },
] as const;

// ── Tooltip style ────────────────────────────────────────────────────────────

const tooltipStyle = {
  backgroundColor: "#0a1f17",
  border: "1px solid rgba(16,185,129,0.2)",
  borderRadius: "8px",
  padding: "8px 12px",
  color: "#FFFFFF",
  fontSize: "12px",
};
const tooltipLabelStyle = { color: "#FFFFFF" };
const tooltipItemStyle = { color: "#FFFFFF" };

// ── Helpers ──────────────────────────────────────────────────────────────────

const fmt$ = (n: number, dec = 2) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec })}`;

const fmtCompact = (n: number) => {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return fmt$(n, 0);
};

/* eslint-disable @typescript-eslint/no-explicit-any */
const dollarFormatter = (value: any) => [fmt$(Number(value)), "Value"];
/* eslint-enable @typescript-eslint/no-explicit-any */

// Custom legend for pie charts
/* eslint-disable @typescript-eslint/no-explicit-any */
const PieLegend = (props: any) => {
  const { payload } = props;
  const total = payload.reduce((sum: number, entry: any) => sum + entry.payload.value, 0);
  return (
    <div className="flex flex-wrap justify-center gap-x-3 gap-y-1.5 mt-3">
      {payload.map((entry: any, index: number) => {
        const pct = total > 0 ? ((entry.payload.value / total) * 100).toFixed(0) : "0";
        return (
          <div key={index} className="flex items-center space-x-1.5 text-xs">
            <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: entry.color }} />
            <span className="text-gray-400">{entry.value} <span className="text-gray-500">{pct}%</span></span>
          </div>
        );
      })}
    </div>
  );
};
/* eslint-enable @typescript-eslint/no-explicit-any */

// ── Sort config for position table ───────────────────────────────────────────

type SortKey = "value" | "apy" | "daily" | "fees" | "protocol" | "chain";
type SortDir = "asc" | "desc";

// ── Main Component ───────────────────────────────────────────────────────────

// Approximate AAVE V3 supply APYs (same as lending page)
const AAVE_SUPPLY_APY: Record<string, number> = {
  USDC: 2.86, USDbC: 2.86, "USDC.e": 2.86,
  USDT: 3.50, DAI: 2.20,
  WETH: 1.80, ETH: 1.80,
  WBTC: 0.80, cbBTC: 0.80,
};

function getAaveUnderlying(symbol: string): string {
  const rest = symbol.startsWith("a") ? symbol.slice(1) : symbol;
  for (const prefix of ["Bas", "Arb", "Opt", "Eth", "Pol"]) {
    if (rest.startsWith(prefix)) return rest.slice(prefix.length);
  }
  return rest;
}

function getATokenChain(symbol: string): string | null {
  const rest = symbol.startsWith("a") ? symbol.slice(1) : null;
  if (!rest) return null;
  if (rest.startsWith("Bas")) return "Base";
  if (rest.startsWith("Arb")) return "Arbitrum";
  if (rest.startsWith("Opt")) return "Optimism";
  if (rest.startsWith("Eth")) return "Ethereum";
  if (rest.startsWith("Pol")) return "Polygon";
  return null;
}

export default function Analytics() {
  const { positions, isLoading, dataUpdatedAt } = usePositions();
  const { positions: externalLendingPositions } = useLendingPositions();
  const { tokens: walletTokens } = useWalletTokens();
  const { address } = useAccount();
  const { solanaAddress, suiAddress } = useWalletAuth();
  const { watchedWallets } = useWatchedWallets();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const hasWallet = mounted && (!!(address || solanaAddress || suiAddress) || watchedWallets.length > 0);

  // ── Build AAVE lending positions from wallet tokens ─────────────────────────
  const lendingPositions: ExternalLendingPosition[] = useMemo(() => {
    // AAVE aTokens grouped by chain
    const aaveByChain = new Map<string, { supplied: number; apy: number }>();
    for (const t of walletTokens) {
      if (!t.isLending) continue;
      const chain = getATokenChain(t.symbol) ?? t.chain;
      const prev = aaveByChain.get(chain) ?? { supplied: 0, apy: 0 };
      const underlying = getAaveUnderlying(t.symbol);
      const tokenApy = AAVE_SUPPLY_APY[underlying] ?? 0;
      const newSupplied = prev.supplied + t.usdValue;
      // Weighted average APY
      prev.apy = newSupplied > 0
        ? (prev.apy * prev.supplied + tokenApy * t.usdValue) / newSupplied
        : 0;
      prev.supplied = newSupplied;
      aaveByChain.set(chain, prev);
    }

    const aavePositions: ExternalLendingPosition[] = [...aaveByChain.entries()]
      .filter(([, v]) => v.supplied > 0)
      .map(([chain, v]) => ({
        protocol: "AAVE V3",
        chain,
        totalSupplied: v.supplied,
        totalBorrowed: 0,
        supplyApy: v.apy,
        borrowApy: 0,
        suppliedAssets: [],
        borrowedAssets: [],
        manageUrl: "https://app.aave.com",
      }));

    return [...aavePositions, ...externalLendingPositions];
  }, [walletTokens, externalLendingPositions]);

  // ── Actual performance data from on-chain activity ────────────────────────
  const { perfMap, isLoading: activityLoading } = useAllPositionsActivity(positions);
  const lpPnl = useLpPnl(positions);

  // ── Sort state ─────────────────────────────────────────────────────────────
  const [sortKey, setSortKey] = useState<SortKey>("value");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  // ── Actual APR card toggle ───────────────────────────────────────────────
  const [aprView, setAprView] = useState<"daily" | "weekly" | "monthly" | "yearly">("yearly");

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  // ── Portfolio history ──────────────────────────────────────────────────────
  const totalLpValue = positions.reduce((s, p) => s + p.value, 0);
  const totalLpFees  = positions.reduce((s, p) => s + p.fees, 0);
  const totalLendingValue = lendingPositions.reduce((s, p) => s + p.totalSupplied, 0);
  const totalPortfolioValue = totalLpValue + totalLendingValue;

  const portfolioHistory = usePortfolioHistory(totalLpValue, positions.length, dataUpdatedAt);
  const [rangeKey, setRangeKey] = useState<typeof TIME_RANGES[number]["key"]>("30D");
  const activeRange   = TIME_RANGES.find((r) => r.key === rangeKey) ?? TIME_RANGES[2];
  const rangeCutoff   = Date.now() - activeRange.ms;
  const rangedHistory = portfolioHistory.filter((s) => s.timestamp >= rangeCutoff);
  const effectiveHistory = rangedHistory.length >= 2 ? rangedHistory : portfolioHistory;
  const effectiveFirst   = effectiveHistory[0];
  const pnlDollar = effectiveFirst ? totalLpValue - effectiveFirst.totalValue : 0;
  const pnlPct    = effectiveFirst && effectiveFirst.totalValue > 0
    ? (pnlDollar / effectiveFirst.totalValue) * 100
    : 0;
  const pnlLabel = (() => {
    if (!effectiveFirst) return activeRange.label;
    const coverage = Date.now() - effectiveFirst.timestamp;
    if (coverage < activeRange.ms * 0.5)
      return `since ${new Date(effectiveFirst.timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
    return activeRange.label;
  })();
  const chartData = effectiveHistory.map((s) => ({
    label: activeRange.xFmt(new Date(s.timestamp)),
    value: s.totalValue,
    ts: s.timestamp,
  }));

  // ── Daily income calc ──────────────────────────────────────────────────────
  const { dailyLpIncome, dailyLendingIncome } = useMemo(() => {
    const activeLp = positions.filter((p) => p.apy > 0 && p.value > 0);
    const yearlyLp = activeLp.reduce((s, p) => s + (p.value * p.apy) / 100, 0);

    let yearlyLending = 0;
    for (const lp of lendingPositions) {
      if (lp.supplyApy != null && lp.totalSupplied > 0) {
        yearlyLending += (lp.totalSupplied * lp.supplyApy) / 100;
      }
    }

    return {
      dailyLpIncome: yearlyLp / 365,
      dailyLendingIncome: yearlyLending / 365,
    };
  }, [positions, lendingPositions]);

  const totalDailyIncome = dailyLpIncome + dailyLendingIncome;

  // ── Weighted average actual APR across all active LP positions ─────────────
  const actualAPRData = useMemo(() => {
    const activeWithValue = positions.filter((p) => p.value > 0 && p.status !== "Closed");
    if (activeWithValue.length === 0) return { apr: 0, totalValue: 0 };
    let weightedSum = 0;
    let totalVal = 0;
    for (const p of activeWithValue) {
      const perf = perfMap.get(p.id);
      const apr = perf?.actualAPR ?? p.apy;
      if (apr > 0) {
        weightedSum += apr * p.value;
        totalVal += p.value;
      }
    }
    return { apr: totalVal > 0 ? weightedSum / totalVal : 0, totalValue: totalVal };
  }, [positions, perfMap]);

  // ── Portfolio health score ─────────────────────────────────────────────────
  // Weighted composite (out of 100):
  //   40% positions in range | 25% fee performance vs 20% APR benchmark
  //   20% chain diversification | 15% IL level (lower = better)
  const healthScore = useMemo(() => {
    const activePositions = positions.filter((p) => p.value > 0 && p.status !== "Closed");
    if (activePositions.length === 0) return null;

    // (1) In-range — 40%
    const inRangeCount = activePositions.filter((p) => p.status === "In Range").length;
    const inRangePct = inRangeCount / activePositions.length;
    const inRangeScore = inRangePct * 40;

    // (2) Fee performance — 25%. Value-weighted actual APR vs 20% benchmark.
    let aprWeightedSum = 0;
    let aprTotalVal = 0;
    for (const p of activePositions) {
      const perf = perfMap.get(p.id);
      const apr = perf?.actualAPR ?? p.apy ?? 0;
      if (apr > 0) {
        aprWeightedSum += apr * p.value;
        aprTotalVal += p.value;
      }
    }
    const avgAPR = aprTotalVal > 0 ? aprWeightedSum / aprTotalVal : 0;
    const feeScore = Math.max(0, Math.min(1, avgAPR / 20)) * 25;

    // (3) Chain diversification — 20%. 1 chain ≈ 60%, 2 ≈ 85%, 3+ = 100%.
    const chains = new Set(activePositions.map((p) => p.chain));
    const chainFraction = chains.size >= 3 ? 1 : chains.size === 2 ? 0.85 : 0.6;
    const chainScore = chainFraction * 20;

    // (4) IL level — 15%. 0% IL = full 15; -5% = 0.
    const ilPct = lpPnl.initialValue > 0 ? (lpPnl.ilUSD / lpPnl.initialValue) * 100 : 0;
    const ilMagnitude = Math.abs(Math.min(0, ilPct));
    const ilScore = Math.max(0, 1 - ilMagnitude / 5) * 15;

    return Math.round(inRangeScore + feeScore + chainScore + ilScore);
  }, [positions, perfMap, lpPnl.initialValue, lpPnl.ilUSD]);

  // ── Chain breakdown (LP + lending combined) ────────────────────────────────
  const chainExposure = useMemo(() => {
    const m: Record<string, number> = {};
    for (const p of positions) {
      if (p.value > 0) m[p.chain] = (m[p.chain] ?? 0) + p.value;
    }
    for (const lp of lendingPositions) {
      if (lp.totalSupplied > 0) m[lp.chain] = (m[lp.chain] ?? 0) + lp.totalSupplied;
    }
    return Object.entries(m).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  }, [positions, lendingPositions]);

  // ── Protocol breakdown (LP + lending combined) ─────────────────────────────
  const protocolExposure = useMemo(() => {
    const m: Record<string, number> = {};
    for (const p of positions) {
      if (p.value > 0) m[p.protocol] = (m[p.protocol] ?? 0) + p.value;
    }
    for (const lp of lendingPositions) {
      if (lp.totalSupplied > 0) m[lp.protocol] = (m[lp.protocol] ?? 0) + lp.totalSupplied;
    }
    return Object.entries(m).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  }, [positions, lendingPositions]);

  // ── Income by chain (for bar chart) ────────────────────────────────────────
  const incomeByChain = useMemo(() => {
    const m: Record<string, number> = {};
    for (const p of positions) {
      if (p.apy > 0 && p.value > 0) {
        const daily = (p.value * p.apy) / 100 / 365;
        m[p.chain] = (m[p.chain] ?? 0) + daily;
      }
    }
    for (const lp of lendingPositions) {
      if (lp.supplyApy != null && lp.totalSupplied > 0) {
        const daily = (lp.totalSupplied * lp.supplyApy) / 100 / 365;
        m[lp.chain] = (m[lp.chain] ?? 0) + daily;
      }
    }
    return Object.entries(m)
      .map(([chain, daily]) => ({ chain, daily }))
      .sort((a, b) => b.daily - a.daily);
  }, [positions, lendingPositions]);

  // ── Sorted position table (uses actual APR when available) ─────────────────
  // Only show active positions (In Range / Out of Range) — closed positions
  // with $0 value are excluded from the analytics performance table.
  const sortedPositions = useMemo(() => {
    const STATUS_ORDER: Record<string, number> = { "In Range": 0, "Out of Range": 1 };
    const items = positions
      .filter((p) => p.status !== "Closed" && p.value > 0)
      .map((p) => {
        const perf = perfMap.get(p.id);
        const displayAPR = perf?.actualAPR ?? p.apy;
        const displayDaily = perf?.actualDaily ?? (p.apy > 0 && p.value > 0 ? (p.value * p.apy) / 100 / 365 : 0);
        const isEstimated = !perf || perf.isEstimated;
        return { ...p, displayAPR, displayDaily, isEstimated };
      });
    return [...items].sort((a, b) => {
      // Status primary
      const sa = STATUS_ORDER[a.status] ?? 1;
      const sb = STATUS_ORDER[b.status] ?? 1;
      if (sa !== sb) return sa - sb;
      // User key secondary
      let cmp = 0;
      switch (sortKey) {
        case "value":    cmp = a.value - b.value; break;
        case "apy":      cmp = a.displayAPR - b.displayAPR; break;
        case "daily":    cmp = a.displayDaily - b.displayDaily; break;
        case "fees":     cmp = a.fees - b.fees; break;
        case "protocol": cmp = a.protocol.localeCompare(b.protocol); break;
        case "chain":    cmp = a.chain.localeCompare(b.chain); break;
      }
      return sortDir === "desc" ? -cmp : cmp;
    });
  }, [positions, sortKey, sortDir, perfMap]);

  // ── Top/bottom performers (by actual APR when available) ──────────────────
  const { topPerformers, bottomPerformers } = useMemo(() => {
    const active = positions.filter((p) => p.value > 0).map((p) => {
      const perf = perfMap.get(p.id);
      const displayAPR = perf?.actualAPR ?? p.apy;
      const isEstimated = !perf || perf.isEstimated;
      return { ...p, displayAPR, isEstimated };
    }).filter((p) => p.displayAPR > 0);
    const sorted = [...active].sort((a, b) => b.displayAPR - a.displayAPR);
    return {
      topPerformers: sorted.slice(0, 3),
      bottomPerformers: sorted.slice(-3).reverse(),
    };
  }, [positions, perfMap]);

  // ── Concentration warnings ─────────────────────────────────────────────────
  const chainWarning = useMemo(() => {
    if (chainExposure.length === 0 || totalPortfolioValue === 0) return null;
    const top = chainExposure[0];
    const pct = (top.value / totalPortfolioValue) * 100;
    return pct > 70 ? `${pct.toFixed(0)}% on ${top.name}` : null;
  }, [chainExposure, totalPortfolioValue]);

  const protocolWarning = useMemo(() => {
    if (protocolExposure.length === 0 || totalPortfolioValue === 0) return null;
    const top = protocolExposure[0];
    const pct = (top.value / totalPortfolioValue) * 100;
    return pct > 50 ? `${pct.toFixed(0)}% in ${top.name}` : null;
  }, [protocolExposure, totalPortfolioValue]);

  // ── Loading / empty states ─────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="p-8 pt-24 bg-[#060d08] text-white min-h-screen">
        <Navbar />
        <div className="max-w-7xl mx-auto">
          <h1 className="text-3xl font-bold">Analytics</h1>
          <p className="text-gray-500 mt-2">Loading positions...</p>
        </div>
      </div>
    );
  }

  if (mounted && !hasWallet) {
    return (
      <div className="p-8 pt-24 bg-[#060d08] text-white min-h-screen">
        <Navbar />
        <div className="max-w-7xl mx-auto flex flex-col items-center justify-center py-32 text-center">
          <div className="w-16 h-16 mb-6 rounded-2xl bg-emerald-950/50 border border-emerald-400/15 flex items-center justify-center">
            <svg className="w-8 h-8 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" /></svg>
          </div>
          <h1 className="text-3xl font-bold mb-3">Portfolio Analytics</h1>
          <p className="text-gray-500 max-w-sm">Connect a wallet to view analytics and performance data for your DeFi positions.</p>
        </div>
      </div>
    );
  }

  const SortIcon = ({ col }: { col: SortKey }) => (
    <span className="ml-1 text-[10px]">
      {sortKey === col ? (sortDir === "desc" ? "\u25BC" : "\u25B2") : "\u25BC"}
    </span>
  );

  return (
    <div className="px-4 sm:px-8 pb-4 sm:pb-8 pt-20 sm:pt-24 bg-[#060d08] text-white min-h-screen">
      <Navbar />
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-8 mt-2">
          <h1 className="text-3xl font-bold">Analytics</h1>
          <p className="text-gray-500 mt-1 text-sm">Portfolio insights and performance metrics</p>
        </div>

        {/* ── SECTION 1: Portfolio Overview ─────────────────────────────────── */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 sm:gap-4 mb-6">
          {/* Total Portfolio Value */}
          <div className="bg-[#0a1a12] border border-emerald-400/10 rounded-xl p-4 sm:p-5">
            <p className="text-gray-500 text-xs font-medium mb-1">Total Portfolio</p>
            <p className="text-xl sm:text-2xl font-bold text-white">{fmtCompact(totalPortfolioValue)}</p>
            <div className="flex items-center gap-2 mt-1.5">
              <span className="text-[10px] text-gray-600">LP {fmtCompact(totalLpValue)}</span>
              {totalLendingValue > 0 && (
                <span className="text-[10px] text-gray-600">Lending {fmtCompact(totalLendingValue)}</span>
              )}
            </div>
          </div>

          {/* Total Daily Income */}
          <div className="bg-[#0a1a12] border border-emerald-400/10 rounded-xl p-4 sm:p-5">
            <p className="text-gray-500 text-xs font-medium mb-1">Daily Income</p>
            <p className="text-xl sm:text-2xl font-bold text-emerald-400">
              {totalDailyIncome > 0 ? fmt$(totalDailyIncome) : "$0.00"}
            </p>
            <p className="text-[10px] text-gray-600 mt-1.5">
              {totalDailyIncome > 0 ? `${fmt$(totalDailyIncome * 30)}/mo` : "No active positions"}
            </p>
          </div>

          {/* Unclaimed Fees */}
          <div className="bg-[#0a1a12] border border-emerald-400/10 rounded-xl p-4 sm:p-5">
            <p className="text-gray-500 text-xs font-medium mb-1">Unclaimed Fees</p>
            <p className="text-xl sm:text-2xl font-bold text-white">{fmt$(totalLpFees)}</p>
            <p className="text-[10px] text-gray-600 mt-1.5">
              {positions.filter((p) => p.fees > 0).length} positions with fees
            </p>
          </div>

          {/* Actual APR */}
          <div className="bg-[#0a1a12] border border-emerald-400/10 rounded-xl p-4 sm:p-5">
            <div className="flex items-center justify-between mb-1">
              <p className="text-gray-500 text-xs font-medium">Actual APR</p>
              <div className="flex bg-emerald-950/40 rounded-md overflow-hidden">
                {(["daily", "weekly", "monthly", "yearly"] as const).map((v) => (
                  <button
                    key={v}
                    onClick={() => setAprView(v)}
                    className={`px-1.5 py-0.5 text-[9px] font-medium transition-colors ${
                      aprView === v
                        ? "bg-emerald-600 text-white"
                        : "text-gray-500 hover:text-gray-300"
                    }`}
                  >
                    {v === "daily" ? "D" : v === "weekly" ? "W" : v === "monthly" ? "M" : "Y"}
                  </button>
                ))}
              </div>
            </div>
            {(() => {
              const apr = actualAPRData.apr;
              const displayRate = aprView === "daily" ? apr / 365 : aprView === "weekly" ? apr / 52 : aprView === "monthly" ? apr / 12 : apr;
              const yearlyDollar = (actualAPRData.totalValue * apr) / 100;
              const dollarIncome = aprView === "daily" ? yearlyDollar / 365
                : aprView === "weekly" ? yearlyDollar / 52
                : aprView === "monthly" ? yearlyDollar / 12
                : yearlyDollar;
              const periodLabel = aprView === "daily" ? "/day" : aprView === "weekly" ? "/week" : aprView === "monthly" ? "/mo" : "/year";
              return (
                <>
                  <p className={`text-xl sm:text-2xl font-bold ${apr > 0 ? "text-emerald-400" : "text-gray-600"}`}>
                    {apr > 0 ? `${displayRate.toFixed(displayRate < 1 ? 3 : 1)}%` : "--"}
                  </p>
                  <p className="text-[10px] text-gray-600 mt-1.5">
                    {apr > 0 ? `${fmt$(dollarIncome)}${periodLabel}` : "No active positions"}
                  </p>
                </>
              );
            })()}
          </div>

          {/* Health Score */}
          <div className="bg-[#0a1a12] border border-emerald-400/10 rounded-xl p-4 sm:p-5">
            <p className="text-gray-500 text-xs font-medium mb-1">Health Score</p>
            <div className="flex items-baseline gap-2">
              <p className={`text-xl sm:text-2xl font-bold ${
                healthScore == null ? "text-gray-600"
                : healthScore >= 70 ? "text-emerald-400"
                : healthScore >= 40 ? "text-amber-400"
                : "text-red-400"
              }`}>
                {healthScore != null ? healthScore : "--"}
              </p>
              <span className="text-xs text-gray-600">/100</span>
            </div>
            <p className="text-[10px] text-gray-600 mt-1.5">
              {healthScore != null
                ? healthScore >= 70 ? "Well diversified" : healthScore >= 40 ? "Moderate risk" : "High concentration"
                : "No data"}
            </p>
          </div>
        </div>

        {/* ── SECTION 2: Portfolio Performance Chart ────────────────────────── */}
        <div className="bg-[#0a1a12] border border-emerald-400/10 rounded-xl p-4 sm:p-6 mb-6">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
            <div>
              <h2 className="text-lg font-bold">Portfolio Value</h2>
              {effectiveFirst && (
                <div className="flex items-baseline gap-2 mt-1">
                  <span className={`text-sm font-semibold ${pnlDollar >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                    {pnlDollar >= 0 ? "+" : ""}{fmt$(pnlDollar)} ({pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(2)}%)
                  </span>
                  <span className="text-xs text-gray-600">{pnlLabel}</span>
                </div>
              )}
            </div>
            <div className="flex gap-1">
              {TIME_RANGES.map((r) => {
                const hasData = portfolioHistory.some((s) => s.timestamp >= Date.now() - r.ms);
                return (
                  <button
                    key={r.key}
                    onClick={() => setRangeKey(r.key)}
                    className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                      rangeKey === r.key
                        ? "bg-emerald-600 text-white"
                        : hasData
                        ? "bg-emerald-950/40 text-gray-400 hover:text-white"
                        : "bg-emerald-950/20 text-gray-700 cursor-default"
                    }`}
                  >
                    {r.key}
                  </button>
                );
              })}
            </div>
          </div>

          {chartData.length >= 2 ? (
            <ResponsiveContainer width="100%" height={300}>
              <AreaChart data={chartData}>
                <defs>
                  <linearGradient id="valueGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#0f2e1f" />
                <XAxis dataKey="label" tick={{ fill: "#6b7280", fontSize: 10 }} axisLine={false} tickLine={false} />
                <YAxis
                  tick={{ fill: "#6b7280", fontSize: 10 }}
                  tickFormatter={(v) => fmtCompact(v)}
                  axisLine={false}
                  tickLine={false}
                  width={55}
                />
                <Tooltip
                  contentStyle={tooltipStyle}
                  itemStyle={tooltipItemStyle}
                  labelStyle={tooltipLabelStyle}
                  formatter={(value: number | undefined) => [fmt$(value ?? 0), "Portfolio"]}
                />
                <Area
                  type="monotone"
                  dataKey="value"
                  stroke="#10b981"
                  strokeWidth={2}
                  fill="url(#valueGrad)"
                  dot={false}
                  activeDot={{ r: 4, fill: "#10b981" }}
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-[200px] text-gray-600 text-sm">
              Collecting data points... chart appears after ~1 minute
            </div>
          )}
        </div>

        {/* ── SECTION 2.5: LP Profit & Loss (on-chain) ──────────────────────── */}
        <div className="bg-[#0a1a12] border border-emerald-400/10 rounded-xl p-4 sm:p-6 mb-6">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
            <div>
              <h2 className="text-lg font-bold">LP Profit &amp; Loss</h2>
              <p className="text-xs text-gray-500 mt-0.5">Aggregated from on-chain deposit &amp; fee events across all LP positions</p>
            </div>
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
            <div className="bg-[#0a2e1a]/40 rounded-lg p-3 border border-emerald-400/5">
              <p className="text-xs text-gray-500 mb-1">Total Initial Value</p>
              <p className="text-lg font-bold text-white">{fmt$(lpPnl.initialValue)}</p>
              <p className="text-[10px] text-gray-600 mt-0.5">at deposit prices</p>
            </div>
            <div className="bg-[#0a2e1a]/40 rounded-lg p-3 border border-emerald-400/5">
              <p className="text-xs text-gray-500 mb-1">Current Value</p>
              <p className="text-lg font-bold text-white">{fmt$(lpPnl.currentValue)}</p>
              <p className="text-[10px] text-gray-600 mt-0.5">live</p>
            </div>
            <div className="bg-[#0a2e1a]/40 rounded-lg p-3 border border-emerald-400/5">
              <p className="text-xs text-gray-500 mb-1">Total Fees Collected</p>
              <p className="text-lg font-bold text-emerald-300">{fmt$(lpPnl.feesCollected)}</p>
              <p className="text-[10px] text-gray-600 mt-0.5">claimed lifetime</p>
            </div>
            <div className="bg-[#0a2e1a]/40 rounded-lg p-3 border border-emerald-400/5">
              <p className="text-xs text-gray-500 mb-1">Total Fees Unclaimed</p>
              <p className="text-lg font-bold text-emerald-300">{fmt$(lpPnl.feesUnclaimed)}</p>
              <p className="text-[10px] text-gray-600 mt-0.5">pending on-chain</p>
            </div>
            <div className="bg-[#0a2e1a]/40 rounded-lg p-3 border border-emerald-400/5">
              <p className="text-xs text-gray-500 mb-1">Total Impermanent Loss</p>
              <p className={`text-lg font-bold ${lpPnl.ilUSD <= 0 ? "text-red-400" : "text-emerald-400"}`}>
                {fmt$(lpPnl.ilUSD)}
              </p>
              <p className="text-[10px] text-gray-600 mt-0.5">vs HODL</p>
            </div>
            <div className="bg-[#0a2e1a]/40 rounded-lg p-3 border border-emerald-400/5">
              <p className="text-xs text-gray-500 mb-1">Net P&amp;L</p>
              <p className={`text-lg font-bold ${lpPnl.netPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                {lpPnl.netPnl >= 0 ? "+" : ""}{fmt$(lpPnl.netPnl)}
              </p>
              <p className={`text-[10px] mt-0.5 ${lpPnl.netPnl >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                {lpPnl.netPnlPct >= 0 ? "+" : ""}{lpPnl.netPnlPct.toFixed(2)}%
              </p>
            </div>
          </div>

          {lpPnl.excluded > 0 && (
            <p className="text-[11px] text-gray-600 mt-3">
              {lpPnl.excluded} position{lpPnl.excluded === 1 ? "" : "s"} excluded — entry data unavailable.
            </p>
          )}
          {lpPnl.isLoading && lpPnl.included === 0 && (
            <p className="text-[11px] text-gray-600 mt-3">Loading on-chain history…</p>
          )}
        </div>

        {/* ── SECTION 3: Income Breakdown ───────────────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6 mb-6">
          {/* Income by Source */}
          <div className="bg-[#0a1a12] border border-emerald-400/10 rounded-xl p-4 sm:p-6">
            <h2 className="text-lg font-bold mb-4">Income by Source</h2>
            {totalDailyIncome > 0 ? (
              <>
                <ResponsiveContainer width="100%" height={220}>
                  <PieChart>
                    <Pie
                      data={[
                        { name: "LP Fees", value: parseFloat((dailyLpIncome * 365).toFixed(2)) },
                        ...(dailyLendingIncome > 0
                          ? [{ name: "Lending Interest", value: parseFloat((dailyLendingIncome * 365).toFixed(2)) }]
                          : []),
                      ]}
                      cx="50%"
                      cy="50%"
                      outerRadius={80}
                      innerRadius={50}
                      dataKey="value"
                      paddingAngle={2}
                    >
                      <Cell fill="#10b981" />
                      {dailyLendingIncome > 0 && <Cell fill="#3b82f6" />}
                    </Pie>
                    <Tooltip contentStyle={tooltipStyle} itemStyle={tooltipItemStyle} labelStyle={tooltipLabelStyle} formatter={dollarFormatter} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="flex justify-center gap-6 mt-2">
                  <div className="flex items-center gap-1.5 text-xs">
                    <div className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
                    <span className="text-gray-400">LP Fees</span>
                    <span className="text-white font-medium">{fmt$(dailyLpIncome * 365)}/yr</span>
                  </div>
                  {dailyLendingIncome > 0 && (
                    <div className="flex items-center gap-1.5 text-xs">
                      <div className="w-2.5 h-2.5 rounded-full bg-blue-500" />
                      <span className="text-gray-400">Lending</span>
                      <span className="text-white font-medium">{fmt$(dailyLendingIncome * 365)}/yr</span>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="flex items-center justify-center h-[220px] text-gray-600 text-sm">
                No active income sources
              </div>
            )}
          </div>

          {/* Income by Chain */}
          <div className="bg-[#0a1a12] border border-emerald-400/10 rounded-xl p-4 sm:p-6">
            <h2 className="text-lg font-bold mb-4">Daily Income by Chain</h2>
            {incomeByChain.length > 0 ? (
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={incomeByChain} layout="vertical" margin={{ left: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#0f2e1f" horizontal={false} />
                  <XAxis
                    type="number"
                    tick={{ fill: "#6b7280", fontSize: 10 }}
                    tickFormatter={(v) => `$${v.toFixed(1)}`}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    type="category"
                    dataKey="chain"
                    tick={{ fill: "#9ca3af", fontSize: 11 }}
                    width={70}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip
                    contentStyle={tooltipStyle}
                    itemStyle={tooltipItemStyle}
                    labelStyle={tooltipLabelStyle}
                    formatter={(value: number | undefined) => [fmt$(value ?? 0) + "/day", "Income"]}
                  />
                  <Bar dataKey="daily" radius={[0, 4, 4, 0]} maxBarSize={24}>
                    {incomeByChain.map((entry, i) => (
                      <Cell key={i} fill={CHAIN_COLORS[entry.chain] ?? PIE_COLORS[i % PIE_COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-[260px] text-gray-600 text-sm">
                No income data available
              </div>
            )}
          </div>
        </div>

        {/* ── SECTION 4: Position Performance Table ────────────────────────── */}
        <div className="bg-[#0a1a12] border border-emerald-400/10 rounded-xl p-4 sm:p-6 mb-6">
          <h2 className="text-lg font-bold mb-4">Position Performance</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-emerald-400/10">
                  <th className="text-left py-2.5 px-2 text-gray-500 font-medium text-xs">Position</th>
                  <th
                    className="text-left py-2.5 px-2 text-gray-500 font-medium text-xs cursor-pointer hover:text-gray-300"
                    onClick={() => handleSort("protocol")}
                  >Protocol<SortIcon col="protocol" /></th>
                  <th
                    className="text-left py-2.5 px-2 text-gray-500 font-medium text-xs cursor-pointer hover:text-gray-300"
                    onClick={() => handleSort("chain")}
                  >Chain<SortIcon col="chain" /></th>
                  <th
                    className="text-right py-2.5 px-2 text-gray-500 font-medium text-xs cursor-pointer hover:text-gray-300"
                    onClick={() => handleSort("value")}
                  >Value<SortIcon col="value" /></th>
                  <th
                    className="text-right py-2.5 px-2 text-gray-500 font-medium text-xs cursor-pointer hover:text-gray-300"
                    onClick={() => handleSort("apy")}
                  >APR<SortIcon col="apy" /></th>
                  <th
                    className="text-right py-2.5 px-2 text-gray-500 font-medium text-xs cursor-pointer hover:text-gray-300 hidden sm:table-cell"
                    onClick={() => handleSort("daily")}
                  >Daily<SortIcon col="daily" /></th>
                  <th
                    className="text-right py-2.5 px-2 text-gray-500 font-medium text-xs cursor-pointer hover:text-gray-300 hidden sm:table-cell"
                    onClick={() => handleSort("fees")}
                  >Fees<SortIcon col="fees" /></th>
                  <th className="text-center py-2.5 px-2 text-gray-500 font-medium text-xs">Status</th>
                </tr>
              </thead>
              <tbody>
                {sortedPositions.map((p) => {
                  // Performance color based on actual/estimated APR
                  const perfColor = p.displayAPR >= 20 ? "text-emerald-400"
                    : p.displayAPR >= 5 ? "text-amber-400"
                    : p.displayAPR > 0 ? "text-red-400"
                    : "text-gray-600";

                  return (
                    <tr key={p.id} className="border-b border-emerald-400/5 hover:bg-emerald-950/20 transition-colors">
                      <td className="py-2.5 px-2">
                        <span className="text-white font-medium text-xs sm:text-sm">{p.pair}</span>
                      </td>
                      <td className="py-2.5 px-2">
                        <span
                          className="text-xs px-1.5 py-0.5 rounded-md"
                          style={{
                            backgroundColor: `${PROTOCOL_COLORS[p.protocol] ?? "#6b7280"}15`,
                            color: PROTOCOL_COLORS[p.protocol] ?? "#9ca3af",
                          }}
                        >
                          {p.protocol}
                        </span>
                      </td>
                      <td className="py-2.5 px-2">
                        <span className="text-xs text-gray-400">{p.chain}</span>
                      </td>
                      <td className="py-2.5 px-2 text-right font-mono text-xs text-white">
                        {fmt$(p.value)}
                      </td>
                      <td className={`py-2.5 px-2 text-right font-mono text-xs ${perfColor}`}>
                        {p.displayAPR > 0 ? `${p.displayAPR.toFixed(1)}%` : "--"}
                        {p.isEstimated && p.displayAPR > 0 && (
                          <span className="text-[9px] text-gray-600 ml-0.5">est.</span>
                        )}
                      </td>
                      <td className="py-2.5 px-2 text-right font-mono text-xs text-gray-400 hidden sm:table-cell">
                        {p.displayDaily > 0 ? (
                          <>
                            {fmt$(p.displayDaily)}
                            {p.isEstimated && <span className="text-[9px] text-gray-600 ml-0.5">est.</span>}
                          </>
                        ) : "--"}
                      </td>
                      <td className="py-2.5 px-2 text-right font-mono text-xs text-gray-400 hidden sm:table-cell">
                        {p.fees > 0 ? fmt$(p.fees) : "--"}
                      </td>
                      <td className="py-2.5 px-2 text-center">
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                          p.status === "In Range" ? "bg-emerald-500/15 text-emerald-400"
                          : p.status === "Out of Range" ? "bg-amber-500/15 text-amber-400"
                          : "bg-gray-500/15 text-gray-500"
                        }`}>
                          {p.status}
                        </span>
                      </td>
                    </tr>
                  );
                })}
                {sortedPositions.length === 0 && (
                  <tr>
                    <td colSpan={8} className="py-8 text-center text-gray-600 text-sm">No LP positions found</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Lending positions summary rows */}
          {lendingPositions.length > 0 && (
            <>
              <div className="border-t border-emerald-400/10 mt-4 pt-4">
                <h3 className="text-sm font-semibold text-gray-400 mb-3">Lending Positions</h3>
                <div className="space-y-2">
                  {lendingPositions.map((lp) => (
                    <div
                      key={lp.protocol + lp.chain}
                      className="flex items-center justify-between py-2 px-2 rounded-lg hover:bg-emerald-950/20 transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <span
                          className="text-xs px-1.5 py-0.5 rounded-md"
                          style={{
                            backgroundColor: `${PROTOCOL_COLORS[lp.protocol] ?? "#6b7280"}15`,
                            color: PROTOCOL_COLORS[lp.protocol] ?? "#9ca3af",
                          }}
                        >
                          {lp.protocol}
                        </span>
                        <span className="text-xs text-gray-500">{lp.chain}</span>
                      </div>
                      <div className="flex items-center gap-4 text-xs">
                        <span className="text-white font-mono">{fmt$(lp.totalSupplied)}</span>
                        <span className={`font-mono ${lp.supplyApy != null && lp.supplyApy > 0 ? "text-emerald-400" : "text-gray-600"}`}>
                          {lp.supplyApy != null ? `${lp.supplyApy.toFixed(1)}%` : "--"}
                        </span>
                        {lp.totalBorrowed > 0 && (
                          <span className="text-red-400 font-mono">-{fmt$(lp.totalBorrowed)}</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>

        {/* ── SECTION 5: Risk Analysis ─────────────────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6 mb-6">
          {/* Chain Exposure */}
          <div className="bg-[#0a1a12] border border-emerald-400/10 rounded-xl p-4 sm:p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold">Chain Exposure</h2>
              {chainWarning && (
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 font-medium">
                  {chainWarning}
                </span>
              )}
            </div>
            {chainExposure.length > 0 ? (
              <ResponsiveContainer width="100%" height={280}>
                <PieChart>
                  <Pie
                    data={chainExposure}
                    cx="50%"
                    cy="45%"
                    outerRadius={90}
                    innerRadius={55}
                    dataKey="value"
                    paddingAngle={2}
                  >
                    {chainExposure.map((entry, i) => (
                      <Cell key={i} fill={CHAIN_COLORS[entry.name] ?? PIE_COLORS[i % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={tooltipStyle} itemStyle={tooltipItemStyle} labelStyle={tooltipLabelStyle} formatter={dollarFormatter} />
                  <Legend content={PieLegend} />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-[280px] text-gray-600 text-sm">No data</div>
            )}
          </div>

          {/* Protocol Exposure */}
          <div className="bg-[#0a1a12] border border-emerald-400/10 rounded-xl p-4 sm:p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold">Protocol Exposure</h2>
              {protocolWarning && (
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 font-medium">
                  {protocolWarning}
                </span>
              )}
            </div>
            {protocolExposure.length > 0 ? (
              <ResponsiveContainer width="100%" height={280}>
                <PieChart>
                  <Pie
                    data={protocolExposure}
                    cx="50%"
                    cy="45%"
                    outerRadius={90}
                    innerRadius={55}
                    dataKey="value"
                    paddingAngle={2}
                  >
                    {protocolExposure.map((entry, i) => (
                      <Cell key={i} fill={PROTOCOL_COLORS[entry.name] ?? PIE_COLORS[i % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={tooltipStyle} itemStyle={tooltipItemStyle} labelStyle={tooltipLabelStyle} formatter={dollarFormatter} />
                  <Legend content={PieLegend} />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-[280px] text-gray-600 text-sm">No data</div>
            )}
          </div>
        </div>

        {/* ── SECTION 6: Top & Bottom Performers ───────────────────────────── */}
        {(topPerformers.length > 0 || bottomPerformers.length > 0) && (
          <div className="bg-[#0a1a12] border border-emerald-400/10 rounded-xl p-4 sm:p-6 mb-12">
            <h2 className="text-lg font-bold mb-1">Performance Rankings</h2>
            <p className="text-[10px] text-gray-600 mb-4">Ranked by actual APR from claimed fees{activityLoading ? " (loading...)" : ""}</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
              {/* Top Performers */}
              <div>
                <h3 className="text-xs font-semibold text-emerald-400 mb-3 uppercase tracking-wider">Top Performers</h3>
                <div className="space-y-2">
                  {topPerformers.map((p, i) => (
                    <div key={p.id} className="flex items-center justify-between py-2 px-3 rounded-lg bg-emerald-950/20">
                      <div className="flex items-center gap-2.5">
                        <span className="text-xs font-bold text-emerald-600 w-5">#{i + 1}</span>
                        <div>
                          <p className="text-sm font-medium text-white">{p.pair}</p>
                          <p className="text-[10px] text-gray-500">{p.protocol} / {p.chain}</p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-bold text-emerald-400">
                          {p.displayAPR.toFixed(1)}%
                          {p.isEstimated && <span className="text-[9px] text-gray-600 ml-0.5 font-normal">est.</span>}
                        </p>
                        <p className="text-[10px] text-gray-500">{fmt$(p.value)}</p>
                      </div>
                    </div>
                  ))}
                  {topPerformers.length === 0 && (
                    <p className="text-gray-600 text-xs">No active positions</p>
                  )}
                </div>
              </div>

              {/* Bottom Performers */}
              <div>
                <h3 className="text-xs font-semibold text-red-400 mb-3 uppercase tracking-wider">Lowest Yield</h3>
                <div className="space-y-2">
                  {bottomPerformers.map((p, i) => (
                    <div key={p.id} className="flex items-center justify-between py-2 px-3 rounded-lg bg-red-950/10">
                      <div className="flex items-center gap-2.5">
                        <span className="text-xs font-bold text-red-600 w-5">#{topPerformers.length - i}</span>
                        <div>
                          <p className="text-sm font-medium text-white">{p.pair}</p>
                          <p className="text-[10px] text-gray-500">{p.protocol} / {p.chain}</p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-bold text-red-400">
                          {p.displayAPR.toFixed(1)}%
                          {p.isEstimated && <span className="text-[9px] text-gray-600 ml-0.5 font-normal">est.</span>}
                        </p>
                        <p className="text-[10px] text-gray-500">{fmt$(p.value)}</p>
                      </div>
                    </div>
                  ))}
                  {bottomPerformers.length === 0 && (
                    <p className="text-gray-600 text-xs">No active positions</p>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
