"use client";

import { useState, useMemo, useEffect, useRef, type CSSProperties } from "react";
import Link from "next/link";
import Navbar from "../Navbar";
import { getTokenLogo } from "../lib/tokenLogos";
import { useWalletTokens } from "../hooks/useWalletTokens";
import { useLendingPositions } from "../hooks/useLendingPositions";
import { usePositions } from "../contexts/PositionsContext";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { useWallet } from "@solana/wallet-adapter-react";
import type { WalletName } from "@solana/wallet-adapter-base";
import { useCurrentAccount, useWallets, useConnectWallet, useDisconnectWallet } from "@mysten/dapp-kit";
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

// ── Token color map (reusable across the app) ─────────────────────────────────
export const TOKEN_COLORS: Record<string, string> = {
  // Ethereum
  ETH:     "#627EEA",
  WETH:    "#627EEA",
  // USDC variants
  USDC:    "#2775CA",
  "USDC.e":"#2775CA",
  USDbC:   "#2775CA",
  // USDT
  USDT:    "#26A17B",
  // Bitcoin
  BTC:     "#F7931A",
  WBTC:    "#F7931A",
  cbBTC:   "#F7931A",
  tBTC:    "#F7931A",
  // Solana
  SOL:     "#9945FF",
  WSOL:    "#9945FF",
  // Sui
  SUI:     "#6FBCF0",
  // HYPE (HyperEVM)
  HYPE:    "#00D4AA",
  WHYPE:   "#00D4AA",
  // DAI
  DAI:     "#F5AC37",
  // BNB
  BNB:     "#F0B90B",
  WBNB:    "#F0B90B",
  // MATIC / POL
  MATIC:   "#8247E5",
  POL:     "#8247E5",
  // AVAX
  AVAX:    "#E84142",
  // ARB
  ARB:     "#2D9CDB",
  // OP
  OP:      "#FF0420",
  // USDS
  USDS:    "#26A17B",
};

export function getTokenColor(symbol: string): string {
  return TOKEN_COLORS[symbol] ?? "#6B7280";
}

