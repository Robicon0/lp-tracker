"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import Link from "next/link";
import Navbar from "../Navbar";
import PriceTicker from "../PriceTicker";
import { usePositions } from "../contexts/PositionsContext";
import { useAccount } from "wagmi";
import { useWalletAuth } from "../contexts/WalletAuthContext";
import { useWatchedWallets, type WatchedWalletChain } from "../contexts/WatchedWalletsContext";
import { usePortfolioHistory } from "../hooks/usePortfolioHistory";
import type { AerodromePosition } from "../lib/aerodrome";
import {
  PieChart,
  Pie,
  Cell,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

// ── Time range config ────────────────────────────────────────────────────────
const TIME_RANGES = [
  { key: "1D",  ms: 1   * 24 * 3_600_000, label: "in last 24h",     xFmt: (d: Date) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) },
  { key: "7D",  ms: 7   * 24 * 3_600_000, label: "in last 7 days",  xFmt: (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) },
  { key: "30D", ms: 30  * 24 * 3_600_000, label: "in last 30 days", xFmt: (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) },
  { key: "90D", ms: 90  * 24 * 3_600_000, label: "in last 90 days", xFmt: (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) },
  { key: "1Y",  ms: 365 * 24 * 3_600_000, label: "in last year",    xFmt: (d: Date) => d.toLocaleDateString("en-US", { month: "short", year: "2-digit" }) },
] as const;

// ── Filter / sort options ────────────────────────────────────────────────────
const CHAIN_FILTERS = ["All", "Ethereum", "Base", "Arbitrum", "Optimism", "Polygon", "Avalanche", "Solana", "Sui", "HyperEVM", "BNB Chain"];
const STATUS_FILTERS = ["All", "In Range", "Out of Range", "Closed"];
const SORT_OPTIONS = [
  { label: "Value (High → Low)", key: "value", dir: "desc" },
  { label: "Value (Low → High)", key: "value", dir: "asc" },
  { label: "APY (High → Low)", key: "apy", dir: "desc" },
  { label: "APY (Low → High)", key: "apy", dir: "asc" },
  { label: "Fees (High → Low)", key: "fees", dir: "desc" },
  { label: "Fees (Low → High)", key: "fees", dir: "asc" },
] as const;

// ── Color maps ───────────────────────────────────────────────────────────────
const PROTOCOL_COLORS: Record<string, string> = {
  Aerodrome:   "#22c55e",
  "Uniswap V3": "#a855f7",
  Velodrome:   "#3b82f6",
  Orca:        "#f59e0b",
  Raydium:     "#ef4444",
  Cetus:       "#06b6d4",
  Bluefin:     "#0ea5e9",
  Momentum:    "#84cc16",
  HyperSwap:   "#f97316",
  KittenSwap:  "#ec4899",
  ProjectX:    "#8b5cf6",
  PRJX:        "#8b5cf6",
  PancakeSwap: "#fbbf24",
};
const CHAIN_COLORS: Record<string, string> = {
  Base:       "#0052ff",
  Ethereum:   "#627eea",
  Arbitrum:   "#2d9cdb",
  Optimism:   "#ff0420",
  Polygon:    "#8247e5",
  Avalanche:  "#e84142",
  Solana:     "#9945ff",
  Sui:        "#6fbcf0",
  HyperEVM:   "#00d4aa",
  "BNB Chain": "#f0b90b",
};

const STABLES_SET = new Set(["USDC", "USDT", "DAI", "USDbC", "USDC.e", "USDS"]);

// ── Helpers ──────────────────────────────────────────────────────────────────
function getProtocolColor(protocol: string): string {
  for (const [key, color] of Object.entries(PROTOCOL_COLORS)) {
    if (protocol.includes(key)) return color;
  }
  return "#6b7280";
}
function getChainColor(chain: string): string {
  return CHAIN_COLORS[chain] ?? "#6b7280";
}

function getManageUrl(protocol: string): string {
  if (protocol.includes("Aerodrome")) return "https://aerodrome.finance/positions";
  if (protocol.includes("Velodrome")) return "https://velodrome.finance/positions";
  if (protocol.includes("Uniswap")) return "https://app.uniswap.org/pools";
  if (protocol.includes("Orca")) return "https://v2.orca.so/";
  if (protocol.includes("Raydium")) return "https://raydium.io/portfolio/";
  if (protocol.includes("Bluefin")) return "https://trade.bluefin.io/liquidity";
  if (protocol.includes("Cetus")) return "https://app.cetus.zone/liquidity";
  if (protocol.includes("Momentum")) return "https://app.mmt.finance";
  if (protocol.includes("HyperSwap")) return "https://app.hyperswap.exchange/#/pool";
  if (protocol.includes("KittenSwap")) return "https://www.kittenswap.org";
  if (protocol.includes("ProjectX") || protocol.includes("PRJX")) return "https://prjx.com";
  if (protocol.includes("PancakeSwap")) return "https://pancakeswap.finance/liquidity";
  return "";
}

function formatTickPrice(tick: number, d0: number, d1: number, t0Sym: string, t1Sym: string): string {
  try {
    const rawPrice = Math.pow(1.0001, tick) * Math.pow(10, d0 - d1);
    if (!isFinite(rawPrice) || rawPrice <= 0) return "—";
    const fmt = (n: number) => {
      if (n < 0.00001) return n.toExponential(2);
      if (n < 0.001)   return n.toFixed(8);
      if (n < 1)       return n.toFixed(4);
      if (n < 1000)    return n.toFixed(2);
      return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
    };
    if (STABLES_SET.has(t1Sym)) return `$${fmt(rawPrice)}`;
    if (STABLES_SET.has(t0Sym)) {
      const inv = 1 / rawPrice;
      return isFinite(inv) && inv > 0 ? `$${fmt(inv)}` : "—";
    }
    return `${fmt(rawPrice)} ${t1Sym}`;
  } catch { return "—"; }
}

