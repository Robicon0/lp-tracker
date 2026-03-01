"use client";

import { useState, useMemo, useEffect } from "react";
import { positions } from "../data/positions";
import Link from "next/link";
import Navbar from "../Navbar";
import PriceTicker from "../PriceTicker";
import { useAccount } from "wagmi";
import { fetchAerodromePositions, AerodromePosition } from "../lib/aerodrome";
import { fetchUniswapV3Positions } from "../lib/uniswap";
import { fetchVelodromePositions } from "../lib/velodrome";
const chains = ["All", "Ethereum", "Base", "Arbitrum", "Optimism", "Polygon", "Avalanche", "Solana"];
const statuses = ["All", "In Range", "Out of Range"];
const sortOptions = [
  { label: "Value (High → Low)", key: "value", dir: "desc" },
  { label: "Value (Low → High)", key: "value", dir: "asc" },
  { label: "APY (High → Low)", key: "apy", dir: "desc" },
  { label: "APY (Low → High)", key: "apy", dir: "asc" },
  { label: "Fees (High → Low)", key: "fees", dir: "desc" },
  { label: "Fees (Low → High)", key: "fees", dir: "asc" },
];

export default function Dashboard() {
  const { address, isConnected } = useAccount();
const [realPositions, setRealPositions] = useState<AerodromePosition[]>([]);
const [loadingPositions, setLoadingPositions] = useState(false);

useEffect(() => {
  if (!isConnected || !address) {
    setRealPositions([]);
    return;
  }
  setLoadingPositions(true);
  Promise.all([
      fetchAerodromePositions(address),
      fetchUniswapV3Positions(address),
      fetchVelodromePositions(address),
    ]).then(([aeroPos, uniPos, veloPos]) => {
      console.log('Aerodrome:', aeroPos.length, 'Uniswap V3:', uniPos.length, 'Velodrome:', veloPos.length);
      setRealPositions([...aeroPos, ...uniPos, ...veloPos]);
      setLoadingPositions(false);
    });
}, [address, isConnected]);
  const [chainFilter, setChainFilter] = useState("All");
  const [statusFilter, setStatusFilter] = useState("All");
  const [sortIndex, setSortIndex] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");

  const filtered = useMemo(() => {
    let result = realPositions.length > 0 ? realPositions : positions;

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
      result = result.filter((p) => p.status === statusFilter);
    }

    const { key, dir } = sortOptions[sortIndex];
    result = [...result].sort((a, b) => {
      const aVal = a[key as keyof typeof a] as number;
      const bVal = b[key as keyof typeof b] as number;
      return dir === "desc" ? bVal - aVal : aVal - bVal;
    });

    return result;
  }, [realPositions, chainFilter, statusFilter, sortIndex, searchQuery]);

  const displayPositions = realPositions.length > 0 ? realPositions : positions;
  const totalValue = displayPositions.reduce((sum, p) => sum + p.value, 0);
  const totalFees = displayPositions.reduce((sum, p) => sum + p.fees, 0);
  const uniqueChains = new Set(displayPositions.map(p => p.chain)).size;

  return (
    <div className="p-8 pt-24 bg-black text-white min-h-screen">
      <Navbar />
      <div className="max-w-7xl mx-auto">
        <PriceTicker />
        <h1 className="text-4xl font-bold">Portfolio Overview</h1>
        <p className="text-gray-400 mt-2">Track your DeFi liquidity positions</p>

        {/* Stats Cards */}
        <div className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-6">
            <p className="text-gray-400 text-sm mb-2">Total Portfolio Value</p>
            <p className="text-3xl font-bold">${totalValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-6">
            <p className="text-gray-400 text-sm mb-2">Active Positions</p>
            <p className="text-3xl font-bold">{displayPositions.length}</p>
            <p className="text-gray-400 text-sm mt-2">Across {uniqueChains} chains</p>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-6">
            <p className="text-gray-400 text-sm mb-2">Total Fees Earned</p>
            <p className="text-3xl font-bold">${totalFees.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
            <p className="text-gray-400 text-sm mt-2">All time</p>
          </div>
        </div>

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
            Showing {filtered.length} of {displayPositions.length} positions
          </span>
        </div>

        {/* Positions Grid */}
        <div className="flex justify-between items-center mt-8 mb-4"><h2 className="text-2xl font-bold">Your Positions</h2><button onClick={() => { const headers = "Pair,Protocol,Chain,Value,APY,Fees,Status\n"; const rows = filtered.map((p) => `${p.pair},${p.protocol},${p.chain},${p.value},${p.apy}%,${p.fees},${p.status}`).join("\n"); const blob = new Blob([headers + rows], { type: "text/csv" }); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = "lp-positions.csv"; a.click(); URL.revokeObjectURL(url); }} className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">Export CSV</button></div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {filtered.map((pos) => (
            <Link key={pos.id} href={`/dashboard/${pos.id}`}>
              <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 hover:border-blue-500 transition-colors cursor-pointer">
                <div className="flex justify-between items-start mb-4">
                  <div>
                    <h3 className="text-xl font-bold">{pos.pair}</h3>
                    <p className="text-gray-400 text-sm">{pos.protocol} • {pos.chain}</p>
                  </div>
                  <span
                    className={`px-3 py-1 rounded-full text-sm ${
                      pos.status === "In Range"
                        ? "bg-green-500/10 text-green-500"
                        : "bg-red-500/10 text-red-500"
                    }`}
                  >
                    {pos.status}
                  </span>
                </div>
                <div className="space-y-2">
                  <div className="flex justify-between">
                    <span className="text-gray-400">Position Value</span>
                    <span className="font-semibold">${pos.value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">APY</span>
                    <span className="text-green-500">{pos.apy}%</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Fees Earned</span>
                    <span className="font-semibold">${pos.fees.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                  </div>
                </div>
              </div>
            </Link>
          ))}

          {filtered.length === 0 && (
            <div className="col-span-2 text-center py-12 text-gray-500">
              No positions match your filters.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}