// Per-chain "explicitly disconnected" flag stored in localStorage. When set,
// the corresponding wallet provider does NOT auto-connect on the next page
// load — that's the natural behaviour: if the user clicked Disconnect, they
// shouldn't be silently re-connected on refresh.
//
// On a successful explicit Connect, the flag is cleared so subsequent
// refreshes resume the silent auto-connect path. First-time visitors have
// no flag → auto-connect runs as usual.
//
// Every read is SSR-safe: returns `false` (= not disconnected → allow
// auto-connect) on the server. Writes no-op on the server.

export type WalletChain = "evm" | "solana" | "sui";

const KEYS: Record<WalletChain, string> = {
  evm:    "defidesh_evm_disconnected",
  solana: "defidesh_solana_disconnected",
  sui:    "defidesh_sui_disconnected",
};

export function isDisconnected(chain: WalletChain): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(KEYS[chain]) === "true";
  } catch {
    return false;
  }
}

export function setDisconnected(chain: WalletChain): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEYS[chain], "true");
  } catch {
    /* quota / disabled storage — silently ignore */
  }
}

export function clearDisconnected(chain: WalletChain): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(KEYS[chain]);
  } catch {
    /* silently ignore */
  }
}
