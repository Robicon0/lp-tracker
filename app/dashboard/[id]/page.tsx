"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import { useState, useEffect } from "react";
import Navbar from "../../Navbar";
import { getTokenLogo, getTokenColor } from "../../lib/tokenLogos";
import { usePositions } from "../../contexts/PositionsContext";
import { usePositionActivity } from "../../hooks/usePositionActivity";
import { useBluefinActivity } from "../../hooks/useBluefinActivity";
import { useOrcaActivity } from "../../hooks/useOrcaActivity";
import { useRaydiumActivity } from "../../hooks/useRaydiumActivity";
import { useHyperSwapActivity } from "../../hooks/useHyperSwapActivity";
import { useUniswapActivity } from "../../hooks/useUniswapActivity";
import { useVelodromeActivity } from "../../hooks/useVelodromeActivity";
import { usePancakeSwapActivity } from "../../hooks/usePancakeSwapActivity";
import { useDbPositionHistory, type HistoryRange } from "../../hooks/useDbPortfolioHistory";
import { computePositionPnL } from "../../lib/positionPnl";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts";

function TokenCircle({ symbol, size = 32, overlap = false }: { symbol: string; size?: number; overlap?: boolean }) {
  const [imgError, setImgError] = useState(false);
  const logoUrl = getTokenLogo(symbol);
  const color = getTokenColor(symbol);
  const baseStyle: React.CSSProperties = {
    width: size, height: size, borderRadius: "50%",
    border: "2px solid #0a0f0d", flexShrink: 0,
    ...(overlap ? { marginLeft: -size * 0.3 } : {}),
  };
  if (logoUrl && !imgError) {
    return (
      <img src={logoUrl} alt={symbol} onError={() => setImgError(true)}
        style={{ ...baseStyle, objectFit: "cover", display: "block" }} />
    );
  }
  return (
    <div style={{ ...baseStyle, background: color, display: "flex", alignItems: "center",
      justifyContent: "center", fontSize: size * 0.36, fontWeight: 700, color: "white" }}>
      {symbol.charAt(0).toUpperCase()}
    </div>
  );
}

const STABLES = new Set(["USDC", "USDT", "DAI", "USDbC", "USDC.e", "USDS"]);

function tickToPrice(tick: number, decimals0: number, decimals1: number): number {
  return Math.pow(1.0001, tick) * Math.pow(10, decimals0 - decimals1);
}

