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

export function useWalletLevelFees(
  positions: AerodromePosition[],
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
  }, [positions]);

  return { events, isLoading };
}
