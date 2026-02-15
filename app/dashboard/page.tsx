export default function Dashboard() {
  return (
    <div className="p-8 bg-black text-white min-h-screen">
      <h1 className="text-4xl font-bold">Portfolio Overview</h1>
      <p className="text-gray-400 mt-2">Track your DeFi liquidity positions</p>
      
      <div className="mt-8 grid grid-cols-3 gap-6">
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-6">
          <p className="text-gray-400 text-sm">Total Portfolio Value</p>
          <p className="text-3xl font-bold mt-2">$127,458.32</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-6">
          <p className="text-gray-400 text-sm">Active Positions</p>
          <p className="text-3xl font-bold mt-2">8</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-6">
          <p className="text-gray-400 text-sm">Total Fees Earned</p>
          <p className="text-3xl font-bold mt-2">$3,247.89</p>
        </div>
      </div>

      <h2 className="text-2xl font-bold mt-8 mb-4">Your Positions</h2>
      <div className="grid grid-cols-2 gap-6">
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-6">
          <h3 className="text-xl font-bold">ETH / USDC</h3>
          <p className="text-gray-400 text-sm">Uniswap V3</p>
          <p className="text-green-500 mt-4">APY: 24.3%</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-6">
          <h3 className="text-xl font-bold">WBTC / ETH</h3>
          <p className="text-gray-400 text-sm">Aerodrome</p>
          <p className="text-green-500 mt-4">APY: 18.7%</p>
        </div>
      </div>
    </div>
  );
}
