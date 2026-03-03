"use client";

import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SuiClientProvider, WalletProvider as SuiWalletProvider, createNetworkConfig } from "@mysten/dapp-kit";
import { config } from "./config/wagmi";
import { PositionsProvider } from "./contexts/PositionsContext";

const queryClient = new QueryClient();
const solanaWallets = [new PhantomWalletAdapter()];
const SOLANA_RPC = "https://api.mainnet-beta.solana.com";

const { networkConfig: suiNetworkConfig } = createNetworkConfig({
  mainnet: { url: "https://fullnode.mainnet.sui.io:443", network: "mainnet" as const },
});

export default function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ConnectionProvider endpoint={SOLANA_RPC}>
      <WalletProvider wallets={solanaWallets} autoConnect={false}>
        <WagmiProvider config={config}>
          <QueryClientProvider client={queryClient}>
            <SuiClientProvider networks={suiNetworkConfig} defaultNetwork="mainnet">
              <SuiWalletProvider autoConnect={false}>
                <PositionsProvider>
                  {children}
                </PositionsProvider>
              </SuiWalletProvider>
            </SuiClientProvider>
          </QueryClientProvider>
        </WagmiProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
