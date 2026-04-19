"use client";

import { createContext, useContext, useEffect, useRef } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
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
}

const PositionsContext = createContext<PositionsContextValue>({
  positions: [],
  isLoading: false,
  isFetching: false,
  isUsingDemoData: false,
  dataUpdatedAt: 0,
  refetch: () => {},
});

export function PositionsProvider({ children }: { children: React.ReactNode }) {
  const { address } = useAccount();
  // Use addresses from WalletAuthContext — the only source of truth for explicit
  // user connections. Adapter state (useWallet, useCurrentAccount) is not used
  // here because those can reflect locked/silent-reconnect state.
  const { solanaAddress, suiAddress } = useWalletAuth();
  const { watchedWallets } = useWatchedWallets();

  const hasWallet = !!(address || solanaAddress || suiAddress) || watchedWallets.length > 0;

  // Deduplicate connected + watched wallet addresses per chain. EVM is
  // case-insensitive (checksum differences must not count as two wallets);
  // Solana base58 and Sui hex are case-sensitive-equal after lowercasing hex.
  const evmAddresses = Array.from(new Set(
    [address, ...watchedWallets.filter((w) => w.chain === "evm").map((w) => w.address)]
      .filter((a): a is string => !!a)
      .map((a) => a.toLowerCase()),
  ));
  const solanaAddresses = Array.from(new Set(
    [solanaAddress, ...watchedWallets.filter((w) => w.chain === "solana").map((w) => w.address)]
      .filter((a): a is string => !!a),
  ));
  const suiAddresses = Array.from(new Set(
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

  const evmKey = evmAddresses.join(",");
  const solKey = solanaAddresses.join(",");
  const suiKey = suiAddresses.join(",");

  const { data: walletPositions, isLoading, isFetching, dataUpdatedAt, refetch } = useQuery({
    queryKey: ["positions", evmKey, solKey, suiKey],
    queryFn: async () => {
      const promises: Promise<AerodromePosition[]>[] = [];

      for (const a of evmAddresses) {
        promises.push(
          fetchAerodromePositions(a),
          fetchUniswapV3Positions(a),
          fetchVelodromePositions(a),
          fetchHyperSwapPositions(a),
          fetchPancakeSwapPositions(a),
        );
      }

      for (const a of solanaAddresses) {
        promises.push(
          fetchRaydiumPositions(a),
          fetchOrcaPositions(a),
        );
      }

      for (const a of suiAddresses) {
        promises.push(
          fetchCetusPositions(a),
          fetchBluefinPositions(a),
          fetchMomentumPositions(a),
        );
      }

      const results = await Promise.all(promises);
      return results.flat();
    },
    enabled: hasWallet,
    staleTime: 60_000,
    refetchInterval: hasWallet ? 60_000 : false,
    placeholderData: keepPreviousData,
  });

  const positions = walletPositions || [];

  return (
    <PositionsContext.Provider value={{ positions, isLoading, isFetching, isUsingDemoData: false, dataUpdatedAt, refetch }}>
      {children}
    </PositionsContext.Provider>
  );
}

export function usePositions() {
  return useContext(PositionsContext);
}
