import { http, createConfig } from "wagmi";
import { mainnet, base, arbitrum, optimism, polygon, avalanche } from "wagmi/chains";
import { injected } from "wagmi/connectors";

const hyperEvm = {
  id: 999,
  name: 'HyperEVM',
  nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.hyperliquid.xyz/evm'] },
  },
  blockExplorers: {
    default: { name: 'HyperEVMScan', url: 'https://hyperevmscan.io' },
  },
} as const;

export const config = createConfig({
  chains: [mainnet, base, arbitrum, optimism, polygon, avalanche, hyperEvm],
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
    [hyperEvm.id]: http(),
  },
});