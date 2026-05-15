"use client";

import { useState, useEffect, useRef } from "react";
import { useAccount } from "wagmi";
import { useWalletAuth } from "../contexts/WalletAuthContext";
import { useWatchedWallets } from "../contexts/WatchedWalletsContext";

// AlphaFi/AlphaLend (Sui) — implemented via raw Sui RPC in /api/lending/alphafi/route.ts
// Uses suix_getOwnedObjects to find PositionCap objects, then reads position details.
// Package: 0xee754fc0c6d977403c9218cedbfffed033b4b42b50a65c2c3f1c7be13efeafd2

export interface ExternalLendingAsset {
  symbol: string;
  amount: number;
  usdValue: number;
  apy: number | null; // null = unavailable
}

export interface ExternalLendingPosition {
  protocol: string;
  chain: string;
  totalSupplied: number;
  totalBorrowed: number;
  supplyApy: number | null; // null = no APY data available; weighted avg otherwise
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
  Suilend:        "https://app.suilend.fi",
  HyperLend:      "https://app.hyperlend.finance/dashboard",
  Kamino:         "https://app.kamino.finance/lending",
  HypurrFi:       "https://hypurr.fi",
};

function buildPosition(
  data: { supplies: ExternalLendingAsset[]; borrows: ExternalLendingAsset[]; protocol: string; chain: string },
): ExternalLendingPosition | null {
  const { supplies, borrows, protocol, chain } = data;
  if (supplies.length === 0 && borrows.length === 0) return null;

  const totalSupplied = supplies.reduce((s, a) => s + a.usdValue, 0);
  const totalBorrowed = borrows.reduce((s, a) => s + a.usdValue, 0);

  // supplyApy is null if no asset has APY data; otherwise weighted avg (null assets treated as 0)
  const hasAnyApyData = supplies.some((a) => a.apy !== null);
  const supplyApy: number | null = !hasAnyApyData
    ? null
    : totalSupplied > 0
    ? supplies.reduce((s, a) => s + (a.apy ?? 0) * a.usdValue, 0) / totalSupplied
    : 0;

  const borrowApy = totalBorrowed > 0
    ? borrows.reduce((s, a) => s + (a.apy ?? 0) * a.usdValue, 0) / totalBorrowed
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
  const { watchedWallets, scanAddress } = useWatchedWallets();

  // SCAN MODE: ignore connected + watched and fetch ONLY the scan address.
  const isScanMode = scanAddress !== null;

  const evmAddresses = isScanMode
    ? (scanAddress!.chain === "evm" ? [scanAddress!.address.toLowerCase()] : [])
    : Array.from(new Set(
        [address, ...watchedWallets.filter((w) => w.chain === "evm").map((w) => w.address)]
          .filter((a): a is string => !!a)
          .map((a) => a.toLowerCase())
      ));
  const solanaAddresses = isScanMode
    ? (scanAddress!.chain === "solana" ? [scanAddress!.address] : [])
    : Array.from(new Set(
        [solanaAddress, ...watchedWallets.filter((w) => w.chain === "solana").map((w) => w.address)]
          .filter((a): a is string => !!a)
      ));
  const suiAddresses = isScanMode
    ? (scanAddress!.chain === "sui" ? [scanAddress!.address] : [])
    : Array.from(new Set(
        [suiAddress, ...watchedWallets.filter((w) => w.chain === "sui").map((w) => w.address)]
          .filter((a): a is string => !!a)
      ));
  const evmKey = evmAddresses.join(",");
  const solKey = solanaAddresses.join(",");
  const suiKey = suiAddresses.join(",");

  const fetchedForRef = useRef<string | null>(null);

  const [data, setData] = useState<UseLendingPositionsData>({
    positions: [],
    isLoading: false,
  });

  useEffect(() => {
    // Composite key — same pattern as useWalletTokens
    const fetchKey = [evmKey, solKey, suiKey].filter(Boolean).join("|") || null;
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

        async function fetchMerged(
          addrs: string[],
          endpoint: string,
          protocol: string,
          chain: string,
        ): Promise<ExternalLendingPosition | null> {
          if (addrs.length === 0) return null;
          try {
            // Per-wallet visibility: log the exact address list we fetch for
            // each protocol so multi-wallet setups are debuggable from the
            // browser console without server access. Each address gets its
            // own /api call below — never just the first address.
            console.log(
              `[useLendingPositions] ${protocol}: querying ${addrs.length} ${chain} address(es) →`,
              addrs.map((a) => `${a.slice(0, 6)}…${a.slice(-4)}`),
            );
            const results = await Promise.allSettled(
              addrs.map((a) => fetch(`${endpoint}?account=${a}`).then((r) => r.json())),
            );
            if (cancelled) return null;
            const supplies: ExternalLendingAsset[] = [];
            const borrows: ExternalLendingAsset[] = [];
            for (let i = 0; i < results.length; i++) {
              const r = results[i];
              const addr = addrs[i];
              const tag = `${addr.slice(0, 6)}…${addr.slice(-4)}`;
              if (r.status !== "fulfilled") {
                console.warn(`[useLendingPositions] ${protocol} ${tag} → fetch rejected:`, r.reason);
                continue;
              }
              if (r.value?.note) console.info(`[useLendingPositions] ${protocol} ${tag}: ${r.value.note}`);
              const sN = (r.value?.supplies ?? []).length;
              const bN = (r.value?.borrows  ?? []).length;
              console.log(`[useLendingPositions] ${protocol} ${tag} → ${sN} supplies, ${bN} borrows`);
              for (const s of (r.value?.supplies ?? []) as ExternalLendingAsset[]) supplies.push(s);
              for (const b of (r.value?.borrows  ?? []) as ExternalLendingAsset[]) borrows.push(b);
            }
            return buildPosition({ supplies, borrows, protocol, chain });
          } catch (err) {
            console.error(`[useLendingPositions] ${protocol} fetch failed:`, err);
            return null;
          }
        }

        // ── Dolomite (Arbitrum) ───────────────────────────────────────────────
        tasks.push(fetchMerged(evmAddresses, "/api/lending/dolomite", "Dolomite", "Arbitrum"));
        // ── Jupiter Lend (Solana) ─────────────────────────────────────────────
        tasks.push(fetchMerged(solanaAddresses, "/api/lending/jupiter", "Jupiter Lend", "Solana"));
        // ── Suilend (Sui) ────────────────────────────────────────────────────
        tasks.push(fetchMerged(suiAddresses, "/api/lending/suilend", "Suilend", "Sui"));
        // ── AlphaFi / AlphaLend (Sui) ─────────────────────────────────────────
        tasks.push(fetchMerged(suiAddresses, "/api/lending/alphafi", "AlphaFi", "Sui"));
        // ── HyperLend (HyperEVM) ─────────────────────────────────────────────
        tasks.push(fetchMerged(evmAddresses, "/api/lending/hyperlend", "HyperLend", "HyperEVM"));
        // ── HypurrFi (HyperEVM) ──────────────────────────────────────────────
        tasks.push(fetchMerged(evmAddresses, "/api/lending/hypurrfi", "HypurrFi", "HyperEVM"));
        // ── Kamino Finance (Solana) ──────────────────────────────────────────
        tasks.push(fetchMerged(solanaAddresses, "/api/lending/kamino", "Kamino", "Solana"));

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
  }, [evmKey, solKey, suiKey]);

  return data;
}
