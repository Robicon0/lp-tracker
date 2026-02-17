import { positions } from "../../data/positions";
import Link from "next/link";
import { notFound } from "next/navigation";
import Navbar from "../../Navbar";
interface Props {
  params: Promise<{ id: string }>;
}

export default async function PositionDetail({ params }: Props) {
  const { id } = await params;
  const pos = positions.find((p) => p.id === id);

  if (!pos) {
    notFound();
  }

  const feesPerDay = pos.fees / 30;
  const estimatedMonthly = (pos.value * pos.apy) / 100 / 12;

  return (
    <div className="p-8 pt-24 bg-black text-white min-h-screen">
        <Navbar />
      <div className="max-w-4xl mx-auto">
        {/* Back Link */}
        <Link href="/dashboard" className="text-blue-400 hover:text-blue-300 text-sm mb-6 inline-block">
          ← Back to Dashboard
        </Link>

        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-4xl font-bold">{pos.pair}</h1>
            <p className="text-gray-400 mt-1">{pos.protocol} • {pos.chain}</p>
          </div>
          <span
            className={`px-4 py-2 rounded-full text-sm font-medium ${
              pos.status === "In Range"
                ? "bg-green-500/10 text-green-500"
                : "bg-red-500/10 text-red-500"
            }`}
          >
            {pos.status}
          </span>
        </div>

        {/* Main Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-6">
            <p className="text-gray-400 text-sm mb-2">Position Value</p>
            <p className="text-3xl font-bold">
              ${pos.value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </p>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-6">
            <p className="text-gray-400 text-sm mb-2">Current APY</p>
            <p className="text-3xl font-bold text-green-500">{pos.apy}%</p>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-6">
            <p className="text-gray-400 text-sm mb-2">Total Fees Earned</p>
            <p className="text-3xl font-bold">
              ${pos.fees.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </p>
          </div>
        </div>

        {/* Detailed Info */}
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 mb-8">
          <h2 className="text-xl font-bold mb-4">Position Details</h2>
          <div className="space-y-3">
            <div className="flex justify-between py-2 border-b border-gray-800">
              <span className="text-gray-400">Trading Pair</span>
              <span className="font-semibold">{pos.pair}</span>
            </div>
            <div className="flex justify-between py-2 border-b border-gray-800">
              <span className="text-gray-400">Protocol</span>
              <span className="font-semibold">{pos.protocol}</span>
            </div>
            <div className="flex justify-between py-2 border-b border-gray-800">
              <span className="text-gray-400">Blockchain</span>
              <span className="font-semibold">{pos.chain}</span>
            </div>
            <div className="flex justify-between py-2 border-b border-gray-800">
              <span className="text-gray-400">Status</span>
              <span className={pos.status === "In Range" ? "text-green-500" : "text-red-500"}>
                {pos.status}
              </span>
            </div>
            <div className="flex justify-between py-2 border-b border-gray-800">
              <span className="text-gray-400">Est. Daily Fees</span>
              <span className="font-semibold">
                ${feesPerDay.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </div>
            <div className="flex justify-between py-2">
              <span className="text-gray-400">Est. Monthly Yield</span>
              <span className="font-semibold text-green-500">
                ${estimatedMonthly.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </div>
          </div>
        </div>

        {/* Placeholder sections for future features */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-6">
            <h2 className="text-xl font-bold mb-2">Performance Chart</h2>
            <p className="text-gray-500 text-sm">Coming soon — historical position performance</p>
            <div className="h-40 flex items-center justify-center border border-dashed border-gray-700 rounded-lg mt-4">
              <span className="text-gray-600">📈 Chart Placeholder</span>
            </div>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-6">
            <h2 className="text-xl font-bold mb-2">Impermanent Loss</h2>
            <p className="text-gray-500 text-sm">Coming soon — IL tracking & calculator</p>
            <div className="h-40 flex items-center justify-center border border-dashed border-gray-700 rounded-lg mt-4">
              <span className="text-gray-600">📊 IL Calculator Placeholder</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}