export default function Dashboard() {
  return (
    <div className="min-h-screen bg-black text-white p-8">
      <div className="max-w-7xl mx-auto">
        <div className="mb-8">
          <h1 className="text-4xl font-bold mb-2">Portfolio Overview</h1>
          <p className="text-gray-400">Track your DeFi liquidity positions</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-6">
            <p className="text-gray-400 text-sm mb-2">Total Portfolio Value</p>
            <p className="text-3xl font-bold">$127,458.32</p>
            <p className="text-green-500 text-sm mt-2">+$2,341.21 (24h)</p>
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded-lg p-6">
            <p className="text-gray-400 text-sm mb-2">Active Positions</p>
            <p className="text-3xl font-bold">8</p>
            <p className="text-gray-400 text-sm mt-2">Across 6 chains</p>
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded-lg p-6">
            <p className="text-gray-400 text-sm mb-2">Total Fees Earned</p>
            <p className="text-3xl font-bold">$3,247.89</p>
            <p className="text-gray-400 text-sm mt-2">All time</p>
          </div>
        </div>

        <div>
          <h2 className="text-2xl font-bold mb-4">Your Positions</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            
            <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 hover:border-blue-500 transition-colors cursor-pointer">
              <div className="flex justify-between items-start mb-4">
                <div>
                  <h3 className="text-xl font-bold">ETH / USDC</h3>
                  <p className="text-gray-400 text-sm">Uniswap V3 • Ethereum</p>
                </div>
                <span className="bg-green-500/10 text-green-500 px-3 py-1 rounded-full text-sm">In Range</span>
              </div>
              <div className="space-y-2">
                <div className="flex justify-between">
                  <span className="text-gray-400">Position Value</span>
                  <span className="font-semibold">$45,231.12</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">APY</span>
                  <span className="text-green-500">24.3%</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Fees Earned</span>
                  <span className="font-semibold">$1,234.56</span>
                </div>
              </div>
            </div>

            <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 hover:border-blue-500 transition-colors cursor-pointer">
              <div className="flex justify-between items-start mb-4">
                <div>
                  <h3 className="text-xl font-bold">WBTC / ETH</h3>
                  <p className="text-gray-400 text-sm">Aerodrome • Base</p>
                </div>
                <span className="bg-green-500/10 text-green-500 px-3 py-1 rounded-full text-sm">In Range</span>
              </div>
              <div className="space-y-2">
                <div className="flex justify-between">
                  <span className="text-gray-400">Position Value</span>
                  <span className="font-semibold">$32,890.45</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">APY</span>
                  <span className="text-green-500">18.7%</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Fees Earned</span>
                  <span className="font-semibold">$892.34</span>
                </div>
              </div>
            </div>

            <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 hover:border-blue-500 transition-colors cursor-pointer">
              <div className="flex justify-between items-start mb-4">
                <div>
                  <h3 className="text-xl font-bold">USDC / USDT</h3>
                  <p className="text-gray-400 text-sm">Uniswap V3 • Ethereum</p>
                </div>
                <span className="bg-green-500/10 text-green-500 px-3 py-1 rounded-full text-sm">In Range</span>
              </div>
              <div className="space-y-2">
                <div className="flex justify-between">
                  <span className="text-gray-400">Position Value</span>
                  <span className="font-semibold">$28,450.00</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">APY</span>
                  <span className="text-green-500">12.5%</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Fees Earned</span>
                  <span className="font-semibold">$456.78</span>
                </div>
              </div>
            </div>

            <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 hover:border-blue-500 transition-colors cursor-pointer">
              <div className="flex justify-between items-start mb-4">
                <div>
                  <h3 className="text-xl font-bold">ARB / ETH</h3>
                  <p className="text-gray-400 text-sm">Uniswap V3 • Arbitrum</p>
                </div>
                <span className="bg-green-500/10 text-green-500 px-3 py-1 rounded-full text-sm">In Range</span>
              </div>
              <div className="space-y-2">
                <div className="flex justify-between">
                  <span className="text-gray-400">Position Value</span>
                  <span className="font-semibold">$8,920.15</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">APY</span>
                  <span className="text-green-500">31.2%</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Fees Earned</span>
                  <span className="font-semibold">$287.45</span>
                </div>
              </div>
            </div>

            <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 hover:border-blue-500 transition-colors cursor-pointer">
              <div className="flex justify-between items-start mb-4">
                <div>
                  <h3 className="text-xl font-bold">OP / ETH</h3>
                  <p className="text-gray-400 text-sm">Velodrome • Optimism</p>
                </div>
                <span className="bg-green-500/10 text-green-500 px-3 py-1 rounded-full text-sm">In Range</span>
              </div>
              <div className="space-y-2">
                <div className="flex justify-between">
                  <span className="text-gray-400">Position Value</span>
                  <span className="font-semibold">$6,543.21</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">APY</span>
                  <span className="text-green-500">28.9%</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Fees Earned</span>
                  <span className="font-semibold">$189.23</span>
                </div>
              </div>
            </div>

            <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 hover:border-blue-500 transition-colors cursor-pointer">
              <div className="flex justify-between items-start mb-4">
                <div>
                  <h3 className="text-xl font-bold">MATIC / ETH</h3>
                  <p className="text-gray-400 text-sm">QuickSwap • Polygon</p>
                </div>
                <span className="bg-red-500/10 text-red-500 px-3 py-1 rounded-full text-sm">Out of Range</span>
              </div>
              <div className="space-y-2">
                <div className="flex justify-between">
                  <span className="text-gray-400">Position Value</span>
                  <span className="font-semibold">$3,234.56</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">APY</span>
                  <span className="text-green-500">15.4%</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Fees Earned</span>
                  <span className="font-semibold">$98.67</span>
                </div>
              </div>
            </div>

            <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 hover:border-blue-500 transition-colors cursor-pointer">
              <div className="flex justify-between items-start mb-4">
                <div>
                  <h3 className="text-xl font-bold">AVAX / USDC</h3>
                  <p className="text-gray-400 text-sm">Trader Joe • Avalanche</p>
                </div>
                <span className="bg-green-500/10 text-green-500 px-3 py-1 rounded-full text-sm">In Range</span>
              </div>
              <div className="space-y-2">
                <div className="flex justify-between">
                  <span className="text-gray-400">Position Value</span>
                  <span className="font-semibold">$1,567.89</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">APY</span>
                  <span className="text-green-500">22.1%</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Fees Earned</span>
                  <span className="font-semibold">$67.34</span>
                </div>
              </div>
            </div>

            <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 hover:border-blue-500 transition-colors cursor-pointer">
              <div className="flex justify-between items-start mb-4">
                <div>
                  <h3 className="text-xl font-bold">SOL / USDC</h3>
                  <p className="text-gray-400 text-sm">Raydium • Solana</p>
                </div>
                <span className="bg-green-500/10 text-green-500 px-3 py-1 rounded-full text-sm">In Range</span>
              </div>
              <div className="space-y-2">
                <div className="flex justify-between">
                  <span className="text-gray-400">Position Value</span>
                  <span className="font-semibold">$620.94</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">APY</span>
                  <span className="text-green-500">45.6%</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Fees Earned</span>
                  <span className="font-semibold">$21.52</span>
                </div>
              </div>
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}