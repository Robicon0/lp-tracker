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

interface BluefinContext {
  account: string;
  coinTypeA: string;
  coinTypeB: string;
  decimalsA: number;
  decimalsB: number;
  priceA: number;
  priceB: number;
}

// Fallback coin context for a Sui wallet that has NO open Bluefin position
// to read real coin types / prices from (i.e. all its Bluefin positions are
// closed and their on-chain objects destroyed). The Bluefin activity route
// in wallet-scope mode only emits fee/reward events; for fee_claim USD it
// uses amount0*priceA + amount1*priceB, so priceB=1 anchors the USDC side
// (the dominant fee leg for SUI/USDC pools). priceA=0 means SUI-denominated
// fee value isn't counted — accepted as graceful (USDC-side fees are still
// recovered, which is strictly better than dropping the whole wallet).
const SUI_FALLBACK = {
  coinTypeA: "0x2::sui::SUI",
  coinTypeB: "0x5d4b302506645c37ff133b98c4b50a4ae4614bb0aef5ba1e3af8bc33af2a9d5f::coin::COIN",
  decimalsA: 9,
  decimalsB: 6,
  priceA: 0,
  priceB: 1,
} as const;

export function useWalletLevelFees(
  positions: AerodromePosition[],
  // Sui wallet addresses (connected + watched) to ALWAYS scan for Bluefin
  // fee history, even when no open Bluefin position exists for them. Without
  // this, a wallet whose Bluefin positions are all closed never gets its
  // lifetime fees fetched.
  suiWalletAddresses?: string[],
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
    const bluefinByWallet = new Map<string, BluefinContext>();
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

    // For any Sui wallet address NOT already covered by an open Bluefin
    // position, add a fallback context so its (closed-position) fee history
    // is still fetched. Dedupe case-insensitively against the open-position
    // wallets so we never double-fetch the same wallet.
    const coveredLower = new Set([...bluefinByWallet.keys()].map((k) => k.toLowerCase()));
    for (const addr of suiWalletAddresses ?? []) {
      if (!addr || coveredLower.has(addr.toLowerCase())) continue;
      coveredLower.add(addr.toLowerCase());
      bluefinByWallet.set(addr, { account: addr, ...SUI_FALLBACK });
    }

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

    if (fetches.length === 0) {
      setEvents([]);
      setIsLoading(false);
      return;
    }

    const key = Array.from(bluefinByWallet.keys()).sort().join("|");
    if (key === fetchedKeyRef.current) return;
    fetchedKeyRef.current = key;

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
  }, [positions, suiWalletAddresses]);

  return { events, isLoading };
}
