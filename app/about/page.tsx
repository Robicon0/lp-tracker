import Navbar from "../Navbar";

export default function About() {
  return (
    <div className="min-h-screen bg-black text-white p-8 pt-24">
      <Navbar />
      <div className="max-w-4xl mx-auto">
        <h1 className="text-4xl font-bold mb-4">About LP Tracker</h1>
        <p className="text-gray-400 mb-8">
          A DeFi portfolio tracker for monitoring liquidity positions across multiple blockchains.
        </p>

        {/* What It Does */}
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 mb-6">
          <h2 className="text-2xl font-bold mb-3">What It Does</h2>
          <p className="text-gray-300 leading-relaxed">
            LP Tracker helps liquidity providers monitor their positions across decentralized exchanges
            like Uniswap, Aerodrome, Velodrome, QuickSwap, Trader Joe, and Raydium. Track your portfolio
            value, APY, fees earned, and position status — all in one place.
          </p>
        </div>

        {/* Supported Chains */}
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 mb-6">
          <h2 className="text-2xl font-bold mb-3">Supported Chains</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {["Ethereum", "Base", "Arbitrum", "Optimism", "Polygon", "Avalanche", "Solana"].map((chain) => (
              <div key={chain} className="bg-gray-800 border border-gray-700 rounded-lg px-4 py-3 text-center">
                <span className="text-white font-medium">{chain}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Features */}
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 mb-6">
          <h2 className="text-2xl font-bold mb-3">Features</h2>
          <div className="space-y-2 text-gray-300">
            <p>✅ Portfolio overview with total value and fees earned</p>
            <p>✅ Filter positions by chain, protocol, and status</p>
            <p>✅ Sort by value, APY, or fees</p>
            <p>✅ Individual position detail pages</p>
            <p>✅ MetaMask wallet connection</p>
            <p>🔜 Real-time data from blockchain</p>
            <p>🔜 Performance charts and IL tracking</p>
            <p>🔜 Multi-wallet support</p>
          </div>
        </div>

        {/* Tech Stack */}
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 mb-6">
          <h2 className="text-2xl font-bold mb-3">Tech Stack</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {["Next.js", "React", "TypeScript", "Tailwind CSS", "wagmi", "viem"].map((tech) => (
              <div key={tech} className="bg-gray-800 border border-gray-700 rounded-lg px-4 py-3 text-center">
                <span className="text-gray-300 text-sm">{tech}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="text-center text-gray-500 text-sm mt-8">
          <p>Built by Osho • 2026</p>
        </div>
      </div>
    </div>
  );
}