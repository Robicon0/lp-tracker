"use client";

import { createContext, useContext, useState, useEffect } from "react";
import { useWalletAuth } from "./WalletAuthContext";

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

// Why an address was not added (wallet-security Rule 3 and Rule 6). The caller
// shows `message`; nothing is ever added silently-not.
export type AddWalletResult =
  | { ok: true }
  | { ok: false; reason: "connected" | "duplicate" | "limit"; message: string };

export const MAX_WATCHED_PER_CHAIN = 20;

// EVM and Sui addresses are hex, so two spellings that differ only in case are
// the same wallet. Solana base58 is case-SENSITIVE: compare it exactly.
export function sameWalletAddress(a: string, b: string, chain: WatchedWalletChain): boolean {
  if (chain === "solana") return a.trim() === b.trim();
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

interface WatchedWalletsContextValue {
  watchedWallets: WatchedWallet[];
  addWallet: (address: string, chain: WatchedWalletChain, label?: string) => AddWalletResult;
  removeWallet: (address: string, chain: WatchedWalletChain) => void;
  updateLabel: (address: string, chain: WatchedWalletChain, label: string) => void;
  scanAddress: ScanAddress | null;
  setScanAddress: (a: ScanAddress | null) => void;
}

const LS_KEY = "lp-watched-wallets";

const WatchedWalletsContext = createContext<WatchedWalletsContextValue>({
  watchedWallets: [],
  addWallet: () => ({ ok: true }),
  removeWallet: () => {},
  updateLabel: () => {},
  scanAddress: null,
  setScanAddress: () => {},
});

export function WatchedWalletsProvider({ children }: { children: React.ReactNode }) {
  const [watchedWallets, setWatchedWallets] = useState<WatchedWallet[]>([]);
  const [scanAddress, setScanAddress] = useState<ScanAddress | null>(null);
  const { evmAddress, solanaAddress, suiAddress } = useWalletAuth();

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

  function addWallet(address: string, chain: WatchedWalletChain, label?: string): AddWalletResult {
    // The same wallet through both doors would be listed twice (and is a
    // double-count risk for any consumer that forgets to merge): reject it.
    const connected = chain === "evm" ? evmAddress : chain === "solana" ? solanaAddress : chain === "sui" ? suiAddress : null;
    if (connected && sameWalletAddress(connected, address, chain)) {
      return {
        ok: false,
        reason: "connected",
        message: "This wallet is already connected. Disconnect it first if you want to view it as a watched address.",
      };
    }
    const onChain = watchedWallets.filter((w) => w.chain === chain);
    if (onChain.some((w) => sameWalletAddress(w.address, address, chain))) {
      return { ok: false, reason: "duplicate", message: "This address is already in your watched wallets." };
    }
    if (onChain.length >= MAX_WATCHED_PER_CHAIN) {
      return {
        ok: false,
        reason: "limit",
        message: `Watched address limit reached for this chain (${MAX_WATCHED_PER_CHAIN}). Remove an existing address to add a new one.`,
      };
    }
    persist([...watchedWallets, { address, chain, label, addedAt: Date.now() }]);
    return { ok: true };
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
