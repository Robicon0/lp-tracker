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

  // Only use the adapter for: listing wallets, calling select/connect/disconnect.
  // Never read connected or publicKey from the adapter for display — a locked
  // Phantom wallet keeps connected=true and publicKey set via Wallet Standard
  // silent reconnect, so those values are not trustworthy.
  const {
    select,
    connect: connectSolana,
    disconnect: disconnectSolana,
    connected: adapterConnected,
    publicKey: adapterPublicKey,
    wallets: solanaWallets,
  } = useWallet();

  // Sui wallet
  const suiAccount = useCurrentAccount();
  const suiAddress = suiAccount?.address;
  const suiWallets = useWallets();
  const { mutate: connectSui } = useConnectWallet();
  const { mutate: disconnectSui } = useDisconnectWallet();

  // solanaAddress is our source of truth — only set after an explicit user connect.
  const { solanaAddress, setSolanaAddress } = useWalletAuth();

  const [showEvmModal, setShowEvmModal] = useState(false);
  const [showSolanaModal, setShowSolanaModal] = useState(false);
  const [showSuiModal, setShowSuiModal] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [showMobileMenu, setShowMobileMenu] = useState(false);
  useEffect(() => setMounted(true), []);

  // Flag set during an in-progress explicit connect — used by the effect below
  // to capture publicKey once React re-renders with the updated adapter state.
  const awaitingConnect = useRef(false);

  // Capture publicKey after a user-initiated connect resolves.
  // We use an effect (not reading publicKey inline) because React hook values
  // inside an async function reflect the stale closure at render time.
  useEffect(() => {
    if (awaitingConnect.current && adapterConnected && adapterPublicKey) {
      setSolanaAddress(adapterPublicKey.toBase58());
      awaitingConnect.current = false;
    }
  }, [adapterConnected, adapterPublicKey, setSolanaAddress]);

  // If the adapter disconnects mid-session (e.g. wallet lock + Phantom emits
  // an accounts-change event with empty accounts), clear our stored address too.
  useEffect(() => {
    if (!adapterConnected && solanaAddress) {
      setSolanaAddress(null);
    }
  }, [adapterConnected, solanaAddress, setSolanaAddress]);

  const handleEvmConnect = (connectorIndex: number) => {
    connect({ connector: connectors[connectorIndex] });
    setShowEvmModal(false);
  };

  const handleSolanaConnect = async (walletName: string) => {
    try {
      select(walletName as WalletName);
      awaitingConnect.current = true;
      await connectSolana();
      // publicKey captured by the useEffect above once React re-renders
    } catch (err) {
      awaitingConnect.current = false;
      console.error("Solana connect error:", err);
    }
    setShowSolanaModal(false);
  };

  const handleSolanaDisconnect = () => {
    setSolanaAddress(null);
    disconnectSolana();
  };

  const truncateAddress = (addr: string) => addr.slice(0, 6) + "..." + addr.slice(-4);

  return (
    <>
      <nav className="fixed top-0 left-0 right-0 z-50 bg-black/80 backdrop-blur-sm border-b border-gray-800">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            {/* Logo */}
            <Link href="/" className="flex-shrink-0">
              <h1 className="text-2xl font-bold text-white">LP Tracker</h1>
            </Link>

            {/* Desktop Navigation */}
            <div className="hidden md:flex items-center space-x-8">
              <Link href="/" className="text-gray-300 hover:text-white transition-colors">Home</Link>
              <Link href="/dashboard" className="text-gray-300 hover:text-white transition-colors">Dashboard</Link>
              <Link href="/analytics" className="text-gray-300 hover:text-white transition-colors">Analytics</Link>
              <Link href="/about" className="text-gray-300 hover:text-white transition-colors">About</Link>
              <Link href="/wallet" className="text-gray-300 hover:text-white transition-colors">Wallet</Link>

              {/* EVM Wallet */}
              {mounted && isConnected && address ? (
                <div className="flex items-center space-x-2">
                  <span className="bg-gray-900 border border-gray-700 text-green-400 px-3 py-1.5 rounded-lg text-sm font-mono">
                    {truncateAddress(address)}
                  </span>
                  <button onClick={() => disconnect()} className="text-gray-400 hover:text-red-400 text-sm transition-colors">✕</button>
                </div>
              ) : (
                mounted && (
                  <button
                    onClick={() => setShowEvmModal(true)}
                    className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                  >
                    Connect EVM
                  </button>
                )
              )}

              {/* Solana Wallet */}
              {mounted && solanaAddress ? (
                <div className="flex items-center space-x-2">
                  <span className="bg-gray-900 border border-purple-700 text-purple-400 px-3 py-1.5 rounded-lg text-sm font-mono">
                    ◎ {truncateAddress(solanaAddress)}
                  </span>
                  <button onClick={handleSolanaDisconnect} className="text-gray-400 hover:text-red-400 text-sm transition-colors">✕</button>
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
                  <span className="bg-gray-900 border border-cyan-700 text-cyan-400 px-3 py-1.5 rounded-lg text-sm font-mono">
                    🌊 {truncateAddress(suiAddress)}
                  </span>
                  <button onClick={() => disconnectSui()} className="text-gray-400 hover:text-red-400 text-sm transition-colors">✕</button>
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
            <button onClick={() => setShowMobileMenu(!showMobileMenu)} className="md:hidden text-gray-300 hover:text-white">
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
              <Link href="/" className="block text-gray-300 hover:text-white py-2">Home</Link>
              <Link href="/dashboard" className="block text-gray-300 hover:text-white py-2">Dashboard</Link>
              <Link href="/analytics" className="block text-gray-300 hover:text-white py-2">Analytics</Link>
              <Link href="/about" className="block text-gray-300 hover:text-white py-2">About</Link>

              {/* EVM — mobile */}
              {isConnected && address ? (
                <div className="flex items-center justify-between py-2">
                  <span className="text-green-400 text-sm font-mono">{truncateAddress(address)}</span>
                  <button onClick={() => disconnect()} className="text-red-400 text-sm">Disconnect EVM</button>
                </div>
              ) : (
                <button
                  onClick={() => { setShowEvmModal(true); setShowMobileMenu(false); }}
                  className="w-full bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg text-sm font-medium"
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
                  <button onClick={() => disconnectSui()} className="text-red-400 text-sm">Disconnect Sui</button>
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
          <div className="relative bg-gray-900 border border-gray-700 rounded-2xl p-6 w-full max-w-sm mx-4">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-bold text-white">Connect EVM Wallet</h2>
              <button onClick={() => setShowEvmModal(false)} className="text-gray-400 hover:text-white">✕</button>
            </div>
            <div className="space-y-3">
              {connectors.map((connector, index) => (
                <button
                  key={connector.id}
                  onClick={() => handleEvmConnect(index)}
                  className="w-full flex items-center space-x-4 bg-gray-800 hover:bg-gray-700 border border-gray-700 hover:border-gray-600 rounded-xl p-4 transition-colors"
                >
                  <span className="text-2xl">{connector.name === "MetaMask" ? "🦊" : "🔗"}</span>
                  <div className="text-left">
                    <p className="text-white font-medium">{connector.name}</p>
                    <p className="text-gray-400 text-xs">Connect with browser extension</p>
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
          <div className="relative bg-gray-900 border border-purple-700/50 rounded-2xl p-6 w-full max-w-sm mx-4">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-bold text-white">Connect Solana Wallet</h2>
              <button onClick={() => setShowSolanaModal(false)} className="text-gray-400 hover:text-white">✕</button>
            </div>
            {solanaWallets.length === 0 ? (
              <p className="text-gray-400 text-sm text-center py-4">
                No Solana wallet detected. Install a Solana-compatible wallet (e.g. Phantom, Backpack, Solflare).
              </p>
            ) : (
              <div className="space-y-3">
                {solanaWallets.map((wallet) => (
                  <button
                    key={wallet.adapter.name}
                    onClick={() => handleSolanaConnect(wallet.adapter.name)}
                    className="w-full flex items-center space-x-4 bg-gray-800 hover:bg-gray-700 border border-gray-700 hover:border-purple-700 rounded-xl p-4 transition-colors"
                  >
                    {wallet.adapter.icon && (
                      <img src={wallet.adapter.icon} alt={wallet.adapter.name} className="w-8 h-8 rounded-lg" />
                    )}
                    <div className="text-left">
                      <p className="text-white font-medium">{wallet.adapter.name}</p>
                      <p className="text-gray-400 text-xs">Connect with {wallet.adapter.name}</p>
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
          <div className="relative bg-gray-900 border border-cyan-700/50 rounded-2xl p-6 w-full max-w-sm mx-4">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-bold text-white">Connect Sui Wallet</h2>
              <button onClick={() => setShowSuiModal(false)} className="text-gray-400 hover:text-white">✕</button>
            </div>
            {suiWallets.length === 0 ? (
              <p className="text-gray-400 text-sm text-center py-4">
                No Sui wallet detected. Install a Sui-compatible wallet (e.g. Phantom, Suiet, Slush).
              </p>
            ) : (
              <div className="space-y-3">
                {suiWallets.map((wallet) => (
                  <button
                    key={wallet.name}
                    onClick={() => { connectSui({ wallet }); setShowSuiModal(false); }}
                    className="w-full flex items-center space-x-4 bg-gray-800 hover:bg-gray-700 border border-gray-700 hover:border-cyan-700 rounded-xl p-4 transition-colors"
                  >
                    {wallet.icon && <img src={wallet.icon} alt={wallet.name} className="w-8 h-8 rounded-lg" />}
                    <div className="text-left">
                      <p className="text-white font-medium">{wallet.name}</p>
                      <p className="text-gray-400 text-xs">Connect with {wallet.name}</p>
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
