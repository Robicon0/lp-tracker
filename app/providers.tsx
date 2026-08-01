"use client";

import { useState, useEffect, useRef } from "react";
import { WagmiProvider, useDisconnect, useAccount, useReconnect } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConnectionProvider, WalletProvider, useWallet } from "@solana/wallet-adapter-react";
import { SuiClientProvider, WalletProvider as SuiWalletProvider, createNetworkConfig, useCurrentAccount } from "@mysten/dapp-kit";
import { config } from "./config/wagmi";
import { PositionsProvider } from "./contexts/PositionsContext";
import { WalletAuthProvider } from "./contexts/WalletAuthContext";
import { WatchedWalletsProvider } from "./contexts/WatchedWalletsContext";
import { isDisconnected, clearDisconnected } from "./lib/walletDisconnectFlag";
import { useWalletAuth } from "./contexts/WalletAuthContext";

const queryClient = new QueryClient();
// Empty array: WalletProvider auto-detects any Solana Wallet Standard-compliant
// wallet installed in the browser (Phantom, Backpack, Solflare, etc.)
const solanaWallets: never[] = [];
const SOLANA_RPC = "https://api.mainnet-beta.solana.com";

const { networkConfig: suiNetworkConfig } = createNetworkConfig({
  mainnet: { url: "https://fullnode.mainnet.sui.io:443", network: "mainnet" as const },
});

// EVM gate — wagmi auto-reconnects from its own storage on mount. When the
// user explicitly disconnected last session we honour that by force-
// disconnecting on mount so the connector doesn't silently restore from its
// internal storage. Sits inside WagmiProvider so it can call useDisconnect.
function EvmDisconnectGate() {
  const { disconnect } = useDisconnect();
  useEffect(() => {
    if (isDisconnected("evm")) {
      disconnect();
    }
    // Run once on mount; subsequent disconnects are user-driven.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

// Per-chain "connection confirmed" watchers — these are the ONLY places that
// clear the corresponding `defidesh_<chain>_disconnected` flag. They fire
// only when the adapter reports a fully-confirmed connection, never when the
// user merely clicks Connect. That way a failed connect attempt (e.g. wallet
// is locked) can't strand the flag in a cleared state and let autoConnect
// silently reconnect on the next click.
//
// Pattern: skip the FIRST effect run on mount. Reason: when wagmi has stored
// state (or the adapter silently reconnected before the disconnect gate
// fired), `connected` is true on the very first render. Reacting to that
// would clear a flag the user never asked us to clear. We only act on
// transitions that happen AFTER mount — i.e. real user-initiated connects.
function useClearOnConfirmedConnect(chain: "evm" | "solana" | "sui", connected: boolean) {
  const initialized = useRef(false);
  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      return;
    }
    if (connected) clearDisconnected(chain);
  }, [chain, connected]);
}

function EvmConnectionWatcher() {
  const { isConnected } = useAccount();
  useClearOnConfirmedConnect("evm", isConnected);
  return null;
}