function getTickPriceUSD(tick: number, pos: AerodromePosition): number | null {
  const d0 = pos.token0Decimals ?? 18;
  const d1 = pos.token1Decimals ?? 6;
  try {
    const raw = Math.pow(1.0001, tick) * Math.pow(10, d0 - d1);
    if (!isFinite(raw) || raw <= 0) return null;
    if (STABLES_SET.has(pos.token1Symbol ?? "")) return raw;
    if (STABLES_SET.has(pos.token0Symbol ?? "")) { const inv = 1 / raw; return isFinite(inv) && inv > 0 ? inv : null; }
    if (pos.price1 && pos.price1 > 0) return raw * pos.price1;
    return raw;
  } catch { return null; }
}

function getCurrentPriceForRange(pos: AerodromePosition): number | null {
  if (STABLES_SET.has(pos.token1Symbol ?? "")) return pos.price0 ?? null;
  if (STABLES_SET.has(pos.token0Symbol ?? "")) return pos.price1 ?? null;
  return pos.price0 ?? null;
}

function effectiveStatus(p: { value: number; fees: number; status: string }): "In Range" | "Out of Range" | "Closed" {
  if (p.value === 0 && p.fees === 0) return "Closed";
  return p.status as "In Range" | "Out of Range";
}

// ── Component ────────────────────────────────────────────────────────────────
export default function Dashboard() {
  const { positions: allPositions, isLoading, isFetching, dataUpdatedAt, refetch } = usePositions();
  const { address } = useAccount();
  const { solanaAddress, suiAddress } = useWalletAuth();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const { watchedWallets, addWallet } = useWatchedWallets();
  const hasWallet = mounted && (!!(address || solanaAddress || suiAddress) || watchedWallets.length > 0);
  const connectedWalletCount = mounted
    ? [address, solanaAddress, suiAddress].filter(Boolean).length + watchedWallets.length
    : 0;

  // Watch wallet quick-add
  const [watchInput, setWatchInput] = useState("");
  const [watchChain, setWatchChain] = useState<WatchedWalletChain>("evm");
  const [watchError, setWatchError] = useState("");
  const [showWatchPanel, setShowWatchPanel] = useState(false);

  function validateAddress(addr: string, chain: WatchedWalletChain): string {
    if (!addr.trim()) return "Address is required";
    if (chain === "evm"    && !/^0x[0-9a-fA-F]{40}$/.test(addr)) return "Invalid EVM address (0x + 40 hex chars)";
    if (chain === "solana" && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr)) return "Invalid Solana address";
    if (chain === "sui"    && !/^0x[0-9a-fA-F]{63,64}$/.test(addr)) return "Invalid Sui address (0x + 64 hex chars)";
    if (chain === "aptos"  && !/^0x[0-9a-fA-F]{64}$/.test(addr)) return "Invalid Aptos address (0x + 64 hex chars)";
    return "";
  }
  function handleWatch() {
    const err = validateAddress(watchInput.trim(), watchChain);
    if (err) { setWatchError(err); return; }
    addWallet(watchInput.trim(), watchChain);
    setWatchInput(""); setWatchError("");
  }

  // Filters / sort / search
  const [chainFilter,  setChainFilter]  = useState("All");
  const [statusFilter, setStatusFilter] = useState("All");
  const [sortIndex,    setSortIndex]    = useState(0);
  const [searchQuery,  setSearchQuery]  = useState("");
  const [expandedPositionIds, setExpandedPositionIds] = useState<Set<string>>(new Set());
  const [activeTab, setActiveTab] = useState<"liquidity" | "tokens" | "lending">("liquidity");

  // "Updated X ago" ticker
  const [secondsAgo, setSecondsAgo] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    setSecondsAgo(dataUpdatedAt > 0 ? Math.floor((Date.now() - dataUpdatedAt) / 1000) : 0);
    if (dataUpdatedAt > 0) {
      intervalRef.current = setInterval(() => setSecondsAgo(Math.floor((Date.now() - dataUpdatedAt) / 1000)), 1000);
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [dataUpdatedAt]);

  function lastUpdatedLabel(): string {
    if (dataUpdatedAt === 0) return "";
    if (secondsAgo < 5)  return "just now";
    if (secondsAgo < 60) return `${secondsAgo}s ago`;
    return `${Math.floor(secondsAgo / 60)}m ago`;
  }

  // Filtered + sorted positions
  const filtered = useMemo(() => {
    let result = allPositions;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(p => p.pair.toLowerCase().includes(q) || p.protocol.toLowerCase().includes(q) || p.chain.toLowerCase().includes(q));
    }
    if (chainFilter  !== "All") result = result.filter(p => p.chain === chainFilter);
    if (statusFilter !== "All") result = result.filter(p => effectiveStatus(p) === statusFilter);
    const { key, dir } = SORT_OPTIONS[sortIndex];
    const STATUS_ORDER: Record<string, number> = { "In Range": 0, "Out of Range": 1, "Closed": 2 };
    return [...result].sort((a, b) => {
      const sd = (STATUS_ORDER[effectiveStatus(a)] ?? 1) - (STATUS_ORDER[effectiveStatus(b)] ?? 1);
      if (sd !== 0) return sd;
      const av = a[key as keyof typeof a] as number;
      const bv = b[key as keyof typeof b] as number;
      return dir === "desc" ? bv - av : av - bv;
    });
  }, [allPositions, chainFilter, statusFilter, sortIndex, searchQuery]);

  // Aggregate stats
  const totalValue    = allPositions.reduce((s, p) => s + p.value, 0);
  const totalFees     = allPositions.reduce((s, p) => s + p.fees, 0);
  const uniqueChains  = new Set(allPositions.map(p => p.chain)).size;

  // Cashflow estimates
  const { dailyCashflow, monthlyCashflow, yearlyCashflow, hasCashflowData } = useMemo(() => {
    const active = allPositions.filter(p => p.apy > 0 && p.value > 0);
    if (!active.length) return { dailyCashflow: 0, monthlyCashflow: 0, yearlyCashflow: 0, hasCashflowData: false };
    const yearly = active.reduce((s, p) => s + p.value * p.apy / 100, 0);
    return { dailyCashflow: yearly / 365, monthlyCashflow: yearly / 12, yearlyCashflow: yearly, hasCashflowData: true };
  }, [allPositions]);

  // Value-weighted average APR
  const avgApr = useMemo(() => {
    const active = allPositions.filter(p => p.value > 0 && p.apy > 0);
    if (!active.length) return null;
    const w = active.reduce((s, p) => s + p.value, 0);
    return w > 0 ? active.reduce((s, p) => s + p.apy * p.value, 0) / w : null;
  }, [allPositions]);

  // Protocol + chain breakdown for charts
  const protocolBreakdown = useMemo(() => {
    const m: Record<string, number> = {};
    for (const p of allPositions) { if (p.value > 0) m[p.protocol] = (m[p.protocol] ?? 0) + p.value; }
    return Object.entries(m).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  }, [allPositions]);

  const chainBreakdown = useMemo(() => {
    const m: Record<string, number> = {};
    for (const p of allPositions) { if (p.value > 0) m[p.chain] = (m[p.chain] ?? 0) + p.value; }
    return Object.entries(m).map(([chain, value]) => ({ chain, value })).sort((a, b) => b.value - a.value);
  }, [allPositions]);

  // IL
  const { totalILUSD, totalILHodlValue } = useMemo(() => {
    let sumIL = 0, sumHodl = 0;
    for (const pos of allPositions) {
      if (pos.status === "Closed") continue;
      if (!pos.liquidity || !pos.price0 || !pos.price1 || pos.tickLower == null || pos.tickUpper == null) continue;
      const L = Number(pos.liquidity);
      if (L === 0) continue;
      const d0 = pos.token0Decimals ?? 18, d1 = pos.token1Decimals ?? 18;
      const entryTick = Math.floor((pos.tickLower + pos.tickUpper) / 2);
      const sqrtPe    = Math.sqrt(Math.pow(1.0001, entryTick));
      const sqrtLow   = Math.sqrt(Math.pow(1.0001, pos.tickLower));
      const sqrtHigh  = Math.sqrt(Math.pow(1.0001, pos.tickUpper));
      if (!isFinite(sqrtPe) || sqrtPe === 0 || !isFinite(sqrtLow) || !isFinite(sqrtHigh)) continue;
      const a0 = Math.max(0, L * (1 / sqrtPe - 1 / sqrtHigh)) / Math.pow(10, d0);
      const a1 = Math.max(0, L * (sqrtPe - sqrtLow)) / Math.pow(10, d1);
      const hodlVal = a0 * pos.price0 + a1 * pos.price1;
      if (hodlVal <= 0) continue;
      sumIL   += pos.value - hodlVal;
      sumHodl += hodlVal;
    }
    return { totalILUSD: sumIL, totalILHodlValue: sumHodl };
  }, [allPositions]);

  // Portfolio history chart
  const [rangeKey, setRangeKey] = useState<typeof TIME_RANGES[number]["key"]>("30D");
  const portfolioHistory = usePortfolioHistory(totalValue, allPositions.length, dataUpdatedAt);
  const activeRange   = TIME_RANGES.find(r => r.key === rangeKey) ?? TIME_RANGES[2];
  const rangeCutoff   = Date.now() - activeRange.ms;
  const rangedHistory = portfolioHistory.filter(s => s.timestamp >= rangeCutoff);
  const effectiveHistory = rangedHistory.length >= 2 ? rangedHistory : portfolioHistory;
  const effectiveFirst   = effectiveHistory[0];
  const pnlDollar = effectiveFirst ? totalValue - effectiveFirst.totalValue : 0;
  const pnlPct    = effectiveFirst && effectiveFirst.totalValue > 0 ? (pnlDollar / effectiveFirst.totalValue) * 100 : 0;
  const pnlLabel  = (() => {
    if (!effectiveFirst) return activeRange.label;
    const coverage = Date.now() - effectiveFirst.timestamp;
    if (coverage < activeRange.ms * 0.5)
      return `since ${new Date(effectiveFirst.timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
    return activeRange.label;
  })();
  const chartData = effectiveHistory.map(s => ({ label: activeRange.xFmt(new Date(s.timestamp)), value: s.totalValue }));

  // Formatting helpers
  const fmt$ = (n: number, dec = 2) => `$${n.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec })}`;
  const trunc = (addr: string) => addr.slice(0, 6) + "…" + addr.slice(-4);
  const togglePosition = (id: string) => setExpandedPositionIds(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="bg-[#0a0a0a] text-white min-h-screen">
      <Navbar />

      {/* Price Ticker — pinned below fixed nav */}
      <div className="pt-16">
        <PriceTicker />
      </div>

      <div className="max-w-[1200px] mx-auto px-4 py-6">

        {/* ── Page Header ─────────────────────────────────────────────────── */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
          <div>
            <h1 className="text-3xl font-bold text-white">My Portfolio</h1>
            {mounted && dataUpdatedAt > 0 && (
              <p className="text-sm text-gray-400 mt-0.5">Updated {lastUpdatedLabel()}</p>
            )}
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => refetch()}
              disabled={isFetching}
              title="Refresh positions"
              className="flex items-center gap-2 bg-[#1a1a2e] hover:bg-[#252535] border border-[#252535] disabled:opacity-50 text-gray-300 px-4 py-2 rounded-lg text-sm transition-colors"
            >
              <svg className={`w-4 h-4 ${isFetching ? "animate-spin" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              {isFetching ? "Refreshing…" : "Refresh"}
            </button>
            <Link
              href="/wallet"
              className="flex items-center gap-2 bg-[#fbbf24]/10 hover:bg-[#fbbf24]/20 border border-[#fbbf24]/30 text-[#fbbf24] px-4 py-2 rounded-lg text-sm font-medium transition-colors"
            >
              Manage Wallets
            </Link>
          </div>
        </div>

        {/* ── Row 1: Wallets · Total Value · Net Cashflow ──────────────────── */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">

          {/* Wallets */}
          <div className="bg-[#151520] border border-[#252535] rounded-xl p-5">
            <h3 className="text-[#fbbf24] font-semibold text-xs uppercase tracking-widest mb-3">Wallets</h3>
            {mounted && (address || solanaAddress || suiAddress) ? (
              <div className="space-y-2">
                {address && (
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-gray-500 w-14">EVM</span>
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-mono text-emerald-400">{trunc(address)}</span>
                      <button onClick={() => navigator.clipboard.writeText(address)} title="Copy" className="text-gray-600 hover:text-gray-300 text-xs">⎘</button>
                    </div>
                  </div>
                )}
                {solanaAddress && (
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-gray-500 w-14">Solana</span>
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-mono text-purple-400">{trunc(solanaAddress)}</span>
                      <button onClick={() => navigator.clipboard.writeText(solanaAddress)} title="Copy" className="text-gray-600 hover:text-gray-300 text-xs">⎘</button>
                    </div>
                  </div>
                )}
                {suiAddress && (
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-gray-500 w-14">Sui</span>
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-mono text-cyan-400">{trunc(suiAddress)}</span>
                      <button onClick={() => navigator.clipboard.writeText(suiAddress)} title="Copy" className="text-gray-600 hover:text-gray-300 text-xs">⎘</button>
                    </div>
                  </div>
                )}
                {watchedWallets.length > 0 && (
                  <div className="pt-1.5 border-t border-[#252535]">
                    <Link href="/watched" className="text-xs text-gray-500 hover:text-gray-300 transition-colors">
                      +{watchedWallets.length} watched wallet{watchedWallets.length !== 1 ? "s" : ""}
                    </Link>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-gray-500 text-sm">No wallets connected</p>
            )}
          </div>

          {/* Total Value */}
          <div className="bg-[#151520] border border-[#252535] rounded-xl p-5">
            <h3 className="text-[#fbbf24] font-semibold text-xs uppercase tracking-widest mb-3">Total Value</h3>
            <p className="text-3xl font-bold text-white">{fmt$(totalValue)}</p>
            {uniqueChains > 0 && (
              <p className="text-xs text-gray-500 mt-1">Across {uniqueChains} chain{uniqueChains !== 1 ? "s" : ""}</p>
            )}
          </div>

          {/* Estimated Net Cashflow */}
          <div className="bg-[#151520] border border-[#252535] rounded-xl p-5">
            <h3 className="text-[#fbbf24] font-semibold text-xs uppercase tracking-widest mb-3">Estimated Net Cashflow</h3>
            {hasCashflowData ? (
              <div className="space-y-2">
                <div className="flex justify-between"><span className="text-sm text-gray-400">Daily</span>  <span className="text-sm font-semibold text-[#22c55e]">+{fmt$(dailyCashflow)}</span></div>
                <div className="flex justify-between"><span className="text-sm text-gray-400">Monthly</span><span className="text-sm font-semibold text-[#22c55e]">+{fmt$(monthlyCashflow)}</span></div>
                <div className="flex justify-between"><span className="text-sm text-gray-400">Yearly</span> <span className="text-sm font-semibold text-[#22c55e]">+{fmt$(yearlyCashflow)}</span></div>
              </div>
            ) : (
              <p className="text-gray-500 text-sm">N/A — no APY data available</p>
            )}
          </div>
        </div>

        {/* ── Row 2: Tokens · Lending · Liquidity Positions ────────────────── */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">

          {/* Tokens — placeholder */}
          <div className="bg-[#151520] border border-[#252535] rounded-xl p-5">
            <h3 className="text-[#fbbf24] font-semibold text-xs uppercase tracking-widest mb-3">Tokens</h3>
            <p className="text-3xl font-bold text-white">$0.00</p>
            <p className="text-xs text-gray-500 mt-1">Coming soon</p>
          </div>

          {/* Lending / Borrowing — placeholder */}
          <div className="bg-[#151520] border border-[#252535] rounded-xl p-5">
            <h3 className="text-[#fbbf24] font-semibold text-xs uppercase tracking-widest mb-3">Lending / Borrowing</h3>
            <p className="text-3xl font-bold text-white">$0.00</p>
            <p className="text-xs text-gray-500 mt-1">Coming soon</p>
          </div>

          {/* Liquidity Positions */}
          <div className="bg-[#151520] border border-[#252535] rounded-xl p-5">
            <h3 className="text-[#fbbf24] font-semibold text-xs uppercase tracking-widest mb-3">Liquidity Positions</h3>
            <p className="text-3xl font-bold text-white">{fmt$(totalValue)}</p>
            {totalFees > 0 && (
              <p className="text-sm text-[#22c55e] mt-1">+{fmt$(totalFees)} Ready to collect</p>
            )}
            <p className="text-xs text-gray-500 mt-1">{allPositions.length} position{allPositions.length !== 1 ? "s" : ""}</p>
          </div>
        </div>

        {/* ── Charts Row ───────────────────────────────────────────────────── */}
        {allPositions.some(p => p.value > 0) && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">

            {/* Portfolio Allocation Donut */}
            <div className="bg-[#151520] border border-[#252535] rounded-xl p-5">
              <h3 className="text-[#fbbf24] font-semibold text-xs uppercase tracking-widest mb-4">Portfolio Allocation</h3>
              <div className="flex items-center gap-4">
                <div className="shrink-0">
                  <ResponsiveContainer width={130} height={130}>
                    <PieChart>
                      <Pie data={protocolBreakdown} cx="50%" cy="50%" innerRadius={38} outerRadius={62} dataKey="value" strokeWidth={0}>
                        {protocolBreakdown.map((entry) => (
                          <Cell key={entry.name} fill={getProtocolColor(entry.name)} />
                        ))}
                      </Pie>
                      <Tooltip
                        contentStyle={{ backgroundColor: "#151520", border: "1px solid #252535", borderRadius: "8px", color: "#fff", fontSize: "12px" }}
                        formatter={(v: number | undefined) => [fmt$(v ?? 0), ""]}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="flex-1 space-y-1.5 overflow-hidden">
                  {protocolBreakdown.map((entry) => (
                    <div key={entry.name} className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: getProtocolColor(entry.name) }} />
                        <span className="text-xs text-gray-400 truncate">{entry.name}</span>
                      </div>
                      <div className="text-xs text-right shrink-0">
                        <span className="text-white font-medium">{fmt$(entry.value, 0)}</span>
                        <span className="text-gray-500 ml-1">
                          ({totalValue > 0 ? ((entry.value / totalValue) * 100).toFixed(1) : "0"}%)
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Chain Distribution */}
            <div className="bg-[#151520] border border-[#252535] rounded-xl p-5">
              <h3 className="text-[#fbbf24] font-semibold text-xs uppercase tracking-widest mb-4">Chain Distribution</h3>
              <div className="space-y-3">
                {chainBreakdown.map((entry) => {
                  const pct = totalValue > 0 ? (entry.value / totalValue) * 100 : 0;
                  return (
                    <div key={entry.chain}>
                      <div className="flex justify-between items-center mb-1">
                        <div className="flex items-center gap-2">
                          <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: getChainColor(entry.chain) }} />
                          <span className="text-xs text-gray-300">{entry.chain}</span>
                        </div>
                        <div className="text-xs text-right">
                          <span className="text-white">{fmt$(entry.value, 0)}</span>
                          <span className="text-gray-500 ml-1">({pct.toFixed(1)}%)</span>
                        </div>
                      </div>
                      <div className="h-1.5 bg-[#252535] rounded-full overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: getChainColor(entry.chain) }} />
                      </div>
                    </div>
                  );
                })}
                {chainBreakdown.length === 0 && <p className="text-gray-500 text-sm">No chain data</p>}
              </div>
            </div>
          </div>
        )}

        {/* ── Portfolio History Chart ──────────────────────────────────────── */}
        {hasWallet && mounted && (
          <div className="bg-[#151520] border border-[#252535] rounded-xl p-5 mb-6">
            <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
              <div className="flex items-center gap-3 flex-wrap">
                <h3 className="text-[#fbbf24] font-semibold text-xs uppercase tracking-widest">Portfolio History</h3>
                <div className="flex gap-1">
                  {TIME_RANGES.map((r) => {
                    const hasData = portfolioHistory.filter(s => s.timestamp >= Date.now() - r.ms).length >= 2;
                    return (
                      <button
                        key={r.key}
                        onClick={() => setRangeKey(r.key)}
                        className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                          rangeKey === r.key
                            ? "bg-[#22c55e] text-white"
                            : hasData
                            ? "bg-[#252535] text-gray-400 hover:text-gray-200"
                            : "bg-[#252535] text-gray-600"
                        }`}
                      >{r.key}</button>
                    );
                  })}
                </div>
              </div>
              {effectiveHistory.length >= 2 && (
                <div className={`text-sm font-medium ${pnlDollar >= 0 ? "text-[#22c55e]" : "text-[#ef4444]"}`}>
                  {pnlDollar >= 0 ? "+" : ""}{fmt$(Math.abs(pnlDollar))}{" "}
                  <span className="opacity-75">({pnlDollar >= 0 ? "+" : ""}{pnlPct.toFixed(2)}%)</span>
                  <span className="text-gray-500 font-normal ml-1">{pnlLabel}</span>
                </div>
              )}
            </div>
            {portfolioHistory.length < 2 ? (
              <div className="text-center py-8">
                <p className="text-sm text-gray-500">Tracking started — chart appears after the next refresh.</p>
                <p className="text-xs text-gray-600 mt-1">A data point is saved on every 60-second refresh.</p>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={chartData} margin={{ top: 4, right: 16, left: 8, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#252535" />
                  <XAxis dataKey="label" tick={{ fill: "#6b7280", fontSize: 11 }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                  <YAxis tick={{ fill: "#6b7280", fontSize: 11 }} axisLine={false} tickLine={false}
                    tickFormatter={v => `$${Number(v).toLocaleString("en-US", { maximumFractionDigits: 0 })}`} width={72} />
                  <Tooltip
                    contentStyle={{ backgroundColor: "#151520", border: "1px solid #252535", borderRadius: "8px", color: "#fff" }}
                    formatter={(v: number | undefined) => [fmt$(v ?? 0), "Portfolio Value"]}
                    labelStyle={{ color: "#9ca3af", marginBottom: 4 }}
                  />
                  <Line type="monotone" dataKey="value" stroke="#22c55e" strokeWidth={2} dot={chartData.length <= 20} activeDot={{ r: 4, fill: "#22c55e" }} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        )}

        {/* ── Tab Navigation ──────────────────────────────────────────────── */}
        <div className="flex flex-wrap items-center gap-2 mb-4">
          {(["liquidity", "tokens", "lending"] as const).map((tab) => {
            const labels: Record<string, string> = {
              liquidity: `Liquidity Positions (${allPositions.length})`,
              tokens:    "Tokens (0)",
              lending:   "Lending / Borrowing (0)",
            };
            return (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`px-5 py-2 rounded-lg text-sm font-medium transition-colors ${
                  activeTab === tab
                    ? "bg-[#22c55e] text-white"
                    : "bg-[#151520] border border-[#252535] text-gray-400 hover:text-gray-200"
                }`}
              >{labels[tab]}</button>
            );
          })}

          {/* Action buttons */}
          <div className="ml-auto flex gap-2">
            <button
              onClick={() => setShowWatchPanel(v => !v)}
              title="Watch a wallet"
              className="bg-[#151520] border border-[#252535] hover:bg-[#1f1f30] text-gray-400 px-3 py-2 rounded-lg text-sm transition-colors"
            >👁 Watch</button>
            <button
              onClick={() => {
                const rows = filtered.map(p => `${p.pair},${p.protocol},${p.chain},${p.value},${p.apy}%,${p.fees},${p.status}`).join("\n");
                const blob = new Blob(["Pair,Protocol,Chain,Value,APY,Fees,Status\n" + rows], { type: "text/csv" });
                const url  = URL.createObjectURL(blob);
                const a    = document.createElement("a");
                a.href = url; a.download = "defidesh-positions.csv"; a.click();
                URL.revokeObjectURL(url);
              }}
              className="bg-[#151520] border border-[#252535] hover:bg-[#1f1f30] text-gray-400 px-3 py-2 rounded-lg text-sm transition-colors"
            >Export CSV</button>
          </div>
        </div>

        {/* Watch Wallet Panel */}
        {showWatchPanel && mounted && (
          <div className="bg-[#151520] border border-[#252535] rounded-xl p-4 mb-4">
            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2">
              <span className="text-gray-400 text-sm shrink-0">Watch wallet:</span>
              <input
                type="text"
                value={watchInput}
                onChange={e => { setWatchInput(e.target.value); setWatchError(""); }}
                onKeyDown={e => e.key === "Enter" && handleWatch()}
                placeholder="Paste wallet address"
                className="flex-1 min-w-0 bg-[#0a0a0a] border border-[#252535] text-white rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-[#fbbf24]"
              />
              <select
                value={watchChain}
                onChange={e => { setWatchChain(e.target.value as WatchedWalletChain); setWatchError(""); }}
                className="bg-[#0a0a0a] border border-[#252535] text-white rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-[#fbbf24] shrink-0"
              >
                <option value="evm">EVM</option>
                <option value="solana">Solana</option>
                <option value="sui">Sui</option>
                <option value="aptos">Aptos</option>
              </select>
              <button onClick={handleWatch} className="bg-[#fbbf24]/10 hover:bg-[#fbbf24]/20 border border-[#fbbf24]/30 text-[#fbbf24] px-3 py-1.5 rounded-lg text-sm shrink-0">Add</button>
              {watchedWallets.length > 0 && (
                <Link href="/watched" className="text-gray-400 hover:text-gray-200 text-sm shrink-0 transition-colors">
                  Manage ({watchedWallets.length})
                </Link>
              )}
            </div>
            {watchError && <p className="text-[#ef4444] text-xs mt-1">{watchError}</p>}
          </div>
        )}

        {/* ── Liquidity Positions Tab Content ─────────────────────────────── */}
        {activeTab === "liquidity" && (
          <>
            {/* Summary Stats Row */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
              <div className="bg-[#151520] border border-[#252535] rounded-xl p-4">
                <p className="text-xs text-gray-500 mb-1">Total Value</p>
                <p className="text-lg font-bold text-white">{fmt$(totalValue)}</p>
              </div>
              <div className="bg-[#151520] border border-[#252535] rounded-xl p-4">
                <p className="text-xs text-gray-500 mb-1">Uncollected Fees</p>
                <p className="text-lg font-bold text-[#22c55e]">{fmt$(totalFees)}</p>
              </div>
              <div className="bg-[#151520] border border-[#252535] rounded-xl p-4">
                <p className="text-xs text-gray-500 mb-1">Estimated APR</p>
                {avgApr !== null
                  ? <p className="text-lg font-bold text-[#22c55e]">+{avgApr.toFixed(2)}%</p>
                  : <p className="text-lg font-bold text-gray-500">N/A</p>}
              </div>
              <div className="bg-[#151520] border border-[#252535] rounded-xl p-4">
                <p className="text-xs text-gray-500 mb-1">Est. Cashflow</p>
                {hasCashflowData ? (
                  <div className="space-y-0.5">
                    <p className="text-xs text-[#22c55e]">D: +{fmt$(dailyCashflow)}</p>
                    <p className="text-xs text-[#22c55e]">M: +{fmt$(monthlyCashflow)}</p>
                    <p className="text-xs text-[#22c55e]">Y: +{fmt$(yearlyCashflow)}</p>
                  </div>
                ) : <p className="text-lg font-bold text-gray-500">N/A</p>}
              </div>
            </div>

            {/* Filters Row */}
            <div className="flex flex-wrap gap-3 mb-4 items-center">
              <input
                type="text"
                placeholder="Search pairs, protocols, chains…"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="bg-[#151520] border border-[#252535] text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#fbbf24] w-56"
              />
              <select value={chainFilter}  onChange={e => setChainFilter(e.target.value)}      className="bg-[#151520] border border-[#252535] text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#fbbf24]">
                {CHAIN_FILTERS.map(c  => <option key={c}  value={c}>{c}</option>)}
              </select>
              <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}     className="bg-[#151520] border border-[#252535] text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#fbbf24]">
                {STATUS_FILTERS.map(s => <option key={s}  value={s}>{s}</option>)}
              </select>
              <select value={sortIndex}    onChange={e => setSortIndex(Number(e.target.value))} className="bg-[#151520] border border-[#252535] text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#fbbf24]">
                {SORT_OPTIONS.map((opt, i) => <option key={i} value={i}>{opt.label}</option>)}
              </select>
              <span className="text-gray-600 text-xs ml-auto">{filtered.length} of {allPositions.length}</span>
            </div>

            {/* Loading */}
            {mounted && isLoading && (
              <div className="flex flex-col items-center justify-center py-16 text-gray-400">
                <div className="w-8 h-8 border-2 border-[#22c55e] border-t-transparent rounded-full animate-spin mb-4" />
                <p>Fetching your positions…</p>
              </div>
            )}

            {/* Empty states */}
            {!isLoading && filtered.length === 0 && mounted && (
              <div>
                {!hasWallet ? (
                  <div className="flex flex-col items-center justify-center py-20 text-center">
                    <div className="text-5xl mb-6">💼</div>
                    <h3 className="text-xl font-semibold text-white mb-2">No wallet connected</h3>
                    <p className="text-gray-400 mb-8 max-w-sm">Connect your wallet to track your LP positions across EVM chains, Solana, and Sui.</p>
                    <div className="flex flex-wrap justify-center gap-3 text-sm text-gray-400">
                      <div className="bg-[#151520] border border-[#252535] rounded-lg px-4 py-3 flex items-center gap-2">
                        <span className="text-blue-400 font-medium">EVM</span>
                        <span>Ethereum · Base · Arbitrum · Optimism</span>
                      </div>
                      <div className="bg-[#151520] border border-[#252535] rounded-lg px-4 py-3 flex items-center gap-2">
                        <span className="text-purple-400 font-medium">Solana</span>
                        <span>Raydium · Orca</span>
                      </div>
                      <div className="bg-[#151520] border border-[#252535] rounded-lg px-4 py-3 flex items-center gap-2">
                        <span className="text-cyan-400 font-medium">Sui</span>
                        <span>Bluefin · Cetus</span>
                      </div>
                    </div>
                  </div>
                ) : allPositions.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-20 text-center">
                    <div className="text-5xl mb-6">📭</div>
                    <h3 className="text-xl font-semibold text-white mb-2">No positions found</h3>
                    <p className="text-gray-400 max-w-sm">No LP positions were found for your connected wallet(s).</p>
                  </div>
                ) : (
                  <div className="text-center py-12 text-gray-500">No positions match your filters.</div>
                )}
              </div>
            )}

            {/* Position Cards */}
            {!isLoading && filtered.map((pos) => {
              const posStatus  = effectiveStatus(pos);
              const isClosed   = posStatus === "Closed";
              const isExpanded = expandedPositionIds.has(pos.id);
              const d0  = pos.token0Decimals ?? 18;
              const d1  = pos.token1Decimals ?? 6;
              const t0  = pos.token0Symbol ?? "Token0";
              const t1  = pos.token1Symbol ?? "Token1";
              const hasRange   = pos.tickLower != null && pos.tickUpper != null;
              const hasAmounts = pos.amount0 != null || pos.amount1 != null;
              const hasFees    = pos.fees0 != null || pos.fees1 != null;
              const manageUrl  = getManageUrl(pos.protocol);

              // Price range calculations
              let minPriceStr = "—", maxPriceStr = "—", currentPriceStr = "—";
              let rangeBarPct = 50;
              if (hasRange) {
                minPriceStr = formatTickPrice(pos.tickLower!, d0, d1, t0, t1);
                maxPriceStr = formatTickPrice(pos.tickUpper!, d0, d1, t0, t1);
                const curPrice = getCurrentPriceForRange(pos);
                if (curPrice !== null) {
                  currentPriceStr = curPrice < 0.01
                    ? curPrice.toExponential(2)
                    : curPrice < 1000
                    ? `$${curPrice.toFixed(curPrice < 1 ? 4 : 2)}`
                    : `$${curPrice.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
                  const minP = getTickPriceUSD(pos.tickLower!, pos);
                  const maxP = getTickPriceUSD(pos.tickUpper!, pos);
                  if (minP !== null && maxP !== null && maxP > minP) {
                    rangeBarPct = Math.max(2, Math.min(98, ((curPrice - minP) / (maxP - minP)) * 100));
                  }
                }
              }
              const rangeWidthPct = hasRange
                ? (() => { const mn = getTickPriceUSD(pos.tickLower!, pos); const mx = getTickPriceUSD(pos.tickUpper!, pos); return mn && mx && mn > 0 ? ((mx - mn) / mn * 100).toFixed(2) : null; })()
                : null;

              return (
                <div key={pos.id} className={`bg-[#151520] border border-[#252535] rounded-xl mb-3 transition-all ${isClosed ? "opacity-50" : ""}`}>

                  {/* Collapsed header */}
                  <button className="w-full text-left p-5" onClick={() => togglePosition(pos.id)}>
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap mb-1">
                          <h3 className="text-base font-bold text-white">{pos.pair}</h3>
                          <span className="bg-[#252535] text-gray-300 text-xs px-2 py-0.5 rounded">{pos.protocol}</span>
                          {pos.feeTier != null && (
                            <span className="bg-[#252535] text-gray-400 text-xs px-2 py-0.5 rounded">{pos.feeTier}% Fee</span>
                          )}
                          <span className={`text-xs px-2 py-0.5 rounded-full border ${
                            posStatus === "In Range"
                              ? "bg-emerald-950/60 text-emerald-400 border-emerald-400/30"
                              : posStatus === "Closed"
                              ? "bg-gray-800/60 text-gray-400 border-gray-600/30"
                              : "bg-orange-950/60 text-orange-400 border-orange-400/30"
                          }`}>{posStatus}</span>
                        </div>
                        <p className="text-xs text-gray-500">
                          {pos.chain}
                          {connectedWalletCount >= 2 && pos.walletAddress && (
                            <span className="ml-1 font-mono">· …{pos.walletAddress.slice(-4)}</span>
                          )}
                        </p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-base font-bold text-white">{fmt$(pos.value)}</p>
                        {pos.fees > 0 && <p className="text-xs text-[#22c55e]">+{fmt$(pos.fees)} fees</p>}
                      </div>
                      <svg className={`w-4 h-4 text-gray-500 transition-transform shrink-0 ${isExpanded ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    </div>
                  </button>

                  {/* Expanded detail */}
                  {isExpanded && (
                    <div className="px-5 pb-5 border-t border-[#252535] pt-4 space-y-5">

                      {/* ◎ Current Liquidity */}
                      {hasAmounts && (
                        <div>
                          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">◎ Current Liquidity</p>
                          <div className="grid grid-cols-2 gap-3">
                            {[
                              { sym: t0, amount: pos.amount0, price: pos.price0 },
                              { sym: t1, amount: pos.amount1, price: pos.price1 },
                            ].map(({ sym, amount, price }) => (
                              <div key={sym} className="bg-[#0a0a0a] border border-[#252535] rounded-lg p-3">
                                <p className="text-xs text-gray-500 mb-1">{sym}</p>
                                <p className="text-lg font-bold text-white">
                                  {amount != null ? amount.toLocaleString("en-US", { maximumFractionDigits: 6 }) : "—"}
                                </p>
                                {amount != null && price && (
                                  <p className="text-xs text-gray-500">{fmt$(amount * price)}</p>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* $ Uncollected Fees */}
                      {hasFees && ((pos.fees0 ?? 0) + (pos.fees1 ?? 0)) > 0 && (
                        <div>
                          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">$ Uncollected Fees</p>
                          <div className="grid grid-cols-2 gap-3">
                            {[
                              { sym: t0, fee: pos.fees0, price: pos.price0 },
                              { sym: t1, fee: pos.fees1, price: pos.price1 },
                            ].map(({ sym, fee, price }) => (
                              <div key={sym} className="bg-[#0a0a0a] border border-[#252535] rounded-lg p-3">
                                <p className="text-xs text-gray-500 mb-1">{sym}</p>
                                <p className="text-lg font-bold text-white">
                                  {fee != null ? fee.toLocaleString("en-US", { maximumFractionDigits: 6 }) : "—"}
                                </p>
                                {fee != null && price && (
                                  <p className="text-xs text-gray-500">{fmt$(fee * price)}</p>
                                )}
                              </div>
                            ))}
                          </div>
                          {pos.fees > 0 && (
                            <div className="flex justify-end mt-2">
                              <span className="text-sm font-semibold text-[#22c55e]">{fmt$(pos.fees)} ready to collect</span>
                            </div>
                          )}
                        </div>
                      )}

                      {/* ◉ Concentrated Liquidity Range */}
                      {hasRange && (
                        <div>
                          <div className="flex items-center justify-between mb-2">
                            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">◉ Concentrated Liquidity Range</p>
                            <span className={`text-xs px-2 py-0.5 rounded-full ${
                              isClosed       ? "text-gray-400"
                              : posStatus === "In Range" ? "text-emerald-400"
                              : "text-orange-400"
                            }`}>
                              {isClosed ? "Position Closed" : posStatus === "In Range" ? "Position Active" : "Out of Range"}
                            </span>
                          </div>
                          <div className="bg-[#0a0a0a] border border-[#252535] rounded-lg p-4">
                            <div className="flex justify-between text-xs mb-3 gap-2">
                              <div className="text-gray-500"><span className="text-gray-600">Min</span><br />{minPriceStr}</div>
                              <div className={`text-center font-semibold ${isClosed ? "text-gray-400" : posStatus === "In Range" ? "text-[#22c55e]" : "text-orange-400"}`}>
                                <span className="text-gray-600 font-normal">Current</span><br />{currentPriceStr}
                              </div>
                              <div className="text-gray-500 text-right"><span className="text-gray-600">Max</span><br />{maxPriceStr}</div>
                            </div>
                            <div className="relative h-2 bg-[#252535] rounded-full">
                              <div
                                className="absolute inset-0 rounded-full"
                                style={{
                                  background: isClosed
                                    ? "#374151"
                                    : posStatus === "In Range"
                                    ? "linear-gradient(90deg, #16a34a40, #22c55e, #16a34a40)"
                                    : "linear-gradient(90deg, #f59e0b40, #f59e0b, #f59e0b40)",
                                }}
                              />
                              {!isClosed && currentPriceStr !== "—" && (
                                <div
                                  className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full border-2 border-white z-10"
                                  style={{
                                    left: `calc(${rangeBarPct}% - 6px)`,
                                    backgroundColor: posStatus === "In Range" ? "#22c55e" : "#f59e0b",
                                  }}
                                />
                              )}
                            </div>
                            {rangeWidthPct != null && (
                              <div className="flex justify-end mt-1.5">
                                <span className="text-xs text-gray-500">Range Width: {rangeWidthPct}%</span>
                              </div>
                            )}
                          </div>
                        </div>
                      )}

                      {/* ↗ Yield & APR Projections */}
                      {pos.apy > 0 && (
                        <div>
                          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">↗ Yield & APR Projections</p>
                          <div className="grid grid-cols-4 gap-2">
                            {([ ["Daily", 365], ["Weekly", 52], ["Monthly", 12], ["Yearly", 1] ] as [string, number][]).map(([label, div]) => (
                              <div key={label} className="bg-[#0a0a0a] border border-[#252535] rounded-lg p-3 text-center">
                                <p className="text-xs text-gray-500 mb-1">{label}</p>
                                <p className="text-sm font-bold text-[#22c55e]">+{(pos.apy / div).toFixed(div >= 52 ? 2 : 1)}%</p>
                                <p className="text-xs text-gray-400">{fmt$(pos.value * pos.apy / 100 / div)}</p>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* ◈ Pool Statistics */}
                      <div>
                        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">◈ Pool Statistics</p>
                        <div className="grid grid-cols-3 gap-2">
                          {["Pool TVL", "24h Volume", "24h Fees"].map(label => (
                            <div key={label} className="bg-[#0a0a0a] border border-[#252535] rounded-lg p-3 text-center">
                              <p className="text-xs text-gray-500 mb-1">{label}</p>
                              <p className="text-sm text-gray-600">N/A</p>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Footer actions */}
                      <div className="flex items-center justify-between pt-1">
                        <Link
                          href={`/dashboard/${pos.id}`}
                          onClick={e => e.stopPropagation()}
                          className="text-sm text-gray-400 hover:text-gray-200 transition-colors"
                        >
                          View Details →
                        </Link>
                        {manageUrl && (
                          <a
                            href={manageUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={e => e.stopPropagation()}
                            className="bg-[#fbbf24]/10 hover:bg-[#fbbf24]/20 border border-[#fbbf24]/30 text-[#fbbf24] px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                          >
                            Manage Position ↗
                          </a>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            {/* Closed position note */}
            {mounted && (solanaAddress || suiAddress) && (
              <div className="mt-4 text-sm text-gray-500 border border-[#252535] rounded-lg px-4 py-3 flex items-start gap-2">
                <span className="mt-0.5 shrink-0">ℹ️</span>
                <span>
                  Some closed positions may not appear: on Solana, NFTs are burned when a position is fully closed; on Sui, position objects are destroyed. These no longer exist on-chain and cannot be recovered.
                </span>
              </div>
            )}
          </>
        )}

        {/* Tokens Tab */}
        {activeTab === "tokens" && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="text-5xl mb-4">🪙</div>
            <h3 className="text-xl font-semibold text-white mb-2">Token Holdings</h3>
            <p className="text-gray-400">Coming soon — token portfolio tracking is not yet available.</p>
          </div>
        )}

        {/* Lending Tab */}
        {activeTab === "lending" && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="text-5xl mb-4">🏦</div>
            <h3 className="text-xl font-semibold text-white mb-2">Lending &amp; Borrowing</h3>
            <p className="text-gray-400">Coming soon — lending position tracking is not yet available.</p>
          </div>
        )}

      </div>
    </div>
  );
}
