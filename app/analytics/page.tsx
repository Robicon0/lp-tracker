"use client";

import { useMemo, useEffect, useState } from "react";
import Navbar from "../Navbar";
import { usePositions } from "../contexts/PositionsContext";
import { useLendingPositions, type ExternalLendingPosition } from "../hooks/useLendingPositions";
import { usePortfolioHistory } from "../hooks/usePortfolioHistory";
import { useAllPositionsActivity } from "../hooks/useAllPositionsActivity";
import { useWalletLevelFees } from "../hooks/useWalletLevelFees";
import { useLpPnl } from "../hooks/useLpPnl";
import { useWalletTokens } from "../hooks/useWalletTokens";
import { useAaveV3Rates } from "../hooks/useAaveV3Rates";
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
  { key: "1D",   ms: 1   * 24 * 3_600_000, label: "24h",     xFmt: (d: Date) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) },
  { key: "7D",   ms: 7   * 24 * 3_600_000, label: "7 days",  xFmt: (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) },
  { key: "30D",  ms: 30  * 24 * 3_600_000, label: "30 days", xFmt: (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) },
  { key: "90D",  ms: 90  * 24 * 3_600_000, label: "90 days", xFmt: (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) },
  { key: "180D", ms: 180 * 24 * 3_600_000, label: "180 days",xFmt: (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) },
  { key: "1Y",   ms: 365 * 24 * 3_600_000, label: "1 year",  xFmt: (d: Date) => d.toLocaleDateString("en-US", { month: "short", year: "2-digit" }) },
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

// ── ExposureCard — donut + right-side hover-synced legend ────────────────────
// Reused for Chain Exposure and Protocol Exposure. Renders the donut on the
// left (with center text) and an interactive legend on the right where each
// row stays in sync with donut slice hover. Hovering either side highlights
// the same slice. Auto-handles any list length so new chains/protocols added
// in the future appear automatically with no code changes.

type ExposureRow = { name: string; value: number };

interface ExposureCardProps {
  title: string;
  warning?: string | null;
  data: ExposureRow[];
  colorOf: (name: string, i: number) => string;
  centerPrimary: string;
  centerSecondary: string;
  valueFmt: (v: number) => string;
}

