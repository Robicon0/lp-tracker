"use client";

import { useParams } from "next/navigation";
import { useState, useEffect, useMemo, type CSSProperties } from "react";
import Link from "next/link";
import TerminalNavbar from "../../../components/TerminalNavbar";
import { usePositions } from "../../../contexts/PositionsContext";
import type { AerodromePosition } from "../../../lib/aerodrome";
import { getTokenLogo, TOKEN_COLORS } from "../../../lib/tokenLogos";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import { usePositionActivity } from "../../../hooks/usePositionActivity";
import { useBluefinActivity } from "../../../hooks/useBluefinActivity";
import { useOrcaActivity } from "../../../hooks/useOrcaActivity";
import { useRaydiumActivity } from "../../../hooks/useRaydiumActivity";
import { useHyperSwapActivity } from "../../../hooks/useHyperSwapActivity";
import { useUniswapActivity } from "../../../hooks/useUniswapActivity";
import { useVelodromeActivity } from "../../../hooks/useVelodromeActivity";
import { usePancakeSwapActivity } from "../../../hooks/usePancakeSwapActivity";
import { computePositionPnL } from "../../../lib/positionPnl";

// ── Terminal palette (matches position.html exactly) ─────────────────────────
const C = {
  bg:         "#050505",
  bg1:        "#090909",
  bg2:        "#0d0d0d",
  bg3:        "#121212",
  bg4:        "#171717",
  border:     "#1c1c1c",
  borderHi:   "#262626",
  text:       "#a0a0a0",
  textMid:    "#b0b0b0",
  textBright: "#e0e0e0",
  textWhite:  "#f0f0f0",
  green:      "#00ff41",
  greenDim:   "#00992a",
  greenFaint: "rgba(0,255,65,0.06)",
  greenGlow:  "rgba(0,255,65,0.18)",
  cyan:       "#00d4ff",
  cyanFaint:  "rgba(0,212,255,0.07)",
  red:        "#ff3355",
  redFaint:   "rgba(255,51,85,0.07)",
  amber:      "#ffaa00",
  purple:     "#9945ff",
  blue:       "#3d9fff",
} as const;

const FONT = "'JetBrains Mono','Courier New',monospace";

const SCANLINE_BG =
  "repeating-linear-gradient(0deg, transparent, transparent 3px, rgba(0,0,0,0.012) 3px, rgba(0,0,0,0.012) 4px)";

// ── Token logo circle ─────────────────────────────────────────────────────────
function TokenCircle({
  symbol, size = 44, style,
}: { symbol: string; size?: number; style?: CSSProperties }) {
  const [imgErr, setImgErr] = useState(false);
  const logoUrl = getTokenLogo(symbol);
  const color = TOKEN_COLORS[symbol] ?? TOKEN_COLORS[symbol.toUpperCase()] ?? "#3d3d3d";
  const base: CSSProperties = {
    width: size, height: size, borderRadius: "50%",
    border: `1px solid ${C.borderHi}`, flexShrink: 0, background: C.bg2, ...style,
  };
  if (logoUrl && !imgErr) {
    return <img src={logoUrl} alt={symbol} onError={() => setImgErr(true)}
      style={{ ...base, objectFit: "cover", display: "block" }} />;
  }
  return (
    <div style={{
      ...base, background: color,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: size * 0.22, fontWeight: 700, color: C.textWhite, letterSpacing: "0.04em",
    }}>
      {symbol.length <= 4 ? symbol.toUpperCase() : symbol.slice(0, 4).toUpperCase()}
    </div>
  );
}

// ── Fee-snapshot localStorage helpers (unchanged) ────────────────────────────
const FEE_LS_KEY = "defidesh-fee-history";
const MIN_SNAPSHOT_MS = 5 * 60 * 1000;

interface FeeSnapshot {
  timestamp: number;
  feesUSD: number;
  fees0?: number;
  fees1?: number;
}

function loadSnapshots(posId: string): FeeSnapshot[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(FEE_LS_KEY);
    if (!raw) return [];
    return (JSON.parse(raw) as Record<string, FeeSnapshot[]>)[posId] ?? [];
  } catch { return []; }
}

function appendSnapshot(posId: string, snap: FeeSnapshot): FeeSnapshot[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(FEE_LS_KEY);
    const all = raw ? (JSON.parse(raw) as Record<string, FeeSnapshot[]>) : {};
    const existing = all[posId] ?? [];
    const last = existing[existing.length - 1];
    if (last && snap.timestamp - last.timestamp < MIN_SNAPSHOT_MS) return existing;
    const updated = [...existing, snap].slice(-1000);
    all[posId] = updated;
    localStorage.setItem(FEE_LS_KEY, JSON.stringify(all));
    return updated;
  } catch { return []; }
}

// ── Constants ─────────────────────────────────────────────────────────────────
const STABLES = new Set(["USDC", "USDT", "DAI", "USDbC", "USDC.e", "USDS"]);

// ── Helpers ───────────────────────────────────────────────────────────────────
function effectiveStatus(p: AerodromePosition): "In Range" | "Out of Range" | "Closed" {
  if (p.value === 0 && p.fees === 0) return "Closed";
  return p.status as "In Range" | "Out of Range";
}

function getManageUrl(protocol: string): string {
  if (protocol.includes("Aerodrome"))  return "https://aerodrome.finance/dash";
  if (protocol.includes("Velodrome"))  return "https://velodrome.finance/dash";
  if (protocol.includes("Uniswap"))    return "https://app.uniswap.org/pool";
  if (protocol.includes("Orca"))       return "https://www.orca.so/portfolio";
  if (protocol.includes("Raydium"))    return "https://raydium.io/portfolio/";
  if (protocol.includes("Bluefin"))    return "https://trade.bluefin.io/lend";
  if (protocol.includes("Cetus"))      return "https://app.cetus.zone/position";
  if (protocol.includes("Momentum"))   return "https://app.mmt.finance";
  if (protocol.includes("HyperSwap"))  return "https://app.hyperswap.fi/pool";
  if (protocol.includes("KittenSwap")) return "https://www.kittenswap.org";
  if (protocol.includes("ProjectX") || protocol.includes("PRJX")) return "https://prjx.com";
  if (protocol.includes("PancakeSwap")) return "https://pancakeswap.finance/liquidity";
  return "";
}

