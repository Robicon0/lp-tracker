"use client";

import { useState, useEffect } from "react";
import { useWalletAuth } from "../contexts/WalletAuthContext";
import Navbar from "../Navbar";
import { reportSuiRead, SUI_UNAVAILABLE_TEXT } from "../lib/enumerationTruncation";

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
  /** The balance read failed: shown as failed, never as an empty wallet. */
  failed?: boolean;
}

// Balances come from our own route (/api/evm/token-balances): the browser makes
// no Alchemy call and the key is not in the bundle (batch C 2a).
const CHAINS = [
  { name: "Ethereum", nativeSymbol: "ETH", param: "ethereum" },
  { name: "Base", nativeSymbol: "ETH", param: "base" },
  { name: "Arbitrum", nativeSymbol: "ETH", param: "arbitrum" },
  { name: "Optimism", nativeSymbol: "ETH", param: "optimism" },
  { name: "Polygon", nativeSymbol: "POL", param: "polygon" },
];

async function fetchChainBalances(address: string, chain: typeof CHAINS[0]): Promise<ChainBalances> {
  const res = await fetch(`/api/evm/token-balances?address=${encodeURIComponent(address)}&chain=${chain.param}&limit=20`);
  // A failed read is shown as failed (rule (e)), never as an empty wallet.
  if (!res.ok) return { chain: chain.name, nativeSymbol: chain.nativeSymbol, nativeBalance: null, tokens: [], failed: true };
  const j = (await res.json()) as { nativeHex: string; tokens: Array<{ tokenBalance: string; meta: { symbol: string | null; decimals: number | null; name: string | null; logo: string | null } | null }> };

  // Native balance
  const ethWei = BigInt(j.nativeHex ?? "0x0");
  const nativeBalance = (Number(ethWei) / 1e18).toFixed(4);

  // ERC-20 balances (first 20 non-zero, in Alchemy's order, as before)
  const tokens: TokenBalance[] = [];
  for (const token of j.tokens) {
    const meta = token.meta;
    if (meta?.symbol && meta.symbol.length < 20) {
      const rawBalance = BigInt(token.tokenBalance);
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
  }

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
  const { evmAddress: address, solanaAddress, suiAddress } = useWalletAuth();
  const isConnected = !!address;

  const [chainBalances, setChainBalances] = useState<ChainBalances[]>([]);
  const [solanaBalances, setSolanaBalances] = useState<SolanaBalances | null>(null);
  const [suiBalances, setSuiBalances] = useState<SuiBalances | null>(null);
  const [loading, setLoading] = useState(false);
  const [solanaLoading, setSolanaLoading] = useState(false);
  const [suiLoading, setSuiLoading] = useState(false);
  const [suiFailed, setSuiFailed] = useState(false);

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
    setSuiFailed(false);
    fetch(`/api/sui/balances?account=${suiAddress}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`sui balances ${r.status}`))))
      .then((data) => { setSuiBalances(data); setSuiFailed(false); reportSuiRead("balances", suiAddress, true); })
      // A failed read is never an empty balance (rule (e)).
      .catch(() => { setSuiBalances(null); setSuiFailed(true); reportSuiRead("balances", suiAddress, false); })
      .finally(() => setSuiLoading(false));
  }, [suiAddress]);

  return (
    <div className="p-8 pt-24 text-white min-h-screen">
      <Navbar />
      <div className="max-w-4xl mx-auto">
        <h1 className="text-4xl font-bold">Wallet Balances</h1>
        <p className="text-emerald-300/70 mt-2">Token balances across all supported chains</p>

        {!isConnected && !solanaAddress && !suiAddress ? (
          <div className="mt-8 bg-emerald-950/30 border border-emerald-400/15 rounded-xl p-8 text-center">
            <p className="text-emerald-300/70 text-lg">Connect a wallet to view balances</p>
            <p className="text-emerald-400/40 text-base mt-2">Use &quot;Connect EVM&quot;, &quot;Connect Phantom&quot;, or &quot;Connect Sui&quot; in the navbar</p>
          </div>
        ) : (
          <div className="mt-8 space-y-6">
            {/* EVM section */}
            {address && (
              <div className="space-y-3">
                <div className="bg-emerald-950/30 border border-emerald-400/15 rounded-xl p-4">
                  <p className="text-emerald-300/70 text-sm mb-1">EVM Wallet</p>
                  <p className="text-white font-mono text-base">{address}</p>
                </div>
                {loading ? (
                  <div className="bg-emerald-950/30 border border-emerald-400/15 rounded-xl p-6">
                    <div className="flex items-center space-x-2">
                      <div className="w-3 h-3 bg-emerald-400 rounded-full animate-pulse" />
                      <span className="text-emerald-300/70">Fetching EVM balances...</span>
                    </div>
                  </div>
                ) : chainBalances.map((cb) => (
                  <div key={cb.chain} className="bg-emerald-950/30 border border-emerald-400/15 rounded-xl overflow-hidden">
                    <div className="px-4 py-3 border-b border-emerald-400/10 bg-emerald-900/20">
                      <span className="text-white font-semibold text-base">{cb.chain}</span>
                    </div>
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-emerald-400/10">
                          <th className="text-left text-emerald-300/70 text-sm font-medium px-4 py-3">Token</th>
                          <th className="text-right text-emerald-300/70 text-sm font-medium px-4 py-3">Balance</th>
                        </tr>
                      </thead>
                      <tbody>
                        {cb.nativeBalance && cb.nativeBalance !== "0.0000" && (
                          <tr className="border-b border-emerald-400/10 hover:bg-emerald-950/30">
                            <td className="px-4 py-3">
                              <div className="flex items-center space-x-3">
                                <span className="text-lg">⟠</span>
                                <div>
                                  <p className="text-white font-medium text-base">{cb.nativeSymbol}</p>
                                  <p className="text-emerald-400/40 text-sm">{cb.chain} native</p>
                                </div>
                              </div>
                            </td>
                            <td className="px-4 py-3 text-right text-white text-base">{cb.nativeBalance}</td>
                          </tr>
                        )}
                        {cb.tokens.map((token, i) => (
                          <tr key={i} className="border-b border-emerald-400/10 hover:bg-emerald-950/30">
                            <td className="px-4 py-3">
                              <div className="flex items-center space-x-3">
                                {token.logo ? (
                                  <img src={token.logo} alt={token.symbol} className="w-6 h-6 rounded-full" />
                                ) : (
                                  <div className="w-6 h-6 bg-emerald-900/40 rounded-full flex items-center justify-center text-sm text-emerald-300">
                                    {token.symbol.charAt(0)}
                                  </div>
                                )}
                                <div>
                                  <p className="text-white font-medium text-base">{token.symbol}</p>
                                  <p className="text-emerald-400/40 text-sm">{token.name}</p>
                                </div>
                              </div>
                            </td>
                            <td className="px-4 py-3 text-right text-white text-base">{token.balance}</td>
                          </tr>
                        ))}
                        {cb.failed && (
                          <tr>
                            <td colSpan={2} className="px-4 py-4 text-center text-amber-300/80 text-base">Couldn&apos;t load {cb.chain} balances — try again shortly</td>
                          </tr>
                        )}
                        {cb.nativeBalance === "0.0000" && cb.tokens.length === 0 && (
                          <tr>
                            <td colSpan={2} className="px-4 py-4 text-center text-emerald-400/40 text-base">No tokens found on {cb.chain}</td>
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
                <div className="bg-emerald-950/30 border border-purple-800/50 rounded-xl p-4">
                  <p className="text-purple-400 text-sm mb-1">Solana Wallet (Phantom)</p>
                  <p className="text-white font-mono text-base">{solanaAddress}</p>
                </div>
                {solanaLoading ? (
                  <div className="bg-emerald-950/30 border border-emerald-400/15 rounded-xl p-6">
                    <div className="flex items-center space-x-2">
                      <div className="w-3 h-3 bg-purple-500 rounded-full animate-pulse" />
                      <span className="text-emerald-300/70">Fetching Solana balances...</span>
                    </div>
                  </div>
                ) : solanaBalances ? (
                  <div className="bg-emerald-950/30 border border-purple-800/40 rounded-xl overflow-hidden">
                    <div className="px-4 py-3 border-b border-purple-800/40 bg-purple-900/10">
                      <span className="text-purple-300 font-semibold text-base">Solana</span>
                    </div>
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-emerald-400/10">
                          <th className="text-left text-emerald-300/70 text-sm font-medium px-4 py-3">Token</th>
                          <th className="text-right text-emerald-300/70 text-sm font-medium px-4 py-3">Balance</th>
                        </tr>
                      </thead>
                      <tbody>
                        {solanaBalances.solBalance !== "0.0000" && (
                          <tr className="border-b border-emerald-400/10 hover:bg-emerald-950/30">
                            <td className="px-4 py-3">
                              <div className="flex items-center space-x-3">
                                <span className="text-lg">◎</span>
                                <div>
                                  <p className="text-white font-medium text-base">SOL</p>
                                  <p className="text-emerald-400/40 text-sm">Solana native</p>
                                </div>
                              </div>
                            </td>
                            <td className="px-4 py-3 text-right text-white text-base">{solanaBalances.solBalance}</td>
                          </tr>
                        )}
                        {solanaBalances.tokens.map((token, i) => (
                          <tr key={i} className="border-b border-emerald-400/10 hover:bg-emerald-950/30">
                            <td className="px-4 py-3">
                              <div className="flex items-center space-x-3">
                                <div className="w-6 h-6 bg-purple-900/40 rounded-full flex items-center justify-center text-sm text-purple-300">
                                  {token.symbol.charAt(0)}
                                </div>
                                <div>
                                  <p className="text-white font-medium text-base">{token.symbol}</p>
                                  <p className="text-emerald-400/40 text-sm">{token.name}</p>
                                </div>
                              </div>
                            </td>
                            <td className="px-4 py-3 text-right text-white text-base">{token.balance}</td>
                          </tr>
                        ))}
                        {solanaBalances.solBalance === "0.0000" && solanaBalances.tokens.length === 0 && (
                          <tr>
                            <td colSpan={2} className="px-4 py-4 text-center text-emerald-400/40 text-base">No tokens found on Solana</td>
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
                <div className="bg-emerald-950/30 border border-cyan-800/50 rounded-xl p-4">
                  <p className="text-cyan-400 text-sm mb-1">Sui Wallet</p>
                  <p className="text-white font-mono text-base">{suiAddress}</p>
                </div>
                {suiLoading ? (
                  <div className="bg-emerald-950/30 border border-emerald-400/15 rounded-xl p-6">
                    <div className="flex items-center space-x-2">
                      <div className="w-3 h-3 bg-cyan-500 rounded-full animate-pulse" />
                      <span className="text-emerald-300/70">Fetching Sui balances...</span>
                    </div>
                  </div>
                ) : suiBalances ? (
                  <div className="bg-emerald-950/30 border border-cyan-800/40 rounded-xl overflow-hidden">
                    <div className="px-4 py-3 border-b border-cyan-800/40 bg-cyan-900/10">
                      <span className="text-cyan-300 font-semibold text-base">Sui</span>
                    </div>
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-emerald-400/10">
                          <th className="text-left text-emerald-300/70 text-sm font-medium px-4 py-3">Token</th>
                          <th className="text-right text-emerald-300/70 text-sm font-medium px-4 py-3">Balance</th>
                        </tr>
                      </thead>
                      <tbody>
                        {suiBalances.suiBalance !== "0.0000" && (
                          <tr className="border-b border-emerald-400/10 hover:bg-emerald-950/30">
                            <td className="px-4 py-3">
                              <div className="flex items-center space-x-3">
                                <span className="text-lg">🌊</span>
                                <div>
                                  <p className="text-white font-medium text-base">SUI</p>
                                  <p className="text-emerald-400/40 text-sm">Sui native</p>
                                </div>
                              </div>
                            </td>
                            <td className="px-4 py-3 text-right text-white text-base">{suiBalances.suiBalance}</td>
                          </tr>
                        )}
                        {suiBalances.tokens.map((token, i) => (
                          <tr key={i} className="border-b border-emerald-400/10 hover:bg-emerald-950/30">
                            <td className="px-4 py-3">
                              <div className="flex items-center space-x-3">
                                <div className="w-6 h-6 bg-cyan-900/40 rounded-full flex items-center justify-center text-sm text-cyan-300">
                                  {token.symbol.charAt(0)}
                                </div>
                                <div>
                                  <p className="text-white font-medium text-base">{token.symbol}</p>
                                  <p className="text-emerald-400/40 text-sm">{token.name}</p>
                                </div>
                              </div>
                            </td>
                            <td className="px-4 py-3 text-right text-white text-base">{token.balance}</td>
                          </tr>
                        ))}
                        {suiBalances.suiBalance === "0.0000" && suiBalances.tokens.length === 0 && (
                          <tr>
                            <td colSpan={2} className="px-4 py-4 text-center text-emerald-400/40 text-base">No tokens found on Sui</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                ) : suiFailed ? (
                  <div role="status" className="border border-amber-400/40 rounded-xl p-4 text-amber-200 text-sm">
                    ⚠ {SUI_UNAVAILABLE_TEXT}
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