function ExposureCard({
  title, warning, data, colorOf, centerPrimary, centerSecondary, valueFmt,
}: ExposureCardProps) {
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  const total = data.reduce((s, r) => s + r.value, 0);
  const colored = data.map((r, i) => ({ ...r, color: colorOf(r.name, i) }));

  return (
    <div className="bg-[#0a1a12] border border-emerald-400/10 rounded-xl p-4 sm:p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold">{title}</h2>
        {warning && (
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 font-medium">
            {warning}
          </span>
        )}
      </div>
      {data.length === 0 ? (
        <div className="flex items-center justify-center h-[260px] text-gray-600 text-sm">No data</div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-[200px_1fr] gap-4 items-center">
          <div className="relative" style={{ height: 220 }}>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={colored}
                  cx="50%"
                  cy="50%"
                  outerRadius={92}
                  innerRadius={62}
                  dataKey="value"
                  paddingAngle={2}
                  stroke="#0a1a12"
                  strokeWidth={2}
                  onMouseEnter={(_, i) => setActiveIdx(i)}
                  onMouseLeave={() => setActiveIdx(null)}
                >
                  {colored.map((entry, i) => (
                    <Cell
                      key={entry.name}
                      fill={entry.color}
                      opacity={activeIdx == null || activeIdx === i ? 1 : 0.35}
                    />
                  ))}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
              {activeIdx != null && colored[activeIdx] ? (
                <>
                  <p className="text-[10px] uppercase tracking-wider text-gray-500">
                    {colored[activeIdx].name}
                  </p>
                  <p className="text-xl font-bold text-white">{valueFmt(colored[activeIdx].value)}</p>
                  <p className="text-[10px] text-gray-500">
                    {total > 0 ? ((colored[activeIdx].value / total) * 100).toFixed(1) : "0"}%
                  </p>
                </>
              ) : (
                <>
                  <p className="text-2xl font-bold text-white">{centerPrimary}</p>
                  <p className="text-[11px] text-gray-500 mt-0.5">{centerSecondary}</p>
                </>
              )}
            </div>
          </div>

          {/* Right-side legend */}
          <div className="flex flex-col gap-1 max-h-[240px] overflow-y-auto pr-1">
            {colored.map((row, i) => {
              const pct = total > 0 ? (row.value / total) * 100 : 0;
              const isActive = activeIdx === i;
              return (
                <button
                  type="button"
                  key={row.name}
                  onMouseEnter={() => setActiveIdx(i)}
                  onMouseLeave={() => setActiveIdx(null)}
                  onFocus={() => setActiveIdx(i)}
                  onBlur={() => setActiveIdx(null)}
                  className={`flex items-center justify-between gap-3 px-2.5 py-1.5 rounded-md text-left transition-colors ${
                    isActive ? "bg-emerald-900/30" : "hover:bg-emerald-900/15"
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: row.color }} />
                    <span className="text-sm text-white truncate" title={row.name}>{row.name}</span>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <p className="text-sm font-semibold text-emerald-300">{pct.toFixed(1)}%</p>
                    <p className="text-[10px] text-gray-500">{valueFmt(row.value)}</p>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Sort config for position table ───────────────────────────────────────────

type SortKey = "value" | "apy" | "daily" | "fees" | "protocol" | "chain";
type SortDir = "asc" | "desc";

// ── Main Component ───────────────────────────────────────────────────────────

// Fallback AAVE V3 supply APYs (used only when live rate fetch fails)
const FALLBACK_AAVE_SUPPLY_APY: Record<string, number> = {
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
  const { tokens: rawWalletTokens } = useWalletTokens();
  const { rates: aaveRates, prices: aavePrices } = useAaveV3Rates(rawWalletTokens);
  const walletTokens = useMemo(() => {
    return rawWalletTokens.map((t) => {
      if ((!t.isLending && !t.isDebt) || t.price > 0) return t;
      const live = aavePrices[t.contractAddress?.toLowerCase() ?? ""];
      if (!live || live <= 0) return t;
      return { ...t, price: live, usdValue: t.balance * live };
    });
  }, [rawWalletTokens, aavePrices]);
  const { address } = useAccount();
  const { solanaAddress, suiAddress } = useWalletAuth();
  const { watchedWallets } = useWatchedWallets();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const hasWallet = mounted && (!!(address || solanaAddress || suiAddress) || watchedWallets.length > 0);

  // ── Build AAVE lending positions from wallet tokens ─────────────────────────
  const lendingPositions: ExternalLendingPosition[] = useMemo(() => {
    // AAVE aTokens (supply) + debt tokens (borrow) grouped by chain
    const aaveByChain = new Map<string, {
      supplied: number; supplyApy: number;
      borrowed: number; borrowApy: number;
    }>();
    for (const t of walletTokens) {
      if (!t.isLending && !t.isDebt) continue;
      const chain = getATokenChain(t.symbol) ?? t.chain;
      const prev = aaveByChain.get(chain) ?? { supplied: 0, supplyApy: 0, borrowed: 0, borrowApy: 0 };

      const addr = t.contractAddress?.toLowerCase();
      const live = addr ? aaveRates[addr] : undefined;
      const fallbackSupply = FALLBACK_AAVE_SUPPLY_APY[getAaveUnderlying(t.symbol)] ?? 0;

      if (t.isLending) {
        const tokenApy = live?.supplyApy ?? fallbackSupply;
        const newSupplied = prev.supplied + t.usdValue;
        prev.supplyApy = newSupplied > 0
          ? (prev.supplyApy * prev.supplied + tokenApy * t.usdValue) / newSupplied
          : 0;
        prev.supplied = newSupplied;
      } else if (t.isDebt) {
        const tokenApy = live?.borrowApy ?? 0;
        const newBorrowed = prev.borrowed + t.usdValue;
        prev.borrowApy = newBorrowed > 0
          ? (prev.borrowApy * prev.borrowed + tokenApy * t.usdValue) / newBorrowed
          : 0;
        prev.borrowed = newBorrowed;
      }

      aaveByChain.set(chain, prev);
    }

    const aavePositions: ExternalLendingPosition[] = [...aaveByChain.entries()]
      .filter(([, v]) => v.supplied > 0 || v.borrowed > 0)
      .map(([chain, v]) => ({
        protocol: "AAVE V3",
        chain,
        totalSupplied: v.supplied,
        totalBorrowed: v.borrowed,
        supplyApy: v.supplyApy,
        borrowApy: v.borrowApy,
        suppliedAssets: [],
        borrowedAssets: [],
        manageUrl: "https://app.aave.com",
      }));

    return [...aavePositions, ...externalLendingPositions];
  }, [walletTokens, aaveRates, externalLendingPositions]);

  // ── Actual performance data from on-chain activity ────────────────────────
  const { perfMap, eventsMap, isLoading: activityLoading } = useAllPositionsActivity(positions);
  const { events: walletLevelFees } = useWalletLevelFees(positions);
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

  // ── Fee income — aggregate from on-chain fee_claim / reward_claim events ───
  // Any position whose protocol is supported by `useAllPositionsActivity`
  // contributes; protocol + chain are read from `positions`, not hardcoded, so
  // new protocols automatically appear with no code change.
  const feeIncome = useMemo(() => {
    interface FlatFee { ts: number; usd: number; protocol: string; chain: string; dedupeKey: string; }
    const flat: FlatFee[] = [];
    const posById = new Map(positions.map((p) => [p.id, p]));

    // Key used to suppress the same on-chain fee claim showing up twice
    // (once from the per-position scan, once from the wallet-scope scan).
    // txHash alone is not enough — a single tx can settle multiple fee
    // claims — so also hash the amounts. If txHash is missing, fall back
    // to (protocol, ts, amount0, amount1) so the dedupe still works.
    const buildKey = (protocol: string, e: { txHash?: string; timestamp: number; amount0: number; amount1: number }) => {
      if (e.txHash) return `${protocol}::${e.txHash}::${e.amount0}::${e.amount1}`;
      return `${protocol}::ts${e.timestamp}::${e.amount0}::${e.amount1}`;
    };

    const push = (
      protocol: string,
      chain: string,
      e: { type: string; timestamp: number; amount0: number; amount1: number; usdAtTime: number | null; txHash?: string },
    ) => {
      if (e.type !== "fee_claim" && e.type !== "reward_claim") return;
      const usd = e.usdAtTime ?? 0;
      if (!Number.isFinite(usd) || usd <= 0) return;
      flat.push({
        ts: e.timestamp * 1000,
        usd,
        protocol,
        chain,
        dedupeKey: buildKey(protocol, e),
      });
    };

    for (const [posId, events] of eventsMap.entries()) {
      const pos = posById.get(posId);
      if (!pos) continue;
      for (const e of events) push(pos.protocol, pos.chain, e);
    }
    // Wallet-scope events — captures fees from destroyed positions that
    // no longer appear in `positions`. Tagged with their own protocol/chain.
    for (const t of walletLevelFees) push(t.protocol, t.chain, t.event);

    // Dedupe — keep only first occurrence per dedupeKey.
    const seen = new Set<string>();
    const deduped = flat.filter((f) => {
      if (seen.has(f.dedupeKey)) return false;
      seen.add(f.dedupeKey);
      return true;
    });
    deduped.sort((a, b) => a.ts - b.ts);
    const flatDeduped = deduped;
    // Replace flat with deduped for the rest of the computation.
    flat.length = 0;
    flat.push(...flatDeduped);

    const totalAllTime = flat.reduce((s, f) => s + f.usd, 0);
    const inWindow = flat.filter((f) => f.ts >= rangeCutoff);
    const totalWindow = inWindow.reduce((s, f) => s + f.usd, 0);

    // Cumulative series within the active range (starts at 0, ends at totalWindow).
    const now = Date.now();
    const series: { label: string; ts: number; value: number }[] = [];
    series.push({ ts: rangeCutoff, label: activeRange.xFmt(new Date(rangeCutoff)), value: 0 });
    let running = 0;
    for (const f of inWindow) {
      running += f.usd;
      series.push({ ts: f.ts, label: activeRange.xFmt(new Date(f.ts)), value: running });
    }
    if (series[series.length - 1].ts < now) {
      series.push({ ts: now, label: activeRange.xFmt(new Date(now)), value: running });
    }

    // Protocol breakdown — in-window fees, grouped by protocol+chain.
    const byKey = new Map<string, { protocol: string; chain: string; usd: number }>();
    for (const f of inWindow) {
      const k = `${f.protocol}::${f.chain}`;
      const prev = byKey.get(k) ?? { protocol: f.protocol, chain: f.chain, usd: 0 };
      prev.usd += f.usd;
      byKey.set(k, prev);
    }
    const protocols = Array.from(byKey.values())
      .filter((p) => p.usd > 0)
      .map((p) => ({
        ...p,
        pct: totalWindow > 0 ? (p.usd / totalWindow) * 100 : 0,
      }))
      .sort((a, b) => b.usd - a.usd);

    return { totalAllTime, totalWindow, series, protocols };
  }, [eventsMap, positions, rangeCutoff, activeRange, walletLevelFees]);

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

  // ── Income by Source — D/M/Y toggle ─────────────────────────────────────
  // D = today, M = this month (last 30d), Y = this year (last 365d).
  // LP fees show ACCRUED income for the period using each position's APY —
  // this includes uncollected fees, so the number is non-zero even on days
  // with no claim. Lending uses the current-APY projection too. The math is
  // protocol-agnostic — every active position contributes, automatically.
  const [incomePeriod, setIncomePeriod] = useState<"D" | "M" | "Y">("D");
  const [chainPeriod, setChainPeriod] = useState<"1D" | "7D" | "30D">("1D");
  const incomeWindow = useMemo(() => {
    const periodDays = incomePeriod === "D" ? 1 : incomePeriod === "M" ? 30 : 365;
    const lpAccrued = dailyLpIncome * periodDays;
    const lendingProjected = dailyLendingIncome * periodDays;
    return { lpAccrued, lendingProjected, total: lpAccrued + lendingProjected };
  }, [incomePeriod, dailyLpIncome, dailyLendingIncome]);

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

  // ── Income by chain (LP only — only chains with active LP positions) ──────
  // Lending APRs are excluded here so the section reflects fee-earning chains
  // exclusively. Sorted desc by daily income; total row appended.
  const incomeByChain = useMemo(() => {
    const m: Record<string, number> = {};
    for (const p of positions) {
      if (p.status === "Closed" || p.value <= 0) continue;
      if (p.apy > 0) {
        const daily = (p.value * p.apy) / 100 / 365;
        m[p.chain] = (m[p.chain] ?? 0) + daily;
      } else if (!(p.chain in m)) {
        // Chain has an active position but APY is unknown — record at $0 so
        // it shows up in the list rather than being silently dropped.
        m[p.chain] = 0;
      }
    }
    return Object.entries(m)
      .map(([chain, daily]) => ({ chain, daily }))
      .sort((a, b) => b.daily - a.daily);
  }, [positions]);

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

        {/* ── SECTION 2: Fee Income Chart ───────────────────────────────────── */}
        <div className="bg-[#0a1a12] border border-emerald-400/10 rounded-xl p-4 sm:p-6 mb-6">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-4">
            <div>
              <h2 className="text-lg font-bold">Fee Income</h2>
              <div className="mt-1">
                <span className="text-2xl font-bold text-emerald-300">
                  {fmt$(feeIncome.totalWindow)}
                </span>
              </div>
              <p className="text-xs text-gray-500 mt-0.5">fees earned in last {activeRange.label} — all chains</p>
              <p className="text-[11px] text-gray-600 mt-0.5">Lifetime: {fmt$(feeIncome.totalAllTime)}</p>
            </div>
            <div className="flex gap-1">
              {TIME_RANGES.map((r) => (
                <button
                  key={r.key}
                  onClick={() => setRangeKey(r.key)}
                  className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                    rangeKey === r.key
                      ? "bg-emerald-600 text-white"
                      : "bg-emerald-950/40 text-gray-400 hover:text-white"
                  }`}
                >
                  {r.key}
                </button>
              ))}
            </div>
          </div>

          {feeIncome.series.length >= 2 && feeIncome.totalWindow > 0 ? (
            <ResponsiveContainer width="100%" height={300}>
              <AreaChart data={feeIncome.series}>
                <defs>
                  <linearGradient id="feeGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.35} />
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
                  formatter={(value: number | undefined) => [fmt$(value ?? 0), "Cumulative fees"]}
                />
                <Area
                  type="monotone"
                  dataKey="value"
                  stroke="#10b981"
                  strokeWidth={2}
                  fill="url(#feeGrad)"
                  dot={false}
                  activeDot={{ r: 4, fill: "#10b981" }}
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-[200px] text-gray-600 text-sm">
              {activityLoading
                ? "Loading on-chain fee history…"
                : `No fee claims in the last ${activeRange.label}`}
            </div>
          )}

          {/* Protocol breakdown */}
          <div className="mt-5">
            <div className="flex items-center justify-between mb-2">
              <p className="text-[11px] uppercase tracking-wider text-gray-500">
                By Protocol
              </p>
              {feeIncome.protocols.length > 0 && (
                <p className="text-[11px] text-gray-600">scroll to see all →</p>
              )}
            </div>
            {feeIncome.protocols.length > 0 ? (
              <div className="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1" style={{ scrollbarWidth: "thin" }}>
                {feeIncome.protocols.map((p) => {
                  const color = PROTOCOL_COLORS[p.protocol] ?? "#10b981";
                  return (
                    <div
                      key={`${p.protocol}::${p.chain}`}
                      className="flex-shrink-0 bg-[#0a2e1a]/40 border border-emerald-400/10 rounded-lg p-3"
                      style={{ width: 190, borderLeft: `3px solid ${color}` }}
                    >
                      <p className="text-sm font-semibold text-white truncate" title={p.protocol}>
                        {p.protocol}
                      </p>
                      <p className="text-[11px] text-gray-500 mt-0.5 truncate" title={p.chain}>
                        {p.chain}
                      </p>
                      <p className="text-lg font-bold text-emerald-300 mt-2">{fmt$(p.usd)}</p>
                      <p className="text-[11px] text-gray-500 mt-0.5">
                        {p.pct.toFixed(1)}% of {activeRange.label}
                      </p>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-xs text-gray-600">
                No fee claims in the last {activeRange.label}.
              </p>
            )}
          </div>
        </div>

        {/* ── SECTION 2.5: LP Profit & Loss (on-chain) ──────────────────────── */}
        <div className="bg-[#0a1a12] border border-emerald-400/10 rounded-xl p-4 sm:p-6 mb-6">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
            <div>
              <h2 className="text-lg font-bold flex items-center gap-2">
                LP Profit &amp; Loss
                {lpPnl.isLoading && (
                  <span
                    className="inline-block w-3 h-3 rounded-full border-2 border-emerald-400/30 border-t-emerald-400 animate-spin"
                    aria-label="Loading"
                  />
                )}
              </h2>
              <p className="text-xs text-gray-500 mt-0.5">
                Aggregated from on-chain deposit &amp; fee events across all LP positions
                {lpPnl.isLoading && lpPnl.included > 0 && (
                  <span className="text-gray-600"> — loading {lpPnl.included} of {lpPnl.included + lpPnl.excluded + lpPnl.errored + (lpPnl.isLoading ? 1 : 0)}…</span>
                )}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
            {[
              { label: "Total Initial Value", value: fmt$(lpPnl.initialValue), color: "text-white", foot: "at deposit prices" },
              { label: "Current Value",       value: fmt$(lpPnl.currentValue), color: "text-white", foot: "live" },
              { label: "Total Fees Collected", value: fmt$(lpPnl.feesCollected), color: "text-emerald-300", foot: "claimed lifetime" },
              { label: "Total Fees Unclaimed", value: fmt$(lpPnl.feesUnclaimed), color: "text-emerald-300", foot: "pending on-chain" },
              {
                label: "Total Impermanent Loss",
                value: `${-lpPnl.ilUSD > 0 ? "+" : ""}${fmt$(-lpPnl.ilUSD)}`,
                color: -lpPnl.ilUSD > 0 ? "text-red-400" : "text-emerald-400",
                foot: "Σ(HODL − Current), open only",
                tooltip: (() => {
                  // hodlValue derived from the identity ilUSD = currentValue - hodlValue
                  const hodlValue = lpPnl.currentValue - lpPnl.ilUSD;
                  const totalFees = lpPnl.feesCollected + lpPnl.feesUnclaimed;
                  const x = fmt$(lpPnl.currentValue); // current LP value
                  const y = fmt$(hodlValue);          // HODL value
                  const z = fmt$(Math.abs(lpPnl.ilUSD)); // |IL|
                  const w = fmt$(totalFees);          // fees earned
                  if (lpPnl.ilUSD >= 0) {
                    return `Your current LP value (${x}) is higher than your HODL value (${y}) by ${z}. The AMM rebalancing has worked in your favour. Combined with ${w} fees earned your total return is strong.\n\nFormula: IL = Current LP Value − HODL Value`;
                  }
                  const offset = totalFees >= Math.abs(lpPnl.ilUSD) ? "fully" : "partially";
                  return `Your current LP value (${x}) is lower than your HODL value (${y}) by ${z}. This is your impermanent loss. Your fees earned (${w}) ${offset} offset this loss. IL may recover if prices return to entry levels.\n\nFormula: IL = Current LP Value − HODL Value`;
                })(),
              },
              {
                label: "Net P&L",
                value: `${lpPnl.netPnl >= 0 ? "+" : ""}${fmt$(lpPnl.netPnl)}`,
                color: lpPnl.netPnl >= 0 ? "text-emerald-400" : "text-red-400",
                foot: `${lpPnl.netPnlPct >= 0 ? "+" : ""}${lpPnl.netPnlPct.toFixed(2)}%`,
                footColor: lpPnl.netPnl >= 0 ? "text-emerald-500" : "text-red-500",
              },
            ].map((card) => {
              const showSkeleton = lpPnl.isLoading && lpPnl.included === 0;
              return (
                <div key={card.label} className="bg-[#0a2e1a]/40 rounded-lg p-3 border border-emerald-400/5 relative">
                  <p className="text-xs text-gray-500 mb-1 flex items-center gap-1">
                    <span>{card.label}</span>
                    {card.tooltip && (
                      <span className="group relative inline-flex items-center">
                        <button
                          type="button"
                          aria-label={`About ${card.label}`}
                          tabIndex={0}
                          className="w-4 h-4 rounded-full border border-emerald-400/40 text-emerald-400/80 text-[10px] leading-none flex items-center justify-center hover:border-emerald-400 hover:text-emerald-300 focus:border-emerald-400 focus:text-emerald-300 focus:outline-none cursor-help"
                        >
                          ⓘ
                        </button>
                        <span
                          role="tooltip"
                          className="pointer-events-none absolute left-0 top-full mt-2 z-30 w-64 sm:w-72 whitespace-pre-wrap text-[11px] leading-relaxed bg-[#0a1f17] border border-emerald-400/30 rounded-lg p-3 text-emerald-50/90 shadow-2xl opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity"
                        >
                          {card.tooltip}
                        </span>
                      </span>
                    )}
                  </p>
                  {showSkeleton ? (
                    <div className="h-[22px] w-20 rounded bg-emerald-900/30 animate-pulse" />
                  ) : (
                    <p className={`text-lg font-bold ${card.color}`}>{card.value}</p>
                  )}
                  <p className={`text-[10px] mt-0.5 ${card.footColor ?? "text-gray-600"}`}>{card.foot}</p>
                </div>
              );
            })}
          </div>

          {lpPnl.excluded > 0 && (
            <p className="text-[11px] text-gray-600 mt-3">
              {lpPnl.excluded} position{lpPnl.excluded === 1 ? "" : "s"} excluded — entry data unavailable.
            </p>
          )}
          {lpPnl.errored > 0 && (
            <div className="mt-3 bg-red-950/30 border border-red-400/20 rounded-lg px-3 py-2">
              <p className="text-[12px] text-red-300 font-medium">
                Couldn&apos;t load {lpPnl.errored} position{lpPnl.errored === 1 ? "" : "s"}
                {lpPnl.errorReasons.length > 0 && (
                  <> — {lpPnl.errorReasons.slice(0, 3).join(", ")}</>
                )}
              </p>
              <p className="text-[11px] text-red-300/70 mt-0.5">
                The RPC didn&apos;t respond in 30s. Totals below are for the positions that did load. Refreshing the page will retry.
              </p>
            </div>
          )}
          {lpPnl.isLoading && lpPnl.included === 0 && lpPnl.errored === 0 && (
            <p className="text-[11px] text-gray-600 mt-3">Loading on-chain history…</p>
          )}
        </div>

        {/* ── SECTION 3: Income Breakdown ───────────────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6 mb-6">
          {/* Income by Source — donut center + D/M/Y toggle */}
          <div className="bg-[#0a1a12] border border-emerald-400/10 rounded-xl p-4 sm:p-6">
            <div className="flex items-start justify-between mb-4 gap-3">
              <div>
                <h2 className="text-lg font-bold">Income by Source</h2>
                <p className="text-xs text-gray-500 mt-0.5">
                  {incomePeriod === "D" ? "Today" : incomePeriod === "M" ? "This month" : "This year"}
                </p>
              </div>
              <div className="flex gap-1">
                {(["D", "M", "Y"] as const).map((k) => (
                  <button
                    key={k}
                    onClick={() => setIncomePeriod(k)}
                    className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                      incomePeriod === k
                        ? "bg-emerald-600 text-white"
                        : "bg-emerald-950/40 text-gray-400 hover:text-white"
                    }`}
                  >
                    {k}
                  </button>
                ))}
              </div>
            </div>

            {incomeWindow.total > 0 ? (
              <>
                <div className="relative">
                  <ResponsiveContainer width="100%" height={220}>
                    <PieChart>
                      <Pie
                        data={[
                          ...(incomeWindow.lpAccrued > 0
                            ? [{ name: "LP Fees", value: parseFloat(incomeWindow.lpAccrued.toFixed(2)), color: "#10b981" }]
                            : []),
                          ...(incomeWindow.lendingProjected > 0
                            ? [{ name: "Lending Interest", value: parseFloat(incomeWindow.lendingProjected.toFixed(2)), color: "#3b82f6" }]
                            : []),
                        ]}
                        cx="50%"
                        cy="50%"
                        outerRadius={88}
                        innerRadius={62}
                        dataKey="value"
                        paddingAngle={2}
                      >
                        {(incomeWindow.lpAccrued > 0 ? [{ color: "#10b981" }] : [])
                          .concat(incomeWindow.lendingProjected > 0 ? [{ color: "#3b82f6" }] : [])
                          .map((c, i) => <Cell key={i} fill={c.color} />)}
                      </Pie>
                      <Tooltip contentStyle={tooltipStyle} itemStyle={tooltipItemStyle} labelStyle={tooltipLabelStyle} formatter={dollarFormatter} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                    <p className="text-[10px] uppercase tracking-wider text-gray-500">Total</p>
                    <p className="text-2xl font-bold text-white">{fmt$(incomeWindow.total)}</p>
                    <p className="text-[10px] text-gray-500">
                      {incomePeriod === "D" ? "today" : incomePeriod === "M" ? "this month" : "this year"}
                    </p>
                  </div>
                </div>

                {/* Source cards */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-4">
                  <div className="bg-[#0a2e1a]/40 rounded-lg p-3 border border-emerald-400/15"
                       style={{ borderLeft: "3px solid #10b981" }}>
                    <p className="text-xs text-gray-400">LP Fees</p>
                    <p className="text-lg font-bold text-emerald-300">{fmt$(incomeWindow.lpAccrued)}</p>
                    <p className="text-[10px] text-gray-500 mt-0.5">accrued on-chain</p>
                  </div>
                  <div className="bg-[#0a1a3a]/40 rounded-lg p-3 border border-blue-400/15"
                       style={{ borderLeft: "3px solid #3b82f6" }}>
                    <p className="text-xs text-gray-400">Lending Interest</p>
                    <p className="text-lg font-bold text-blue-300">{fmt$(incomeWindow.lendingProjected)}</p>
                    <p className="text-[10px] text-gray-500 mt-0.5">estimated at current APY</p>
                  </div>
                </div>
              </>
            ) : (
              <div className="flex items-center justify-center h-[260px] text-gray-600 text-sm">
                No income in this period
              </div>
            )}
          </div>

          {/* Daily Income by Chain — period toggle + gradient bars + total row */}
          <div className="bg-[#0a1a12] border border-emerald-400/10 rounded-xl p-4 sm:p-6">
            <div className="flex items-start justify-between mb-4 gap-3">
              <div>
                <h2 className="text-lg font-bold">Daily Income by Chain</h2>
                <p className="text-[11px] text-gray-500 mt-0.5">est. from current pool APYs</p>
              </div>
              <div className="flex gap-1">
                {(["1D", "7D", "30D"] as const).map((k) => (
                  <button
                    key={k}
                    onClick={() => setChainPeriod(k)}
                    className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                      chainPeriod === k
                        ? "bg-emerald-600 text-white"
                        : "bg-emerald-950/40 text-gray-400 hover:text-white"
                    }`}
                  >
                    {k}
                  </button>
                ))}
              </div>
            </div>
            {incomeByChain.length > 0 ? (
              <>
                <div className="flex flex-col gap-2.5">
                  {(() => {
                    const days = chainPeriod === "1D" ? 1 : chainPeriod === "7D" ? 7 : 30;
                    const periodLabel = chainPeriod === "1D" ? "today" : `in ${chainPeriod.toLowerCase()}`;
                    const rows = [...incomeByChain]
                      .map((c) => ({ chain: c.chain, period: c.daily * days, daily: c.daily }))
                      .sort((a, b) => b.period - a.period);
                    const max = Math.max(...rows.map((r) => r.period), 0.0001);
                    return rows.map((row) => {
                      const pct = max > 0 ? (row.period / max) * 100 : 0;
                      const color = CHAIN_COLORS[row.chain] ?? "#10b981";
                      return (
                        <div key={row.chain} className="bg-[#0a2e1a]/30 rounded-lg p-2.5 border border-emerald-400/5">
                          <div className="flex items-center justify-between mb-1.5">
                            <div className="flex items-center gap-2">
                              <span className="w-2 h-2 rounded-full" style={{ background: color }} />
                              <span className="text-sm font-medium text-white">{row.chain}</span>
                            </div>
                            <div className="text-right">
                              <p className="text-sm font-semibold text-emerald-300">
                                {fmt$(row.period)}<span className="text-[10px] text-gray-500 font-normal"> {periodLabel}</span>
                              </p>
                              <p className="text-[10px] text-gray-500">{fmt$(row.daily * 30)}/mo</p>
                            </div>
                          </div>
                          <div className="h-1.5 rounded-full bg-emerald-950/50 overflow-hidden">
                            <div
                              className="h-full rounded-full"
                              style={{
                                width: `${Math.max(pct, 2)}%`,
                                background: `linear-gradient(90deg, ${color}33 0%, ${color} 100%)`,
                              }}
                            />
                          </div>
                        </div>
                      );
                    });
                  })()}
                </div>
                {/* Total row */}
                {(() => {
                  const days = chainPeriod === "1D" ? 1 : chainPeriod === "7D" ? 7 : 30;
                  const periodLabel = chainPeriod === "1D" ? "today" : `in ${chainPeriod.toLowerCase()}`;
                  const totalDaily = incomeByChain.reduce((s, c) => s + c.daily, 0);
                  return (
                    <div className="mt-3 pt-3 border-t border-emerald-400/10 flex items-center justify-between">
                      <span className="text-xs uppercase tracking-wider text-gray-500">Total</span>
                      <div className="text-right">
                        <p className="text-base font-bold text-white">
                          {fmt$(totalDaily * days)}
                          <span className="text-xs text-gray-500 font-normal"> {periodLabel}</span>
                        </p>
                        <p className="text-[11px] text-gray-500">{fmt$(totalDaily * 30)}/mo</p>
                      </div>
                    </div>
                  );
                })()}
              </>
            ) : (
              <div className="flex items-center justify-center h-[200px] text-gray-600 text-sm">
                No active LP positions
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

        {/* ── SECTION 5: Risk Analysis — Chain + Protocol exposure ─────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6 mb-6">
          <ExposureCard
            title="Chain Exposure"
            warning={chainWarning}
            data={chainExposure}
            colorOf={(name, i) => CHAIN_COLORS[name] ?? PIE_COLORS[i % PIE_COLORS.length]}
            centerPrimary={fmt$(totalPortfolioValue)}
            centerSecondary={`${chainExposure.length} chain${chainExposure.length === 1 ? "" : "s"}`}
            valueFmt={(v) => fmt$(v)}
          />
          <ExposureCard
            title="Protocol Exposure"
            warning={protocolWarning}
            data={protocolExposure}
            colorOf={(name, i) => PROTOCOL_COLORS[name] ?? PIE_COLORS[i % PIE_COLORS.length]}
            centerPrimary={String(protocolExposure.length)}
            centerSecondary="active"
            valueFmt={(v) => fmt$(v)}
          />
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
