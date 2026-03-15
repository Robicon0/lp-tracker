"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import Navbar from "../../Navbar";
import { usePositions } from "../../contexts/PositionsContext";

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

  if (isLoading) {
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

  const pos = positions.find((p) => p.id === id);

  if (!pos) {
    return (
      <div className="p-8 pt-24 bg-black text-white min-h-screen">
        <Navbar />
        <div className="max-w-4xl mx-auto">
          <Link href="/dashboard" className="text-blue-400 hover:text-blue-300 text-sm mb-6 inline-block">
            &larr; Back to Dashboard
          </Link>
          <div className="text-center py-24">
            <h1 className="text-4xl font-bold mb-4">Position Not Found</h1>
            <p className="text-gray-400">This position doesn&apos;t exist or your wallet isn&apos;t connected.</p>
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
      </div>
    </div>
  );
}
