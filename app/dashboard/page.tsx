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
import { useAllPositionsActivity } from "../hooks/useAllPositionsActivity";
import { computePositionPnL, type ActivityEventForPnL } from "../lib/positionPnl";
import type { AerodromePosition } from "../lib/aerodrome";
import {
  PieChart,
  Pie,
  Cell,
  AreaChart,
  Area,
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

const CHAIN_FILTERS = ["All", "EVM", "Solana", "Sui"] as const;
type ChainFilter = typeof CHAIN_FILTERS[number];

const EVM_CHAINS_SET = new Set(["Base", "Ethereum", "Arbitrum", "Optimism", "Polygon", "Avalanche", "HyperEVM", "BNB Chain"]);
function chainCategory(chain: string): "EVM" | "Solana" | "Sui" | "OTHER" {
  if (chain === "Solana") return "Solana";
  if (chain === "Sui")    return "Sui";
  if (EVM_CHAINS_SET.has(chain)) return "EVM";
  return "OTHER";
}

const PROTOCOL_COLORS: Record<string, string> = {
  Aerodrome:    "#00ff41",
  "Uniswap V3": "#00d4ff",
  Velodrome:    "#3d9fff",
  Orca:         "#ffaa00",
  Raydium:      "#ff3355",
  Cetus:        "#9945ff",
  Bluefin:      "#3d9fff",
  Momentum:     "#00ff41",
  HyperSwap:    "#ffaa00",
  KittenSwap:   "#9945ff",
  ProjectX:     "#9945ff",
  PRJX:         "#9945ff",
  PancakeSwap:  "#ffaa00",
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

// ── Terminal palette (matches dashboard.html exactly) ─────────────────────────
const C = {
  bg:         "#050505",
  bg1:        "#090909",
  bg2:        "#0d0d0d",
  bg3:        "#121212",
  bg4:        "#171717",
  border:     "#1c1c1c",
  borderHi:   "#262626",
  borderGlow: "#2e2e2e",
  text:       "#a0a0a0",
  textMid:    "#aaaaaa",
  textBright: "#e0e0e0",
  textWhite:  "#f0f0f0",
  green:      "#00ff41",
  green2:     "#00e535",
  greenDim:   "#00b82a",
  greenFaint: "rgba(0,255,65,0.06)",
  greenGlow:  "rgba(0,255,65,0.18)",
  cyan:       "#00d4ff",
  cyanDim:    "#0099bb",
  cyanFaint:  "rgba(0,212,255,0.07)",
  red:        "#ff3355",
  redFaint:   "rgba(255,51,85,0.08)",
  purple:     "#9945ff",
  blue:       "#3d9fff",
  amber:      "#ffaa00",
} as const;

const FONT = "'JetBrains Mono','Courier New',monospace";

const SCANLINE_BG =
  "repeating-linear-gradient(0deg, transparent, transparent 3px, rgba(0,0,0,0.015) 3px, rgba(0,0,0,0.015) 4px)";

// ── Chain UI tokens ───────────────────────────────────────────────────────────
const CHAIN_DISPLAY: Record<"EVM" | "Solana" | "Sui", { color: string; faint: string; border: string }> = {
  EVM:    { color: C.cyan,   faint: "rgba(0,212,255,0.06)",  border: "rgba(0,212,255,0.27)"  },
  Solana: { color: C.purple, faint: "rgba(153,69,255,0.06)", border: "rgba(153,69,255,0.27)" },
  Sui:    { color: C.blue,   faint: "rgba(61,159,255,0.06)", border: "rgba(61,159,255,0.27)" },
};

// ── TokenCircle ───────────────────────────────────────────────────────────────
function TokenCircle({
  symbol, size = 22, style,
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
      fontSize: size * 0.4, fontWeight: 700, color: "white",
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
  return "#9945ff";
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

function healthFor(status: "In Range" | "Out of Range" | "Closed"): number {
  if (status === "In Range")     return 90;
  if (status === "Out of Range") return 55;
  return 0;
}
function healthColor(h: number): string {
  if (h >= 80) return C.green;
  if (h >= 60) return C.amber;
  return C.red;
}

function tokenInitials(pair: string): string {
  const parts = pair.split("/").map((s) => s.trim());
  return `${parts[0]?.[0] ?? "?"}${parts[1]?.[0] ?? "?"}`;
}

function chainInfoFromConnected(addr: string | null | undefined, kind: "EVM" | "SOL" | "SUI") {
  if (!addr) return null;
  const colour =
    kind === "EVM" ? C.cyan :
    kind === "SOL" ? C.purple :
    C.blue;
  const chains =
    kind === "EVM" ? "Ethereum · Base · Arbitrum" :
    kind === "SOL" ? "Solana Mainnet" :
    "Sui Network";
  const name = kind === "EVM" ? "EVM Wallet"
             : kind === "SOL" ? "Solana Wallet"
             : "Sui Wallet";
  return { colour, chains, name, addr };
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function Dashboard() {
  const { positions: allPositions, isLoading, isFetching, dataUpdatedAt, refetch } = usePositions();
  // Per-position activity events — used for proper P&L calculation per row.
  const { eventsMap: positionEventsMap } = useAllPositionsActivity(allPositions);
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

  const lendingProtocolNames = useMemo(
    () => Array.from(new Set(externalLendingPositions.map((p) => p.protocol))),
    [externalLendingPositions],
  );

  // Top 3 lending positions for the Lend & Borrow pane breakdown
  const topLending = useMemo(() => {
    return [...externalLendingPositions]
      .sort((a, b) => b.totalSupplied - a.totalSupplied)
      .slice(0, 3);
  }, [externalLendingPositions]);

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
  const [chainFilter, setChainFilter] = useState<ChainFilter>("All");
  const [activeSection, setActiveSection] = useState<NavSection>("overview");
  const [chartTab, setChartTab] = useState<typeof TIME_RANGES[number]["key"]>("30D");

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
    if (chainFilter !== "All") result = result.filter((p) => chainCategory(p.chain) === chainFilter);
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

  // Composite portfolio health (avg of per-position health)
  const portfolioHealth = useMemo(() => {
    const active = allPositions.filter((p) => p.value > 0);
    if (!active.length) return null;
    const sum = active.reduce((s, p) => s + healthFor(effectiveStatus(p)), 0);
    return sum / active.length;
  }, [allPositions]);

  const protocolBreakdown = useMemo(() => {
    const m: Record<string, number> = {};
    for (const p of allPositions) {
      if (p.value > 0) m[p.protocol] = (m[p.protocol] ?? 0) + p.value;
    }
    return Object.entries(m).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  }, [allPositions]);

  // Group chains into EVM / Solana / Sui buckets for the chain distribution row
  const chainGrouped = useMemo(() => {
    const m: Record<"EVM" | "Solana" | "Sui", { value: number; chains: Set<string> }> = {
      EVM:    { value: 0, chains: new Set<string>() },
      Solana: { value: 0, chains: new Set<string>() },
      Sui:    { value: 0, chains: new Set<string>() },
    };
    for (const p of allPositions) {
      if (p.value <= 0) continue;
      const cat = chainCategory(p.chain);
      if (cat === "OTHER") continue;
      m[cat].value += p.value;
      m[cat].chains.add(p.chain === "Solana" ? "Mainnet" : p.chain === "Sui" ? "Mainnet" : p.chain);
    }
    const total = m.EVM.value + m.Solana.value + m.Sui.value;
    return (Object.keys(m) as Array<"EVM" | "Solana" | "Sui">)
      .map((name) => ({
        name,
        value: m[name].value,
        chains: Array.from(m[name].chains).join(" · ") || "—",
        pct: total > 0 ? (m[name].value / total) * 100 : 0,
      }))
      .filter((r) => r.value > 0);
  }, [allPositions]);

  const portfolioHistory = usePortfolioHistory(totalValue, allPositions.length, dataUpdatedAt);
  const activeRange    = TIME_RANGES.find((r) => r.key === chartTab) ?? TIME_RANGES[2];
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
  const peakValue = effectiveHistory.length > 0
    ? Math.max(...effectiveHistory.map((s) => s.totalValue))
    : totalValue;

  const fmt$ = (n: number, dec = 2) =>
    `$${n.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec })}`;

  // Split a $ value into integer and cents pieces for the page-header big number
  const splitDollars = (n: number): { whole: string; cents: string } => {
    const fixed = n.toFixed(2);
    const [w, c] = fixed.split(".");
    return {
      whole: Number(w).toLocaleString("en-US"),
      cents: c ?? "00",
    };
  };

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

  const splitTotal = splitDollars(totalValue);

  // Suppress unused-var lint
  void secondsAgo;
  void getTickPriceUSD;
  void tokenInitials;

  // Build wallet rows for the Wallets pane in row 1
  const walletPaneRows = useMemo(() => {
    const rows: Array<{ key: string; color: string; name: string; addr: string; sub: string; type: "browser" | "watched"; chain?: WatchedWalletChain; }> = [];
    if (address)        { const i = chainInfoFromConnected(address, "EVM")!;        rows.push({ key: address,        color: i.colour, name: i.name, addr: i.addr, sub: i.chains, type: "browser", chain: "evm"    }); }
    if (solanaAddress)  { const i = chainInfoFromConnected(solanaAddress, "SOL")!;  rows.push({ key: solanaAddress,  color: i.colour, name: i.name, addr: i.addr, sub: i.chains, type: "browser", chain: "solana" }); }
    if (suiAddress)     { const i = chainInfoFromConnected(suiAddress, "SUI")!;     rows.push({ key: suiAddress,     color: i.colour, name: i.name, addr: i.addr, sub: i.chains, type: "browser", chain: "sui"    }); }
    for (const w of watchedWallets) {
      const colour = w.chain === "evm" ? C.cyan : w.chain === "solana" ? C.purple : w.chain === "sui" ? C.blue : C.text;
      const sub = w.chain === "evm" ? "EVM Watched"
                : w.chain === "solana" ? "Solana Watched"
                : w.chain === "sui" ? "Sui Watched"
                : "Watched";
      rows.push({ key: w.address, color: colour, name: w.label ?? "Watched", addr: w.address, sub, type: "watched", chain: w.chain });
    }
    return rows;
  }, [address, solanaAddress, suiAddress, watchedWallets]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: "100vh",
        background: C.bg,
        color: C.text,
        fontFamily: FONT,
        fontSize: 12,
        lineHeight: 1.5,
        overflowX: "hidden",
      }}
    >
      <style>{`
        @keyframes _spin  { from { transform:rotate(0deg) } to { transform:rotate(360deg) } }
        @keyframes _pulse { 0%,100%{opacity:1} 50%{opacity:0.25} }
        @keyframes _fadeUp { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
        .spin-icon { display:inline-block; animation: _spin 1s linear infinite; }
        .ptable tbody tr { transition: background 0.1s; }
        .ptable tbody tr:hover td { background: rgba(255,255,255,0.013); }
        .pos-row { transition: background 0.1s; }
        .pos-row:hover { background: rgba(255,255,255,0.013); }
        .nav-tab-link:hover { color: ${C.textMid} !important; background: ${C.bg2} !important; }
        .filter-pill { transition: all 0.12s; }
        .filter-pill:hover { color: ${C.textMid}; border-color: ${C.border}; }
        .ct-tab { transition: all 0.1s; }
        .ct-tab:hover:not([data-active="true"]) { color: ${C.textMid}; background: ${C.bg2}; }
        .manage-btn:hover { border-color: ${C.cyanDim} !important; color: ${C.cyan} !important; background: ${C.cyanFaint} !important; }
        .pane-link:hover { color: ${C.green}; }
        .lending-card:hover { border-color: ${C.green} !important; }
        .term-btn:hover { color: ${C.green} !important; border-color: ${C.borderGlow} !important; background: ${C.bg2} !important; }
        .save-btn:hover { background: ${C.green2} !important; box-shadow: 0 4px 20px rgba(0,255,65,0.2); }
        .scroll-thin::-webkit-scrollbar { width: 4px; height: 4px; }
        .scroll-thin::-webkit-scrollbar-thumb { background: ${C.borderHi}; }
        .anim-fade { animation: _fadeUp 0.45s ease both; }
      `}</style>

      {/* Scanline overlay */}
      <div
        aria-hidden
        style={{
          position: "fixed",
          inset: 0,
          pointerEvents: "none",
          zIndex: 9998,
          background: SCANLINE_BG,
        }}
      />

      <TerminalNavbar />

      {/* Layout: sidebar + main */}
      <div style={{ display: "flex", flex: 1, minHeight: "calc(100vh - 52px)" }}>
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

        <main className="scroll-thin" style={{ flex: 1, overflowY: "auto", background: C.bg, minWidth: 0 }}>

          {/* ── PAGE HEADER ─────────────────────────────────────────────── */}
          <section
            id="section-overview"
            className="anim-fade"
            style={{
              padding: "36px 40px 28px",
              borderBottom: `1px solid ${C.border}`,
              background: `linear-gradient(180deg, ${C.bg1} 0%, ${C.bg} 100%)`,
              position: "relative",
              overflow: "hidden",
            }}
          >
            <div
              aria-hidden
              style={{
                position: "absolute", right: -40, top: -40, width: 300, height: 300,
                background: "radial-gradient(circle, rgba(0,255,65,0.04) 0%, transparent 70%)",
                pointerEvents: "none",
              }}
            />

            <div
              style={{
                fontSize: 8,
                color: C.text,
                letterSpacing: "0.18em",
                textTransform: "uppercase",
                marginBottom: 10,
                opacity: 0.6,
              }}
            >
              <span style={{ color: C.green, opacity: 1 }}>// </span>
              total_portfolio_value · <span style={{ color: C.green, opacity: 1 }}>updated {dataUpdatedAt > 0 ? `${secondsAgo}s ago` : "—"}</span>
            </div>

            <div
              style={{
                display: "flex",
                alignItems: "flex-end",
                justifyContent: "space-between",
                marginBottom: 28,
                gap: 16,
                flexWrap: "wrap",
              }}
            >
              <div>
                <div
                  style={{
                    fontSize: 56,
                    fontWeight: 700,
                    color: C.textWhite,
                    letterSpacing: "-0.04em",
                    lineHeight: 1,
                    textShadow: "0 0 60px rgba(0,255,65,0.08)",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  ${splitTotal.whole}
                  <span style={{ fontSize: 32, color: C.textMid, fontWeight: 500 }}>.{splitTotal.cents}</span>
                </div>
                {chartPnlAvailable && (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      marginTop: 10,
                      fontSize: 12,
                      color: chartPnlDollar >= 0 ? C.green : C.red,
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    <span style={{ fontSize: 14 }}>{chartPnlDollar >= 0 ? "↑" : "↓"}</span>
                    <span>{chartPnlDollar >= 0 ? "+" : "-"}{fmt$(Math.abs(chartPnlDollar))}</span>
                    <span style={{ color: C.text, fontSize: 10, marginLeft: 4, opacity: 0.6 }}>
                      {chartPnlDollar >= 0 ? "+" : ""}{chartPnlPct.toFixed(1)}% ({activeRange.label.replace("in last ", "")})
                    </span>
                  </div>
                )}
              </div>

              <div style={{ display: "flex", gap: 8, alignSelf: "flex-end" }}>
                <button
                  type="button"
                  className="term-btn"
                  onClick={() => { if (!isFetching) refetch(); }}
                  aria-disabled={isFetching}
                  style={{
                    background: "transparent",
                    border: `1px solid ${C.borderHi}`,
                    color: C.text,
                    padding: "9px 20px",
                    fontSize: 10,
                    fontWeight: 600,
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                    cursor: isFetching ? "not-allowed" : "pointer",
                    fontFamily: FONT,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    opacity: isFetching ? 0.6 : 1,
                  }}
                >
                  <span className={isFetching ? "spin-icon" : ""}>↻</span>
                  {isFetching ? "Refreshing" : "Refresh"}
                </button>
                <button
                  type="button"
                  onClick={() => setShowManageWallets(true)}
                  className="term-btn"
                  style={{
                    background: "transparent",
                    border: `1px solid ${C.borderHi}`,
                    color: C.text,
                    padding: "9px 20px",
                    fontSize: 10,
                    fontWeight: 600,
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                    cursor: "pointer",
                    fontFamily: FONT,
                  }}
                >
                  ▸ Wallets
                </button>
              </div>
            </div>

            {/* 4 stat tiles */}
            <div style={{ display: "flex", gap: 0 }}>
              {[
                {
                  label: "Positions",
                  val:   String(allPositions.length),
                  cls:   "white" as const,
                  sub:   uniqueChains > 0 ? `across ${uniqueChains} chain${uniqueChains === 1 ? "" : "s"}` : "—",
                },
                {
                  label: "Avg APY",
                  val:   avgApr !== null ? `${avgApr.toFixed(1)}%` : "N/A",
                  cls:   "green" as const,
                  sub:   "value-weighted",
                },
                {
                  label: "Uncollected Fees",
                  val:   totalFees > 0 ? fmt$(totalFees) : "—",
                  cls:   totalFees > 0 ? "green" as const : "white" as const,
                  sub:   `${allPositions.filter((p) => p.fees > 0).length} positions claiming`,
                },
                {
                  label: "Daily Yield",
                  val:   hasCashflowData ? `+${fmt$(dailyCashflow)}` : "N/A",
                  cls:   "green" as const,
                  sub:   hasCashflowData ? `${fmt$(dailyCashflow * 30, 0)}/mo est.` : "—",
                },
              ].map((s, i, arr) => (
                <div
                  key={s.label}
                  style={{
                    paddingLeft: i === 0 ? 0 : 32,
                    paddingRight: i === arr.length - 1 ? 0 : 32,
                    borderRight: i < arr.length - 1 ? `1px solid ${C.border}` : "none",
                    display: "flex",
                    flexDirection: "column",
                    gap: 5,
                  }}
                >
                  <div style={{ fontSize: 9, color: C.text, letterSpacing: "0.14em", textTransform: "uppercase", opacity: 0.6 }}>
                    {s.label}
                  </div>
                  <div
                    style={{
                      fontSize: 20,
                      fontWeight: 700,
                      letterSpacing: "-0.01em",
                      color:
                        s.cls === "green" ? C.green :
                        s.cls === "white" ? C.textWhite : C.textMid,
                      textShadow: s.cls === "green" ? "0 0 20px rgba(0,255,65,0.2)" : "none",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {s.val}
                  </div>
                  <div style={{ fontSize: 9, color: C.text, opacity: 0.5 }}>{s.sub}</div>
                </div>
              ))}
            </div>
          </section>

          {/* ── ROW 1: Wallets · Cashflow · Lend & Borrow ───────────────── */}
          <div style={{ display: "flex", borderBottom: `1px solid ${C.border}`, flexWrap: "wrap" }} className="anim-fade">
            {/* WALLETS */}
            <div
              style={{
                flex: "1 1 320px",
                borderRight: `1px solid ${C.border}`,
                padding: "24px 28px",
                minWidth: 0,
              }}
            >
              <PaneHead title="wallets" linkLabel="+ Add wallet" onLinkClick={() => setShowManageWallets(true)} />

              {!hasWallet && mounted && (
                <div style={{ fontSize: 11, color: C.text, opacity: 0.5, padding: "12px 0" }}>
                  No wallet connected — use ▸ Wallets above.
                </div>
              )}

              {walletPaneRows.map((w) => (
                <div
                  key={w.key}
                  className="pos-row"
                  onClick={() => setShowManageWallets(true)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    padding: "11px 0",
                    borderBottom: `1px solid ${C.border}`,
                    gap: 12,
                    cursor: "pointer",
                  }}
                >
                  <div style={{ width: 2, height: 36, background: w.color, flexShrink: 0 }} />
                  <div style={{ flex: 1, overflow: "hidden" }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: C.textBright, letterSpacing: "0.02em" }}>
                      {w.name}
                    </div>
                    <div style={{ fontSize: 9, color: C.text, marginTop: 2, fontStyle: "italic", opacity: 0.6 }}>
                      {w.addr.slice(0, 6)}…{w.addr.slice(-4)}
                    </div>
                  </div>
                  <div style={{ textAlign: "right", flexShrink: 0 }}>
                    <div style={{ fontSize: 11, color: C.textMid, opacity: 0.7 }}>
                      {w.type === "browser" ? "● Connected" : "Watched"}
                    </div>
                    <div style={{ fontSize: 9, color: C.text, marginTop: 2, opacity: 0.5 }}>
                      {w.sub}
                    </div>
                  </div>
                  <div style={{ color: C.borderGlow, fontSize: 12 }}>▸</div>
                </div>
              ))}
            </div>

            {/* CASHFLOW */}
            <div
              style={{
                flex: "1 1 320px",
                borderRight: `1px solid ${C.border}`,
                padding: "24px 28px",
                minWidth: 0,
              }}
            >
              <PaneHead title="estimated_net_cashflow" />
              <div
                style={{
                  marginBottom: 6,
                  fontSize: 9,
                  color: C.text,
                  opacity: 0.4,
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                }}
              >
                per day
              </div>
              <div
                style={{
                  fontSize: 36,
                  fontWeight: 700,
                  color: C.green,
                  letterSpacing: "-0.03em",
                  lineHeight: 1,
                  margin: "6px 0",
                  textShadow: "0 0 32px rgba(0,255,65,0.25)",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {hasCashflowData ? `+${fmt$(dailyCashflow)}` : "—"}
              </div>
              <div style={{ marginTop: 20 }}>
                {[
                  { label: "Weekly",      val: hasCashflowData ? `+${fmt$(dailyCashflow * 7)}`      : "—", c: C.green },
                  { label: "Monthly",     val: hasCashflowData ? `+${fmt$(dailyCashflow * 30)}`     : "—", c: C.green },
                  { label: "Yearly est.", val: hasCashflowData ? `+${fmt$(dailyCashflow * 365, 0)}` : "—", c: C.cyan  },
                ].map((r, i, arr) => (
                  <div
                    key={r.label}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      padding: "8px 0",
                      borderBottom: i < arr.length - 1 ? `1px solid ${C.border}` : "none",
                      fontSize: 10,
                    }}
                  >
                    <span style={{ color: C.text, letterSpacing: "0.1em", textTransform: "uppercase", fontSize: 9, opacity: 0.6 }}>
                      {r.label}
                    </span>
                    <span style={{ fontWeight: 600, color: r.c, fontVariantNumeric: "tabular-nums" }}>
                      {r.val}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* LEND & BORROW */}
            <Link href="/dashboard/lending" style={{ textDecoration: "none", color: "inherit", flex: "1 1 320px", minWidth: 0 }}>
              <div
                className="lending-card"
                style={{
                  padding: "24px 28px",
                  cursor: "pointer",
                  height: "100%",
                  boxSizing: "border-box",
                  borderRight: "none",
                  transition: "border-color 0.15s",
                }}
              >
                <PaneHead title="lend_and_borrow" linkLabel="View →" linkColor={C.cyan} />
                <div
                  style={{
                    marginBottom: 6,
                    fontSize: 9,
                    color: C.text,
                    opacity: 0.4,
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                  }}
                >
                  total supplied
                </div>
                <div
                  style={{
                    fontSize: 36,
                    fontWeight: 700,
                    color: C.cyan,
                    letterSpacing: "-0.03em",
                    lineHeight: 1,
                    margin: "6px 0",
                    textShadow: "0 0 32px rgba(0,212,255,0.2)",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {walletTokensLoading ? "—" : fmt$(combinedLendingValue)}
                </div>
                <div style={{ marginTop: 20 }}>
                  {topLending.length === 0 ? (
                    <div style={{ fontSize: 11, color: C.text, opacity: 0.5, padding: "8px 0" }}>
                      {hasWallet ? "No lending positions" : "Connect a wallet to see lending"}
                    </div>
                  ) : (
                    topLending.map((p, i) => (
                      <div
                        key={p.protocol + p.chain + i}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          padding: "8px 0",
                          borderBottom: i < topLending.length - 1 ? `1px solid ${C.border}` : "none",
                          fontSize: 10,
                        }}
                      >
                        <span style={{ color: C.text, letterSpacing: "0.1em", textTransform: "uppercase", fontSize: 9, opacity: 0.6 }}>
                          {p.protocol}{" "}
                          <span style={{ opacity: 0.4 }}>({p.chain})</span>
                        </span>
                        <span style={{ fontWeight: 600, color: C.cyan, fontVariantNumeric: "tabular-nums" }}>
                          {fmt$(p.totalSupplied)}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </Link>
          </div>

          {/* ── ROW 2: Allocation (wide) + Chain Distribution (narrow) ──── */}
          {allPositions.some((p) => p.value > 0) && (
            <div style={{ display: "flex", borderBottom: `1px solid ${C.border}`, flexWrap: "wrap" }} className="anim-fade">
              <div
                style={{
                  flex: "2 1 480px",
                  borderRight: `1px solid ${C.border}`,
                  padding: "24px 28px",
                  minWidth: 0,
                }}
              >
                <PaneHead title="protocol_allocation" />
                <div style={{ display: "flex", gap: 28, alignItems: "center", flexWrap: "wrap" }}>
                  <div style={{ position: "relative", flexShrink: 0, width: 130, height: 130 }}>
                    <ResponsiveContainer width={130} height={130}>
                      <PieChart>
                        <Pie
                          data={protocolBreakdown}
                          cx="50%" cy="50%"
                          innerRadius={42}
                          outerRadius={62}
                          dataKey="value"
                          stroke={C.bg1}
                          strokeWidth={1}
                        >
                          {protocolBreakdown.map((entry) => (
                            <Cell key={entry.name} fill={getProtocolColor(entry.name)} />
                          ))}
                        </Pie>
                        <Tooltip
                          contentStyle={{
                            backgroundColor: C.bg1,
                            border: `1px solid ${C.border}`,
                            borderRadius: 0,
                            color: C.textBright,
                            fontSize: 11,
                            fontFamily: FONT,
                          }}
                          itemStyle={{ color: C.textBright }}
                          labelStyle={{ color: C.text }}
                          formatter={(v: number | undefined) => [fmt$(v ?? 0), ""]}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                    <div
                      style={{
                        position: "absolute",
                        inset: 0,
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        justifyContent: "center",
                        pointerEvents: "none",
                      }}
                    >
                      <div style={{ fontSize: 13, fontWeight: 700, color: C.textBright }}>
                        {protocolBreakdown.length}
                      </div>
                      <div style={{ fontSize: 8, color: C.text, letterSpacing: "0.2em", opacity: 0.5 }}>
                        POOLS
                      </div>
                    </div>
                  </div>

                  <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 9, minWidth: 200 }}>
                    {protocolBreakdown.map((entry) => {
                      const pct = totalValue > 0 ? (entry.value / totalValue) * 100 : 0;
                      const colour = getProtocolColor(entry.name);
                      return (
                        <div key={entry.name} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 10 }}>
                          <div
                            style={{
                              width: 7, height: 7, background: colour, flexShrink: 0,
                              boxShadow: `0 0 6px ${colour}66`,
                            }}
                          />
                          <div style={{ color: C.text, minWidth: 90, fontSize: 10 }}>{entry.name}</div>
                          <div style={{ flex: 1, height: 2, background: C.border, margin: "0 4px" }}>
                            <div style={{ height: "100%", width: `${pct}%`, background: colour, transition: "width 1s ease" }} />
                          </div>
                          <div
                            style={{
                              color: C.textBright,
                              fontWeight: 700,
                              minWidth: 36,
                              textAlign: "right",
                              fontSize: 11,
                              fontVariantNumeric: "tabular-nums",
                            }}
                          >
                            {pct.toFixed(0)}%
                          </div>
                          <div style={{ color: C.text, fontSize: 9, minWidth: 56, textAlign: "right", opacity: 0.6, fontVariantNumeric: "tabular-nums" }}>
                            {fmt$(entry.value, 0)}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              <div style={{ flex: "1 1 280px", padding: "24px 28px", minWidth: 0 }}>
                <PaneHead title="chain_distribution" />
                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                  {chainGrouped.length === 0 ? (
                    <div style={{ color: C.text, fontSize: 11, opacity: 0.5 }}>No chain data yet.</div>
                  ) : chainGrouped.map((c) => {
                    const colour = CHAIN_DISPLAY[c.name].color;
                    return (
                      <div key={c.name}>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6, fontSize: 10 }}>
                          <div style={{ color: C.textMid, display: "flex", alignItems: "center", gap: 6 }}>
                            <div style={{ width: 6, height: 6, background: colour, flexShrink: 0, boxShadow: `0 0 5px ${colour}88` }} />
                            <span>{c.name}</span>
                            <span style={{ fontSize: 9, opacity: 0.4, marginLeft: 4 }}>{c.chains}</span>
                          </div>
                          <div style={{ color: C.textBright, fontWeight: 700, fontSize: 12, fontVariantNumeric: "tabular-nums" }}>
                            {c.pct.toFixed(0)}%
                          </div>
                        </div>
                        <div style={{ height: 3, background: C.border, width: "100%" }}>
                          <div
                            style={{
                              height: "100%", width: `${c.pct}%`, background: colour,
                              boxShadow: `0 0 6px ${colour}66`, transition: "width 1s ease",
                            }}
                          />
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 3, fontSize: 9, fontVariantNumeric: "tabular-nums" }}>
                          <span style={{ color: C.text, opacity: 0.5 }}>VALUE</span>
                          <span style={{ color: C.text, opacity: 0.7 }}>{fmt$(c.value, 0)}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* ── ROW 3: yield chart ──────────────────────────────────────── */}
          {hasWallet && (
            <div
              id="section-cashflow"
              style={{ padding: "24px 28px", borderBottom: `1px solid ${C.border}` }}
              className="anim-fade"
            >
              <div style={{ display: "flex", alignItems: "center", gap: 0, marginBottom: 20, flexWrap: "wrap" }}>
                <div
                  style={{
                    fontSize: 8,
                    letterSpacing: "0.22em",
                    textTransform: "uppercase",
                    color: C.text,
                    opacity: 0.55,
                    marginRight: 20,
                  }}
                >
                  <span style={{ color: C.green, opacity: 1 }}>// </span>
                  yield_history
                </div>
                <div style={{ display: "flex" }}>
                  {TIME_RANGES.map((r, i, arr) => {
                    const active = chartTab === r.key;
                    return (
                      <button
                        key={r.key}
                        onClick={() => setChartTab(r.key)}
                        data-active={active}
                        className="ct-tab"
                        style={{
                          padding: "4px 12px",
                          fontFamily: FONT,
                          fontSize: 9,
                          letterSpacing: "0.12em",
                          textTransform: "uppercase",
                          border: `1px solid ${active ? C.greenDim : C.border}`,
                          borderRight: i < arr.length - 1 ? "none" : `1px solid ${active ? C.greenDim : C.border}`,
                          background: active ? C.bg2 : "transparent",
                          color: active ? C.green : C.text,
                          cursor: "pointer",
                        }}
                      >
                        {r.key}
                      </button>
                    );
                  })}
                </div>

                <div
                  style={{
                    marginLeft: "auto",
                    display: "flex",
                    alignItems: "center",
                    gap: 20,
                    fontSize: 9,
                  }}
                >
                  {chartPnlAvailable && (
                    <ChartMeta label="Window P&L" value={`${chartPnlDollar >= 0 ? "+" : "-"}${fmt$(Math.abs(chartPnlDollar), 0)}`} colour={chartPnlDollar >= 0 ? C.green : C.red} />
                  )}
                  <ChartMeta label="Peak Value" value={fmt$(peakValue, 0)} colour={C.textBright} />
                  <ChartMeta label="Avg APY" value={avgApr !== null ? `${avgApr.toFixed(1)}%` : "—"} colour={C.textBright} />
                </div>
              </div>

              {portfolioHistory.length < 2 ? (
                <div style={{ textAlign: "center", padding: "32px 0" }}>
                  <div style={{ fontSize: 12, color: C.text, opacity: 0.5 }}>
                    Tracking started — chart appears after the next refresh.
                  </div>
                  <div style={{ fontSize: 10, color: C.text, marginTop: 4, letterSpacing: "0.06em", opacity: 0.4 }}>
                    A data point is saved on every 60-second refresh.
                  </div>
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={160}>
                  <AreaChart data={chartData} margin={{ top: 4, right: 16, left: 8, bottom: 4 }}>
                    <defs>
                      <linearGradient id="yieldGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={C.green} stopOpacity={0.18} />
                        <stop offset="60%" stopColor={C.green} stopOpacity={0.04} />
                        <stop offset="100%" stopColor={C.green} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="4 6" stroke="rgba(255,255,255,0.03)" />
                    <XAxis dataKey="label" tick={{ fill: "rgba(255,255,255,0.2)", fontSize: 9, fontFamily: FONT }}
                      axisLine={false} tickLine={false} interval="preserveStartEnd" />
                    <YAxis tick={{ fill: "rgba(255,255,255,0.18)", fontSize: 9, fontFamily: FONT }}
                      axisLine={false} tickLine={false} width={64}
                      tickFormatter={(v) => `$${Number(v).toLocaleString("en-US", { maximumFractionDigits: 0 })}`} />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: C.bg1,
                        border: `1px solid ${C.border}`,
                        borderRadius: 0,
                        color: C.textBright,
                        fontFamily: FONT,
                      }}
                      itemStyle={{ color: C.green }}
                      labelStyle={{ color: C.text, marginBottom: 4 }}
                      formatter={(v: number | undefined) => [fmt$(v ?? 0), "Value"]}
                    />
                    <Area
                      type="monotone"
                      dataKey="value"
                      stroke={C.green}
                      strokeWidth={1.5}
                      fill="url(#yieldGrad)"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>
          )}

          {/* ── ROW 4: bottom metrics strip (4 cells) ───────────────────── */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              borderBottom: `1px solid ${C.border}`,
            }}
            className="anim-fade"
          >
            {[
              {
                label: "Daily Yield",
                val:   hasCashflowData ? `+${fmt$(dailyCashflow)}`     : "—",
                cls:   "green" as const,
                sub:   hasCashflowData ? `≈ ${fmt$(dailyCashflow * 30, 0)}/mo` : "—",
              },
              {
                label: "Weekly",
                val:   hasCashflowData ? `+${fmt$(dailyCashflow * 7)}` : "—",
                cls:   "green" as const,
                sub:   "estimated 7d",
              },
              {
                label: "Monthly",
                val:   hasCashflowData ? `+${fmt$(dailyCashflow * 30, 0)}` : "—",
                cls:   "cyan" as const,
                sub:   "estimated 30d",
              },
              {
                label: "Total Uncollected",
                val:   totalFees > 0 ? `+${fmt$(totalFees)}` : "—",
                cls:   "white" as const,
                sub:   `${allPositions.filter((p) => p.fees > 0).length} positions`,
              },
            ].map((m, i, arr) => (
              <div
                key={m.label}
                style={{
                  padding: "22px 28px",
                  borderRight: i < arr.length - 1 ? `1px solid ${C.border}` : "none",
                  position: "relative",
                  overflow: "hidden",
                }}
              >
                <div
                  aria-hidden
                  style={{
                    position: "absolute", top: 0, left: 0, right: 0, height: 1,
                    background: `linear-gradient(90deg, transparent, ${C.borderGlow}, transparent)`,
                  }}
                />
                <div
                  style={{
                    fontSize: 8,
                    color: C.text,
                    letterSpacing: "0.18em",
                    textTransform: "uppercase",
                    marginBottom: 10,
                    opacity: 0.5,
                  }}
                >
                  {m.label}
                </div>
                <div
                  style={{
                    fontSize: 22,
                    fontWeight: 700,
                    letterSpacing: "-0.02em",
                    marginBottom: 4,
                    color:
                      m.cls === "green" ? C.green :
                      m.cls === "cyan"  ? C.cyan  :
                      C.textBright,
                    textShadow:
                      m.cls === "green" ? "0 0 24px rgba(0,255,65,0.2)" :
                      m.cls === "cyan"  ? "0 0 24px rgba(0,212,255,0.15)" : "none",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {m.val}
                </div>
                <div style={{ fontSize: 9, color: C.text, opacity: 0.45 }}>{m.sub}</div>
              </div>
            ))}
          </div>

          {/* ── ROW 5: positions table ──────────────────────────────────── */}
          <div id="section-positions" className="anim-fade">
            {/* Status filter row */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 0,
                padding: "10px 28px",
                borderBottom: `1px solid ${C.border}`,
                background: C.bg1,
                flexWrap: "wrap",
              }}
            >
              {STATUS_FILTERS.map((s) => {
                const count =
                  s === "All"
                    ? allPositions.length
                    : allPositions.filter((p) => effectiveStatus(p) === s).length;
                const active = statusFilter === s;
                return (
                  <button
                    key={s}
                    onClick={() => setStatusFilter(s)}
                    style={{
                      fontFamily: FONT,
                      fontSize: 10,
                      letterSpacing: "0.08em",
                      padding: "5px 14px",
                      marginRight: 6,
                      border: `1px solid ${active ? C.greenDim : C.borderHi}`,
                      background: active ? C.greenFaint : "transparent",
                      color: active ? C.green : C.text,
                      cursor: "pointer",
                      transition: "all 0.12s",
                      boxShadow: active ? "0 0 10px rgba(0,255,65,0.08)" : "none",
                    }}
                  >
                    {s === "All" ? "All Positions" : s}{" "}
                    <span style={{ opacity: active ? 0.8 : 0.4, marginLeft: 4, fontSize: 9 }}>
                      ({count})
                    </span>
                  </button>
                );
              })}
              <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                <button
                  onClick={exportCSV}
                  className="term-btn"
                  style={{
                    background: "transparent",
                    border: `1px solid ${C.borderHi}`,
                    color: C.text,
                    padding: "5px 14px",
                    fontSize: 9,
                    fontWeight: 600,
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                    cursor: "pointer",
                    fontFamily: FONT,
                  }}
                >
                  ↓ Export CSV
                </button>
              </div>
            </div>

            {/* Chain filter row */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "12px 28px",
                borderBottom: `1px solid ${C.border}`,
                background: C.bg1,
                flexWrap: "wrap",
              }}
            >
              {CHAIN_FILTERS.map((f) => {
                const active = chainFilter === f;
                return (
                  <button
                    key={f}
                    onClick={() => setChainFilter(f)}
                    className="filter-pill"
                    style={{
                      fontFamily: FONT,
                      fontSize: 9,
                      letterSpacing: "0.1em",
                      textTransform: "uppercase",
                      padding: "4px 12px",
                      cursor: "pointer",
                      border: active ? `1px solid ${C.greenDim}` : `1px solid transparent`,
                      background: active ? C.greenFaint : "transparent",
                      color: active ? C.green : C.text,
                    }}
                  >
                    {f}
                  </button>
                );
              })}
            </div>

            {/* Table */}
            {mounted && isLoading ? (
              <div style={{ textAlign: "center", padding: "64px 0", color: C.text }}>
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
            ) : filtered.length === 0 ? (
              <div style={{ textAlign: "center", padding: "64px 28px", color: C.text }}>
                {!hasWallet ? (
                  <>
                    <div style={{ fontSize: 13, fontWeight: 700, color: C.textBright, marginBottom: 8, letterSpacing: "0.06em" }}>
                      NO_WALLET_CONNECTED
                    </div>
                    <div style={{ color: C.text, fontSize: 11, opacity: 0.6 }}>
                      Connect a wallet to track LP positions across EVM, Solana, and Sui.
                    </div>
                  </>
                ) : allPositions.length === 0 ? (
                  <>
                    <div style={{ fontSize: 13, fontWeight: 700, color: C.textBright, marginBottom: 8, letterSpacing: "0.06em" }}>
                      NO_POSITIONS_FOUND
                    </div>
                    <div style={{ color: C.text, fontSize: 11, opacity: 0.6 }}>
                      No LP positions were found for your connected wallet(s).
                    </div>
                  </>
                ) : (
                  <div style={{ fontSize: 11, opacity: 0.5 }}>No positions match this filter.</div>
                )}
              </div>
            ) : (
              <div style={{ overflowX: "auto" }} className="scroll-thin">
                <table className="ptable" style={{ width: "100%", borderCollapse: "collapse", fontFamily: FONT }}>
                  <thead>
                    <tr style={{ background: C.bg1 }}>
                      {["Position", "Value", "APY", "P&L", "Health", ""].map((h, i) => (
                        <th
                          key={h + i}
                          style={{
                            padding: i === 0 ? "10px 16px 10px 28px" : "10px 16px 10px 0",
                            textAlign: i === 0 ? "left" : "right",
                            fontSize: 8,
                            fontWeight: 400,
                            color: C.text,
                            letterSpacing: "0.16em",
                            textTransform: "uppercase",
                            borderBottom: `1px solid ${C.border}`,
                            opacity: 0.55,
                          }}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((pos) => {
                      const posStatus = effectiveStatus(pos);
                      const slug = encodeURIComponent(pos.id);
                      const dailyEarnings = pos.apy > 0 && pos.value > 0
                        ? (pos.value * pos.apy) / 100 / 365
                        : null;
                      const cat = chainCategory(pos.chain);
                      const chainTok = cat === "OTHER" ? null : CHAIN_DISPLAY[cat];
                      const health = healthFor(posStatus);
                      const hColour = healthColor(health);
                      const isClosed = posStatus === "Closed";

                      // ── P&L: (Current − Initial) + Fees Collected + Fees Unclaimed
                      // (IL is implicit in Current − Initial for an LP position).
                      // Computed from on-chain activity events via computePositionPnL.
                      // Falls back to uncollected-fees-as-proxy when events / prices missing.
                      let pnlUsd: number | null = null;
                      let pnlPct: number | null = null;
                      const events = positionEventsMap.get(pos.id);
                      if (
                        events &&
                        events.length > 0 &&
                        pos.price0 != null &&
                        pos.price1 != null &&
                        pos.price0 > 0 &&
                        pos.price1 > 0
                      ) {
                        const r = computePositionPnL({
                          currentValue: pos.value,
                          unclaimedFeesUSD: pos.fees,
                          price0: pos.price0,
                          price1: pos.price1,
                          events: events as ActivityEventForPnL[],
                          isClosed,
                        });
                        if (r.ok) {
                          pnlUsd = r.data.netPnlUSD;
                          pnlPct = r.data.netPnlPct;
                        }
                      }

                      return (
                        <tr
                          key={pos.id}
                          className="pos-row"
                          style={{ opacity: isClosed ? 0.5 : 1 }}
                          onClick={(e) => {
                            // ignore clicks on the manage button itself
                            if ((e.target as HTMLElement).closest(".manage-btn")) return;
                            window.location.href = `/dashboard/position/${slug}`;
                          }}
                        >
                          {/* Position cell */}
                          <td style={{ padding: "13px 16px 13px 28px", borderBottom: `1px solid ${C.border}`, verticalAlign: "middle", cursor: "pointer" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                              {/* dual token circles */}
                              {(() => {
                                const parts = pos.pair.split(/\s*\/\s*/);
                                const sym0 = parts[0]?.trim() ?? "";
                                const sym1 = parts[1]?.trim() ?? "";
                                const SIZE = 26;
                                const OVERLAP = 8;
                                return (
                                  <div style={{ position: "relative", width: SIZE * 2 - OVERLAP, height: SIZE, flexShrink: 0 }}>
                                    <TokenCircle symbol={sym1} size={SIZE} style={{ position: "absolute", right: 0, top: 0, zIndex: 1 }} />
                                    <TokenCircle symbol={sym0} size={SIZE} style={{ position: "absolute", left: 0, top: 0, zIndex: 2 }} />
                                  </div>
                                );
                              })()}
                              <div>
                                <div style={{ fontSize: 12, fontWeight: 700, color: C.textBright, letterSpacing: "0.02em" }}>
                                  {pos.pair}
                                </div>
                                <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 3 }}>
                                  <span style={{ fontSize: 9, color: C.text, letterSpacing: "0.1em", textTransform: "uppercase", opacity: 0.6 }}>
                                    {pos.protocol}
                                  </span>
                                  {chainTok && (
                                    <span
                                      style={{
                                        fontSize: 8,
                                        padding: "1px 6px",
                                        letterSpacing: "0.1em",
                                        textTransform: "uppercase",
                                        border: `1px solid ${chainTok.border}`,
                                        background: chainTok.faint,
                                        color: chainTok.color,
                                        fontWeight: 600,
                                      }}
                                    >
                                      {pos.chain}
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>
                          </td>

                          {/* Value */}
                          <td style={{ padding: "13px 16px 13px 0", borderBottom: `1px solid ${C.border}`, textAlign: "right", verticalAlign: "middle", cursor: "pointer" }}>
                            <div style={{ fontSize: 12, fontWeight: 700, color: C.textBright, fontVariantNumeric: "tabular-nums" }}>
                              {fmt$(pos.value)}
                            </div>
                            {dailyEarnings !== null && (
                              <div style={{ fontSize: 9, color: C.text, marginTop: 3, opacity: 0.5 }}>
                                ${dailyEarnings.toFixed(2)}/day
                              </div>
                            )}
                          </td>

                          {/* APY */}
                          <td style={{ padding: "13px 16px 13px 0", borderBottom: `1px solid ${C.border}`, textAlign: "right", verticalAlign: "middle", cursor: "pointer" }}>
                            {pos.apy > 0 ? (
                              <>
                                <div style={{ fontSize: 13, fontWeight: 700, color: C.green, textShadow: "0 0 10px rgba(0,255,65,0.25)", fontVariantNumeric: "tabular-nums" }}>
                                  {pos.apy.toFixed(1)}%
                                </div>
                                <div style={{ fontSize: 9, color: C.text, marginTop: 3, opacity: 0.5 }}>
                                  base
                                </div>
                              </>
                            ) : (
                              <div style={{ fontSize: 11, color: C.text, opacity: 0.5 }}>N/A</div>
                            )}
                          </td>

                          {/* P&L = (Current − Initial) + Fees Collected + Fees Unclaimed */}
                          <td style={{ padding: "13px 16px 13px 0", borderBottom: `1px solid ${C.border}`, textAlign: "right", verticalAlign: "middle", cursor: "pointer" }}>
                            {pnlUsd !== null ? (
                              <>
                                <div
                                  style={{
                                    fontSize: 12,
                                    fontWeight: 700,
                                    color: pnlUsd >= 0 ? C.green : C.red,
                                    fontVariantNumeric: "tabular-nums",
                                    textShadow: pnlUsd >= 0 ? "0 0 10px rgba(0,255,65,0.25)" : "0 0 10px rgba(255,51,85,0.25)",
                                  }}
                                >
                                  {pnlUsd >= 0 ? "+" : "-"}{fmt$(Math.abs(pnlUsd))}
                                </div>
                                {pnlPct !== null && Number.isFinite(pnlPct) && (
                                  <div style={{ fontSize: 9, color: C.text, marginTop: 3, opacity: 0.55, fontVariantNumeric: "tabular-nums" }}>
                                    {pnlUsd >= 0 ? "+" : ""}{pnlPct.toFixed(1)}%
                                  </div>
                                )}
                              </>
                            ) : pos.fees > 0 ? (
                              <>
                                <div style={{ fontSize: 12, fontWeight: 700, color: C.green, fontVariantNumeric: "tabular-nums" }}>
                                  +{fmt$(pos.fees)}
                                </div>
                                <div style={{ fontSize: 9, color: C.text, marginTop: 3, opacity: 0.45 }}>
                                  fees only
                                </div>
                              </>
                            ) : (
                              <div style={{ fontSize: 12, fontWeight: 700, color: C.text, fontVariantNumeric: "tabular-nums" }}>—</div>
                            )}
                          </td>

                          {/* Health */}
                          <td style={{ padding: "13px 16px 13px 0", borderBottom: `1px solid ${C.border}`, textAlign: "right", verticalAlign: "middle", cursor: "pointer" }}>
                            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 5 }}>
                              <span style={{ fontSize: 11, fontWeight: 700, color: hColour, fontVariantNumeric: "tabular-nums" }}>
                                {health}%
                              </span>
                              <div style={{ width: 56, height: 2, background: C.border }}>
                                <div
                                  style={{
                                    height: "100%",
                                    width: `${health}%`,
                                    background: hColour,
                                    boxShadow: `0 0 4px ${hColour}88`,
                                  }}
                                />
                              </div>
                            </div>
                          </td>

                          {/* Manage — internal navigation to position detail */}
                          <td style={{ padding: "13px 16px 13px 0", borderBottom: `1px solid ${C.border}`, textAlign: "right", verticalAlign: "middle" }}>
                            <button
                              type="button"
                              className="manage-btn"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                window.location.href = `/dashboard/position/${slug}`;
                              }}
                              style={{
                                fontFamily: FONT,
                                fontSize: 9,
                                fontWeight: 600,
                                letterSpacing: "0.1em",
                                textTransform: "uppercase",
                                padding: "6px 14px",
                                border: `1px solid ${C.borderHi}`,
                                background: "transparent",
                                color: C.text,
                                cursor: "pointer",
                                transition: "all 0.15s",
                                whiteSpace: "nowrap",
                              }}
                            >
                              Manage →
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ── Alerts placeholder section ──────────────────────────────── */}
          <div
            id="section-alerts"
            style={{ padding: "24px 28px", borderTop: `1px solid ${C.border}` }}
          >
            <PaneHead title="alerts" />
            <div style={{ fontSize: 11, color: C.text, padding: "8px 0", letterSpacing: "0.04em" }}>
              ◇ No active alerts.
            </div>
            <div style={{ fontSize: 10, color: C.text, opacity: 0.5, marginTop: 4 }}>
              Coming soon — out-of-range warnings, IL thresholds, and price-drop notifications.
            </div>
          </div>

          {/* Keyboard hint bar */}
          <div
            style={{
              borderTop: `1px solid ${C.border}`,
              padding: "10px 28px",
              display: "flex",
              gap: 24,
              fontSize: 9,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              color: C.text,
              flexWrap: "wrap",
              background: C.bg1,
            }}
          >
            <span><span style={{ color: C.green }}>[F5]</span> refresh</span>
            <span><span style={{ color: C.green }}>[W]</span> manage wallets</span>
            <span style={{ flex: 1 }} />
            <span style={{ color: C.borderGlow }}>v0.9.1-beta</span>
          </div>
        </main>
      </div>

      {/* ── Manage Wallets Modal ─────────────────────────────────────────── */}
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
              fontFamily: FONT,
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
                    color: C.textMid,
                    cursor: "pointer",
                    fontSize: 14,
                    padding: "2px 8px",
                    fontFamily: FONT,
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
                    color: C.textMid,
                    cursor: "pointer",
                    fontSize: 12,
                    padding: "2px 8px",
                    fontFamily: FONT,
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
                      color: C.textBright,
                      padding: "9px 11px",
                      fontSize: 12,
                      outline: "none",
                      boxSizing: "border-box",
                      fontFamily: FONT,
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
                      color: C.textBright,
                      padding: "9px 11px",
                      fontSize: 12,
                      outline: "none",
                      boxSizing: "border-box",
                      fontFamily: FONT,
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
                      background: addWalletAddress.trim() ? C.green : C.bg1,
                      border: `1px solid ${addWalletAddress.trim() ? C.green : C.border}`,
                      color: addWalletAddress.trim() ? "#000" : C.text,
                      padding: "9px",
                      fontSize: 11,
                      fontWeight: 700,
                      letterSpacing: "0.1em",
                      textTransform: "uppercase",
                      cursor: addWalletAddress.trim() ? "pointer" : "not-allowed",
                      fontFamily: FONT,
                    }}
                  >
                    ▸ Add Wallet
                  </button>
                  <div style={{ background: C.greenFaint, border: `1px solid ${C.green}`, padding: "9px 12px", display: "flex", alignItems: "flex-start", gap: 10 }}>
                    <span style={{ color: C.green, fontSize: 13, flexShrink: 0, marginTop: 1 }}>✓</span>
                    <div style={{ fontSize: 11, color: C.textBright, lineHeight: 1.6 }}>
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
                  {address ? (
                    <ConnectedRow tagColor={C.cyan} tagLabel="EVM" addr={address} onDisconnect={() => evmDisconnect()} />
                  ) : (
                    <ConnectButton onClick={() => setShowEvmConnectors(true)} label="Connect EVM Wallet" tagColor={C.cyan} tagLabel="EVM" />
                  )}
                  {solanaAddress ? (
                    <ConnectedRow tagColor={C.purple} tagLabel="SOL" addr={solanaAddress} onDisconnect={() => { setSolanaAddress(null); disconnectSolanaWallet(); }} />
                  ) : (
                    <ConnectButton onClick={() => setShowSolanaWalletList(true)} label="Connect Solana Wallet" tagColor={C.purple} tagLabel="SOL" />
                  )}
                  {suiAddress ? (
                    <ConnectedRow tagColor={C.blue} tagLabel="SUI" addr={suiAddress} onDisconnect={() => { setSuiAddress(null); disconnectSuiWallet(); }} />
                  ) : (
                    <ConnectButton onClick={() => setShowSuiWalletList(true)} label="Connect Sui Wallet" tagColor={C.blue} tagLabel="SUI" />
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
                  { label: "EVM", color: C.cyan,   wallets: evmWalletList },
                  { label: "SOL", color: C.purple, wallets: solWalletList },
                  { label: "SUI", color: C.blue,   wallets: suiWalletList },
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
                            fontSize: 9, color: group.color, fontWeight: 700,
                            textTransform: "uppercase", letterSpacing: "0.16em", marginBottom: 6,
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
                                  background: C.bg1,
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
                                          color: C.textBright,
                                          padding: "3px 8px",
                                          fontSize: 11,
                                          outline: "none",
                                          flex: 1,
                                          fontFamily: FONT,
                                        }}
                                      />
                                      <button
                                        onClick={() => {
                                          const ww = watchedWallets.find((wl) => wl.address === w.addr);
                                          if (ww) updateLabel(ww.address, ww.chain, editLabelValue);
                                          setEditingWallet(null);
                                        }}
                                        style={{
                                          color: C.green, background: "none", border: "none",
                                          cursor: "pointer", fontSize: 11, whiteSpace: "nowrap", fontFamily: FONT,
                                        }}
                                      >
                                        SAVE
                                      </button>
                                      <button
                                        onClick={() => setEditingWallet(null)}
                                        style={{ color: C.text, background: "none", border: "none", cursor: "pointer", fontSize: 12 }}
                                      >
                                        ✕
                                      </button>
                                    </div>
                                  ) : (
                                    <div>
                                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                                        <span style={{ fontSize: 12, fontWeight: 600, color: C.textBright }}>
                                          {w.label || (w.type === "browser" ? group.label : "Watched")}
                                        </span>
                                        {w.type === "watched" && (
                                          <button
                                            onClick={() => { setEditingWallet(w.addr); setEditLabelValue(w.label ?? ""); }}
                                            style={{ color: C.text, background: "none", border: "none", cursor: "pointer", fontSize: 11, padding: 0 }}
                                            title="Edit label"
                                          >
                                            ✎
                                          </button>
                                        )}
                                        <span
                                          style={{
                                            fontSize: 9,
                                            color: w.type === "browser" ? C.green : C.text,
                                            background: w.type === "browser" ? C.greenFaint : "transparent",
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
                                        <span style={{ fontSize: 10, color: C.text, fontFamily: FONT }}>
                                          {w.addr.slice(0, 8)}…{w.addr.slice(-6)}
                                        </span>
                                        <button
                                          onClick={() => navigator.clipboard.writeText(w.addr)}
                                          style={{ color: C.text, background: "none", border: "none", cursor: "pointer", fontSize: 11, padding: 0 }}
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
                                        color: C.red, background: C.redFaint,
                                        border: `1px solid ${C.red}`, padding: "2px 7px",
                                        fontSize: 11, cursor: "pointer", fontFamily: FONT,
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
                                        color: C.red, background: C.redFaint,
                                        border: `1px solid ${C.red}`, padding: "2px 7px",
                                        fontSize: 11, cursor: "pointer", fontFamily: FONT,
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
            </div>

            {/* Sub-pickers */}
            {showEvmConnectors && (
              <SubPickerOverlay title="CHOOSE_EVM_WALLET" onClose={() => setShowEvmConnectors(false)} accent={C.green}>
                {connectors.map((connector, i) => (
                  <button
                    key={connector.id}
                    onClick={() => { evmConnect({ connector: connectors[i] }); setShowEvmConnectors(false); }}
                    style={{
                      display: "flex", alignItems: "center", gap: 10,
                      background: C.bg1, border: `1px solid ${C.border}`,
                      padding: "10px 12px", width: "100%", cursor: "pointer",
                      color: C.textBright, fontFamily: FONT, textAlign: "left",
                    }}
                  >
                    <span style={{ fontSize: 12, color: C.green }}>▸</span>
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 600, color: C.textBright }}>{connector.name}</div>
                      <div style={{ fontSize: 10, color: C.text, letterSpacing: "0.06em" }}>Browser extension</div>
                    </div>
                  </button>
                ))}
              </SubPickerOverlay>
            )}

            {showSolanaWalletList && (
              <SubPickerOverlay title="CHOOSE_SOLANA_WALLET" onClose={() => setShowSolanaWalletList(false)} accent={C.purple}>
                {solanaWallets.length === 0 ? (
                  <div style={{ fontSize: 12, color: C.text, textAlign: "center", padding: 8 }}>
                    No Solana wallet detected. Install Phantom, Backpack, or Solflare.
                  </div>
                ) : (
                  solanaWallets.map((w) => (
                    <button
                      key={w.adapter.name}
                      onClick={() => handleSolanaConnectFromModal(w.adapter.name)}
                      style={{
                        display: "flex", alignItems: "center", gap: 10,
                        background: C.bg1, border: `1px solid ${C.border}`,
                        padding: "10px 12px", width: "100%", cursor: "pointer",
                        color: C.textBright, fontFamily: FONT, textAlign: "left",
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

            {showSuiWalletList && (
              <SubPickerOverlay title="CHOOSE_SUI_WALLET" onClose={() => setShowSuiWalletList(false)} accent={C.blue}>
                {modalSuiWallets.length === 0 ? (
                  <div style={{ fontSize: 12, color: C.text, textAlign: "center", padding: 8 }}>
                    No Sui wallet detected. Install Phantom, Suiet, or Slush.
                  </div>
                ) : (
                  modalSuiWallets.map((w) => (
                    <button
                      key={w.name}
                      onClick={() => handleSuiConnectFromModal(w)}
                      style={{
                        display: "flex", alignItems: "center", gap: 10,
                        background: C.bg1, border: `1px solid ${C.border}`,
                        padding: "10px 12px", width: "100%", cursor: "pointer",
                        color: C.textBright, fontFamily: FONT, textAlign: "left",
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
function PaneHead({
  title, linkLabel, linkColor, onLinkClick,
}: { title: string; linkLabel?: string; linkColor?: string; onLinkClick?: () => void }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom: 20,
      }}
    >
      <div
        style={{
          fontSize: 8,
          letterSpacing: "0.22em",
          textTransform: "uppercase",
          color: C.text,
          opacity: 0.55,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span style={{ color: C.green, opacity: 1, fontSize: 9 }}>//</span>
        {title}
      </div>
      {linkLabel && (
        <button
          type="button"
          onClick={onLinkClick}
          className="pane-link"
          style={{
            fontSize: 9,
            color: linkColor ?? C.text,
            letterSpacing: "0.1em",
            cursor: "pointer",
            background: "none",
            border: "none",
            fontFamily: FONT,
            opacity: linkColor ? 0.85 : 1,
          }}
        >
          {linkLabel}
        </button>
      )}
    </div>
  );
}

function ChartMeta({ label, value, colour }: { label: string; value: string; colour: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 1 }}>
      <div style={{ color: C.text, opacity: 0.5, letterSpacing: "0.1em", textTransform: "uppercase", fontSize: 9 }}>
        {label}
      </div>
      <div style={{ fontWeight: 700, color: colour, fontSize: 12, fontVariantNumeric: "tabular-nums" }}>
        {value}
      </div>
    </div>
  );
}

function ConnectedRow({
  tagColor, tagLabel, addr, onDisconnect,
}: { tagColor: string; tagLabel: string; addr: string; onDisconnect: () => void }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        background: C.bg1,
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
        <span style={{ fontSize: 11, color: C.textBright, fontFamily: FONT }}>
          {addr.slice(0, 8)}…{addr.slice(-6)}
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ color: C.green, fontSize: 11, fontWeight: 600, letterSpacing: "0.08em" }}>● CONNECTED</span>
        <button
          onClick={onDisconnect}
          style={{
            background: C.redFaint,
            border: `1px solid ${C.red}`,
            color: C.red,
            padding: "2px 8px",
            fontSize: 10,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            cursor: "pointer",
            fontFamily: FONT,
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
        background: C.bg1,
        border: `1px solid ${C.border}`,
        padding: "9px 12px",
        width: "100%",
        cursor: "pointer",
        color: C.textBright,
        textAlign: "left",
        fontFamily: FONT,
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
          fontFamily: FONT,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: accent, letterSpacing: "0.16em", textTransform: "uppercase" }}>
            {title}
          </div>
          <button
            onClick={onClose}
            style={{
              color: C.textMid, background: "none", border: `1px solid ${C.border}`,
              cursor: "pointer", fontSize: 11, padding: "1px 8px",
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