// EVM identity sync (2026-07-19, owner-requested EVM session persistence —
// parity with Solana/Sui). Keeps WalletAuthContext.evmAddress as the single
// EVM identity every page reads:
//   1. On mount, if the user did NOT explicitly disconnect, restore the
//      last-confirmed address from localStorage — so a locked MetaMask (which
//      reveals no accounts until unlocked) still yields the read-only view the
//      user had last session, exactly like Solana/Sui wallets do.
//   2. Whenever wagmi reports a live address (unlocked + authorized), it wins
//      and is persisted as the new last-confirmed identity.
//   3. A wagmi DISCONNECTED report does NOT clear the identity (that's the
//      locked-wallet-on-load case); only the explicit Disconnect handlers call
//      setEvmAddress(null), which also removes the persisted key.
function EvmAddressSync() {
  const { address } = useAccount();
  const { setEvmAddress, restoreEvmAddress } = useWalletAuth();
  const { reconnect } = useReconnect();

  // (1) RESTORE — adopt the persisted identity as READ-ONLY ("restored"), not
  // as a live connection. Marking it restored is what stops the UI claiming
  // "Connected" for an address that may be stale.
  useEffect(() => {
    if (!isDisconnected("evm")) {
      try {
        const saved = localStorage.getItem("defidesh-evm-addr");
        if (saved) restoreEvmAddress(saved);
      } catch {}
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // (2) SILENT RECONNECT on mount. Without this, a wallet that is installed,
  // unlocked and already authorized still leaves wagmi DISCONNECTED, so the
  // restored address is never reconciled and a stale one survives forever —
  // the confirmed 2026-08-02 bug. Asking wagmi to reconnect promotes an
  // already-authorized wallet to a live connection with no user action and no
  // prompt. Skipped when the user explicitly disconnected (flag always wins).
  useEffect(() => {
    if (isDisconnected("evm")) return;
    try { reconnect(); } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // (3) LIVE WINS. wagmi reporting an address means an ACTIVE connection, so it
  // is authoritative: it overwrites the restored identity and is persisted as
  // the new last-confirmed one. Because PositionsContext keys its queries by
  // address (`["positions", label, address]`), changing it here makes React
  // Query fetch the correct address automatically — no manual page refresh.
  useEffect(() => {
    if (address) setEvmAddress(address);
  }, [address, setEvmAddress]);

  return null;
}

// (4) UNLOCK / ACCOUNT-SWITCH WATCHER.
//
// wagmi only surfaces `accountsChanged` for a connector it is already
// connected to. The failing case is the opposite: wagmi is NOT connected
// (wallet was locked at load), the user then unlocks or switches account, and
// nothing tells us. So we listen to the injected provider directly and ask
// wagmi to reconnect when the wallet becomes available. Once wagmi connects,
// effect (3) above replaces the identity and positions refetch on their own.
//
// Covers Rabby and MetaMask (both inject `window.ethereum` and emit EIP-1193
// events). A wallet that emits nothing still gets the visibilitychange sweep.
function EvmUnlockWatcher() {
  const { reconnect } = useReconnect();
  const { isConnected } = useAccount();
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (isDisconnected("evm")) return;

    const eth = (window as unknown as { ethereum?: { on?: (e: string, f: (...a: unknown[]) => void) => void; removeListener?: (e: string, f: (...a: unknown[]) => void) => void } }).ethereum;

    const tryReconnect = () => {
      if (isDisconnected("evm")) return; // an explicit disconnect always wins
      try { reconnect(); } catch {}
    };

    // Unlocking fires accountsChanged with a non-empty array; switching
    // accounts fires it with the new one. Both mean "reconcile now".
    const onAccountsChanged = (...args: unknown[]) => {
      const accts = args[0];
      if (Array.isArray(accts) && accts.length > 0) tryReconnect();
    };
    const onConnect = () => tryReconnect();

    eth?.on?.("accountsChanged", onAccountsChanged);
    eth?.on?.("connect", onConnect);

    // Fallback for wallets that unlock without emitting anything we hear:
    // re-check when the tab regains focus. Cheap and idempotent — reconnect()
    // is a no-op when already connected.
    const onVisible = () => { if (document.visibilityState === "visible" && !isConnected) tryReconnect(); };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      eth?.removeListener?.("accountsChanged", onAccountsChanged);
      eth?.removeListener?.("connect", onConnect);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [reconnect, isConnected]);
  return null;
}

function SolanaConnectionWatcher() {
  const { connected } = useWallet();
  useClearOnConfirmedConnect("solana", connected);
  return null;
}

function SuiConnectionWatcher() {
  const account = useCurrentAccount();
  useClearOnConfirmedConnect("sui", !!account);
  return null;
}

export default function Providers({ children }: { children: React.ReactNode }) {
  // Read each chain's "explicitly disconnected" flag synchronously on first
  // render so providers mount with the correct autoConnect value. Default
  // (no flag, first visit) = autoConnect ON; flag set = autoConnect OFF.
  const [solanaAutoConnect] = useState(() => !isDisconnected("solana"));
  const [suiAutoConnect] = useState(() => !isDisconnected("sui"));

  return (
    <ConnectionProvider endpoint={SOLANA_RPC}>
      <WalletProvider wallets={solanaWallets} autoConnect={solanaAutoConnect}>
        <SolanaConnectionWatcher />
        <WalletAuthProvider>
          <WagmiProvider config={config}>
            <QueryClientProvider client={queryClient}>
              <EvmDisconnectGate />
              <EvmConnectionWatcher />
              <EvmAddressSync />
              <EvmUnlockWatcher />
              <SuiClientProvider networks={suiNetworkConfig} defaultNetwork="mainnet">
                <SuiWalletProvider autoConnect={suiAutoConnect}>
                  <SuiConnectionWatcher />
                  <WatchedWalletsProvider>
                    <PositionsProvider>
                      {children}
                    </PositionsProvider>
                  </WatchedWalletsProvider>
                </SuiWalletProvider>
              </SuiClientProvider>
            </QueryClientProvider>
          </WagmiProvider>
        </WalletAuthProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
