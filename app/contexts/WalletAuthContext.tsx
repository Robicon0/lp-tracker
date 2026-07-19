"use client";

import { createContext, useContext, useState, useCallback } from "react";

interface WalletAuthContextValue {
  // EVM: the effective EVM identity every page reads (2026-07-19, owner-requested
  // session persistence). Live wagmi address when the wallet is unlocked and
  // reconnected; otherwise the LAST-CONFIRMED address persisted in localStorage
  // (`defidesh-evm-addr`) — restored on load ONLY when the user did not
  // explicitly disconnect (flag `defidesh_evm_disconnected`). This gives EVM the
  // same "come back later and it's still there" behavior Solana/Sui already have
  // (their Wallet Standard adapters report the address even while locked;
  // MetaMask-style EVM extensions reveal nothing while locked, so a persisted
  // read-only identity is the only way to reach parity). DefiDesh is read-only,
  // so the persisted identity grants exactly what a watched address grants.
  // Synced by EvmAddressSync in providers.tsx; persistence lives in the setter
  // so no call site can forget it.
  evmAddress: string | null;
  setEvmAddress: (addr: string | null) => void;

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

const EVM_ADDR_KEY = "defidesh-evm-addr";

const WalletAuthContext = createContext<WalletAuthContextValue>({
  evmAddress: null,
  setEvmAddress: () => {},
  solanaAddress: null,
  setSolanaAddress: () => {},
  suiAddress: null,
  setSuiAddress: () => {},
});

export function WalletAuthProvider({ children }: { children: React.ReactNode }) {
  const [evmAddress, setEvmAddressState] = useState<string | null>(null);
  const [solanaAddress, setSolanaAddress] = useState<string | null>(null);
  const [suiAddress, setSuiAddress] = useState<string | null>(null);

  // Persistence rides the setter so an explicit disconnect (null) always removes
  // the saved identity and a confirmed connect always records it.
  const setEvmAddress = useCallback((addr: string | null) => {
    setEvmAddressState(addr);
    try {
      if (addr) localStorage.setItem(EVM_ADDR_KEY, addr);
      else localStorage.removeItem(EVM_ADDR_KEY);
    } catch {}
  }, []);

  return (
    <WalletAuthContext.Provider
      value={{ evmAddress, setEvmAddress, solanaAddress, setSolanaAddress, suiAddress, setSuiAddress }}
    >
      {children}
    </WalletAuthContext.Provider>
  );
}

export function useWalletAuth() {
  return useContext(WalletAuthContext);
}