function formatPrice(p: number): string {
  if (p >= 1000) return `$${p.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  if (p >= 1) return `$${p.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  return `$${p.toLocaleString("en-US", { maximumFractionDigits: 6 })}`;
}

function buildTickRangeLabel(
  tickLower: number,
  tickUpper: number,
  decimals0: number,
  decimals1: number,
  sym0: string,
  sym1: string,
): string {
  if (STABLES.has(sym1)) {
    const lo = tickToPrice(tickLower, decimals0, decimals1);
    const hi = tickToPrice(tickUpper, decimals0, decimals1);
    return `${formatPrice(lo)} — ${formatPrice(hi)}`;
  } else if (STABLES.has(sym0)) {
    const lo = tickToPrice(tickLower, decimals0, decimals1);
    const hi = tickToPrice(tickUpper, decimals0, decimals1);
    return `${formatPrice(1 / hi)} — ${formatPrice(1 / lo)}`;
  } else {
    const lo = tickToPrice(tickLower, decimals0, decimals1);
    const hi = tickToPrice(tickUpper, decimals0, decimals1);
    const fmt = (p: number) => p.toLocaleString("en-US", { maximumFractionDigits: 6 });
    return `${fmt(lo)} — ${fmt(hi)} ${sym1}/${sym0}`;
  }
}

interface ILData {
  entryPriceUSD: number;
  entryPriceLabel: string;
  entryTick: number;
  hodlValue: number;
  ilUSD: number;
  ilPct: number;
}

function computeIL(
  liquidity: string,
  price0: number,
  price1: number,
  tickLower: number,
  tickUpper: number,
  decimals0: number,
  decimals1: number,
  sym0: string,
  sym1: string,
  currentValue: number,
): ILData | null {
  if (!liquidity || price0 === 0 || price1 === 0) return null;
  const L = Number(liquidity);
  if (L === 0) return null;

  const entryTick = Math.floor((tickLower + tickUpper) / 2);
  const sqrtPe = Math.sqrt(Math.pow(1.0001, entryTick));
  const sqrtLower = Math.sqrt(Math.pow(1.0001, tickLower));
  const sqrtUpper = Math.sqrt(Math.pow(1.0001, tickUpper));

  if (!isFinite(sqrtPe) || sqrtPe === 0 || !isFinite(sqrtLower) || !isFinite(sqrtUpper)) return null;

  const entryAmount0 = Math.max(0, L * (1 / sqrtPe - 1 / sqrtUpper)) / Math.pow(10, decimals0);
  const entryAmount1 = Math.max(0, L * (sqrtPe - sqrtLower)) / Math.pow(10, decimals1);

  const hodlValue = entryAmount0 * price0 + entryAmount1 * price1;
  if (hodlValue <= 0) return null;

  const ilUSD = currentValue - hodlValue;
  const ilPct = (ilUSD / hodlValue) * 100;

  // Token0 price in USD at entry tick
  const entryPriceToken0USD = Math.pow(1.0001, entryTick) * Math.pow(10, decimals0 - decimals1) * price1;

  let entryPriceUSD: number;
  let entryPriceLabel: string;
  if (STABLES.has(sym1)) {
    entryPriceUSD = entryPriceToken0USD;
    entryPriceLabel = sym0;
  } else if (STABLES.has(sym0)) {
    entryPriceUSD = entryPriceToken0USD > 0 ? 1 / entryPriceToken0USD : 0;
    entryPriceLabel = sym1;
  } else {
    entryPriceUSD = entryPriceToken0USD;
    entryPriceLabel = sym0;
  }

  if (!isFinite(entryPriceUSD) || entryPriceUSD <= 0) return null;

  return { entryPriceUSD, entryPriceLabel, entryTick, hodlValue, ilUSD, ilPct };
}

export default function PositionDetail() {
  const { id } = useParams<{ id: string }>();
  const { positions, isLoading } = usePositions();
  const [mounted, setMounted] = useState(false);
  const [aprExpanded, setAprExpanded] = useState(false);
  const [pnlRange, setPnlRange] = useState<HistoryRange>("30d");
  const { snapshots: dbPosSnaps, configured: dbPosConfigured } = useDbPositionHistory(id, pnlRange);
  useEffect(() => setMounted(true), []);

  // Find position — may be undefined until data loads; derive params for hook below
  const pos = positions.find((p) => p.id === id);

  // ALL hooks must be called unconditionally before any early returns
  const aeroTokenId = pos?.protocol === 'Aerodrome' ? pos.id.replace('aero-', '') : null;
  const { data: aeroActivity, isLoading: aeroActivityLoading } = usePositionActivity(
    aeroTokenId,
    pos?.token0Decimals ?? 18,
    pos?.token1Decimals ?? 18,
    pos?.token0Address,
    pos?.token1Address,
    pos?.price0,
    pos?.price1,
  );

  const bluefinObjId = pos?.protocol === 'Bluefin' ? pos.id.replace('bluefin-', '') : null;
  const { data: bluefinActivity, isLoading: bluefinActivityLoading } = useBluefinActivity(
    bluefinObjId,
    pos?.token0Decimals ?? 9,
    pos?.token1Decimals ?? 6,
    pos?.coinTypeA,
    pos?.coinTypeB,
    pos?.price0,
    pos?.price1,
    pos?.walletAddress,
  );

  const orcaPosId = pos?.protocol === 'Orca' ? pos.id.replace('orca-', '') : null;
  const { data: orcaActivity, isLoading: orcaActivityLoading } = useOrcaActivity(
    orcaPosId,
    pos?.token0Decimals ?? 9,
    pos?.token1Decimals ?? 6,
    pos?.token0Address,
    pos?.token1Address,
    pos?.price0,
    pos?.price1,
    pos?.walletAddress,
  );

  const raydiumPosId = pos?.protocol === 'Raydium' ? pos.id.replace('ray-', '') : null;
  const { data: raydiumActivity, isLoading: raydiumActivityLoading } = useRaydiumActivity(
    raydiumPosId,
    pos?.token0Decimals ?? 9,
    pos?.token1Decimals ?? 6,
    pos?.token0Address,
    pos?.token1Address,
    pos?.price0,
    pos?.price1,
    pos?.walletAddress,
  );

  const HYPEREVM_PROTOCOLS = new Set(['HyperSwap', 'KittenSwap', 'ProjectX']);
  const hyperswapTokenId = pos && HYPEREVM_PROTOCOLS.has(pos.protocol)
    ? pos.id.replace(/^hyperswap-[^-]+-/, '')
    : null;
  const { data: hyperswapActivity, isLoading: hyperswapActivityLoading } = useHyperSwapActivity(
    hyperswapTokenId,
    pos && HYPEREVM_PROTOCOLS.has(pos.protocol) ? pos.protocol : null,
    pos?.token0Decimals ?? 18,
    pos?.token1Decimals ?? 6,
    pos?.token0Address,
    pos?.token1Address,
    pos?.price0,
    pos?.price1,
  );

  // Uniswap V3 — id format: uni3-{chainKey}-{tokenId}
  const uniswapPosId = pos?.protocol === 'Uniswap V3' ? pos.id : null;
  const { data: uniswapActivity, isLoading: uniswapActivityLoading } = useUniswapActivity(
    uniswapPosId,
    pos?.token0Decimals ?? 18,
    pos?.token1Decimals ?? 18,
    pos?.token0Address,
    pos?.token1Address,
    pos?.price0,
    pos?.price1,
  );

  // Velodrome — id format: velo-{tokenId}
  const velodromePosId = pos?.protocol === 'Velodrome' ? pos.id.replace('velo-', '') : null;
  const { data: velodromeActivity, isLoading: velodromeActivityLoading } = useVelodromeActivity(
    velodromePosId,
    pos?.token0Decimals ?? 18,
    pos?.token1Decimals ?? 18,
    pos?.token0Address,
    pos?.token1Address,
    pos?.price0,
    pos?.price1,
  );

  // PancakeSwap V3 (BNB Chain) — id format: cake3-bsc-{tokenId}
  const pancakeTokenId = pos?.protocol === 'PancakeSwap V3' ? pos.id.replace('cake3-bsc-', '') : null;
  const { data: pancakeActivity, isLoading: pancakeActivityLoading } = usePancakeSwapActivity(
    pancakeTokenId,
    pos?.token0Decimals ?? 18,
    pos?.token1Decimals ?? 18,
    pos?.token0Address,
    pos?.token1Address,
    pos?.price0,
    pos?.price1,
  );

  // Unified activity data — pick source based on protocol
  const isHyperEVM = pos ? HYPEREVM_PROTOCOLS.has(pos.protocol) : false;
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
  const isActivityProtocol = pos?.protocol === 'Aerodrome' || pos?.protocol === 'Bluefin'
    || pos?.protocol === 'Orca' || pos?.protocol === 'Raydium' || isHyperEVM
    || pos?.protocol === 'Uniswap V3' || pos?.protocol === 'Velodrome'
    || pos?.protocol === 'PancakeSwap V3';
  // EVM-only protocols where on-chain entry-price P&L + IL is supported this phase.
  // Solana (Orca/Raydium) and Sui (Bluefin) are out of scope and keep the legacy IL section.
  const isEvmActivityProtocol = pos?.protocol === 'Aerodrome' || pos?.protocol === 'Velodrome'
    || pos?.protocol === 'Uniswap V3' || isHyperEVM || pos?.protocol === 'PancakeSwap V3';

  // localStorage fee snapshot — saves current uncollected fees so we can detect
  // future claims on chains where tx scanning isn't available (Solana/Sui).
  // Must be called here (after pos is defined) but before any early returns.
  useEffect(() => {
    if (!pos || !mounted) return;
    try {
      const snapshot = {
        timestamp: Math.floor(Date.now() / 1000),
        uncollectedFeesUSD: pos.fees,
        token0Uncollected: pos.fees0 ?? 0,
        token1Uncollected: pos.fees1 ?? 0,
      };
      const key = `defidesh-fee-snapshots-${pos.id}`;
      const existing: typeof snapshot[] = JSON.parse(localStorage.getItem(key) ?? '[]');
      const last = existing[existing.length - 1];
      // Only append a new snapshot every 5+ minutes to avoid flooding storage
      if (!last || snapshot.timestamp - last.timestamp > 300) {
        existing.push(snapshot);
        if (existing.length > 1000) existing.shift();
        localStorage.setItem(key, JSON.stringify(existing));
      }
    } catch {
      // localStorage unavailable — ignore
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos?.id, pos?.fees, mounted]);

  if (!mounted || isLoading) {
    return (
      <div className="px-4 pt-24 pb-8 bg-[#0a0f0d] text-white min-h-screen">
        <Navbar />
        <div className="w-full max-w-7xl mx-auto">
          <Link href="/dashboard" className="text-emerald-400 hover:text-emerald-300 text-sm mb-6 inline-block">
            &larr; Back to Dashboard
          </Link>
          <div className="flex items-center justify-center py-24">
            <div className="w-8 h-8 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin" />
          </div>
        </div>
      </div>
    );
  }

  if (!pos) {
    return (
      <div className="px-4 pt-24 pb-8 bg-[#0a0f0d] text-white min-h-screen">
        <Navbar />
        <div className="w-full max-w-7xl mx-auto">
          <Link href="/dashboard" className="text-emerald-400 hover:text-emerald-300 text-sm mb-6 inline-block">
            &larr; Back to Dashboard
          </Link>
          <div className="flex items-center justify-center py-24">
            <div className="text-center">
              <h1 className="text-4xl font-bold mb-4">Position Not Found</h1>
              <p className="text-emerald-300/70">This position doesn&apos;t exist or your wallet isn&apos;t connected.</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const estimatedDailyFees = (pos.value * pos.apy) / 100 / 365;
  const estimatedMonthlyYield = (pos.value * pos.apy) / 100 / 12;

  const ilData: ILData | null =
    pos.status !== "Closed" &&
    pos.liquidity != null &&
    pos.price0 != null &&
    pos.price1 != null &&
    pos.tickLower != null &&
    pos.tickUpper != null
      ? computeIL(
          pos.liquidity,
          pos.price0,
          pos.price1,
          pos.tickLower,
          pos.tickUpper,
          pos.token0Decimals ?? 18,
          pos.token1Decimals ?? 18,
          pos.token0Symbol ?? "",
          pos.token1Symbol ?? "",
          pos.value,
        )
      : null;

  const hasFeeBreakdown = pos.fees0 != null && pos.fees1 != null;
  const hasTickRange = pos.tickLower != null && pos.tickUpper != null;
  const hasFeeTier = pos.feeTier != null;

  const tickRangeLabel =
    pos.tickLower != null && pos.tickUpper != null
      ? buildTickRangeLabel(
          pos.tickLower,
          pos.tickUpper,
          pos.token0Decimals ?? 18,
          pos.token1Decimals ?? 18,
          pos.token0Symbol ?? "",
          pos.token1Symbol ?? "",
        )
      : null;

  // Pre-compute APR metrics for the stat card
  const aprMetrics = (() => {
    if (!isActivityProtocol || !activity) return null;
    const feeClaims = activity.events.filter(e => e.type === 'fee_claim' || e.type === 'reward_claim');
    if (feeClaims.length === 0) return null;
    const totalFeesUSD = feeClaims.reduce((sum, e) => {
      if (e.usdAtTime != null) return sum + e.usdAtTime;
      return sum + e.amount0 * (pos.price0 ?? 0) + e.amount1 * (pos.price1 ?? 0);
    }, 0);
    const deposits = activity.events.filter(e => e.type === 'deposit');
    const firstDeposit = deposits.length > 0 ? deposits[deposits.length - 1] : null;
    const firstTs = firstDeposit?.timestamp ?? 0;
    const nowTs = Math.floor(Date.now() / 1000);
    const daysActive = firstTs > 0 ? (nowTs - firstTs) / 86400 : 0;
    if (daysActive < 1) return null;
    const aprYearly = pos.value > 0 ? (totalFeesUSD / pos.value) / (daysActive / 365) * 100 : 0;
    return { aprYearly, aprMonthly: aprYearly / 12, aprWeekly: aprYearly / 52, aprDaily: aprYearly / 365 };
  })();

  // Total claimed fees from on-chain activity (fee_claim + reward_claim events)
  const totalClaimedUSD = (() => {
    if (!activity) return 0;
    return activity.events
      .filter(e => e.type === 'fee_claim' || e.type === 'reward_claim')
      .reduce((sum, e) => {
        if (e.usdAtTime != null) return sum + e.usdAtTime;
        return sum + e.amount0 * (pos.price0 ?? 0) + e.amount1 * (pos.price1 ?? 0);
      }, 0);
  })();
  // Lifetime = claimed (historical) + currently uncollected
  const totalLifetimeFeesUSD = totalClaimedUSD + pos.fees;

  return (
    <div className="px-4 pt-24 pb-8 bg-[#0a0f0d] text-white min-h-screen">
      <Navbar />
      <div className="w-full max-w-7xl mx-auto">
        <Link href="/dashboard" className="text-emerald-400 hover:text-emerald-300 text-sm mb-6 inline-block">
          &larr; Back to Dashboard
        </Link>

        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            {(pos.token0Symbol || pos.token1Symbol) && (
              <div className="flex items-center">
                <TokenCircle symbol={pos.token0Symbol ?? ''} size={44} />
                <TokenCircle symbol={pos.token1Symbol ?? ''} size={44} overlap />
              </div>
            )}
            <div>
              <h1 className="text-2xl font-extrabold text-white">{pos.pair}</h1>
              <p className="text-gray-400 text-sm mt-1">{pos.protocol} &bull; {pos.chain}</p>
            </div>
          </div>
          <span className={`px-4 py-2 rounded-full text-sm font-bold ${
            pos.status === "In Range"
              ? "bg-emerald-950 text-emerald-400 border border-emerald-400/30"
              : pos.status === "Closed"
              ? "bg-gray-800/50 text-gray-400 border border-gray-600/30"
              : "bg-red-950/50 text-red-400 border border-red-400/30"
          }`}>
            {pos.status}
          </span>
        </div>

        {/* Row 1: Top Stats — 4 cards */}
        <div className="grid grid-cols-4 gap-[2px] mb-4 bg-emerald-500/20 rounded-xl overflow-hidden">
          <div className="bg-gradient-to-br from-[#064e3b] to-[#0a2e1a] p-4">
            <p className="text-xs font-semibold text-emerald-300 mb-1">Position Value</p>
            <p className="text-2xl font-extrabold text-white">
              ${pos.value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </p>
          </div>

          <div className="bg-gradient-to-br from-[#064e3b] to-[#0a2e1a] p-4">
            <p className="text-xs font-semibold text-emerald-300 mb-1">Realized APR</p>
            {activityLoading ? (
              <div className="h-7 mt-1 bg-emerald-900/40 rounded animate-pulse w-3/4" />
            ) : aprMetrics ? (
              <button onClick={() => setAprExpanded(v => !v)} className="text-left w-full">
                <div className="flex items-center gap-1">
                  <span className="text-2xl font-extrabold text-white">~{aprMetrics.aprYearly.toFixed(1)}%</span>
                  <span className="text-gray-400 text-xs">/yr</span>
                  <svg className={`w-3 h-3 text-gray-400 ml-auto transition-transform duration-200 ${aprExpanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </div>
                {aprExpanded && (
                  <div className="mt-2 grid grid-cols-2 gap-1">
                    <div className="bg-emerald-900/30 rounded p-1.5 text-center">
                      <p className="text-xs text-gray-400">Yearly</p>
                      <p className="text-xs font-bold text-emerald-300">~{aprMetrics.aprYearly.toFixed(1)}%</p>
                    </div>
                    <div className="bg-blue-900/30 rounded p-1.5 text-center">
                      <p className="text-xs text-gray-400">Monthly</p>
                      <p className="text-xs font-bold text-blue-300">~{aprMetrics.aprMonthly.toFixed(2)}%</p>
                    </div>
                    <div className="bg-purple-900/30 rounded p-1.5 text-center">
                      <p className="text-xs text-gray-400">Weekly</p>
                      <p className="text-xs font-bold text-purple-300">~{aprMetrics.aprWeekly.toFixed(2)}%</p>
                    </div>
                    <div className="bg-emerald-900/20 rounded p-1.5 text-center">
                      <p className="text-xs text-gray-400">Daily</p>
                      <p className="text-xs font-bold text-white/60">~{aprMetrics.aprDaily.toFixed(3)}%</p>
                    </div>
                  </div>
                )}
              </button>
            ) : (
              <p className="text-2xl font-extrabold text-white/30">—</p>
            )}
          </div>

          <div className="bg-gradient-to-br from-[#064e3b] to-[#0a2e1a] p-4">
            <p className="text-xs font-semibold text-emerald-300 mb-1">Total Fees Earned</p>
            {activityLoading && isActivityProtocol ? (
              <div className="h-7 mt-1 bg-emerald-900/40 rounded animate-pulse w-3/4" />
            ) : (
              <>
                <p className="text-2xl font-extrabold text-white">
                  ${(isActivityProtocol ? totalLifetimeFeesUSD : pos.fees).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </p>
                {isActivityProtocol && totalClaimedUSD > 0 && (
                  <p className="text-xs text-emerald-300/60 mt-1">
                    ${totalClaimedUSD.toFixed(2)} claimed + ${pos.fees.toFixed(2)} uncollected
                  </p>
                )}
              </>
            )}
          </div>

          <div className="bg-gradient-to-br from-[#064e3b] to-[#0a2e1a] p-4">
            <p className="text-xs font-semibold text-emerald-300 mb-1">IL</p>
            {ilData ? (
              <>
                <p className={`text-2xl font-bold ${ilData.ilUSD < 0 ? 'text-red-400' : 'text-emerald-400'}`}>
                  {ilData.ilUSD < 0 ? '−' : '+'}${Math.abs(ilData.ilUSD).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </p>
                <p className="text-xs mt-1 text-red-300">
                  {ilData.ilUSD >= 0 ? '+' : ''}{ilData.ilPct.toFixed(2)}% vs HODL
                </p>
              </>
            ) : (
              <p className="text-2xl font-extrabold text-white/30">—</p>
            )}
          </div>
        </div>

        {/* Row 2: Assets + Position Details */}
        <div className={`grid gap-[2px] mb-1.5 bg-emerald-500/20 rounded-xl overflow-hidden items-start ${isActivityProtocol ? 'grid-cols-2' : 'grid-cols-1'}`}>
          {/* Assets: Current vs Invested */}
          {isActivityProtocol && (
            <div className="bg-[#0a2e1a]/60 p-4">
              <h2 className="text-sm font-extrabold text-emerald-300 mb-3">Assets</h2>

              {activityLoading && (
                <div className="flex items-center gap-1 text-gray-400 text-sm py-4">
                  <div className="w-4 h-4 border border-emerald-400/50 border-t-transparent rounded-full animate-spin" />
                  Scanning on-chain history…
                </div>
              )}

              {!activityLoading && activity && (() => {
              const p0 = pos.price0 ?? 0;
              const p1 = pos.price1 ?? 0;
              const sym0 = pos.token0Symbol ?? 'Token0';
              const sym1 = pos.token1Symbol ?? 'Token1';
              const cur0 = pos.amount0 ?? 0;
              const cur1 = pos.amount1 ?? 0;
              const inv0 = activity.netInvested0;
              const inv1 = activity.netInvested1;
              const investedUSD = inv0 * p0 + inv1 * p1;
              const currentUSD = pos.value;
              const gainLossUSD = currentUSD - investedUSD;
              const gainLoss0 = cur0 - inv0;
              const gainLoss1 = cur1 - inv1;

              const fmtAmt = (n: number, decimals = 6) =>
                n.toLocaleString('en-US', { maximumFractionDigits: decimals, minimumFractionDigits: 0 });
              const fmtUSD = (n: number) =>
                `$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
              const sign = (n: number) => (n >= 0 ? '+' : '−');

              return (
                <div>
                  <div className="grid grid-cols-4 gap-1 text-xs text-gray-400 mb-1.5 px-1">
                    <span></span>
                    <span className="text-right">{sym0}</span>
                    <span className="text-right">{sym1}</span>
                    <span className="text-right">USD</span>
                  </div>
                  <div className="grid grid-cols-4 gap-1 py-2 border-b border-emerald-500/10 px-1 items-center">
                    <span className="text-sm text-gray-400">Invested</span>
                    <span className="text-right font-mono text-sm font-bold text-white">{fmtAmt(inv0)}</span>
                    <span className="text-right font-mono text-sm font-bold text-white">{fmtAmt(inv1)}</span>
                    <span className="text-right text-sm font-bold text-white">{fmtUSD(investedUSD)}</span>
                  </div>
                  <div className="grid grid-cols-4 gap-1 py-2 border-b border-emerald-500/10 px-1 items-center">
                    <span className="text-sm text-gray-400">Current</span>
                    <span className="text-right font-mono text-sm font-bold text-white">{fmtAmt(cur0)}</span>
                    <span className="text-right font-mono text-sm font-bold text-white">{fmtAmt(cur1)}</span>
                    <span className="text-right text-sm font-bold text-white">{fmtUSD(currentUSD)}</span>
                  </div>
                  <div className="grid grid-cols-4 gap-1 py-2 px-1 items-center">
                    <span className="text-sm text-gray-400">Gain / Loss</span>
                    <span className={`text-right font-mono text-sm font-bold ${gainLoss0 >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {sign(gainLoss0)}{fmtAmt(Math.abs(gainLoss0))}
                    </span>
                    <span className={`text-right font-mono text-sm font-bold ${gainLoss1 >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {sign(gainLoss1)}{fmtAmt(Math.abs(gainLoss1))}
                    </span>
                    <span className={`text-right text-sm font-bold ${gainLossUSD >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {sign(gainLossUSD)}{fmtUSD(gainLossUSD)}
                    </span>
                  </div>
                  {activity.events.length === 0 && (
                    <p className="text-gray-400/50 text-xs mt-2">
                      No on-chain events found · NFT manager address may need updating
                    </p>
                  )}
                </div>
              );
            })()}

              {!activityLoading && !activity && (
                <p className="text-sm text-gray-400">Could not load activity data.</p>
              )}
            </div>
          )}

          {/* Position Details */}
          <div className="bg-[#0a2e1a]/60 p-4">
            <h2 className="text-sm font-extrabold text-emerald-300 mb-3">Position Details</h2>
            <div className="space-y-0">
              <div className="flex justify-between py-2 border-b border-emerald-500/10">
                <span className="text-sm text-gray-400">Trading Pair</span>
                <span className="text-sm font-bold text-white">{pos.pair}</span>
              </div>
              <div className="flex justify-between py-2 border-b border-emerald-500/10">
                <span className="text-sm text-gray-400">Protocol</span>
                <span className="text-sm font-bold text-white">{pos.protocol}</span>
              </div>
              <div className="flex justify-between py-2 border-b border-emerald-500/10">
                <span className="text-sm text-gray-400">Blockchain</span>
                <span className="text-sm font-bold text-white">{pos.chain}</span>
              </div>
              <div className="flex justify-between py-2 border-b border-emerald-500/10">
                <span className="text-sm text-gray-400">Status</span>
                <span className={`text-sm font-bold ${pos.status === "In Range" ? "text-emerald-400" : pos.status === "Closed" ? "text-gray-400" : "text-red-400"}`}>
                  {pos.status}
                </span>
              </div>
              {hasFeeTier && (
                <div className="flex justify-between py-2 border-b border-emerald-500/10">
                  <span className="text-sm text-gray-400">Fee Tier</span>
                  <span className="text-sm font-bold text-white">{pos.feeTier}%</span>
                </div>
              )}
              {hasTickRange && (
                <div className="flex justify-between py-2 border-b border-emerald-500/10">
                  <span className="text-sm text-gray-400">Price Range</span>
                  <span className="text-sm font-bold text-white">
                    {tickRangeLabel ?? `${pos.tickLower} → ${pos.tickUpper}`}
                  </span>
                </div>
              )}
              <div className="flex justify-between py-2 border-b border-emerald-500/10">
                <span className="text-sm text-gray-400">
                  Est. Daily Fees
                  <span className="text-gray-400/50 text-xs ml-1">(pool APY × value)</span>
                </span>
                <span className="text-sm font-bold text-white">
                  {pos.apy > 0 ? `$${estimatedDailyFees.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—"}
                </span>
              </div>
              <div className="flex justify-between py-2">
                <span className="text-sm text-gray-400">
                  Est. Monthly Yield
                  <span className="text-gray-400/50 text-xs ml-1">(pool APY × value)</span>
                </span>
                <span className="text-sm font-bold text-emerald-400">
                  {pos.apy > 0 ? `$${estimatedMonthlyYield.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—"}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Row 3: IL Breakdown + Unclaimed Fees */}
        {(ilData || hasFeeBreakdown) && (
          <div className={`grid gap-[2px] mb-1.5 bg-emerald-500/20 rounded-xl overflow-hidden items-start ${ilData && hasFeeBreakdown ? 'grid-cols-2' : 'grid-cols-1'}`}>
            {ilData && (
              <div className="bg-[#0a2e1a]/60 p-4">
                <h2 className="text-sm font-extrabold text-emerald-300 mb-3">IL Breakdown</h2>
                <div className="space-y-0">
                  <div className="flex justify-between py-2 border-b border-emerald-500/10">
                    <span className="text-sm text-gray-400">Entry price (est.)</span>
                    <span className="text-sm font-bold text-white">
                      {formatPrice(ilData.entryPriceUSD)} / {ilData.entryPriceLabel}
                    </span>
                  </div>
                  <div className="flex justify-between py-2 border-b border-emerald-500/10">
                    <span className="text-sm text-gray-400">HODL value</span>
                    <span className="text-sm font-bold text-white">
                      ${ilData.hodlValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                  </div>
                  <div className="flex justify-between py-2 border-b border-emerald-500/10">
                    <span className="text-sm text-gray-400">Current value</span>
                    <span className="text-sm font-bold text-white">
                      ${pos.value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                  </div>
                  <div className="flex justify-between py-2 border-b border-emerald-500/10">
                    <span className="text-sm text-gray-400">IL ($)</span>
                    <span className={`text-sm font-bold ${ilData.ilUSD < 0 ? "text-red-400" : "text-emerald-400"}`}>
                      {ilData.ilUSD < 0 ? "−" : "+"}${Math.abs(ilData.ilUSD).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                  </div>
                  <div className="flex justify-between py-2">
                    <span className="text-sm text-gray-400">IL (%)</span>
                    <span className={`text-sm font-bold ${ilData.ilUSD < 0 ? "text-red-400" : "text-emerald-400"}`}>
                      {ilData.ilUSD >= 0 ? "+" : ""}{ilData.ilPct.toFixed(2)}%
                    </span>
                  </div>
                </div>
                <p className="text-gray-400/40 text-xs mt-3">
                  Estimated from range midpoint · tick {ilData.entryTick} — not your actual entry
                </p>
              </div>
            )}

            {hasFeeBreakdown && (
              <div className="bg-[#0a2e1a]/60 p-4">
                <h2 className="text-sm font-extrabold text-emerald-300 mb-3">Unclaimed Fees</h2>
                <div className="space-y-0">
                  <div className="flex justify-between items-center py-2 border-b border-emerald-500/10">
                    <span className="text-sm text-gray-400">{pos.token0Symbol}</span>
                    <span className="text-sm font-bold text-white">{pos.fees0!.toLocaleString("en-US", { maximumFractionDigits: 6 })}</span>
                  </div>
                  <div className="flex justify-between items-center py-2 border-b border-emerald-500/10">
                    <span className="text-sm text-gray-400">{pos.token1Symbol}</span>
                    <span className="text-sm font-bold text-white">{pos.fees1!.toLocaleString("en-US", { maximumFractionDigits: 6 })}</span>
                  </div>
                  <div className="flex justify-between items-center py-2">
                    <span className="text-sm text-gray-400">Total (USD)</span>
                    <span className="text-sm font-bold text-emerald-400">
                      ${pos.fees.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Row 3a-NEW (EVM only): On-chain P&L + Impermanent Loss using ENTRY prices.
            Built from deposit events with per-event historical prices. The
            non-EVM legacy section below stays untouched for Solana/Sui this phase. */}
        {isEvmActivityProtocol && (() => {
          const cardWrap = (body: React.ReactNode) => (
            <div className="bg-[#0a2e1a]/60 p-4 mb-1.5 rounded-xl">
              <h2 className="text-sm font-extrabold text-emerald-300 mb-3">On-Chain P&amp;L &amp; Impermanent Loss</h2>
              {body}
            </div>
          );

          if (activityLoading) {
            return cardWrap(
              <div className="flex items-center gap-2 text-gray-400 text-sm py-4">
                <div className="w-4 h-4 border border-emerald-400/50 border-t-transparent rounded-full animate-spin" />
                Reconstructing position from on-chain history…
              </div>
            );
          }

          if (!activity) {
            return cardWrap(
              <p className="text-xs text-gray-500">
                Entry data unavailable — P&amp;L cannot be computed.
              </p>
            );
          }

          const result = computePositionPnL({
            currentValue: pos.value,
            unclaimedFeesUSD: pos.fees ?? 0,
            price0: pos.price0 ?? 0,
            price1: pos.price1 ?? 0,
            events: activity.events,
          });

          if (!result.ok) {
            return cardWrap(
              <p className="text-xs text-gray-500">
                Entry data unavailable — no on-chain deposit event found for this position. P&amp;L cannot be computed.
              </p>
            );
          }

          const d = result.data;
          const pnlPositive = d.netPnlUSD >= 0;
          const ilNegative = d.ilUSD < 0;
          const fmtUSD = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

          return cardWrap(
            <>
              {/* Row 1: 5 P&L cards (Initial / Current / Fees Collected / Fees Unclaimed / Net P&L) */}
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-1 mb-2">
                <div className="bg-emerald-500/10 rounded-lg p-3 text-center">
                  <p className="text-xs text-gray-400 mb-1">Initial Value</p>
                  <p className="text-base font-extrabold text-white">${fmtUSD(d.initialValue)}</p>
                  <p className="text-[10px] text-gray-500 mt-0.5">at deposit time</p>
                </div>
                <div className="bg-emerald-500/10 rounded-lg p-3 text-center">
                  <p className="text-xs text-gray-400 mb-1">Current Value</p>
                  <p className="text-base font-extrabold text-white">${fmtUSD(d.currentValue)}</p>
                  <p className="text-[10px] text-gray-500 mt-0.5">live</p>
                </div>
                <div className="bg-emerald-500/10 rounded-lg p-3 text-center">
                  <p className="text-xs text-gray-400 mb-1">Fees Collected</p>
                  <p className="text-base font-extrabold text-emerald-400">${fmtUSD(d.feesCollected)}</p>
                  <p className="text-[10px] text-gray-500 mt-0.5">claimed on-chain</p>
                </div>
                <div className="bg-emerald-500/10 rounded-lg p-3 text-center">
                  <p className="text-xs text-gray-400 mb-1">Fees Unclaimed</p>
                  <p className="text-base font-extrabold text-emerald-300">${fmtUSD(d.feesUnclaimed)}</p>
                  <p className="text-[10px] text-gray-500 mt-0.5">ready to claim</p>
                </div>
                <div className={`rounded-lg p-3 text-center ${pnlPositive ? "bg-emerald-500/20" : "bg-red-500/20"}`}>
                  <p className="text-xs text-gray-400 mb-1">Net P&amp;L</p>
                  <p className={`text-base font-extrabold ${pnlPositive ? "text-emerald-300" : "text-red-300"}`}>
                    {pnlPositive ? "+" : "−"}${fmtUSD(Math.abs(d.netPnlUSD))}
                  </p>
                  <p className={`text-[10px] mt-0.5 ${pnlPositive ? "text-emerald-300/70" : "text-red-300/70"}`}>
                    {pnlPositive ? "+" : ""}{d.netPnlPct.toFixed(2)}%
                  </p>
                </div>
              </div>

              {/* Row 2: Impermanent Loss — HODL value, IL ($/%), fees offset */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-1">
                <div className="bg-emerald-500/10 rounded-lg p-3 text-center">
                  <p className="text-xs text-gray-400 mb-1">HODL Value</p>
                  <p className="text-base font-extrabold text-white">${fmtUSD(d.hodlValue)}</p>
                  <p className="text-[10px] text-gray-500 mt-0.5">if you just held</p>
                </div>
                <div className="bg-emerald-500/10 rounded-lg p-3 text-center">
                  <p className="text-xs text-gray-400 mb-1">Impermanent Loss</p>
                  <p className={`text-base font-extrabold ${ilNegative ? "text-red-400" : "text-emerald-400"}`}>
                    {ilNegative ? "−" : "+"}${fmtUSD(Math.abs(d.ilUSD))}
                  </p>
                  <p className={`text-[10px] mt-0.5 ${ilNegative ? "text-red-400/70" : "text-emerald-400/70"}`}>
                    {d.ilPct.toFixed(2)}%
                  </p>
                </div>
                <div className={`rounded-lg p-3 text-center ${d.feesOffsetIL ? "bg-emerald-500/20" : "bg-red-500/20"}`}>
                  <p className="text-xs text-gray-400 mb-1">Fees vs IL</p>
                  <p className={`text-base font-extrabold ${d.feesOffsetIL ? "text-emerald-300" : "text-red-300"}`}>
                    {d.feesOffsetIL ? "Offset ✓" : "Not yet"}
                  </p>
                  <p className="text-[10px] text-gray-500 mt-0.5">
                    ${fmtUSD(d.feesCollected + d.feesUnclaimed)} fees vs ${fmtUSD(Math.abs(d.ilUSD))} IL
                  </p>
                </div>
              </div>

              <p className="text-gray-400/40 text-xs mt-3">
                Based on {d.depositCount} on-chain deposit{d.depositCount === 1 ? "" : "s"}.
                Entry price ratio {pos.token0Symbol}/{pos.token1Symbol}: {(d.entryPrice0 / (d.entryPrice1 || 1)).toFixed(6)} →
                current ratio: {((pos.price0 ?? 0) / (pos.price1 || 1)).toFixed(6)}.
                IL formula: 2√r/(1+r) − 1 where r = current÷entry price ratio.
              </p>
            </>
          );
        })()}

        {/* Row 3a (legacy, non-EVM only): Impermanent Loss vs HODL using current prices.
            Phase 1 leaves Solana/Sui untouched — they keep this section. */}
        {(() => {
          const supportsIL = isActivityProtocol && !isEvmActivityProtocol;
          if (!supportsIL) return null;
          // Sum all deposit events (multiple add-liquidity tx allowed)
          const deposits = activity?.events.filter((e) => e.type === 'deposit') ?? [];
          const hasDepositData = deposits.length > 0 && (pos.price0 != null || pos.price1 != null);

          let body;
          if (activityLoading) {
            body = (
              <p className="text-xs text-gray-500">Loading deposit history…</p>
            );
          } else if (!hasDepositData) {
            body = (
              <p className="text-xs text-gray-500">
                Deposit data unavailable — cannot compute IL without an on-chain deposit event.
              </p>
            );
          } else {
            const orig0 = deposits.reduce((s, e) => s + e.amount0, 0);
            const orig1 = deposits.reduce((s, e) => s + e.amount1, 0);
            const p0 = pos.price0 ?? 0;
            const p1 = pos.price1 ?? 0;
            const hodlValue = orig0 * p0 + orig1 * p1;
            const lpValue = pos.value;
            const il = lpValue - hodlValue;
            const ilPct = hodlValue > 0 ? (il / hodlValue) * 100 : 0;
            const feesEarned = totalClaimedUSD + (pos.fees || 0);
            const netVsHodl = il + feesEarned;
            const netVsHodlPct = hodlValue > 0 ? (netVsHodl / hodlValue) * 100 : 0;
            const netPositive = netVsHodl >= 0;
            body = (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-1">
                  <div className="bg-emerald-500/10 rounded-lg p-3 text-center">
                    <p className="text-xs text-gray-400 mb-1">HODL Value</p>
                    <p className="text-base font-extrabold text-white">
                      ${hodlValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </p>
                    <p className="text-[10px] text-gray-500 mt-0.5">if you just held</p>
                  </div>
                  <div className="bg-emerald-500/10 rounded-lg p-3 text-center">
                    <p className="text-xs text-gray-400 mb-1">LP Value</p>
                    <p className="text-base font-extrabold text-white">
                      ${lpValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </p>
                    <p className="text-[10px] text-gray-500 mt-0.5">current position</p>
                  </div>
                  <div className="bg-emerald-500/10 rounded-lg p-3 text-center">
                    <p className="text-xs text-gray-400 mb-1">Impermanent Loss</p>
                    <p className={`text-base font-extrabold ${il < 0 ? "text-red-400" : "text-emerald-400"}`}>
                      {il < 0 ? "−" : "+"}${Math.abs(il).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </p>
                    <p className={`text-[10px] mt-0.5 ${il < 0 ? "text-red-400/70" : "text-emerald-400/70"}`}>
                      {il >= 0 ? "+" : ""}{ilPct.toFixed(2)}%
                    </p>
                  </div>
                  <div className="bg-emerald-500/10 rounded-lg p-3 text-center">
                    <p className="text-xs text-gray-400 mb-1">Fees Earned</p>
                    <p className="text-base font-extrabold text-emerald-400">
                      +${feesEarned.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </p>
                    <p className="text-[10px] text-gray-500 mt-0.5">claimed + uncollected</p>
                  </div>
                  <div className={`rounded-lg p-3 text-center ${netPositive ? "bg-emerald-500/20" : "bg-red-500/20"}`}>
                    <p className="text-xs text-gray-400 mb-1">Net vs HODL</p>
                    <p className={`text-base font-extrabold ${netPositive ? "text-emerald-300" : "text-red-300"}`}>
                      {netPositive ? "+" : "−"}${Math.abs(netVsHodl).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </p>
                    <p className={`text-[10px] mt-0.5 ${netPositive ? "text-emerald-300/70" : "text-red-300/70"}`}>
                      {netPositive ? "+" : ""}{netVsHodlPct.toFixed(2)}%
                    </p>
                  </div>
                </div>
                <p className="text-gray-400/40 text-xs mt-3">
                  Based on {deposits.length} on-chain deposit{deposits.length === 1 ? "" : "s"} ({orig0.toLocaleString("en-US", { maximumFractionDigits: 4 })} {pos.token0Symbol} + {orig1.toLocaleString("en-US", { maximumFractionDigits: 4 })} {pos.token1Symbol}) valued at current prices.
                </p>
              </>
            );
          }

          return (
            <div className="bg-[#0a2e1a]/60 p-4 mb-1.5 rounded-xl">
              <h2 className="text-sm font-extrabold text-emerald-300 mb-3">Impermanent Loss</h2>
              {body}
            </div>
          );
        })()}

        {/* Row 3b: Pool Statistics — shown when pool TVL/volume data is available */}
        {(pos.poolTvl != null || pos.pool24hVolume != null) && (
          <div className="bg-[#0a2e1a]/60 p-4 mb-1.5 rounded-xl">
            <h2 className="text-sm font-extrabold text-emerald-300 mb-3">Pool Statistics</h2>
            <div className="grid grid-cols-3 gap-1">
              {pos.poolTvl != null && (
                <div className="bg-emerald-500/10 rounded-lg p-3 text-center">
                  <p className="text-xs text-gray-400 mb-1">Pool TVL</p>
                  <p className="text-lg font-extrabold text-white">
                    ${pos.poolTvl >= 1_000_000
                      ? `${(pos.poolTvl / 1_000_000).toFixed(1)}M`
                      : pos.poolTvl >= 1_000
                      ? `${(pos.poolTvl / 1_000).toFixed(0)}K`
                      : pos.poolTvl.toLocaleString("en-US", { maximumFractionDigits: 0 })}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">all fee tiers</p>
                </div>
              )}
              {pos.pool24hVolume != null && (
                <div className="bg-blue-900/20 rounded-lg p-3 text-center">
                  <p className="text-xs text-gray-400 mb-1">24h Volume</p>
                  <p className="text-lg font-extrabold text-white">
                    ${pos.pool24hVolume >= 1_000_000
                      ? `${(pos.pool24hVolume / 1_000_000).toFixed(1)}M`
                      : pos.pool24hVolume >= 1_000
                      ? `${(pos.pool24hVolume / 1_000).toFixed(0)}K`
                      : pos.pool24hVolume.toLocaleString("en-US", { maximumFractionDigits: 0 })}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">DefiLlama</p>
                </div>
              )}
              {pos.pool24hVolume != null && pos.feeTier != null && (
                <div className="bg-emerald-900/20 rounded-lg p-3 text-center">
                  <p className="text-xs text-gray-400 mb-1">Est. 24h Fees</p>
                  <p className="text-lg font-extrabold text-emerald-300">
                    ${(pos.pool24hVolume * pos.feeTier / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">{pos.feeTier}% fee tier</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Row 3.5: Position P&L (DB-backed) ───────────────────────────── */}
        {(() => {
          const initial = dbPosSnaps.length > 0 ? dbPosSnaps[0].value : 0;
          const current = pos.value;
          const claimed = totalClaimedUSD;
          const netPnl = current + claimed - initial;
          const netPnlPct = initial > 0 ? (netPnl / initial) * 100 : 0;
          const chart = dbPosSnaps.map((s) => ({
            label: new Date(s.timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
            value: s.value,
          }));
          return (
            <div className="bg-[#0a2e1a]/60 p-4 mb-3">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-3">
                <h2 className="text-sm font-extrabold text-emerald-300">Position P&amp;L</h2>
                <div className="flex gap-1">
                  {(["7d", "30d", "90d", "all"] as HistoryRange[]).map((r) => (
                    <button
                      key={r}
                      onClick={() => setPnlRange(r)}
                      className={`px-2 py-0.5 text-[10px] rounded transition-colors ${
                        pnlRange === r
                          ? "bg-emerald-600 text-white"
                          : "bg-emerald-950/40 text-gray-400 hover:text-white"
                      }`}
                    >
                      {r.toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-2 lg:grid-cols-5 gap-2 mb-3">
                <div className="bg-[#0a1a12] rounded p-2">
                  <p className="text-[10px] text-gray-500">Initial Value</p>
                  <p className="text-sm font-bold text-white">
                    ${initial.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </p>
                </div>
                <div className="bg-[#0a1a12] rounded p-2">
                  <p className="text-[10px] text-gray-500">Current Value</p>
                  <p className="text-sm font-bold text-white">
                    ${current.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </p>
                </div>
                <div className="bg-[#0a1a12] rounded p-2">
                  <p className="text-[10px] text-gray-500">Total Fees Claimed</p>
                  <p className="text-sm font-bold text-emerald-300">
                    ${claimed.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </p>
                </div>
                <div className="bg-[#0a1a12] rounded p-2">
                  <p className="text-[10px] text-gray-500">Net P&amp;L</p>
                  <p className={`text-sm font-bold ${netPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                    {netPnl >= 0 ? "+" : ""}${netPnl.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </p>
                </div>
                <div className="bg-[#0a1a12] rounded p-2">
                  <p className="text-[10px] text-gray-500">P&amp;L %</p>
                  <p className={`text-sm font-bold ${netPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                    {netPnlPct >= 0 ? "+" : ""}{netPnlPct.toFixed(2)}%
                  </p>
                </div>
              </div>
              {!dbPosConfigured ? (
                <div className="flex items-center justify-center h-[140px] text-gray-600 text-xs text-center px-4">
                  Database not configured. Set <code className="text-emerald-400">POSTGRES_URL</code> in env to enable position-level P&amp;L tracking.
                </div>
              ) : chart.length >= 2 ? (
                <ResponsiveContainer width="100%" height={200}>
                  <AreaChart data={chart}>
                    <defs>
                      <linearGradient id={`posPnlGrad-${pos.id}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#0f2e1f" />
                    <XAxis dataKey="label" tick={{ fill: "#6b7280", fontSize: 10 }} axisLine={false} tickLine={false} />
                    <YAxis
                      tick={{ fill: "#6b7280", fontSize: 10 }}
                      tickFormatter={(v) => `$${Number(v).toLocaleString("en-US", { maximumFractionDigits: 0 })}`}
                      axisLine={false}
                      tickLine={false}
                      width={55}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "#0a1f17",
                        border: "1px solid rgba(16,185,129,0.2)",
                        borderRadius: "8px",
                        padding: "8px 12px",
                        color: "#FFFFFF",
                        fontSize: "12px",
                      }}
                      formatter={(v: number | undefined) => [
                        `$${Number(v ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
                        "Value",
                      ]}
                      labelStyle={{ color: "#9ca3af" }}
                    />
                    <Area
                      type="monotone"
                      dataKey="value"
                      stroke="#10b981"
                      strokeWidth={2}
                      fill={`url(#posPnlGrad-${pos.id})`}
                      dot={false}
                      activeDot={{ r: 4, fill: "#10b981" }}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex items-center justify-center h-[140px] text-gray-600 text-xs text-center px-4">
                  Tracking started. P&amp;L data will appear after the next snapshot.
                </div>
              )}
            </div>
          );
        })()}

        {/* Row 4: Actual Performance — full width */}
        {isActivityProtocol && (
          <div className="bg-[#0a2e1a]/60 p-4 mb-3">
            <h2 className="text-sm font-extrabold text-emerald-300 mb-3">Actual Performance</h2>
            <p className="text-xs text-gray-400/60 mb-4">Based on actual claimed fees · not pool APY estimate</p>

            {activityLoading && (
              <div className="flex items-center gap-1 text-gray-400 text-sm py-4">
                <div className="w-4 h-4 border border-emerald-400/50 border-t-transparent rounded-full animate-spin" />
                Calculating…
              </div>
            )}

            {!activityLoading && activity && (() => {
              const feeClaims = activity.events.filter(e => e.type === 'fee_claim' || e.type === 'reward_claim');
              const deposits = activity.events.filter(e => e.type === 'deposit');

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

              const actualAPR = daysActive >= 1 && pos.value > 0
                ? (claimedUSD / pos.value) / (daysActive / 365) * 100
                : null;
              const estimatedAPR = pos.apy > 0 ? pos.apy : null;
              const actualDailyIncome = daysActive >= 1 ? claimedUSD / daysActive : null;
              const feeIncomePct = pos.value > 0 ? (lifetimeUSD / pos.value) * 100 : 0;

              const daysLabel = daysActive >= 1
                ? `${Math.floor(daysActive)}d`
                : (firstTs > 0 ? '<1d' : '—');

              const fmtUSD = (n: number) =>
                `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

              return (
                <div className="space-y-1">
                  {/* Row 1: TOTAL CLAIMED | TOTAL UNCOLLECTED | TOTAL LIFETIME */}
                  <div className="grid grid-cols-3 gap-1">
                    <div className="bg-emerald-500/10 rounded-lg p-3 text-center">
                      <p className="text-xs text-gray-400 mb-1">Total Claimed</p>
                      <p className="text-xl font-extrabold text-emerald-400">{fmtUSD(claimedUSD)}</p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {feeClaims.length > 0
                          ? `${feeClaims.length} collection${feeClaims.length !== 1 ? 's' : ''}`
                          : 'no claims yet'}
                      </p>
                    </div>
                    <div className="bg-emerald-500/10 rounded-lg p-3 text-center">
                      <p className="text-xs text-gray-400 mb-1">Total Uncollected</p>
                      <p className="text-xl font-extrabold text-white">{fmtUSD(uncollectedUSD)}</p>
                      <p className="text-xs text-gray-500 mt-0.5">pending</p>
                    </div>
                    <div className="bg-emerald-500/10 rounded-lg p-3 text-center">
                      <p className="text-xs text-gray-400 mb-1">Total Lifetime</p>
                      <p className="text-xl font-extrabold text-white">{fmtUSD(lifetimeUSD)}</p>
                      <p className="text-xs text-gray-500 mt-0.5">claimed + pending</p>
                    </div>
                  </div>

                  {/* Row 2: ACTUAL APR | ESTIMATED APR | TRACKING AGE */}
                  <div className="grid grid-cols-3 gap-1">
                    <div className="bg-emerald-900/20 rounded-lg p-3 text-center">
                      <p className="text-xs text-gray-400 mb-1">Actual APR</p>
                      {actualAPR != null
                        ? <p className="text-xl font-extrabold text-emerald-400">~{actualAPR.toFixed(1)}%</p>
                        : <p className="text-xl font-extrabold text-white/30">{feeClaims.length === 0 ? 'No claims' : '<1d'}</p>
                      }
                      <p className="text-xs text-gray-500 mt-0.5">from real claims</p>
                    </div>
                    <div className="bg-blue-900/20 rounded-lg p-3 text-center">
                      <p className="text-xs text-gray-400 mb-1">Estimated APR</p>
                      {estimatedAPR != null
                        ? <p className="text-xl font-extrabold text-blue-300">~{estimatedAPR.toFixed(1)}%</p>
                        : <p className="text-xl font-extrabold text-white/30">—</p>
                      }
                      <p className="text-xs text-gray-500 mt-0.5">pool APY</p>
                    </div>
                    <div className="bg-emerald-900/10 rounded-lg p-3 text-center">
                      <p className="text-xs text-gray-400 mb-1">Tracking Age</p>
                      <p className="text-xl font-extrabold text-white">{daysLabel}</p>
                      {firstTs > 0 && (
                        <p className="text-xs text-gray-500 mt-0.5">
                          since {new Date(firstTs * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })}
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Row 3: ACTUAL DAILY INCOME | FEE INCOME % */}
                  <div className="grid grid-cols-2 gap-1">
                    <div className="bg-emerald-500/10 rounded-lg p-3 text-center">
                      <p className="text-xs text-gray-400 mb-1">Actual Daily Income</p>
                      {actualDailyIncome != null
                        ? (
                          <p className="text-lg font-bold text-white">
                            {fmtUSD(actualDailyIncome)}<span className="text-gray-400 text-sm font-normal">/day</span>
                          </p>
                        )
                        : <p className="text-lg font-bold text-white/30">—</p>
                      }
                    </div>
                    <div className="bg-emerald-500/10 rounded-lg p-3 text-center">
                      <p className="text-xs text-gray-400 mb-1">Fee Income (% of position)</p>
                      <p className="text-lg font-bold text-white">{feeIncomePct.toFixed(3)}%</p>
                    </div>
                  </div>
                </div>
              );
            })()}

            {!activityLoading && !activity && (
              <p className="text-sm text-gray-400">Could not load activity data.</p>
            )}
          </div>
        )}

        {/* Row 4b: Fee Claims Log — full width */}
        {isActivityProtocol && (
          <div className="bg-[#0a2e1a]/60 p-4 mb-3">
            <h2 className="text-sm font-extrabold text-yellow-400 mb-1">📋 FEE CLAIMS LOG</h2>
            <p className="text-xs text-gray-400/60 mb-4">Collected fees only · deposits and withdrawals shown in Activity History below</p>

            {activityLoading && (
              <div className="flex items-center gap-1 text-gray-400 text-sm py-4">
                <div className="w-4 h-4 border border-emerald-400/50 border-t-transparent rounded-full animate-spin" />
                Scanning blockchain for fee history…
              </div>
            )}

            {!activityLoading && activity && (() => {
              const sym0 = pos.token0Symbol ?? 'Token0';
              const sym1 = pos.token1Symbol ?? 'Token1';
              const feeClaims = activity.events.filter(e => e.type === 'fee_claim' || e.type === 'reward_claim');

              const txUrl = (hash: string) => {
                if (pos.protocol === 'Bluefin') return `https://suivision.xyz/txblock/${hash}`;
                if (pos.protocol === 'Orca' || pos.protocol === 'Raydium') return `https://solscan.io/tx/${hash}`;
                if (HYPEREVM_PROTOCOLS.has(pos.protocol)) return `https://hyperevmscan.io/tx/${hash}`;
                if (pos.chain === 'Arbitrum') return `https://arbiscan.io/tx/${hash}`;
                if (pos.chain === 'Polygon')  return `https://polygonscan.com/tx/${hash}`;
                if (pos.chain === 'Optimism') return `https://optimistic.etherscan.io/tx/${hash}`;
                if (pos.chain === 'Ethereum') return `https://etherscan.io/tx/${hash}`;
                return `https://basescan.org/tx/${hash}`;
              };
              const fmtDate = (ts: number) => {
                if (!ts) return '—';
                const d = new Date(ts * 1000);
                return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
              };
              const fmtAmt = (n: number) =>
                n === 0 ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: 6, minimumFractionDigits: 0 });
              const fmtUSD = (n: number | null) =>
                n == null ? '—' : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
              const shortHash = (h: string) => `${h.slice(0, 6)}…${h.slice(-4)}`;

              const totalClaimed = feeClaims.reduce((sum, e) => {
                if (e.usdAtTime != null) return sum + e.usdAtTime;
                return sum + e.amount0 * (pos.price0 ?? 0) + e.amount1 * (pos.price1 ?? 0);
              }, 0);

              if (feeClaims.length === 0) {
                return (
                  <p className="text-sm text-gray-400 py-2">
                    No fee claims detected yet. Claims will appear here after you collect fees.
                  </p>
                );
              }

              return (
                <div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-xs text-gray-400 border-b border-emerald-500/10">
                          <th className="text-left py-2 pr-4 font-normal">Date</th>
                          <th className="text-left py-2 pr-4 font-normal">Type</th>
                          <th className="text-right py-2 pr-4 font-normal">{sym0}</th>
                          <th className="text-right py-2 pr-4 font-normal">{sym1}</th>
                          <th className="text-right py-2 pr-4 font-normal">Total USD</th>
                          <th className="text-right py-2 font-normal">Tx</th>
                        </tr>
                      </thead>
                      <tbody>
                        {feeClaims.map((ev, i) => (
                          <tr key={i} className="border-b border-emerald-500/10 hover:bg-[rgba(6,78,59,0.2)]">
                            <td className="py-2 pr-4 text-xs text-gray-400 whitespace-nowrap">{fmtDate(ev.timestamp)}</td>
                            <td className="py-2 pr-4">
                              <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                                ev.type === 'reward_claim'
                                  ? 'bg-blue-900/40 text-blue-300'
                                  : 'bg-emerald-900/40 text-emerald-300'
                              }`}>
                                {ev.type === 'reward_claim' ? 'Reward' : 'Fee Claim'}
                              </span>
                            </td>
                            <td className="py-2 pr-4 text-right font-mono text-xs text-white">
                              {ev.type === 'reward_claim'
                                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                ? `${fmtAmt(ev.amount0)} ${(ev as any).rewardSymbol ?? ''}`
                                : fmtAmt(ev.amount0)}
                            </td>
                            <td className="py-2 pr-4 text-right font-mono text-xs text-white">
                              {ev.type === 'reward_claim' ? '—' : fmtAmt(ev.amount1)}
                            </td>
                            <td className="py-2 pr-4 text-right text-xs font-bold text-emerald-300">{fmtUSD(ev.usdAtTime)}</td>
                            <td className="py-2 text-right">
                              <a href={txUrl(ev.txHash)} target="_blank" rel="noopener noreferrer"
                                className="text-emerald-400 hover:text-emerald-300 font-mono text-xs">
                                {shortHash(ev.txHash)}
                              </a>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="mt-3 pt-3 border-t border-emerald-500/10 flex justify-between items-center">
                    <span className="text-xs text-gray-400">
                      {feeClaims.length} collection{feeClaims.length !== 1 ? 's' : ''}
                    </span>
                    <span className="text-sm font-bold text-emerald-400">
                      Total Claimed: {fmtUSD(totalClaimed)}
                    </span>
                  </div>
                </div>
              );
            })()}

            {!activityLoading && !activity && (
              <p className="text-sm text-gray-400">Could not load fee claim data.</p>
            )}
          </div>
        )}

        {/* Row 5: Activity History — full width */}
        {isActivityProtocol && (
          <div className="bg-[#0a2e1a]/60 p-4 mb-6">
            <h2 className="text-sm font-extrabold text-emerald-300 mb-3">Activity History</h2>

            {activityLoading && (
              <div className="flex items-center gap-1 text-gray-400 text-sm py-4">
                <div className="w-4 h-4 border border-emerald-400/50 border-t-transparent rounded-full animate-spin" />
                Scanning on-chain history…
              </div>
            )}

            {!activityLoading && activity && activity.events.length === 0 && (
              <p className="text-sm text-gray-400">No on-chain events found for this position.</p>
            )}

            {!activityLoading && activity && activity.events.length > 0 && (() => {
              const sym0 = pos.token0Symbol ?? 'Token0';
              const sym1 = pos.token1Symbol ?? 'Token1';
              const ACTION_LABELS: Record<string, string> = {
                deposit: 'Deposit',
                withdrawal: 'Withdrawal',
                fee_claim: 'Fee Claim',
                reward_claim: 'Reward',
              };
              const ACTION_COLORS: Record<string, string> = {
                deposit: 'text-blue-400',
                withdrawal: 'text-red-400',
                fee_claim: 'text-emerald-400',
                reward_claim: 'text-purple-400',
              };
              const txUrl = (hash: string) => {
                if (pos.protocol === 'Bluefin') return `https://suivision.xyz/txblock/${hash}`;
                if (pos.protocol === 'Orca' || pos.protocol === 'Raydium') return `https://solscan.io/tx/${hash}`;
                if (HYPEREVM_PROTOCOLS.has(pos.protocol)) return `https://hyperevmscan.io/tx/${hash}`;
                if (pos.chain === 'Arbitrum') return `https://arbiscan.io/tx/${hash}`;
                if (pos.chain === 'Polygon')  return `https://polygonscan.com/tx/${hash}`;
                if (pos.chain === 'Optimism') return `https://optimistic.etherscan.io/tx/${hash}`;
                if (pos.chain === 'Ethereum') return `https://etherscan.io/tx/${hash}`;
                return `https://basescan.org/tx/${hash}`;
              };
              const fmtDate = (ts: number) => {
                if (!ts) return '—';
                const d = new Date(ts * 1000);
                return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
              };
              const fmtAmt = (n: number) =>
                n === 0 ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: 6, minimumFractionDigits: 0 });
              const fmtUSD = (n: number | null) =>
                n == null ? '—' : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
              const shortHash = (h: string) => `${h.slice(0, 6)}…${h.slice(-4)}`;

              return (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-xs text-gray-400 border-b border-emerald-500/10">
                        <th className="text-left py-2 pr-4 font-normal">Date</th>
                        <th className="text-left py-2 pr-4 font-normal">Action</th>
                        <th className="text-right py-2 pr-4 font-normal">{sym0}</th>
                        <th className="text-right py-2 pr-4 font-normal">{sym1}</th>
                        <th className="text-right py-2 pr-4 font-normal">USD</th>
                        <th className="text-right py-2 pr-4 font-normal">Cumul. Fees</th>
                        <th className="text-right py-2 font-normal">Tx</th>
                      </tr>
                    </thead>
                    <tbody>
                      {activity.events.map((ev, i) => (
                        <tr key={i} className="border-b border-emerald-500/10 hover:bg-[rgba(6,78,59,0.2)]">
                          <td className="py-2 pr-4 text-sm text-gray-400 whitespace-nowrap">{fmtDate(ev.timestamp)}</td>
                          <td className={`py-2 pr-4 text-sm font-bold ${ACTION_COLORS[ev.type] ?? 'text-gray-400'}`}>
                            {ACTION_LABELS[ev.type] ?? ev.type}
                          </td>
                          <td className="py-2 pr-4 text-right font-mono text-sm font-bold text-white">
                            {ev.type === 'reward_claim'
                              ? <span>{fmtAmt(ev.amount0)}<span className="text-gray-400 font-normal text-xs ml-1">{ev.rewardSymbol}</span></span>
                              : fmtAmt(ev.amount0)}
                          </td>
                          <td className="py-2 pr-4 text-right font-mono text-sm font-bold text-white">
                            {ev.type === 'reward_claim' ? '—' : fmtAmt(ev.amount1)}
                          </td>
                          <td className="py-2 pr-4 text-right text-sm font-bold text-white">{fmtUSD(ev.usdAtTime)}</td>
                          <td className="py-2 pr-4 text-right text-sm text-gray-400">
                            {(ev.type === 'fee_claim' || ev.type === 'reward_claim') ? fmtUSD(ev.cumulativeFeeUSD) : '—'}
                          </td>
                          <td className="py-2 text-right">
                            <a href={txUrl(ev.txHash)} target="_blank" rel="noopener noreferrer"
                              className="text-emerald-400 hover:text-emerald-300 font-mono text-xs">
                              {shortHash(ev.txHash)}
                            </a>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            })()}

            {!activityLoading && !activity && (
              <p className="text-sm text-gray-400">Could not load activity data.</p>
            )}

            {/* Solana / Sui scanning note */}
            {(pos.protocol === 'Orca' || pos.protocol === 'Raydium') && (
              <p className="text-xs text-gray-500 mt-3 border-t border-emerald-500/10 pt-3">
                Note: Fully closed Solana positions have their NFT burned on-chain and cannot be recovered.
                Fee snapshots are saved locally each visit to track future claims.
              </p>
            )}
            {(pos.protocol === 'Cetus' || pos.protocol === 'Bluefin' || pos.protocol === 'Momentum') && (
              <p className="text-xs text-gray-500 mt-3 border-t border-emerald-500/10 pt-3">
                Note: Fully closed Sui positions have their object destroyed on-chain and cannot be recovered.
                Fee snapshots are saved locally each visit to track future claims.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
