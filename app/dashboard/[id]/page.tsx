"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import { useState, useEffect } from "react";
import Navbar from "../../Navbar";
import { usePositions } from "../../contexts/PositionsContext";
import { usePositionActivity } from "../../hooks/usePositionActivity";
import { useBluefinActivity } from "../../hooks/useBluefinActivity";

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

  // Unified activity data — pick source based on protocol
  const activity = pos?.protocol === 'Aerodrome' ? aeroActivity
    : pos?.protocol === 'Bluefin' ? bluefinActivity
    : null;
  const activityLoading = pos?.protocol === 'Aerodrome' ? aeroActivityLoading
    : pos?.protocol === 'Bluefin' ? bluefinActivityLoading
    : false;
  const isActivityProtocol = pos?.protocol === 'Aerodrome' || pos?.protocol === 'Bluefin';

  if (!mounted || isLoading) {
    return (
      <div className="p-8 pt-24 bg-black text-white min-h-screen">
        <Navbar />
        <div className="max-w-4xl mx-auto">
          <Link href="/dashboard" className="text-blue-400 hover:text-blue-300 text-sm mb-6 inline-block">
            &larr; Back to Dashboard
          </Link>
          <div className="flex items-center justify-center py-24">
            <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          </div>
        </div>
      </div>
    );
  }

  if (!pos) {
    return (
      <div className="p-8 pt-24 bg-black text-white min-h-screen">
        <Navbar />
        <div className="max-w-4xl mx-auto">
          <Link href="/dashboard" className="text-blue-400 hover:text-blue-300 text-sm mb-6 inline-block">
            &larr; Back to Dashboard
          </Link>
          <div className="flex items-center justify-center py-24">
            <div className="text-center">
              <h1 className="text-4xl font-bold mb-4">Position Not Found</h1>
              <p className="text-gray-400">This position doesn&apos;t exist or your wallet isn&apos;t connected.</p>
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

  const hasTokenBreakdown = pos.amount0 != null && pos.amount1 != null;
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

  return (
    <div className="p-8 pt-24 bg-black text-white min-h-screen">
      <Navbar />
      <div className="max-w-4xl mx-auto">
        <Link href="/dashboard" className="text-blue-400 hover:text-blue-300 text-sm mb-6 inline-block">
          &larr; Back to Dashboard
        </Link>

        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-4xl font-bold">{pos.pair}</h1>
            <p className="text-gray-400 mt-1">{pos.protocol} &bull; {pos.chain}</p>
          </div>
          <span className={`px-4 py-2 rounded-full text-sm font-medium ${
            pos.status === "In Range"
              ? "bg-green-500/10 text-green-500"
              : pos.status === "Closed"
              ? "bg-gray-500/10 text-gray-400"
              : "bg-red-500/10 text-red-500"
          }`}>
            {pos.status}
          </span>
        </div>

        {/* Top Stats */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-6">
            <p className="text-gray-400 text-sm mb-2">Position Value</p>
            <p className="text-3xl font-bold">
              ${pos.value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </p>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-6">
            <p className="text-gray-400 text-sm mb-2">Current APY</p>
            <p className="text-3xl font-bold text-green-500">{pos.apy}%</p>
            {pos.apy > 0 && (
              <p className="text-gray-500 text-xs mt-1">
                {(pos.apy / 12).toFixed(2)}% /mo &middot; {(pos.apy / 365).toFixed(3)}% /day
              </p>
            )}
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-6">
            <p className="text-gray-400 text-sm mb-2">Fees Earned</p>
            <p className="text-3xl font-bold">
              ${pos.fees.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </p>
          </div>
        </div>

        {/* Token Breakdown */}
        {hasTokenBreakdown && (
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 mb-6">
            <h2 className="text-xl font-bold mb-4">Token Amounts</h2>
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-gray-800/50 rounded-lg p-4">
                <p className="text-gray-400 text-sm mb-1">{pos.token0Symbol}</p>
                <p className="text-xl font-semibold">{pos.amount0!.toLocaleString("en-US", { maximumFractionDigits: 6 })}</p>
              </div>
              <div className="bg-gray-800/50 rounded-lg p-4">
                <p className="text-gray-400 text-sm mb-1">{pos.token1Symbol}</p>
                <p className="text-xl font-semibold">{pos.amount1!.toLocaleString("en-US", { maximumFractionDigits: 6 })}</p>
              </div>
            </div>
          </div>
        )}

        {/* Fee Breakdown */}
        {hasFeeBreakdown && (
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 mb-6">
            <h2 className="text-xl font-bold mb-4">Fee Breakdown</h2>
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-gray-800/50 rounded-lg p-4">
                <p className="text-gray-400 text-sm mb-1">{pos.token0Symbol} Fees</p>
                <p className="text-xl font-semibold">{pos.fees0!.toLocaleString("en-US", { maximumFractionDigits: 6 })}</p>
              </div>
              <div className="bg-gray-800/50 rounded-lg p-4">
                <p className="text-gray-400 text-sm mb-1">{pos.token1Symbol} Fees</p>
                <p className="text-xl font-semibold">{pos.fees1!.toLocaleString("en-US", { maximumFractionDigits: 6 })}</p>
              </div>
            </div>
          </div>
        )}

        {/* Position Details */}
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 mb-6">
          <h2 className="text-xl font-bold mb-4">Position Details</h2>
          <div className="space-y-0">
            <div className="flex justify-between py-3 border-b border-gray-800">
              <span className="text-gray-400">Trading Pair</span>
              <span className="font-semibold">{pos.pair}</span>
            </div>
            <div className="flex justify-between py-3 border-b border-gray-800">
              <span className="text-gray-400">Protocol</span>
              <span className="font-semibold">{pos.protocol}</span>
            </div>
            <div className="flex justify-between py-3 border-b border-gray-800">
              <span className="text-gray-400">Blockchain</span>
              <span className="font-semibold">{pos.chain}</span>
            </div>
            <div className="flex justify-between py-3 border-b border-gray-800">
              <span className="text-gray-400">Status</span>
              <span className={pos.status === "In Range" ? "text-green-500 font-semibold" : pos.status === "Closed" ? "text-gray-400 font-semibold" : "text-red-500 font-semibold"}>
                {pos.status}
              </span>
            </div>
            {hasFeeTier && (
              <div className="flex justify-between py-3 border-b border-gray-800">
                <span className="text-gray-400">Fee Tier</span>
                <span className="font-semibold">{pos.feeTier}%</span>
              </div>
            )}
            {hasTickRange && (
              <div className="flex justify-between py-3 border-b border-gray-800">
                <span className="text-gray-400">Price Range</span>
                <span className="font-semibold">
                  {tickRangeLabel ?? `${pos.tickLower} → ${pos.tickUpper}`}
                </span>
              </div>
            )}
            <div className="flex justify-between py-3 border-b border-gray-800">
              <span className="text-gray-400">
                Est. Daily Fees
                <span className="text-gray-600 text-xs ml-1">(pool APY × value)</span>
              </span>
              <span className="font-semibold">
                {pos.apy > 0
                  ? `$${estimatedDailyFees.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                  : "—"}
              </span>
            </div>
            <div className="flex justify-between py-3">
              <span className="text-gray-400">
                Est. Monthly Yield
                <span className="text-gray-600 text-xs ml-1">(pool APY × value)</span>
              </span>
              <span className="font-semibold text-green-500">
                {pos.apy > 0
                  ? `$${estimatedMonthlyYield.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                  : "—"}
              </span>
            </div>
          </div>
        </div>

        {/* Impermanent Loss */}
        {ilData && (
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 mb-6">
            <h2 className="text-xl font-bold mb-4">Impermanent Loss</h2>
            <div className="space-y-0">
              <div className="flex justify-between py-3 border-b border-gray-800">
                <span className="text-gray-400">Entry price (est.)</span>
                <span className="font-semibold">
                  {formatPrice(ilData.entryPriceUSD)} / {ilData.entryPriceLabel}
                </span>
              </div>
              <div className="flex justify-between py-3 border-b border-gray-800">
                <span className="text-gray-400">HODL value</span>
                <span className="font-semibold">
                  ${ilData.hodlValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </div>
              <div className="flex justify-between py-3 border-b border-gray-800">
                <span className="text-gray-400">Current value</span>
                <span className="font-semibold">
                  ${pos.value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </div>
              <div className="flex justify-between py-3">
                <span className="text-gray-400">IL</span>
                <span className={`font-semibold ${ilData.ilUSD < 0 ? "text-red-400" : "text-green-400"}`}>
                  {ilData.ilUSD < 0 ? "−" : "+"}$
                  {Math.abs(ilData.ilUSD).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  {" "}({ilData.ilUSD >= 0 ? "+" : ""}{ilData.ilPct.toFixed(2)}%)
                </span>
              </div>
            </div>
            <p className="text-gray-600 text-xs mt-3">
              Estimated from range midpoint · tick {ilData.entryTick} — not your actual entry
            </p>
          </div>
        )}

        {/* Assets: Current vs Invested (Aerodrome + Bluefin) */}
        {isActivityProtocol && (
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 mb-6">
            <h2 className="text-xl font-bold mb-4">Assets</h2>

            {activityLoading && (
              <div className="flex items-center gap-2 text-gray-400 text-sm py-4">
                <div className="w-4 h-4 border border-gray-500 border-t-transparent rounded-full animate-spin" />
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
                  <div className="grid grid-cols-4 gap-2 text-xs text-gray-500 mb-2 px-1">
                    <span></span>
                    <span className="text-right">{sym0}</span>
                    <span className="text-right">{sym1}</span>
                    <span className="text-right">USD</span>
                  </div>
                  {/* Invested row */}
                  <div className="grid grid-cols-4 gap-2 py-3 border-b border-gray-800 px-1 items-center">
                    <span className="text-gray-400 text-sm">Invested</span>
                    <span className="text-right font-mono text-sm">{fmtAmt(inv0)}</span>
                    <span className="text-right font-mono text-sm">{fmtAmt(inv1)}</span>
                    <span className="text-right text-sm font-semibold">{fmtUSD(investedUSD)}</span>
                  </div>
                  {/* Current row */}
                  <div className="grid grid-cols-4 gap-2 py-3 border-b border-gray-800 px-1 items-center">
                    <span className="text-gray-400 text-sm">Current</span>
                    <span className="text-right font-mono text-sm">{fmtAmt(cur0)}</span>
                    <span className="text-right font-mono text-sm">{fmtAmt(cur1)}</span>
                    <span className="text-right text-sm font-semibold">{fmtUSD(currentUSD)}</span>
                  </div>
                  {/* Gain/Loss row */}
                  <div className="grid grid-cols-4 gap-2 py-3 px-1 items-center">
                    <span className="text-gray-400 text-sm">Gain / Loss</span>
                    <span className={`text-right font-mono text-sm ${gainLoss0 >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {sign(gainLoss0)}{fmtAmt(Math.abs(gainLoss0))}
                    </span>
                    <span className={`text-right font-mono text-sm ${gainLoss1 >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {sign(gainLoss1)}{fmtAmt(Math.abs(gainLoss1))}
                    </span>
                    <span className={`text-right text-sm font-semibold ${gainLossUSD >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {sign(gainLossUSD)}{fmtUSD(gainLossUSD)}
                    </span>
                  </div>
                  {activity.events.length === 0 && (
                    <p className="text-gray-600 text-xs mt-2">
                      No on-chain events found · NFT manager address may need updating
                    </p>
                  )}
                </div>
              );
            })()}

            {!activityLoading && !activity && (
              <p className="text-gray-500 text-sm">Could not load activity data.</p>
            )}
          </div>
        )}

        {/* Activity History Table (Aerodrome + Bluefin) */}
        {isActivityProtocol && (
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 mb-6">
            <h2 className="text-xl font-bold mb-4">Activity History</h2>

            {activityLoading && (
              <div className="flex items-center gap-2 text-gray-400 text-sm py-4">
                <div className="w-4 h-4 border border-gray-500 border-t-transparent rounded-full animate-spin" />
                Loading activity…
              </div>
            )}

            {!activityLoading && activity && activity.events.length === 0 && (
              <p className="text-gray-500 text-sm">No on-chain events found for this position.</p>
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
                withdrawal: 'text-orange-400',
                fee_claim: 'text-green-400',
                reward_claim: 'text-purple-400',
              };

              const txUrl = (hash: string) =>
                pos.protocol === 'Bluefin'
                  ? `https://suivision.xyz/txblock/${hash}`
                  : `https://basescan.org/tx/${hash}`;

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
                      <tr className="text-gray-500 text-xs border-b border-gray-800">
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
                        <tr key={i} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                          <td className="py-3 pr-4 text-gray-400 whitespace-nowrap">{fmtDate(ev.timestamp)}</td>
                          <td className={`py-3 pr-4 font-medium ${ACTION_COLORS[ev.type] ?? 'text-gray-300'}`}>
                            {ACTION_LABELS[ev.type] ?? ev.type}
                          </td>
                          <td className="py-3 pr-4 text-right font-mono text-gray-300">
                            {ev.type === 'reward_claim'
                              ? <span>{fmtAmt(ev.amount0)}<span className="text-gray-500 text-xs ml-1">{ev.rewardSymbol}</span></span>
                              : fmtAmt(ev.amount0)}
                          </td>
                          <td className="py-3 pr-4 text-right font-mono text-gray-300">
                            {ev.type === 'reward_claim' ? '—' : fmtAmt(ev.amount1)}
                          </td>
                          <td className="py-3 pr-4 text-right text-gray-300">{fmtUSD(ev.usdAtTime)}</td>
                          <td className="py-3 pr-4 text-right text-gray-500">
                            {(ev.type === 'fee_claim' || ev.type === 'reward_claim') ? fmtUSD(ev.cumulativeFeeUSD) : '—'}
                          </td>
                          <td className="py-3 text-right">
                            <a
                              href={txUrl(ev.txHash)}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-400 hover:text-blue-300 font-mono text-xs"
                            >
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
              <p className="text-gray-500 text-sm">Could not load activity data.</p>
            )}
          </div>
        )}

        {/* Actual Performance — Feature 9 (Aerodrome + Bluefin) */}
        {isActivityProtocol && (
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 mb-6">
            <h2 className="text-xl font-bold mb-1">Actual Performance</h2>
            <p className="text-gray-600 text-xs mb-4">Based on actual claimed fees · not pool APY estimate</p>

            {activityLoading && (
              <div className="flex items-center gap-2 text-gray-400 text-sm py-4">
                <div className="w-4 h-4 border border-gray-500 border-t-transparent rounded-full animate-spin" />
                Calculating…
              </div>
            )}

            {!activityLoading && activity && (() => {
              const feeClaims = activity.events.filter(e => e.type === 'fee_claim' || e.type === 'reward_claim');
              const deposits = activity.events.filter(e => e.type === 'deposit');

              // Total fees in USD — prefer usdAtTime, fall back to current prices
              const totalFeesUSD = feeClaims.reduce((sum, e) => {
                if (e.usdAtTime != null) return sum + e.usdAtTime;
                const p0 = pos.price0 ?? 0;
                const p1 = pos.price1 ?? 0;
                return sum + e.amount0 * p0 + e.amount1 * p1;
              }, 0);

              // First deposit timestamp (events are newest-first, so take last deposit)
              const firstDeposit = deposits.length > 0
                ? deposits[deposits.length - 1]
                : null;
              const firstTs = firstDeposit?.timestamp ?? 0;
              const nowTs = Math.floor(Date.now() / 1000);
              const daysActive = firstTs > 0 ? (nowTs - firstTs) / 86400 : 0;

              const fmtUSD = (n: number) =>
                `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

              if (feeClaims.length === 0) {
                return (
                  <p className="text-gray-500 text-sm">No fees claimed yet.</p>
                );
              }

              if (daysActive < 1) {
                return (
                  <div className="space-y-0">
                    <div className="flex justify-between py-3 border-b border-gray-800">
                      <span className="text-gray-400">Total fees earned</span>
                      <span className="font-semibold text-green-400">{fmtUSD(totalFeesUSD)}</span>
                    </div>
                    <div className="flex justify-between py-3">
                      <span className="text-gray-400">Position active</span>
                      <span className="font-semibold">&lt; 1 day</span>
                    </div>
                    <p className="text-gray-600 text-xs mt-2">APR not shown — position active less than 1 day</p>
                  </div>
                );
              }

              const dailyFees = totalFeesUSD / daysActive;
              const weeklyFees = dailyFees * 7;
              const monthlyFees = dailyFees * 30;
              const yearlyFees = dailyFees * 365;
              const aprYearly = pos.value > 0
                ? (totalFeesUSD / pos.value) / (daysActive / 365) * 100
                : 0;
              const aprMonthly = aprYearly / 12;
              const aprWeekly = aprYearly / 52;

              const daysLabel = daysActive >= 1
                ? `${Math.floor(daysActive)} day${Math.floor(daysActive) !== 1 ? 's' : ''}`
                : '< 1 day';

              return (
                <div>
                  <div className="space-y-0">
                    <div className="flex justify-between py-3 border-b border-gray-800">
                      <span className="text-gray-400">Total fees earned</span>
                      <span className="font-semibold text-green-400">{fmtUSD(totalFeesUSD)}</span>
                    </div>
                    <div className="flex justify-between py-3 border-b border-gray-800">
                      <span className="text-gray-400">Position active</span>
                      <span className="font-semibold">{daysLabel}</span>
                    </div>
                    <div className="flex justify-between py-3 border-b border-gray-800">
                      <span className="text-gray-400">Realized APR</span>
                      <div className="text-right">
                        <span className="font-semibold text-green-400">~{aprYearly.toLocaleString('en-US', { maximumFractionDigits: 1 })}% / yr</span>
                        <span className="text-gray-500 text-xs mx-2">·</span>
                        <span className="text-green-400/70 text-sm">~{aprMonthly.toLocaleString('en-US', { maximumFractionDigits: 2 })}% / mo</span>
                        <span className="text-gray-500 text-xs mx-2">·</span>
                        <span className="text-green-400/50 text-sm">~{aprWeekly.toLocaleString('en-US', { maximumFractionDigits: 2 })}% / wk</span>
                      </div>
                    </div>
                  </div>
                  <div className="mt-4 grid grid-cols-4 gap-3">
                    <div className="bg-gray-800/50 rounded-lg p-3 text-center">
                      <p className="text-gray-500 text-xs mb-1">Daily</p>
                      <p className="font-semibold text-sm">{fmtUSD(dailyFees)}</p>
                    </div>
                    <div className="bg-gray-800/50 rounded-lg p-3 text-center">
                      <p className="text-gray-500 text-xs mb-1">Weekly</p>
                      <p className="font-semibold text-sm">{fmtUSD(weeklyFees)}</p>
                    </div>
                    <div className="bg-gray-800/50 rounded-lg p-3 text-center">
                      <p className="text-gray-500 text-xs mb-1">Monthly</p>
                      <p className="font-semibold text-sm">{fmtUSD(monthlyFees)}</p>
                    </div>
                    <div className="bg-gray-800/50 rounded-lg p-3 text-center">
                      <p className="text-gray-500 text-xs mb-1">Yearly</p>
                      <p className="font-semibold text-sm">{fmtUSD(yearlyFees)}</p>
                    </div>
                  </div>
                </div>
              );
            })()}

            {!activityLoading && !activity && (
              <p className="text-gray-500 text-sm">Could not load activity data.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
