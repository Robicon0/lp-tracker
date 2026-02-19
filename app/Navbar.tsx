"use client";

import { useState } from "react";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import Link from "next/link";

export default function Navbar() {
  const { address, isConnected } = useAccount();
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();
  const [showModal, setShowModal] = useState(false);
  const [showMobileMenu, setShowMobileMenu] = useState(false);

  const handleConnect = (connectorIndex: number) => {
    connect({ connector: connectors[connectorIndex] });
    setShowModal(false);
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
              <Link href="/about" className="text-gray-300 hover:text-white transition-colors">
                About
              </Link>

              {/* Wallet Button */}
              {isConnected && address ? (
                <div className="flex items-center space-x-3">
                  <span className="bg-gray-900 border border-gray-700 text-green-400 px-3 py-1.5 rounded-lg text-sm font-mono">
                    {truncateAddress(address)}
                  </span>
                  <button
                    onClick={() => disconnect()}
                    className="text-gray-400 hover:text-red-400 text-sm transition-colors"
                  >
                    Disconnect
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setShowModal(true)}
                  className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                >
                  Connect Wallet
                </button>
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
              <Link href="/about" className="block text-gray-300 hover:text-white py-2">About</Link>
              {isConnected && address ? (
                <div className="flex items-center justify-between py-2">
                  <span className="text-green-400 text-sm font-mono">{truncateAddress(address)}</span>
                  <button onClick={() => disconnect()} className="text-red-400 text-sm">Disconnect</button>
                </div>
              ) : (
                <button
                  onClick={() => { setShowModal(true); setShowMobileMenu(false); }}
                  className="w-full bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg text-sm font-medium"
                >
                  Connect Wallet
                </button>
              )}
            </div>
          )}
        </div>
      </nav>

      {/* Wallet Connection Modal */}
      {showModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
            onClick={() => setShowModal(false)}
          />
          <div className="relative bg-gray-900 border border-gray-700 rounded-2xl p-6 w-full max-w-sm mx-4">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-bold text-white">Connect Wallet</h2>
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
    </>
  );
}