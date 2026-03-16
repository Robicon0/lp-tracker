"use client";

import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { SuiClientProvider, WalletProvider as SuiWalletProvider, createNetworkConfig } from "@mysten/dapp-kit";
import { config } from "./config/wagmi";
import { PositionsProvider } from "./contexts/PositionsContext";
import { WalletAuthProvider } from "./contexts/WalletAuthContext";
import { WatchedWalletsProvider } from "./contexts/WatchedWalletsContext";

const queryClient = new QueryClient();
// Empty array: WalletProvider auto-detects any Solana Wallet Standard-compliant
// wallet installed in the browser (Phantom, Backpack, Solflare, etc.)
const solanaWallets: never[] = [];
const SOLANA_RPC = "https://api.mainnet-beta.solana.com";

const { networkConfig: suiNetworkConfig } = createNetworkConfig({
  mainnet: { url: "https://fullnode.mainnet.sui.io:443", network: "mainnet" as const },
});

export default function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ConnectionProvider endpoint={SOLANA_RPC}>
      <WalletProvider wallets={solanaWallets} autoConnect={false}>
        <WalletAuthProvider>
          <WagmiProvider config={config}>
            <QueryClientProvider client={queryClient}>
              <SuiClientProvider networks={suiNetworkConfig} defaultNetwork="mainnet">
                <SuiWalletProvider autoConnect={false}>
                  <WatchedWalletsProvider>
                    <PositionsProvider>
                      {children}
                    </PositionsProvider>
                  </WatchedWalletsProvider>
                </SuiWalletProvider>
              </SuiClientProvider>
            </QueryClientProvider>
          </WagmiProvider>
        </WalletAuthProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
