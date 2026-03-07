"use client";

import { useState, useEffect } from "react";
import { useAccount } from "wagmi";
import { useWalletAuth } from "../contexts/WalletAuthContext";
import Navbar from "../Navbar";

interface TokenBalance {
  name: string;
  symbol: string;
  balance: string;
  logo: string;
}

interface ChainBalances {
  chain: string;
  nativeSymbol: string;
  nativeBalance: string | null;
  tokens: TokenBalance[];
}

const ALCHEMY_KEY = process.env.NEXT_PUBLIC_ALCHEMY_KEY;

const CHAINS = [
  { name: "Ethereum", nativeSymbol: "ETH", url: `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}` },
  { name: "Base", nativeSymbol: "ETH", url: `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}` },
  { name: "Arbitrum", nativeSymbol: "ETH", url: `https://arb-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}` },
  { name: "Optimism", nativeSymbol: "ETH", url: `https://opt-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}` },
  { name: "Polygon", nativeSymbol: "POL", url: `https://polygon-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}` },
];

async function fetchChainBalances(address: string, chain: typeof CHAINS[0]): Promise<ChainBalances> {
  const post = (body: object) =>
    fetch(chain.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => r.json());

  // Native balance
  const ethData = await post({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [address, "latest"] });
  const ethWei = BigInt(ethData.result ?? "0x0");
  const nativeBalance = (Number(ethWei) / 1e18).toFixed(4);

  // ERC-20 balances
  let tokens: TokenBalance[] = [];
  try {
    const tokenData = await post({ jsonrpc: "2.0", id: 2, method: "alchemy_getTokenBalances", params: [address, "erc20"] });
    const nonZero = (tokenData.result?.tokenBalances ?? []).filter(
      (t: { tokenBalance: string }) =>
        t.tokenBalance && t.tokenBalance !== "0x0000000000000000000000000000000000000000000000000000000000000000"
    );

    const top = nonZero.slice(0, 20);
    for (const token of top) {
      try {
        const metaData = await post({ jsonrpc: "2.0", id: 3, method: "alchemy_getTokenMetadata", params: [(token as { contractAddress: string }).contractAddress] });
        const meta = metaData.result;
        if (meta?.symbol && meta.symbol.length < 20) {
          const rawBalance = BigInt((token as { tokenBalance: string }).tokenBalance);
          const decimals = meta.decimals || 18;
          const balance = Number(rawBalance) / Math.pow(10, decimals);
          if (balance > 0.0001) {
            tokens.push({
              name: meta.name && meta.name.length < 30 ? meta.name : "Unknown",
              symbol: meta.symbol,
              balance: balance < 1 ? balance.toFixed(6) : balance.toFixed(2),
              logo: meta.logo || "",
            });
          }
        }
      } catch { /* skip bad token */ }
    }
  } catch { /* skip if chain doesn't support */ }

  return { chain: chain.name, nativeSymbol: chain.nativeSymbol, nativeBalance, tokens };
}

interface SolanaBalances {
  solBalance: string;
  tokens: { mint: string; symbol: string; name: string; balance: string }[];
}

interface SuiBalances {
  suiBalance: string;
  tokens: { coinType: string; symbol: string; name: string; balance: string }[];
}

