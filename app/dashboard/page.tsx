"use client";

import { useState, useMemo, useEffect, useRef, type CSSProperties } from "react";
import Link from "next/link";
import TerminalNavbar from "../components/TerminalNavbar";
import DashboardSidebar, { type NavSection } from "../components/DashboardSidebar";
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

const STATUS_FILTERS = ["In Range", "Out of Range", "Closed", "All"] as const;
type StatusFilter = typeof STATUS_FILTERS[number];

const CHAIN_FILTERS = ["ALL", "EVM", "SOLANA", "SUI"] as const;
type ChainFilter = typeof CHAIN_FILTERS[number];

const EVM_CHAINS = new Set(["Base", "Ethereum", "Arbitrum", "Optimism", "Polygon", "Avalanche", "HyperEVM", "BNB Chain"]);
function chainCategory(chain: string): "EVM" | "SOLANA" | "SUI" | "OTHER" {
  if (chain === "Solana") return "SOLANA";
  if (chain === "Sui")    return "SUI";
  if (EVM_CHAINS.has(chain)) return "EVM";
  return "OTHER";
}

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

export const TOKEN_COLORS: Record<string, string> = {
  ETH: "#627EEA", WETH: "#627EEA",
  USDC: "#2775CA", "USDC.e": "#2775CA", USDbC: "#2775CA",
  USDT: "#26A17B",
  BTC: "#F7931A", WBTC: "#F7931A", cbBTC: "#F7931A", tBTC: "#F7931A",
  SOL: "#9945FF", WSOL: "#9945FF",
  SUI: "#6FBCF0",
  HYPE: "#00D4AA", WHYPE: "#00D4AA",
  DAI: "#F5AC37",
  BNB: "#F0B90B", WBNB: "#F0B90B",
  MATIC: "#8247E5", POL: "#8247E5",
  AVAX: "#E84142",
  ARB: "#2D9CDB",
  OP: "#FF0420",
  USDS: "#26A17B",
};

export function getTokenColor(symbol: string): string {
  return TOKEN_COLORS[symbol] ?? "#6B7280";
}

const C = {
  bg: "#000000",
  card: "#090909",
  border: "#1c1c1c",
  green: "#00ff41",
  greenSoft: "rgba(0,255,65,0.08)",
  amber: "#f59e0b",
  amberSoft: "rgba(245,158,11,0.08)",
  red: "#ff3355",
  redSoft: "rgba(255,51,85,0.08)",
  text: "#e8e8e8",
  textDim: "#c8c8c8",
  muted: "#7a7a7a",
  mute2: "#555555",
  mute3: "#333333",
} as const;

const SCANLINE_BG =
  "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.03) 2px, rgba(0,0,0,0.03) 4px)";

// ── TokenCircle ───────────────────────────────────────────────────────────────
function TokenCircle({
  symbol, size = 32, style,
}: { symbol: string; size?: number; style?: CSSProperties }) {
  const [imgError, setImgError] = useState(false);
  const logoUrl = getTokenLogo(symbol);
  const color = TOKEN_COLORS[symbol] ?? TOKEN_COLORS[symbol.toUpperCase()] ?? "#6B7280";
  const shared: CSSProperties = {
    width: size, height: size, borderRadius: "50%",
    border: `2px solid ${C.bg}`, flexShrink: 0, ...style,
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

function healthPctFor(status: "In Range" | "Out of Range" | "Closed"): number {
  if (status === "In Range") return 100;
  if (status === "Out of Range") return 50;
  return 0;
}

// ── Reusable bits ─────────────────────────────────────────────────────────────
function SectionHeader({ label, right }: { label: string; right?: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        marginBottom: 16,
        fontSize: 10,
        letterSpacing: "0.2em",
        textTransform: "uppercase",
        color: C.mute2,
      }}
    >
      <span style={{ color: C.green }}>//</span>
      <span>{label}</span>
      <span style={{ flex: 1, height: 1, background: "rgba(0,255,65,0.12)" }} />
      {right}
    </div>
  );
}

const cardStyle: CSSProperties = {
  background: C.card,
  border: `1px solid ${C.border}`,
  padding: 20,
};

const statusTagStyle = (status: "In Range" | "Out of Range" | "Closed"): CSSProperties => {
  if (status === "In Range") {
    return { background: "rgba(0,255,65,0.08)", border: `1px solid ${C.green}`, color: C.green };
  }
  if (status === "Out of Range") {
    return { background: C.amberSoft, border: `1px solid ${C.amber}`, color: C.amber };
  }
  return { background: "transparent", border: `1px solid ${C.border}`, color: C.mute2 };
};

