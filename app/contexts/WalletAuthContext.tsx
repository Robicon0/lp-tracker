"use client";

import { createContext, useContext, useState } from "react";

interface WalletAuthContextValue {
  solanaExplicit: boolean;
  setSolanaExplicit: (v: boolean) => void;
}

const WalletAuthContext = createContext<WalletAuthContextValue>({
  solanaExplicit: false,
  setSolanaExplicit: () => {},
});

export function WalletAuthProvider({ children }: { children: React.ReactNode }) {
  const [solanaExplicit, setSolanaExplicit] = useState(false);
  return (
    <WalletAuthContext.Provider value={{ solanaExplicit, setSolanaExplicit }}>
      {children}
    </WalletAuthContext.Provider>
  );
}

export function useWalletAuth() {
  return useContext(WalletAuthContext);
}
