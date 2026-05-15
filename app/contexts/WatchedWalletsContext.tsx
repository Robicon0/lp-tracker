"use client";

import { createContext, useContext, useState, useEffect } from "react";

export type WatchedWalletChain = "evm" | "solana" | "sui" | "aptos";

export interface WatchedWallet {
  address: string;
  chain: WatchedWalletChain;
  label?: string;
  addedAt: number;
}

// Scan mode: when a user pastes an address into the homepage SCAN form, the
// dashboard enters a read-only view of that address. While scanAddress is set,
// every consumer hook (PositionsContext, useWalletTokens, useLendingPositions)
// IGNORES the connected wagmi/Solana/Sui wallets AND the persisted
// watchedWallets list — using ONLY the scan address on its declared chain.
// scanAddress is intentionally ephemeral (NOT persisted to localStorage); it
// dies on a hard refresh unless the URL still has ?address=&chain= params, and
// the dashboard re-applies it from the URL on mount.
export interface ScanAddress {
  address: string;
  chain: WatchedWalletChain;
}

interface WatchedWalletsContextValue {
  watchedWallets: WatchedWallet[];
  addWallet: (address: string, chain: WatchedWalletChain, label?: string) => void;
  removeWallet: (address: string, chain: WatchedWalletChain) => void;
  updateLabel: (address: string, chain: WatchedWalletChain, label: string) => void;
  scanAddress: ScanAddress | null;
  setScanAddress: (a: ScanAddress | null) => void;
}

const LS_KEY = "lp-watched-wallets";

const WatchedWalletsContext = createContext<WatchedWalletsContextValue>({
  watchedWallets: [],
  addWallet: () => {},
  removeWallet: () => {},
  updateLabel: () => {},
  scanAddress: null,
  setScanAddress: () => {},
});

export function WatchedWalletsProvider({ children }: { children: React.ReactNode }) {
  const [watchedWallets, setWatchedWallets] = useState<WatchedWallet[]>([]);
  const [scanAddress, setScanAddress] = useState<ScanAddress | null>(null);

  // Hydrate from localStorage on mount (client-only)
  useEffect(() => {
    try {
      const stored = localStorage.getItem(LS_KEY);
      if (stored) setWatchedWallets(JSON.parse(stored));
    } catch {}
  }, []);

  function persist(wallets: WatchedWallet[]) {
    setWatchedWallets(wallets);
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(wallets));
    } catch {}
  }

  function addWallet(address: string, chain: WatchedWalletChain, label?: string) {
    const isDupe = watchedWallets.some(
      (w) => w.address.toLowerCase() === address.toLowerCase() && w.chain === chain
    );
    if (isDupe) return;
    persist([...watchedWallets, { address, chain, label, addedAt: Date.now() }]);
  }

  function removeWallet(address: string, chain: WatchedWalletChain) {
    persist(watchedWallets.filter((w) => !(w.address === address && w.chain === chain)));
  }

  function updateLabel(address: string, chain: WatchedWalletChain, label: string) {
    persist(
      watchedWallets.map((w) =>
        w.address === address && w.chain === chain ? { ...w, label } : w
      )
    );
  }

  return (
    <WatchedWalletsContext.Provider value={{ watchedWallets, addWallet, removeWallet, updateLabel, scanAddress, setScanAddress }}>
      {children}
    </WatchedWalletsContext.Provider>
  );
}

export function useWatchedWallets() {
  return useContext(WatchedWalletsContext);
}