// ── Component ─────────────────────────────────────────────────────────────────
export default function Dashboard() {
  const { positions: allPositions, isLoading, isFetching, dataUpdatedAt, refetch } = usePositions();
  const { address } = useAccount();
  const { connect: evmConnect, connectors } = useConnect();
  const { disconnect: evmDisconnect } = useDisconnect();
  const { solanaAddress, suiAddress, setSolanaAddress, setSuiAddress } = useWalletAuth();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const { select: solanaSelect, connect: connectSolanaWallet, disconnect: disconnectSolanaWallet,
    connected: adapterSolanaConnected, publicKey: adapterPublicKey, wallets: solanaWallets } = useWallet();
  const awaitingSolanaConnectModal = useRef(false);

  const adapterSuiAccount = useCurrentAccount();
  const modalSuiWallets = useWallets();
  const { mutateAsync: connectSuiAsync } = useConnectWallet();
  const { mutate: disconnectSuiWallet } = useDisconnectWallet();
  const awaitingSuiConnectModal = useRef(false);

  useEffect(() => {
    if (awaitingSolanaConnectModal.current && adapterSolanaConnected && adapterPublicKey) {
      setSolanaAddress(adapterPublicKey.toBase58());
      awaitingSolanaConnectModal.current = false;
    }
  }, [adapterSolanaConnected, adapterPublicKey, setSolanaAddress]);

  useEffect(() => {
    if (awaitingSuiConnectModal.current && adapterSuiAccount) {
      setSuiAddress(adapterSuiAccount.address);
      awaitingSuiConnectModal.current = false;
    }
  }, [adapterSuiAccount, setSuiAddress]);

  const { watchedWallets, addWallet, removeWallet, updateLabel } = useWatchedWallets();
  const hasWallet = mounted && (!!(address || solanaAddress || suiAddress) || watchedWallets.length > 0);

  const {
    totalTokenValue, totalLendingValue,
    tokenCount, lendingCount,
    isLoading: walletTokensLoading,
  } = useWalletTokens();

  const { positions: externalLendingPositions } = useLendingPositions();
  const externalLendingValue = externalLendingPositions.reduce((s, p) => s + p.totalSupplied, 0);
  const externalLendingCount = externalLendingPositions.length;
  const combinedLendingValue = totalLendingValue + externalLendingValue;
  const combinedLendingCount = lendingCount + externalLendingCount;

  // Names of lending protocols the user actually has positions in (drives sidebar live dots)
  const lendingProtocolNames = useMemo(
    () => Array.from(new Set(externalLendingPositions.map((p) => p.protocol))),
    [externalLendingPositions],
  );

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

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("In Range");
  const [chainFilter, setChainFilter] = useState<ChainFilter>("ALL");
  const [activeSection, setActiveSection] = useState<NavSection>("overview");

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

  // Filtered + sorted positions
  const filtered = useMemo(() => {
    let result = allPositions;
    if (statusFilter !== "All") result = result.filter((p) => effectiveStatus(p) === statusFilter);
    if (chainFilter !== "ALL") result = result.filter((p) => chainCategory(p.chain) === chainFilter);
    const STATUS_ORDER: Record<string, number> = { "In Range": 0, "Out of Range": 1, Closed: 2 };
    return [...result].sort(
      (a, b) => (STATUS_ORDER[effectiveStatus(a)] ?? 1) - (STATUS_ORDER[effectiveStatus(b)] ?? 1),
    );
  }, [allPositions, statusFilter, chainFilter]);

  const totalValue   = allPositions.reduce((s, p) => s + p.value, 0);
  const totalFees    = allPositions.reduce((s, p) => s + p.fees, 0);
  const uniqueChains = new Set(allPositions.filter((p) => p.value > 0).map((p) => p.chain)).size;

  const { dailyCashflow, hasCashflowData } = useMemo(() => {
    const active = allPositions.filter((p) => p.apy > 0 && p.value > 0);
    if (!active.length) return { dailyCashflow: 0, hasCashflowData: false };
    const yearly = active.reduce((s, p) => s + (p.value * p.apy) / 100, 0);
    return { dailyCashflow: yearly / 365, hasCashflowData: true };
  }, [allPositions]);

  // Value-weighted APY
  const avgApr = useMemo(() => {
    const active = allPositions.filter((p) => p.value > 0 && p.apy > 0);
    if (!active.length) return null;
    const w = active.reduce((s, p) => s + p.value, 0);
    return w > 0 ? active.reduce((s, p) => s + p.apy * p.value, 0) / w : null;
  }, [allPositions]);

  // Simple unweighted average APY (for the "Avg APY" header column)
  const avgApySimple = useMemo(() => {
    const active = allPositions.filter((p) => p.value > 0 && p.apy > 0);
    if (!active.length) return null;
    return active.reduce((s, p) => s + p.apy, 0) / active.length;
  }, [allPositions]);

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

  const [rangeKey, setRangeKey] = useState<typeof TIME_RANGES[number]["key"]>("30D");
  const portfolioHistory = usePortfolioHistory(totalValue, allPositions.length, dataUpdatedAt);
  const activeRange    = TIME_RANGES.find((r) => r.key === rangeKey) ?? TIME_RANGES[2];
  const rangeCutoff    = Date.now() - activeRange.ms;
  const rangedHistory  = portfolioHistory.filter((s) => s.timestamp >= rangeCutoff);
  const effectiveHistory = rangedHistory.length >= 2 ? rangedHistory : portfolioHistory;
  const chartData = effectiveHistory.map((s) => ({
    label: activeRange.xFmt(new Date(s.timestamp)),
    value: s.totalValue,
  }));

  const chartBaseline = effectiveHistory.length >= 2 ? effectiveHistory[0].totalValue : 0;
  const chartPnlAvailable = effectiveHistory.length >= 2 && chartBaseline > 0;
  const chartPnlDollar = chartPnlAvailable ? totalValue - chartBaseline : 0;
  const chartPnlPct    = chartPnlAvailable ? (chartPnlDollar / chartBaseline) * 100 : 0;

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

  const saveReport = () => {
    const report = {
      exportedAt: new Date().toISOString(),
      summary: {
        totalValue,
        totalFees,
        uniqueChains,
        totalPositions: allPositions.length,
        dailyCashflow,
        avgApyWeighted: avgApr,
        avgApySimple,
        totalTokenValue,
        combinedLendingValue,
        tokenCount,
        combinedLendingCount,
      },
      protocolBreakdown,
      chainBreakdown,
      positions: allPositions.map((p) => ({
        id: p.id,
        pair: p.pair,
        protocol: p.protocol,
        chain: p.chain,
        value: p.value,
        apy: p.apy,
        fees: p.fees,
        status: effectiveStatus(p),
      })),
      lendingPositions: externalLendingPositions,
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    a.href = url; a.download = `defidesh-report-${stamp}.json`; a.click();
    URL.revokeObjectURL(url);
  };

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

  // Smooth-scroll on sidebar nav click
  function handleSectionChange(id: NavSection) {
    setActiveSection(id);
    if (typeof document !== "undefined") {
      const el = document.getElementById(`section-${id}`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  // Suppress unused-var lint
  void secondsAgo;
  void getTickPriceUSD;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div
      style={{
        background: C.bg,
        minHeight: "100vh",
        color: C.textDim,
        fontFamily: "var(--font-jetbrains-mono), 'Courier New', monospace",
        fontSize: 13,
        lineHeight: 1.6,
      }}
    >
      <style>{`
        @keyframes _spin { from { transform:rotate(0deg) } to { transform:rotate(360deg) } }
        .spin-icon { display:inline-block; animation: _spin 1s linear infinite; }
        .pos-row   { transition: border-color 0.15s, background 0.15s; }
        .pos-row.in-range:hover  { border-color: ${C.green} !important; }
        .pos-row.out-range:hover { border-color: ${C.amber} !important; }
        .pos-row.closed:hover    { border-color: ${C.mute3} !important; }
        .term-tab:hover          { color: ${C.green} !important; }
        .term-tab[data-active="true"]:hover { color: ${C.bg} !important; }
        .term-btn:hover          { background: ${C.greenSoft} !important; color: ${C.green} !important; border-color: ${C.green} !important; }
        @media (max-width:1100px) {
          .pos-pnl   { display:none !important; }
        }
        @media (max-width:900px) {
          .pos-health{ display:none !important; }
        }
        @media (max-width:760px) {
          .hero-big-num { font-size:36px !important; letter-spacing:-1px !important; }
          .pos-grid    { grid-template-columns: 1.6fr 1fr 1fr 110px 90px !important; }
          .pos-apr     { display:none !important; }
        }
        @media (max-width:520px) {
          .pos-grid    { grid-template-columns: 1.6fr 1fr 90px !important; }
          .pos-val-fees{ display:none !important; }
          .pos-manage  { display:none !important; }
        }
      `}</style>

      {/* Scanline overlay */}
      <div
        aria-hidden
        className="fixed inset-0 pointer-events-none z-[9999]"
        style={{ background: SCANLINE_BG }}
      />

      <TerminalNavbar />

      {/* Layout: sidebar + main */}
      <div style={{ display: "flex", alignItems: "flex-start", minHeight: "calc(100vh - 52px)" }}>
        <DashboardSidebar
          activeSection={activeSection}
          onSectionChange={handleSectionChange}
          positions={allPositions}
          lendingProtocolNames={lendingProtocolNames}
          evmAddr={address ?? null}
          solAddr={solanaAddress}
          suiAddr={suiAddress}
          watchedWallets={watchedWallets}
          onAddWallet={() => setShowManageWallets(true)}
        />

        <main style={{ flex: 1, minWidth: 0 }}>
          {/* ── Section: overview ─────────────────────────────────────────── */}
          <section
            id="section-overview"
            style={{
              padding: "32px 28px 28px",
              borderBottom: `1px solid ${C.border}`,
            }}
          >
            <SectionHeader
              label="portfolio_overview.live"
              right={
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 10,
                    color: C.green,
                    letterSpacing: "0.1em",
                  }}
                >
                  <span
                    className="animate-pulse"
                    style={{ width: 5, height: 5, background: C.green, display: "inline-block" }}
                  />
                  LIVE
                </span>
              }
            />

            <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontSize: 10, letterSpacing: "0.18em", textTransform: "uppercase", color: C.mute2, marginBottom: 8 }}>
                  Total Portfolio Value
                </div>
                <div
                  className="hero-big-num"
                  style={{
                    fontSize: "clamp(40px, 5.4vw, 72px)",
                    fontWeight: 700,
                    color: C.text,
                    letterSpacing: "-0.02em",
                    lineHeight: 1.05,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {fmt$(totalValue)}
                </div>
              </div>

              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button
                  type="button"
                  className="term-btn"
                  onClick={() => { if (!isFetching) refetch(); }}
                  aria-disabled={isFetching}
                  style={{
                    background: C.card,
                    border: `1px solid ${C.border}`,
                    color: C.textDim,
                    padding: "9px 16px",
                    fontSize: 11,
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                    fontFamily: "var(--font-jetbrains-mono)",
                    cursor: isFetching ? "not-allowed" : "pointer",
                    opacity: isFetching ? 0.6 : 1,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <span className={isFetching ? "spin-icon" : ""}>↻</span>
                  {isFetching ? "REFRESHING…" : "REFRESH"}
                </button>
                <button
                  type="button"
                  onClick={() => setShowManageWallets(true)}
                  style={{
                    background: C.card,
                    border: `1px solid ${C.border}`,
                    color: C.textDim,
                    padding: "9px 16px",
                    fontSize: 11,
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                    fontFamily: "var(--font-jetbrains-mono)",
                    cursor: "pointer",
                  }}
                  className="term-btn"
                >
                  ▸ Manage Wallets
                </button>
                <button
                  type="button"
                  onClick={saveReport}
                  style={{
                    background: C.green,
                    border: `1px solid ${C.green}`,
                    color: "#000",
                    padding: "9px 16px",
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                    fontFamily: "var(--font-jetbrains-mono)",
                    cursor: "pointer",
                  }}
                  title="Download a JSON snapshot of the full dashboard state"
                >
                  ▸ Save Report
                </button>
              </div>
            </div>

            {/* 6-column metric strip */}
            <div
              style={{
                marginTop: 24,
                borderTop: `1px solid ${C.border}`,
                paddingTop: 18,
                display: "grid",
                gridTemplateColumns: "repeat(6, minmax(0, 1fr))",
                gap: 0,
              }}
            >
              {[
                { label: "Positions",   value: String(allPositions.length),                                 color: C.text },
                { label: "Chains",      value: uniqueChains > 0 ? String(uniqueChains) : "—",               color: C.text },
                { label: "APY",         value: avgApr !== null      ? `${avgApr.toFixed(1)}%`      : "N/A", color: C.green },
                { label: "Avg APY",     value: avgApySimple !== null ? `${avgApySimple.toFixed(1)}%` : "N/A", color: C.green },
                { label: "Uncollected", value: totalFees > 0 ? fmt$(totalFees) : "—",                       color: C.green },
                { label: "Daily Yield", value: hasCashflowData ? `+${fmt$(dailyCashflow)}` : "N/A",         color: C.green },
              ].map(({ label, value, color }, i, arr) => (
                <div
                  key={label}
                  style={{
                    paddingLeft: i === 0 ? 0 : 16,
                    paddingRight: i === arr.length - 1 ? 0 : 16,
                    borderRight: i < arr.length - 1 ? `1px solid ${C.border}` : "none",
                  }}
                >
                  <div
                    style={{
                      fontSize: 9,
                      letterSpacing: "0.16em",
                      textTransform: "uppercase",
                      color: C.mute2,
                      marginBottom: 4,
                    }}
                  >
                    {label}
                  </div>
                  <div
                    style={{
                      fontSize: 18,
                      fontWeight: 600,
                      color,
                      fontVariantNumeric: "tabular-nums",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {value}
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* ── Section: charts (allocation + chain + history) ────────────── */}
          {mounted && (
            <section
              id="section-charts"
              style={{ padding: "28px 28px", borderBottom: `1px solid ${C.border}` }}
            >
              {allPositions.some((p) => p.value > 0) && (
                <>
                  <SectionHeader label="portfolio_allocation" />
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))",
                      gap: 0,
                      marginBottom: 24,
                    }}
                  >
                    {/* Allocation by Protocol */}
                    <div style={cardStyle}>
                      <div style={{ fontSize: 10, letterSpacing: "0.16em", textTransform: "uppercase", color: C.mute2, marginBottom: 14 }}>
                        Protocol Allocation
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                        <div style={{ flexShrink: 0 }}>
                          <ResponsiveContainer width={130} height={130}>
                            <PieChart>
                              <Pie data={protocolBreakdown} cx="50%" cy="50%"
                                innerRadius={38} outerRadius={62} dataKey="value" strokeWidth={0}>
                                {protocolBreakdown.map((entry) => (
                                  <Cell key={entry.name} fill={getProtocolColor(entry.name)} />
                                ))}
                              </Pie>
                              <Tooltip
                                contentStyle={{ backgroundColor: C.card, border: `1px solid ${C.border}`, borderRadius: 0, color: C.text, fontSize: 12 }}
                                itemStyle={{ color: C.text }}
                                labelStyle={{ color: C.mute2 }}
                                formatter={(v: number | undefined) => [fmt$(v ?? 0), ""]}
                              />
                            </PieChart>
                          </ResponsiveContainer>
                        </div>
                        <div style={{ flex: 1, overflow: "hidden" }}>
                          {protocolBreakdown.map((entry) => (
                            <div key={entry.name}
                              style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 6 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 6, overflow: "hidden" }}>
                                <div style={{ width: 8, height: 8, background: getProtocolColor(entry.name), flexShrink: 0 }} />
                                <span style={{ fontSize: 11, color: C.textDim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                  {entry.name}
                                </span>
                              </div>
                              <div style={{ fontSize: 11, textAlign: "right", flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
                                <span style={{ color: C.text, fontWeight: 500 }}>{fmt$(entry.value, 0)}</span>
                                <span style={{ color: C.mute2, marginLeft: 4 }}>
                                  ({totalValue > 0 ? ((entry.value / totalValue) * 100).toFixed(1) : "0"}%)
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>

                    {/* Chain Distribution */}
                    <div style={cardStyle}>
                      <div style={{ fontSize: 10, letterSpacing: "0.16em", textTransform: "uppercase", color: C.mute2, marginBottom: 14 }}>
                        Chain Distribution
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                        {chainBreakdown.map((entry) => {
                          const pct = totalValue > 0 ? (entry.value / totalValue) * 100 : 0;
                          return (
                            <div key={entry.chain}>
                              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                  <div style={{ width: 8, height: 8, background: getChainColor(entry.chain) }} />
                                  <span style={{ fontSize: 11, color: C.textDim }}>{entry.chain}</span>
                                </div>
                                <div style={{ fontSize: 11, fontVariantNumeric: "tabular-nums" }}>
                                  <span style={{ color: C.text }}>{fmt$(entry.value, 0)}</span>
                                  <span style={{ color: C.mute2, marginLeft: 4 }}>({pct.toFixed(1)}%)</span>
                                </div>
                              </div>
                              <div style={{ height: 3, background: C.bg, border: `1px solid ${C.border}`, overflow: "hidden" }}>
                                <div style={{ height: "100%", background: getChainColor(entry.chain), width: `${pct}%` }} />
                              </div>
                            </div>
                          );
                        })}
                        {chainBreakdown.length === 0 && (
                          <div style={{ color: C.mute2, fontSize: 12 }}>No chain data</div>
                        )}
                      </div>
                    </div>
                  </div>
                </>
              )}

              {/* Portfolio History */}
              {hasWallet && (
                <>
                  <SectionHeader label="portfolio_history" />
                  <div style={cardStyle}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        marginBottom: 16,
                        flexWrap: "wrap",
                        gap: 12,
                      }}
                    >
                      <div style={{ display: "flex", border: `1px solid ${C.border}` }}>
                        {TIME_RANGES.map((r, i, arr) => {
                          const snapshotHasData = portfolioHistory.filter((s) => s.timestamp >= Date.now() - r.ms).length >= 2;
                          const active = rangeKey === r.key;
                          return (
                            <button
                              key={r.key}
                              onClick={() => setRangeKey(r.key)}
                              data-active={active}
                              className="term-tab"
                              style={{
                                padding: "5px 12px",
                                border: "none",
                                borderRight: i < arr.length - 1 ? `1px solid ${C.border}` : "none",
                                fontSize: 11,
                                fontWeight: 600,
                                letterSpacing: "0.06em",
                                fontFamily: "var(--font-jetbrains-mono)",
                                cursor: "pointer",
                                background: active ? C.green : "transparent",
                                color: active ? "#000" : (snapshotHasData ? C.textDim : C.mute3),
                              }}
                            >
                              {r.key}
                            </button>
                          );
                        })}
                      </div>
                      {chartPnlAvailable && (
                        <div
                          style={{
                            fontSize: 12,
                            fontWeight: 500,
                            color: chartPnlDollar >= 0 ? C.green : C.red,
                            fontVariantNumeric: "tabular-nums",
                          }}
                        >
                          {chartPnlDollar >= 0 ? "+" : ""}{fmt$(Math.abs(chartPnlDollar))}{" "}
                          <span style={{ opacity: 0.75 }}>
                            ({chartPnlDollar >= 0 ? "+" : ""}{chartPnlPct.toFixed(2)}%)
                          </span>
                          <span style={{ color: C.mute2, fontWeight: 400, marginLeft: 6 }}>
                            {activeRange.label}
                          </span>
                        </div>
                      )}
                    </div>
                    {portfolioHistory.length < 2 ? (
                      <div style={{ textAlign: "center", padding: "32px 0" }}>
                        <div style={{ fontSize: 12, color: C.mute2 }}>
                          Tracking started — chart appears after the next refresh.
                        </div>
                        <div style={{ fontSize: 10, color: C.mute3, marginTop: 4, letterSpacing: "0.06em" }}>
                          A data point is saved on every 60-second refresh.
                        </div>
                      </div>
                    ) : (
                      <ResponsiveContainer width="100%" height={200}>
                        <LineChart data={chartData} margin={{ top: 4, right: 16, left: 8, bottom: 4 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                          <XAxis dataKey="label" tick={{ fill: C.mute2, fontSize: 11 }}
                            axisLine={false} tickLine={false} interval="preserveStartEnd" />
                          <YAxis tick={{ fill: C.mute2, fontSize: 11 }}
                            axisLine={false} tickLine={false} width={72}
                            tickFormatter={(v) => `$${Number(v).toLocaleString("en-US", { maximumFractionDigits: 0 })}`} />
                          <Tooltip
                            contentStyle={{ backgroundColor: C.card, border: `1px solid ${C.border}`, borderRadius: 0, color: C.text }}
                            itemStyle={{ color: C.green }}
                            labelStyle={{ color: C.mute2, marginBottom: 4 }}
                            formatter={(v: number | undefined) => [fmt$(v ?? 0), "Portfolio Value"]}
                          />
                          <Line type="monotone" dataKey="value" stroke={C.green} strokeWidth={2}
                            dot={chartData.length <= 20}
                            activeDot={{ r: 4, fill: C.green }} />
                        </LineChart>
                      </ResponsiveContainer>
                    )}
                  </div>
                </>
              )}
            </section>
          )}

          {/* ── Section: cashflow (4 yield blocks) ────────────────────────── */}
          <section
            id="section-cashflow"
            style={{ padding: "28px 28px", borderBottom: `1px solid ${C.border}` }}
          >
            <SectionHeader label="cash_flow" />
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                gap: 0,
              }}
            >
              {[
                { label: "Daily Yield",       value: hasCashflowData ? dailyCashflow      : null, color: C.green, prefix: "+" },
                { label: "Weekly",            value: hasCashflowData ? dailyCashflow * 7  : null, color: C.green, prefix: "+" },
                { label: "Monthly",           value: hasCashflowData ? dailyCashflow * 30 : null, color: C.green, prefix: "+" },
                { label: "Total Uncollected", value: totalFees > 0   ? totalFees          : null, color: C.green, prefix: "+" },
              ].map(({ label, value, color, prefix }) => (
                <div
                  key={label}
                  style={{
                    background: C.card,
                    border: `1px solid ${C.border}`,
                    padding: "20px 24px",
                  }}
                >
                  <div
                    style={{
                      fontSize: 9,
                      letterSpacing: "0.18em",
                      textTransform: "uppercase",
                      color: C.mute2,
                      marginBottom: 8,
                    }}
                  >
                    {label}
                  </div>
                  <div
                    style={{
                      fontSize: 22,
                      fontWeight: 700,
                      color: value !== null ? color : C.mute2,
                      fontVariantNumeric: "tabular-nums",
                      letterSpacing: "-0.02em",
                    }}
                  >
                    {value !== null ? `${prefix}${fmt$(value)}` : "—"}
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* ── Section: positions ───────────────────────────────────────── */}
          <section
            id="section-positions"
            style={{ padding: "28px 28px 56px" }}
          >
            <SectionHeader
              label="open_positions"
              right={
                <button
                  onClick={exportCSV}
                  className="term-btn"
                  style={{
                    background: C.card,
                    border: `1px solid ${C.border}`,
                    color: C.textDim,
                    padding: "6px 12px",
                    fontSize: 10,
                    letterSpacing: "0.12em",
                    textTransform: "uppercase",
                    fontFamily: "var(--font-jetbrains-mono)",
                    cursor: "pointer",
                  }}
                >
                  ▸ Export.csv
                </button>
              }
            />

            {/* Status filter tabs */}
            <div style={{ display: "flex", border: `1px solid ${C.border}`, marginBottom: 8, flexWrap: "wrap" }}>
              {STATUS_FILTERS.map((s, i) => {
                const active = statusFilter === s;
                const count =
                  s === "All"
                    ? allPositions.length
                    : allPositions.filter((p) => effectiveStatus(p) === s).length;
                return (
                  <button
                    key={s}
                    onClick={() => setStatusFilter(s)}
                    data-active={active}
                    className="term-tab"
                    style={{
                      background: active ? C.green : "transparent",
                      color: active ? "#000" : C.mute2,
                      border: "none",
                      borderRight: i < STATUS_FILTERS.length - 1 ? `1px solid ${C.border}` : "none",
                      padding: "8px 14px",
                      fontSize: 11,
                      letterSpacing: "0.08em",
                      textTransform: "uppercase",
                      fontFamily: "var(--font-jetbrains-mono)",
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    {s === "All" ? "All" : s}{" "}
                    <span style={{ opacity: 0.7 }}>({count})</span>
                  </button>
                );
              })}
            </div>

            {/* Chain filter tabs */}
            <div style={{ display: "flex", border: `1px solid ${C.border}`, marginBottom: 18, flexWrap: "wrap" }}>
              {CHAIN_FILTERS.map((c, i) => {
                const active = chainFilter === c;
                const count =
                  c === "ALL"
                    ? allPositions.length
                    : allPositions.filter((p) => chainCategory(p.chain) === c).length;
                return (
                  <button
                    key={c}
                    onClick={() => setChainFilter(c)}
                    data-active={active}
                    className="term-tab"
                    style={{
                      background: active ? C.green : "transparent",
                      color: active ? "#000" : C.mute2,
                      border: "none",
                      borderRight: i < CHAIN_FILTERS.length - 1 ? `1px solid ${C.border}` : "none",
                      padding: "7px 14px",
                      fontSize: 10,
                      letterSpacing: "0.14em",
                      textTransform: "uppercase",
                      fontFamily: "var(--font-jetbrains-mono)",
                      fontWeight: 700,
                      cursor: "pointer",
                    }}
                  >
                    {c} <span style={{ opacity: 0.7 }}>({count})</span>
                  </button>
                );
              })}
            </div>

            {/* Loading */}
            {mounted && isLoading && (
              <div style={{ textAlign: "center", padding: "64px 0", color: C.mute2 }}>
                <div
                  className="spin-icon"
                  style={{
                    width: 24, height: 24,
                    border: `2px solid ${C.green}`,
                    borderTopColor: "transparent",
                    margin: "0 auto 16px",
                    display: "block",
                  }}
                />
                <div style={{ fontSize: 12, letterSpacing: "0.08em" }}>Fetching your positions…</div>
              </div>
            )}

            {/* Empty states */}
            {!isLoading && mounted && filtered.length === 0 && (
              <div>
                {!hasWallet ? (
                  <div style={{ textAlign: "center", padding: "64px 0", color: C.textDim }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 8, letterSpacing: "0.06em" }}>
                      NO_WALLET_CONNECTED
                    </div>
                    <div style={{ color: C.mute2, marginBottom: 28, fontSize: 12, letterSpacing: "0.04em" }}>
                      Connect a wallet to track LP positions across EVM, Solana, and Sui.
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 10, fontSize: 11, color: C.mute2 }}>
                      {[
                        { chain: "EVM",    color: "#00e5ff", desc: "Ethereum · Base · Arbitrum · Optimism" },
                        { chain: "SOLANA", color: "#9945ff", desc: "Raydium · Orca" },
                        { chain: "SUI",    color: "#4da2ff", desc: "Bluefin · Cetus" },
                      ].map(({ chain, color, desc }) => (
                        <div key={chain} style={{
                          background: C.card,
                          border: `1px solid ${C.border}`,
                          padding: "10px 14px",
                          display: "flex", alignItems: "center", gap: 8,
                        }}>
                          <span style={{ color, fontWeight: 700, letterSpacing: "0.1em" }}>{chain}</span>
                          <span style={{ color: C.mute2 }}>{desc}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : allPositions.length === 0 ? (
                  <div style={{ textAlign: "center", padding: "64px 0" }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 8, letterSpacing: "0.06em" }}>
                      NO_POSITIONS_FOUND
                    </div>
                    <div style={{ color: C.mute2, fontSize: 12 }}>
                      No LP positions were found for your connected wallet(s).
                    </div>
                  </div>
                ) : (
                  <div style={{ textAlign: "center", padding: "48px 0", color: C.mute2, fontSize: 12 }}>
                    No positions match this filter.
                  </div>
                )}
              </div>
            )}

            {/* Position table */}
            {!isLoading && filtered.length > 0 && (
              <>
                {/* Header row */}
                <div
                  className="pos-grid"
                  style={{
                    display: "grid",
                    gridTemplateColumns: "minmax(220px, 2.2fr) 1fr 1fr minmax(120px, 1.2fr) minmax(80px, 0.8fr) 130px 90px",
                    alignItems: "center",
                    gap: 16,
                    padding: "10px 16px",
                    background: C.bg,
                    borderTop: `1px solid ${C.border}`,
                    borderLeft: `1px solid ${C.border}`,
                    borderRight: `1px solid ${C.border}`,
                    fontSize: 9,
                    letterSpacing: "0.16em",
                    textTransform: "uppercase",
                    color: C.mute2,
                  }}
                >
                  <span>Position</span>
                  <span className="pos-val-fees">Value · Fees</span>
                  <span className="pos-apr">APR · Daily</span>
                  <span className="pos-pnl">P&amp;L</span>
                  <span className="pos-health" style={{ textAlign: "right" }}>Health</span>
                  <span style={{ textAlign: "right" }}>Status</span>
                  <span className="pos-manage" style={{ textAlign: "right" }}>Action</span>
                </div>

                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 0,
                  }}
                >
                  {filtered.map((pos) => {
                    const posStatus = effectiveStatus(pos);
                    const isClosed = posStatus === "Closed";
                    const slug = encodeURIComponent(pos.id);
                    const dailyEarnings =
                      pos.apy > 0 && pos.value > 0 ? (pos.value * pos.apy) / 100 / 365 : null;
                    const statusClass =
                      posStatus === "In Range" ? "in-range"
                      : posStatus === "Out of Range" ? "out-range"
                      : "closed";
                    const feeRatio = pos.value > 0 ? (pos.fees / pos.value) * 100 : 0;
                    // Visualise small fee ratios — clamp at 100% bar fill
                    const pnlBarPct = Math.max(0, Math.min(100, feeRatio * 5));
                    const health = healthPctFor(posStatus);
                    const manageUrl = getManageUrl(pos.protocol);

                    return (
                      <Link
                        key={pos.id}
                        href={`/dashboard/position/${slug}`}
                        className={`pos-row pos-grid ${statusClass}`}
                        style={{
                          display: "grid",
                          gridTemplateColumns: "minmax(220px, 2.2fr) 1fr 1fr minmax(120px, 1.2fr) minmax(80px, 0.8fr) 130px 90px",
                          alignItems: "center",
                          gap: 16,
                          padding: 16,
                          background: C.card,
                          border: `1px solid ${C.border}`,
                          marginTop: -1,
                          textDecoration: "none",
                          color: C.text,
                          cursor: "pointer",
                          opacity: isClosed ? 0.55 : 1,
                        }}
                      >
                        {/* Pair info */}
                        <div style={{ display: "flex", alignItems: "center", gap: 12, overflow: "hidden" }}>
                          {(() => {
                            const parts = pos.pair.split(/\s*\/\s*/);
                            const sym0 = parts[0]?.trim() ?? "";
                            const sym1 = parts[1]?.trim() ?? "";
                            const SIZE = 30;
                            const OVERLAP = 10;
                            return (
                              <div style={{ position: "relative", width: SIZE * 2 - OVERLAP, height: SIZE, flexShrink: 0 }}>
                                <TokenCircle symbol={sym1} size={SIZE} style={{ position: "absolute", right: 0, top: 0, zIndex: 1 }} />
                                <TokenCircle symbol={sym0} size={SIZE} style={{ position: "absolute", left: 0, top: 0, zIndex: 2 }} />
                              </div>
                            );
                          })()}
                          <div style={{ overflow: "hidden" }}>
                            <div
                              style={{
                                fontSize: 14,
                                fontWeight: 600,
                                color: C.text,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                                letterSpacing: "0.02em",
                              }}
                            >
                              {pos.pair}
                            </div>
                            <div style={{ fontSize: 10, color: C.mute2, letterSpacing: "0.08em", textTransform: "uppercase", marginTop: 2 }}>
                              {pos.protocol} · {pos.chain}{pos.feeTier != null ? ` · ${pos.feeTier}%` : ""}
                            </div>
                          </div>
                        </div>

                        {/* Value · Fees */}
                        <div className="pos-val-fees">
                          <div style={{ fontSize: 14, fontWeight: 600, color: C.text, fontVariantNumeric: "tabular-nums" }}>
                            {fmt$(pos.value)}
                          </div>
                          {pos.fees > 0 && (
                            <div style={{ fontSize: 10, color: C.green, letterSpacing: "0.06em", marginTop: 2 }}>
                              +{fmt$(pos.fees)} fees
                            </div>
                          )}
                        </div>

                        {/* APR · Daily */}
                        <div className="pos-apr">
                          {pos.apy > 0 ? (
                            <>
                              <div style={{ fontSize: 13, fontWeight: 600, color: C.green, fontVariantNumeric: "tabular-nums" }}>
                                {pos.apy.toFixed(1)}%
                              </div>
                              {dailyEarnings !== null && (
                                <div style={{ fontSize: 10, color: C.mute2, letterSpacing: "0.06em", marginTop: 2 }}>
                                  ${dailyEarnings.toFixed(2)}/day
                                </div>
                              )}
                            </>
                          ) : (
                            <div style={{ fontSize: 12, fontWeight: 600, color: C.mute2 }}>N/A</div>
                          )}
                        </div>

                        {/* P&L bar */}
                        <div className="pos-pnl">
                          <div
                            style={{
                              height: 6,
                              background: C.bg,
                              border: `1px solid ${C.border}`,
                              overflow: "hidden",
                              marginBottom: 4,
                            }}
                          >
                            <div
                              style={{
                                height: "100%",
                                background: pos.fees > 0 ? C.green : "transparent",
                                width: `${pnlBarPct}%`,
                              }}
                            />
                          </div>
                          <div
                            style={{
                              fontSize: 10,
                              color: pos.fees > 0 ? C.green : C.mute2,
                              letterSpacing: "0.04em",
                              fontVariantNumeric: "tabular-nums",
                            }}
                          >
                            {pos.fees > 0 ? `+${fmt$(pos.fees)} (${feeRatio.toFixed(2)}%)` : "—"}
                          </div>
                        </div>

                        {/* Health % */}
                        <div className="pos-health" style={{ textAlign: "right" }}>
                          <div
                            style={{
                              fontSize: 12,
                              fontWeight: 600,
                              color:
                                health >= 100 ? C.green
                                : health > 0  ? C.amber
                                : C.mute2,
                              fontVariantNumeric: "tabular-nums",
                              marginBottom: 4,
                            }}
                          >
                            {health}%
                          </div>
                          <div
                            style={{
                              height: 4,
                              background: C.bg,
                              border: `1px solid ${C.border}`,
                              overflow: "hidden",
                              marginLeft: "auto",
                              maxWidth: 80,
                            }}
                          >
                            <div
                              style={{
                                height: "100%",
                                width: `${health}%`,
                                background:
                                  health >= 100 ? C.green
                                  : health > 0  ? C.amber
                                  : "transparent",
                              }}
                            />
                          </div>
                        </div>

                        {/* Status badge */}
                        <div style={{ display: "flex", justifyContent: "flex-end" }}>
                          <span
                            style={{
                              ...statusTagStyle(posStatus),
                              fontSize: 10,
                              letterSpacing: "0.1em",
                              textTransform: "uppercase",
                              fontWeight: 600,
                              padding: "4px 10px",
                              fontFamily: "var(--font-jetbrains-mono)",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {posStatus === "In Range"
                              ? "● IN_RANGE"
                              : posStatus === "Out of Range"
                              ? "◌ OUT_RANGE"
                              : "◇ CLOSED"}
                          </span>
                        </div>

                        {/* MANAGE button */}
                        <div className="pos-manage" style={{ display: "flex", justifyContent: "flex-end" }}>
                          {manageUrl ? (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                window.open(manageUrl, "_blank", "noopener,noreferrer");
                              }}
                              className="term-btn"
                              style={{
                                background: "transparent",
                                border: `1px solid ${C.border}`,
                                color: C.textDim,
                                padding: "5px 10px",
                                fontSize: 9,
                                letterSpacing: "0.14em",
                                textTransform: "uppercase",
                                fontWeight: 700,
                                fontFamily: "var(--font-jetbrains-mono)",
                                cursor: "pointer",
                              }}
                            >
                              Manage
                            </button>
                          ) : (
                            <span style={{ fontSize: 9, color: C.mute3, letterSpacing: "0.1em" }}>—</span>
                          )}
                        </div>
                      </Link>
                    );
                  })}
                </div>
              </>
            )}
          </section>

          {/* ── Section: alerts (placeholder) ─────────────────────────────── */}
          <section
            id="section-alerts"
            style={{ padding: "28px 28px 56px", borderTop: `1px solid ${C.border}` }}
          >
            <SectionHeader label="alerts" />
            <div
              style={{
                ...cardStyle,
                color: C.mute2,
                fontSize: 12,
                letterSpacing: "0.04em",
              }}
            >
              <div style={{ color: C.textDim, fontSize: 12, marginBottom: 8 }}>
                ◇ No active alerts
              </div>
              <div style={{ fontSize: 11, color: C.mute2 }}>
                Coming soon — out-of-range warnings, IL thresholds, and price-drop notifications.
              </div>
            </div>
          </section>
        </main>
      </div>

      {/* Keyboard hint bar (visual only) */}
      <div
        style={{
          borderTop: `1px solid ${C.border}`,
          padding: "10px 24px",
          display: "flex",
          gap: 24,
          fontSize: 10,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: C.mute2,
          flexWrap: "wrap",
        }}
      >
        <span><span style={{ color: C.green }}>[F5]</span> refresh</span>
        <span><span style={{ color: C.green }}>[W]</span> manage wallets</span>
        <span style={{ flex: 1 }} />
        <span style={{ color: C.mute3 }}>v0.9.1-beta</span>
      </div>

      {/* ── Manage Wallets Modal ─────────────────────────────────────────────── */}
      {showManageWallets && mounted && (
        <div style={{ position: "fixed", inset: 0, zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div
            style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.85)", backdropFilter: "blur(4px)" }}
            onClick={() => {
              setShowManageWallets(false);
              setShowEvmConnectors(false);
              setShowSolanaWalletList(false);
              setShowSuiWalletList(false);
            }}
          />
          <div
            style={{
              position: "relative",
              background: C.bg,
              border: `1px solid ${C.green}`,
              width: "100%",
              maxWidth: 540,
              margin: "0 16px",
              maxHeight: "90vh",
              overflowY: "auto",
              fontFamily: "var(--font-jetbrains-mono)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "14px 18px",
                borderBottom: `1px solid ${C.green}`,
                position: "sticky",
                top: 0,
                background: C.bg,
                zIndex: 10,
              }}
            >
              <div style={{ fontSize: 11, fontWeight: 700, color: C.green, letterSpacing: "0.16em", textTransform: "uppercase" }}>
                MANAGE_WALLETS
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <button
                  onClick={() => refetch()}
                  title="Refresh positions"
                  style={{
                    background: "none",
                    border: `1px solid ${C.border}`,
                    color: C.textDim,
                    cursor: "pointer",
                    fontSize: 14,
                    padding: "2px 8px",
                    fontFamily: "var(--font-jetbrains-mono)",
                  }}
                >
                  <span className={isFetching ? "spin-icon" : ""}>↻</span>
                </button>
                <button
                  onClick={() => {
                    setShowManageWallets(false);
                    setShowEvmConnectors(false);
                    setShowSolanaWalletList(false);
                    setShowSuiWalletList(false);
                  }}
                  style={{
                    background: "none",
                    border: `1px solid ${C.border}`,
                    color: C.textDim,
                    cursor: "pointer",
                    fontSize: 12,
                    padding: "2px 8px",
                    fontFamily: "var(--font-jetbrains-mono)",
                  }}
                >
                  [X]
                </button>
              </div>
            </div>

            <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 22 }}>
              {/* Add New Wallet */}
              <div style={{ border: `1px solid ${C.border}`, padding: 16 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: C.green, marginBottom: 12, letterSpacing: "0.14em", textTransform: "uppercase" }}>
                  ▸ Add New Wallet
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <input
                    type="text"
                    value={addWalletAddress}
                    onChange={(e) => { setAddWalletAddress(e.target.value); setAddWalletError(""); }}
                    onKeyDown={(e) => e.key === "Enter" && handleAddWatchedWallet()}
                    placeholder="0x… / sol… / 0x(sui)…"
                    style={{
                      width: "100%",
                      background: C.bg,
                      border: `1px solid ${C.border}`,
                      color: C.text,
                      padding: "9px 11px",
                      fontSize: 12,
                      outline: "none",
                      boxSizing: "border-box",
                      fontFamily: "var(--font-jetbrains-mono)",
                    }}
                  />
                  <input
                    type="text"
                    value={addWalletLabel}
                    onChange={(e) => setAddWalletLabel(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleAddWatchedWallet()}
                    placeholder="Label (optional) — e.g. Main Wallet"
                    style={{
                      width: "100%",
                      background: C.bg,
                      border: `1px solid ${C.border}`,
                      color: C.text,
                      padding: "9px 11px",
                      fontSize: 12,
                      outline: "none",
                      boxSizing: "border-box",
                      fontFamily: "var(--font-jetbrains-mono)",
                    }}
                  />
                  {addWalletError && (
                    <div style={{ color: C.red, fontSize: 11 }}>{addWalletError}</div>
                  )}
                  <button
                    onClick={handleAddWatchedWallet}
                    disabled={!addWalletAddress.trim()}
                    style={{
                      width: "100%",
                      background: addWalletAddress.trim() ? C.green : C.card,
                      border: `1px solid ${addWalletAddress.trim() ? C.green : C.border}`,
                      color: addWalletAddress.trim() ? "#000" : C.mute2,
                      padding: "9px",
                      fontSize: 11,
                      fontWeight: 700,
                      letterSpacing: "0.1em",
                      textTransform: "uppercase",
                      cursor: addWalletAddress.trim() ? "pointer" : "not-allowed",
                      fontFamily: "var(--font-jetbrains-mono)",
                    }}
                  >
                    ▸ Add Wallet
                  </button>
                  <div style={{ background: C.greenSoft, border: `1px solid ${C.green}`, padding: "9px 12px", display: "flex", alignItems: "flex-start", gap: 10 }}>
                    <span style={{ color: C.green, fontSize: 13, flexShrink: 0, marginTop: 1 }}>✓</span>
                    <div style={{ fontSize: 11, color: C.textDim, lineHeight: 1.6 }}>
                      <strong style={{ color: C.green }}>READ_ONLY.</strong>{" "}
                      No private keys, no signing — DefiDesh only reads public chain data.
                    </div>
                  </div>
                </div>
              </div>

              {/* Connect Browser Wallet */}
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: C.green, marginBottom: 12, letterSpacing: "0.14em", textTransform: "uppercase" }}>
                  ▸ Connect Browser Wallet
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {mounted && address ? (
                    <ConnectedRow tagColor="#00e5ff" tagLabel="EVM" addr={address} onDisconnect={() => evmDisconnect()} />
                  ) : mounted && (
                    <ConnectButton onClick={() => setShowEvmConnectors(true)} label="Connect EVM Wallet" tagColor="#00e5ff" tagLabel="EVM" />
                  )}

                  {mounted && solanaAddress ? (
                    <ConnectedRow tagColor="#9945ff" tagLabel="SOL" addr={solanaAddress} onDisconnect={() => { setSolanaAddress(null); disconnectSolanaWallet(); }} />
                  ) : mounted && (
                    <ConnectButton onClick={() => setShowSolanaWalletList(true)} label="Connect Solana Wallet" tagColor="#9945ff" tagLabel="SOL" />
                  )}

                  {mounted && suiAddress ? (
                    <ConnectedRow tagColor="#4da2ff" tagLabel="SUI" addr={suiAddress} onDisconnect={() => { setSuiAddress(null); disconnectSuiWallet(); }} />
                  ) : mounted && (
                    <ConnectButton onClick={() => setShowSuiWalletList(true)} label="Connect Sui Wallet" tagColor="#4da2ff" tagLabel="SUI" />
                  )}
                </div>
              </div>

              {/* Your Wallets */}
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
                  { label: "EVM", color: "#00e5ff", wallets: evmWalletList },
                  { label: "SOL", color: "#9945ff", wallets: solWalletList },
                  { label: "SUI", color: "#4da2ff", wallets: suiWalletList },
                ].filter((g) => g.wallets.length > 0);

                return (
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: C.green, marginBottom: 12, letterSpacing: "0.14em", textTransform: "uppercase" }}>
                      ▸ Your Wallets
                    </div>
                    {groups.map((group) => (
                      <div key={group.label} style={{ marginBottom: 14 }}>
                        <div
                          style={{
                            fontSize: 9,
                            color: group.color,
                            fontWeight: 700,
                            textTransform: "uppercase",
                            letterSpacing: "0.16em",
                            marginBottom: 6,
                          }}
                        >
                          {group.label} WALLETS
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                          {group.wallets.map((w) => {
                            const isEditing = editingWallet === w.addr;
                            return (
                              <div
                                key={w.addr}
                                style={{
                                  background: C.card,
                                  border: `1px solid ${C.border}`,
                                  padding: "9px 12px",
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "space-between",
                                  gap: 12,
                                }}
                              >
                                <div style={{ flex: 1, overflow: "hidden" }}>
                                  {isEditing ? (
                                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
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
                                        style={{
                                          background: C.bg,
                                          border: `1px solid ${C.border}`,
                                          color: C.text,
                                          padding: "3px 8px",
                                          fontSize: 11,
                                          outline: "none",
                                          flex: 1,
                                          fontFamily: "var(--font-jetbrains-mono)",
                                        }}
                                      />
                                      <button
                                        onClick={() => {
                                          const ww = watchedWallets.find((wl) => wl.address === w.addr);
                                          if (ww) updateLabel(ww.address, ww.chain, editLabelValue);
                                          setEditingWallet(null);
                                        }}
                                        style={{
                                          color: C.green,
                                          background: "none",
                                          border: "none",
                                          cursor: "pointer",
                                          fontSize: 11,
                                          whiteSpace: "nowrap",
                                          fontFamily: "var(--font-jetbrains-mono)",
                                        }}
                                      >
                                        SAVE
                                      </button>
                                      <button
                                        onClick={() => setEditingWallet(null)}
                                        style={{ color: C.mute2, background: "none", border: "none", cursor: "pointer", fontSize: 12 }}
                                      >
                                        ✕
                                      </button>
                                    </div>
                                  ) : (
                                    <div>
                                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                                        <span style={{ fontSize: 12, fontWeight: 600, color: C.text }}>
                                          {w.label || (w.type === "browser" ? group.label : "Watched")}
                                        </span>
                                        {w.type === "watched" && (
                                          <button
                                            onClick={() => { setEditingWallet(w.addr); setEditLabelValue(w.label ?? ""); }}
                                            style={{ color: C.mute2, background: "none", border: "none", cursor: "pointer", fontSize: 11, padding: 0 }}
                                            title="Edit label"
                                          >
                                            ✎
                                          </button>
                                        )}
                                        <span
                                          style={{
                                            fontSize: 9,
                                            color: w.type === "browser" ? C.green : C.mute2,
                                            background: w.type === "browser" ? C.greenSoft : "transparent",
                                            border: `1px solid ${w.type === "browser" ? C.green : C.border}`,
                                            padding: "0 6px",
                                            marginLeft: 2,
                                            letterSpacing: "0.1em",
                                            textTransform: "uppercase",
                                          }}
                                        >
                                          {w.type === "browser" ? "Browser" : "Watched"}
                                        </span>
                                      </div>
                                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                        <span style={{ fontSize: 10, color: C.mute2, fontFamily: "var(--font-jetbrains-mono)" }}>
                                          {w.addr.slice(0, 8)}…{w.addr.slice(-6)}
                                        </span>
                                        <button
                                          onClick={() => navigator.clipboard.writeText(w.addr)}
                                          style={{ color: C.mute2, background: "none", border: "none", cursor: "pointer", fontSize: 11, padding: 0 }}
                                          title="Copy address"
                                        >
                                          ⧉
                                        </button>
                                      </div>
                                    </div>
                                  )}
                                </div>
                                <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                                  <span style={{ color: C.green, fontSize: 12 }}>✓</span>
                                  {w.type === "watched" ? (
                                    <button
                                      onClick={() => {
                                        const ww = watchedWallets.find((wl) => wl.address === w.addr);
                                        if (ww) removeWallet(ww.address, ww.chain);
                                      }}
                                      title="Remove watched wallet"
                                      style={{
                                        color: C.red,
                                        background: C.redSoft,
                                        border: `1px solid ${C.red}`,
                                        padding: "2px 7px",
                                        fontSize: 11,
                                        cursor: "pointer",
                                        fontFamily: "var(--font-jetbrains-mono)",
                                      }}
                                    >
                                      🗑
                                    </button>
                                  ) : (
                                    <button
                                      onClick={() => {
                                        if (w.addr === address) evmDisconnect();
                                        else if (w.addr === solanaAddress) { setSolanaAddress(null); disconnectSolanaWallet(); }
                                        else if (w.addr === suiAddress) { setSuiAddress(null); disconnectSuiWallet(); }
                                      }}
                                      title="Disconnect wallet"
                                      style={{
                                        color: C.red,
                                        background: C.redSoft,
                                        border: `1px solid ${C.red}`,
                                        padding: "2px 7px",
                                        fontSize: 11,
                                        cursor: "pointer",
                                        fontFamily: "var(--font-jetbrains-mono)",
                                      }}
                                    >
                                      ✕
                                    </button>
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

              {/* Wallet Balances + Lending shortcuts */}
              {hasWallet && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 0 }}>
                  <Link href="/dashboard/tokens" style={{ textDecoration: "none", color: "inherit" }}>
                    <div style={{ background: C.card, border: `1px solid ${C.border}`, padding: 14 }}>
                      <div style={{ fontSize: 9, color: C.green, letterSpacing: "0.16em", textTransform: "uppercase", marginBottom: 6 }}>
                        ▸ Wallet Balances
                      </div>
                      <div style={{ fontSize: 16, fontWeight: 700, color: C.text, fontVariantNumeric: "tabular-nums" }}>
                        {walletTokensLoading ? "—" : fmt$(totalTokenValue)}
                      </div>
                      <div style={{ fontSize: 10, color: C.mute2, marginTop: 2, letterSpacing: "0.06em" }}>
                        {tokenCount > 0 ? `${tokenCount} token${tokenCount === 1 ? "" : "s"}` : "—"}
                      </div>
                    </div>
                  </Link>
                  <Link href="/dashboard/lending" style={{ textDecoration: "none", color: "inherit" }}>
                    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderLeft: "none", padding: 14 }}>
                      <div style={{ fontSize: 9, color: C.green, letterSpacing: "0.16em", textTransform: "uppercase", marginBottom: 6 }}>
                        ▸ Lending / Borrowing
                      </div>
                      <div style={{ fontSize: 16, fontWeight: 700, color: C.text, fontVariantNumeric: "tabular-nums" }}>
                        {walletTokensLoading ? "—" : fmt$(combinedLendingValue)}
                      </div>
                      <div style={{ fontSize: 10, color: C.mute2, marginTop: 2, letterSpacing: "0.06em" }}>
                        {combinedLendingCount > 0 ? `${combinedLendingCount} position${combinedLendingCount === 1 ? "" : "s"}` : "—"}
                      </div>
                    </div>
                  </Link>
                </div>
              )}
            </div>

            {/* EVM picker sub-modal */}
            {showEvmConnectors && (
              <SubPickerOverlay
                title="CHOOSE_EVM_WALLET"
                onClose={() => setShowEvmConnectors(false)}
                accent={C.green}
              >
                {connectors.map((connector, i) => (
                  <button
                    key={connector.id}
                    onClick={() => {
                      evmConnect({ connector: connectors[i] });
                      setShowEvmConnectors(false);
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      background: C.card,
                      border: `1px solid ${C.border}`,
                      padding: "10px 12px",
                      width: "100%",
                      cursor: "pointer",
                      color: C.text,
                      fontFamily: "var(--font-jetbrains-mono)",
                      textAlign: "left",
                    }}
                  >
                    <span style={{ fontSize: 12, color: C.green }}>▸</span>
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 600, color: C.text }}>{connector.name}</div>
                      <div style={{ fontSize: 10, color: C.mute2, letterSpacing: "0.06em" }}>Browser extension</div>
                    </div>
                  </button>
                ))}
              </SubPickerOverlay>
            )}

            {/* Solana picker sub-modal */}
            {showSolanaWalletList && (
              <SubPickerOverlay
                title="CHOOSE_SOLANA_WALLET"
                onClose={() => setShowSolanaWalletList(false)}
                accent="#9945ff"
              >
                {solanaWallets.length === 0 ? (
                  <div style={{ fontSize: 12, color: C.mute2, textAlign: "center", padding: 8 }}>
                    No Solana wallet detected. Install Phantom, Backpack, or Solflare.
                  </div>
                ) : (
                  solanaWallets.map((w) => (
                    <button
                      key={w.adapter.name}
                      onClick={() => handleSolanaConnectFromModal(w.adapter.name)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        background: C.card,
                        border: `1px solid ${C.border}`,
                        padding: "10px 12px",
                        width: "100%",
                        cursor: "pointer",
                        color: C.text,
                        fontFamily: "var(--font-jetbrains-mono)",
                        textAlign: "left",
                      }}
                    >
                      {w.adapter.icon && (
                        <img src={w.adapter.icon} alt={w.adapter.name} style={{ width: 22, height: 22 }} />
                      )}
                      <span style={{ fontSize: 12 }}>{w.adapter.name}</span>
                    </button>
                  ))
                )}
              </SubPickerOverlay>
            )}

            {/* Sui picker sub-modal */}
            {showSuiWalletList && (
              <SubPickerOverlay
                title="CHOOSE_SUI_WALLET"
                onClose={() => setShowSuiWalletList(false)}
                accent="#4da2ff"
              >
                {modalSuiWallets.length === 0 ? (
                  <div style={{ fontSize: 12, color: C.mute2, textAlign: "center", padding: 8 }}>
                    No Sui wallet detected. Install Phantom, Suiet, or Slush.
                  </div>
                ) : (
                  modalSuiWallets.map((w) => (
                    <button
                      key={w.name}
                      onClick={() => handleSuiConnectFromModal(w)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        background: C.card,
                        border: `1px solid ${C.border}`,
                        padding: "10px 12px",
                        width: "100%",
                        cursor: "pointer",
                        color: C.text,
                        fontFamily: "var(--font-jetbrains-mono)",
                        textAlign: "left",
                      }}
                    >
                      {w.icon && <img src={w.icon} alt={w.name} style={{ width: 22, height: 22 }} />}
                      <span style={{ fontSize: 12 }}>{w.name}</span>
                    </button>
                  ))
                )}
              </SubPickerOverlay>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Tiny presentational helpers ──────────────────────────────────────────────
function ConnectedRow({
  tagColor, tagLabel, addr, onDisconnect,
}: { tagColor: string; tagLabel: string; addr: string; onDisconnect: () => void }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        background: C.card,
        border: `1px solid ${tagColor}`,
        padding: "9px 12px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span
          style={{
            fontSize: 10,
            color: tagColor,
            fontWeight: 700,
            letterSpacing: "0.14em",
            border: `1px solid ${tagColor}`,
            padding: "1px 6px",
          }}
        >
          {tagLabel}
        </span>
        <span style={{ fontSize: 11, color: C.textDim, fontFamily: "var(--font-jetbrains-mono)" }}>
          {addr.slice(0, 8)}…{addr.slice(-6)}
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ color: C.green, fontSize: 11, fontWeight: 600, letterSpacing: "0.08em" }}>● CONNECTED</span>
        <button
          onClick={onDisconnect}
          style={{
            background: C.redSoft,
            border: `1px solid ${C.red}`,
            color: C.red,
            padding: "2px 8px",
            fontSize: 10,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            cursor: "pointer",
            fontFamily: "var(--font-jetbrains-mono)",
          }}
        >
          Disconnect
        </button>
      </div>
    </div>
  );
}

function ConnectButton({
  onClick, label, tagColor, tagLabel,
}: { onClick: () => void; label: string; tagColor: string; tagLabel: string }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        background: C.card,
        border: `1px solid ${C.border}`,
        padding: "9px 12px",
        width: "100%",
        cursor: "pointer",
        color: C.text,
        textAlign: "left",
        fontFamily: "var(--font-jetbrains-mono)",
      }}
    >
      <span
        style={{
          fontSize: 10,
          color: tagColor,
          fontWeight: 700,
          letterSpacing: "0.14em",
          border: `1px solid ${tagColor}`,
          padding: "1px 6px",
        }}
      >
        {tagLabel}
      </span>
      <span style={{ fontSize: 12 }}>{label}</span>
    </button>
  );
}

function SubPickerOverlay({
  title, onClose, accent, children,
}: { title: string; onClose: () => void; accent: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: "rgba(0,0,0,0.85)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          background: C.bg,
          border: `1px solid ${accent}`,
          padding: 18,
          width: "85%",
          maxWidth: 320,
          fontFamily: "var(--font-jetbrains-mono)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: accent, letterSpacing: "0.16em", textTransform: "uppercase" }}>
            {title}
          </div>
          <button
            onClick={onClose}
            style={{
              color: C.textDim,
              background: "none",
              border: `1px solid ${C.border}`,
              cursor: "pointer",
              fontSize: 11,
              padding: "1px 8px",
            }}
          >
            [X]
          </button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>{children}</div>
      </div>
    </div>
  );
}
