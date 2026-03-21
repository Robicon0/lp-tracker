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

const COIN_IDS = "bitcoin,ethereum,solana,wrapped-bitcoin,sui,hyperliquid,coinbase-wrapped-btc,bittensor,zcash";
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
      <div className="bg-emerald-950/30 backdrop-blur-md border border-emerald-400/15 rounded-xl p-4 mb-6">
        <div className="flex justify-between items-center mb-3">
          <div className="flex items-center space-x-2">
            <div className="w-2 h-2 bg-emerald-400/30 rounded-full animate-pulse" />
            <span className="text-emerald-300/50 text-sm font-medium">Live Prices</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-3">
          {[...Array(7)].map((_, i) => (
            <div key={i} className="flex items-center space-x-2 bg-emerald-900/20 border border-emerald-400/10 rounded-lg px-3 py-2 animate-pulse">
              <div className="w-5 h-5 bg-emerald-900/50 rounded-full" />
              <div className="w-8 h-3 bg-emerald-900/50 rounded" />
              <div className="w-14 h-3 bg-emerald-900/50 rounded" />
              <div className="w-8 h-3 bg-emerald-900/40 rounded" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (prices.length === 0) {
    return (
      <div className="bg-emerald-950/30 backdrop-blur-md border border-emerald-400/15 rounded-xl p-4 mb-6">
        <p className="text-emerald-400/40 text-sm">Unable to load live prices. Will retry shortly.</p>
      </div>
    );
  }

  return (
    <div className="bg-emerald-950/30 backdrop-blur-md border border-emerald-400/15 rounded-xl p-4 mb-6">
      <div className="flex justify-between items-center mb-3">
        <div className="flex items-center space-x-2">
          <div className="w-2 h-2 bg-emerald-400 rounded-full animate-pulse" />
          <span className="text-emerald-300/70 text-sm font-medium">Live Prices</span>
        </div>
        <span className="text-emerald-400/30 text-xs">Updated: {lastUpdated}</span>
      </div>
      <div className="flex flex-wrap gap-3">
        {prices.map((coin) => {
          if (coin.current_price === null || coin.current_price === undefined) return null;
          const change = coin.price_change_percentage_24h ?? 0;
          return (
            <div
              key={coin.id}
              className="flex items-center space-x-2 bg-emerald-900/20 border border-emerald-400/10 rounded-lg px-3 py-2"
            >
              <img src={coin.image} alt={coin.symbol} className="w-5 h-5" />
              <span className="text-emerald-50 text-sm font-medium uppercase">{coin.symbol}</span>
              <span className="text-emerald-100/80 text-sm">
                ${coin.current_price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
              <span className={`text-xs ${change >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                {change >= 0 ? "+" : ""}{change.toFixed(1)}%
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}