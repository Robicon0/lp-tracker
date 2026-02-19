import { http, createConfig } from "wagmi";
import { mainnet, base, arbitrum, optimism, polygon, avalanche } from "wagmi/chains";
import { injected } from "wagmi/connectors";

export const config = createConfig({
  chains: [mainnet, base, arbitrum, optimism, polygon, avalanche],
  connectors: [
    injected(), // MetaMask and other browser wallets
  ],
  transports: {
    [mainnet.id]: http(),
    [base.id]: http(),
    [arbitrum.id]: http(),
    [optimism.id]: http(),
    [polygon.id]: http(),
    [avalanche.id]: http(),
  },
});