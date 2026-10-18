"use client";

import { useState, useEffect } from "react";
import { useWalletAuth } from "./contexts/WalletAuthContext";

interface TokenBalance {
  name: string;
  symbol: string;
  balance: string;
  logo: string;
}

// Balances come from our own route (/api/evm/token-balances): no Alchemy call
// and no key in the browser (batch C 2a). (Not mounted by any page today.)

export default function WalletBalances() {
  const { evmAddress: address } = useWalletAuth();
  const isConnected = !!address;
  const [ethBalance, setEthBalance] = useState<string | null>(null);
  const [tokens, setTokens] = useState<TokenBalance[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!isConnected || !address) {
      setEthBalance(null);
      setTokens([]);
      return;
    }

    const fetchBalances = async () => {
      setLoading(true);
      setError("");

      try {
        const res = await fetch(`/api/evm/token-balances?address=${encodeURIComponent(address)}&chain=ethereum&limit=10`);
        if (!res.ok) throw new Error(`token-balances ${res.status}`);
        const j = (await res.json()) as { nativeHex: string; tokens: Array<{ tokenBalance: string; meta: { symbol: string | null; decimals: number | null; name: string | null; logo: string | null } | null }> };
        const ethWei = BigInt(j.nativeHex);
        const ethValue = Number(ethWei) / 1e18;
        setEthBalance(ethValue.toFixed(4));

        const tokenDetails: TokenBalance[] = [];
        for (const token of j.tokens) {
          const meta = token.meta;
          if (meta && meta.symbol) {
            const rawBalance = BigInt(token.tokenBalance);
            const decimals = meta.decimals || 18;
            const balance = Number(rawBalance) / Math.pow(10, decimals);
            if (balance > 0.0001) {
              tokenDetails.push({
                name: meta.name || "Unknown",
                symbol: meta.symbol || "???",
                balance: balance < 1 ? balance.toFixed(6) : balance.toFixed(2),
                logo: meta.logo || "",
              });
            }
          }
        }
        setTokens(tokenDetails);
      } catch (err) {
        setError("Failed to fetch balances. Please try again.");
      } finally {
        setLoading(false);
      }
    };

    fetchBalances();
  }, [address, isConnected]);

  if (!isConnected) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 mb-6">
        <p className="text-gray-300 text-base">Connect your wallet to see real token balances.</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 mb-6">
        <div className="flex items-center space-x-2">
          <div className="w-3 h-3 bg-blue-500 rounded-full animate-pulse" />
          <span className="text-gray-300 text-base">Fetching wallet balances...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 mb-6">
        <p className="text-red-400 text-base">{error}</p>
      </div>
    );
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 mb-6">
      <h3 className="text-lg font-bold mb-4">Wallet Balances (Ethereum)</h3>

      <div className="space-y-3">
        {ethBalance && (
          <div className="flex items-center justify-between bg-gray-800 border border-gray-700 rounded-lg px-4 py-3">
            <div className="flex items-center space-x-3">
              <span className="text-xl">⟠</span>
              <div>
                <p className="text-white font-medium">ETH</p>
                <p className="text-gray-300 text-sm">Ethereum</p>
              </div>
            </div>
            <p className="text-white font-medium">{ethBalance} ETH</p>
          </div>
        )}

        {tokens.map((token, i) => (
          <div
            key={i}
            className="flex items-center justify-between bg-gray-800 border border-gray-700 rounded-lg px-4 py-3"
          >
            <div className="flex items-center space-x-3">
              {token.logo ? (
                <img src={token.logo} alt={token.symbol} className="w-6 h-6 rounded-full" />
              ) : (
                <div className="w-6 h-6 bg-gray-600 rounded-full flex items-center justify-center text-sm">
                  {token.symbol.charAt(0)}
                </div>
              )}
              <div>
                <p className="text-white font-medium">{token.symbol}</p>
                <p className="text-gray-300 text-sm">{token.name}</p>
              </div>
            </div>
            <p className="text-white font-medium">{token.balance} {token.symbol}</p>
          </div>
        ))}

        {tokens.length === 0 && ethBalance && (
          <p className="text-gray-300 text-base">No ERC-20 tokens found on Ethereum mainnet.</p>
        )}
      </div>
    </div>
  );
}