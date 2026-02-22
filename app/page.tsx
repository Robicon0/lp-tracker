import Navbar from "./Navbar";
import Link from "next/link";

export default function Home() {
  return (
    <div className="min-h-screen bg-black text-white">
      <Navbar />
      <div className="flex flex-col items-center justify-center min-h-screen px-4 pt-16">
        <h1 className="text-6xl font-bold mb-4 text-center">LP Tracker</h1>
        <p className="text-xl text-gray-400 mb-8 text-center max-w-2xl">
          Track your DeFi liquidity positions across multiple chains. Monitor value, APY, fees, and more — all in one place.
        </p>
        <div className="flex space-x-4">
          <Link
            href="/dashboard"
            className="bg-blue-600 hover:bg-blue-500 text-white px-6 py-3 rounded-lg text-lg font-medium transition-colors"
          >
            Go to Dashboard
          </Link>
          <Link
            href="/analytics"
            className="bg-gray-800 hover:bg-gray-700 border border-gray-700 text-white px-6 py-3 rounded-lg text-lg font-medium transition-colors"
          >
            View Analytics
          </Link>
        </div>
        <div className="mt-16 grid grid-cols-1 md:grid-cols-3 gap-8 max-w-4xl">
          <div className="text-center">
            <p className="text-3xl font-bold text-blue-500 mb-2">8</p>
            <p className="text-gray-400">Active Positions</p>
          </div>
          <div className="text-center">
            <p className="text-3xl font-bold text-green-500 mb-2">7</p>
            <p className="text-gray-400">Chains Supported</p>
          </div>
          <div className="text-center">
            <p className="text-3xl font-bold text-yellow-500 mb-2">Live</p>
            <p className="text-gray-400">Price Updates</p>
          </div>
        </div>
      </div>
    </div>
  );
}