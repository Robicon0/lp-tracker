"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import Link from "next/link";
import Navbar from "../Navbar";
import PriceTicker from "../PriceTicker";
import { usePositions } from "../contexts/PositionsContext";
import { useAccount } from "wagmi";
import { useWalletAuth } from "../contexts/WalletAuthContext";
import { usePortfolioHistory } from "../hooks/usePortfolioHistory";

const TIME_RANGES = [
  { key: "1D",  ms: 1   * 24 * 3_600_000, label: "in last 24h",     xFmt: (d: Date) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) },
  { key: "7D",  ms: 7   * 24 * 3_600_000, label: "in last 7 days",  xFmt: (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) },
  { key: "30D", ms: 30  * 24 * 3_600_000, label: "in last 30 days", xFmt: (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) },
  { key: "90D", ms: 90  * 24 * 3_600_000, label: "in last 90 days", xFmt: (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) },
  { key: "1Y",  ms: 365 * 24 * 3_600_000, label: "in last year",    xFmt: (d: Date) => d.toLocaleDateString("en-US", { month: "short", year: "2-digit" }) },
] as const;

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
const chains = ["All", "Ethereum", "Base", "Arbitrum", "Optimism", "Polygon", "Avalanche", "Solana"];
const statuses = ["All", "In Range", "Out of Range", "Closed"];

function effectiveStatus(p: { value: number; fees: number; status: string }): "In Range" | "Out of Range" | "Closed" {
  if (p.value === 0 && p.fees === 0) return "Closed";
  return p.status as "In Range" | "Out of Range";
}
const sortOptions = [
  { label: "Value (High → Low)", key: "value", dir: "desc" },
  { label: "Value (Low → High)", key: "value", dir: "asc" },
  { label: "APY (High → Low)", key: "apy", dir: "desc" },
  { label: "APY (Low → High)", key: "apy", dir: "asc" },
  { label: "Fees (High → Low)", key: "fees", dir: "desc" },
  { label: "Fees (Low → High)", key: "fees", dir: "asc" },
];

