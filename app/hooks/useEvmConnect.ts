"use client";

import { useCallback } from "react";
import { useConnect, useConnections, useReconnect, type Connector } from "wagmi";
import { useWalletAuth } from "../contexts/WalletAuthContext";
import { clearDisconnected } from "../lib/walletDisconnectFlag";

// The ONE implementation of an explicit, user-initiated EVM connect — the pick
// in a Connect EVM dialog (hero, navbar, Manage Wallets, Switch wallet).
//
// A successful pick is the only thing that
//   1. records the CHOSEN connector (the only EVM identity source),
//   2. clears `defidesh_evm_disconnected`, and
//   3. sets the address as live.
// Nothing an extension does on its own — an unlock, an account event, its
// Solana or Sui side being connected — can do any of the three.
//
// A pick that fails or is cancelled changes nothing: the wallet chosen before
// stays chosen, and a set disconnect flag stays set.
export function useEvmConnect() {
  const { connectAsync, connectors } = useConnect();
  const { reconnectAsync } = useReconnect();
  const connections = useConnections();
  const { setEvmAddress, chooseEvmConnector } = useWalletAuth();

  const connectEvm = useCallback(async (connector: Connector): Promise<boolean> => {
    try {
      let account: string | undefined;
      const alreadyConnected = connections.some(
        (c) => c.connector.uid === connector.uid && typeof c.connector.connect === "function",
      );
      if (alreadyConnected) {
        // Same wallet picked again (Switch wallet → another account in it): ask
        // the wallet directly, then have the library re-read this connector so
        // its connection carries the account the wallet now reports.
        const res = await connector.connect();
        account = res.accounts[0] as string | undefined;
        const again = await reconnectAsync({ connectors: [connector] }).catch(() => []);
        account = again.find((c) => c.connector.uid === connector.uid)?.accounts[0] ?? account;
      } else {
        const res = await connectAsync({ connector });
        account = res.accounts[0];
      }
      if (!account) return false;
      clearDisconnected("evm");
      chooseEvmConnector(connector.id);
      setEvmAddress(account);
      return true;
    } catch (err) {
      console.error("EVM connect error:", err);
      return false;
    }
  }, [connections, connectAsync, reconnectAsync, chooseEvmConnector, setEvmAddress]);

  const connectEvmById = useCallback((id: string) => {
    const connector = connectors.find((c) => c.id === id);
    return connector ? connectEvm(connector) : Promise.resolve(false);
  }, [connectors, connectEvm]);

  return { connectEvm, connectEvmById, connectors };
}
