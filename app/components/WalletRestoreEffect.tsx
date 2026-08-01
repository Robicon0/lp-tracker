"use client";

import { useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletReadyState } from "@solana/wallet-adapter-base";
import { useCurrentAccount, useWallets } from "@mysten/dapp-kit";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { useWalletAuth } from "../contexts/WalletAuthContext";

// Restores `solanaAddress` / `suiAddress` in WalletAuthContext after a page
// refresh. Mounted once at the root in `app/layout.tsx`, so it is the SINGLE
// owner of Solana/Sui restore, persist, and clear. (The duplicate copy that
// used to live in `app/Navbar.tsx` was removed — two components racing to
// delete the same keys was an aggravating factor in the bug below. Navbar
// still owns the explicit CONNECT capture, which is connect mechanics, not
// restore.)
//
// ─────────────────────────────────────────────────────────────────────────
// THE BUG THIS FILE EXISTS TO NOT REPEAT (fixed 2026-08-02)
//
// Sui wallets "disconnected" on their own and had to be re-added by hand,
// every time. Cause: this component destroyed persisted state in response to
// an ambiguous reading, in two places.
//
//   1. `useWallets()` is populated ASYNCHRONOUSLY — Wallet Standard
//      extensions announce themselves via window events after page load. On
//      the first render the array is empty whether or not a wallet exists.
//      The old code read `suiWallets.length === 0` as "no wallet installed"
//      and deleted BOTH our `defidesh-sui-addr` AND dapp-kit's private
//      `dapp-kit:wallet-connection-info`. Deleting the latter is what made
//      it unrecoverable: dapp-kit could no longer auto-reconnect, so the
//      user had to re-add the wallet manually.
//
//   2. `useCurrentAccount()` returns null until autoConnect resolves. Any
//      momentary null — extension hiccup, wallet switch, extension update,
//      tab backgrounding — permanently deleted the saved address.
//
// Reproduced live: both keys were gone within 500 ms of page load.
//
// THE RULE, which mirrors `useClearOnConfirmedConnect` in providers.tsx (it
// skips its first effect run for exactly this reason): an "empty" or "absent"
// reading from an asynchronously-initialising adapter is NOT EVIDENCE OF
// ABSENCE. Never take a destructive action on it until it has settled. This
// is the same principle as `suiRpcIndexed()` throwing SuiIndexUnavailableError
// instead of returning an empty result that masquerades as "no data".
//
// Three invariants now enforced below:
//   (a) Destructive cleanup waits for WALLET_SETTLE_MS, and a disconnect must
//       PERSIST for CLEAR_DEBOUNCE_MS before the address is dropped.
//   (b) We never delete another library's private storage
//       (`dapp-kit:wallet-connection-info`, Solana's `walletName`). Those
//       belong to dapp-kit / the wallet adapter and deleting them destroys
//       their ability to self-recover. Our own key is the only one we own.
//   (c) Address comparison is NORMALIZED, so an equivalent-but-differently-
//       formatted address (Sui short form vs 32-byte padded) still matches.
// ─────────────────────────────────────────────────────────────────────────

// How long to wait before an empty wallet registry may be believed.
//
// DELIBERATELY GENEROUS. The asymmetry is the whole point: being slow to clear
// a stale key costs nothing a user can perceive (the UI reads the context, not
// this key, so a lingering key displays NOTHING on its own), whereas clearing
// a live user's connection costs them a manual reconnect. So the window is set
// far beyond any realistic Wallet Standard announce time rather than close to
// it.
//
// A tight window would leave the ORIGINAL BUG partly alive in precisely the
// case users reported — "correlates with browser restarts." On a cold start
// the browser, the extension process and the page are all initialising at
// once, and an extension can announce noticeably later than on a warm load.
// If cleanup fired at 3 s and the extension announced at 3.5 s, we would
// delete the key moments before the adapter reconnects, and restore would find
// nothing — the user sees the same self-disconnect. 15 s clears that margin
// comfortably; extensions that never announce are simply not installed, and
// their stale key is removed a few seconds later than before.
const WALLET_SETTLE_MS = 15_000;

// How long an adapter must CONTINUOUSLY report no account before we treat it
// as a real disconnect rather than a transient blip.
const CLEAR_DEBOUNCE_MS = 2000;

const SOLANA_KEY = "defidesh-solana-addr";
const SUI_KEY = "defidesh-sui-addr";

/** Normalized Sui equality — tolerates short vs 32-byte-padded hex forms. */
function sameSuiAddress(a: string, b: string): boolean {
  try {
    return normalizeSuiAddress(a) === normalizeSuiAddress(b);
  } catch {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
  }
}

/** Solana base58 is case-SENSITIVE, so normalization is whitespace only. */
function sameSolanaAddress(a: string, b: string): boolean {
  return a.trim() === b.trim();
}

