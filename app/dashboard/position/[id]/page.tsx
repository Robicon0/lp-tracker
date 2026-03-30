"use client";

import { useParams } from "next/navigation";
import { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import Navbar from "../../../Navbar";
import { usePositions } from "../../../contexts/PositionsContext";
import type { AerodromePosition } from "../../../lib/aerodrome";
import { getTokenLogo, TOKEN_COLORS } from "../../../lib/tokenLogos";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import { usePositionActivity } from "../../../hooks/usePositionActivity";
import { useBluefinActivity } from "../../../hooks/useBluefinActivity";
import { useOrcaActivity } from "../../../hooks/useOrcaActivity";
import { useRaydiumActivity } from "../../../hooks/useRaydiumActivity";
import { useHyperSwapActivity } from "../../../hooks/useHyperSwapActivity";
import { useUniswapActivity } from "../../../hooks/useUniswapActivity";
import { useVelodromeActivity } from "../../../hooks/useVelodromeActivity";

// ── Token logo circle ─────────────────────────────────────────────────────────
function TokenCircle({ symbol, size = 32, style }: {
  symbol: string; size?: number; style?: React.CSSProperties;
}) {
  const [imgErr, setImgErr] = useState(false);
  const logoUrl = getTokenLogo(symbol);
  const color = TOKEN_COLORS[symbol] ?? TOKEN_COLORS[symbol.toUpperCase()] ?? "#6B7280";
  const base: React.CSSProperties = {
    width: size, height: size, borderRadius: "50%",
    border: "2px solid #060d08", flexShrink: 0, ...style,
  };
  if (logoUrl && !imgErr) {
    return <img src={logoUrl} alt={symbol} onError={() => setImgErr(true)}
      style={{ ...base, objectFit: "cover", display: "block" }} />;
  }
  return (
    <div style={{ ...base, background: color,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: size * 0.35, fontWeight: 700, color: "white" }}>
      {symbol.charAt(0).toUpperCase()}
    </div>
  );
}

// ── Fee-snapshot localStorage helpers ────────────────────────────────────────
const FEE_LS_KEY = "defidesh-fee-history";
const MIN_SNAPSHOT_MS = 5 * 60 * 1000; // save at most once per 5 min

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

// ── Sub-components ────────────────────────────────────────────────────────────
function Card({ children, style = {} }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      background: "rgba(255,255,255,0.03)",
      border: "1px solid rgba(255,255,255,0.06)",
      borderRadius: 14,
      padding: 20,
      ...style,
    }}>
      {children}
    </div>
  );
}

function SectionHeader({ icon, label }: { icon: string; label: string }) {
  return (
    <p style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 1,
      color: "#6ee7b7", margin: "0 0 16px", display: "flex", alignItems: "center", gap: 6 }}>
      <span>{icon}</span> {label}
    </p>
  );
}

