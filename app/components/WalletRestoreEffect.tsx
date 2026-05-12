"use client";

import { useEffect } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletReadyState } from "@solana/wallet-adapter-base";
import { useCurrentAccount, useWallets } from "@mysten/dapp-kit";
import { useWalletAuth } from "../contexts/WalletAuthContext";

// Headless component that restores `solanaAddress` and `suiAddress` in
// WalletAuthContext after a page refresh, mirroring the effects in the
// original `app/Navbar.tsx`. The redesigned pages render TerminalNav /
// TerminalNavbar instead of Navbar, so without this component those pages
// would lose Solana/Sui connections on every refresh — the wallet adapter
// would silently reconnect but `solanaAddress` / `suiAddress` (which the UI
// reads) would stay `null` because nothing sets them.
//
// Mounted once at the root in `app/layout.tsx` so EVERY page benefits,
// including the redesigned ones. Renders nothing.
export default function WalletRestoreEffect() {
  const {
    connected: adapterSolanaConnected,
    publicKey: adapterPublicKey,
    wallets: solanaWallets,
  } = useWallet();
  const adapterSuiAccount = useCurrentAccount();
  const suiWallets = useWallets();
  const { solanaAddress, setSolanaAddress, suiAddress, setSuiAddress } = useWalletAuth();

  // ── Solana ────────────────────────────────────────────────────────────

  // Persist solanaAddress to localStorage so it survives page refresh.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (solanaAddress) {
      localStorage.setItem("defidesh-solana-addr", solanaAddress);
    }
  }, [solanaAddress]);

  // If no Solana wallet extension is installed, clear stale localStorage so
  // the UI doesn't show a phantom connected address.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const hasInstalled = solanaWallets.some((w) => w.readyState === WalletReadyState.Installed);
    if (!hasInstalled) {
      if (localStorage.getItem("defidesh-solana-addr")) {
        localStorage.removeItem("defidesh-solana-addr");
      }
      if (localStorage.getItem("walletName")) {
        localStorage.removeItem("walletName");
      }
    }
  }, [solanaWallets]);

  // After silent reconnect (Wallet Standard / autoConnect), the adapter is
  // connected but `solanaAddress` is still null. If localStorage has a saved
  // address matching the adapter's publicKey, restore it.
  useEffect(() => {
    if (adapterSolanaConnected && adapterPublicKey && !solanaAddress) {
      const hasInstalled = solanaWallets.some((w) => w.readyState === WalletReadyState.Installed);
      if (!hasInstalled) {
        if (typeof window !== "undefined") localStorage.removeItem("defidesh-solana-addr");
        return;
      }
      const saved = typeof window !== "undefined" ? localStorage.getItem("defidesh-solana-addr") : null;
      if (saved && saved === adapterPublicKey.toBase58()) {
        setSolanaAddress(saved);
      }
    }
  }, [adapterSolanaConnected, adapterPublicKey, solanaAddress, setSolanaAddress, solanaWallets]);

  // Clear if the adapter disconnects mid-session (e.g. wallet emits an
  // accounts-changed event).
  useEffect(() => {
    if (!adapterSolanaConnected && solanaAddress) {
      setSolanaAddress(null);
      if (typeof window !== "undefined") localStorage.removeItem("defidesh-solana-addr");
    }
  }, [adapterSolanaConnected, solanaAddress, setSolanaAddress]);

  // ── Sui ───────────────────────────────────────────────────────────────

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (suiAddress) {
      localStorage.setItem("defidesh-sui-addr", suiAddress);
    }
  }, [suiAddress]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (suiWallets.length === 0) {
      if (localStorage.getItem("defidesh-sui-addr")) {
        localStorage.removeItem("defidesh-sui-addr");
      }
      const dappKitKey = "dapp-kit:wallet-connection-info";
      if (localStorage.getItem(dappKitKey)) {
        localStorage.removeItem(dappKitKey);
      }
    }
  }, [suiWallets]);

  useEffect(() => {
    if (adapterSuiAccount && !suiAddress) {
      if (suiWallets.length === 0) {
        if (typeof window !== "undefined") localStorage.removeItem("defidesh-sui-addr");
        return;
      }
      const saved = typeof window !== "undefined" ? localStorage.getItem("defidesh-sui-addr") : null;
      if (saved && saved === adapterSuiAccount.address) {
        setSuiAddress(saved);
      }
    }
  }, [adapterSuiAccount, suiAddress, setSuiAddress, suiWallets]);

  useEffect(() => {
    if (!adapterSuiAccount && suiAddress) {
      setSuiAddress(null);
      if (typeof window !== "undefined") localStorage.removeItem("defidesh-sui-addr");
    }
  }, [adapterSuiAccount, suiAddress, setSuiAddress]);

  return null;
}
