"use client";

import { useState, useEffect, useRef } from "react";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { useWallet } from "@solana/wallet-adapter-react";
import type { WalletName } from "@solana/wallet-adapter-base";
import { useCurrentAccount, useWallets, useConnectWallet, useDisconnectWallet } from "@mysten/dapp-kit";
import { useWalletAuth } from "./contexts/WalletAuthContext";
import Link from "next/link";

export default function Navbar() {
  const { address, isConnected } = useAccount();
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();

  // Solana adapter — used ONLY for mechanics: wallet list, select, connect, disconnect.
  // Never read connected or publicKey from the adapter for display: a locked Phantom
  // wallet keeps those truthy via Wallet Standard silent reconnect.
  const {
    select,
    connect: connectSolana,
    disconnect: disconnectSolana,
    connected: adapterSolanaConnected,
    publicKey: adapterPublicKey,
    wallets: solanaWallets,
  } = useWallet();

  // Sui adapter — used ONLY for mechanics: wallet list, connect, disconnect.
  // @mysten/dapp-kit persists the last connected wallet; useCurrentAccount() can
  // return an account on page load without user action, so we never use it for display.
  const adapterSuiAccount = useCurrentAccount();
  const suiWallets = useWallets();
  const { mutateAsync: connectSuiAsync } = useConnectWallet();
  const { mutate: disconnectSui } = useDisconnectWallet();

  // Our source of truth — only set after explicit user-initiated connect.
  const { solanaAddress, setSolanaAddress, suiAddress, setSuiAddress } = useWalletAuth();

  const [showEvmModal, setShowEvmModal] = useState(false);
  const [showSolanaModal, setShowSolanaModal] = useState(false);
  const [showSuiModal, setShowSuiModal] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [showMobileMenu, setShowMobileMenu] = useState(false);
  useEffect(() => setMounted(true), []);

  // --- Solana connection tracking ---
  // Set to true during an in-progress explicit connect so the effect below
  // knows to capture publicKey once the adapter state updates.
  const awaitingSolanaConnect = useRef(false);

  useEffect(() => {
    if (awaitingSolanaConnect.current && adapterSolanaConnected && adapterPublicKey) {
      setSolanaAddress(adapterPublicKey.toBase58());
      awaitingSolanaConnect.current = false;
    }
  }, [adapterSolanaConnected, adapterPublicKey, setSolanaAddress]);

  // Clear if adapter disconnects mid-session (e.g. wallet emits accounts-change).
  useEffect(() => {
    if (!adapterSolanaConnected && solanaAddress) {
      setSolanaAddress(null);
    }
  }, [adapterSolanaConnected, solanaAddress, setSolanaAddress]);

  // --- Sui connection tracking ---
  const awaitingSuiConnect = useRef(false);

  useEffect(() => {
    if (awaitingSuiConnect.current && adapterSuiAccount) {
      setSuiAddress(adapterSuiAccount.address);
      awaitingSuiConnect.current = false;
    }
  }, [adapterSuiAccount, setSuiAddress]);

  // Clear if adapter disconnects mid-session.
  useEffect(() => {
    if (!adapterSuiAccount && suiAddress) {
      setSuiAddress(null);
    }
  }, [adapterSuiAccount, suiAddress, setSuiAddress]);

  // --- Connect handlers ---
  const handleEvmConnect = (connectorIndex: number) => {
    connect({ connector: connectors[connectorIndex] });
    setShowEvmModal(false);
  };

  const handleSolanaConnect = async (walletName: string) => {
    try {
      select(walletName as WalletName);
      awaitingSolanaConnect.current = true;
      await connectSolana();
      // Address captured by the useEffect above once React re-renders.
    } catch (err) {
      awaitingSolanaConnect.current = false;
      console.error("Solana connect error:", err);
    }
    setShowSolanaModal(false);
  };

  const handleSolanaDisconnect = () => {
    setSolanaAddress(null);
    disconnectSolana();
  };

  const handleSuiConnect = async (wallet: (typeof suiWallets)[0]) => {
    try {
      awaitingSuiConnect.current = true;
      await connectSuiAsync({ wallet });
      // Address captured by the useEffect above once adapterSuiAccount updates.
    } catch (err) {
      awaitingSuiConnect.current = false;
      console.error("Sui connect error:", err);
    }
    setShowSuiModal(false);
  };

  const handleSuiDisconnect = () => {
    setSuiAddress(null);
    disconnectSui();
  };

  const truncateAddress = (addr: string) => addr.slice(0, 6) + "..." + addr.slice(-4);

  return (
    <>
      <nav className="fixed top-0 left-0 right-0 z-50 bg-[#0a0f0d]/90 backdrop-blur-sm border-b border-emerald-400/15">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            {/* Logo */}
            <Link href="/" className="flex-shrink-0">
              <h1 className="text-2xl font-bold text-white">DefiDesh</h1>
            </Link>

            {/* Desktop Navigation */}
            <div className="hidden md:flex items-center space-x-8">
              <Link href="/" className="text-emerald-300/80 hover:text-emerald-300 transition-colors">Home</Link>
              <Link href="/dashboard" className="text-emerald-300/80 hover:text-emerald-300 transition-colors">Dashboard</Link>
              <Link href="/analytics" className="text-emerald-300/80 hover:text-emerald-300 transition-colors">Analytics</Link>
              <Link href="/about" className="text-emerald-300/80 hover:text-emerald-300 transition-colors">About</Link>
              <Link href="/wallet" className="text-emerald-300/80 hover:text-emerald-300 transition-colors">Wallet</Link>
              <Link href="/watched" className="text-emerald-300/80 hover:text-emerald-300 transition-colors">Watched</Link>

              {/* EVM Wallet */}
              {mounted && isConnected && address ? (
                <div className="flex items-center space-x-2">
                  <span className="bg-emerald-950 border border-emerald-400/30 text-emerald-400 px-3 py-1.5 rounded-lg text-sm font-mono">
                    {truncateAddress(address)}
                  </span>
                  <button onClick={() => disconnect()} className="text-emerald-300/70 hover:text-red-400 text-sm transition-colors">✕</button>
                </div>
              ) : (
                mounted && (
                  <button
                    onClick={() => setShowEvmModal(true)}
                    className="bg-emerald-700 hover:bg-emerald-600 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                  >
                    Connect EVM
                  </button>
                )
              )}

              {/* Solana Wallet */}
              {mounted && solanaAddress ? (
                <div className="flex items-center space-x-2">
                  <span className="bg-[#0a1f17] border border-purple-700 text-purple-400 px-3 py-1.5 rounded-lg text-sm font-mono whitespace-nowrap">
                    ◎ {truncateAddress(solanaAddress)}
                  </span>
                  <button onClick={handleSolanaDisconnect} className="text-emerald-300/70 hover:text-red-400 text-sm transition-colors">✕</button>
                </div>
              ) : (
                mounted && (
                  <button
                    onClick={() => setShowSolanaModal(true)}
                    className="bg-purple-700 hover:bg-purple-600 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                  >
                    Connect Solana
                  </button>
                )
              )}

              {/* Sui Wallet */}
              {mounted && suiAddress ? (
                <div className="flex items-center space-x-2">
                  <span className="bg-[#0a1f17] border border-cyan-700 text-cyan-400 px-3 py-1.5 rounded-lg text-sm font-mono whitespace-nowrap">
                    ◈ {truncateAddress(suiAddress)}
                  </span>
                  <button onClick={handleSuiDisconnect} className="text-emerald-300/70 hover:text-red-400 text-sm transition-colors">✕</button>
                </div>
              ) : (
                mounted && (
                  <button
                    onClick={() => suiWallets.length > 0 ? setShowSuiModal(true) : undefined}
                    className="bg-cyan-700 hover:bg-cyan-600 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                  >
                    Connect Sui
                  </button>
                )
              )}
            </div>

            {/* Mobile Menu Button */}
            <button onClick={() => setShowMobileMenu(!showMobileMenu)} className="md:hidden text-emerald-300/80 hover:text-emerald-300">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                {showMobileMenu ? (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                ) : (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                )}
              </svg>
            </button>
          </div>

          {/* Mobile Menu */}
          {showMobileMenu && (
            <div className="md:hidden pb-4 space-y-2">
              <Link href="/" className="block text-emerald-300/80 hover:text-emerald-300 py-2">Home</Link>
              <Link href="/dashboard" className="block text-emerald-300/80 hover:text-emerald-300 py-2">Dashboard</Link>
              <Link href="/analytics" className="block text-emerald-300/80 hover:text-emerald-300 py-2">Analytics</Link>
              <Link href="/about" className="block text-emerald-300/80 hover:text-emerald-300 py-2">About</Link>
              <Link href="/watched" className="block text-emerald-300/80 hover:text-emerald-300 py-2">Watched</Link>

              {/* EVM — mobile */}
              {isConnected && address ? (
                <div className="flex items-center justify-between py-2">
                  <span className="text-green-400 text-sm font-mono">{truncateAddress(address)}</span>
                  <button onClick={() => disconnect()} className="text-red-400 text-sm">Disconnect EVM</button>
                </div>
              ) : (
                <button
                  onClick={() => { setShowEvmModal(true); setShowMobileMenu(false); }}
                  className="w-full bg-emerald-700 hover:bg-emerald-600 text-white px-4 py-2 rounded-lg text-sm font-medium"
                >
                  Connect EVM
                </button>
              )}

              {/* Solana — mobile */}
              {solanaAddress ? (
                <div className="flex items-center justify-between py-2">
                  <span className="text-purple-400 text-sm font-mono">◎ {truncateAddress(solanaAddress)}</span>
                  <button onClick={handleSolanaDisconnect} className="text-red-400 text-sm">Disconnect Solana</button>
                </div>
              ) : (
                <button
                  onClick={() => { setShowSolanaModal(true); setShowMobileMenu(false); }}
                  className="w-full bg-purple-700 hover:bg-purple-600 text-white px-4 py-2 rounded-lg text-sm font-medium"
                >
                  Connect Solana
                </button>
              )}

              {/* Sui — mobile */}
              {suiAddress ? (
                <div className="flex items-center justify-between py-2">
                  <span className="text-cyan-400 text-sm font-mono">🌊 {truncateAddress(suiAddress)}</span>
                  <button onClick={handleSuiDisconnect} className="text-red-400 text-sm">Disconnect Sui</button>
                </div>
              ) : (
                <button
                  onClick={() => { setShowSuiModal(true); setShowMobileMenu(false); }}
                  className="w-full bg-cyan-700 hover:bg-cyan-600 text-white px-4 py-2 rounded-lg text-sm font-medium"
                >
                  Connect Sui
                </button>
              )}
            </div>
          )}
        </div>
      </nav>

      {/* EVM Wallet Modal */}
      {showEvmModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setShowEvmModal(false)} />
          <div className="relative bg-[#0a1f17] border border-emerald-400/20 rounded-2xl p-6 w-full max-w-sm mx-4">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-bold text-white">Connect EVM Wallet</h2>
              <button onClick={() => setShowEvmModal(false)} className="text-emerald-300/70 hover:text-white">✕</button>
            </div>
            <div className="space-y-3">
              {connectors.map((connector, index) => (
                <button
                  key={connector.id}
                  onClick={() => handleEvmConnect(index)}
                  className="w-full flex items-center space-x-4 bg-emerald-950/50 hover:bg-emerald-900/50 border border-emerald-400/10 hover:border-emerald-400/30 rounded-xl p-4 transition-colors"
                >
                  <span className="text-2xl">{connector.name === "MetaMask" ? "🦊" : "🔗"}</span>
                  <div className="text-left">
                    <p className="text-white font-medium">{connector.name}</p>
                    <p className="text-emerald-300/70 text-xs">Connect with browser extension</p>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Solana Wallet Modal */}
      {showSolanaModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setShowSolanaModal(false)} />
          <div className="relative bg-[#0a1f17] border border-purple-700/50 rounded-2xl p-6 w-full max-w-sm mx-4">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-bold text-white">Connect Solana Wallet</h2>
              <button onClick={() => setShowSolanaModal(false)} className="text-emerald-300/70 hover:text-white">✕</button>
            </div>
            {solanaWallets.length === 0 ? (
              <p className="text-emerald-300/70 text-sm text-center py-4">
                No Solana wallet detected. Install a Solana-compatible wallet (e.g. Phantom, Backpack, Solflare).
              </p>
            ) : (
              <div className="space-y-3">
                {solanaWallets.map((wallet) => (
                  <button
                    key={wallet.adapter.name}
                    onClick={() => handleSolanaConnect(wallet.adapter.name)}
                    className="w-full flex items-center space-x-4 bg-emerald-950/50 hover:bg-emerald-900/50 border border-emerald-400/10 hover:border-purple-700 rounded-xl p-4 transition-colors"
                  >
                    {wallet.adapter.icon && (
                      <img src={wallet.adapter.icon} alt={wallet.adapter.name} className="w-8 h-8 rounded-lg" />
                    )}
                    <div className="text-left">
                      <p className="text-white font-medium">{wallet.adapter.name}</p>
                      <p className="text-emerald-300/70 text-xs">Connect with {wallet.adapter.name}</p>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Sui Wallet Modal */}
      {showSuiModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setShowSuiModal(false)} />
          <div className="relative bg-[#0a1f17] border border-cyan-700/50 rounded-2xl p-6 w-full max-w-sm mx-4">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-bold text-white">Connect Sui Wallet</h2>
              <button onClick={() => setShowSuiModal(false)} className="text-emerald-300/70 hover:text-white">✕</button>
            </div>
            {suiWallets.length === 0 ? (
              <p className="text-emerald-300/70 text-sm text-center py-4">
                No Sui wallet detected. Install a Sui-compatible wallet (e.g. Phantom, Suiet, Slush).
              </p>
            ) : (
              <div className="space-y-3">
                {suiWallets.map((wallet) => (
                  <button
                    key={wallet.name}
                    onClick={() => handleSuiConnect(wallet)}
                    className="w-full flex items-center space-x-4 bg-emerald-950/50 hover:bg-emerald-900/50 border border-emerald-400/10 hover:border-cyan-700 rounded-xl p-4 transition-colors"
                  >
                    {wallet.icon && <img src={wallet.icon} alt={wallet.name} className="w-8 h-8 rounded-lg" />}
                    <div className="text-left">
                      <p className="text-white font-medium">{wallet.name}</p>
                      <p className="text-emerald-300/70 text-xs">Connect with {wallet.name}</p>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
