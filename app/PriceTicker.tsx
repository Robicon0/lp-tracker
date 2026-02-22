"use client";

import { useState, useEffect } from "react";

interface PriceData {
  id: string;
  symbol: string;
  name: string;
  current_price: number | null;
  price_change_percentage_24h: number | null;
  image: string;
}

const COIN_IDS = "ethereum,bitcoin,usd-coin,tether,arbitrum,optimism,matic-network,avalanche-2,solana,wrapped-bitcoin";

export default function PriceTicker() {
  const [prices, setPrices] = useState<PriceData[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState("");

  const fetchPrices = async () => {
    try {
      const res = await fetch(
        `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${COIN_IDS}&order=market_cap_desc&sparkline=false`
      );
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        setPrices(data);
        setLastUpdated(new Date().toLocaleTimeString());
      }
    } catch (err) {
      // silently fail, keep showing old prices if available
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPrices();
    const interval = setInterval(fetchPrices, 60000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 mb-6">
        <div className="flex items-center space-x-2">
          <div className="w-3 h-3 bg-blue-500 rounded-full animate-pulse" />
          <span className="text-gray-400 text-sm">Loading live prices...</span>
        </div>
      </div>
    );
  }

  if (prices.length === 0) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 mb-6">
        <p className="text-gray-500 text-sm">Unable to load live prices. Will retry shortly.</p>
      </div>
    );
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 mb-6">
      <div className="flex justify-between items-center mb-3">
        <div className="flex items-center space-x-2">
          <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
          <span className="text-gray-400 text-sm font-medium">Live Prices</span>
        </div>
        <span className="text-gray-600 text-xs">Updated: {lastUpdated}</span>
      </div>
      <div className="flex flex-wrap gap-3">
        {prices.map((coin) => {
          if (coin.current_price === null || coin.current_price === undefined) return null;
          const change = coin.price_change_percentage_24h ?? 0;
          return (
            <div
              key={coin.id}
              className="flex items-center space-x-2 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2"
            >
              <img src={coin.image} alt={coin.symbol} className="w-5 h-5" />
              <span className="text-white text-sm font-medium uppercase">{coin.symbol}</span>
              <span className="text-white text-sm">
                ${coin.current_price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
              <span className={`text-xs ${change >= 0 ? "text-green-500" : "text-red-500"}`}>
                {change >= 0 ? "+" : ""}{change.toFixed(1)}%
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}