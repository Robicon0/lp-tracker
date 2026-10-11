"use client";

import { createContext, useContext, useState, useCallback, useEffect } from "react";
import { isDisconnected } from "../lib/walletDisconnectFlag";

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

  // WHERE the current EVM identity came from. This distinction exists because
  // conflating the two caused a real, confirmed bug (2026-08-02): a STALE
  // persisted address was displayed as "Connected" and every EVM position
  // query ran against it, returning nothing, while the user's actual wallet
  // (Rabby) held a different account. Because a restored address is only ever
  // corrected when wagmi holds a LIVE connection — and an installed, unlocked
  // wallet does NOT by itself make wagmi connected — the wrong address
  // persisted indefinitely and no amount of reloading fixed it.
  //
  //   "live"     — wagmi reports this address from an ACTIVE connection. It is
  //                the wallet's real current account and is authoritative.
  //   "restored" — read back from localStorage. A read-only best guess at who
  //                the user is; it MAY be stale. Never present it as a live
  //                connection, and always let "live" overwrite it.
  //   null       — no EVM identity.
  evmIdentitySource: "live" | "restored" | null;

  // Restore a persisted identity WITHOUT claiming it is live. Separate from
  // setEvmAddress so a call site cannot accidentally promote a cached address
  // to authoritative — the bug above in one line.
  restoreEvmAddress: (addr: string) => void;
  // The chosen wallet stopped reporting an account mid-session (locked, or the
  // site was disconnected inside the extension): keep the address on screen,
  // but as LAST USED, not as a live connection.
  demoteEvmIdentity: () => void;

  // The connector the user PICKED in a Connect EVM dialog. It is the only EVM
  // identity source: on load only this connector is asked to reconnect, and a
  // live address is adopted only from this connector's own connection.
  //
  // Why it exists (found 2026-10-12): the wallet library reconnects to EVERY
  // extension that already trusts the site, and the first one to answer became
  // the identity. A second extension that trusted the site only because its
  // Solana side had been connected took over whenever the chosen wallet was
  // locked, was shown as "connected", and overwrote the saved address.
  //
  // null = no connector chosen (never connected, or explicitly disconnected).
  evmConnectorId: string | null;
  chooseEvmConnector: (id: string | null) => void;

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
export const EVM_CONNECTOR_KEY = "defidesh-evm-connector";

// An explicit disconnect leaves no choice behind (the flag always wins).
// Otherwise: the stored choice, or — for a browser that connected before the choice was
// stored — the connector of the library's last explicit connect
// (`wagmi.recentConnectorId`, written by a Connect click). Nothing on record
// means no connector: the saved address then shows as LAST USED and no live
// account is adopted until the user picks a wallet.
function readStoredEvmConnector(): string | null {
  if (typeof window === "undefined" || isDisconnected("evm")) return null;
  try {
    const own = localStorage.getItem(EVM_CONNECTOR_KEY);
    if (own) return own;
    if (!localStorage.getItem(EVM_ADDR_KEY)) return null;
    const recent = localStorage.getItem("wagmi.recentConnectorId");
    if (!recent) return null;
    const id: unknown = JSON.parse(recent);
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

const WalletAuthContext = createContext<WalletAuthContextValue>({
  evmAddress: null,
  setEvmAddress: () => {},
  evmIdentitySource: null,
  restoreEvmAddress: () => {},
  demoteEvmIdentity: () => {},
  evmConnectorId: null,
  chooseEvmConnector: () => {},
  solanaAddress: null,
  setSolanaAddress: () => {},
  suiAddress: null,
  setSuiAddress: () => {},
});

export function WalletAuthProvider({ children }: { children: React.ReactNode }) {
  const [evmAddress, setEvmAddressState] = useState<string | null>(null);
  const [evmIdentitySource, setEvmIdentitySource] = useState<"live" | "restored" | null>(null);
  // Read once, on the client. It drives effects only (which connector is asked
  // to reconnect), never markup, so the server's null cannot mismatch.
  const [evmConnectorId, setEvmConnectorId] = useState<string | null>(readStoredEvmConnector);
  const [solanaAddress, setSolanaAddress] = useState<string | null>(null);
  const [suiAddress, setSuiAddress] = useState<string | null>(null);

  // A choice taken over from the library's record is stored as ours, once.
  useEffect(() => {
    try {
      if (evmConnectorId && !localStorage.getItem(EVM_CONNECTOR_KEY)) localStorage.setItem(EVM_CONNECTOR_KEY, evmConnectorId);
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const chooseEvmConnector = useCallback((id: string | null) => {
    setEvmConnectorId(id);
    try {
      if (id) localStorage.setItem(EVM_CONNECTOR_KEY, id);
      else localStorage.removeItem(EVM_CONNECTOR_KEY);
    } catch {}
  }, []);

  // Persistence rides the setter so an explicit disconnect (null) always removes
  // the saved identity and a confirmed connect always records it. An address set
  // here is LIVE — it came from the CHOSEN connector's active connection or an
  // explicit user connect — so it overwrites whatever was restored.
  const setEvmAddress = useCallback((addr: string | null) => {
    setEvmAddressState(addr);
    setEvmIdentitySource(addr ? "live" : null);
    try {
      if (addr) localStorage.setItem(EVM_ADDR_KEY, addr);
      else localStorage.removeItem(EVM_ADDR_KEY);
    } catch {}
  }, []);

  // Restore path: adopt the persisted address as a read-only identity but mark
  // it "restored" so the UI does not claim a live connection and so live state
  // can override it. Deliberately does NOT write storage — there is nothing new
  // to record, and rewriting would obscure staleness.
  const restoreEvmAddress = useCallback((addr: string) => {
    setEvmAddressState((prev) => prev ?? addr);
    setEvmIdentitySource((prev) => (prev === "live" ? prev : "restored"));
  }, []);

  const demoteEvmIdentity = useCallback(() => {
    setEvmIdentitySource((prev) => (prev === "live" ? "restored" : prev));
  }, []);

  return (
    <WalletAuthContext.Provider
      value={{ evmAddress, setEvmAddress, evmIdentitySource, restoreEvmAddress, demoteEvmIdentity, evmConnectorId, chooseEvmConnector, solanaAddress, setSolanaAddress, suiAddress, setSuiAddress }}
    >
      {children}
    </WalletAuthContext.Provider>
  );
}

export function useWalletAuth() {
  return useContext(WalletAuthContext);
}
