"use client";

import Navbar from "../Navbar";
import { positions } from "../data/positions";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
  AreaChart,
  Area,
} from "recharts";

// Colors for charts
const COLORS = ["#3B82F6", "#10B981", "#F59E0B", "#EF4444", "#8B5CF6", "#EC4899", "#06B6D4", "#F97316"];

// Short pair names for bar chart labels
const shortName = (pair: string) => pair.replace(" / ", "/");

// Data: Value by position
const valueData = positions.map((p) => ({
  name: shortName(p.pair),
  value: p.value,
}));

// Data: APY by position
const apyData = positions.map((p) => ({
  name: shortName(p.pair),
  apy: p.apy,
}));

// Data: Value by chain (aggregated)
const chainMap: Record<string, number> = {};
positions.forEach((p) => {
  chainMap[p.chain] = (chainMap[p.chain] || 0) + p.value;
});
const chainData = Object.entries(chainMap)
  .map(([name, value]) => ({ name, value }))
  .sort((a, b) => b.value - a.value);

// Data: Value by protocol (aggregated)
const protocolMap: Record<string, number> = {};
positions.forEach((p) => {
  protocolMap[p.protocol] = (protocolMap[p.protocol] || 0) + p.value;
});
const protocolData = Object.entries(protocolMap)
  .map(([name, value]) => ({ name, value }))
  .sort((a, b) => b.value - a.value);

// Mock: Simulated 30-day portfolio performance
const performanceData = Array.from({ length: 30 }, (_, i) => {
  const base = 120000;
  const variation = Math.sin(i / 3) * 5000 + Math.random() * 3000;
  return {
    day: `Day ${i + 1}`,
    value: Math.round(base + variation + i * 200),
  };
});

// Mock: Simulated daily fees over 30 days
const dailyFeesData = Array.from({ length: 30 }, (_, i) => ({
  day: `Day ${i + 1}`,
  fees: Math.round(50 + Math.random() * 150),
}));

const CustomTooltipStyle = {
  backgroundColor: "#1F2937",
  border: "1px solid #374151",
  borderRadius: "8px",
  padding: "8px 12px",
  color: "#FFFFFF",
};

// Custom legend renderer for pie charts
const renderLegend = (props: any) => {
  const { payload } = props;
  const total = payload.reduce((sum: number, entry: any) => sum + entry.payload.value, 0);
  return (
    <div className="flex flex-wrap justify-center gap-x-4 gap-y-2 mt-4">
      {payload.map((entry: any, index: number) => {
        const pct = ((entry.payload.value / total) * 100).toFixed(0);
        const dollars = entry.payload.value.toLocaleString();
        return (
          <div key={index} className="flex items-center space-x-1.5 text-xs">
            <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: entry.color }} />
            <span className="text-gray-300">{entry.value} {pct}% (${dollars})</span>
          </div>
        );
      })}
    </div>
  );
};

