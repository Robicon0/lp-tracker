"use client";

import { createContext, useContext } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount } from "wagmi";
import { fetchAerodromePositions, AerodromePosition } from "../lib/aerodrome";
import { fetchUniswapV3Positions } from "../lib/uniswap";
import { fetchVelodromePositions } from "../lib/velodrome";
import { positions as demoPositions } from "../data/positions";

interface PositionsContextValue {
  positions: AerodromePosition[];
  isLoading: boolean;
  isUsingDemoData: boolean;
}

const PositionsContext = createContext<PositionsContextValue>({
  positions: demoPositions,
  isLoading: false,
  isUsingDemoData: true,
});

export function PositionsProvider({ children }: { children: React.ReactNode }) {
  const { address, isConnected } = useAccount();

  const { data: walletPositions, isLoading } = useQuery({
    queryKey: ["positions", address],
    queryFn: async () => {
      const [aeroPos, uniPos, veloPos] = await Promise.all([
        fetchAerodromePositions(address!),
        fetchUniswapV3Positions(address!),
        fetchVelodromePositions(address!),
      ]);
      return [...aeroPos, ...uniPos, ...veloPos];
    },
    enabled: isConnected && !!address,
    staleTime: 60_000,
  });

  const isUsingDemoData = false;
  const positions = walletPositions || [];

  return (
    <PositionsContext.Provider value={{ positions, isLoading, isUsingDemoData }}>
      {children}
    </PositionsContext.Provider>
  );
}

export function usePositions() {
  return useContext(PositionsContext);
}
