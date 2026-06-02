"use client";

import { useState, useEffect, useRef } from "react";
import type { AerodromePosition } from "../lib/aerodrome";
import type { ActivityEvent } from "./useAllPositionsActivity";

// Wallet-scope fee events. Captures fees from positions that no longer exist
// as on-chain objects / NFTs — i.e. fully closed Bluefin positions on Sui
// whose object has been destroyed. Per-position activity scans can't see
// these because there's no object to query anymore; a wallet-wide scan of
// protocol events recovers them.
//
// Strategy per chain:
//   Sui / Bluefin:  one call to /api/bluefin/activity?positionId=all per
//                   Sui wallet that has at least one Bluefin position; the
//                   route iterates the wallet's tx history and emits fee +
//                   reward events across ALL Bluefin positions ever owned.
//
// The output is a flat list of ActivityEvent tagged with protocol + chain,
// intended to be merged with per-position events via dedupe-by-txHash so
// open-position events are not double-counted.

export interface TaggedFeeEvent {
  event: ActivityEvent;
  protocol: string;
  chain: string;
}

interface RawActivityResponse {
  events?: ActivityEvent[];
}

interface SuiPoolContext {
  account: string;
  coinTypeA: string;
  coinTypeB: string;
  decimalsA: number;
  decimalsB: number;
  priceA: number;
  priceB: number;
}

// Bluefin fallback context — Bluefin pools are conventionally SUI(A)/USDC(B).
// Used for Sui wallets with no open Bluefin position. `priceA` is injected
// at call site from the live SUI spot.
const BLUEFIN_FALLBACK = {
  coinTypeA: "0x2::sui::SUI",
  coinTypeB: "0x5d4b302506645c37ff133b98c4b50a4ae4614bb0aef5ba1e3af8bc33af2a9d5f::coin::COIN",
  decimalsA: 9,
  decimalsB: 6,
  priceB: 1,
} as const;

// Cetus fallback context — Cetus's canonical USDC/SUI pool is USDC(A,6) /
// SUI(B,9), the REVERSE of Bluefin's ordering. Wallets whose Cetus positions
// are all closed have no open position to read the real ordering from, so
// without this distinct fallback the wallet-scope scan would price USDC
// amounts as SUI (and vice versa) — inflating reported fees by orders of
// magnitude when token decimals + price both flip together (e.g. $10 →
// $10,000 from a single fee_claim where amount_a was actually 10·10^6 USDC
// scaled against decimalsA=9). `priceB` (SUI) is injected at call site.
//
// Wallets in `cetusByWallet` (built from open Cetus positions in `positions`)
// take precedence over this fallback — the real per-position context is
// always preferred when available, mirroring how Bluefin per-wallet contexts
// are built.
const CETUS_FALLBACK = {
  coinTypeA: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
  coinTypeB: "0x2::sui::SUI",
  decimalsA: 6,
  decimalsB: 9,
  priceA: 1,
} as const;

