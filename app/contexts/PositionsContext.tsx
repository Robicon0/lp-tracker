"use client";

import { createContext, useContext } from "react";
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

  // Stable queryKey: stringify watched wallets so React Query refetches when they change
  const watchedKey = watchedWallets.map((w) => `${w.chain}:${w.address}`).join(",");

  const { data: walletPositions, isLoading, isFetching, dataUpdatedAt, refetch } = useQuery({
    queryKey: ["positions", address, solanaAddress, suiAddress, watchedKey],
    queryFn: async () => {
      const promises: Promise<AerodromePosition[]>[] = [];

      // Connected wallets
      if (address) {
        promises.push(
          fetchAerodromePositions(address),
          fetchUniswapV3Positions(address),
          fetchVelodromePositions(address),
          fetchHyperSwapPositions(address),
          fetchPancakeSwapPositions(address),
        );
      }

      if (solanaAddress) {
        promises.push(
          fetchRaydiumPositions(solanaAddress),
          fetchOrcaPositions(solanaAddress),
        );
      }

      if (suiAddress) {
        promises.push(
          fetchCetusPositions(suiAddress),
          fetchBluefinPositions(suiAddress),
          fetchMomentumPositions(suiAddress),
        );
      }

      // Watched wallets
      for (const w of watchedWallets) {
        if (w.chain === "evm") {
          promises.push(
            fetchAerodromePositions(w.address),
            fetchUniswapV3Positions(w.address),
            fetchVelodromePositions(w.address),
            fetchHyperSwapPositions(w.address),
            fetchPancakeSwapPositions(w.address),
          );
        } else if (w.chain === "solana") {
          promises.push(
            fetchRaydiumPositions(w.address),
            fetchOrcaPositions(w.address),
          );
        } else if (w.chain === "sui") {
          promises.push(
            fetchCetusPositions(w.address),
            fetchBluefinPositions(w.address),
            fetchMomentumPositions(w.address),
          );
        }
        // aptos: not yet implemented — skip silently
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
