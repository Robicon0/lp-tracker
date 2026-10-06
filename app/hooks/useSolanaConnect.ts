"use client";

import { useCallback, useEffect, useRef } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import type { WalletName } from "@solana/wallet-adapter-base";
import { useWalletAuth } from "../contexts/WalletAuthContext";

// The ONE implementation of an explicit, user-initiated Solana connect.
//
// Every connect surface (home hero, top Navbar, Manage Wallets modal) used to
// do `select(name); await connect();` in the same tick. select() only QUEUES
// the wallet — the adapter's `wallet` updates on the next render — so connect()
// threw WalletNotSelectedError for any wallet that was not already selected:
// every first connect, and every reconnect after an explicit disconnect (which
// clears the selection). The catch then dropped the "awaiting" flag, so when
// the adapter did connect a moment later the address was never captured.
// Measured 2026-10-07 with a Wallet Standard wallet: the hero needed a SECOND
// click, the Navbar and the modal never connected at all.
//
// Here the connect is deferred to an effect that runs once the selection has
// actually landed, and the address is captured only for a connect the user
// asked for (the `awaiting` ref) — never adopted from a silent adapter session
// (wallet-security Rule 1; WalletRestoreEffect owns restore).
export function useSolanaConnect() {
  const { wallet, select, connect, connected, publicKey } = useWallet();
  const { setSolanaAddress } = useWalletAuth();
  const awaiting = useRef(false);
  const pendingName = useRef<string | null>(null);

  // Capture the address once a user-initiated connect completes.
  useEffect(() => {
    if (awaiting.current && connected && publicKey) {
      setSolanaAddress(publicKey.toBase58());
      awaiting.current = false;
    }
  }, [connected, publicKey, setSolanaAddress]);

  // Deferred connect: fires when the queued selection becomes the adapter's
  // current wallet. connect() is a no-op if the provider's own autoConnect got
  // there first; either way the capture effect above sees the result.
  useEffect(() => {
    const pending = pendingName.current;
    if (!pending || wallet?.adapter.name !== pending) return;
    pendingName.current = null;
    connect().catch((err) => {
      awaiting.current = false;
      console.error("Solana connect error:", err);
    });
  }, [wallet, connect]);

  return useCallback((walletName: string) => {
    const alreadySelected = wallet?.adapter.name === walletName;
    // The adapter already holds a live session for this wallet: connect()
    // would change nothing and the capture effect would never re-fire.
    if (alreadySelected && connected && publicKey) {
      setSolanaAddress(publicKey.toBase58());
      return;
    }
    awaiting.current = true;
    if (!alreadySelected) {
      pendingName.current = walletName;
      select(walletName as WalletName);
      return;
    }
    connect().catch((err) => {
      awaiting.current = false;
      console.error("Solana connect error:", err);
    });
  }, [wallet, connected, publicKey, select, connect, setSolanaAddress]);
}
