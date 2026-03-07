"use client";

import { createContext, useContext, useState } from "react";

interface WalletAuthContextValue {
  // Solana: only set after user-initiated connect — never read publicKey/connected
  // from the adapter directly (Wallet Standard silently reconnects locked wallets).
  solanaAddress: string | null;
  setSolanaAddress: (addr: string | null) => void;

  // Sui: only set after user-initiated connect — @mysten/dapp-kit persists the last
  // connected wallet and useCurrentAccount() can return an account even after page
  // reload without user action.
  suiAddress: string | null;
  setSuiAddress: (addr: string | null) => void;
}

const WalletAuthContext = createContext<WalletAuthContextValue>({
  solanaAddress: null,
  setSolanaAddress: () => {},
  suiAddress: null,
  setSuiAddress: () => {},
});

export function WalletAuthProvider({ children }: { children: React.ReactNode }) {
  const [solanaAddress, setSolanaAddress] = useState<string | null>(null);
  const [suiAddress, setSuiAddress] = useState<string | null>(null);
  return (
    <WalletAuthContext.Provider value={{ solanaAddress, setSolanaAddress, suiAddress, setSuiAddress }}>
      {children}
    </WalletAuthContext.Provider>
  );
}

export function useWalletAuth() {
  return useContext(WalletAuthContext);
}
