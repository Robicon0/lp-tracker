"use client";

import { useState, useEffect, useRef } from "react";
import { WagmiProvider, useDisconnect, useConnections, useConnectors, useReconnect } from "wagmi";
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

// Per-chain "connection confirmed" watchers for SOLANA and SUI — they clear the
// corresponding `defidesh_<chain>_disconnected` flag when the adapter reports a
// fully-confirmed connection, never when the user merely clicks Connect. That
// way a failed connect attempt (e.g. wallet is locked) can't strand the flag in
// a cleared state and let autoConnect silently reconnect on the next click.
//
// Pattern: skip the FIRST effect run on mount. Reason: when the adapter
// silently reconnected before the disconnect gate fired, `connected` is true on
// the very first render. Reacting to that would clear a flag the user never
// asked us to clear. We only act on transitions that happen AFTER mount.
//
// EVM does NOT use this any more (2026-10-12). The wallet library connects on
// its own when ANY extension that trusts the site emits an account event, so a
// "connected" transition is not evidence of a user action: with the flag set,
// a second extension announcing its account cleared the flag and became the
// identity with no Connect click. The EVM flag is cleared in exactly one place,
// the Connect pick (app/hooks/useEvmConnect.ts).
function useClearOnConfirmedConnect(chain: "solana" | "sui", connected: boolean) {
  const initialized = useRef(false);
  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      return;
    }
    if (connected) clearDisconnected(chain);
  }, [chain, connected]);
}

// EVM identity (2026-10-12: the CHOSEN connector is the only source).
//
// WalletAuthContext.evmAddress is the single EVM identity every page reads.
// It comes from exactly two places:
//   - the connector the user picked in a Connect EVM dialog (live), or
//   - the address saved at the last confirmed connect (shown as LAST USED).
// Never from any other extension, whatever the library is connected to.
//
//   1. RESTORE. On mount, unless the user explicitly disconnected, the saved
//      address is adopted as a read-only identity marked "restored".
//   2. RECONNECT THE CHOSEN CONNECTOR ONLY. The library's own
//      reconnect-on-mount asks every extension that trusts the site and makes
//      the first to answer current; it is switched off (see Providers), and
//      only the chosen connector is asked here.
//   3. ADOPT ONLY FROM THE CHOSEN CONNECTOR. The live address is read from the
//      chosen connector's own connection (matched by this session's connector
//      instance, so a connection list saved by an earlier session can never
//      pass for live), not from the library's "current" account.
//   4. FOLLOW THE CHOSEN WALLET. An account switch inside it reaches us through
//      its connection; an unlock is heard on ITS provider (not the page default,
//      which may belong to another extension) and reconnects it alone.
//   5. An explicit disconnect always wins: nothing here runs while the flag is
//      set, and only the Connect pick clears it.
function EvmIdentitySync() {
  const connections = useConnections();
  const connectors = useConnectors();
  const { reconnect } = useReconnect();
  const { setEvmAddress, restoreEvmAddress, demoteEvmIdentity, evmConnectorId } = useWalletAuth();

  const chosen = evmConnectorId ? connectors.find((c) => c.id === evmConnectorId) : undefined;
  const chosenUid = chosen?.uid;
  const live = chosen ? connections.find((c) => c.connector.uid === chosen.uid)?.accounts[0] : undefined;
  const liveRef = useRef(live);
  liveRef.current = live;
  const chosenRef = useRef(chosen);
  chosenRef.current = chosen;

  // (1) RESTORE — read-only, marked "restored" so the UI never claims a live
  // connection for an address that may be stale.
  useEffect(() => {
    if (!isDisconnected("evm")) {
      try {
        const saved = localStorage.getItem("defidesh-evm-addr");
        if (saved) restoreEvmAddress(saved);
      } catch {}
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // (2) RECONNECT the chosen connector, once, as soon as it exists (an
  // auto-discovered connector is registered a moment after mount). One
  // macrotask later, so it runs after the library's own mount work. No cleanup
  // on purpose: an effect that can return early must not cancel work it has
  // already marked as started.
  const askedUid = useRef<string | null>(null);
  useEffect(() => {
    if (!chosenUid || isDisconnected("evm")) return;
    if (askedUid.current === chosenUid) return;
    askedUid.current = chosenUid;
    if (liveRef.current) return; // just connected by an explicit pick
    setTimeout(() => {
      const c = chosenRef.current;
      if (!c || c.uid !== chosenUid || liveRef.current || isDisconnected("evm")) return;
      try { reconnect({ connectors: [c] }); } catch {}
    }, 0);
  }, [chosenUid, reconnect]);

  // (3) ADOPT — only the chosen connector's account, and persist it as the new
  // last-confirmed identity. PositionsContext keys its queries by address, so
  // the right wallet is fetched with no page refresh. When the chosen wallet
  // stops reporting an account mid-session the address stays, as LAST USED.
  const wasLive = useRef(false);
  useEffect(() => {
    if (live) {
      if (isDisconnected("evm")) return;
      wasLive.current = true;
      setEvmAddress(live);
    } else if (wasLive.current) {
      wasLive.current = false;
      demoteEvmIdentity();
    }
  }, [live, setEvmAddress, demoteEvmIdentity]);

  // (4) UNLOCK WATCHER on the chosen connector's own provider. The library
  // only reports account changes for a connector it is connected to; the case
  // that needs help is the opposite one (wallet locked at load, unlocked
  // later). A wallet that emits nothing still gets the tab-refocus check.
  useEffect(() => {
    if (!chosenUid || isDisconnected("evm")) return;
    type Provider = {
      on?: (e: string, f: (...a: unknown[]) => void) => void;
      removeListener?: (e: string, f: (...a: unknown[]) => void) => void;
    };
    let cancelled = false;
    let detach = () => {};

    const tryReconnect = () => {
      const c = chosenRef.current;
      if (!c || c.uid !== chosenUid || liveRef.current) return;
      if (isDisconnected("evm")) return; // an explicit disconnect always wins
      try { reconnect({ connectors: [c] }); } catch {}
    };
    const onAccountsChanged = (...args: unknown[]) => {
      const accts = args[0];
      if (Array.isArray(accts) && accts.length > 0) tryReconnect();
    };
    const onConnect = () => tryReconnect();

    void chosenRef.current?.getProvider().then((p) => {
      const provider = p as Provider | undefined;
      if (cancelled || !provider?.on) return;
      provider.on("accountsChanged", onAccountsChanged);
      provider.on("connect", onConnect);
      detach = () => {
        provider.removeListener?.("accountsChanged", onAccountsChanged);
        provider.removeListener?.("connect", onConnect);
      };
    }).catch(() => {});

    const onVisible = () => { if (document.visibilityState === "visible") tryReconnect(); };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      detach();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [chosenUid, reconnect]);

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
  // EVM: the library's reconnect-on-mount is OFF for everyone. It asks every
  // extension that trusts the site, not the wallet the user chose, and with
  // two wallets installed the wrong one became the identity (2026-10-12).
  // EvmIdentitySync reconnects the chosen connector alone, and not at all
  // after an explicit disconnect (wallet-security Rule 1).

  return (
    <ConnectionProvider endpoint={SOLANA_RPC}>
      <WalletProvider wallets={solanaWallets} autoConnect={solanaAutoConnect}>
        <SolanaConnectionWatcher />
        <WalletAuthProvider>
          <WagmiProvider config={config} reconnectOnMount={false}>
            <QueryClientProvider client={queryClient}>
              <EvmDisconnectGate />
              <EvmIdentitySync />
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
