"use client";

import { createContext, useContext } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount } from "wagmi";
import { useWallet } from "@solana/wallet-adapter-react";
import { fetchAerodromePositions, AerodromePosition } from "../lib/aerodrome";
import { fetchUniswapV3Positions } from "../lib/uniswap";
import { fetchVelodromePositions } from "../lib/velodrome";
import { fetchRaydiumPositions } from "../lib/raydium";
import { fetchOrcaPositions } from "../lib/orca";

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
  const { address, isConnected } = useAccount();
  const { publicKey } = useWallet();
  const solanaAddress = publicKey?.toBase58();

  const { data: walletPositions, isLoading } = useQuery({
    queryKey: ["positions", address, solanaAddress],
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

      const results = await Promise.all(promises);
      return results.flat();
    },
    enabled: !!(address || solanaAddress),
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
