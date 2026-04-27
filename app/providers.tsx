"use client";

import { useState, useEffect } from "react";
import { WagmiProvider, useDisconnect } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { SuiClientProvider, WalletProvider as SuiWalletProvider, createNetworkConfig } from "@mysten/dapp-kit";
import { config } from "./config/wagmi";
import { PositionsProvider } from "./contexts/PositionsContext";
import { WalletAuthProvider } from "./contexts/WalletAuthContext";
import { WatchedWalletsProvider } from "./contexts/WatchedWalletsContext";
import { isDisconnected } from "./lib/walletDisconnectFlag";

const queryClient = new QueryClient();
// Empty array: WalletProvider auto-detects any Solana Wallet Standard-compliant
// wallet installed in the browser (Phantom, Backpack, Solflare, etc.)
const solanaWallets: never[] = [];
const SOLANA_RPC = "https://api.mainnet-beta.solana.com";

const { networkConfig: suiNetworkConfig } = createNetworkConfig({
  mainnet: { url: "https://fullnode.mainnet.sui.io:443", network: "mainnet" as const },
});

// EVM gate — wagmi auto-reconnects from its own storage on mount. When the
// user explicitly disconnected last session we honour that by force-
// disconnecting on mount so the connector doesn't silently restore from its
// internal storage. Sits inside WagmiProvider so it can call useDisconnect.
function EvmDisconnectGate() {
  const { disconnect } = useDisconnect();
  useEffect(() => {
    if (isDisconnected("evm")) {
      disconnect();
    }
    // Run once on mount; subsequent disconnects are user-driven.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

export default function Providers({ children }: { children: React.ReactNode }) {
  // Read each chain's "explicitly disconnected" flag synchronously on first
  // render so providers mount with the correct autoConnect value. Default
  // (no flag, first visit) = autoConnect ON; flag set = autoConnect OFF.
  const [solanaAutoConnect] = useState(() => !isDisconnected("solana"));
  const [suiAutoConnect] = useState(() => !isDisconnected("sui"));

  return (
    <ConnectionProvider endpoint={SOLANA_RPC}>
      <WalletProvider wallets={solanaWallets} autoConnect={solanaAutoConnect}>
        <WalletAuthProvider>
          <WagmiProvider config={config}>
            <QueryClientProvider client={queryClient}>
              <EvmDisconnectGate />
              <SuiClientProvider networks={suiNetworkConfig} defaultNetwork="mainnet">
                <SuiWalletProvider autoConnect={suiAutoConnect}>
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
