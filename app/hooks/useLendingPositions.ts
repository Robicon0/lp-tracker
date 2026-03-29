"use client";

import { useState, useEffect, useRef } from "react";
import { useAccount } from "wagmi";
import { useWalletAuth } from "../contexts/WalletAuthContext";

// AlphaFi/AlphaLend (Sui) — implemented via raw Sui RPC in /api/lending/alphafi/route.ts
// Uses suix_getOwnedObjects to find PositionCap objects, then reads position details.
// Package: 0xee754fc0c6d977403c9218cedbfffed033b4b42b50a65c2c3f1c7be13efeafd2

export interface ExternalLendingAsset {
  symbol: string;
  amount: number;
  usdValue: number;
  apy: number;
}

export interface ExternalLendingPosition {
  protocol: string;
  chain: string;
  totalSupplied: number;
  totalBorrowed: number;
  supplyApy: number; // weighted avg
  borrowApy: number; // weighted avg
  suppliedAssets: ExternalLendingAsset[];
  borrowedAssets: ExternalLendingAsset[];
  manageUrl: string;
}

export interface UseLendingPositionsData {
  positions: ExternalLendingPosition[];
  isLoading: boolean;
}

const MANAGE_URLS: Record<string, string> = {
  Dolomite:       "https://app.dolomite.io/balances",
  "Jupiter Lend": "https://jup.ag/lend",
  AlphaFi:        "https://app.alphafi.xyz/alphalend",
};

function buildPosition(
  data: { supplies: ExternalLendingAsset[]; borrows: ExternalLendingAsset[]; protocol: string; chain: string },
): ExternalLendingPosition | null {
  const { supplies, borrows, protocol, chain } = data;
  if (supplies.length === 0 && borrows.length === 0) return null;

  const totalSupplied = supplies.reduce((s, a) => s + a.usdValue, 0);
  const totalBorrowed = borrows.reduce((s, a) => s + a.usdValue, 0);

  const supplyApy = totalSupplied > 0
    ? supplies.reduce((s, a) => s + a.apy * a.usdValue, 0) / totalSupplied
    : 0;
  const borrowApy = totalBorrowed > 0
    ? borrows.reduce((s, a) => s + a.apy * a.usdValue, 0) / totalBorrowed
    : 0;

  return {
    protocol,
    chain,
    totalSupplied,
    totalBorrowed,
    supplyApy,
    borrowApy,
    suppliedAssets: supplies,
    borrowedAssets: borrows,
    manageUrl: MANAGE_URLS[protocol] ?? "#",
  };
}

export function useLendingPositions(): UseLendingPositionsData {
  const { address } = useAccount();
  const { solanaAddress, suiAddress } = useWalletAuth();

  const fetchedForRef = useRef<string | null>(null);

  const [data, setData] = useState<UseLendingPositionsData>({
    positions: [],
    isLoading: false,
  });

  useEffect(() => {
    // Composite key — same pattern as useWalletTokens
    const fetchKey = [address, solanaAddress, suiAddress].filter(Boolean).join("|") || null;
    if (!fetchKey || fetchedForRef.current === fetchKey) return;

    fetchedForRef.current = fetchKey;
    let cancelled = false;
    let fetchCompleted = false;
    setData((prev) => ({ ...prev, isLoading: true }));

    const timeoutId = setTimeout(() => {
      if (!cancelled) {
        console.error("[useLendingPositions] timed out after 30s");
        cancelled = true;
        setData((prev) => ({ ...prev, isLoading: false }));
      }
    }, 30_000);

    (async () => {
      try {
        const tasks: Promise<ExternalLendingPosition | null>[] = [];

        // ── Dolomite (Arbitrum) ───────────────────────────────────────────────
        if (address) {
          tasks.push((async () => {
            try {
              console.log("[useLendingPositions] Fetching Dolomite...");
              const res = await fetch(`/api/lending/dolomite?account=${address}`).then((r) => r.json());
              if (cancelled) return null;
              return buildPosition({
                supplies: res.supplies ?? [],
                borrows:  res.borrows  ?? [],
                protocol: "Dolomite",
                chain:    "Arbitrum",
              });
            } catch (err) {
              console.error("[useLendingPositions] Dolomite fetch failed:", err);
              return null;
            }
          })());
        }

        // ── Jupiter Lend (Solana) ─────────────────────────────────────────────
        if (solanaAddress) {
          tasks.push((async () => {
            try {
              console.log("[useLendingPositions] Fetching Jupiter Lend...");
              const res = await fetch(`/api/lending/jupiter?account=${solanaAddress}`).then((r) => r.json());
              if (cancelled) return null;
              if (res.note) {
                // API key not configured — log once, return null silently
                console.info("[useLendingPositions] Jupiter Lend:", res.note);
              }
              return buildPosition({
                supplies: res.supplies ?? [],
                borrows:  res.borrows  ?? [],
                protocol: "Jupiter Lend",
                chain:    "Solana",
              });
            } catch (err) {
              console.error("[useLendingPositions] Jupiter Lend fetch failed:", err);
              return null;
            }
          })());
        }

        // ── AlphaFi / AlphaLend (Sui) ─────────────────────────────────────────
        if (suiAddress) {
          tasks.push((async () => {
            try {
              console.log("[useLendingPositions] Fetching AlphaFi...");
              const res = await fetch(`/api/lending/alphafi?account=${suiAddress}`).then((r) => r.json());
              if (cancelled) return null;
              return buildPosition({
                supplies: res.supplies ?? [],
                borrows:  res.borrows  ?? [],
                protocol: "AlphaFi",
                chain:    "Sui",
              });
            } catch (err) {
              console.error("[useLendingPositions] AlphaFi fetch failed:", err);
              return null;
            }
          })());
        }

        const results = await Promise.allSettled(tasks);
        if (cancelled) return;

        const positions = results
          .filter((r): r is PromiseFulfilledResult<ExternalLendingPosition | null> => r.status === "fulfilled")
          .map((r) => r.value)
          .filter((p): p is ExternalLendingPosition => p !== null);

        console.log("[useLendingPositions] found", positions.length, "external lending positions");
        fetchCompleted = true;
        clearTimeout(timeoutId);
        setData({ positions, isLoading: false });
      } catch (err) {
        console.error("[useLendingPositions] unexpected error:", err);
        clearTimeout(timeoutId);
        if (!cancelled) setData((prev) => ({ ...prev, isLoading: false }));
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
      if (!fetchCompleted) fetchedForRef.current = null;
    };
  }, [address, solanaAddress]);

  return data;
}