export default function Analytics() {
  const totalValue = positions.reduce((sum, p) => sum + p.value, 0);
  const totalFees = positions.reduce((sum, p) => sum + p.fees, 0);
  const avgApy = positions.reduce((sum, p) => sum + p.apy, 0) / positions.length;

  return (
    <div className="p-8 pt-24 bg-black text-white min-h-screen">
      <Navbar />
      <div className="max-w-7xl mx-auto">
        <h1 className="text-4xl font-bold">Portfolio Analytics</h1>
        <p className="text-gray-400 mt-2">Visual breakdown of your DeFi positions</p>

        {/* Summary Stats */}
        <div className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-6">
            <p className="text-gray-400 text-sm mb-2">Total Portfolio Value</p>
            <p className="text-3xl font-bold">
              ${totalValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </p>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-6">
            <p className="text-gray-400 text-sm mb-2">Average APY</p>
            <p className="text-3xl font-bold text-green-500">{avgApy.toFixed(1)}%</p>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-6">
            <p className="text-gray-400 text-sm mb-2">Total Fees Earned</p>
            <p className="text-3xl font-bold">
              ${totalFees.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </p>
          </div>
        </div>

        {/* Row 1: Portfolio Performance + Daily Fees */}
        <div className="mt-8 grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* 30-Day Portfolio Performance */}
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-6">
            <h2 className="text-xl font-bold mb-4">30-Day Portfolio Value</h2>
            <ResponsiveContainer width="100%" height={300}>
              <AreaChart data={performanceData}>
                <defs>
                  <linearGradient id="colorValue" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3B82F6" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#3B82F6" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                <XAxis dataKey="day" tick={{ fill: "#9CA3AF", fontSize: 11 }} interval={4} />
                <YAxis tick={{ fill: "#9CA3AF", fontSize: 11 }} tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} />
                <Tooltip contentStyle={CustomTooltipStyle} formatter={(value: number) => [`$${value.toLocaleString()}`, "Value"]} />
                <Area type="monotone" dataKey="value" stroke="#3B82F6" fill="url(#colorValue)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          {/* Daily Fees */}
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-6">
            <h2 className="text-xl font-bold mb-4">Daily Fees Earned</h2>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={dailyFeesData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                <XAxis dataKey="day" tick={{ fill: "#9CA3AF", fontSize: 11 }} interval={4} />
                <YAxis tick={{ fill: "#9CA3AF", fontSize: 11 }} tickFormatter={(v) => `$${v}`} />
                <Tooltip contentStyle={CustomTooltipStyle} formatter={(value: number) => [`$${value}`, "Fees"]} />
                <Bar dataKey="fees" fill="#10B981" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Row 2: Value by Position + APY Comparison */}
        <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Value by Position */}
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-6">
            <h2 className="text-xl font-bold mb-4">Value by Position</h2>
            <ResponsiveContainer width="100%" height={320}>
              <BarChart data={valueData} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                <XAxis type="number" tick={{ fill: "#9CA3AF", fontSize: 11 }} tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} />
                <YAxis type="category" dataKey="name" tick={{ fill: "#9CA3AF", fontSize: 12 }} width={80} />
                <Tooltip contentStyle={CustomTooltipStyle} formatter={(value: number) => [`$${value.toLocaleString()}`, "Value"]} />
                <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                  {valueData.map((_, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* APY Comparison */}
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-6">
            <h2 className="text-xl font-bold mb-4">APY Comparison</h2>
            <ResponsiveContainer width="100%" height={320}>
              <BarChart data={apyData} margin={{ bottom: 20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                <XAxis
                  dataKey="name"
                  tick={{ fill: "#9CA3AF", fontSize: 10 }}
                  interval={0}
                  angle={0}
                  textAnchor="middle"
                  height={40}
                />
                <YAxis tick={{ fill: "#9CA3AF", fontSize: 11 }} tickFormatter={(v) => `${v}%`} />
                <Tooltip contentStyle={CustomTooltipStyle} formatter={(value: number) => [`${value}%`, "APY"]} />
                <Bar dataKey="apy" radius={[4, 4, 0, 0]}>
                  {apyData.map((_, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Row 3: Chain Distribution + Protocol Distribution */}
        <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-6 mb-12">
          {/* Chain Distribution */}
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-6">
            <h2 className="text-xl font-bold mb-4">Value by Chain</h2>
            <ResponsiveContainer width="100%" height={350}>
              <PieChart>
                <Pie
                  data={chainData}
                  cx="50%"
                  cy="40%"
                  outerRadius={100}
                  innerRadius={55}
                  dataKey="value"
                  paddingAngle={2}
                >
                  {chainData.map((_, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip contentStyle={CustomTooltipStyle} formatter={(value: number) => [`$${value.toLocaleString()}`, "Value"]} />
                <Legend content={renderLegend} />
              </PieChart>
            </ResponsiveContainer>
          </div>

          {/* Protocol Distribution */}
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-6">
            <h2 className="text-xl font-bold mb-4">Value by Protocol</h2>
            <ResponsiveContainer width="100%" height={350}>
              <PieChart>
                <Pie
                  data={protocolData}
                  cx="50%"
                  cy="40%"
                  outerRadius={100}
                  innerRadius={55}
                  dataKey="value"
                  paddingAngle={2}
                >
                  {protocolData.map((_, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip contentStyle={CustomTooltipStyle} formatter={(value: number) => [`$${value.toLocaleString()}`, "Value"]} />
                <Legend content={renderLegend} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
}