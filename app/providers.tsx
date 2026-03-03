"use client";

import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { config } from "./config/wagmi";
import { PositionsProvider } from "./contexts/PositionsContext";

const queryClient = new QueryClient();
const solanaWallets = [new PhantomWalletAdapter()];
// Public RPC for wallet connection — Helius key is used only server-side in API routes
const SOLANA_RPC = "https://api.mainnet-beta.solana.com";

export default function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ConnectionProvider endpoint={SOLANA_RPC}>
      <WalletProvider wallets={solanaWallets} autoConnect={false}>
        <WagmiProvider config={config}>
          <QueryClientProvider client={queryClient}>
            <PositionsProvider>
              {children}
            </PositionsProvider>
          </QueryClientProvider>
        </WagmiProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}