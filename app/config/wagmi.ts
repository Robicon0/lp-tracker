import { http, createConfig } from "wagmi";
import { mainnet, base, arbitrum, optimism, polygon, avalanche } from "wagmi/chains";
import { injected, metaMask, coinbaseWallet, walletConnect } from "wagmi/connectors";

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

const wcProjectId = process.env.NEXT_PUBLIC_WC_PROJECT_ID || "";

const connectors = [
  metaMask(),
  injected({ target: "rabby" }),
  coinbaseWallet({ appName: "DefiDesh" }),
  ...(wcProjectId
    ? [walletConnect({ projectId: wcProjectId, showQrModal: true })]
    : []),
  injected({ target: "phantom" }),
];

export const config = createConfig({
  chains: [mainnet, base, arbitrum, optimism, polygon, avalanche, hyperEvm],
  connectors,
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
