"use client";

import { createContext, useContext, useEffect, useMemo, useRef } from "react";
import { useQueries, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { useAccount } from "wagmi";
import { fetchAerodromePositions, AerodromePosition } from "../lib/aerodrome";
import { useWalletAuth } from "./WalletAuthContext";
import { useWatchedWallets } from "./WatchedWalletsContext";
import { fetchUniswapV3Positions } from "../lib/uniswap";
import { fetchVelodromePositions } from "../lib/velodrome";
import { fetchRaydiumPositions } from "../lib/raydium";
import { fetchOrcaPositions } from "../lib/orca";
import { fetchCetusPositions } from "../lib/cetus";
import { fetchBluefinPositions } from "../lib/bluefin";
import { fetchMomentumPositions } from "../lib/momentum";
import { fetchHyperSwapPositions } from "../lib/hyperswap";
import { fetchPancakeSwapPositions } from "../lib/pancakeswap";

interface PositionsContextValue {
  positions: AerodromePosition[];
  isLoading: boolean;
  isFetching: boolean;
  isUsingDemoData: boolean;
  dataUpdatedAt: number;
  refetch: () => void;
  // Sprint PERFORMANCE: sources (protocol names) whose FIRST load hasn't
  // resolved yet — lets pages show a subtle "still scanning X…" hint while
  // already-arrived positions render. Empty once everything has loaded.
  pendingSources: string[];
}

const PositionsContext = createContext<PositionsContextValue>({
  positions: [],
  isLoading: false,
  isFetching: false,
  isUsingDemoData: false,
  dataUpdatedAt: 0,
  refetch: () => {},
  pendingSources: [],
});

// One entry per (protocol source, wallet address) — each becomes its own React
// Query so positions stream into the UI as each source resolves, instead of the
// previous single Promise.all that blanked the page until the SLOWEST route
// (Aerodrome, ~35s) finished while nine sub-4s routes sat ready (Sprint
// PERFORMANCE item 3). Fetchers already catch and return [] on failure, so a
// failed source contributes nothing (same behavior as before).
interface SourceQuery {
  label: string; // protocol display label for pendingSources
  address: string;
  fetcher: (address: string) => Promise<AerodromePosition[]>;
}

export function PositionsProvider({ children }: { children: React.ReactNode }) {
  const { address } = useAccount();
  // Use addresses from WalletAuthContext — the only source of truth for explicit
  // user connections. Adapter state (useWallet, useCurrentAccount) is not used
  // here because those can reflect locked/silent-reconnect state.
  const { solanaAddress, suiAddress } = useWalletAuth();
  const { watchedWallets, scanAddress } = useWatchedWallets();
  const queryClient = useQueryClient();

  // SCAN MODE: when scanAddress is set (from /dashboard?address=&chain=),
  // ignore connected wallets AND saved watched wallets entirely — fetch ONLY
  // the scan address on its declared chain. The dashboard banner makes the
  // override visible to the user.
  const isScanMode = scanAddress !== null;

  const hasWallet = isScanMode || !!(address || solanaAddress || suiAddress) || watchedWallets.length > 0;

  // Deduplicate connected + watched wallet addresses per chain. EVM is
  // case-insensitive (checksum differences must not count as two wallets);
  // Solana base58 and Sui hex are case-sensitive-equal after lowercasing hex.
  const evmAddresses = isScanMode
    ? (scanAddress!.chain === "evm" ? [scanAddress!.address.toLowerCase()] : [])
    : Array.from(new Set(
        [address, ...watchedWallets.filter((w) => w.chain === "evm").map((w) => w.address)]
          .filter((a): a is string => !!a)
          .map((a) => a.toLowerCase()),
      ));
  const solanaAddresses = isScanMode
    ? (scanAddress!.chain === "solana" ? [scanAddress!.address] : [])
    : Array.from(new Set(
        [solanaAddress, ...watchedWallets.filter((w) => w.chain === "solana").map((w) => w.address)]
          .filter((a): a is string => !!a),
      ));
  const suiAddresses = isScanMode
    ? (scanAddress!.chain === "sui" ? [scanAddress!.address.toLowerCase()] : [])
    : Array.from(new Set(
        [suiAddress, ...watchedWallets.filter((w) => w.chain === "sui").map((w) => w.address.toLowerCase())]
          .filter((a): a is string => !!a),
      ));

  // Auto-register connected wallets with the snapshot DB so the cron job
  // knows which addresses to track historically. Fire-and-forget; silently
  // no-ops if the DB isn't configured (returns 503).
  const registeredRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const toRegister: Array<{ address: string; chain: "evm" | "solana" | "sui" }> = [];
    if (address) toRegister.push({ address, chain: "evm" });
    if (solanaAddress) toRegister.push({ address: solanaAddress, chain: "solana" });
    if (suiAddress) toRegister.push({ address: suiAddress, chain: "sui" });
    for (const w of toRegister) {
      const key = `${w.chain}:${w.address}`;
      if (registeredRef.current.has(key)) continue;
      registeredRef.current.add(key);
      fetch("/api/wallets/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(w),
      }).catch(() => {
        // Best-effort: don't surface DB errors to the user.
        registeredRef.current.delete(key);
      });
    }
  }, [address, solanaAddress, suiAddress]);

  // Build the per-(source, address) query list. Order is stable for a given
  // address set, and each query is independently keyed, so one slow source
  // never gates the others.
  const sources: SourceQuery[] = [];
  for (const a of evmAddresses) {
    sources.push(
      { label: "Aerodrome", address: a, fetcher: fetchAerodromePositions },
      { label: "Uniswap V3", address: a, fetcher: fetchUniswapV3Positions },
      { label: "Velodrome", address: a, fetcher: fetchVelodromePositions },
      { label: "HyperEVM", address: a, fetcher: fetchHyperSwapPositions },
      { label: "PancakeSwap", address: a, fetcher: fetchPancakeSwapPositions },
    );
  }
  for (const a of solanaAddresses) {
    sources.push(
      { label: "Raydium", address: a, fetcher: fetchRaydiumPositions },
      { label: "Orca", address: a, fetcher: fetchOrcaPositions },
    );
  }
  for (const a of suiAddresses) {
    sources.push(
      { label: "Cetus", address: a, fetcher: fetchCetusPositions },
      { label: "Bluefin", address: a, fetcher: fetchBluefinPositions },
      { label: "Momentum", address: a, fetcher: fetchMomentumPositions },
    );
  }

  const queries = useQueries({
    queries: sources.map((s) => ({
      queryKey: ["positions", s.label, s.address],
      queryFn: () => s.fetcher(s.address),
      enabled: hasWallet,
      staleTime: 60_000,
      refetchInterval: hasWallet ? 60_000 : false,
      // Keep the previous source's rows visible during the 60s background
      // refresh — no flash/blank between refetches (same UX as before).
      placeholderData: keepPreviousData,
    })),
  });

  // Combine per-source results. Memoized on a stable signature (per-query
  // dataUpdatedAt) so the positions array identity only changes when some
  // source actually delivered new data — downstream hooks (useLpPnl etc.)
  // depend on that identity and were built for wave-by-wave arrival.
  const signature = queries.map((q) => q.dataUpdatedAt).join(",") + `|${sources.length}`;
  const positions = useMemo(
    () => queries.flatMap((q) => q.data ?? []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [signature],
  );

  // isLoading = nothing has arrived yet (initial blank state only). Once ANY
  // source resolves, rows render and isLoading drops — the remaining sources
  // are reported via pendingSources/isFetching instead of blanking the page.
  const isLoading = hasWallet && queries.length > 0 && queries.every((q) => q.isPending);
  const isFetching = queries.some((q) => q.isFetching);
  const dataUpdatedAt = queries.reduce((m, q) => Math.max(m, q.dataUpdatedAt), 0);
  const pendingSources = useMemo(() => {
    const labels = new Set<string>();
    queries.forEach((q, i) => { if (q.isPending) labels.add(sources[i].label); });
    return [...labels];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, queries.filter((q) => q.isPending).length]);

  const refetch = () => { void queryClient.invalidateQueries({ queryKey: ["positions"] }); };

  return (
    <PositionsContext.Provider value={{ positions, isLoading, isFetching, isUsingDemoData: false, dataUpdatedAt, refetch, pendingSources }}>
      {children}
    </PositionsContext.Provider>
  );
}

export function usePositions() {
  return useContext(PositionsContext);
}
