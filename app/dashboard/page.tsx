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

// ── Time range config ─────────────────────────────────────────────────────────
const TIME_RANGES = [
  { key: "1D",  ms: 1   * 24 * 3_600_000, label: "in last 24h",     xFmt: (d: Date) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) },
  { key: "7D",  ms: 7   * 24 * 3_600_000, label: "in last 7 days",  xFmt: (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) },
  { key: "30D", ms: 30  * 24 * 3_600_000, label: "in last 30 days", xFmt: (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) },
  { key: "90D", ms: 90  * 24 * 3_600_000, label: "in last 90 days", xFmt: (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) },
  { key: "1Y",  ms: 365 * 24 * 3_600_000, label: "in last year",    xFmt: (d: Date) => d.toLocaleDateString("en-US", { month: "short", year: "2-digit" }) },
] as const;

const STATUS_FILTERS = ["All", "In Range", "Out of Range", "Closed"];

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

const STABLES_SET = new Set(["USDC", "USDT", "DAI", "USDbC", "USDC.e", "USDS"]);

// ── Helpers ───────────────────────────────────────────────────────────────────
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
  if (protocol.includes("Aerodrome"))  return "https://aerodrome.finance/positions";
  if (protocol.includes("Velodrome"))  return "https://velodrome.finance/positions";
  if (protocol.includes("Uniswap"))    return "https://app.uniswap.org/pools";
  if (protocol.includes("Orca"))       return "https://v2.orca.so/";
  if (protocol.includes("Raydium"))    return "https://raydium.io/portfolio/";
  if (protocol.includes("Bluefin"))    return "https://trade.bluefin.io/liquidity";
  if (protocol.includes("Cetus"))      return "https://app.cetus.zone/liquidity";
  if (protocol.includes("Momentum"))   return "https://app.mmt.finance";
  if (protocol.includes("HyperSwap"))  return "https://app.hyperswap.exchange/#/pool";
  if (protocol.includes("KittenSwap")) return "https://www.kittenswap.org";
  if (protocol.includes("ProjectX") || protocol.includes("PRJX")) return "https://prjx.com";
  if (protocol.includes("PancakeSwap")) return "https://pancakeswap.finance/liquidity";
  return "";
}

function effectiveStatus(p: { value: number; fees: number; status: string }): "In Range" | "Out of Range" | "Closed" {
  if (p.value === 0 && p.fees === 0) return "Closed";
  return p.status as "In Range" | "Out of Range";
}

function getTickPriceUSD(tick: number, pos: AerodromePosition): number | null {
  const d0 = pos.token0Decimals ?? 18;
  const d1 = pos.token1Decimals ?? 6;
  try {
    const raw = Math.pow(1.0001, tick) * Math.pow(10, d0 - d1);
    if (!isFinite(raw) || raw <= 0) return null;
    if (STABLES_SET.has(pos.token1Symbol ?? "")) return raw;
    if (STABLES_SET.has(pos.token0Symbol ?? "")) {
      const inv = 1 / raw;
      return isFinite(inv) && inv > 0 ? inv : null;
    }
    if (pos.price1 && pos.price1 > 0) return raw * pos.price1;
    return raw;
  } catch { return null; }
}

function chainGradient(chain: string): string {
  const map: Record<string, string> = {
    Base:        "linear-gradient(135deg, #059669, #10b981)",
    Ethereum:    "linear-gradient(135deg, #0d9488, #14b8a6)",
    Solana:      "linear-gradient(135deg, #065f46, #047857)",
    Sui:         "linear-gradient(135deg, #0d9488, #2dd4bf)",
    Arbitrum:    "linear-gradient(135deg, #0891b2, #06b6d4)",
    Optimism:    "linear-gradient(135deg, #dc2626, #b91c1c)",
    Polygon:     "linear-gradient(135deg, #047857, #0d9488)",
    HyperEVM:    "linear-gradient(135deg, #065f46, #059669)",
    "BNB Chain": "linear-gradient(135deg, #92400e, #b45309)",
    Avalanche:   "linear-gradient(135deg, #991b1b, #dc2626)",
  };
  return map[chain] ?? "linear-gradient(135deg, #064e3b, #065f46)";
}

