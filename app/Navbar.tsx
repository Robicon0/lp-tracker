"use client";

import { useState, useEffect } from "react";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { useWallet } from "@solana/wallet-adapter-react";
import type { WalletName } from "@solana/wallet-adapter-base";
import { useCurrentAccount, useWallets, useConnectWallet, useDisconnectWallet } from "@mysten/dapp-kit";
import Link from "next/link";

export default function Navbar() {
  const { address, isConnected } = useAccount();
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();
  const { select, connect: connectSolana, disconnect: disconnectSolana, publicKey } = useWallet();
  const solanaAddress = publicKey?.toBase58();

  // Sui wallet
  const suiAccount = useCurrentAccount();
  const suiAddress = suiAccount?.address;
  const suiWallets = useWallets();
  const { mutate: connectSui } = useConnectWallet();
  const { mutate: disconnectSui } = useDisconnectWallet();
  const [showSuiModal, setShowSuiModal] = useState(false);

  const [showModal, setShowModal] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const [showMobileMenu, setShowMobileMenu] = useState(false);

  const handleConnect = (connectorIndex: number) => {
    connect({ connector: connectors[connectorIndex] });
    setShowModal(false);
  };

  const handlePhantomConnect = async () => {
    try {
      select("Phantom" as WalletName);
      await connectSolana();
    } catch (err) {
      console.error("Phantom connect error:", err);
    }
  };

  const truncateAddress = (addr: string) => {
    return addr.slice(0, 6) + "..." + addr.slice(-4);
  };

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
              <Link href="/" className="text-gray-300 hover:text-white transition-colors">
                Home
              </Link>
              <Link href="/dashboard" className="text-gray-300 hover:text-white transition-colors">
                Dashboard
              </Link>
              <Link href="/analytics" className="text-gray-300 hover:text-white transition-colors">
                Analytics
              </Link>
              <Link href="/about" className="text-gray-300 hover:text-white transition-colors">
                About
              </Link>
              <Link href="/wallet" className="text-gray-300 hover:text-white transition-colors">
                Wallet
              </Link>

              {/* EVM Wallet Button */}
              {mounted && isConnected && address ? (
                <div className="flex items-center space-x-2">
                  <span className="bg-gray-900 border border-gray-700 text-green-400 px-3 py-1.5 rounded-lg text-sm font-mono">
                    {truncateAddress(address)}
                  </span>
                  <button
                    onClick={() => disconnect()}
                    className="text-gray-400 hover:text-red-400 text-sm transition-colors"
                  >
                    ✕
                  </button>
                </div>
              ) : (
                mounted && (
                  <button
                    onClick={() => setShowModal(true)}
                    className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                  >
                    Connect EVM
                  </button>
                )
              )}

              {/* Phantom / Solana Wallet Button */}
              {mounted && solanaAddress ? (
                <div className="flex items-center space-x-2">
                  <span className="bg-gray-900 border border-purple-700 text-purple-400 px-3 py-1.5 rounded-lg text-sm font-mono">
                    👻 {truncateAddress(solanaAddress)}
                  </span>
                  <button
                    onClick={() => disconnectSolana()}
                    className="text-gray-400 hover:text-red-400 text-sm transition-colors"
                  >
                    ✕
                  </button>
                </div>
              ) : (
                mounted && (
                  <button
                    onClick={handlePhantomConnect}
                    className="bg-purple-700 hover:bg-purple-600 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                  >
                    Connect Phantom
                  </button>
                )
              )}

              {/* Sui Wallet Button */}
              {mounted && suiAddress ? (
                <div className="flex items-center space-x-2">
                  <span className="bg-gray-900 border border-cyan-700 text-cyan-400 px-3 py-1.5 rounded-lg text-sm font-mono">
                    🌊 {truncateAddress(suiAddress)}
                  </span>
                  <button
                    onClick={() => disconnectSui()}
                    className="text-gray-400 hover:text-red-400 text-sm transition-colors"
                  >
                    ✕
                  </button>
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
            <button
              onClick={() => setShowMobileMenu(!showMobileMenu)}
              className="md:hidden text-gray-300 hover:text-white"
            >
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
              {/* EVM wallet — mobile */}
              {isConnected && address ? (
                <div className="flex items-center justify-between py-2">
                  <span className="text-green-400 text-sm font-mono">{truncateAddress(address)}</span>
                  <button onClick={() => disconnect()} className="text-red-400 text-sm">Disconnect EVM</button>
                </div>
              ) : (
                <button
                  onClick={() => { setShowModal(true); setShowMobileMenu(false); }}
                  className="w-full bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg text-sm font-medium"
                >
                  Connect EVM
                </button>
              )}

              {/* Phantom wallet — mobile */}
              {solanaAddress ? (
                <div className="flex items-center justify-between py-2">
                  <span className="text-purple-400 text-sm font-mono">👻 {truncateAddress(solanaAddress)}</span>
                  <button onClick={() => disconnectSolana()} className="text-red-400 text-sm">Disconnect Phantom</button>
                </div>
              ) : (
                <button
                  onClick={() => { handlePhantomConnect(); setShowMobileMenu(false); }}
                  className="w-full bg-purple-700 hover:bg-purple-600 text-white px-4 py-2 rounded-lg text-sm font-medium"
                >
                  Connect Phantom
                </button>
              )}

              {/* Sui wallet — mobile */}
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

      {/* EVM Wallet Connection Modal */}
      {showModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
            onClick={() => setShowModal(false)}
          />
          <div className="relative bg-gray-900 border border-gray-700 rounded-2xl p-6 w-full max-w-sm mx-4">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-bold text-white">Connect EVM Wallet</h2>
              <button
                onClick={() => setShowModal(false)}
                className="text-gray-400 hover:text-white"
              >
                ✕
              </button>
            </div>

            <div className="space-y-3">
              {connectors.map((connector, index) => (
                <button
                  key={connector.id}
                  onClick={() => handleConnect(index)}
                  className="w-full flex items-center space-x-4 bg-gray-800 hover:bg-gray-750 border border-gray-700 hover:border-gray-600 rounded-xl p-4 transition-colors"
                >
                  <span className="text-2xl">
                    {connector.name === "MetaMask" ? "🦊" : "🔗"}
                  </span>
                  <div className="text-left">
                    <p className="text-white font-medium">{connector.name}</p>
                    <p className="text-gray-400 text-xs">
                      {connector.name === "MetaMask"
                        ? "Connect with browser extension"
                        : "Connect wallet"}
                    </p>
                  </div>
                </button>
              ))}
            </div>

            <p className="text-gray-500 text-xs text-center mt-4">
              By connecting, you agree to the Terms of Service
            </p>
          </div>
        </div>
      )}

      {/* Sui Wallet Connection Modal */}
      {showSuiModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
            onClick={() => setShowSuiModal(false)}
          />
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
                    {wallet.icon && (
                      <img src={wallet.icon} alt={wallet.name} className="w-8 h-8 rounded-lg" />
                    )}
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