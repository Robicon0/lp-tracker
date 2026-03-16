"use client";

import { createContext, useContext } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { useAccount } from "wagmi";
import { fetchAerodromePositions, AerodromePosition } from "../lib/aerodrome";
import { useWalletAuth } from "./WalletAuthContext";
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

  const hasWallet = !!(address || solanaAddress || suiAddress);

  const { data: walletPositions, isLoading, isFetching, dataUpdatedAt, refetch } = useQuery({
    queryKey: ["positions", address, solanaAddress, suiAddress],
    queryFn: async () => {
      const promises: Promise<AerodromePosition[]>[] = [];

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