export default function WalletPage() {
  const { address, isConnected } = useAccount();
  const { solanaAddress, suiAddress } = useWalletAuth();

  const [chainBalances, setChainBalances] = useState<ChainBalances[]>([]);
  const [solanaBalances, setSolanaBalances] = useState<SolanaBalances | null>(null);
  const [suiBalances, setSuiBalances] = useState<SuiBalances | null>(null);
  const [loading, setLoading] = useState(false);
  const [solanaLoading, setSolanaLoading] = useState(false);
  const [suiLoading, setSuiLoading] = useState(false);

  useEffect(() => {
    if (!isConnected || !address) {
      setChainBalances([]);
      return;
    }

    const fetchAll = async () => {
      setLoading(true);
      try {
        const results = await Promise.all(CHAINS.map((c) => fetchChainBalances(address, c)));
        // Only show chains with non-zero native balance or tokens
        const nonEmpty = results.filter(
          (r) => r.nativeBalance !== "0.0000" || r.tokens.length > 0
        );
        setChainBalances(nonEmpty.length > 0 ? nonEmpty : results.slice(0, 1));
      } catch { /* silently fail */ }
      finally { setLoading(false); }
    };

    fetchAll();
  }, [address, isConnected]);

  useEffect(() => {
    if (!solanaAddress) {
      setSolanaBalances(null);
      return;
    }
    setSolanaLoading(true);
    fetch(`/api/solana/balances?account=${solanaAddress}`)
      .then((r) => r.json())
      .then((data) => setSolanaBalances(data.error ? null : data))
      .catch(() => setSolanaBalances(null))
      .finally(() => setSolanaLoading(false));
  }, [solanaAddress]);

  useEffect(() => {
    if (!suiAddress) {
      setSuiBalances(null);
      return;
    }
    setSuiLoading(true);
    fetch(`/api/sui/balances?account=${suiAddress}`)
      .then((r) => r.json())
      .then((data) => setSuiBalances(data.error ? null : data))
      .catch(() => setSuiBalances(null))
      .finally(() => setSuiLoading(false));
  }, [suiAddress]);

  return (
    <div className="p-8 pt-24 bg-black text-white min-h-screen">
      <Navbar />
      <div className="max-w-4xl mx-auto">
        <h1 className="text-4xl font-bold">Wallet Balances</h1>
        <p className="text-gray-400 mt-2">Token balances across all supported chains</p>

        {!isConnected && !solanaAddress && !suiAddress ? (
          <div className="mt-8 bg-gray-900 border border-gray-800 rounded-lg p-8 text-center">
            <p className="text-gray-400 text-lg">Connect a wallet to view balances</p>
            <p className="text-gray-500 text-sm mt-2">Use &quot;Connect EVM&quot;, &quot;Connect Phantom&quot;, or &quot;Connect Sui&quot; in the navbar</p>
          </div>
        ) : (
          <div className="mt-8 space-y-6">
            {/* EVM section */}
            {address && (
              <div className="space-y-3">
                <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
                  <p className="text-gray-400 text-xs mb-1">EVM Wallet</p>
                  <p className="text-white font-mono text-sm">{address}</p>
                </div>
                {loading ? (
                  <div className="bg-gray-900 border border-gray-800 rounded-lg p-6">
                    <div className="flex items-center space-x-2">
                      <div className="w-3 h-3 bg-blue-500 rounded-full animate-pulse" />
                      <span className="text-gray-400">Fetching EVM balances...</span>
                    </div>
                  </div>
                ) : chainBalances.map((cb) => (
                  <div key={cb.chain} className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
                    <div className="px-4 py-3 border-b border-gray-800 bg-gray-800/40">
                      <span className="text-white font-semibold text-sm">{cb.chain}</span>
                    </div>
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-gray-800">
                          <th className="text-left text-gray-400 text-xs font-medium px-4 py-3">Token</th>
                          <th className="text-right text-gray-400 text-xs font-medium px-4 py-3">Balance</th>
                        </tr>
                      </thead>
                      <tbody>
                        {cb.nativeBalance && cb.nativeBalance !== "0.0000" && (
                          <tr className="border-b border-gray-800/50 hover:bg-gray-800/30">
                            <td className="px-4 py-3">
                              <div className="flex items-center space-x-3">
                                <span className="text-lg">⟠</span>
                                <div>
                                  <p className="text-white font-medium text-sm">{cb.nativeSymbol}</p>
                                  <p className="text-gray-500 text-xs">{cb.chain} native</p>
                                </div>
                              </div>
                            </td>
                            <td className="px-4 py-3 text-right text-white text-sm">{cb.nativeBalance}</td>
                          </tr>
                        )}
                        {cb.tokens.map((token, i) => (
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
                        {cb.nativeBalance === "0.0000" && cb.tokens.length === 0 && (
                          <tr>
                            <td colSpan={2} className="px-4 py-4 text-center text-gray-500 text-sm">No tokens found on {cb.chain}</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
            )}

            {/* Solana section */}
            {solanaAddress && (
              <div className="space-y-3">
                <div className="bg-gray-900 border border-purple-800/50 rounded-lg p-4">
                  <p className="text-purple-400 text-xs mb-1">Solana Wallet (Phantom)</p>
                  <p className="text-white font-mono text-sm">{solanaAddress}</p>
                </div>
                {solanaLoading ? (
                  <div className="bg-gray-900 border border-gray-800 rounded-lg p-6">
                    <div className="flex items-center space-x-2">
                      <div className="w-3 h-3 bg-purple-500 rounded-full animate-pulse" />
                      <span className="text-gray-400">Fetching Solana balances...</span>
                    </div>
                  </div>
                ) : solanaBalances ? (
                  <div className="bg-gray-900 border border-purple-800/40 rounded-lg overflow-hidden">
                    <div className="px-4 py-3 border-b border-purple-800/40 bg-purple-900/10">
                      <span className="text-purple-300 font-semibold text-sm">Solana</span>
                    </div>
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-gray-800">
                          <th className="text-left text-gray-400 text-xs font-medium px-4 py-3">Token</th>
                          <th className="text-right text-gray-400 text-xs font-medium px-4 py-3">Balance</th>
                        </tr>
                      </thead>
                      <tbody>
                        {solanaBalances.solBalance !== "0.0000" && (
                          <tr className="border-b border-gray-800/50 hover:bg-gray-800/30">
                            <td className="px-4 py-3">
                              <div className="flex items-center space-x-3">
                                <span className="text-lg">◎</span>
                                <div>
                                  <p className="text-white font-medium text-sm">SOL</p>
                                  <p className="text-gray-500 text-xs">Solana native</p>
                                </div>
                              </div>
                            </td>
                            <td className="px-4 py-3 text-right text-white text-sm">{solanaBalances.solBalance}</td>
                          </tr>
                        )}
                        {solanaBalances.tokens.map((token, i) => (
                          <tr key={i} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                            <td className="px-4 py-3">
                              <div className="flex items-center space-x-3">
                                <div className="w-6 h-6 bg-purple-900/40 rounded-full flex items-center justify-center text-xs text-purple-300">
                                  {token.symbol.charAt(0)}
                                </div>
                                <div>
                                  <p className="text-white font-medium text-sm">{token.symbol}</p>
                                  <p className="text-gray-500 text-xs">{token.name}</p>
                                </div>
                              </div>
                            </td>
                            <td className="px-4 py-3 text-right text-white text-sm">{token.balance}</td>
                          </tr>
                        ))}
                        {solanaBalances.solBalance === "0.0000" && solanaBalances.tokens.length === 0 && (
                          <tr>
                            <td colSpan={2} className="px-4 py-4 text-center text-gray-500 text-sm">No tokens found on Solana</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                ) : null}
              </div>
            )}

            {/* Sui section */}
            {suiAddress && (
              <div className="space-y-3">
                <div className="bg-gray-900 border border-cyan-800/50 rounded-lg p-4">
                  <p className="text-cyan-400 text-xs mb-1">Sui Wallet</p>
                  <p className="text-white font-mono text-sm">{suiAddress}</p>
                </div>
                {suiLoading ? (
                  <div className="bg-gray-900 border border-gray-800 rounded-lg p-6">
                    <div className="flex items-center space-x-2">
                      <div className="w-3 h-3 bg-cyan-500 rounded-full animate-pulse" />
                      <span className="text-gray-400">Fetching Sui balances...</span>
                    </div>
                  </div>
                ) : suiBalances ? (
                  <div className="bg-gray-900 border border-cyan-800/40 rounded-lg overflow-hidden">
                    <div className="px-4 py-3 border-b border-cyan-800/40 bg-cyan-900/10">
                      <span className="text-cyan-300 font-semibold text-sm">Sui</span>
                    </div>
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-gray-800">
                          <th className="text-left text-gray-400 text-xs font-medium px-4 py-3">Token</th>
                          <th className="text-right text-gray-400 text-xs font-medium px-4 py-3">Balance</th>
                        </tr>
                      </thead>
                      <tbody>
                        {suiBalances.suiBalance !== "0.0000" && (
                          <tr className="border-b border-gray-800/50 hover:bg-gray-800/30">
                            <td className="px-4 py-3">
                              <div className="flex items-center space-x-3">
                                <span className="text-lg">🌊</span>
                                <div>
                                  <p className="text-white font-medium text-sm">SUI</p>
                                  <p className="text-gray-500 text-xs">Sui native</p>
                                </div>
                              </div>
                            </td>
                            <td className="px-4 py-3 text-right text-white text-sm">{suiBalances.suiBalance}</td>
                          </tr>
                        )}
                        {suiBalances.tokens.map((token, i) => (
                          <tr key={i} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                            <td className="px-4 py-3">
                              <div className="flex items-center space-x-3">
                                <div className="w-6 h-6 bg-cyan-900/40 rounded-full flex items-center justify-center text-xs text-cyan-300">
                                  {token.symbol.charAt(0)}
                                </div>
                                <div>
                                  <p className="text-white font-medium text-sm">{token.symbol}</p>
                                  <p className="text-gray-500 text-xs">{token.name}</p>
                                </div>
                              </div>
                            </td>
                            <td className="px-4 py-3 text-right text-white text-sm">{token.balance}</td>
                          </tr>
                        ))}
                        {suiBalances.suiBalance === "0.0000" && suiBalances.tokens.length === 0 && (
                          <tr>
                            <td colSpan={2} className="px-4 py-4 text-center text-gray-500 text-sm">No tokens found on Sui</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                ) : null}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