export default function Dashboard() {
  const { positions: allPositions, isLoading, isFetching, dataUpdatedAt, refetch } = usePositions();
  const { address } = useAccount();
  const { solanaAddress, suiAddress } = useWalletAuth();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const hasWallet = mounted && !!(address || solanaAddress || suiAddress);
  const [chainFilter, setChainFilter] = useState("All");
  const [statusFilter, setStatusFilter] = useState("All");
  const [sortIndex, setSortIndex] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [secondsAgo, setSecondsAgo] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Tick the "last updated" counter every second
  useEffect(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    setSecondsAgo(dataUpdatedAt > 0 ? Math.floor((Date.now() - dataUpdatedAt) / 1000) : 0);
    if (dataUpdatedAt > 0) {
      intervalRef.current = setInterval(() => {
        setSecondsAgo(Math.floor((Date.now() - dataUpdatedAt) / 1000));
      }, 1000);
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [dataUpdatedAt]);

  function lastUpdatedLabel(): string {
    if (dataUpdatedAt === 0) return "";
    if (secondsAgo < 5) return "just now";
    if (secondsAgo < 60) return `${secondsAgo}s ago`;
    const m = Math.floor(secondsAgo / 60);
    return `${m}m ago`;
  }

  const filtered = useMemo(() => {
    let result = allPositions;

    if (searchQuery.trim() !== "") {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (p) =>
          p.pair.toLowerCase().includes(q) ||
          p.protocol.toLowerCase().includes(q) ||
          p.chain.toLowerCase().includes(q)
      );
    }

    if (chainFilter !== "All") {
      result = result.filter((p) => p.chain === chainFilter);
    }
    if (statusFilter !== "All") {
      result = result.filter((p) => effectiveStatus(p) === statusFilter);
    }

    const { key, dir } = sortOptions[sortIndex];
    const STATUS_ORDER: Record<string, number> = { "In Range": 0, "Out of Range": 1, "Closed": 2 };
    result = [...result].sort((a, b) => {
      // Primary: always group In Range → Out of Range → Closed
      const statusDiff = (STATUS_ORDER[effectiveStatus(a)] ?? 1) - (STATUS_ORDER[effectiveStatus(b)] ?? 1);
      if (statusDiff !== 0) return statusDiff;
      // Secondary: user's chosen sort key within each group
      const aVal = a[key as keyof typeof a] as number;
      const bVal = b[key as keyof typeof b] as number;
      return dir === "desc" ? bVal - aVal : aVal - bVal;
    });

    return result;
  }, [allPositions, chainFilter, statusFilter, sortIndex, searchQuery]);

  const totalValue = allPositions.reduce((sum, p) => sum + p.value, 0);
  const totalFees = allPositions.reduce((sum, p) => sum + p.fees, 0);
  const uniqueChains = new Set(allPositions.map(p => p.chain)).size;

  const [rangeKey, setRangeKey] = useState<typeof TIME_RANGES[number]["key"]>("30D");
  const portfolioHistory = usePortfolioHistory(totalValue, allPositions.length, dataUpdatedAt);

  const activeRange = TIME_RANGES.find((r) => r.key === rangeKey) ?? TIME_RANGES[2];
  const rangeCutoff = Date.now() - activeRange.ms;
  const rangedHistory = portfolioHistory.filter((s) => s.timestamp >= rangeCutoff);

  // Fall back to all available data if the selected range doesn't have enough points
  const effectiveHistory = rangedHistory.length >= 2 ? rangedHistory : portfolioHistory;
  const effectiveFirst = effectiveHistory[0];

  const pnlDollar = effectiveFirst ? totalValue - effectiveFirst.totalValue : 0;
  const pnlPct = effectiveFirst && effectiveFirst.totalValue > 0
    ? (pnlDollar / effectiveFirst.totalValue) * 100
    : 0;

  // Show "since [date]" when actual data doesn't cover at least 50% of the selected range
  const pnlLabel = (() => {
    if (!effectiveFirst) return activeRange.label;
    const coverageMs = Date.now() - effectiveFirst.timestamp;
    if (coverageMs < activeRange.ms * 0.5) {
      return `since ${new Date(effectiveFirst.timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
    }
    return activeRange.label;
  })();

  const chartData = effectiveHistory.map((s) => ({
    label: activeRange.xFmt(new Date(s.timestamp)),
    value: s.totalValue,
  }));

  return (
    <div className="p-8 pt-24 bg-black text-white min-h-screen">
      <Navbar />
      <div className="max-w-7xl mx-auto">
        <PriceTicker />
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-4xl font-bold">Portfolio Overview</h1>
            <p className="text-gray-400 mt-2">Track your DeFi liquidity positions</p>
          </div>
          {hasWallet && mounted && (
            <div className="flex items-center gap-3">
              {dataUpdatedAt > 0 && (
                <span className="text-gray-500 text-sm">
                  Updated {lastUpdatedLabel()}
                </span>
              )}
              <button
                onClick={() => refetch()}
                disabled={isFetching}
                className="flex items-center gap-2 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-gray-300 px-3 py-1.5 rounded-lg text-sm transition-colors"
                title="Refresh positions"
              >
                <svg
                  className={`w-3.5 h-3.5 ${isFetching ? "animate-spin" : ""}`}
                  fill="none" stroke="currentColor" viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                {isFetching ? "Refreshing…" : "Refresh"}
              </button>
            </div>
          )}
        </div>

        {/* Stats Cards */}
        <div className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-6">
            <p className="text-gray-400 text-sm mb-2">Total Portfolio Value</p>
            <p className="text-3xl font-bold">${totalValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-6">
            <p className="text-gray-400 text-sm mb-2">Active Positions</p>
            <p className="text-3xl font-bold">{allPositions.length}</p>
            <p className="text-gray-400 text-sm mt-2">Across {uniqueChains} chains</p>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-6">
            <p className="text-gray-400 text-sm mb-2">Total Fees Earned</p>
            <p className="text-3xl font-bold">${totalFees.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
            <p className="text-gray-400 text-sm mt-2">All time</p>
          </div>
        </div>

        {/* Portfolio History */}
        {hasWallet && mounted && (
          <div className="mt-6 bg-gray-900 border border-gray-800 rounded-lg p-6">
            <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
              <div className="flex items-center gap-3 flex-wrap">
                <h2 className="text-xl font-bold">Portfolio History</h2>
                <div className="flex gap-1">
                  {TIME_RANGES.map((r) => {
                    const cutoff = Date.now() - r.ms;
                    const hasData = portfolioHistory.filter((s) => s.timestamp >= cutoff).length >= 2;
                    return (
                      <button
                        key={r.key}
                        onClick={() => setRangeKey(r.key)}
                        title={!hasData ? "Not enough history yet" : undefined}
                        className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                          rangeKey === r.key
                            ? "bg-blue-600 text-white"
                            : hasData
                            ? "bg-gray-800 text-gray-400 hover:text-white hover:bg-gray-700"
                            : "bg-gray-800 text-gray-600"
                        }`}
                      >
                        {r.key}
                      </button>
                    );
                  })}
                </div>
              </div>
              {effectiveHistory.length >= 2 && (
                <div className={`text-sm font-medium ${pnlDollar >= 0 ? "text-green-500" : "text-red-500"}`}>
                  {pnlDollar >= 0 ? "+" : ""}
                  ${Math.abs(pnlDollar).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  {" "}
                  <span className="opacity-75">
                    ({pnlDollar >= 0 ? "+" : ""}{pnlPct.toFixed(2)}%)
                  </span>
                  <span className="text-gray-500 font-normal ml-1">{pnlLabel}</span>
                </div>
              )}
            </div>
            {portfolioHistory.length < 2 ? (
              <div className="flex flex-col items-center justify-center py-10 text-gray-500">
                <svg className="w-8 h-8 mb-3 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                    d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
                <p className="text-sm">Tracking started — chart will appear after the next refresh.</p>
                <p className="text-xs mt-1 opacity-60">A new data point is saved on every positions refresh.</p>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={chartData} margin={{ top: 4, right: 16, left: 8, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                  <XAxis
                    dataKey="label"
                    tick={{ fill: "#6b7280", fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    tick={{ fill: "#6b7280", fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(v) => `$${Number(v).toLocaleString("en-US", { maximumFractionDigits: 0 })}`}
                    width={72}
                  />
                  <Tooltip
                    contentStyle={{ backgroundColor: "#1f2937", border: "1px solid #374151", borderRadius: "8px", color: "#fff" }}
                    formatter={(v: number | undefined) => [`$${(v ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, "Portfolio Value"]}
                    labelStyle={{ color: "#9ca3af", marginBottom: 4 }}
                  />
                  <Line
                    type="monotone"
                    dataKey="value"
                    stroke="#3b82f6"
                    strokeWidth={2}
                    dot={chartData.length <= 20}
                    activeDot={{ r: 4, fill: "#3b82f6" }}
                  />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        )}

        {/* Filters & Sort */}
        <div className="mt-8 flex flex-wrap gap-4 items-center">
          {/* Search */}
          <div>
            <input
              type="text"
              placeholder="Search pairs, protocols, chains..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="bg-gray-900 border border-gray-700 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500 w-64"
            />
          </div>

          {/* Chain Filter */}
          <div>
            <label className="text-gray-400 text-sm mr-2">Chain:</label>
            <select
              value={chainFilter}
              onChange={(e) => setChainFilter(e.target.value)}
              className="bg-gray-900 border border-gray-700 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
            >
              {chains.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>

          {/* Status Filter */}
          <div>
            <label className="text-gray-400 text-sm mr-2">Status:</label>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="bg-gray-900 border border-gray-700 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
            >
              {statuses.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>

          {/* Sort */}
          <div>
            <label className="text-gray-400 text-sm mr-2">Sort:</label>
            <select
              value={sortIndex}
              onChange={(e) => setSortIndex(Number(e.target.value))}
              className="bg-gray-900 border border-gray-700 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
            >
              {sortOptions.map((opt, i) => (
                <option key={i} value={i}>{opt.label}</option>
              ))}
            </select>
          </div>

          {/* Result count */}
          <span className="text-gray-500 text-sm ml-auto">
            Showing {filtered.length} of {allPositions.length} positions
          </span>
        </div>

        {/* Positions Grid */}
        <div className="flex justify-between items-center mt-8 mb-4"><h2 className="text-2xl font-bold">Your Positions</h2><button onClick={() => { const headers = "Pair,Protocol,Chain,Value,APY,Fees,Status\n"; const rows = filtered.map((p) => `${p.pair},${p.protocol},${p.chain},${p.value},${p.apy}%,${p.fees},${p.status}`).join("\n"); const blob = new Blob([headers + rows], { type: "text/csv" }); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = "lp-positions.csv"; a.click(); URL.revokeObjectURL(url); }} className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">Export CSV</button></div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {mounted && isLoading && (
            <div className="col-span-2 flex flex-col items-center justify-center py-16 text-gray-400">
              <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mb-4" />
              <p>Fetching your positions...</p>
            </div>
          )}
          {(!mounted || !isLoading) && filtered.map((pos) => {
            const posStatus = effectiveStatus(pos);
            const isClosed = posStatus === "Closed";
            return (
            <Link key={pos.id} href={`/dashboard/${pos.id}`}>
              <div className={`bg-gray-900 border border-gray-800 rounded-lg p-6 hover:border-blue-500 transition-colors cursor-pointer${isClosed ? " opacity-50" : ""}`}>
                <div className="flex justify-between items-start mb-4">
                  <div>
                    <h3 className="text-xl font-bold">{pos.pair}</h3>
                    <p className="text-gray-400 text-sm">{pos.protocol} • {pos.chain}</p>
                  </div>
                  <span
                    className={`px-3 py-1 rounded-full text-sm ${
                      posStatus === "In Range"
                        ? "bg-green-500/10 text-green-500"
                        : posStatus === "Closed"
                        ? "bg-gray-500/10 text-gray-400"
                        : "bg-red-500/10 text-red-500"
                    }`}
                  >
                    {posStatus}
                  </span>
                </div>
                <div className="space-y-2">
                  <div className="flex justify-between">
                    <span className="text-gray-400">Position Value</span>
                    <span className="font-semibold">${pos.value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                  </div>
                  <div className="flex justify-between items-start">
                    <span className="text-gray-400">APY</span>
                    <div className="text-right">
                      <span className="text-green-500">{pos.apy}% <span className="text-green-500/60 text-xs">/yr</span></span>
                      {pos.apy > 0 && (
                        <div className="text-xs text-gray-500 mt-0.5">
                          {(pos.apy / 12).toFixed(2)}% /mo · {(pos.apy / 365).toFixed(3)}% /day
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Fees Earned</span>
                    <span className="font-semibold">${pos.fees.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                  </div>
                </div>
              </div>
            </Link>
            );
          })}

          {mounted && !isLoading && filtered.length === 0 && (
            <div className="col-span-2">
              {!hasWallet ? (
                <div className="flex flex-col items-center justify-center py-20 text-center">
                  <div className="text-5xl mb-6">💼</div>
                  <h3 className="text-xl font-semibold text-white mb-2">No wallet connected</h3>
                  <p className="text-gray-400 mb-8 max-w-sm">Connect your wallet to track your LP positions across EVM chains, Solana, and Sui.</p>
                  <div className="flex flex-wrap justify-center gap-4 text-sm text-gray-500">
                    <div className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-3 flex items-center gap-2">
                      <span className="text-blue-400 font-medium">EVM</span>
                      <span>Ethereum · Base · Arbitrum · Optimism</span>
                    </div>
                    <div className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-3 flex items-center gap-2">
                      <span className="text-purple-400 font-medium">Solana</span>
                      <span>Raydium · Orca</span>
                    </div>
                    <div className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-3 flex items-center gap-2">
                      <span className="text-cyan-400 font-medium">Sui</span>
                      <span>Bluefin · Cetus</span>
                    </div>
                  </div>
                </div>
              ) : allPositions.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-20 text-center">
                  <div className="text-5xl mb-6">📭</div>
                  <h3 className="text-xl font-semibold text-white mb-2">No positions found</h3>
                  <p className="text-gray-400 max-w-sm">No LP positions were found for your connected wallet(s). Open a position on Aerodrome, Uniswap, Orca, Bluefin, or another supported protocol.</p>
                </div>
              ) : (
                <div className="text-center py-12 text-gray-500">
                  No positions match your filters.
                </div>
              )}
            </div>
          )}
        </div>

        {/* Closed position limitation note — shown when Solana or Sui wallet is connected */}
        {mounted && (solanaAddress || suiAddress) && (
          <div className="mt-6 text-sm text-gray-500 border border-gray-800 rounded-lg px-4 py-3 flex items-start gap-2">
            <span className="mt-0.5 shrink-0">ℹ️</span>
            <span>
              Some closed positions may not appear: on Solana, NFTs are burned when a position is fully closed; on Sui, position objects are destroyed. These no longer exist on-chain and cannot be recovered. Only positions whose on-chain record still exists (zero liquidity but unburned) show as &quot;Closed&quot;.
            </span>
          </div>
        )}
      </div>
    </div>
  );
}