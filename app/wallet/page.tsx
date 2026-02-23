"use client";

import { useState, useEffect } from "react";
import { useAccount } from "wagmi";
import Navbar from "../Navbar";

interface TokenBalance {
  name: string;
  symbol: string;
  balance: string;
  logo: string;
}

const ALCHEMY_KEY = process.env.NEXT_PUBLIC_ALCHEMY_KEY;
const ALCHEMY_URL = `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`;

export default function WalletPage() {
  const { address, isConnected } = useAccount();
  const [ethBalance, setEthBalance] = useState<string | null>(null);
  const [tokens, setTokens] = useState<TokenBalance[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isConnected || !address) {
      setEthBalance(null);
      setTokens([]);
      return;
    }

    const fetchBalances = async () => {
      setLoading(true);
      try {
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

          const top = nonZero.slice(0, 20);
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

              if (meta && meta.symbol && meta.symbol.length < 20) {
                const rawBalance = BigInt(token.tokenBalance);
                const decimals = meta.decimals || 18;
                const balance = Number(rawBalance) / Math.pow(10, decimals);

                if (balance > 0.0001) {
                  tokenDetails.push({
                    name: meta.name && meta.name.length < 30 ? meta.name : "Unknown",
                    symbol: meta.symbol,
                    balance: balance < 1 ? balance.toFixed(6) : balance.toFixed(2),
                    logo: meta.logo || "",
                  });
                }
              }
            } catch {
              // Skip
            }
          }

          setTokens(tokenDetails);
        }
      } catch {
        // Silently fail
      } finally {
        setLoading(false);
      }
    };

    fetchBalances();
  }, [address, isConnected]);

  return (
    <div className="p-8 pt-24 bg-black text-white min-h-screen">
      <Navbar />
      <div className="max-w-4xl mx-auto">
        <h1 className="text-4xl font-bold">Wallet Balances</h1>
        <p className="text-gray-400 mt-2">Your real token balances on Ethereum mainnet</p>

        {!isConnected ? (
          <div className="mt-8 bg-gray-900 border border-gray-800 rounded-lg p-8 text-center">
            <p className="text-gray-400 text-lg">Connect your wallet to view balances</p>
            <p className="text-gray-500 text-sm mt-2">Click &quot;Connect Wallet&quot; in the navbar</p>
          </div>
        ) : loading ? (
          <div className="mt-8 bg-gray-900 border border-gray-800 rounded-lg p-8">
            <div className="flex items-center space-x-2">
              <div className="w-3 h-3 bg-blue-500 rounded-full animate-pulse" />
              <span className="text-gray-400">Fetching balances from blockchain...</span>
            </div>
          </div>
        ) : (
          <div className="mt-8">
            <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 mb-4">
              <p className="text-gray-400 text-xs mb-1">Connected Wallet</p>
              <p className="text-white font-mono text-sm">{address}</p>
            </div>

            <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-800">
                    <th className="text-left text-gray-400 text-xs font-medium px-4 py-3">Token</th>
                    <th className="text-right text-gray-400 text-xs font-medium px-4 py-3">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {ethBalance && (
                    <tr className="border-b border-gray-800/50 hover:bg-gray-800/30">
                      <td className="px-4 py-3">
                        <div className="flex items-center space-x-3">
                          <span className="text-lg">⟠</span>
                          <div>
                            <p className="text-white font-medium text-sm">ETH</p>
                            <p className="text-gray-500 text-xs">Ethereum</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right text-white text-sm">{ethBalance}</td>
                    </tr>
                  )}
                  {tokens.map((token, i) => (
                    <tr key={i} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                      <td className="px-4 py-3">
                        <div className="flex items-center space-x-3">
                          {token.logo ? (
                            <img src={token.logo} alt={token.symbol} className="w-6 h-6 rounded-full" />
                          ) : (
                            <div className="w-6 h-6 bg-gray-700 rounded-full flex items-center justify-center text-xs text-gray-300">
                              {token.symbol.charAt(0)}
                            </div>
                          )}
                          <div>
                            <p className="text-white font-medium text-sm">{token.symbol}</p>
                            <p className="text-gray-500 text-xs">{token.name}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right text-white text-sm">{token.balance}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {tokens.length === 0 && ethBalance && (
                <p className="text-gray-500 text-sm text-center py-4">No ERC-20 tokens found.</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}