export default function WalletRestoreEffect() {
  const {
    connected: adapterSolanaConnected,
    publicKey: adapterPublicKey,
    wallets: solanaWallets,
  } = useWallet();
  const adapterSuiAccount = useCurrentAccount();
  const suiWallets = useWallets();
  const { solanaAddress, setSolanaAddress, suiAddress, setSuiAddress } = useWalletAuth();

  // Invariant (a): nothing destructive may run until the announce/reconnect
  // window has elapsed. Until then an empty registry means "don't know yet".
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSettled(true), WALLET_SETTLE_MS);
    return () => clearTimeout(t);
  }, []);

  // ── Solana ────────────────────────────────────────────────────────────

  // Persist only. Never clears — a page refresh initialises solanaAddress to
  // null, and clearing here would delete the key before restore could read it.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (solanaAddress) localStorage.setItem(SOLANA_KEY, solanaAddress);
  }, [solanaAddress]);

  // Stale-state cleanup for a browser with no Solana wallet installed.
  // Gated on `settled` so a slow-announcing extension is never mistaken for
  // an absent one. Invariant (b): the adapter's own `walletName` key is left
  // alone — it is the adapter's state, and deleting it breaks its reconnect.
  useEffect(() => {
    if (typeof window === "undefined" || !settled) return;
    const hasInstalled = solanaWallets.some((w) => w.readyState === WalletReadyState.Installed);
    if (!hasInstalled && localStorage.getItem(SOLANA_KEY)) {
      localStorage.removeItem(SOLANA_KEY);
    }
  }, [solanaWallets, settled]);

  // Restore after a silent reconnect: adapter is connected but our context is
  // still null. Requires the saved address to MATCH the adapter's, so an
  // account the user never confirmed here is not silently adopted
  // (wallet-security Rule 1). Invariant (c): comparison is normalized.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!adapterSolanaConnected || !adapterPublicKey || solanaAddress) return;
    const hasInstalled = solanaWallets.some((w) => w.readyState === WalletReadyState.Installed);
    if (!hasInstalled) return; // not yet announced — say nothing, delete nothing
    const saved = localStorage.getItem(SOLANA_KEY);
    if (saved && sameSolanaAddress(saved, adapterPublicKey.toBase58())) {
      setSolanaAddress(saved);
    }
  }, [adapterSolanaConnected, adapterPublicKey, solanaAddress, setSolanaAddress, solanaWallets]);

  // Debounced clear: a disconnect must persist to count. A transient null
  // (extension hiccup, wallet switch, tab backgrounding) cancels the timer.
  const solanaClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (solanaClearTimer.current) {
      clearTimeout(solanaClearTimer.current);
      solanaClearTimer.current = null;
    }
    if (!settled || adapterSolanaConnected || !solanaAddress) return;
    solanaClearTimer.current = setTimeout(() => {
      setSolanaAddress(null);
      try { localStorage.removeItem(SOLANA_KEY); } catch {}
    }, CLEAR_DEBOUNCE_MS);
    return () => {
      if (solanaClearTimer.current) clearTimeout(solanaClearTimer.current);
      solanaClearTimer.current = null;
    };
  }, [adapterSolanaConnected, solanaAddress, setSolanaAddress, settled]);

  // ── Sui ───────────────────────────────────────────────────────────────

  // Persist only — same reasoning as Solana above.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (suiAddress) localStorage.setItem(SUI_KEY, suiAddress);
  }, [suiAddress]);

  // Stale-state cleanup for a browser with no Sui wallet installed. Gated on
  // `settled`. Invariant (b): `dapp-kit:wallet-connection-info` is NEVER
  // touched — that deletion is precisely what made the original bug
  // unrecoverable, because dapp-kit could no longer auto-reconnect.
  useEffect(() => {
    if (typeof window === "undefined" || !settled) return;
    if (suiWallets.length === 0 && localStorage.getItem(SUI_KEY)) {
      localStorage.removeItem(SUI_KEY);
    }
  }, [suiWallets, settled]);

  // Restore after dapp-kit's autoConnect. Normalized match (invariant c).
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!adapterSuiAccount || suiAddress) return;
    if (suiWallets.length === 0) return; // not yet announced — delete nothing
    const saved = localStorage.getItem(SUI_KEY);
    if (saved && sameSuiAddress(saved, adapterSuiAccount.address)) {
      setSuiAddress(saved);
    }
  }, [adapterSuiAccount, suiAddress, setSuiAddress, suiWallets]);

  // Debounced clear — see the Solana equivalent above.
  const suiClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (suiClearTimer.current) {
      clearTimeout(suiClearTimer.current);
      suiClearTimer.current = null;
    }
    if (!settled || adapterSuiAccount || !suiAddress) return;
    suiClearTimer.current = setTimeout(() => {
      setSuiAddress(null);
      try { localStorage.removeItem(SUI_KEY); } catch {}
    }, CLEAR_DEBOUNCE_MS);
    return () => {
      if (suiClearTimer.current) clearTimeout(suiClearTimer.current);
      suiClearTimer.current = null;
    };
  }, [adapterSuiAccount, suiAddress, setSuiAddress, settled]);

  return null;
}
