"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import Navbar from "../../Navbar";
import { usePositions } from "../../contexts/PositionsContext";

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
  const hasTokenBreakdown = pos.amount0 != null && pos.amount1 != null;
  const hasFeeBreakdown = pos.fees0 != null && pos.fees1 != null;
  const hasTickRange = pos.tickLower != null && pos.tickUpper != null;
  const hasFeeTier = pos.feeTier != null;

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
              <span className={pos.status === "In Range" ? "text-green-500 font-semibold" : "text-red-500 font-semibold"}>
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
                <span className="text-gray-400">Tick Range</span>
                <span className="font-semibold font-mono text-sm">{pos.tickLower} → {pos.tickUpper}</span>
              </div>
            )}
            <div className="flex justify-between py-3 border-b border-gray-800">
              <span className="text-gray-400">Est. Daily Fees</span>
              <span className="font-semibold">
                ${estimatedDailyFees.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </div>
            <div className="flex justify-between py-3">
              <span className="text-gray-400">Est. Monthly Yield</span>
              <span className="font-semibold text-green-500">
                ${estimatedMonthlyYield.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
