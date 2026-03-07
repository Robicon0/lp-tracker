"use client";

import { createContext, useContext } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount } from "wagmi";
import { fetchAerodromePositions, AerodromePosition } from "../lib/aerodrome";
import { useWalletAuth } from "./WalletAuthContext";
import { fetchUniswapV3Positions } from "../lib/uniswap";
import { fetchVelodromePositions } from "../lib/velodrome";
import { fetchRaydiumPositions } from "../lib/raydium";
import { fetchOrcaPositions } from "../lib/orca";
import { fetchCetusPositions } from "../lib/cetus";
import { fetchBluefinPositions } from "../lib/bluefin";

interface PositionsContextValue {
  positions: AerodromePosition[];
  isLoading: boolean;
  isUsingDemoData: boolean;
}

const PositionsContext = createContext<PositionsContextValue>({
  positions: [],
  isLoading: false,
  isUsingDemoData: false,
});

export function PositionsProvider({ children }: { children: React.ReactNode }) {
  const { address } = useAccount();
  // Use addresses from WalletAuthContext — the only source of truth for explicit
  // user connections. Adapter state (useWallet, useCurrentAccount) is not used
  // here because those can reflect locked/silent-reconnect state.
  const { solanaAddress, suiAddress } = useWalletAuth();

  const { data: walletPositions, isLoading } = useQuery({
    queryKey: ["positions", address, solanaAddress, suiAddress],
    queryFn: async () => {
      const promises: Promise<AerodromePosition[]>[] = [];

      if (address) {
        promises.push(
          fetchAerodromePositions(address),
          fetchUniswapV3Positions(address),
          fetchVelodromePositions(address),
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
        );
      }

      const results = await Promise.all(promises);
      return results.flat();
    },
    enabled: !!(address || solanaAddress || suiAddress),
    staleTime: 60_000,
  });

  const positions = walletPositions || [];

  return (
    <PositionsContext.Provider value={{ positions, isLoading, isUsingDemoData: false }}>
      {children}
    </PositionsContext.Provider>
  );
}

export function usePositions() {
  return useContext(PositionsContext);
}