function fmtLarge(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function tickToUSD(tick: number, pos: AerodromePosition): number | null {
  const d0 = pos.token0Decimals ?? 18;
  const d1 = pos.token1Decimals ?? 6;
  try {
    const raw = Math.pow(1.0001, tick) * Math.pow(10, d0 - d1);
    if (!isFinite(raw) || raw <= 0) return null;
    if (STABLES.has(pos.token1Symbol ?? "")) return raw;
    if (STABLES.has(pos.token0Symbol ?? "")) {
      const inv = 1 / raw;
      return isFinite(inv) && inv > 0 ? inv : null;
    }
    if (pos.price1 && pos.price1 > 0) return raw * pos.price1;
    return raw;
  } catch { return null; }
}

function fmtPrice(n: number): string {
  if (n >= 1_000) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  if (n >= 1)     return `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  if (n >= 0.0001) return `$${n.toFixed(6)}`;
  return `$${n.toExponential(2)}`;
}

function fmt$(n: number, dec = 2): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec })}`;
}

function getCurrentPrice(pos: AerodromePosition): number | null {
  if (STABLES.has(pos.token1Symbol ?? "")) return pos.price0 ?? null;
  if (STABLES.has(pos.token0Symbol ?? "")) return pos.price1 ?? null;
  return pos.price0 ?? null;
}

function chainColor(chain: string): string {
  const map: Record<string, string> = {
    Base: C.blue, Ethereum: C.cyan, Arbitrum: C.green, Optimism: "#ff0420",
    Polygon: C.purple, Avalanche: "#e84142", Solana: C.purple, Sui: C.blue,
    HyperEVM: "#00d4aa", "BNB Chain": C.amber,
  };
  return map[chain] ?? C.green;
}

// ── Section frame ────────────────────────────────────────────────────────────
function Section({
  icon, title, sub, right, children,
}: {
  icon: string;
  title: string;
  sub?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section style={{ borderBottom: `1px solid ${C.border}`, animation: "_fadeUp 0.45s ease both" }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", padding: "24px 40px 0", marginBottom: 18, gap: 16, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
          <span style={{ fontSize: 14, color: C.green, letterSpacing: "0.1em" }}>{icon}</span>
          <div>
            <div style={{ fontSize: 15.5, fontWeight: 700, color: C.textBright, letterSpacing: "0.18em", textTransform: "uppercase" }}>
              {title}
            </div>
            {sub && <div style={{ fontSize: 14, color: C.text, opacity: 0.55, marginTop: 4 }}>{sub}</div>}
          </div>
        </div>
        {right && <div style={{ marginRight: 0 }}>{right}</div>}
      </div>
      {children}
    </section>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────
export default function PositionDetail() {
  const params = useParams();
  const { positions, isLoading } = usePositions();

  const rawId = typeof params.id === "string" ? params.id : Array.isArray(params.id) ? params.id[0] : "";
  const posId = decodeURIComponent(rawId);
  const pos   = positions.find((p) => p.id === posId) ?? null;

  // ── Derived data ────────────────────────────────────────────────────────────
  const posStatus  = pos ? effectiveStatus(pos) : "Closed";
  const isClosed   = posStatus === "Closed";
  const manageUrl  = pos ? getManageUrl(pos.protocol) : "";

  const t0  = pos?.token0Symbol ?? "Token0";
  const t1  = pos?.token1Symbol ?? "Token1";

  // Price range
  const hasRange    = pos != null && pos.tickLower != null && pos.tickUpper != null;
  const minPriceUSD = hasRange && pos ? tickToUSD(pos.tickLower!, pos) : null;
  const maxPriceUSD = hasRange && pos ? tickToUSD(pos.tickUpper!, pos) : null;
  const curPriceUSD = pos ? getCurrentPrice(pos) : null;

  let rangeBarPct = 50;
  if (minPriceUSD !== null && maxPriceUSD !== null && curPriceUSD !== null && maxPriceUSD > minPriceUSD) {
    rangeBarPct = Math.max(2, Math.min(98, ((curPriceUSD - minPriceUSD) / (maxPriceUSD - minPriceUSD)) * 100));
  }

  const rangeWidthPct = (minPriceUSD && maxPriceUSD && minPriceUSD > 0)
    ? ((maxPriceUSD - minPriceUSD) / minPriceUSD * 100).toFixed(2)
    : null;

  const distLower = (minPriceUSD && curPriceUSD && curPriceUSD > 0)
    ? ((minPriceUSD - curPriceUSD) / curPriceUSD * 100).toFixed(1)
    : null;
  const distUpper = (maxPriceUSD && curPriceUSD && curPriceUSD > 0)
    ? ((maxPriceUSD - curPriceUSD) / curPriceUSD * 100).toFixed(1)
    : null;

  // APR / cashflow
  const hasApr     = (pos?.apy ?? 0) > 0 && (pos?.value ?? 0) > 0;
  const dailyUSD   = hasApr ? pos!.value * pos!.apy / 100 / 365 : null;
  const weeklyUSD  = hasApr ? pos!.value * pos!.apy / 100 / 52  : null;
  const monthlyUSD = hasApr ? pos!.value * pos!.apy / 100 / 12  : null;
  const yearlyUSD  = hasApr ? pos!.value * pos!.apy / 100       : null;

  // Amounts
  const hasAmounts = pos != null && (pos.amount0 != null || pos.amount1 != null);
  const hasFees    = pos != null && (pos.fees0 != null || pos.fees1 != null);

  // ── Fee tracking (unused chart historical fallback, retained for snapshot side-effect parity) ──
  const [, setSnapshots] = useState<FeeSnapshot[]>([]);
  void loadSnapshots;

  // ── Pool statistics (from DefiLlama) ────────────────────────────────────────
  const [poolStats, setPoolStats] = useState<{ tvlUsd: number | null; volumeUsd1d: number | null; feesUsd1d: number | null } | null>(null);
  const [poolStatsLoading, setPoolStatsLoading] = useState(false);

  useEffect(() => {
    if (!pos) return;
    setPoolStatsLoading(true);
    const params = new URLSearchParams({ protocol: pos.protocol, chain: pos.chain, pair: pos.pair });
    fetch(`/api/pool-stats?${params.toString()}`)
      .then(r => r.json())
      .then(data => { setPoolStats(data); setPoolStatsLoading(false); })
      .catch(() => setPoolStatsLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos?.id]);

  // Snapshot fee history on every refresh (still used for legacy listeners)
  useEffect(() => {
    if (!pos) return;
    const snap: FeeSnapshot = {
      timestamp: Date.now(),
      feesUSD: pos.fees,
      fees0: pos.fees0,
      fees1: pos.fees1,
    };
    const updated = appendSnapshot(pos.id, snap);
    setSnapshots(updated);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos?.id, pos?.fees]);

  // ── Activity data (on-chain fee claim history) ───────────────────────────
  const HYPEREVM_PROTOCOLS = new Set(['HyperSwap', 'KittenSwap', 'ProjectX']);
  const isHyperEVM = pos ? HYPEREVM_PROTOCOLS.has(pos.protocol) : false;

  const aeroTokenId = pos?.protocol === 'Aerodrome' ? pos.id.replace('aero-', '') : null;
  const { data: aeroActivity, isLoading: aeroActivityLoading, error: aeroActivityError } = usePositionActivity(
    aeroTokenId, pos?.token0Decimals ?? 18, pos?.token1Decimals ?? 18,
    pos?.token0Address, pos?.token1Address, pos?.price0, pos?.price1,
    pos?.tickLower, pos?.tickUpper,
  );

  const bluefinObjId = pos?.protocol === 'Bluefin' ? pos.id.replace('bluefin-', '') : null;
  const { data: bluefinActivity, isLoading: bluefinActivityLoading, error: bluefinActivityError } = useBluefinActivity(
    bluefinObjId, pos?.token0Decimals ?? 9, pos?.token1Decimals ?? 6,
    pos?.coinTypeA, pos?.coinTypeB, pos?.price0, pos?.price1, pos?.walletAddress,
    pos?.tickLower, pos?.tickUpper,
  );

  const orcaPosId = pos?.protocol === 'Orca' ? pos.id.replace('orca-', '') : null;
  const { data: orcaActivity, isLoading: orcaActivityLoading, error: orcaActivityError } = useOrcaActivity(
    orcaPosId, pos?.token0Decimals ?? 9, pos?.token1Decimals ?? 6,
    pos?.token0Address, pos?.token1Address, pos?.price0, pos?.price1, pos?.walletAddress,
    pos?.tickLower, pos?.tickUpper,
  );

  const raydiumPosId = pos?.protocol === 'Raydium' ? pos.id.replace('ray-', '') : null;
  const { data: raydiumActivity, isLoading: raydiumActivityLoading, error: raydiumActivityError } = useRaydiumActivity(
    raydiumPosId, pos?.token0Decimals ?? 9, pos?.token1Decimals ?? 6,
    pos?.token0Address, pos?.token1Address, pos?.price0, pos?.price1, pos?.walletAddress,
    pos?.tickLower, pos?.tickUpper,
  );

  const hyperswapTokenId = pos && HYPEREVM_PROTOCOLS.has(pos.protocol)
    ? pos.id.replace(/^hyperswap-[^-]+-/, '')
    : null;
  const { data: hyperswapActivity, isLoading: hyperswapActivityLoading, error: hyperswapActivityError } = useHyperSwapActivity(
    hyperswapTokenId, pos && HYPEREVM_PROTOCOLS.has(pos.protocol) ? pos.protocol : null,
    pos?.token0Decimals ?? 18, pos?.token1Decimals ?? 6,
    pos?.token0Address, pos?.token1Address, pos?.price0, pos?.price1,
    pos?.tickLower, pos?.tickUpper,
  );

  const uniswapPosId = pos?.protocol === 'Uniswap V3' ? pos.id : null;
  const { data: uniswapActivity, isLoading: uniswapActivityLoading, error: uniswapActivityError } = useUniswapActivity(
    uniswapPosId, pos?.token0Decimals ?? 18, pos?.token1Decimals ?? 18,
    pos?.token0Address, pos?.token1Address, pos?.price0, pos?.price1,
    pos?.tickLower, pos?.tickUpper,
  );

  const velodromePosId = pos?.protocol === 'Velodrome' ? pos.id.replace('velo-', '') : null;
  const { data: velodromeActivity, isLoading: velodromeActivityLoading, error: velodromeActivityError } = useVelodromeActivity(
    velodromePosId, pos?.token0Decimals ?? 18, pos?.token1Decimals ?? 18,
    pos?.token0Address, pos?.token1Address, pos?.price0, pos?.price1,
    pos?.tickLower, pos?.tickUpper,
  );

  const pancakeTokenId = pos?.protocol === 'PancakeSwap V3' ? pos.id.replace('cake3-bsc-', '') : null;
  const { data: pancakeActivity, isLoading: pancakeActivityLoading } = usePancakeSwapActivity(
    pancakeTokenId, pos?.token0Decimals ?? 18, pos?.token1Decimals ?? 18,
    pos?.token0Address, pos?.token1Address, pos?.price0, pos?.price1,
    pos?.tickLower, pos?.tickUpper,
  );

  const activity = pos?.protocol === 'Aerodrome' ? aeroActivity
    : pos?.protocol === 'Bluefin' ? bluefinActivity
    : pos?.protocol === 'Orca' ? orcaActivity
    : pos?.protocol === 'Raydium' ? raydiumActivity
    : isHyperEVM ? hyperswapActivity
    : pos?.protocol === 'Uniswap V3' ? uniswapActivity
    : pos?.protocol === 'Velodrome' ? velodromeActivity
    : pos?.protocol === 'PancakeSwap V3' ? pancakeActivity
    : null;
  const activityLoading = pos?.protocol === 'Aerodrome' ? aeroActivityLoading
    : pos?.protocol === 'Bluefin' ? bluefinActivityLoading
    : pos?.protocol === 'Orca' ? orcaActivityLoading
    : pos?.protocol === 'Raydium' ? raydiumActivityLoading
    : isHyperEVM ? hyperswapActivityLoading
    : pos?.protocol === 'Uniswap V3' ? uniswapActivityLoading
    : pos?.protocol === 'Velodrome' ? velodromeActivityLoading
    : pos?.protocol === 'PancakeSwap V3' ? pancakeActivityLoading
    : false;
  const activityError = pos?.protocol === 'Aerodrome' ? aeroActivityError
    : pos?.protocol === 'Bluefin' ? bluefinActivityError
    : pos?.protocol === 'Orca' ? orcaActivityError
    : pos?.protocol === 'Raydium' ? raydiumActivityError
    : isHyperEVM ? hyperswapActivityError
    : pos?.protocol === 'Uniswap V3' ? uniswapActivityError
    : pos?.protocol === 'Velodrome' ? velodromeActivityError
    : null;
  const isActivityProtocol = ['Aerodrome', 'Bluefin', 'Orca', 'Raydium', 'Uniswap V3', 'Velodrome', 'PancakeSwap V3'].includes(pos?.protocol ?? '') || isHyperEVM;
  const activityPending = isActivityProtocol && !activity && !activityError;

  // Build fee accumulation chart from on-chain activity fee_claim events.
  const feeChartData = useMemo(() => {
    if (!activity?.events || activity.events.length === 0) return null;

    const chronological = [...activity.events].reverse();
    const feeClaims = chronological.filter(
      (e) => (e.type === 'fee_claim' || e.type === 'reward_claim') && e.timestamp > 0,
    );

    if (feeClaims.length === 0) return { chartData: [] as { label: string; value: number }[], noClaimsYet: true, openTs: 0 };

    const firstDeposit = chronological.find((e) => e.type === 'deposit');
    const openTs = firstDeposit ? firstDeposit.timestamp * 1000 : feeClaims[0].timestamp * 1000;

    let cumulative = 0;
    const chartData: { label: string; value: number }[] = [
      { label: new Date(openTs).toLocaleDateString("en-US", { month: "short", day: "numeric" }), value: 0 },
    ];

    for (const ev of feeClaims) {
      cumulative += ev.usdAtTime ?? 0;
      chartData.push({
        label: new Date(ev.timestamp * 1000).toLocaleDateString("en-US", {
          month: "short", day: "numeric",
        }),
        value: cumulative,
      });
    }

    return { chartData, noClaimsYet: false, openTs };
  }, [activity]);

  // ── Loading state ──────────────────────────────────────────────────────────
  if (isLoading && !pos) {
    return (
      <div style={{ background: C.bg, color: C.text, minHeight: "100vh", fontFamily: FONT }}>
        <TerminalNavbar />
        <div style={{ padding: 64, textAlign: "center" }}>
          <div style={{
            width: 32, height: 32, border: `2px solid ${C.green}`, borderTopColor: "transparent",
            borderRadius: "50%", margin: "0 auto 16px",
            animation: "_spin 1s linear infinite",
          }} />
          <style>{`@keyframes _spin { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }`}</style>
          <p style={{ color: C.text, fontSize: 14, letterSpacing: "0.12em", textTransform: "uppercase" }}>Loading position…</p>
        </div>
      </div>
    );
  }

  // ── Not found ──────────────────────────────────────────────────────────────
  if (!pos) {
    return (
      <div style={{ background: C.bg, color: C.text, minHeight: "100vh", fontFamily: FONT }}>
        <TerminalNavbar />
        <div style={{ padding: 64, textAlign: "center" }}>
          <h2 style={{ fontSize: 28, fontWeight: 700, color: C.textWhite, marginBottom: 12, letterSpacing: "-0.01em" }}>
            Position not found
          </h2>
          <p style={{ color: C.text, marginBottom: 24, fontSize: 15 }}>
            This position could not be located. It may have been closed or the data hasn&apos;t loaded yet.
          </p>
          <Link href="/dashboard" style={{
            border: `1px solid ${C.greenDim}`, background: C.greenFaint, color: C.green,
            padding: "10px 18px", textDecoration: "none", fontSize: 14,
            fontFamily: FONT, letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 600,
          }}>
            ← Back to Dashboard
          </Link>
        </div>
      </div>
    );
  }

  // ── Derived activity metrics ───────────────────────────────────────────────
  const feeClaims = activity?.events.filter(e => e.type === 'fee_claim' || e.type === 'reward_claim') ?? [];
  const deposits = activity?.events.filter(e => e.type === 'deposit') ?? [];
  const claimedUSD = feeClaims.reduce((sum, e) => {
    if (e.usdAtTime != null) return sum + e.usdAtTime;
    return sum + e.amount0 * (pos.price0 ?? 0) + e.amount1 * (pos.price1 ?? 0);
  }, 0);
  const uncollectedUSD = pos.fees;
  const lifetimeUSD = claimedUSD + uncollectedUSD;
  const firstDeposit = deposits.length > 0 ? deposits[deposits.length - 1] : null;
  const firstTs = firstDeposit?.timestamp ?? 0;
  const nowTs = Math.floor(Date.now() / 1000);
  const daysActive = firstTs > 0 ? (nowTs - firstTs) / 86400 : 0;
  const actualAPR = daysActive >= 1 && pos.value > 0 && claimedUSD > 0
    ? (claimedUSD / pos.value) / (daysActive / 365) * 100
    : null;
  const actualDailyIncome = daysActive >= 1 && claimedUSD > 0 ? claimedUSD / daysActive : null;
  const feeIncomePct = pos.value > 0 ? (lifetimeUSD / pos.value) * 100 : 0;
  const daysLabel = daysActive >= 1 ? `${Math.floor(daysActive)}d` : (firstTs > 0 ? '<1d' : '—');
  const openedDate = firstTs > 0 ? new Date(firstTs * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : null;

  // P&L
  const pnlEvents = activity?.events.map((e) => ({
    type: e.type as 'deposit' | 'withdrawal' | 'fee_claim' | 'reward_claim',
    timestamp: e.timestamp as number,
    amount0: e.amount0 as number,
    amount1: e.amount1 as number,
    usdAtTime: (e.usdAtTime as number | null) ?? null,
    price0AtTime: (e.price0AtTime as number | null) ?? null,
    price1AtTime: (e.price1AtTime as number | null) ?? null,
    txHash: e.txHash ?? undefined,
  })) ?? [];
  const pnlResult = isActivityProtocol && activity ? computePositionPnL({
    currentValue: pos.value,
    unclaimedFeesUSD: pos.fees ?? 0,
    price0: pos.price0 ?? 0,
    price1: pos.price1 ?? 0,
    events: pnlEvents,
    isClosed: pos.status === "Closed",
  }) : null;
  const pnl = pnlResult?.ok ? pnlResult.data : null;
  const pnlPositive = pnl ? pnl.netPnlUSD >= 0 : false;
  const ilNegative  = pnl ? pnl.ilUSD < 0 : false;
  const totalFees   = pnl ? pnl.feesCollected + pnl.feesUnclaimed : 0;

  // Tx URL builder
  const txUrl = (hash: string): string => {
    if (pos.protocol === 'Bluefin') return `https://suivision.xyz/txblock/${hash}`;
    if (pos.protocol === 'Orca' || pos.protocol === 'Raydium') return `https://solscan.io/tx/${hash}`;
    if (HYPEREVM_PROTOCOLS.has(pos.protocol)) return `https://hyperevmscan.io/tx/${hash}`;
    if (pos.chain === 'Arbitrum') return `https://arbiscan.io/tx/${hash}`;
    if (pos.chain === 'Polygon')  return `https://polygonscan.com/tx/${hash}`;
    if (pos.chain === 'Optimism') return `https://optimistic.etherscan.io/tx/${hash}`;
    if (pos.chain === 'Ethereum') return `https://etherscan.io/tx/${hash}`;
    if (pos.chain === 'BNB Chain') return `https://bscscan.com/tx/${hash}`;
    return `https://basescan.org/tx/${hash}`;
  };
  const shortHash = (h: string) => h.length > 12 ? `${h.slice(0, 6)}…${h.slice(-4)}` : h;
  const fmtDate = (ts: number) => !ts ? '—' : new Date(ts * 1000).toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
  });
  const fmtAmt = (n: number) => n === 0 ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: 6 });

  // ── Wallet truncation ──────────────────────────────────────────────────────
  const truncWallet = pos.walletAddress
    ? `${pos.walletAddress.slice(0, 6)}…${pos.walletAddress.slice(-4)}`
    : null;

  // Helpers for inline styles
  const cellPadding = "20px 24px";
  const labelStyle: CSSProperties = {
    fontSize: 12, color: C.text, letterSpacing: "0.18em", textTransform: "uppercase",
    marginBottom: 10, opacity: 0.6, fontFamily: FONT,
  };
  const subStyle: CSSProperties = {
    fontSize: 12, color: C.text, marginTop: 5, opacity: 0.6, letterSpacing: "0.04em",
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div style={{
      display: "flex",
      flexDirection: "column",
      minHeight: "100vh",
      background: C.bg,
      color: C.text,
      fontFamily: FONT,
      fontSize: 16,
      lineHeight: 1.5,
      overflowX: "hidden",
    }}>
      <style>{`
        @keyframes _spin   { from { transform:rotate(0deg) } to { transform:rotate(360deg) } }
        @keyframes _pulse  { 0%,100%{opacity:1} 50%{opacity:0.3} }
        @keyframes _fadeUp { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
        @keyframes _scan   { 0%{transform:translateX(-100%)} 100%{transform:translateX(100%)} }
        .pos-row:hover td { background: rgba(255,255,255,0.012); }
        .btn-neutral:hover { border-color: ${C.text} !important; color: ${C.textBright} !important; background: ${C.bg2} !important; }
        .btn-primary:hover { background: rgba(0,255,65,0.12) !important; box-shadow: 0 0 14px rgba(0,255,65,0.18); }
        .tx-link:hover { opacity: 0.7; }
      `}</style>

      {/* Scanline overlay */}
      <div aria-hidden style={{
        position: "fixed", inset: 0, pointerEvents: "none", zIndex: 9998, background: SCANLINE_BG,
      }} />

      <TerminalNavbar />

      <main style={{ flex: 1, background: C.bg }}>

        {/* ── BACK BAR ────────────────────────────────────────────────────── */}
        <div style={{
          padding: "14px 40px",
          borderBottom: `1px solid ${C.border}`,
          display: "flex", alignItems: "center", gap: 14,
        }}>
          <Link href="/dashboard" style={{
            fontSize: 14, color: C.text, textDecoration: "none",
            letterSpacing: "0.08em", textTransform: "uppercase",
            transition: "color 0.15s",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.color = C.textMid)}
          onMouseLeave={(e) => (e.currentTarget.style.color = C.text)}
          >
            ← Back to Dashboard
          </Link>
          <span style={{ color: C.borderHi, fontSize: 12 }}>›</span>
          <span style={{ fontSize: 14, color: C.text, letterSpacing: "0.06em" }}>
            <span style={{ color: C.green }}>// position_detail</span> · {pos.id}
          </span>
        </div>

        {/* ── POSITION HEADER ─────────────────────────────────────────────── */}
        <div style={{
          padding: "32px 40px 28px",
          borderBottom: `1px solid ${C.border}`,
          background: `linear-gradient(180deg, ${C.bg1} 0%, ${C.bg} 100%)`,
          position: "relative",
          animation: "_fadeUp 0.4s ease both",
        }}>
          <div aria-hidden style={{
            position: "absolute", top: 0, left: 0, right: 0, height: 1,
            background: `linear-gradient(90deg, transparent, ${C.greenGlow} 30%, ${C.greenGlow} 70%, transparent)`,
            opacity: 0.4,
          }} />
          <div style={{
            fontSize: 12, color: C.text, letterSpacing: "0.22em", textTransform: "uppercase",
            marginBottom: 14, opacity: 0.6,
          }}>
            <span style={{ color: C.green, opacity: 1 }}>// liquidity_position</span> · {pos.protocol.toLowerCase().replace(/ /g, "_")} · {pos.chain.toLowerCase().replace(/ /g, "_")}_network
          </div>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 24, flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
              {/* Overlapping token icons */}
              <div style={{ display: "flex", alignItems: "center" }}>
                <TokenCircle symbol={t0} size={44} style={{ position: "relative", zIndex: 2 }} />
                <TokenCircle symbol={t1} size={44} style={{ marginLeft: -14, position: "relative", zIndex: 1 }} />
              </div>
              <div>
                <div style={{ fontSize: 30, fontWeight: 700, color: C.textWhite, letterSpacing: "-0.01em" }}>
                  {t0} / {t1}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8, flexWrap: "wrap" }}>
                  {/* Protocol tag */}
                  <span style={{
                    fontSize: 12, letterSpacing: "0.1em", textTransform: "uppercase",
                    padding: "4px 12px", border: `1px solid ${C.cyan}4d`, background: C.cyanFaint,
                    color: C.cyan, fontWeight: 600,
                  }}>
                    {pos.protocol}
                  </span>
                  {/* Status tag */}
                  <span style={{
                    fontSize: 12, letterSpacing: "0.1em", textTransform: "uppercase",
                    padding: "4px 12px", fontWeight: 600,
                    display: "flex", alignItems: "center", gap: 6,
                    border: `1px solid ${
                      isClosed ? C.borderHi : posStatus === "In Range" ? C.greenDim : C.amber
                    }`,
                    background: isClosed ? C.bg2
                      : posStatus === "In Range" ? C.greenFaint
                      : "rgba(255,170,0,0.06)",
                    color: isClosed ? C.text
                      : posStatus === "In Range" ? C.green
                      : C.amber,
                  }}>
                    {!isClosed && posStatus === "In Range" && (
                      <span style={{
                        width: 6, height: 6, background: C.green,
                        animation: "_pulse 2s infinite",
                      }} />
                    )}
                    {posStatus}
                  </span>
                  {/* Fee tier tag */}
                  {pos.feeTier != null && (
                    <span style={{
                      fontSize: 12, letterSpacing: "0.1em", textTransform: "uppercase",
                      padding: "4px 12px", border: `1px solid ${C.borderHi}`, background: C.bg2,
                      color: C.textMid, fontWeight: 600,
                    }}>
                      {pos.feeTier}% Tier
                    </span>
                  )}
                </div>
                {/* Sub meta row */}
                <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 14, fontSize: 14, color: C.text, letterSpacing: "0.06em", flexWrap: "wrap" }}>
                  <span style={{ color: chainColor(pos.chain), textTransform: "uppercase", letterSpacing: "0.12em", fontWeight: 600 }}>
                    ◆ {pos.chain}
                  </span>
                  {truncWallet && (
                    <>
                      <span style={{ color: C.borderHi }}>·</span>
                      <span>wallet <code style={{ color: C.textMid, fontFamily: FONT }}>{truncWallet}</code></span>
                    </>
                  )}
                  {openedDate && (
                    <>
                      <span style={{ color: C.borderHi }}>·</span>
                      <span>
                        Opened <strong style={{ color: C.textMid, fontWeight: 600 }}>{openedDate}</strong>
                        {daysLabel !== '—' && (
                          <> · <span style={{ color: C.green }}>{daysLabel} active</span></>
                        )}
                      </span>
                    </>
                  )}
                </div>
              </div>
            </div>
            {/* Actions */}
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              {manageUrl && (
                <a href={manageUrl} target="_blank" rel="noopener noreferrer"
                  className="btn-primary"
                  style={{
                    fontFamily: FONT, fontSize: 14, fontWeight: 600,
                    letterSpacing: "0.1em", textTransform: "uppercase",
                    padding: "10px 18px",
                    border: `1px solid ${C.greenDim}`, background: C.greenFaint,
                    color: C.green, textDecoration: "none",
                    display: "flex", alignItems: "center", gap: 8,
                    cursor: "pointer", transition: "all 0.15s",
                  }}>
                  ↗ Manage Position
                </a>
              )}
            </div>
          </div>
        </div>

        {/* ── TOP STAT STRIP (4 cells) ──────────────────────────────────── */}
        <div style={{
          display: "grid", gridTemplateColumns: "repeat(4, 1fr)",
          borderBottom: `1px solid ${C.border}`,
          animation: "_fadeUp 0.5s ease 0.05s both",
        }}>
          {/* Total Value */}
          <div style={{ padding: "24px 28px", borderRight: `1px solid ${C.border}`, position: "relative", background: C.bg }}>
            <div style={{ ...labelStyle, display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 5, height: 5, background: C.green }} />
              Total Value
            </div>
            <div style={{ fontSize: 32, fontWeight: 700, letterSpacing: "-0.02em", color: C.textWhite, fontVariantNumeric: "tabular-nums" }}>
              {fmt$(pos.value)}
            </div>
            <div style={{ ...subStyle, opacity: 0.7 }}>live mark-to-market</div>
          </div>
          {/* Uncollected Fees */}
          <div style={{ padding: "24px 28px", borderRight: `1px solid ${C.border}`, background: C.bg }}>
            <div style={{ ...labelStyle, display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 5, height: 5, background: C.green }} />
              Uncollected Fees
            </div>
            <div style={{
              fontSize: 32, fontWeight: 700, letterSpacing: "-0.02em",
              color: pos.fees > 0 ? C.green : C.text,
              textShadow: pos.fees > 0 ? "0 0 20px rgba(0,255,65,0.25)" : "none",
              fontVariantNumeric: "tabular-nums",
            }}>
              {fmt$(pos.fees)}
            </div>
            <div style={{ ...subStyle, color: pos.fees > 0 ? C.green : C.text }}>
              {pos.fees > 0 ? "↑ ready to collect" : "no fees pending"}
            </div>
          </div>
          {/* Estimated APR */}
          <div style={{ padding: "24px 28px", borderRight: `1px solid ${C.border}`, background: C.bg }}>
            <div style={{ ...labelStyle, display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 5, height: 5, background: C.green }} />
              Estimated APR
            </div>
            <div style={{
              fontSize: 32, fontWeight: 700, letterSpacing: "-0.02em",
              color: hasApr ? C.cyan : C.text,
              textShadow: hasApr ? "0 0 16px rgba(0,212,255,0.2)" : "none",
              fontVariantNumeric: "tabular-nums",
            }}>
              {hasApr ? `+${pos.apy.toFixed(1)}%` : "N/A"}
            </div>
            <div style={subStyle}>based on pool APY</div>
          </div>
          {/* Est. Cashflow (mini list) */}
          <div style={{ padding: "24px 28px", background: C.bg }}>
            <div style={{ ...labelStyle, display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 5, height: 5, background: C.green }} />
              Est. Cashflow
            </div>
            {hasApr ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 2 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14 }}>
                  <span style={{ color: C.text, opacity: 0.6 }}>Daily</span>
                  <span style={{ color: C.green, fontWeight: 600 }}>+{fmt$(dailyUSD!)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14 }}>
                  <span style={{ color: C.text, opacity: 0.6 }}>Monthly</span>
                  <span style={{ color: C.green, fontWeight: 600 }}>+{fmt$(monthlyUSD!)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14 }}>
                  <span style={{ color: C.text, opacity: 0.6 }}>Yearly</span>
                  <span style={{ color: C.green, fontWeight: 600 }}>+{fmt$(yearlyUSD!)}</span>
                </div>
              </div>
            ) : (
              <div style={{ fontSize: 20, color: C.text, opacity: 0.5, fontStyle: "italic" }}>N/A</div>
            )}
          </div>
        </div>

        {/* ── CURRENT LIQUIDITY ────────────────────────────────────────── */}
        {hasAmounts && (
          <Section icon="[◎]" title="Current Liquidity" sub="Token balances actively deposited in the pool">
            <div style={{
              margin: "0 40px",
              display: "grid", gridTemplateColumns: "1fr 1fr",
              border: `1px solid ${C.border}`,
            }}>
              {[
                { sym: t0, amount: pos.amount0, price: pos.price0, label: "Token A" },
                { sym: t1, amount: pos.amount1, price: pos.price1, label: "Token B" },
              ].map(({ sym, amount, price, label }, i, arr) => {
                const total = (pos.amount0 ?? 0) * (pos.price0 ?? 0) + (pos.amount1 ?? 0) * (pos.price1 ?? 0);
                const myUsd = (amount ?? 0) * (price ?? 0);
                const pct = total > 0 ? ((myUsd / total) * 100).toFixed(1) : "—";
                return (
                  <div key={sym} style={{
                    padding: "22px 26px",
                    borderRight: i === arr.length - 1 ? "none" : `1px solid ${C.border}`,
                  }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                      <span style={{ fontSize: 14, color: C.cyan, fontWeight: 700, letterSpacing: "0.08em" }}>{sym}</span>
                      <span style={{
                        fontSize: 11, color: C.text, letterSpacing: "0.1em",
                        padding: "2px 8px", border: `1px solid ${C.borderHi}`, textTransform: "uppercase",
                      }}>
                        {label} · {pct}%
                      </span>
                    </div>
                    <div style={{ fontSize: 30, fontWeight: 700, color: C.textWhite, letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums" }}>
                      {amount != null ? amount.toLocaleString("en-US", { maximumFractionDigits: 6 }) : "—"}
                    </div>
                    {amount != null && price && (
                      <div style={{ fontSize: 14, color: C.text, marginTop: 4, opacity: 0.7 }}>
                        {fmt$(myUsd)} · @ {fmtPrice(price)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {/* Total row */}
            <div style={{
              margin: "0 40px",
              padding: "14px 26px", borderTop: `1px solid ${C.border}`,
              display: "flex", alignItems: "center", justifyContent: "space-between",
              background: C.bg1,
            }}>
              <span style={{ fontSize: 14, color: C.text, letterSpacing: "0.06em" }}>
                Combined Liquidity Position
              </span>
              <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                {(() => {
                  const total = (pos.amount0 ?? 0) * (pos.price0 ?? 0) + (pos.amount1 ?? 0) * (pos.price1 ?? 0);
                  if (total <= 0) return null;
                  const pct0 = ((pos.amount0 ?? 0) * (pos.price0 ?? 0) / total * 100).toFixed(1);
                  const pct1 = ((pos.amount1 ?? 0) * (pos.price1 ?? 0) / total * 100).toFixed(1);
                  return (
                    <span style={{ fontSize: 12, color: C.text, letterSpacing: "0.1em", textTransform: "uppercase", opacity: 0.6 }}>
                      {pct0} / {pct1} split
                    </span>
                  );
                })()}
                <span style={{
                  fontSize: 17, fontWeight: 700, color: C.green,
                  textShadow: "0 0 12px rgba(0,255,65,0.2)",
                  fontVariantNumeric: "tabular-nums",
                }}>
                  {fmt$(pos.value)}
                </span>
              </div>
            </div>
            <div style={{ height: 24 }} />
          </Section>
        )}

        {/* ── UNCOLLECTED FEES ─────────────────────────────────────────── */}
        {hasFees && (
          <Section
            icon="[$]"
            title="Uncollected Fees"
            sub="Trading fees earned but not yet claimed on-chain"
            right={pos.fees > 0 && manageUrl ? (
              <a href={manageUrl} target="_blank" rel="noopener noreferrer"
                className="btn-primary"
                style={{
                  fontFamily: FONT, fontSize: 14, fontWeight: 600,
                  letterSpacing: "0.1em", textTransform: "uppercase",
                  padding: "10px 18px", marginRight: 40, marginTop: 0,
                  border: `1px solid ${C.greenDim}`, background: C.greenFaint,
                  color: C.green, textDecoration: "none",
                  display: "inline-flex", alignItems: "center", gap: 8,
                  cursor: "pointer", transition: "all 0.15s",
                }}>
                ↗ Claim All
              </a>
            ) : null}
          >
            <div style={{
              margin: "0 40px",
              display: "grid", gridTemplateColumns: "1fr 1fr",
              border: `1px solid ${C.border}`,
            }}>
              {[
                { sym: t0, fee: pos.fees0, price: pos.price0 },
                { sym: t1, fee: pos.fees1, price: pos.price1 },
              ].map(({ sym, fee, price }, i, arr) => {
                const usd0 = (pos.fees0 ?? 0) * (pos.price0 ?? 0);
                const usd1 = (pos.fees1 ?? 0) * (pos.price1 ?? 0);
                const totalFee = usd0 + usd1;
                const myUsd = (fee ?? 0) * (price ?? 0);
                const pct = totalFee > 0 ? ((myUsd / totalFee) * 100).toFixed(1) : "—";
                return (
                  <div key={sym} style={{
                    padding: "22px 26px",
                    borderRight: i === arr.length - 1 ? "none" : `1px solid ${C.border}`,
                  }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                      <span style={{ fontSize: 14, color: C.cyan, fontWeight: 700, letterSpacing: "0.08em" }}>{sym}</span>
                      <span style={{
                        fontSize: 11, color: C.text, letterSpacing: "0.1em",
                        padding: "2px 8px", border: `1px solid ${C.borderHi}`, textTransform: "uppercase",
                      }}>
                        {pct}%
                      </span>
                    </div>
                    <div style={{ fontSize: 30, fontWeight: 700, color: C.textWhite, letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums" }}>
                      {fee != null ? fee.toLocaleString("en-US", { maximumFractionDigits: 6 }) : "—"}
                    </div>
                    {fee != null && price && (
                      <div style={{ fontSize: 14, color: C.text, marginTop: 4, opacity: 0.7 }}>
                        {fmt$(myUsd)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <div style={{
              margin: "0 40px",
              padding: "14px 26px", borderTop: `1px solid ${C.border}`,
              display: "flex", alignItems: "center", justifyContent: "space-between",
              background: C.bg1,
            }}>
              <span style={{ fontSize: 14, color: C.text, letterSpacing: "0.06em" }}>Total Uncollected</span>
              <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                <span style={{ fontSize: 12, color: C.text, letterSpacing: "0.1em", textTransform: "uppercase", opacity: 0.6 }}>
                  ready to collect
                </span>
                <span style={{
                  fontSize: 17, fontWeight: 700, color: C.green,
                  textShadow: "0 0 12px rgba(0,255,65,0.2)",
                  fontVariantNumeric: "tabular-nums",
                }}>
                  {fmt$(pos.fees)}
                </span>
              </div>
            </div>
            <div style={{ height: 24 }} />
          </Section>
        )}

        {/* ── PERFORMANCE METRICS ──────────────────────────────────────── */}
        <Section icon="[△]" title="Performance Metrics" sub="Calculated from real on-chain fee claims">
          <div style={{ padding: "0 40px" }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", border: `1px solid ${C.border}` }}>
              {[
                { label: "Total Claimed", val: activityLoading ? "…" : fmt$(claimedUSD), color: C.green, sub: activityLoading ? "loading…" : isActivityProtocol ? `${feeClaims.length} claim${feeClaims.length !== 1 ? "s" : ""} on-chain` : "no data" },
                { label: "Uncollected", val: fmt$(uncollectedUSD), color: C.green, sub: "pending" },
                { label: "Total Lifetime", val: fmt$(lifetimeUSD), color: C.textWhite, sub: "claimed + pending" },
                { label: "Actual APR", val: activityLoading ? "…" : actualAPR != null ? `~${actualAPR.toFixed(1)}%` : "—", color: C.green, sub: "from real claims" },
                { label: "Estimated APR", val: hasApr ? `~${pos.apy.toFixed(1)}%` : "N/A", color: C.cyan, sub: "pool APY" },
                { label: "Position Age", val: daysLabel, color: C.textWhite, sub: openedDate ? `since ${openedDate}` : "tracking age" },
              ].map((c, i) => (
                <div key={c.label} style={{
                  padding: cellPadding,
                  borderRight: (i + 1) % 3 === 0 ? "none" : `1px solid ${C.border}`,
                  borderBottom: i < 3 ? `1px solid ${C.border}` : "none",
                }}>
                  <div style={labelStyle}>{c.label}</div>
                  <div style={{
                    fontSize: 28, fontWeight: 700, letterSpacing: "-0.02em",
                    color: c.color,
                    textShadow: c.color === C.green ? "0 0 14px rgba(0,255,65,0.2)" : "none",
                    fontVariantNumeric: "tabular-nums",
                  }}>
                    {c.val}
                  </div>
                  <div style={subStyle}>{c.sub}</div>
                </div>
              ))}
            </div>
            {/* Bottom 2-cell row */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", border: `1px solid ${C.border}`, borderTop: "none" }}>
              <div style={{ padding: cellPadding, borderRight: `1px solid ${C.border}` }}>
                <div style={labelStyle}>Actual Daily Income</div>
                <div style={{
                  fontSize: 28, fontWeight: 700, letterSpacing: "-0.02em", color: C.green,
                  textShadow: "0 0 14px rgba(0,255,65,0.2)", fontVariantNumeric: "tabular-nums",
                }}>
                  {activityLoading ? "…" : actualDailyIncome != null
                    ? <>{fmt$(actualDailyIncome)}<span style={{ fontSize: 16, color: C.text, fontWeight: 400, marginLeft: 6, letterSpacing: 0 }}>/day</span></>
                    : "—"}
                </div>
                <div style={subStyle}>trailing 30d average</div>
              </div>
              <div style={{ padding: cellPadding }}>
                <div style={labelStyle}>Fee Income Rate</div>
                <div style={{
                  fontSize: 28, fontWeight: 700, letterSpacing: "-0.02em", color: C.textWhite,
                  fontVariantNumeric: "tabular-nums",
                }}>
                  {feeIncomePct.toFixed(3)}%
                </div>
                <div style={subStyle}>of position value (30d)</div>
              </div>
            </div>
            <div style={{ height: 24 }} />
          </div>
        </Section>

        {/* ── FEE ACCUMULATION CHART ───────────────────────────────────── */}
        {isActivityProtocol && (
          <Section icon="[⏱]" title="Fee Accumulation" sub="Cumulative fees collected over position lifetime">
            <div style={{ padding: "0 40px 28px" }}>
              <div style={{ border: `1px solid ${C.border}`, padding: "20px 24px", background: C.bg1, position: "relative", overflow: "hidden" }}>
                {/* Top scan sweep */}
                <div aria-hidden style={{
                  position: "absolute", top: 0, left: 0, width: 80, height: 1,
                  background: `linear-gradient(90deg, transparent, ${C.green}, transparent)`,
                  animation: "_scan 3s ease-in-out infinite",
                }} />
                {/* Chart meta */}
                <div style={{ display: "flex", alignItems: "center", marginBottom: 14, gap: 0 }}>
                  <div style={{ marginLeft: "auto", display: "flex", gap: 24 }}>
                    {(() => {
                      const peak = feeClaims.length > 0 ? Math.max(...feeClaims.map(e => e.usdAtTime ?? 0)) : 0;
                      const avgClaim = feeClaims.length > 0 ? claimedUSD / feeClaims.length : 0;
                      return [
                        { lbl: "Avg / Claim", val: fmt$(avgClaim), color: C.textBright },
                        { lbl: "Peak Claim", val: fmt$(peak), color: C.green },
                        { lbl: "Total", val: fmt$(lifetimeUSD), color: C.green },
                      ].map((m) => (
                        <div key={m.lbl} style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                          <span style={{ color: C.text, opacity: 0.5, letterSpacing: "0.12em", textTransform: "uppercase", fontSize: 11 }}>{m.lbl}</span>
                          <span style={{ fontWeight: 700, color: m.color, fontSize: 15, fontVariantNumeric: "tabular-nums" }}>{m.val}</span>
                        </div>
                      ));
                    })()}
                  </div>
                </div>
                {/* Chart */}
                {(activityLoading || activityPending) ? (
                  <div style={{ height: 200, display: "flex", alignItems: "center", justifyContent: "center", gap: 10, color: C.text, fontSize: 14, letterSpacing: "0.08em", textTransform: "uppercase" }}>
                    <div style={{ width: 14, height: 14, border: `2px solid ${C.green}`, borderTopColor: "transparent", animation: "_spin 1s linear infinite" }} />
                    Loading…
                  </div>
                ) : !feeChartData || feeChartData.noClaimsYet || feeChartData.chartData.length < 2 ? (
                  <div style={{ height: 200, display: "flex", alignItems: "center", justifyContent: "center", color: C.text, fontSize: 15 }}>
                    No fee claims yet
                  </div>
                ) : (
                  <div style={{ width: "100%", height: 200 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={feeChartData.chartData}>
                        <defs>
                          <linearGradient id="feeAccumGrad" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor={C.green} stopOpacity={0.28} />
                            <stop offset="60%" stopColor={C.green} stopOpacity={0.06} />
                            <stop offset="100%" stopColor={C.green} stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="4 8" stroke="rgba(255,255,255,0.025)" vertical={false} />
                        <XAxis dataKey="label" tick={{ fill: C.text, fontSize: 12, fontFamily: FONT }} axisLine={false} tickLine={false} />
                        <YAxis
                          tick={{ fill: C.text, fontSize: 12, fontFamily: FONT }}
                          tickFormatter={(v) => `$${Math.round(v).toLocaleString()}`}
                          axisLine={false} tickLine={false} width={50}
                        />
                        <Tooltip
                          contentStyle={{ background: C.bg1, border: `1px solid ${C.borderHi}`, padding: "8px 12px", color: C.textBright, fontSize: 14, fontFamily: FONT }}
                          itemStyle={{ color: C.textBright }}
                          labelStyle={{ color: C.text }}
                          formatter={(v: number | undefined) => [`$${(v ?? 0).toFixed(2)}`, "Cumulative Fees"]}
                        />
                        <Area type="monotone" dataKey="value" stroke={C.green} strokeWidth={1.6} fill="url(#feeAccumGrad)" dot={{ r: 3, fill: C.bg, stroke: C.green, strokeWidth: 1.5 }} activeDot={{ r: 5, fill: C.green }} />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                )}
                {feeChartData && !feeChartData.noClaimsYet && feeChartData.chartData.length >= 2 && (
                  <div style={{ textAlign: "center", fontSize: 12, color: C.text, opacity: 0.5, marginTop: 12, letterSpacing: "0.08em" }}>
                    ● markers indicate fee claim events · {feeChartData.chartData.length - 1} claims since {new Date(feeChartData.openTs).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
                  </div>
                )}
              </div>
            </div>
          </Section>
        )}

        {/* ── FEE CLAIMS HISTORY ───────────────────────────────────────── */}
        <Section icon="[⤓]" title="Fee Claims History" sub="On-chain claim transactions for this position">
          <div style={{ padding: "0 40px 24px" }}>
            {(activityLoading || activityPending) ? (
              <div style={{ display: "flex", alignItems: "center", gap: 10, color: C.text, fontSize: 15, padding: "12px 0" }}>
                <div style={{ width: 14, height: 14, border: `2px solid ${C.green}`, borderTopColor: "transparent", animation: "_spin 1s linear infinite", flexShrink: 0 }} />
                Scanning blockchain for fee history…
              </div>
            ) : !isActivityProtocol ? (
              <p style={{ fontSize: 15, color: C.text, opacity: 0.55 }}>
                Activity data not available for {pos.protocol} — on-chain fee history scanning is not yet supported.
              </p>
            ) : activityError ? (
              <p style={{ fontSize: 15, color: C.text, opacity: 0.55 }}>
                Could not load fee claim data. The blockchain scan may have timed out — try refreshing.
              </p>
            ) : feeClaims.length === 0 ? (
              <p style={{ fontSize: 15, color: C.text, opacity: 0.55 }}>
                No fee claims detected yet. Claims will appear here after you collect fees on-chain.
              </p>
            ) : (
              <div style={{ border: `1px solid ${C.border}` }}>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: FONT }}>
                    <thead>
                      <tr style={{ background: C.bg1 }}>
                        <th style={{
                          padding: "12px 20px", fontSize: 12, fontWeight: 400,
                          color: C.text, letterSpacing: "0.18em", textTransform: "uppercase",
                          borderBottom: `1px solid ${C.border}`, opacity: 0.6, textAlign: "left",
                        }}>Date (UTC)</th>
                        <th style={{
                          padding: "12px 20px", fontSize: 12, fontWeight: 400,
                          color: C.text, letterSpacing: "0.18em", textTransform: "uppercase",
                          borderBottom: `1px solid ${C.border}`, opacity: 0.6, textAlign: "right",
                        }}>{t0}</th>
                        <th style={{
                          padding: "12px 20px", fontSize: 12, fontWeight: 400,
                          color: C.text, letterSpacing: "0.18em", textTransform: "uppercase",
                          borderBottom: `1px solid ${C.border}`, opacity: 0.6, textAlign: "right",
                        }}>{t1}</th>
                        <th style={{
                          padding: "12px 20px", fontSize: 12, fontWeight: 400,
                          color: C.text, letterSpacing: "0.18em", textTransform: "uppercase",
                          borderBottom: `1px solid ${C.border}`, opacity: 0.6, textAlign: "right",
                        }}>Total USD</th>
                        <th style={{
                          padding: "12px 20px", fontSize: 12, fontWeight: 400,
                          color: C.text, letterSpacing: "0.18em", textTransform: "uppercase",
                          borderBottom: `1px solid ${C.border}`, opacity: 0.6, textAlign: "right",
                        }}>Tx</th>
                      </tr>
                    </thead>
                    <tbody>
                      {feeClaims.map((ev, i) => {
                        const usd = ev.usdAtTime ?? (ev.amount0 * (pos.price0 ?? 0) + ev.amount1 * (pos.price1 ?? 0));
                        return (
                          <tr key={i} className="pos-row" style={{ borderBottom: i === feeClaims.length - 1 ? "none" : `1px solid ${C.border}` }}>
                            <td style={{ padding: "11px 20px", fontSize: 15, color: C.textMid, whiteSpace: "nowrap" as const }}>{fmtDate(ev.timestamp)}</td>
                            <td style={{ padding: "11px 20px", fontSize: 15, color: C.textMid, fontVariantNumeric: "tabular-nums", textAlign: "right" }}>
                              {ev.type === 'reward_claim'
                                /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
                                ? `${fmtAmt(ev.amount0)} ${(ev as any).rewardSymbol ?? ''}`
                                : fmtAmt(ev.amount0)}
                            </td>
                            <td style={{ padding: "11px 20px", fontSize: 15, color: C.textMid, fontVariantNumeric: "tabular-nums", textAlign: "right" }}>
                              {ev.type === 'reward_claim' ? '—' : fmtAmt(ev.amount1)}
                            </td>
                            <td style={{ padding: "11px 20px", fontSize: 15, color: C.green, fontWeight: 600, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                              {fmt$(usd)}
                            </td>
                            <td style={{ padding: "11px 20px", textAlign: "right" }}>
                              <a className="tx-link" href={txUrl(ev.txHash)} target="_blank" rel="noopener noreferrer"
                                style={{ color: C.cyan, fontSize: 14, textDecoration: "none", transition: "opacity 0.15s" }}>
                                {shortHash(ev.txHash)} ↗
                              </a>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div style={{
                  padding: "12px 20px", borderTop: `1px solid ${C.border}`,
                  display: "flex", justifyContent: "space-between", alignItems: "center", background: C.bg1,
                }}>
                  <span style={{ fontSize: 14, color: C.text, letterSpacing: "0.04em" }}>{feeClaims.length} collection{feeClaims.length !== 1 ? "s" : ""}</span>
                  <span style={{ fontSize: 16, color: C.green, fontWeight: 700 }}>
                    <span style={{ color: C.text, fontWeight: 400, marginRight: 6, opacity: 0.6 }}>Total Claimed:</span>
                    {fmt$(claimedUSD)}
                  </span>
                </div>
              </div>
            )}
          </div>
        </Section>

        {/* ── CONCENTRATED LIQUIDITY RANGE ─────────────────────────────── */}
        {hasRange && (
          <Section
            icon="[◉]"
            title="Concentrated Liquidity Range"
            sub="Active price band — earning fees only when current price stays inside"
            right={
              <span style={{
                marginRight: 40,
                fontSize: 12, letterSpacing: "0.1em", textTransform: "uppercase",
                padding: "4px 12px", fontWeight: 600,
                display: "inline-flex", alignItems: "center", gap: 6,
                border: `1px solid ${isClosed ? C.borderHi : posStatus === "In Range" ? C.greenDim : C.amber}`,
                background: isClosed ? C.bg2 : posStatus === "In Range" ? C.greenFaint : "rgba(255,170,0,0.06)",
                color: isClosed ? C.text : posStatus === "In Range" ? C.green : C.amber,
              }}>
                {!isClosed && posStatus === "In Range" && (
                  <span style={{ width: 6, height: 6, background: C.green, animation: "_pulse 2s infinite" }} />
                )}
                {isClosed ? "Position Closed" : posStatus === "In Range" ? "Position Active" : "Out of Range"}
              </span>
            }
          >
            <div style={{ padding: "0 40px 24px" }}>
              <div style={{
                border: `1px solid ${C.border}`, padding: "24px 28px",
                background: C.bg1, position: "relative", overflow: "hidden",
              }}>
                <div aria-hidden style={{
                  position: "absolute", top: 0, left: 0, width: 80, height: 1,
                  background: `linear-gradient(90deg, transparent, ${C.green}, transparent)`,
                  animation: "_scan 3s ease-in-out infinite",
                }} />
                {/* Price labels */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", marginBottom: 14 }}>
                  <div>
                    <div style={{ fontSize: 12, color: C.text, letterSpacing: "0.16em", textTransform: "uppercase", opacity: 0.6, marginBottom: 6 }}>Min Price</div>
                    <div style={{ fontSize: 22, fontWeight: 700, color: C.textWhite, letterSpacing: "-0.01em" }}>
                      {minPriceUSD != null ? fmtPrice(minPriceUSD) : "—"}
                    </div>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                    <div style={{ fontSize: 12, color: C.text, letterSpacing: "0.16em", textTransform: "uppercase", opacity: 0.6, marginBottom: 6 }}>Current Price</div>
                    <div style={{
                      fontSize: 22, fontWeight: 700, letterSpacing: "-0.01em",
                      color: isClosed ? C.text : posStatus === "In Range" ? C.green : C.amber,
                      textShadow: !isClosed && posStatus === "In Range" ? "0 0 12px rgba(0,255,65,0.3)" : "none",
                    }}>
                      {curPriceUSD != null ? fmtPrice(curPriceUSD) : "—"}
                    </div>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
                    <div style={{ fontSize: 12, color: C.text, letterSpacing: "0.16em", textTransform: "uppercase", opacity: 0.6, marginBottom: 6 }}>Max Price</div>
                    <div style={{ fontSize: 22, fontWeight: 700, color: C.textWhite, letterSpacing: "-0.01em" }}>
                      {maxPriceUSD != null ? fmtPrice(maxPriceUSD) : "—"}
                    </div>
                  </div>
                </div>
                {/* Track */}
                <div style={{ position: "relative", height: 36, marginTop: 14 }}>
                  <div style={{
                    position: "absolute", left: 0, right: 0, top: 14, height: 8,
                    background: `repeating-linear-gradient(90deg, ${C.border} 0, ${C.border} 1px, transparent 1px, transparent 4px)`,
                    borderTop: `1px solid ${C.border}`, borderBottom: `1px solid ${C.border}`,
                  }} />
                  <div style={{
                    position: "absolute", top: 14, left: 0, height: 8,
                    width: `${rangeBarPct}%`,
                    background: `linear-gradient(90deg, ${C.greenDim}, ${C.green})`,
                    boxShadow: "0 0 8px rgba(0,255,65,0.4)",
                    transition: "width 1.2s cubic-bezier(0.22,1,0.36,1)",
                  }} />
                  {curPriceUSD != null && !isClosed && (
                    <div style={{
                      position: "absolute", top: 8, width: 2, height: 20,
                      left: `calc(${rangeBarPct}% - 1px)`,
                      background: C.green, boxShadow: "0 0 8px rgba(0,255,65,0.8)", zIndex: 3,
                    }} />
                  )}
                </div>
                {/* Ticks */}
                {minPriceUSD != null && maxPriceUSD != null && (
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.text, letterSpacing: "0.1em", opacity: 0.4, marginTop: 18 }}>
                    {[0, 0.25, 0.5, 0.75, 1].map((t, i) => (
                      <span key={i}>{fmtPrice(minPriceUSD + (maxPriceUSD - minPriceUSD) * t)}</span>
                    ))}
                  </div>
                )}
                {/* Stats row */}
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 18, paddingTop: 14, borderTop: `1px solid ${C.border}`, flexWrap: "wrap", gap: 16 }}>
                  <div>
                    <div style={{ fontSize: 11, color: C.text, letterSpacing: "0.16em", textTransform: "uppercase", opacity: 0.6, marginBottom: 3 }}>Range Width</div>
                    <div style={{ fontSize: 15, color: C.textBright, fontWeight: 600 }}>{rangeWidthPct ?? "—"}%</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: C.text, letterSpacing: "0.16em", textTransform: "uppercase", opacity: 0.6, marginBottom: 3 }}>Distance to Lower</div>
                    <div style={{ fontSize: 15, color: C.textBright, fontWeight: 600 }}>{distLower != null ? `${distLower}%` : "—"}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: C.text, letterSpacing: "0.16em", textTransform: "uppercase", opacity: 0.6, marginBottom: 3 }}>Distance to Upper</div>
                    <div style={{ fontSize: 15, color: C.textBright, fontWeight: 600 }}>{distUpper != null ? `+${distUpper}%` : "—"}</div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 11, color: C.text, letterSpacing: "0.16em", textTransform: "uppercase", opacity: 0.6, marginBottom: 3 }}>Position Age</div>
                    <div style={{ fontSize: 15, color: C.green, fontWeight: 600 }}>{daysLabel}</div>
                  </div>
                </div>
              </div>
            </div>
          </Section>
        )}

        {/* ── YIELD & APR PROJECTIONS ──────────────────────────────────── */}
        <Section icon="[%]" title="Yield & APR Projections" sub="Forward-looking estimates based on trailing pool fee rate">
          <div style={{ padding: "0 40px 24px" }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", border: `1px solid ${C.border}` }}>
              {([
                { label: "Daily",   div: 365,  amt: dailyUSD,   unit: "day" },
                { label: "Weekly",  div: 52,   amt: weeklyUSD,  unit: "week" },
                { label: "Monthly", div: 12,   amt: monthlyUSD, unit: "month" },
                { label: "Yearly",  div: 1,    amt: yearlyUSD,  unit: "year" },
              ] as const).map(({ label, div, amt, unit }, i, arr) => (
                <div key={label} style={{
                  padding: "22px 24px",
                  borderRight: i === arr.length - 1 ? "none" : `1px solid ${C.border}`,
                }}>
                  <div style={{ ...labelStyle, marginBottom: 10 }}>{label}</div>
                  {hasApr ? (
                    <>
                      <div style={{
                        fontSize: 30, fontWeight: 700, color: C.green,
                        textShadow: "0 0 14px rgba(0,255,65,0.2)", letterSpacing: "-0.02em",
                        fontVariantNumeric: "tabular-nums",
                      }}>
                        +{(pos.apy / div).toFixed(div >= 52 ? 3 : 2)}%
                      </div>
                      <div style={subStyle}>{amt != null ? fmt$(amt) : "—"} / {unit}</div>
                    </>
                  ) : (
                    <div style={{ fontSize: 20, color: C.text, opacity: 0.5, fontStyle: "italic" }}>N/A</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </Section>

        {/* ── ON-CHAIN P&L + IL ────────────────────────────────────────── */}
        {isActivityProtocol && (
          <Section icon="[Σ]" title="On-Chain P&L & Impermanent Loss" sub="Performance versus a simple hold-the-tokens strategy">
            <div style={{ padding: "0 40px 24px" }}>
              {(activityLoading || activityPending) ? (
                <p style={{ fontSize: 15, color: C.text, opacity: 0.55 }}>
                  Reconstructing position from on-chain history…
                </p>
              ) : !activity ? (
                <p style={{ fontSize: 15, color: C.text, opacity: 0.55 }}>
                  Entry data unavailable — P&amp;L cannot be computed.
                </p>
              ) : !pnl ? (
                <p style={{ fontSize: 15, color: C.text, opacity: 0.55 }}>
                  Entry data unavailable — no on-chain deposit event found for this position. P&amp;L cannot be computed.
                </p>
              ) : (
                <div style={{ border: `1px solid ${C.border}` }}>
                  {/* 5-stat grid */}
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", borderBottom: `1px solid ${C.border}` }}>
                    {[
                      { label: "Initial Value", val: fmt$(pnl.initialValue), color: C.textWhite, sub: "at deposit time" },
                      { label: pnl.isClosed ? "Closing Value" : "Current Value", val: fmt$(pnl.isClosed ? pnl.closingValue : pnl.currentValue), color: C.textWhite, sub: pnl.isClosed ? "at close time" : "live mark" },
                      { label: "Fees Collected", val: fmt$(pnl.feesCollected), color: C.green, sub: "claimed on-chain" },
                      { label: "Fees Unclaimed", val: fmt$(pnl.feesUnclaimed), color: C.green, sub: "ready to claim" },
                      {
                        label: "Impermanent Loss",
                        val: `${ilNegative ? "−" : "+"}${fmt$(Math.abs(pnl.ilUSD))}`,
                        color: ilNegative ? C.red : C.green,
                        sub: `${pnl.ilPct.toFixed(2)}%`,
                        subColor: ilNegative ? C.red : C.green,
                      },
                    ].map((c, i, arr) => (
                      <div key={c.label} style={{
                        padding: "20px 22px",
                        borderRight: i === arr.length - 1 ? "none" : `1px solid ${C.border}`,
                      }}>
                        <div style={labelStyle}>{c.label}</div>
                        <div style={{
                          fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em",
                          color: c.color,
                          textShadow: c.color === C.green ? "0 0 14px rgba(0,255,65,0.2)" : "none",
                          fontVariantNumeric: "tabular-nums",
                        }}>
                          {c.val}
                        </div>
                        <div style={{ ...subStyle, color: c.subColor ?? C.text, opacity: c.subColor ? 1 : 0.6 }}>{c.sub}</div>
                      </div>
                    ))}
                  </div>
                  {/* Summary panel */}
                  <div style={{
                    background: "linear-gradient(135deg, rgba(0,255,65,0.04), rgba(0,255,65,0.01))",
                    padding: "24px 28px",
                    display: "grid", gridTemplateColumns: "2fr 1fr 1fr",
                    gap: 32,
                    borderTop: `1px solid ${C.greenDim}`,
                    position: "relative",
                  }}>
                    <div aria-hidden style={{
                      position: "absolute", top: 0, left: 0, right: 0, height: 1,
                      background: `linear-gradient(90deg, transparent, ${C.green} 50%, transparent)`,
                      opacity: 0.6,
                    }} />
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      <div style={{ fontSize: 14, color: C.green, letterSpacing: "0.2em", textTransform: "uppercase", fontWeight: 600 }}>
                        Net P&amp;L
                      </div>
                      <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap" }}>
                        <div style={{
                          fontSize: 36, fontWeight: 700,
                          color: pnlPositive ? C.green : C.red,
                          letterSpacing: "-0.03em",
                          textShadow: pnlPositive ? "0 0 20px rgba(0,255,65,0.3)" : "0 0 20px rgba(255,51,85,0.3)",
                          fontVariantNumeric: "tabular-nums",
                        }}>
                          {pnlPositive ? "+" : "−"}{fmt$(Math.abs(pnl.netPnlUSD))}
                        </div>
                        <div style={{
                          fontSize: 17, fontWeight: 600,
                          color: pnlPositive ? C.green : C.red,
                          opacity: 0.8,
                        }}>
                          {pnlPositive ? "+" : ""}{pnl.netPnlPct.toFixed(2)}%
                        </div>
                      </div>
                      <div style={{ fontSize: 14, color: C.text, opacity: 0.7, letterSpacing: "0.02em", lineHeight: 1.6 }}>
                        {pnl.isClosed
                          ? `(${fmt$(pnl.closingValue)} closing + ${fmt$(pnl.feesCollected)} fees) − ${fmt$(pnl.initialValue)} initial`
                          : `(${fmt$(pnl.currentValue)} current + ${fmt$(pnl.feesCollected)} fees + ${fmt$(pnl.feesUnclaimed)} unclaimed) − ${fmt$(pnl.initialValue)} initial`}
                      </div>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end", paddingLeft: 32, borderLeft: `1px solid ${C.border}` }}>
                      <div style={{ fontSize: 12, color: C.text, letterSpacing: "0.18em", textTransform: "uppercase", opacity: 0.7 }}>HODL Value</div>
                      <div style={{ fontSize: 25, fontWeight: 700, color: C.textWhite, letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums" }}>
                        {fmt$(pnl.hodlValue)}
                      </div>
                      <div style={{ fontSize: 11, color: C.text, opacity: 0.6, letterSpacing: "0.08em", textTransform: "uppercase" }}>
                        if you just held
                      </div>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end", paddingLeft: 32, borderLeft: `1px solid ${C.border}` }}>
                      <div style={{ fontSize: 12, color: C.text, letterSpacing: "0.18em", textTransform: "uppercase", opacity: 0.7 }}>Fees vs IL</div>
                      <div style={{
                        fontSize: 25, fontWeight: 700, letterSpacing: "-0.02em",
                        color: pnl.feesOffsetIL ? C.cyan : C.red,
                      }}>
                        {pnl.feesOffsetIL ? "Offset ✓" : "Not offset ✗"}
                      </div>
                      <div style={{ fontSize: 11, color: C.text, opacity: 0.6, letterSpacing: "0.08em", textTransform: "uppercase" }}>
                        {fmt$(totalFees)} fees vs {fmt$(Math.abs(pnl.ilUSD))} IL
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </Section>
        )}

        {/* ── POOL STATISTICS ─────────────────────────────────────────── */}
        <Section icon="[⚡]" title="Pool Statistics" sub={`Aggregate metrics for ${pos.pair} on ${pos.protocol}`}>
          <div style={{ padding: "0 40px 32px" }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", border: `1px solid ${C.border}` }}>
              {([
                { label: "Pool TVL",   value: poolStats?.tvlUsd ?? null,    sub: "total value locked" },
                { label: "24H Volume", value: poolStats?.volumeUsd1d ?? null, sub: "trailing 24h" },
                { label: "24H Fees",   value: poolStats?.feesUsd1d ?? null,   sub: pos.feeTier != null ? `@ ${pos.feeTier}% fee tier` : "pool fees" },
              ] as const).map(({ label, value, sub }, i, arr) => (
                <div key={label} style={{
                  padding: "22px 24px",
                  borderRight: i === arr.length - 1 ? "none" : `1px solid ${C.border}`,
                }}>
                  <div style={labelStyle}>{label}</div>
                  {poolStatsLoading ? (
                    <div style={{ fontSize: 20, color: C.text, opacity: 0.4 }}>…</div>
                  ) : value != null ? (
                    <>
                      <div style={{ fontSize: 25, fontWeight: 700, color: C.textWhite, letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums" }}>
                        {fmtLarge(value)}
                      </div>
                      <div style={subStyle}>{sub}</div>
                    </>
                  ) : (
                    <div style={{ fontSize: 16, color: C.text, opacity: 0.5, fontStyle: "italic" }}>Data unavailable</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </Section>

        {/* ── PAGE FOOTER ─────────────────────────────────────────────── */}
        <div style={{
          padding: "24px 40px",
          display: "flex", justifyContent: "space-between", alignItems: "center",
          borderTop: `1px solid ${C.border}`, background: C.bg1, gap: 12, flexWrap: "wrap",
        }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ fontSize: 11, color: C.text, letterSpacing: "0.2em", textTransform: "uppercase", opacity: 0.5 }}>
              Position ID
            </div>
            <div style={{ fontSize: 14, color: C.textMid, fontFamily: FONT, letterSpacing: "0.02em", wordBreak: "break-all" }}>
              {pos.id}
            </div>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <Link href="/dashboard"
              className="btn-neutral"
              style={{
                fontFamily: FONT, fontSize: 14, fontWeight: 600,
                letterSpacing: "0.1em", textTransform: "uppercase",
                padding: "10px 18px",
                border: `1px solid ${C.borderHi}`, background: "transparent",
                color: C.textMid, textDecoration: "none",
                display: "flex", alignItems: "center", gap: 8,
                cursor: "pointer", transition: "all 0.15s",
              }}>
              ← Dashboard
            </Link>
            {manageUrl && (
              <a href={manageUrl} target="_blank" rel="noopener noreferrer"
                className="btn-primary"
                style={{
                  fontFamily: FONT, fontSize: 14, fontWeight: 600,
                  letterSpacing: "0.1em", textTransform: "uppercase",
                  padding: "10px 18px",
                  border: `1px solid ${C.greenDim}`, background: C.greenFaint,
                  color: C.green, textDecoration: "none",
                  display: "flex", alignItems: "center", gap: 8,
                  cursor: "pointer", transition: "all 0.15s",
                }}>
                ↗ Manage Position
              </a>
            )}
          </div>
        </div>

      </main>
    </div>
  );
}
