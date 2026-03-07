"use client";

import { createContext, useContext, useState } from "react";

interface WalletAuthContextValue {
  // The Solana address the user explicitly connected in this session.
  // null means no explicit connection — do NOT fall back to useWallet().publicKey,
  // which can be set even for a locked wallet via Wallet Standard silent reconnect.
  solanaAddress: string | null;
  setSolanaAddress: (addr: string | null) => void;
}

const WalletAuthContext = createContext<WalletAuthContextValue>({
  solanaAddress: null,
  setSolanaAddress: () => {},
});

export function WalletAuthProvider({ children }: { children: React.ReactNode }) {
  const [solanaAddress, setSolanaAddress] = useState<string | null>(null);
  return (
    <WalletAuthContext.Provider value={{ solanaAddress, setSolanaAddress }}>
      {children}
    </WalletAuthContext.Provider>
  );
}

export function useWalletAuth() {
  return useContext(WalletAuthContext);
}
