"use client";

import { useCallback } from "react";
import { useDisconnect, useConnectors } from "wagmi";
import { useWallet } from "@solana/wallet-adapter-react";
import { useDisconnectWallet } from "@mysten/dapp-kit";
import { useWalletAuth } from "../contexts/WalletAuthContext";
import { setDisconnected, type WalletChain } from "../lib/walletDisconnectFlag";

// The ONE implementation of an explicit, user-initiated wallet disconnect.
//
// It exists because the disconnect sequence was hand-copied into several
// surfaces and the copies drifted (found 2026-10-07): the Manage Wallets modal
// called only the adapter's own disconnect, which stopped being enough once the
// displayed identity moved into WalletAuthContext + `defidesh-<chain>-addr`.
//   - EVM: wagmi disconnected but the context identity and the persisted key
//     were untouched, so the wallet stayed on screen — the button did nothing.
//   - Solana / Sui: the context was cleared but the persisted key was not, so
//     WalletRestoreEffect re-adopted the address while the adapter was still
//     mid-disconnect, and it lingered until the settle gate + debounce expired.
//
// All four steps are required, and the ORDER matters:
//   1. set the `defidesh_<chain>_disconnected` flag FIRST — every restore /
//      silent-reconnect path checks it, so nothing can re-adopt the wallet
//      while the adapter is still tearing down (wallet-security Rule 1: an
//      explicit disconnect is never overridden by a silent restore);
//   2. clear the context identity (what every page reads);
//   3. remove OUR persisted key (never another library's private storage);
//   4. ask the adapter to disconnect.
export function useWalletDisconnect() {
  const { disconnect: wagmiDisconnect } = useDisconnect();
  const { disconnect: solanaAdapterDisconnect } = useWallet();
  const { mutate: suiAdapterDisconnect } = useDisconnectWallet();
  const connectors = useConnectors();
  const { setEvmAddress, evmConnectorId, chooseEvmConnector, setSolanaAddress, setSuiAddress } = useWalletAuth();

  const disconnectEvm = useCallback(() => {
    setDisconnected("evm");
    setEvmAddress(null); // the setter also removes `defidesh-evm-addr`
    // Disconnect the CHOSEN connector (the library's "current" one can be
    // another extension that connected on its own), then forget the choice:
    // after an explicit disconnect there is no EVM identity source at all
    // until the next Connect pick.
    const chosen = evmConnectorId ? connectors.find((c) => c.id === evmConnectorId) : undefined;
    chooseEvmConnector(null);
    // No chosen connector means we hold no connection of our own; whatever the
    // library is connected to belongs to another extension and is left alone.
    if (chosen) wagmiDisconnect({ connector: chosen });
  }, [setEvmAddress, wagmiDisconnect, connectors, evmConnectorId, chooseEvmConnector]);

  const disconnectSolana = useCallback(() => {
    setDisconnected("solana");
    setSolanaAddress(null);
    try { localStorage.removeItem("defidesh-solana-addr"); } catch {}
    // Rejects when the adapter is already disconnected — nothing left to do.
    void solanaAdapterDisconnect().catch(() => {});
  }, [setSolanaAddress, solanaAdapterDisconnect]);

  const disconnectSui = useCallback(() => {
    setDisconnected("sui");
    setSuiAddress(null);
    try { localStorage.removeItem("defidesh-sui-addr"); } catch {}
    suiAdapterDisconnect();
  }, [setSuiAddress, suiAdapterDisconnect]);

  const disconnectChain = useCallback((chain: WalletChain) => {
    if (chain === "evm") disconnectEvm();
    else if (chain === "solana") disconnectSolana();
    else disconnectSui();
  }, [disconnectEvm, disconnectSolana, disconnectSui]);

  return { disconnectEvm, disconnectSolana, disconnectSui, disconnectChain };
}