// ── TokenCircle: circular token logo with colored-letter fallback ─────────────
function TokenCircle({
  symbol, size = 32, style,
}: { symbol: string; size?: number; style?: CSSProperties }) {
  const [imgError, setImgError] = useState(false);
  const logoUrl = getTokenLogo(symbol);
  const color = TOKEN_COLORS[symbol] ?? TOKEN_COLORS[symbol.toUpperCase()] ?? "#6B7280";
  const shared: CSSProperties = {
    width: size, height: size, borderRadius: "50%",
    border: "2px solid #060d08", flexShrink: 0, ...style,
  };
  if (logoUrl && !imgError) {
    return (
      <img
        src={logoUrl} alt={symbol}
        onError={() => setImgError(true)}
        style={{ ...shared, objectFit: "cover", display: "block" }}
      />
    );
  }
  return (
    <div style={{
      ...shared, background: color,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: size * 0.35, fontWeight: 700, color: "white",
    }}>
      {symbol.charAt(0).toUpperCase()}
    </div>
  );
}

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
  const { connect: evmConnect, connectors } = useConnect();
  const { disconnect: evmDisconnect } = useDisconnect();
  const { solanaAddress, suiAddress, setSolanaAddress, setSuiAddress } = useWalletAuth();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Solana wallet adapter (for modal connect)
  const { select: solanaSelect, connect: connectSolanaWallet, disconnect: disconnectSolanaWallet,
    connected: adapterSolanaConnected, publicKey: adapterPublicKey, wallets: solanaWallets } = useWallet();
  const awaitingSolanaConnectModal = useRef(false);

  // Sui wallet adapter (for modal connect)
  const adapterSuiAccount = useCurrentAccount();
  const modalSuiWallets = useWallets();
  const { mutateAsync: connectSuiAsync } = useConnectWallet();
  const { mutate: disconnectSuiWallet } = useDisconnectWallet();
  const awaitingSuiConnectModal = useRef(false);

  // Track modal Solana connect
  useEffect(() => {
    if (awaitingSolanaConnectModal.current && adapterSolanaConnected && adapterPublicKey) {
      setSolanaAddress(adapterPublicKey.toBase58());
      awaitingSolanaConnectModal.current = false;
    }
  }, [adapterSolanaConnected, adapterPublicKey, setSolanaAddress]);

  // Track modal Sui connect
  useEffect(() => {
    if (awaitingSuiConnectModal.current && adapterSuiAccount) {
      setSuiAddress(adapterSuiAccount.address);
      awaitingSuiConnectModal.current = false;
    }
  }, [adapterSuiAccount, setSuiAddress]);

  const { watchedWallets, addWallet, removeWallet, updateLabel } = useWatchedWallets();
  const hasWallet = mounted && (!!(address || solanaAddress || suiAddress) || watchedWallets.length > 0);

  // Wallet token balances (for Tokens + Lending summary cards)
  const {
    totalTokenValue, totalLendingValue,
    tokenCount, lendingCount,
    isLoading: walletTokensLoading,
  } = useWalletTokens();

  // External lending platforms (Dolomite, Jupiter Lend, AlphaFi, Suilend)
  const { positions: externalLendingPositions } = useLendingPositions();
  const externalLendingValue = externalLendingPositions.reduce((s, p) => s + p.totalSupplied, 0);
  const externalLendingCount = externalLendingPositions.length;
  const combinedLendingValue = totalLendingValue + externalLendingValue;
  const combinedLendingCount = lendingCount + externalLendingCount;

  // Manage Wallets modal state
  const [showManageWallets, setShowManageWallets] = useState(false);
  const [showEvmConnectors, setShowEvmConnectors] = useState(false);
  const [showSolanaWalletList, setShowSolanaWalletList] = useState(false);
  const [showSuiWalletList, setShowSuiWalletList] = useState(false);
  const [addWalletAddress, setAddWalletAddress] = useState("");
  const [addWalletLabel, setAddWalletLabel] = useState("");
  const [addWalletError, setAddWalletError] = useState("");
  const [editingWallet, setEditingWallet] = useState<string | null>(null);
  const [editLabelValue, setEditLabelValue] = useState("");

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
      "/api/prices?endpoint=coins/markets&ids=bitcoin,ethereum,solana&vs_currencies=usd&order=market_cap_desc",
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

  // Detect chain from address format
  function detectChain(addr: string): WatchedWalletChain | null {
    if (/^0x[0-9a-fA-F]{40}$/.test(addr)) return "evm";
    if (/^0x[0-9a-fA-F]{63,64}$/.test(addr)) return "sui";
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr)) return "solana";
    return null;
  }

  function handleAddWatchedWallet() {
    const addr = addWalletAddress.trim();
    if (!addr) { setAddWalletError("Address is required"); return; }
    const chain = detectChain(addr);
    if (!chain) { setAddWalletError("Invalid address format. Please enter a valid EVM, Solana, or SUI address."); return; }
    addWallet(addr, chain, addWalletLabel.trim() || undefined);
    setAddWalletAddress("");
    setAddWalletLabel("");
    setAddWalletError("");
  }

  async function handleSolanaConnectFromModal(walletName: string) {
    try {
      solanaSelect(walletName as WalletName);
      awaitingSolanaConnectModal.current = true;
      await connectSolanaWallet();
    } catch (err) {
      awaitingSolanaConnectModal.current = false;
      console.error("Solana connect error:", err);
    }
    setShowSolanaWalletList(false);
  }

  async function handleSuiConnectFromModal(wallet: (typeof modalSuiWallets)[0]) {
    try {
      awaitingSuiConnectModal.current = true;
      await connectSuiAsync({ wallet });
    } catch (err) {
      awaitingSuiConnectModal.current = false;
      console.error("Sui connect error:", err);
    }
    setShowSuiWalletList(false);
  }

  // Suppress unused-var lint
  void secondsAgo;
  void getTickPriceUSD;
  void getManageUrl;

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

      {/* ── Hero Section ──────────────────────────────────────────────────────── */}
      <div style={{
        background: "linear-gradient(135deg, #041a0a 0%, #071f12 30%, #0a1e1a 55%, #061215 100%)",
        position: "relative",
        overflow: "hidden",
        padding: "80px 28px 24px",
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
                onClick={() => { if (!isFetching) refetch(); }}
                aria-disabled={isFetching}
                style={{ background:"rgba(255,255,255,0.06)", borderRadius:12, padding:"6px 14px",
                  fontSize:12, color:"rgba(255,255,255,0.5)", border:"none",
                  cursor: isFetching ? "not-allowed" : "pointer",
                  opacity: isFetching ? 0.5 : 1 }}
              >
                <span className={isFetching ? "spin-icon" : ""}>↻</span>{" "}
                {isFetching ? "Refreshing…" : "Refresh"}
              </button>
              <button
                onClick={() => setShowManageWallets(true)}
                style={{ background:"rgba(16,185,129,0.2)", borderRadius:12, padding:"6px 14px",
                  fontSize:12, color:"#6ee7b7", border:"1px solid rgba(16,185,129,0.3)", cursor:"pointer" }}
              >
                Manage Wallets
              </button>
            </div>
          </div>

        </div>
      </div>

      {/* ── Summary Cards ─────────────────────────────────────────────────────── */}
      {mounted && (
        <div style={{ background:"#060d08", padding:"20px 28px 0" }}>
          <div style={{ maxWidth:1200, margin:"0 auto" }}>

            {/* Row 1 */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">

              {/* Card 1: Wallets */}
              <div style={{ background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.06)",
                borderRadius:14, padding:20 }}>
                <h3 style={{ fontSize:11, textTransform:"uppercase", letterSpacing:1,
                  color:"#FBBF24", margin:"0 0 14px", fontWeight:600 }}>Wallets</h3>
                <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
                  {address && (
                    <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                      <div>
                        <span style={{ fontSize:10, color:"#3b82f6", fontWeight:700,
                          textTransform:"uppercase", letterSpacing:0.5 }}>EVM</span>
                        <p style={{ fontSize:12, fontFamily:"monospace",
                          color:"rgba(255,255,255,0.65)", margin:0, marginTop:2 }}>
                          {address.slice(0,8)}…{address.slice(-6)}
                        </p>
                      </div>
                      <button onClick={() => navigator.clipboard.writeText(address)}
                        style={{ background:"none", border:"none", color:"rgba(255,255,255,0.35)",
                          cursor:"pointer", fontSize:14, padding:"2px 6px" }} title="Copy address">⧉</button>
                    </div>
                  )}
                  {solanaAddress && (
                    <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                      <div>
                        <span style={{ fontSize:10, color:"#9945ff", fontWeight:700,
                          textTransform:"uppercase", letterSpacing:0.5 }}>Solana</span>
                        <p style={{ fontSize:12, fontFamily:"monospace",
                          color:"rgba(255,255,255,0.65)", margin:0, marginTop:2 }}>
                          {solanaAddress.slice(0,6)}…{solanaAddress.slice(-4)}
                        </p>
                      </div>
                      <button onClick={() => navigator.clipboard.writeText(solanaAddress)}
                        style={{ background:"none", border:"none", color:"rgba(255,255,255,0.35)",
                          cursor:"pointer", fontSize:14, padding:"2px 6px" }} title="Copy address">⧉</button>
                    </div>
                  )}
                  {suiAddress && (
                    <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                      <div>
                        <span style={{ fontSize:10, color:"#6fbcf0", fontWeight:700,
                          textTransform:"uppercase", letterSpacing:0.5 }}>Sui</span>
                        <p style={{ fontSize:12, fontFamily:"monospace",
                          color:"rgba(255,255,255,0.65)", margin:0, marginTop:2 }}>
                          {suiAddress.slice(0,8)}…{suiAddress.slice(-6)}
                        </p>
                      </div>
                      <button onClick={() => navigator.clipboard.writeText(suiAddress)}
                        style={{ background:"none", border:"none", color:"rgba(255,255,255,0.35)",
                          cursor:"pointer", fontSize:14, padding:"2px 6px" }} title="Copy address">⧉</button>
                    </div>
                  )}
                  {watchedWallets.map((w) => (
                    <div key={w.address} style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                      <div>
                        <span style={{ fontSize:10, color:"rgba(255,255,255,0.4)", fontWeight:700,
                          textTransform:"uppercase", letterSpacing:0.5 }}>
                          {w.chain} · {w.label ?? "Watched"}
                        </span>
                        <p style={{ fontSize:12, fontFamily:"monospace",
                          color:"rgba(255,255,255,0.5)", margin:0, marginTop:2 }}>
                          {w.address.slice(0,6)}…{w.address.slice(-4)}
                        </p>
                      </div>
                      <button onClick={() => navigator.clipboard.writeText(w.address)}
                        style={{ background:"none", border:"none", color:"rgba(255,255,255,0.35)",
                          cursor:"pointer", fontSize:14, padding:"2px 6px" }} title="Copy address">⧉</button>
                    </div>
                  ))}
                  {!hasWallet && (
                    <p style={{ fontSize:12, color:"rgba(255,255,255,0.3)", margin:0 }}>No wallet connected</p>
                  )}
                </div>
              </div>

              {/* Card 3: Estimated Net Cashflow */}
              <div style={{ background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.06)",
                borderRadius:14, padding:20 }}>
                <h3 style={{ fontSize:11, textTransform:"uppercase", letterSpacing:1,
                  color:"#FBBF24", margin:"0 0 14px", fontWeight:600 }}>Estimated Net Cashflow</h3>
                {hasCashflowData ? (
                  <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
                    {[
                      { label:"Daily",   value: dailyCashflow },
                      { label:"Monthly", value: dailyCashflow * 30 },
                      { label:"Yearly",  value: dailyCashflow * 365 },
                    ].map(({ label, value }) => (
                      <div key={label} style={{ display:"flex", justifyContent:"space-between",
                        alignItems:"center" }}>
                        <span style={{ fontSize:13, color:"rgba(255,255,255,0.45)" }}>{label}</span>
                        <span style={{ fontSize:15, fontWeight:600, color:"#34d399" }}>
                          +{fmt$(value)}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p style={{ fontSize:13, color:"rgba(255,255,255,0.3)", margin:0 }}>
                    Connect wallet to see cashflow estimates.
                  </p>
                )}
              </div>
            </div>

            {/* Row 2 */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">

              {/* Card 4: Tokens — clickable */}
              <Link href="/dashboard/tokens" style={{ textDecoration:"none" }}>
                <div style={{ background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.06)",
                  borderRadius:14, padding:20, cursor:"pointer", transition:"border-color 0.15s",
                  height:"100%", boxSizing:"border-box" }}
                  onMouseEnter={(e) => (e.currentTarget.style.borderColor = "rgba(251,191,36,0.25)")}
                  onMouseLeave={(e) => (e.currentTarget.style.borderColor = "rgba(255,255,255,0.06)")}>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:14 }}>
                    <h3 style={{ fontSize:11, textTransform:"uppercase", letterSpacing:1,
                      color:"#FBBF24", margin:0, fontWeight:600 }}>Wallet Balances</h3>
                    <span style={{ fontSize:11, color:"rgba(255,255,255,0.25)" }}>View →</span>
                  </div>
                  {!hasWallet ? (
                    <p style={{ fontSize:13, color:"rgba(255,255,255,0.3)", margin:0 }}>Connect wallet to see balances.</p>
                  ) : walletTokensLoading ? (
                    <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                      <div style={{ width:8, height:8, borderRadius:"50%", background:"#FBBF24",
                        animation:"_spin 1s linear infinite" }} />
                      <span style={{ fontSize:13, color:"rgba(255,255,255,0.3)" }}>Loading…</span>
                    </div>
                  ) : (
                    <>
                      <p style={{ fontSize:34, fontWeight:700, color:"white", margin:"0 0 6px",
                        letterSpacing:-1 }}>{fmt$(totalTokenValue)}</p>
                      <p style={{ fontSize:12, color:"rgba(255,255,255,0.4)", margin:0 }}>
                        {tokenCount > 0 ? `${tokenCount} token${tokenCount === 1 ? "" : "s"}` : "No tokens found"}
                      </p>
                    </>
                  )}
                </div>
              </Link>

              {/* Card 5: Lending / Borrowing — clickable */}
              <Link href="/dashboard/lending" style={{ textDecoration:"none" }}>
                <div style={{ background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.06)",
                  borderRadius:14, padding:20, cursor:"pointer", transition:"border-color 0.15s",
                  height:"100%", boxSizing:"border-box" }}
                  onMouseEnter={(e) => (e.currentTarget.style.borderColor = "rgba(251,191,36,0.25)")}
                  onMouseLeave={(e) => (e.currentTarget.style.borderColor = "rgba(255,255,255,0.06)")}>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:14 }}>
                    <h3 style={{ fontSize:11, textTransform:"uppercase", letterSpacing:1,
                      color:"#FBBF24", margin:0, fontWeight:600 }}>Lending / Borrowing</h3>
                    <span style={{ fontSize:11, color:"rgba(255,255,255,0.25)" }}>View →</span>
                  </div>
                  {!hasWallet ? (
                    <p style={{ fontSize:13, color:"rgba(255,255,255,0.3)", margin:0 }}>Connect wallet to see positions.</p>
                  ) : walletTokensLoading ? (
                    <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                      <div style={{ width:8, height:8, borderRadius:"50%", background:"#FBBF24",
                        animation:"_spin 1s linear infinite" }} />
                      <span style={{ fontSize:13, color:"rgba(255,255,255,0.3)" }}>Loading…</span>
                    </div>
                  ) : (
                    <>
                      <p style={{ fontSize:34, fontWeight:700, color:"white", margin:"0 0 6px",
                        letterSpacing:-1 }}>{fmt$(combinedLendingValue)}</p>
                      <p style={{ fontSize:12, color:"rgba(255,255,255,0.4)", margin:0 }}>
                        {combinedLendingCount > 0 ? `${combinedLendingCount} position${combinedLendingCount === 1 ? "" : "s"}` : "No positions found"}
                      </p>
                    </>
                  )}
                </div>
              </Link>
            </div>

          </div>
        </div>
      )}

      {/* ── Charts Section ────────────────────────────────────────────────────── */}
      {mounted && (
        <div style={{ background:"#060d08", padding:"20px 28px 0" }}>
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
                borderRadius:14, padding:20, marginBottom:20 }}>
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

      {/* ── Positions Section ─────────────────────────────────────────────────── */}
      <div style={{ background:"#060d08", padding:"20px 28px 40px" }}>
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
                onClick={exportCSV}
                style={{ background:"rgba(255,255,255,0.04)", border:"1px solid rgba(255,255,255,0.06)",
                  color:"rgba(255,255,255,0.4)", borderRadius:8, padding:"6px 14px",
                  fontSize:12, cursor:"pointer" }}
              >Export CSV</button>
            </div>
          </div>

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
                      {/* Dual overlapping token circles */}
                      {(() => {
                        const parts = pos.pair.split(/\s*\/\s*/);
                        const sym0 = parts[0]?.trim() ?? "";
                        const sym1 = parts[1]?.trim() ?? "";
                        const SIZE = 32;
                        const OVERLAP = 10;
                        return (
                          <div style={{ position:"relative", width:SIZE * 2 - OVERLAP, height:SIZE, flexShrink:0 }}>
                            <TokenCircle symbol={sym1} size={SIZE}
                              style={{ position:"absolute", right:0, top:0, zIndex:1 }} />
                            <TokenCircle symbol={sym0} size={SIZE}
                              style={{ position:"absolute", left:0, top:0, zIndex:2 }} />
                          </div>
                        );
                      })()}
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

        </div>
      </div>

      {/* ── Manage Wallets Modal ───────────────────────────────────────────────── */}
      {showManageWallets && mounted && (
        <div style={{ position:"fixed", inset:0, zIndex:200, display:"flex", alignItems:"center", justifyContent:"center" }}>
          <div style={{ position:"absolute", inset:0, background:"rgba(0,0,0,0.75)", backdropFilter:"blur(4px)" }}
            onClick={() => { setShowManageWallets(false); setShowEvmConnectors(false); setShowSolanaWalletList(false); setShowSuiWalletList(false); }} />
          <div style={{ position:"relative", background:"#070e09", border:"1px solid rgba(16,185,129,0.2)",
            borderRadius:20, width:"100%", maxWidth:520, margin:"0 16px", maxHeight:"90vh", overflowY:"auto" }}>

            {/* Modal Header */}
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between",
              padding:"20px 20px 16px", borderBottom:"1px solid rgba(255,255,255,0.05)",
              position:"sticky", top:0, background:"#070e09", zIndex:10 }}>
              <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                <span style={{ fontSize:20 }}>💼</span>
                <h2 style={{ fontSize:17, fontWeight:700, color:"white", margin:0 }}>Manage Wallets</h2>
              </div>
              <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                <button onClick={() => refetch()} title="Refresh positions"
                  style={{ background:"none", border:"none", color:"rgba(255,255,255,0.4)",
                    cursor:"pointer", fontSize:18, padding:"4px 6px", borderRadius:6,
                    display:"flex", alignItems:"center" }}>
                  <span className={isFetching ? "spin-icon" : ""}>↻</span>
                </button>
                <button onClick={() => { setShowManageWallets(false); setShowEvmConnectors(false); setShowSolanaWalletList(false); setShowSuiWalletList(false); }}
                  style={{ background:"none", border:"none", color:"rgba(255,255,255,0.4)",
                    cursor:"pointer", fontSize:20, padding:"4px 6px", borderRadius:6 }}>✕</button>
              </div>
            </div>

            <div style={{ padding:20, display:"flex", flexDirection:"column", gap:24 }}>

              {/* ── Section 1: Add New Wallet ── */}
              <div style={{ border:"1px solid rgba(255,255,255,0.08)", borderRadius:14, padding:16 }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
                  <span style={{ fontSize:14, fontWeight:700, color:"white" }}>Add New Wallet</span>
                  <button title="Watch any wallet address — read-only, no private keys needed"
                    style={{ background:"rgba(255,255,255,0.06)", border:"none", color:"rgba(255,255,255,0.4)",
                      cursor:"pointer", fontSize:12, width:22, height:22, borderRadius:"50%",
                      display:"flex", alignItems:"center", justifyContent:"center" }}>?</button>
                </div>
                <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
                  <input
                    type="text"
                    value={addWalletAddress}
                    onChange={(e) => { setAddWalletAddress(e.target.value); setAddWalletError(""); }}
                    onKeyDown={(e) => e.key === "Enter" && handleAddWatchedWallet()}
                    placeholder="Enter EVM, Solana, or SUI Address"
                    style={{ width:"100%", background:"#060d08", border:"1px solid rgba(255,255,255,0.1)",
                      color:"white", borderRadius:8, padding:"10px 12px", fontSize:13,
                      outline:"none", boxSizing:"border-box" }}
                  />
                  <input
                    type="text"
                    value={addWalletLabel}
                    onChange={(e) => setAddWalletLabel(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleAddWatchedWallet()}
                    placeholder="Label (Optional) — e.g., Main Wallet, Trading Account"
                    style={{ width:"100%", background:"#060d08", border:"1px solid rgba(255,255,255,0.1)",
                      color:"white", borderRadius:8, padding:"10px 12px", fontSize:13,
                      outline:"none", boxSizing:"border-box" }}
                  />
                  {addWalletError && (
                    <p style={{ color:"#ef4444", fontSize:12, margin:0 }}>{addWalletError}</p>
                  )}
                  <button
                    onClick={handleAddWatchedWallet}
                    style={{
                      width:"100%",
                      background: addWalletAddress.trim() ? "rgba(16,185,129,0.2)" : "rgba(255,255,255,0.04)",
                      border: `1px solid ${addWalletAddress.trim() ? "rgba(16,185,129,0.35)" : "rgba(255,255,255,0.08)"}`,
                      color: addWalletAddress.trim() ? "#6ee7b7" : "rgba(255,255,255,0.3)",
                      borderRadius:8, padding:"10px", fontSize:14, fontWeight:600,
                      cursor: addWalletAddress.trim() ? "pointer" : "default",
                    }}
                  >
                    Add Wallet
                  </button>
                  <div style={{ background:"rgba(16,185,129,0.07)", border:"1px solid rgba(16,185,129,0.15)",
                    borderRadius:8, padding:"10px 12px", display:"flex", alignItems:"flex-start", gap:10 }}>
                    <span style={{ color:"#34d399", fontSize:15, flexShrink:0, marginTop:1 }}>✓</span>
                    <p style={{ fontSize:12, color:"rgba(255,255,255,0.5)", margin:0, lineHeight:1.6 }}>
                      <strong style={{ color:"#6ee7b7" }}>100% Safe &amp; Read-Only.</strong>{" "}
                      We never connect to your wallet or request private keys. DefiDesh only reads public blockchain data.
                    </p>
                  </div>
                </div>
              </div>

              {/* ── Section 2: Connect Browser Wallet ── */}
              <div>
                <h3 style={{ fontSize:14, fontWeight:700, color:"white", margin:"0 0 12px" }}>Connect Browser Wallet</h3>
                <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                  {/* EVM */}
                  {mounted && address ? (
                    <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between",
                      background:"rgba(255,255,255,0.03)", border:"1px solid rgba(16,185,129,0.2)",
                      borderRadius:10, padding:"10px 14px" }}>
                      <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                        <span style={{ fontSize:20 }}>🦊</span>
                        <div>
                          <p style={{ fontSize:13, fontWeight:600, color:"white", margin:0 }}>EVM Wallet</p>
                          <p style={{ fontSize:11, color:"rgba(255,255,255,0.4)", margin:0, fontFamily:"monospace" }}>
                            {address.slice(0,8)}...{address.slice(-6)}
                          </p>
                        </div>
                      </div>
                      <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                        <span style={{ color:"#34d399", fontSize:13, fontWeight:600 }}>● Connected</span>
                        <button onClick={() => evmDisconnect()}
                          style={{ background:"rgba(239,68,68,0.1)", border:"1px solid rgba(239,68,68,0.2)",
                            color:"#ef4444", borderRadius:6, padding:"3px 10px", fontSize:12, cursor:"pointer" }}>
                          Disconnect
                        </button>
                      </div>
                    </div>
                  ) : mounted && (
                    <button onClick={() => setShowEvmConnectors(true)}
                      style={{ display:"flex", alignItems:"center", gap:10, background:"rgba(255,255,255,0.03)",
                        border:"1px solid rgba(255,255,255,0.08)", borderRadius:10, padding:"10px 14px",
                        width:"100%", cursor:"pointer", color:"white", textAlign:"left" }}>
                      <span style={{ fontSize:20 }}>🦊</span>
                      <span style={{ fontSize:13 }}>Connect EVM Wallet</span>
                    </button>
                  )}

                  {/* Solana */}
                  {mounted && solanaAddress ? (
                    <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between",
                      background:"rgba(255,255,255,0.03)", border:"1px solid rgba(153,69,255,0.3)",
                      borderRadius:10, padding:"10px 14px" }}>
                      <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                        <span style={{ fontSize:20 }}>◎</span>
                        <div>
                          <p style={{ fontSize:13, fontWeight:600, color:"white", margin:0 }}>Solana Wallet</p>
                          <p style={{ fontSize:11, color:"rgba(255,255,255,0.4)", margin:0, fontFamily:"monospace" }}>
                            {solanaAddress.slice(0,8)}...{solanaAddress.slice(-6)}
                          </p>
                        </div>
                      </div>
                      <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                        <span style={{ color:"#34d399", fontSize:13, fontWeight:600 }}>● Connected</span>
                        <button onClick={() => { setSolanaAddress(null); disconnectSolanaWallet(); }}
                          style={{ background:"rgba(239,68,68,0.1)", border:"1px solid rgba(239,68,68,0.2)",
                            color:"#ef4444", borderRadius:6, padding:"3px 10px", fontSize:12, cursor:"pointer" }}>
                          Disconnect
                        </button>
                      </div>
                    </div>
                  ) : mounted && (
                    <button onClick={() => setShowSolanaWalletList(true)}
                      style={{ display:"flex", alignItems:"center", gap:10, background:"rgba(255,255,255,0.03)",
                        border:"1px solid rgba(255,255,255,0.08)", borderRadius:10, padding:"10px 14px",
                        width:"100%", cursor:"pointer", color:"white", textAlign:"left" }}>
                      <span style={{ fontSize:20 }}>◎</span>
                      <span style={{ fontSize:13 }}>Connect Solana Wallet</span>
                    </button>
                  )}

                  {/* Sui */}
                  {mounted && suiAddress ? (
                    <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between",
                      background:"rgba(255,255,255,0.03)", border:"1px solid rgba(111,188,240,0.3)",
                      borderRadius:10, padding:"10px 14px" }}>
                      <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                        <span style={{ fontSize:20 }}>◈</span>
                        <div>
                          <p style={{ fontSize:13, fontWeight:600, color:"white", margin:0 }}>Sui Wallet</p>
                          <p style={{ fontSize:11, color:"rgba(255,255,255,0.4)", margin:0, fontFamily:"monospace" }}>
                            {suiAddress.slice(0,8)}...{suiAddress.slice(-6)}
                          </p>
                        </div>
                      </div>
                      <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                        <span style={{ color:"#34d399", fontSize:13, fontWeight:600 }}>● Connected</span>
                        <button onClick={() => { setSuiAddress(null); disconnectSuiWallet(); }}
                          style={{ background:"rgba(239,68,68,0.1)", border:"1px solid rgba(239,68,68,0.2)",
                            color:"#ef4444", borderRadius:6, padding:"3px 10px", fontSize:12, cursor:"pointer" }}>
                          Disconnect
                        </button>
                      </div>
                    </div>
                  ) : mounted && (
                    <button onClick={() => setShowSuiWalletList(true)}
                      style={{ display:"flex", alignItems:"center", gap:10, background:"rgba(255,255,255,0.03)",
                        border:"1px solid rgba(255,255,255,0.08)", borderRadius:10, padding:"10px 14px",
                        width:"100%", cursor:"pointer", color:"white", textAlign:"left" }}>
                      <span style={{ fontSize:20 }}>◈</span>
                      <span style={{ fontSize:13 }}>Connect Sui Wallet</span>
                    </button>
                  )}
                </div>
              </div>

              {/* ── Section 3: Your Wallets ── */}
              {(() => {
                type WalletEntry = { addr: string; label?: string; type: "browser" | "watched" };
                const evmWalletList: WalletEntry[] = [];
                const solWalletList: WalletEntry[] = [];
                const suiWalletList: WalletEntry[] = [];

                if (address) evmWalletList.push({ addr: address, type: "browser" });
                if (solanaAddress) solWalletList.push({ addr: solanaAddress, type: "browser" });
                if (suiAddress) suiWalletList.push({ addr: suiAddress, type: "browser" });

                for (const w of watchedWallets) {
                  const entry: WalletEntry = { addr: w.address, label: w.label, type: "watched" };
                  if (w.chain === "evm") evmWalletList.push(entry);
                  else if (w.chain === "solana") solWalletList.push(entry);
                  else if (w.chain === "sui") suiWalletList.push(entry);
                }

                const hasAny = evmWalletList.length > 0 || solWalletList.length > 0 || suiWalletList.length > 0;
                if (!hasAny) return null;

                const groups = [
                  { label: "EVM Wallets", icon: "⟠", wallets: evmWalletList },
                  { label: "Solana Wallets", icon: "◎", wallets: solWalletList },
                  { label: "Sui Wallets", icon: "◈", wallets: suiWalletList },
                ].filter((g) => g.wallets.length > 0);

                return (
                  <div>
                    <h3 style={{ fontSize:14, fontWeight:700, color:"white", margin:"0 0 12px" }}>Your Wallets</h3>
                    {groups.map((group) => (
                      <div key={group.label} style={{ marginBottom:16 }}>
                        <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8 }}>
                          <span style={{ color:"rgba(255,255,255,0.4)", fontSize:14 }}>{group.icon}</span>
                          <span style={{ fontSize:11, color:"rgba(255,255,255,0.4)", fontWeight:600,
                            textTransform:"uppercase", letterSpacing:1 }}>{group.label}</span>
                        </div>
                        <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                          {group.wallets.map((w) => {
                            const isEditing = editingWallet === w.addr;
                            return (
                              <div key={w.addr} style={{ background:"rgba(255,255,255,0.03)",
                                border:"1px solid rgba(255,255,255,0.06)", borderRadius:10,
                                padding:"10px 14px", display:"flex", alignItems:"center",
                                justifyContent:"space-between", gap:12 }}>
                                <div style={{ flex:1, overflow:"hidden" }}>
                                  {isEditing ? (
                                    <div style={{ display:"flex", gap:6, alignItems:"center" }}>
                                      <input
                                        autoFocus
                                        type="text"
                                        value={editLabelValue}
                                        onChange={(e) => setEditLabelValue(e.target.value)}
                                        onKeyDown={(e) => {
                                          if (e.key === "Enter") {
                                            const ww = watchedWallets.find((wl) => wl.address === w.addr);
                                            if (ww) updateLabel(ww.address, ww.chain, editLabelValue);
                                            setEditingWallet(null);
                                          }
                                          if (e.key === "Escape") setEditingWallet(null);
                                        }}
                                        style={{ background:"#060d08", border:"1px solid rgba(255,255,255,0.2)",
                                          color:"white", borderRadius:6, padding:"4px 8px",
                                          fontSize:12, outline:"none", flex:1 }}
                                      />
                                      <button onClick={() => {
                                        const ww = watchedWallets.find((wl) => wl.address === w.addr);
                                        if (ww) updateLabel(ww.address, ww.chain, editLabelValue);
                                        setEditingWallet(null);
                                      }} style={{ color:"#34d399", background:"none", border:"none",
                                        cursor:"pointer", fontSize:12, whiteSpace:"nowrap" }}>Save</button>
                                      <button onClick={() => setEditingWallet(null)}
                                        style={{ color:"rgba(255,255,255,0.4)", background:"none",
                                          border:"none", cursor:"pointer", fontSize:12 }}>✕</button>
                                    </div>
                                  ) : (
                                    <div>
                                      <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:3 }}>
                                        <span style={{ fontSize:13, fontWeight:600, color:"white" }}>
                                          {w.label || (w.type === "browser" ? group.label.replace(" Wallets","") : "Watched")}
                                        </span>
                                        {w.type === "watched" && (
                                          <button
                                            onClick={() => { setEditingWallet(w.addr); setEditLabelValue(w.label ?? ""); }}
                                            style={{ color:"rgba(255,255,255,0.3)", background:"none",
                                              border:"none", cursor:"pointer", fontSize:12, padding:0 }}
                                            title="Edit label"
                                          >✎</button>
                                        )}
                                        <span style={{ fontSize:10,
                                          color: w.type === "browser" ? "#6ee7b7" : "rgba(255,255,255,0.35)",
                                          background: w.type === "browser" ? "rgba(16,185,129,0.1)" : "rgba(255,255,255,0.05)",
                                          borderRadius:4, padding:"1px 6px", marginLeft:2 }}>
                                          {w.type === "browser" ? "Browser" : "Watched"}
                                        </span>
                                      </div>
                                      <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                                        <span style={{ fontSize:11, color:"rgba(255,255,255,0.35)", fontFamily:"monospace" }}>
                                          {w.addr.slice(0,8)}...{w.addr.slice(-6)}
                                        </span>
                                        <button
                                          onClick={() => navigator.clipboard.writeText(w.addr)}
                                          style={{ color:"rgba(255,255,255,0.3)", background:"none",
                                            border:"none", cursor:"pointer", fontSize:12, padding:0 }}
                                          title="Copy address"
                                        >⧉</button>
                                      </div>
                                    </div>
                                  )}
                                </div>
                                <div style={{ display:"flex", alignItems:"center", gap:8, flexShrink:0 }}>
                                  <span style={{ color:"#34d399", fontSize:14 }}>✓</span>
                                  {w.type === "watched" ? (
                                    <button
                                      onClick={() => {
                                        const ww = watchedWallets.find((wl) => wl.address === w.addr);
                                        if (ww) removeWallet(ww.address, ww.chain);
                                      }}
                                      title="Remove watched wallet"
                                      style={{ color:"#ef4444", background:"rgba(239,68,68,0.08)",
                                        border:"1px solid rgba(239,68,68,0.15)", borderRadius:6,
                                        padding:"3px 8px", fontSize:12, cursor:"pointer" }}
                                    >🗑</button>
                                  ) : (
                                    <button
                                      onClick={() => {
                                        if (w.addr === address) evmDisconnect();
                                        else if (w.addr === solanaAddress) { setSolanaAddress(null); disconnectSolanaWallet(); }
                                        else if (w.addr === suiAddress) { setSuiAddress(null); disconnectSuiWallet(); }
                                      }}
                                      title="Disconnect wallet"
                                      style={{ color:"#ef4444", background:"rgba(239,68,68,0.08)",
                                        border:"1px solid rgba(239,68,68,0.15)", borderRadius:6,
                                        padding:"3px 8px", fontSize:12, cursor:"pointer" }}
                                    >✕</button>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })()}

            </div>

            {/* EVM wallet picker sub-modal */}
            {showEvmConnectors && (
              <div style={{ position:"absolute", inset:0, background:"rgba(0,0,0,0.75)",
                borderRadius:20, display:"flex", alignItems:"center", justifyContent:"center" }}>
                <div style={{ background:"#070e09", border:"1px solid rgba(255,255,255,0.1)",
                  borderRadius:14, padding:20, width:"85%", maxWidth:320 }}>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
                    <h3 style={{ fontSize:15, fontWeight:700, color:"white", margin:0 }}>Choose EVM Wallet</h3>
                    <button onClick={() => setShowEvmConnectors(false)}
                      style={{ color:"rgba(255,255,255,0.4)", background:"none", border:"none", cursor:"pointer", fontSize:18 }}>✕</button>
                  </div>
                  <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                    {connectors.map((connector, i) => (
                      <button key={connector.id}
                        onClick={() => { evmConnect({ connector: connectors[i] }); setShowEvmConnectors(false); }}
                        style={{ display:"flex", alignItems:"center", gap:12, background:"rgba(255,255,255,0.03)",
                          border:"1px solid rgba(255,255,255,0.08)", borderRadius:10, padding:"10px 14px",
                          width:"100%", cursor:"pointer", color:"white" }}>
                        <span style={{ fontSize:22 }}>{connector.name === "MetaMask" ? "🦊" : "🔗"}</span>
                        <div style={{ textAlign:"left" }}>
                          <p style={{ fontSize:14, fontWeight:500, color:"white", margin:0 }}>{connector.name}</p>
                          <p style={{ fontSize:11, color:"rgba(255,255,255,0.4)", margin:0 }}>Connect with browser extension</p>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Solana wallet picker sub-modal */}
            {showSolanaWalletList && (
              <div style={{ position:"absolute", inset:0, background:"rgba(0,0,0,0.75)",
                borderRadius:20, display:"flex", alignItems:"center", justifyContent:"center" }}>
                <div style={{ background:"#070e09", border:"1px solid rgba(153,69,255,0.3)",
                  borderRadius:14, padding:20, width:"85%", maxWidth:320 }}>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
                    <h3 style={{ fontSize:15, fontWeight:700, color:"white", margin:0 }}>Choose Solana Wallet</h3>
                    <button onClick={() => setShowSolanaWalletList(false)}
                      style={{ color:"rgba(255,255,255,0.4)", background:"none", border:"none", cursor:"pointer", fontSize:18 }}>✕</button>
                  </div>
                  {solanaWallets.length === 0 ? (
                    <p style={{ fontSize:13, color:"rgba(255,255,255,0.5)", textAlign:"center", padding:"8px 0" }}>
                      No Solana wallet detected. Install Phantom, Backpack, or Solflare.
                    </p>
                  ) : (
                    <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                      {solanaWallets.map((w) => (
                        <button key={w.adapter.name}
                          onClick={() => handleSolanaConnectFromModal(w.adapter.name)}
                          style={{ display:"flex", alignItems:"center", gap:12, background:"rgba(255,255,255,0.03)",
                            border:"1px solid rgba(255,255,255,0.08)", borderRadius:10, padding:"10px 14px",
                            width:"100%", cursor:"pointer", color:"white" }}>
                          {w.adapter.icon && (
                            <img src={w.adapter.icon} alt={w.adapter.name}
                              style={{ width:28, height:28, borderRadius:6 }} />
                          )}
                          <span style={{ fontSize:14 }}>{w.adapter.name}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Sui wallet picker sub-modal */}
            {showSuiWalletList && (
              <div style={{ position:"absolute", inset:0, background:"rgba(0,0,0,0.75)",
                borderRadius:20, display:"flex", alignItems:"center", justifyContent:"center" }}>
                <div style={{ background:"#070e09", border:"1px solid rgba(111,188,240,0.3)",
                  borderRadius:14, padding:20, width:"85%", maxWidth:320 }}>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
                    <h3 style={{ fontSize:15, fontWeight:700, color:"white", margin:0 }}>Choose Sui Wallet</h3>
                    <button onClick={() => setShowSuiWalletList(false)}
                      style={{ color:"rgba(255,255,255,0.4)", background:"none", border:"none", cursor:"pointer", fontSize:18 }}>✕</button>
                  </div>
                  {modalSuiWallets.length === 0 ? (
                    <p style={{ fontSize:13, color:"rgba(255,255,255,0.5)", textAlign:"center", padding:"8px 0" }}>
                      No Sui wallet detected. Install Phantom, Suiet, or Slush.
                    </p>
                  ) : (
                    <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                      {modalSuiWallets.map((w) => (
                        <button key={w.name}
                          onClick={() => handleSuiConnectFromModal(w)}
                          style={{ display:"flex", alignItems:"center", gap:12, background:"rgba(255,255,255,0.03)",
                            border:"1px solid rgba(255,255,255,0.08)", borderRadius:10, padding:"10px 14px",
                            width:"100%", cursor:"pointer", color:"white" }}>
                          {w.icon && (
                            <img src={w.icon} alt={w.name}
                              style={{ width:28, height:28, borderRadius:6 }} />
                          )}
                          <span style={{ fontSize:14 }}>{w.name}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

          </div>
        </div>
      )}

    </div>
  );
}