function StatCard({
  label, value, sub, valueColor = "white",
}: {
  label: string; value: string; sub?: string; valueColor?: string;
}) {
  return (
    <Card>
      <p style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 1,
        color: "rgba(255,255,255,0.4)", margin: "0 0 8px" }}>{label}</p>
      <p style={{ fontSize: 28, fontWeight: 700, color: valueColor, margin: 0,
        letterSpacing: -0.5 }}>{value}</p>
      {sub && (
        <p style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", margin: "4px 0 0" }}>{sub}</p>
      )}
    </Card>
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
  const d0  = pos?.token0Decimals ?? 18;
  const d1  = pos?.token1Decimals ?? 6;

  // Price range
  const hasRange   = pos != null && pos.tickLower != null && pos.tickUpper != null;
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

  // APR / cashflow
  const hasApr     = (pos?.apy ?? 0) > 0 && (pos?.value ?? 0) > 0;
  const dailyUSD   = hasApr ? pos!.value * pos!.apy / 100 / 365 : null;
  const weeklyUSD  = hasApr ? pos!.value * pos!.apy / 100 / 52  : null;
  const monthlyUSD = hasApr ? pos!.value * pos!.apy / 100 / 12  : null;
  const yearlyUSD  = hasApr ? pos!.value * pos!.apy / 100       : null;

  // Amounts
  const hasAmounts = pos != null && (pos.amount0 != null || pos.amount1 != null);
  const hasFees    = pos != null && (pos.fees0 != null || pos.fees1 != null);

  // ── Fee tracking ────────────────────────────────────────────────────────────
  const [snapshots, setSnapshots] = useState<FeeSnapshot[]>([]);

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

  // Load history on mount; append new snapshot whenever fees change
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

  const feeMetrics = useMemo(() => {
    if (!pos || snapshots.length === 0) return null;

    // Estimated claimed = sum of fee drops between consecutive snapshots
    let estimatedClaimed = 0;
    for (let i = 1; i < snapshots.length; i++) {
      const drop = snapshots[i - 1].feesUSD - snapshots[i].feesUSD;
      if (drop > 0.005) estimatedClaimed += drop;
    }

    const totalEarned  = estimatedClaimed + pos.fees;
    const feeVsHoldPct = pos.value > 0 ? (totalEarned / pos.value) * 100 : 0;
    const firstSnap    = snapshots[0];
    const ageDays      = (Date.now() - firstSnap.timestamp) / 86_400_000;

    // Build cumulative chart data
    let claimed = 0;
    const chartData = snapshots.map((s, i) => {
      if (i > 0) {
        const drop = snapshots[i - 1].feesUSD - s.feesUSD;
        if (drop > 0.005) claimed += drop;
      }
      return {
        label: new Date(s.timestamp).toLocaleDateString("en-US", {
          month: "short", day: "numeric",
          hour: snapshots.length <= 48 ? "numeric" : undefined,
        }),
        value: claimed + s.feesUSD,
      };
    });

    return { estimatedClaimed, totalEarned, feeVsHoldPct, ageDays, firstSnap, chartData };
  }, [snapshots, pos]);

  // ── Activity data (on-chain fee claim history) ───────────────────────────
  const HYPEREVM_PROTOCOLS = new Set(['HyperSwap', 'KittenSwap', 'ProjectX']);
  const isHyperEVM = pos ? HYPEREVM_PROTOCOLS.has(pos.protocol) : false;

  const aeroTokenId = pos?.protocol === 'Aerodrome' ? pos.id.replace('aero-', '') : null;
  const { data: aeroActivity, isLoading: aeroActivityLoading } = usePositionActivity(
    aeroTokenId, pos?.token0Decimals ?? 18, pos?.token1Decimals ?? 18,
    pos?.token0Address, pos?.token1Address, pos?.price0, pos?.price1,
  );

  const bluefinObjId = pos?.protocol === 'Bluefin' ? pos.id.replace('bluefin-', '') : null;
  const { data: bluefinActivity, isLoading: bluefinActivityLoading } = useBluefinActivity(
    bluefinObjId, pos?.token0Decimals ?? 9, pos?.token1Decimals ?? 6,
    pos?.coinTypeA, pos?.coinTypeB, pos?.price0, pos?.price1, pos?.walletAddress,
  );

  const orcaPosId = pos?.protocol === 'Orca' ? pos.id.replace('orca-', '') : null;
  const { data: orcaActivity, isLoading: orcaActivityLoading } = useOrcaActivity(
    orcaPosId, pos?.token0Decimals ?? 9, pos?.token1Decimals ?? 6,
    pos?.token0Address, pos?.token1Address, pos?.price0, pos?.price1, pos?.walletAddress,
  );

  const raydiumPosId = pos?.protocol === 'Raydium' ? pos.id.replace('ray-', '') : null;
  const { data: raydiumActivity, isLoading: raydiumActivityLoading } = useRaydiumActivity(
    raydiumPosId, pos?.token0Decimals ?? 9, pos?.token1Decimals ?? 6,
    pos?.token0Address, pos?.token1Address, pos?.price0, pos?.price1, pos?.walletAddress,
  );

  const hyperswapTokenId = pos && HYPEREVM_PROTOCOLS.has(pos.protocol)
    ? pos.id.replace(/^hyperswap-[^-]+-/, '')
    : null;
  const { data: hyperswapActivity, isLoading: hyperswapActivityLoading } = useHyperSwapActivity(
    hyperswapTokenId, pos && HYPEREVM_PROTOCOLS.has(pos.protocol) ? pos.protocol : null,
    pos?.token0Decimals ?? 18, pos?.token1Decimals ?? 6,
    pos?.token0Address, pos?.token1Address, pos?.price0, pos?.price1,
  );

  const uniswapPosId = pos?.protocol === 'Uniswap V3' ? pos.id : null;
  const { data: uniswapActivity, isLoading: uniswapActivityLoading } = useUniswapActivity(
    uniswapPosId, pos?.token0Decimals ?? 18, pos?.token1Decimals ?? 18,
    pos?.token0Address, pos?.token1Address, pos?.price0, pos?.price1,
  );

  const velodromePosId = pos?.protocol === 'Velodrome' ? pos.id.replace('velo-', '') : null;
  const { data: velodromeActivity, isLoading: velodromeActivityLoading } = useVelodromeActivity(
    velodromePosId, pos?.token0Decimals ?? 18, pos?.token1Decimals ?? 18,
    pos?.token0Address, pos?.token1Address, pos?.price0, pos?.price1,
  );

  const activity = pos?.protocol === 'Aerodrome' ? aeroActivity
    : pos?.protocol === 'Bluefin' ? bluefinActivity
    : pos?.protocol === 'Orca' ? orcaActivity
    : pos?.protocol === 'Raydium' ? raydiumActivity
    : isHyperEVM ? hyperswapActivity
    : pos?.protocol === 'Uniswap V3' ? uniswapActivity
    : pos?.protocol === 'Velodrome' ? velodromeActivity
    : null;
  const activityLoading = pos?.protocol === 'Aerodrome' ? aeroActivityLoading
    : pos?.protocol === 'Bluefin' ? bluefinActivityLoading
    : pos?.protocol === 'Orca' ? orcaActivityLoading
    : pos?.protocol === 'Raydium' ? raydiumActivityLoading
    : isHyperEVM ? hyperswapActivityLoading
    : pos?.protocol === 'Uniswap V3' ? uniswapActivityLoading
    : pos?.protocol === 'Velodrome' ? velodromeActivityLoading
    : false;
  const isActivityProtocol = ['Aerodrome', 'Bluefin', 'Orca', 'Raydium', 'Uniswap V3', 'Velodrome'].includes(pos?.protocol ?? '') || isHyperEVM;

  // ── Render ──────────────────────────────────────────────────────────────────

  // Loading
  if (isLoading && !pos) {
    return (
      <div style={{ background: "#060d08", minHeight: "100vh", color: "white" }}>
        <Navbar />
        <div style={{ maxWidth: 1200, margin: "0 auto", padding: "96px 28px 28px", textAlign: "center" }}>
          <div style={{ width: 32, height: 32, border: "2px solid #10b981",
            borderTopColor: "transparent", borderRadius: "50%", margin: "0 auto 16px",
            animation: "spin 1s linear infinite" }} />
          <style>{`@keyframes spin { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }`}</style>
          <p style={{ color: "rgba(255,255,255,0.4)" }}>Loading position…</p>
        </div>
      </div>
    );
  }

  // Not found
  if (!pos) {
    return (
      <div style={{ background: "#060d08", minHeight: "100vh", color: "white" }}>
        <Navbar />
        <div style={{ maxWidth: 1200, margin: "0 auto", padding: "96px 28px 28px", textAlign: "center" }}>
          <div style={{ fontSize: 48, marginBottom: 24 }}>🔍</div>
          <h2 style={{ fontSize: 24, fontWeight: 700, marginBottom: 12 }}>Position not found</h2>
          <p style={{ color: "rgba(255,255,255,0.4)", marginBottom: 32 }}>
            This position could not be located. It may have been closed or the data hasn&apos;t loaded yet.
          </p>
          <Link href="/dashboard" style={{ background: "rgba(16,185,129,0.2)", border: "1px solid rgba(16,185,129,0.3)",
            color: "#6ee7b7", borderRadius: 10, padding: "10px 20px", textDecoration: "none", fontSize: 14 }}>
            ← Back to Dashboard
          </Link>
        </div>
      </div>
    );
  }

  const void_d0_d1 = [d0, d1]; void void_d0_d1; // suppress unused vars (used in build helpers)

  return (
    <div style={{ background: "#060d08", minHeight: "100vh", color: "white" }}>
      <style>{`
        @keyframes _spin { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
        @media (max-width:640px) {
          .detail-4col  { grid-template-columns: 1fr 1fr !important; }
          .detail-2col  { grid-template-columns: 1fr !important; }
          .detail-3col  { grid-template-columns: 1fr 1fr !important; }
        }
      `}</style>
      <Navbar />

      {/* Small gradient accent at top */}
      <div style={{
        background: "linear-gradient(135deg, #041a0a 0%, #071f12 40%, #060d08 100%)",
        padding: "80px 28px 24px",
        position: "relative",
        overflow: "hidden",
      }}>
        <div style={{ position:"absolute", top:0, right:0, width:300, height:200,
          background:"radial-gradient(circle, rgba(16,185,129,0.1) 0%, transparent 70%)",
          pointerEvents:"none" }} />

        <div style={{ maxWidth: 1200, margin: "0 auto", position: "relative" }}>
          {/* Back button */}
          <Link href="/dashboard" style={{ display: "inline-flex", alignItems: "center", gap: 6,
            fontSize: 13, color: "rgba(255,255,255,0.4)", textDecoration: "none", marginBottom: 20,
            transition: "color 0.15s" }}>
            ← Back to Dashboard
          </Link>

          {/* Header */}
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between",
            flexWrap: "wrap", gap: 16 }}>
            <div>
              {/* Token pair logos + pair name */}
              <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 12 }}>
                {/* Overlapping token circles */}
                <div style={{ position: "relative", width: 60, height: 36, flexShrink: 0 }}>
                  <TokenCircle symbol={t1} size={36}
                    style={{ position: "absolute", right: 0, top: 0, zIndex: 1 }} />
                  <TokenCircle symbol={t0} size={36}
                    style={{ position: "absolute", left: 0, top: 0, zIndex: 2 }} />
                </div>
                <h1 style={{ fontSize: 28, fontWeight: 700, color: "white", margin: 0 }}>
                  {t0} / {t1}
                </h1>
              </div>

              {/* Badges row */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
                <span style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)",
                  color: "rgba(255,255,255,0.7)", fontSize: 12, padding: "3px 10px", borderRadius: 20 }}>
                  {pos.protocol}
                </span>
                {pos.feeTier != null && (
                  <span style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)",
                    color: "rgba(255,255,255,0.7)", fontSize: 12, padding: "3px 10px", borderRadius: 20 }}>
                    {pos.feeTier}% fee
                  </span>
                )}
                <span style={{
                  background: isClosed ? "rgba(255,255,255,0.03)"
                    : posStatus === "In Range" ? "rgba(52,211,153,0.1)"
                    : "rgba(245,158,11,0.1)",
                  border: `1px solid ${isClosed ? "rgba(255,255,255,0.06)"
                    : posStatus === "In Range" ? "rgba(52,211,153,0.2)"
                    : "rgba(245,158,11,0.2)"}`,
                  color: isClosed ? "rgba(255,255,255,0.3)"
                    : posStatus === "In Range" ? "#34d399"
                    : "#f59e0b",
                  fontSize: 12, padding: "3px 10px", borderRadius: 20,
                }}>
                  {posStatus === "In Range" ? "● In Range" : posStatus}
                </span>
              </div>

              {/* Meta info */}
              <p style={{ fontSize: 12, color: "rgba(255,255,255,0.3)", margin: 0 }}>
                {pos.chain}
                {pos.walletAddress && (
                  <span style={{ marginLeft: 8 }}>
                    · wallet …{pos.walletAddress.slice(-6)}
                  </span>
                )}
                {/^\d+$/.test(pos.id) && (
                  <span style={{ marginLeft: 8 }}>· NFT #{pos.id}</span>
                )}
              </p>
            </div>

            {/* Manage Position button */}
            {manageUrl && (
              <a href={manageUrl} target="_blank" rel="noopener noreferrer"
                style={{ background: "rgba(16,185,129,0.2)", border: "1px solid rgba(16,185,129,0.3)",
                  color: "#6ee7b7", borderRadius: 10, padding: "10px 18px", textDecoration: "none",
                  fontSize: 13, fontWeight: 500, whiteSpace: "nowrap", alignSelf: "flex-start" }}>
                Manage Position ↗
              </a>
            )}
          </div>
        </div>
      </div>

      {/* ── Content ─────────────────────────────────────────────────────────── */}
      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "28px 28px 60px" }}>

        {/* ── 2B: Value Summary Row ──────────────────────────────────────────── */}
        <div className="detail-4col" style={{
          display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 16, marginBottom: 28,
        }}>
          <StatCard label="Total Value" value={fmt$(pos.value)} />
          <StatCard
            label="Uncollected Fees"
            value={pos.fees > 0 ? fmt$(pos.fees) : "$0.00"}
            sub={pos.fees > 0 ? "Ready to collect" : "No fees pending"}
            valueColor="#34d399"
          />
          <StatCard
            label="Estimated APR"
            value={hasApr ? `+${pos.apy.toFixed(2)}%` : "N/A"}
            sub={hasApr ? "Based on pool APY" : undefined}
            valueColor="#6ee7b7"
          />
          {/* Cashflow card */}
          <Card>
            <p style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 1,
              color: "rgba(255,255,255,0.4)", margin: "0 0 8px" }}>Est. Cashflow</p>
            {hasApr ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 12, color: "rgba(255,255,255,0.4)" }}>Daily</span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: "#34d399" }}>+{fmt$(dailyUSD!)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 12, color: "rgba(255,255,255,0.4)" }}>Monthly</span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: "#34d399" }}>+{fmt$(monthlyUSD!)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 12, color: "rgba(255,255,255,0.4)" }}>Yearly</span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: "#34d399" }}>+{fmt$(yearlyUSD!)}</span>
                </div>
              </div>
            ) : (
              <p style={{ fontSize: 28, fontWeight: 700, color: "#6ee7b7", margin: 0 }}>N/A</p>
            )}
          </Card>
        </div>

        {/* ── 2C: Current Liquidity ─────────────────────────────────────────── */}
        {hasAmounts && (
          <Card style={{ marginBottom: 20 }}>
            <SectionHeader icon="◎" label="Current Liquidity" />
            <div className="detail-2col" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              {[
                { sym: t0, amount: pos.amount0, price: pos.price0 },
                { sym: t1, amount: pos.amount1, price: pos.price1 },
              ].map(({ sym, amount, price }) => (
                <div key={sym} style={{ background: "rgba(255,255,255,0.03)",
                  border: "1px solid rgba(255,255,255,0.06)", borderRadius: 10, padding: 16 }}>
                  <p style={{ fontSize: 12, fontWeight: 600, color: "#6ee7b7", margin: "0 0 8px" }}>{sym}</p>
                  <p style={{ fontSize: 22, fontWeight: 700, color: "white", margin: "0 0 4px" }}>
                    {amount != null
                      ? amount.toLocaleString("en-US", { maximumFractionDigits: 6 })
                      : "—"}
                  </p>
                  {amount != null && price && (
                    <p style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", margin: 0 }}>
                      {fmt$(amount * price)}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </Card>
        )}

        {/* ── 2D: Uncollected Fees ──────────────────────────────────────────── */}
        {hasFees && (
          <Card style={{ marginBottom: 20 }}>
            <SectionHeader icon="$" label="Uncollected Fees" />
            <div className="detail-2col" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
              {[
                { sym: t0, fee: pos.fees0, price: pos.price0 },
                { sym: t1, fee: pos.fees1, price: pos.price1 },
              ].map(({ sym, fee, price }) => (
                <div key={sym} style={{ background: "rgba(255,255,255,0.03)",
                  border: "1px solid rgba(255,255,255,0.06)", borderRadius: 10, padding: 16 }}>
                  <p style={{ fontSize: 12, fontWeight: 600, color: "#6ee7b7", margin: "0 0 8px" }}>{sym}</p>
                  <p style={{ fontSize: 22, fontWeight: 700, color: "white", margin: "0 0 4px" }}>
                    {fee != null
                      ? fee.toLocaleString("en-US", { maximumFractionDigits: 6 })
                      : "—"}
                  </p>
                  {fee != null && price && (
                    <p style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", margin: 0 }}>
                      {fmt$(fee * price)}
                    </p>
                  )}
                </div>
              ))}
            </div>
            {pos.fees > 0 && (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
                borderTop: "1px solid rgba(255,255,255,0.05)", paddingTop: 12 }}>
                <span style={{ fontSize: 13, color: "rgba(255,255,255,0.5)" }}>Total Uncollected</span>
                <div style={{ textAlign: "right" }}>
                  <span style={{ fontSize: 18, fontWeight: 700, color: "#34d399" }}>{fmt$(pos.fees)}</span>
                  <span style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", marginLeft: 8 }}>
                    Ready to collect
                  </span>
                </div>
              </div>
            )}
          </Card>
        )}

        {/* ── 2D.5: Performance Metrics ─────────────────────────────────────── */}
        <Card style={{ marginBottom: 20, border: "1px solid rgba(251,191,36,0.15)" }}>
          <SectionHeader icon="📊" label="Performance Metrics" />
          <p style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", margin: "-10px 0 16px", letterSpacing: 0.3 }}>
            Based on actual fee claims
          </p>
          {(() => {
            const feeClaims = activity?.events.filter(e => e.type === 'fee_claim' || e.type === 'reward_claim') ?? [];
            const deposits = activity?.events.filter(e => e.type === 'deposit') ?? [];
            const claimedUSD = feeClaims.reduce((sum, e) => {
              if (e.usdAtTime != null) return sum + e.usdAtTime;
              return sum + e.amount0 * (pos.price0 ?? 0) + e.amount1 * (pos.price1 ?? 0);
            }, 0);
            const uncollectedUSD = pos.fees;
            const lifetimeUSD = claimedUSD + uncollectedUSD;
            const firstDeposit = deposits.length > 0 ? deposits[deposits.length - 1] : null;
            const firstTs = firstDeposit?.timestamp ?? (feeMetrics?.firstSnap.timestamp ? feeMetrics.firstSnap.timestamp / 1000 : 0);
            const nowTs = Math.floor(Date.now() / 1000);
            const daysActive = firstTs > 0 ? (nowTs - firstTs) / 86400 : 0;
            const actualAPR = daysActive >= 1 && pos.value > 0 && claimedUSD > 0
              ? (claimedUSD / pos.value) / (daysActive / 365) * 100
              : null;
            const actualDailyIncome = daysActive >= 1 && claimedUSD > 0 ? claimedUSD / daysActive : null;
            const feeIncomePct = pos.value > 0 ? (lifetimeUSD / pos.value) * 100 : 0;
            const daysLabel = daysActive >= 1 ? `${Math.floor(daysActive)}d` : (firstTs > 0 ? '<1d' : '—');
            const cellStyle: React.CSSProperties = {
              background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)",
              borderRadius: 10, padding: 14, textAlign: "center",
            };
            return (
              <div>
                {/* Row 1: Claimed | Uncollected | Lifetime */}
                <div className="detail-3col" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 10 }}>
                  <div style={{ ...cellStyle, border: "1px solid rgba(52,211,153,0.15)" }}>
                    <p style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", margin: "0 0 6px", textTransform: "uppercase", letterSpacing: 1 }}>Total Claimed</p>
                    {activityLoading
                      ? <p style={{ fontSize: 20, fontWeight: 700, color: "rgba(255,255,255,0.2)", margin: "0 0 4px" }}>…</p>
                      : <p style={{ fontSize: 20, fontWeight: 700, color: "#34d399", margin: "0 0 4px" }}>{fmt$(claimedUSD)}</p>
                    }
                    <p style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", margin: 0 }}>
                      {activityLoading ? "loading…" : isActivityProtocol ? `${feeClaims.length} claim${feeClaims.length !== 1 ? "s" : ""}` : "no data"}
                    </p>
                  </div>
                  <div style={cellStyle}>
                    <p style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", margin: "0 0 6px", textTransform: "uppercase", letterSpacing: 1 }}>Uncollected</p>
                    <p style={{ fontSize: 20, fontWeight: 700, color: "#6ee7b7", margin: "0 0 4px" }}>{fmt$(uncollectedUSD)}</p>
                    <p style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", margin: 0 }}>pending</p>
                  </div>
                  <div style={cellStyle}>
                    <p style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", margin: "0 0 6px", textTransform: "uppercase", letterSpacing: 1 }}>Total Lifetime</p>
                    <p style={{ fontSize: 20, fontWeight: 700, color: "white", margin: "0 0 4px" }}>{fmt$(lifetimeUSD)}</p>
                    <p style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", margin: 0 }}>claimed + pending</p>
                  </div>
                </div>
                {/* Row 2: Actual APR | Estimated APR | Position Age */}
                <div className="detail-3col" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 10 }}>
                  <div style={{ ...cellStyle, border: "1px solid rgba(52,211,153,0.12)" }}>
                    <p style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", margin: "0 0 6px", textTransform: "uppercase", letterSpacing: 1 }}>Actual APR</p>
                    {activityLoading
                      ? <p style={{ fontSize: 20, fontWeight: 700, color: "rgba(255,255,255,0.2)", margin: "0 0 4px" }}>…</p>
                      : actualAPR != null
                        ? <p style={{ fontSize: 20, fontWeight: 700, color: "#34d399", margin: "0 0 4px" }}>~{actualAPR.toFixed(1)}%</p>
                        : <p style={{ fontSize: 20, fontWeight: 700, color: "rgba(255,255,255,0.2)", margin: "0 0 4px" }}>—</p>
                    }
                    <p style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", margin: 0 }}>from real claims</p>
                  </div>
                  <div style={{ ...cellStyle, border: "1px solid rgba(96,165,250,0.12)" }}>
                    <p style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", margin: "0 0 6px", textTransform: "uppercase", letterSpacing: 1 }}>Estimated APR</p>
                    {hasApr
                      ? <p style={{ fontSize: 20, fontWeight: 700, color: "#93c5fd", margin: "0 0 4px" }}>~{pos.apy.toFixed(1)}%</p>
                      : <p style={{ fontSize: 20, fontWeight: 700, color: "rgba(255,255,255,0.2)", margin: "0 0 4px" }}>N/A</p>
                    }
                    <p style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", margin: 0 }}>pool APY</p>
                  </div>
                  <div style={cellStyle}>
                    <p style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", margin: "0 0 6px", textTransform: "uppercase", letterSpacing: 1 }}>Position Age</p>
                    <p style={{ fontSize: 20, fontWeight: 700, color: "white", margin: "0 0 4px" }}>{daysLabel}</p>
                    <p style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", margin: 0 }}>
                      {firstTs > 0 ? `since ${new Date(firstTs * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : "tracking age"}
                    </p>
                  </div>
                </div>
                {/* Row 3: Daily Income | Fee Income % */}
                <div className="detail-2col" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  <div style={cellStyle}>
                    <p style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", margin: "0 0 6px", textTransform: "uppercase", letterSpacing: 1 }}>Actual Daily Income</p>
                    {activityLoading
                      ? <p style={{ fontSize: 18, fontWeight: 700, color: "rgba(255,255,255,0.2)", margin: 0 }}>…</p>
                      : actualDailyIncome != null
                        ? <p style={{ fontSize: 18, fontWeight: 700, color: "white", margin: 0 }}>{fmt$(actualDailyIncome)}<span style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", fontWeight: 400 }}>/day</span></p>
                        : <p style={{ fontSize: 18, fontWeight: 700, color: "rgba(255,255,255,0.2)", margin: 0 }}>—</p>
                    }
                  </div>
                  <div style={cellStyle}>
                    <p style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", margin: "0 0 6px", textTransform: "uppercase", letterSpacing: 1 }}>Fee Income</p>
                    <p style={{ fontSize: 18, fontWeight: 700, color: "white", margin: 0 }}>{feeIncomePct.toFixed(3)}%</p>
                    <p style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", margin: "4px 0 0" }}>of position value</p>
                  </div>
                </div>
              </div>
            );
          })()}
        </Card>

        {/* ── 2D.6: Fee Accumulation Chart ──────────────────────────────────── */}
        {feeMetrics && feeMetrics.chartData.length >= 2 && (
          <Card style={{ marginBottom: 20 }}>
            <SectionHeader icon="📈" label="Fee Accumulation" />
            <div style={{ height: 160 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={feeMetrics.chartData}
                  margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                  <XAxis dataKey="label" tick={{ fontSize: 10, fill: "rgba(255,255,255,0.3)" }}
                    tickLine={false} axisLine={false}
                    interval={Math.max(0, Math.floor(feeMetrics.chartData.length / 5) - 1)} />
                  <YAxis tick={{ fontSize: 10, fill: "rgba(255,255,255,0.3)" }}
                    tickLine={false} axisLine={false}
                    tickFormatter={(v: number) => `$${v.toFixed(2)}`} width={52} />
                  <Tooltip
                    contentStyle={{ backgroundColor: "#0a1410",
                      border: "1px solid rgba(255,255,255,0.06)",
                      borderRadius: 8, color: "#fff", fontSize: 12 }}
                    formatter={(v: number | undefined) => [`$${(v ?? 0).toFixed(4)}`, "Cumulative Fees"]}
                  />
                  <Line type="monotone" dataKey="value" stroke="#34d399" strokeWidth={2}
                    dot={false} activeDot={{ r: 4, fill: "#34d399" }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <p style={{ fontSize: 11, color: "rgba(255,255,255,0.25)", margin: "10px 0 0", textAlign: "center" }}>
              Fee tracking started{" "}
              {new Date(feeMetrics.firstSnap.timestamp).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}.
              {" "}Data before this date is not available.
            </p>
          </Card>
        )}

        {/* ── 2D.7: Activity Log ────────────────────────────────────────────── */}
        <Card style={{ marginBottom: 20, border: "1px solid rgba(52,211,153,0.12)" }}>
          <SectionHeader icon="📋" label="Fee Claims History" />
          {activityLoading && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, color: "rgba(255,255,255,0.4)", fontSize: 13, padding: "12px 0" }}>
              <div style={{ width: 16, height: 16, border: "2px solid #34d399", borderTopColor: "transparent",
                borderRadius: "50%", animation: "_spin 1s linear infinite", flexShrink: 0 }} />
              Scanning blockchain for fee history…
            </div>
          )}
          {!activityLoading && !isActivityProtocol && (
            <p style={{ fontSize: 13, color: "rgba(255,255,255,0.35)", margin: 0 }}>
              Activity data not available for {pos.protocol} — on-chain fee history scanning is not yet supported for this protocol.
            </p>
          )}
          {!activityLoading && isActivityProtocol && !activity && (
            <p style={{ fontSize: 13, color: "rgba(255,255,255,0.35)", margin: 0 }}>
              Could not load fee claim data. The blockchain scan may have timed out — try refreshing.
            </p>
          )}
          {!activityLoading && isActivityProtocol && activity && (() => {
            const feeClaims = activity.events.filter(e => e.type === 'fee_claim' || e.type === 'reward_claim');
            const txUrl = (hash: string): string => {
              if (pos.protocol === 'Bluefin') return `https://suivision.xyz/txblock/${hash}`;
              if (pos.protocol === 'Orca' || pos.protocol === 'Raydium') return `https://solscan.io/tx/${hash}`;
              if (HYPEREVM_PROTOCOLS.has(pos.protocol)) return `https://hypurrscan.io/tx/${hash}`;
              if (pos.chain === 'Arbitrum') return `https://arbiscan.io/tx/${hash}`;
              if (pos.chain === 'Polygon')  return `https://polygonscan.com/tx/${hash}`;
              if (pos.chain === 'Optimism') return `https://optimistic.etherscan.io/tx/${hash}`;
              if (pos.chain === 'Ethereum') return `https://etherscan.io/tx/${hash}`;
              return `https://basescan.org/tx/${hash}`;
            };
            const fmtDate = (ts: number) => {
              if (!ts) return '—';
              return new Date(ts * 1000).toLocaleDateString('en-US', {
                year: 'numeric', month: 'short', day: 'numeric',
                hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
              });
            };
            const fmtAmt = (n: number) => n === 0 ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: 6 });
            const shortHash = (h: string) => h.length > 12 ? `${h.slice(0, 6)}…${h.slice(-4)}` : h;
            const totalClaimed = feeClaims.reduce((sum, e) => {
              if (e.usdAtTime != null) return sum + e.usdAtTime;
              return sum + e.amount0 * (pos.price0 ?? 0) + e.amount1 * (pos.price1 ?? 0);
            }, 0);

            if (feeClaims.length === 0) {
              return (
                <p style={{ fontSize: 13, color: "rgba(255,255,255,0.35)", margin: 0 }}>
                  No fee claims detected yet. Claims will appear here after you collect fees on-chain.
                </p>
              );
            }

            const thStyle: React.CSSProperties = {
              fontSize: 11, textTransform: "uppercase" as const, letterSpacing: 0.5,
              color: "rgba(255,255,255,0.3)", padding: "0 0 10px", fontWeight: 500,
            };
            const tdStyle: React.CSSProperties = {
              fontSize: 12, padding: "10px 0", borderTop: "1px solid rgba(255,255,255,0.04)",
              color: "rgba(255,255,255,0.7)",
            };

            return (
              <div>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr>
                        <th style={{ ...thStyle, textAlign: "left" }}>Date (UTC)</th>
                        <th style={{ ...thStyle, textAlign: "right" }}>{t0}</th>
                        <th style={{ ...thStyle, textAlign: "right" }}>{t1}</th>
                        <th style={{ ...thStyle, textAlign: "right" }}>Total USD</th>
                        <th style={{ ...thStyle, textAlign: "right" }}>Tx</th>
                      </tr>
                    </thead>
                    <tbody>
                      {feeClaims.map((ev, i) => {
                        const usd = ev.usdAtTime ?? (ev.amount0 * (pos.price0 ?? 0) + ev.amount1 * (pos.price1 ?? 0));
                        return (
                          <tr key={i}>
                            <td style={{ ...tdStyle, whiteSpace: "nowrap" as const }}>{fmtDate(ev.timestamp)}</td>
                            <td style={{ ...tdStyle, textAlign: "right", fontFamily: "monospace" }}>
                              {ev.type === 'reward_claim'
                                ? `${fmtAmt(ev.amount0)} ${(ev as any).rewardSymbol ?? ''}`
                                : fmtAmt(ev.amount0)}
                            </td>
                            <td style={{ ...tdStyle, textAlign: "right", fontFamily: "monospace" }}>
                              {ev.type === 'reward_claim' ? '—' : fmtAmt(ev.amount1)}
                            </td>
                            <td style={{ ...tdStyle, textAlign: "right", fontWeight: 600, color: "#34d399" }}>
                              {fmt$(usd)}
                            </td>
                            <td style={{ ...tdStyle, textAlign: "right" }}>
                              <a href={txUrl(ev.txHash)} target="_blank" rel="noopener noreferrer"
                                style={{ color: "#6ee7b7", fontFamily: "monospace", fontSize: 11, textDecoration: "none" }}>
                                {shortHash(ev.txHash)}
                              </a>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
                  borderTop: "1px solid rgba(255,255,255,0.06)", marginTop: 12, paddingTop: 12 }}>
                  <span style={{ fontSize: 12, color: "rgba(255,255,255,0.3)" }}>
                    {feeClaims.length} collection{feeClaims.length !== 1 ? "s" : ""}
                  </span>
                  <span style={{ fontSize: 14, fontWeight: 700, color: "#34d399" }}>
                    Total Claimed: {fmt$(totalClaimed)}
                  </span>
                </div>
              </div>
            );
          })()}
        </Card>

        {/* ── 2E: Concentrated Liquidity Range ─────────────────────────────── */}
        {hasRange && (
          <Card style={{ marginBottom: 20 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
              marginBottom: 16, flexWrap: "wrap", gap: 8 }}>
              <SectionHeader icon="◉" label="Concentrated Liquidity Range" />
              <span style={{
                fontSize: 12,
                padding: "3px 10px",
                borderRadius: 20,
                background: isClosed ? "rgba(255,255,255,0.03)"
                  : posStatus === "In Range" ? "rgba(52,211,153,0.1)"
                  : "rgba(245,158,11,0.1)",
                border: `1px solid ${isClosed ? "rgba(255,255,255,0.06)"
                  : posStatus === "In Range" ? "rgba(52,211,153,0.2)"
                  : "rgba(245,158,11,0.2)"}`,
                color: isClosed ? "rgba(255,255,255,0.3)"
                  : posStatus === "In Range" ? "#34d399"
                  : "#f59e0b",
              }}>
                {isClosed ? "Position Closed" : posStatus === "In Range" ? "Position Active" : "Out of Range"}
              </span>
            </div>

            {/* Price labels */}
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
              <div>
                <p style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 1,
                  color: "rgba(255,255,255,0.3)", margin: "0 0 2px" }}>Min Price</p>
                <p style={{ fontSize: 14, fontWeight: 600, color: "white", margin: 0 }}>
                  {minPriceUSD != null ? fmtPrice(minPriceUSD) : "—"}
                </p>
              </div>
              <div style={{ textAlign: "center" }}>
                <p style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 1,
                  color: "rgba(255,255,255,0.3)", margin: "0 0 2px" }}>Current Price</p>
                <p style={{ fontSize: 14, fontWeight: 600,
                  color: isClosed ? "rgba(255,255,255,0.4)"
                    : posStatus === "In Range" ? "#34d399"
                    : "#f59e0b",
                  margin: 0 }}>
                  {curPriceUSD != null ? fmtPrice(curPriceUSD) : "—"}
                </p>
              </div>
              <div style={{ textAlign: "right" }}>
                <p style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 1,
                  color: "rgba(255,255,255,0.3)", margin: "0 0 2px" }}>Max Price</p>
                <p style={{ fontSize: 14, fontWeight: 600, color: "white", margin: 0 }}>
                  {maxPriceUSD != null ? fmtPrice(maxPriceUSD) : "—"}
                </p>
              </div>
            </div>

            {/* Range bar */}
            <div style={{ position: "relative", height: 6, background: "rgba(255,255,255,0.06)",
              borderRadius: 3, marginBottom: 8 }}>
              <div style={{
                position: "absolute", inset: 0, borderRadius: 3,
                background: isClosed ? "#374151"
                  : posStatus === "In Range"
                  ? "linear-gradient(90deg, #059669, #34d399)"
                  : "rgba(245,158,11,0.3)",
              }} />
              {!isClosed && curPriceUSD !== null && (
                <div style={{
                  position: "absolute", top: "50%", transform: "translate(-50%, -50%)",
                  left: `${rangeBarPct}%`,
                  width: 12, height: 12, borderRadius: "50%",
                  background: posStatus === "In Range" ? "#34d399" : "#f59e0b",
                  border: "2px solid white",
                  zIndex: 1,
                }} />
              )}
            </div>

            {rangeWidthPct != null && (
              <p style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", textAlign: "right", margin: 0 }}>
                Range Width: {rangeWidthPct}%
              </p>
            )}
          </Card>
        )}

        {/* ── 2F: Yield & APR Projections ──────────────────────────────────── */}
        <Card style={{ marginBottom: 20 }}>
          <SectionHeader icon="%" label="Yield & APR Projections" />
          <p style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", margin: "-10px 0 16px", letterSpacing: 0.3 }}>
            Based on current pool rate
          </p>
          <div className="detail-4col"
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12 }}>
            {([
              { label: "Daily",   div: 365,  amt: dailyUSD,   unit: "/day" },
              { label: "Weekly",  div: 52,   amt: weeklyUSD,  unit: "/week" },
              { label: "Monthly", div: 12,   amt: monthlyUSD, unit: "/month" },
              { label: "Yearly",  div: 1,    amt: yearlyUSD,  unit: "/year" },
            ] as const).map(({ label, div, amt, unit }) => (
              <div key={label} style={{ background: "rgba(255,255,255,0.03)",
                border: "1px solid rgba(255,255,255,0.06)", borderRadius: 10,
                padding: 14, textAlign: "center" }}>
                <p style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", margin: "0 0 6px",
                  textTransform: "uppercase", letterSpacing: 1 }}>{label}</p>
                {hasApr ? (
                  <>
                    <p style={{ fontSize: 16, fontWeight: 700, color: "#34d399", margin: "0 0 4px" }}>
                      +{(pos.apy / div).toFixed(div >= 52 ? 2 : 1)}%
                    </p>
                    <p style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", margin: 0 }}>
                      {amt != null ? fmt$(amt) : "—"}{unit}
                    </p>
                  </>
                ) : (
                  <p style={{ fontSize: 16, fontWeight: 700, color: "#6ee7b7", margin: 0 }}>N/A</p>
                )}
              </div>
            ))}
          </div>
        </Card>

        {/* ── 2G: Pool Statistics ───────────────────────────────────────────── */}
        <Card style={{ marginBottom: 20 }}>
          <SectionHeader icon="⚡" label="Pool Statistics" />
          <div className="detail-3col"
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
            {([
              { label: "Pool TVL",   value: poolStats?.tvlUsd ?? null },
              { label: "24h Volume", value: poolStats?.volumeUsd1d ?? null },
              { label: "24h Fees",   value: poolStats?.feesUsd1d ?? null },
            ] as const).map(({ label, value }) => (
              <div key={label} style={{ background: "rgba(255,255,255,0.03)",
                border: "1px solid rgba(255,255,255,0.06)", borderRadius: 10,
                padding: 14, textAlign: "center" }}>
                <p style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", margin: "0 0 6px",
                  textTransform: "uppercase", letterSpacing: 1 }}>{label}</p>
                {poolStatsLoading ? (
                  <p style={{ fontSize: 16, color: "rgba(255,255,255,0.2)", margin: 0 }}>…</p>
                ) : value != null ? (
                  <p style={{ fontSize: 16, fontWeight: 700, color: "#6ee7b7", margin: 0 }}>{fmtLarge(value)}</p>
                ) : (
                  <p style={{ fontSize: 13, color: "rgba(255,255,255,0.2)", margin: 0 }}>Data unavailable</p>
                )}
              </div>
            ))}
          </div>
        </Card>

        {/* ── Footer: Position ID & manage link ─────────────────────────────── */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
          flexWrap: "wrap", gap: 12, borderTop: "1px solid rgba(255,255,255,0.05)", paddingTop: 20 }}>
          <div>
            <p style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", margin: "0 0 2px" }}>Position ID</p>
            <p style={{ fontSize: 12, fontFamily: "monospace", color: "rgba(255,255,255,0.5)", margin: 0,
              wordBreak: "break-all" }}>{pos.id}</p>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <Link href="/dashboard" style={{ background: "rgba(255,255,255,0.04)",
              border: "1px solid rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.5)",
              borderRadius: 10, padding: "8px 16px", textDecoration: "none", fontSize: 13 }}>
              ← Dashboard
            </Link>
            {manageUrl && (
              <a href={manageUrl} target="_blank" rel="noopener noreferrer"
                style={{ background: "rgba(16,185,129,0.2)", border: "1px solid rgba(16,185,129,0.3)",
                  color: "#6ee7b7", borderRadius: 10, padding: "8px 16px", textDecoration: "none",
                  fontSize: 13, fontWeight: 500 }}>
                Manage Position ↗
              </a>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}