function tokenInitials(pair: string): string {
  const parts = pair.split("/").map((s) => s.trim());
  return `${parts[0]?.[0] ?? "?"}/${parts[1]?.[0] ?? "?"}`;
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function Dashboard() {
  const { positions: allPositions, isLoading, isFetching, dataUpdatedAt, refetch } = usePositions();
  const { address } = useAccount();
  const { solanaAddress, suiAddress } = useWalletAuth();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const { watchedWallets, addWallet } = useWatchedWallets();
  const hasWallet = mounted && (!!(address || solanaAddress || suiAddress) || watchedWallets.length > 0);

  // Watch wallet
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

  // Status filter
  const [statusFilter, setStatusFilter] = useState("All");

  // "Updated X ago" ticker
  const [secondsAgo, setSecondsAgo] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    setSecondsAgo(dataUpdatedAt > 0 ? Math.floor((Date.now() - dataUpdatedAt) / 1000) : 0);
    if (dataUpdatedAt > 0) {
      intervalRef.current = setInterval(
        () => setSecondsAgo(Math.floor((Date.now() - dataUpdatedAt) / 1000)),
        1000,
      );
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [dataUpdatedAt]);

  // Filtered + sorted positions (status-primary sort)
  const filtered = useMemo(() => {
    let result = allPositions;
    if (statusFilter !== "All") result = result.filter((p) => effectiveStatus(p) === statusFilter);
    const STATUS_ORDER: Record<string, number> = { "In Range": 0, "Out of Range": 1, Closed: 2 };
    return [...result].sort(
      (a, b) => (STATUS_ORDER[effectiveStatus(a)] ?? 1) - (STATUS_ORDER[effectiveStatus(b)] ?? 1),
    );
  }, [allPositions, statusFilter]);

  // Aggregate stats
  const totalValue   = allPositions.reduce((s, p) => s + p.value, 0);
  const totalFees    = allPositions.reduce((s, p) => s + p.fees, 0);
  const uniqueChains = new Set(allPositions.filter((p) => p.value > 0).map((p) => p.chain)).size;

  // Cashflow estimates
  const { dailyCashflow, hasCashflowData } = useMemo(() => {
    const active = allPositions.filter((p) => p.apy > 0 && p.value > 0);
    if (!active.length) return { dailyCashflow: 0, hasCashflowData: false };
    const yearly = active.reduce((s, p) => s + (p.value * p.apy) / 100, 0);
    return { dailyCashflow: yearly / 365, hasCashflowData: true };
  }, [allPositions]);

  // Value-weighted average APR
  const avgApr = useMemo(() => {
    const active = allPositions.filter((p) => p.value > 0 && p.apy > 0);
    if (!active.length) return null;
    const w = active.reduce((s, p) => s + p.value, 0);
    return w > 0 ? active.reduce((s, p) => s + p.apy * p.value, 0) / w : null;
  }, [allPositions]);

  // Protocol + chain breakdown for charts
  const protocolBreakdown = useMemo(() => {
    const m: Record<string, number> = {};
    for (const p of allPositions) {
      if (p.value > 0) m[p.protocol] = (m[p.protocol] ?? 0) + p.value;
    }
    return Object.entries(m).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  }, [allPositions]);

  const chainBreakdown = useMemo(() => {
    const m: Record<string, number> = {};
    for (const p of allPositions) {
      if (p.value > 0) m[p.chain] = (m[p.chain] ?? 0) + p.value;
    }
    return Object.entries(m).map(([chain, value]) => ({ chain, value })).sort((a, b) => b.value - a.value);
  }, [allPositions]);

  // Portfolio history chart
  const [rangeKey, setRangeKey] = useState<typeof TIME_RANGES[number]["key"]>("30D");
  const portfolioHistory = usePortfolioHistory(totalValue, allPositions.length, dataUpdatedAt);
  const activeRange    = TIME_RANGES.find((r) => r.key === rangeKey) ?? TIME_RANGES[2];
  const rangeCutoff    = Date.now() - activeRange.ms;
  const rangedHistory  = portfolioHistory.filter((s) => s.timestamp >= rangeCutoff);
  const effectiveHistory = rangedHistory.length >= 2 ? rangedHistory : portfolioHistory;
  const effectiveFirst   = effectiveHistory[0];
  const pnlDollar = effectiveFirst ? totalValue - effectiveFirst.totalValue : 0;
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
  }));

  // Hero price pills — separate light fetch for BTC/ETH/SOL
  const [heroPrices, setHeroPrices] = useState<Record<string, number>>({});
  useEffect(() => {
    fetch(
      "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=bitcoin,ethereum,solana&order=market_cap_desc&sparkline=false",
    )
      .then((r) => r.json())
      .then((data: Array<{ id: string; current_price: number }>) => {
        const map: Record<string, number> = {};
        for (const d of data) if (d.current_price) map[d.id] = d.current_price;
        setHeroPrices(map);
      })
      .catch(() => {});
  }, []);

  // Formatting helpers
  const fmt$ = (n: number, dec = 2) =>
    `$${n.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec })}`;

  const exportCSV = () => {
    const rows = filtered
      .map((p) => `${p.pair},${p.protocol},${p.chain},${p.value},${p.apy}%,${p.fees},${p.status}`)
      .join("\n");
    const blob = new Blob(["Pair,Protocol,Chain,Value,APY,Fees,Status\n" + rows], { type: "text/csv" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url; a.download = "defidesh-positions.csv"; a.click();
    URL.revokeObjectURL(url);
  };

  // Suppress unused-var lint for secondsAgo-derived label (used indirectly via isFetching display)
  void secondsAgo;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={{ background: "#060d08", minHeight: "100vh", color: "white" }}>
      <style>{`
        .pos-card { transition: border-color 0.18s; }
        .pos-card.in-range:hover  { border-color: rgba(16,185,129,0.3)  !important; }
        .pos-card.out-range:hover { border-color: rgba(245,158,11,0.25) !important; }
        @keyframes _spin { from { transform:rotate(0deg) } to { transform:rotate(360deg) } }
        .spin-icon { display:inline-block; animation: _spin 1s linear infinite; }
        @media (max-width:640px) {
          .hero-pills    { display:none !important; }
          .hero-big-num  { font-size:32px !important; letter-spacing:-1px !important; }
          .hero-stats    { gap:16px !important; }
          .pos-grid      { grid-template-columns: 1fr 1fr !important; }
          .pos-grid-apr  { display:none; }
        }
        @media (max-width:480px) {
          .pos-grid      { grid-template-columns: 1fr !important; }
          .pos-grid-val  { display:none; }
          .pos-grid-apr  { display:none; }
        }
      `}</style>

      <Navbar />

      {/* Price Ticker */}
      <div className="pt-16">
        <div style={{ maxWidth: 1200, margin: "0 auto", padding: "16px 28px 0" }}>
          <PriceTicker />
        </div>
      </div>

      {/* ── Hero Section ──────────────────────────────────────────────────────── */}
      <div style={{
        background: "linear-gradient(135deg, #041a0a 0%, #071f12 30%, #0a1e1a 55%, #061215 100%)",
        position: "relative",
        overflow: "hidden",
        padding: "28px 28px 24px",
      }}>
        {/* Glow orbs */}
        <div style={{ position:"absolute", top:0, right:0, width:400, height:300,
          background:"radial-gradient(circle, rgba(16,185,129,0.14) 0%, transparent 70%)",
          pointerEvents:"none" }} />
        <div style={{ position:"absolute", bottom:0, left:0, width:300, height:200,
          background:"radial-gradient(circle, rgba(52,211,153,0.08) 0%, transparent 70%)",
          pointerEvents:"none" }} />
        <div style={{ position:"absolute", top:"50%", right:"30%", width:200, height:200,
          background:"radial-gradient(circle, rgba(6,214,160,0.06) 0%, transparent 70%)",
          pointerEvents:"none" }} />

        <div style={{ maxWidth:1200, margin:"0 auto", position:"relative" }}>

          {/* Brand + price pills */}
          <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", marginBottom:24 }}>
            <div>
              <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:4 }}>
                <span style={{ fontSize:20, fontWeight:700, color:"white" }}>DefiDesh</span>
                <span style={{ background:"rgba(16,185,129,0.2)", color:"#6ee7b7", fontSize:10,
                  padding:"2px 8px", borderRadius:6, fontWeight:500 }}>BETA</span>
              </div>
              <p style={{ fontSize:11, color:"rgba(255,255,255,0.3)", letterSpacing:1, margin:0 }}>
                Track · Analyze · Optimize
              </p>
            </div>
            <div className="hero-pills" style={{ display:"flex", alignItems:"center", gap:6 }}>
              {[{ id:"bitcoin", label:"BTC" }, { id:"ethereum", label:"ETH" }, { id:"solana", label:"SOL" }].map(
                ({ id, label }) => heroPrices[id] ? (
                  <div key={id} style={{ background:"rgba(255,255,255,0.06)", borderRadius:12,
                    padding:"4px 10px", fontSize:10, color:"rgba(255,255,255,0.5)" }}>
                    {label} ${heroPrices[id].toLocaleString("en-US", { maximumFractionDigits: id === "bitcoin" ? 0 : 2 })}
                  </div>
                ) : null,
              )}
            </div>
          </div>

          {/* Big number */}
          <div style={{ marginBottom:20 }}>
            <p style={{ fontSize:11, letterSpacing:2, textTransform:"uppercase",
              color:"rgba(255,255,255,0.35)", margin:"0 0 6px" }}>
              Total Portfolio Value
            </p>
            <div style={{ display:"flex", alignItems:"baseline", gap:12, flexWrap:"wrap" }}>
              <span className="hero-big-num"
                style={{ fontSize:48, fontWeight:700, color:"white", letterSpacing:-2 }}>
                {fmt$(totalValue)}
              </span>
              {mounted && effectiveHistory.length >= 2 && (
                <span style={{ fontSize:14, color: pnlDollar >= 0 ? "#34d399" : "#ef4444" }}>
                  {pnlDollar >= 0 ? "+" : ""}{fmt$(Math.abs(pnlDollar))}{" "}
                  ({pnlDollar >= 0 ? "+" : ""}{pnlPct.toFixed(1)}%)
                  <span style={{ color:"rgba(255,255,255,0.3)", fontSize:12, marginLeft:4 }}>{pnlLabel}</span>
                </span>
              )}
            </div>
          </div>

          {/* Quick stats + buttons */}
          <div style={{ borderTop:"1px solid rgba(255,255,255,0.05)", paddingTop:16,
            display:"flex", alignItems:"flex-end", justifyContent:"space-between",
            flexWrap:"wrap", gap:16 }}>
            <div className="hero-stats" style={{ display:"flex", gap:24, flexWrap:"wrap" }}>
              {[
                { label:"Positions",  value: String(allPositions.length), color:"white" },
                { label:"Chains",     value: uniqueChains > 0 ? String(uniqueChains) : "—", color:"white" },
                { label:"Uncollected",value: totalFees > 0 ? fmt$(totalFees) : "—", color:"#34d399" },
                { label:"Daily yield",value: hasCashflowData ? `+${fmt$(dailyCashflow)}` : "N/A", color:"#34d399" },
                { label:"Avg APR",    value: avgApr !== null ? `${avgApr.toFixed(1)}%` : "N/A", color:"#6ee7b7" },
              ].map(({ label, value, color }) => (
                <div key={label}>
                  <p style={{ fontSize:10, letterSpacing:1, textTransform:"uppercase",
                    color:"rgba(255,255,255,0.3)", margin:"0 0 4px" }}>{label}</p>
                  <p style={{ fontSize:20, fontWeight:600, color, margin:0 }}>{value}</p>
                </div>
              ))}
            </div>

            <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
              <button
                onClick={() => refetch()}
                disabled={isFetching}
                style={{ background:"rgba(255,255,255,0.06)", borderRadius:12, padding:"6px 14px",
                  fontSize:12, color:"rgba(255,255,255,0.5)", border:"none", cursor:"pointer",
                  opacity: isFetching ? 0.6 : 1 }}
              >
                <span className={isFetching ? "spin-icon" : ""}>↻</span>{" "}
                {isFetching ? "Refreshing…" : "Refresh"}
              </button>
              <Link
                href="/wallet"
                style={{ background:"rgba(16,185,129,0.2)", borderRadius:12, padding:"6px 14px",
                  fontSize:12, color:"#6ee7b7", border:"1px solid rgba(16,185,129,0.3)",
                  textDecoration:"none" }}
              >
                Manage Wallets
              </Link>
            </div>
          </div>

        </div>
      </div>

      {/* ── Positions Section ─────────────────────────────────────────────────── */}
      <div style={{ background:"#060d08", padding:"20px 28px" }}>
        <div style={{ maxWidth:1200, margin:"0 auto" }}>

          {/* Filter / action bar */}
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between",
            marginBottom:16, gap:12, flexWrap:"wrap" }}>
            <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
              {STATUS_FILTERS.map((s) => {
                const active = statusFilter === s;
                const count  = s === "All"
                  ? allPositions.length
                  : allPositions.filter((p) => effectiveStatus(p) === s).length;
                return (
                  <button
                    key={s}
                    onClick={() => setStatusFilter(s)}
                    style={{
                      background: active
                        ? "linear-gradient(135deg, rgba(16,185,129,0.15), rgba(6,214,160,0.1))"
                        : "rgba(255,255,255,0.03)",
                      border: `1px solid ${active ? "rgba(16,185,129,0.25)" : "rgba(255,255,255,0.06)"}`,
                      color: active ? "#6ee7b7" : "rgba(255,255,255,0.4)",
                      borderRadius: 8,
                      padding: "6px 14px",
                      fontSize: 12,
                      cursor: "pointer",
                    }}
                  >
                    {s === "All" ? "All positions" : s} ({count})
                  </button>
                );
              })}
            </div>
            <div style={{ display:"flex", gap:8 }}>
              <button
                onClick={() => setShowWatchPanel((v) => !v)}
                style={{ background:"rgba(255,255,255,0.04)", border:"1px solid rgba(255,255,255,0.06)",
                  color:"rgba(255,255,255,0.4)", borderRadius:8, padding:"6px 14px",
                  fontSize:12, cursor:"pointer" }}
              >👁 Watch</button>
              <button
                onClick={exportCSV}
                style={{ background:"rgba(255,255,255,0.04)", border:"1px solid rgba(255,255,255,0.06)",
                  color:"rgba(255,255,255,0.4)", borderRadius:8, padding:"6px 14px",
                  fontSize:12, cursor:"pointer" }}
              >Export CSV</button>
            </div>
          </div>

          {/* Watch Wallet Panel */}
          {showWatchPanel && mounted && (
            <div style={{ background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.06)",
              borderRadius:12, padding:16, marginBottom:16 }}>
              <div style={{ display:"flex", flexWrap:"wrap", alignItems:"center", gap:8 }}>
                <span style={{ fontSize:13, color:"rgba(255,255,255,0.4)" }}>Watch wallet:</span>
                <input
                  type="text"
                  value={watchInput}
                  onChange={(e) => { setWatchInput(e.target.value); setWatchError(""); }}
                  onKeyDown={(e) => e.key === "Enter" && handleWatch()}
                  placeholder="Paste wallet address"
                  style={{ flex:1, minWidth:180, background:"#060d08", border:"1px solid rgba(255,255,255,0.1)",
                    color:"white", borderRadius:8, padding:"6px 12px", fontSize:13, outline:"none" }}
                />
                <select
                  value={watchChain}
                  onChange={(e) => { setWatchChain(e.target.value as WatchedWalletChain); setWatchError(""); }}
                  style={{ background:"#060d08", border:"1px solid rgba(255,255,255,0.1)", color:"white",
                    borderRadius:8, padding:"6px 12px", fontSize:13, outline:"none" }}
                >
                  <option value="evm">EVM</option>
                  <option value="solana">Solana</option>
                  <option value="sui">Sui</option>
                  <option value="aptos">Aptos</option>
                </select>
                <button
                  onClick={handleWatch}
                  style={{ background:"rgba(16,185,129,0.2)", border:"1px solid rgba(16,185,129,0.3)",
                    color:"#6ee7b7", borderRadius:8, padding:"6px 14px", fontSize:13, cursor:"pointer" }}
                >Add</button>
                {watchedWallets.length > 0 && (
                  <Link href="/watched"
                    style={{ fontSize:13, color:"rgba(255,255,255,0.4)", textDecoration:"none" }}>
                    Manage ({watchedWallets.length})
                  </Link>
                )}
              </div>
              {watchError && <p style={{ color:"#ef4444", fontSize:12, marginTop:6, marginBottom:0 }}>{watchError}</p>}
            </div>
          )}

          {/* Loading */}
          {mounted && isLoading && (
            <div style={{ textAlign:"center", padding:"64px 0", color:"rgba(255,255,255,0.4)" }}>
              <div className="spin-icon" style={{ width:32, height:32, border:"2px solid #10b981",
                borderTopColor:"transparent", borderRadius:"50%", margin:"0 auto 16px",
                display:"block" }} />
              <p>Fetching your positions…</p>
            </div>
          )}

          {/* Empty states */}
          {!isLoading && mounted && filtered.length === 0 && (
            <div>
              {!hasWallet ? (
                <div style={{ textAlign:"center", padding:"80px 0" }}>
                  <div style={{ fontSize:48, marginBottom:24 }}>💼</div>
                  <h3 style={{ fontSize:20, fontWeight:600, color:"white", marginBottom:8 }}>
                    No wallet connected
                  </h3>
                  <p style={{ color:"rgba(255,255,255,0.4)", marginBottom:32 }}>
                    Connect your wallet to track your LP positions across EVM chains, Solana, and Sui.
                  </p>
                  <div style={{ display:"flex", flexWrap:"wrap", justifyContent:"center", gap:12, fontSize:13, color:"rgba(255,255,255,0.4)" }}>
                    {[
                      { chain:"EVM",    color:"#3b82f6", desc:"Ethereum · Base · Arbitrum · Optimism" },
                      { chain:"Solana", color:"#9945ff", desc:"Raydium · Orca" },
                      { chain:"Sui",    color:"#6fbcf0", desc:"Bluefin · Cetus" },
                    ].map(({ chain, color, desc }) => (
                      <div key={chain} style={{ background:"rgba(255,255,255,0.03)",
                        border:"1px solid rgba(255,255,255,0.06)", borderRadius:12,
                        padding:"12px 16px", display:"flex", alignItems:"center", gap:8 }}>
                        <span style={{ color, fontWeight:600 }}>{chain}</span>
                        <span>{desc}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : allPositions.length === 0 ? (
                <div style={{ textAlign:"center", padding:"80px 0" }}>
                  <div style={{ fontSize:48, marginBottom:24 }}>📭</div>
                  <h3 style={{ fontSize:20, fontWeight:600, color:"white", marginBottom:8 }}>
                    No positions found
                  </h3>
                  <p style={{ color:"rgba(255,255,255,0.4)" }}>
                    No LP positions were found for your connected wallet(s).
                  </p>
                </div>
              ) : (
                <div style={{ textAlign:"center", padding:"48px 0", color:"rgba(255,255,255,0.4)" }}>
                  No positions match your filter.
                </div>
              )}
            </div>
          )}

          {/* Position Cards */}
          {!isLoading && filtered.length > 0 && (
            <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
              {filtered.map((pos) => {
                const posStatus     = effectiveStatus(pos);
                const isClosed      = posStatus === "Closed";
                const slug          = encodeURIComponent(pos.id);
                const dailyEarnings = pos.apy > 0 && pos.value > 0
                  ? (pos.value * pos.apy) / 100 / 365
                  : null;
                const statusClass = posStatus === "In Range" ? "in-range"
                  : posStatus === "Out of Range" ? "out-range"
                  : "";

                return (
                  <Link
                    key={pos.id}
                    href={`/dashboard/position/${slug}`}
                    className={`pos-card pos-grid ${statusClass}`}
                    style={{
                      display:"grid",
                      gridTemplateColumns:"2fr 1fr 1fr 130px",
                      alignItems:"center",
                      gap:16,
                      padding:16,
                      borderRadius:14,
                      background: isClosed ? "rgba(255,255,255,0.015)" : "rgba(255,255,255,0.03)",
                      border: `1px solid ${isClosed ? "rgba(255,255,255,0.03)" : "rgba(255,255,255,0.06)"}`,
                      textDecoration:"none",
                      color:"white",
                      cursor:"pointer",
                      opacity: isClosed ? 0.45 : 1,
                    }}
                  >
                    {/* Col 1: Pair info */}
                    <div style={{ display:"flex", alignItems:"center", gap:12, overflow:"hidden" }}>
                      <div style={{
                        width:36, height:36, borderRadius:"50%",
                        background: chainGradient(pos.chain),
                        display:"flex", alignItems:"center", justifyContent:"center",
                        fontSize:11, fontWeight:700, color:"white", flexShrink:0,
                      }}>
                        {tokenInitials(pos.pair)}
                      </div>
                      <div style={{ overflow:"hidden" }}>
                        <p style={{ fontSize:15, fontWeight:600, color:"white", margin:0,
                          overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                          {pos.pair}
                        </p>
                        <p style={{ fontSize:11, color:"rgba(255,255,255,0.3)", margin:0 }}>
                          {pos.protocol} · {pos.chain}{pos.feeTier != null ? ` · ${pos.feeTier}%` : ""}
                        </p>
                      </div>
                    </div>

                    {/* Col 2: Value */}
                    <div className="pos-grid-val">
                      <p style={{ fontSize:18, fontWeight:600, color:"white", margin:0 }}>
                        {fmt$(pos.value)}
                      </p>
                      {pos.fees > 0 && (
                        <p style={{ fontSize:11, color:"#34d399", margin:0 }}>
                          +{fmt$(pos.fees)} fees
                        </p>
                      )}
                    </div>

                    {/* Col 3: APR */}
                    <div className="pos-grid-apr">
                      {pos.apy > 0 ? (
                        <>
                          <p style={{ fontSize:16, fontWeight:600, color:"#6ee7b7", margin:0 }}>
                            {pos.apy.toFixed(1)}%
                          </p>
                          {dailyEarnings !== null && (
                            <p style={{ fontSize:11, color:"rgba(255,255,255,0.3)", margin:0 }}>
                              ${dailyEarnings.toFixed(2)}/day
                            </p>
                          )}
                        </>
                      ) : (
                        <p style={{ fontSize:16, fontWeight:600, color:"#6ee7b7", margin:0 }}>N/A</p>
                      )}
                    </div>

                    {/* Col 4: Status badge */}
                    <div style={{ display:"flex", justifyContent:"flex-end" }}>
                      <span style={{
                        background: posStatus === "In Range"
                          ? "rgba(52,211,153,0.1)"
                          : posStatus === "Out of Range"
                          ? "rgba(245,158,11,0.1)"
                          : "rgba(255,255,255,0.03)",
                        border: `1px solid ${
                          posStatus === "In Range"
                            ? "rgba(52,211,153,0.2)"
                            : posStatus === "Out of Range"
                            ? "rgba(245,158,11,0.2)"
                            : "rgba(255,255,255,0.06)"
                        }`,
                        color: posStatus === "In Range" ? "#34d399"
                          : posStatus === "Out of Range" ? "#f59e0b"
                          : "rgba(255,255,255,0.3)",
                        borderRadius:20,
                        padding:"4px 10px",
                        fontSize:11,
                        whiteSpace:"nowrap",
                      }}>
                        {posStatus === "In Range" ? "● In range"
                          : posStatus === "Out of Range" ? "Out of range"
                          : "Closed"}
                      </span>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}

          {/* Closed position note */}
          {mounted && (solanaAddress || suiAddress) && (
            <div style={{ marginTop:16, fontSize:13, color:"rgba(255,255,255,0.4)",
              border:"1px solid rgba(255,255,255,0.06)", borderRadius:10,
              padding:"12px 16px", display:"flex", gap:8 }}>
              <span style={{ flexShrink:0 }}>ℹ️</span>
              <span>
                Some closed positions may not appear: on Solana, NFTs are burned when a position is fully
                closed; on Sui, position objects are destroyed. These no longer exist on-chain.
              </span>
            </div>
          )}

        </div>
      </div>

      {/* ── Charts Section ────────────────────────────────────────────────────── */}
      {mounted && (
        <div style={{ background:"#060d08", padding:"0 28px 40px" }}>
          <div style={{ maxWidth:1200, margin:"0 auto" }}>

            {allPositions.some((p) => p.value > 0) && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">

                {/* Portfolio Allocation */}
                <div style={{ background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.06)",
                  borderRadius:14, padding:20 }}>
                  <h3 style={{ fontSize:11, textTransform:"uppercase", letterSpacing:1,
                    color:"rgba(255,255,255,0.35)", margin:"0 0 16px" }}>Portfolio Allocation</h3>
                  <div style={{ display:"flex", alignItems:"center", gap:16 }}>
                    <div style={{ flexShrink:0 }}>
                      <ResponsiveContainer width={130} height={130}>
                        <PieChart>
                          <Pie data={protocolBreakdown} cx="50%" cy="50%"
                            innerRadius={38} outerRadius={62} dataKey="value" strokeWidth={0}>
                            {protocolBreakdown.map((entry) => (
                              <Cell key={entry.name} fill={getProtocolColor(entry.name)} />
                            ))}
                          </Pie>
                          <Tooltip
                            contentStyle={{ backgroundColor:"#0a1410",
                              border:"1px solid rgba(255,255,255,0.06)",
                              borderRadius:8, color:"#fff", fontSize:12 }}
                            formatter={(v: number | undefined) => [fmt$(v ?? 0), ""]}
                          />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                    <div style={{ flex:1, overflow:"hidden" }}>
                      {protocolBreakdown.map((entry) => (
                        <div key={entry.name}
                          style={{ display:"flex", alignItems:"center", justifyContent:"space-between",
                            gap:8, marginBottom:6 }}>
                          <div style={{ display:"flex", alignItems:"center", gap:6, overflow:"hidden" }}>
                            <div style={{ width:8, height:8, borderRadius:"50%",
                              background:getProtocolColor(entry.name), flexShrink:0 }} />
                            <span style={{ fontSize:12, color:"rgba(255,255,255,0.5)",
                              overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                              {entry.name}
                            </span>
                          </div>
                          <div style={{ fontSize:12, textAlign:"right", flexShrink:0 }}>
                            <span style={{ color:"white", fontWeight:500 }}>{fmt$(entry.value, 0)}</span>
                            <span style={{ color:"rgba(255,255,255,0.3)", marginLeft:4 }}>
                              ({totalValue > 0 ? ((entry.value / totalValue) * 100).toFixed(1) : "0"}%)
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Chain Distribution */}
                <div style={{ background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.06)",
                  borderRadius:14, padding:20 }}>
                  <h3 style={{ fontSize:11, textTransform:"uppercase", letterSpacing:1,
                    color:"rgba(255,255,255,0.35)", margin:"0 0 16px" }}>Chain Distribution</h3>
                  <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
                    {chainBreakdown.map((entry) => {
                      const pct = totalValue > 0 ? (entry.value / totalValue) * 100 : 0;
                      return (
                        <div key={entry.chain}>
                          <div style={{ display:"flex", justifyContent:"space-between",
                            alignItems:"center", marginBottom:4 }}>
                            <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                              <div style={{ width:8, height:8, borderRadius:"50%",
                                background:getChainColor(entry.chain) }} />
                              <span style={{ fontSize:12, color:"rgba(255,255,255,0.7)" }}>{entry.chain}</span>
                            </div>
                            <div style={{ fontSize:12 }}>
                              <span style={{ color:"white" }}>{fmt$(entry.value, 0)}</span>
                              <span style={{ color:"rgba(255,255,255,0.3)", marginLeft:4 }}>
                                ({pct.toFixed(1)}%)
                              </span>
                            </div>
                          </div>
                          <div style={{ height:4, background:"rgba(255,255,255,0.06)",
                            borderRadius:2, overflow:"hidden" }}>
                            <div style={{ height:"100%", borderRadius:2,
                              background:getChainColor(entry.chain), width:`${pct}%` }} />
                          </div>
                        </div>
                      );
                    })}
                    {chainBreakdown.length === 0 && (
                      <p style={{ color:"rgba(255,255,255,0.3)", fontSize:13 }}>No chain data</p>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Portfolio History */}
            {hasWallet && (
              <div style={{ background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.06)",
                borderRadius:14, padding:20 }}>
                <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between",
                  marginBottom:16, flexWrap:"wrap", gap:12 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:12, flexWrap:"wrap" }}>
                    <h3 style={{ fontSize:11, textTransform:"uppercase", letterSpacing:1,
                      color:"rgba(255,255,255,0.35)", margin:0 }}>Portfolio History</h3>
                    <div style={{ display:"flex", gap:4 }}>
                      {TIME_RANGES.map((r) => {
                        const hasData = portfolioHistory.filter((s) => s.timestamp >= Date.now() - r.ms).length >= 2;
                        return (
                          <button
                            key={r.key}
                            onClick={() => setRangeKey(r.key)}
                            style={{
                              padding:"2px 8px", borderRadius:4, fontSize:11, fontWeight:500, border:"none",
                              cursor:"pointer",
                              background: rangeKey === r.key ? "#10b981" : "rgba(255,255,255,0.06)",
                              color: rangeKey === r.key ? "white"
                                : hasData ? "rgba(255,255,255,0.5)"
                                : "rgba(255,255,255,0.2)",
                            }}
                          >{r.key}</button>
                        );
                      })}
                    </div>
                  </div>
                  {effectiveHistory.length >= 2 && (
                    <div style={{ fontSize:13, fontWeight:500,
                      color: pnlDollar >= 0 ? "#34d399" : "#ef4444" }}>
                      {pnlDollar >= 0 ? "+" : ""}{fmt$(Math.abs(pnlDollar))}{" "}
                      <span style={{ opacity:0.75 }}>
                        ({pnlDollar >= 0 ? "+" : ""}{pnlPct.toFixed(2)}%)
                      </span>
                      <span style={{ color:"rgba(255,255,255,0.4)", fontWeight:400, marginLeft:4 }}>
                        {pnlLabel}
                      </span>
                    </div>
                  )}
                </div>
                {portfolioHistory.length < 2 ? (
                  <div style={{ textAlign:"center", padding:"32px 0" }}>
                    <p style={{ fontSize:13, color:"rgba(255,255,255,0.4)" }}>
                      Tracking started — chart appears after the next refresh.
                    </p>
                    <p style={{ fontSize:11, color:"rgba(255,255,255,0.2)", marginTop:4 }}>
                      A data point is saved on every 60-second refresh.
                    </p>
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={chartData} margin={{ top:4, right:16, left:8, bottom:4 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                      <XAxis dataKey="label" tick={{ fill:"rgba(255,255,255,0.3)", fontSize:11 }}
                        axisLine={false} tickLine={false} interval="preserveStartEnd" />
                      <YAxis tick={{ fill:"rgba(255,255,255,0.3)", fontSize:11 }}
                        axisLine={false} tickLine={false} width={72}
                        tickFormatter={(v) =>
                          `$${Number(v).toLocaleString("en-US", { maximumFractionDigits:0 })}`} />
                      <Tooltip
                        contentStyle={{ backgroundColor:"#0a1410",
                          border:"1px solid rgba(255,255,255,0.06)",
                          borderRadius:8, color:"#fff" }}
                        formatter={(v: number | undefined) => [fmt$(v ?? 0), "Portfolio Value"]}
                        labelStyle={{ color:"rgba(255,255,255,0.5)", marginBottom:4 }}
                      />
                      <Line type="monotone" dataKey="value" stroke="#34d399" strokeWidth={2}
                        dot={chartData.length <= 20}
                        activeDot={{ r:4, fill:"#34d399" }} />
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </div>
            )}

          </div>
        </div>
      )}

    </div>
  );
}
