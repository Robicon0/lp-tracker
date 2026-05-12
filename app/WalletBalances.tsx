"use client";

import { useState, useEffect } from "react";
import { useAccount } from "wagmi";

interface TokenBalance {
  name: string;
  symbol: string;
  balance: string;
  logo: string;
}

const ALCHEMY_KEY = process.env.NEXT_PUBLIC_ALCHEMY_KEY;
const ALCHEMY_URL = `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`;

export default function WalletBalances() {
  const { address, isConnected } = useAccount();
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
        // Fetch ETH balance
        const ethRes = await fetch(ALCHEMY_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "eth_getBalance",
            params: [address, "latest"],
          }),
        });
        const ethData = await ethRes.json();
        const ethWei = BigInt(ethData.result);
        const ethValue = Number(ethWei) / 1e18;
        setEthBalance(ethValue.toFixed(4));

        // Fetch token balances using Alchemy's getTokenBalances
        const tokenRes = await fetch(ALCHEMY_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "alchemy_getTokenBalances",
            params: [address, "erc20"],
          }),
        });
        const tokenData = await tokenRes.json();

        if (tokenData.result && tokenData.result.tokenBalances) {
          const nonZero = tokenData.result.tokenBalances.filter(
            (t: { tokenBalance: string }) =>
              t.tokenBalance && t.tokenBalance !== "0x0000000000000000000000000000000000000000000000000000000000000000"
          );

          const top = nonZero.slice(0, 10);
          const tokenDetails: TokenBalance[] = [];

          for (const token of top) {
            try {
              const metaRes = await fetch(ALCHEMY_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  jsonrpc: "2.0",
                  id: 3,
                  method: "alchemy_getTokenMetadata",
                  params: [token.contractAddress],
                }),
              });
              const metaData = await metaRes.json();
              const meta = metaData.result;

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
            } catch {
              // Skip tokens that fail metadata fetch
            }
          }

          setTokens(tokenDetails);
        }
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
        <p className="text-gray-300 text-sm">Connect your wallet to see real token balances.</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 mb-6">
        <div className="flex items-center space-x-2">
          <div className="w-3 h-3 bg-blue-500 rounded-full animate-pulse" />
          <span className="text-gray-300 text-sm">Fetching wallet balances...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 mb-6">
        <p className="text-red-400 text-sm">{error}</p>
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
                <p className="text-gray-300 text-xs">Ethereum</p>
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
                <div className="w-6 h-6 bg-gray-600 rounded-full flex items-center justify-center text-xs">
                  {token.symbol.charAt(0)}
                </div>
              )}
              <div>
                <p className="text-white font-medium">{token.symbol}</p>
                <p className="text-gray-300 text-xs">{token.name}</p>
              </div>
            </div>
            <p className="text-white font-medium">{token.balance} {token.symbol}</p>
          </div>
        ))}

        {tokens.length === 0 && ethBalance && (
          <p className="text-gray-300 text-sm">No ERC-20 tokens found on Ethereum mainnet.</p>
        )}
      </div>
    </div>
  );
}