export function useWalletLevelFees(
  positions: AerodromePosition[],
  // Sui wallet addresses (connected + watched) to ALWAYS scan for Bluefin
  // fee history, even when no open Bluefin position exists for them. Without
  // this, a wallet whose Bluefin positions are all closed never gets its
  // lifetime fees fetched.
  suiWalletAddresses?: string[],
  // Live SUI spot price (USD) — used as priceA for the closed-wallet fallback
  // context so SUI-denominated fees are valued correctly instead of $0.
  suiPrice?: number,
): { events: TaggedFeeEvent[]; isLoading: boolean } {
  const [events, setEvents] = useState<TaggedFeeEvent[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const fetchedKeyRef = useRef<string>("");

  useEffect(() => {
    // Group Bluefin positions by wallet. Pick the highest-value position per
    // wallet as the "representative" — its coin types / prices are used as
    // the USD fallback for any fee events from that wallet (fee events from
    // other Bluefin pools in the same wallet will get approximate USD, but
    // that's strictly better than dropping them).
    const bluefinByWallet = new Map<string, SuiPoolContext>();
    for (const p of positions) {
      if (p.protocol !== "Bluefin") continue;
      if (!p.walletAddress || !p.coinTypeA || !p.coinTypeB) continue;
      const existing = bluefinByWallet.get(p.walletAddress);
      if (!existing || p.value > 0) {
        // Always prefer a position with non-zero value as representative.
        if (!existing || p.value > 0) {
          bluefinByWallet.set(p.walletAddress, {
            account: p.walletAddress,
            coinTypeA: p.coinTypeA,
            coinTypeB: p.coinTypeB,
            decimalsA: p.token0Decimals ?? 9,
            decimalsB: p.token1Decimals ?? 6,
            priceA: p.price0 ?? 0,
            priceB: p.price1 ?? 0,
          });
        }
      }
    }

    // Cetus per-wallet context, derived from OPEN Cetus positions (now that
    // the Cetus route returns coinTypeA/coinTypeB on every position). This
    // replaces the previous always-SUI_FALLBACK behaviour that mis-priced
    // USDC/SUI fees by orders of magnitude when the actual pool ordering was
    // USDC(A)/SUI(B). Keyed by LOWERCASE wallet address so the loop below
    // can look up case-insensitively against suiWallets's preserved-casing
    // values.
    const cetusByWalletLower = new Map<string, SuiPoolContext>();
    for (const p of positions) {
      if (p.protocol !== "Cetus") continue;
      if (!p.walletAddress || !p.coinTypeA || !p.coinTypeB) continue;
      const lower = p.walletAddress.toLowerCase();
      const existing = cetusByWalletLower.get(lower);
      if (!existing || p.value > 0) {
        cetusByWalletLower.set(lower, {
          account: p.walletAddress,
          coinTypeA: p.coinTypeA,
          coinTypeB: p.coinTypeB,
          decimalsA: p.token0Decimals ?? 6,
          decimalsB: p.token1Decimals ?? 9,
          priceA: p.price0 ?? 0,
          priceB: p.price1 ?? 0,
        });
      }
    }

    // For any Sui wallet address NOT already covered by an open Bluefin
    // position, add a fallback context so its (closed-position) fee history
    // is still fetched. Dedupe case-insensitively against the open-position
    // wallets so we never double-fetch the same wallet.
    const coveredLower = new Set([...bluefinByWallet.keys()].map((k) => k.toLowerCase()));
    for (const addr of suiWalletAddresses ?? []) {
      if (!addr || coveredLower.has(addr.toLowerCase())) continue;
      coveredLower.add(addr.toLowerCase());
      bluefinByWallet.set(addr, { account: addr, ...BLUEFIN_FALLBACK, priceA: suiPrice && suiPrice > 0 ? suiPrice : 0 });
    }

    // Cetus wallet-scope fee + reward scans — same model as Bluefin above.
    // Cetus position objects don't expose coinTypeA / coinTypeB, so we always
    // use the SUI_FALLBACK context (priceA = live SUI, priceB = 1). The
    // analytics Fee Income memo dedupes by (protocol, txHash, amount0, amount1)
    // and pushes per-position events BEFORE wallet-level ones, so OPEN
    // positions keep their accurate per-position decimals and the wallet-scope
    // pass only adds net-new fees from fully-closed positions.
    //
    // Collect every unique Sui wallet from three sources so the scans fire
    // even when ALL of a protocol's positions are closed (and thus might not
    // appear as open positions in `positions`):
    //   1. bluefinByWallet.keys()  — wallets with Bluefin positions
    //   2. positions where chain === "Sui"  — covers Cetus / Momentum / closed
    //   3. suiWalletAddresses passed in  — connected + watched Sui wallets
    const suiWallets = new Map<string, string>(); // lowercase → original casing
    const addSui = (a?: string) => { if (a) suiWallets.set(a.toLowerCase(), a); };
    for (const a of bluefinByWallet.keys()) addSui(a);
    for (const p of positions) if (p.chain === "Sui") addSui(p.walletAddress);
    for (const a of suiWalletAddresses ?? []) addSui(a);

    const suiPriceA = suiPrice && suiPrice > 0 ? suiPrice : 0;

    // Compute the dedup key BEFORE creating any fetch() promises so we never
    // fire HTTP requests when neither the wallet set, the SUI price, nor any
    // wallet's Cetus pool ordering has changed since the last successful
    // fetch. Previously the key check happened AFTER fetch() calls were
    // already issued, causing redundant network traffic on every dependency
    // re-evaluation. Cetus context signature uses only coinTypeA/B (not
    // prices) so per-minute price refreshes don't trigger expensive
    // wallet-scope tx-history rescans — events cached from a slightly older
    // price are acceptable for lifetime fee totals.
    const allWalletKeys = [...new Set([...bluefinByWallet.keys(), ...suiWallets.keys()])].sort();
    if (allWalletKeys.length === 0) {
      setEvents([]);
      setIsLoading(false);
      return;
    }
    const cetusSig = [...cetusByWalletLower.entries()]
      .map(([w, c]) => `${w}:${c.coinTypeA}:${c.coinTypeB}`)
      .sort()
      .join(",");
    const key = allWalletKeys.join("|") + `::sui${suiPrice ?? 0}` + `::cetus[${cetusSig}]`;
    if (key === fetchedKeyRef.current) return;
    fetchedKeyRef.current = key;

    // Build fetches only after confirming the key changed.
    const fetches: Array<Promise<TaggedFeeEvent[]>> = [];

    for (const ctx of bluefinByWallet.values()) {
      const url =
        `/api/bluefin/activity?positionId=all` +
        `&account=${encodeURIComponent(ctx.account)}` +
        `&coinTypeA=${encodeURIComponent(ctx.coinTypeA)}` +
        `&coinTypeB=${encodeURIComponent(ctx.coinTypeB)}` +
        `&decimalsA=${ctx.decimalsA}&decimalsB=${ctx.decimalsB}` +
        `&priceA=${ctx.priceA}&priceB=${ctx.priceB}`;
      fetches.push(
        fetch(url)
          .then((r) => (r.ok ? (r.json() as Promise<RawActivityResponse>) : { events: [] }))
          .then((j) =>
            (j.events ?? []).map((e) => ({ event: e, protocol: "Bluefin", chain: "Sui" })),
          )
          .catch((err) => {
            console.error("[wallet-fees bluefin] fetch failed:", err);
            return [];
          }),
      );
    }

    for (const acct of suiWallets.values()) {
      // Prefer the real per-wallet Cetus context (from an open position);
      // fall back to USDC(A)/SUI(B) ordering only when no open Cetus
      // position exists for this wallet. The fallback's priceB picks up the
      // live SUI spot so the SUI leg of any fee_claim is valued correctly.
      const realCtx = cetusByWalletLower.get(acct.toLowerCase());
      const ctx: SuiPoolContext = realCtx ?? {
        account: acct,
        ...CETUS_FALLBACK,
        priceB: suiPriceA,
      };
      const cetusUrl =
        `/api/cetus/activity?positionId=all` +
        `&account=${encodeURIComponent(ctx.account)}` +
        `&coinTypeA=${encodeURIComponent(ctx.coinTypeA)}` +
        `&coinTypeB=${encodeURIComponent(ctx.coinTypeB)}` +
        `&decimalsA=${ctx.decimalsA}&decimalsB=${ctx.decimalsB}` +
        `&priceA=${ctx.priceA}&priceB=${ctx.priceB}`;
      fetches.push(
        fetch(cetusUrl)
          .then((r) => (r.ok ? (r.json() as Promise<RawActivityResponse>) : { events: [] }))
          .then((j) =>
            (j.events ?? []).map((e) => ({ event: e, protocol: "Cetus", chain: "Sui" })),
          )
          .catch((err) => {
            console.error("[wallet-fees cetus] fetch failed:", err);
            return [];
          }),
      );
    }

    let cancelled = false;
    setIsLoading(true);
    Promise.all(fetches).then((groups) => {
      if (cancelled) return;
      setEvents(groups.flat());
      setIsLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [positions, suiWalletAddresses, suiPrice]);

  return { events, isLoading };
}
