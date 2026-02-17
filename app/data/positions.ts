export interface LPPosition {
  id: string;
  pair: string;
  protocol: string;
  chain: string;
  value: number;
  apy: number;
  fees: number;
  status: "In Range" | "Out of Range";
}

export const positions: LPPosition[] = [
  {
    id: "eth-usdc-uniswap-eth",
    pair: "ETH / USDC",
    protocol: "Uniswap V3",
    chain: "Ethereum",
    value: 45231.12,
    apy: 24.3,
    fees: 1234.56,
    status: "In Range",
  },
  {
    id: "wbtc-eth-aerodrome-base",
    pair: "WBTC / ETH",
    protocol: "Aerodrome",
    chain: "Base",
    value: 32890.45,
    apy: 18.7,
    fees: 892.34,
    status: "In Range",
  },
  {
    id: "usdc-usdt-uniswap-eth",
    pair: "USDC / USDT",
    protocol: "Uniswap V3",
    chain: "Ethereum",
    value: 28450.0,
    apy: 12.5,
    fees: 456.78,
    status: "In Range",
  },
  {
    id: "arb-eth-uniswap-arb",
    pair: "ARB / ETH",
    protocol: "Uniswap V3",
    chain: "Arbitrum",
    value: 8920.15,
    apy: 31.2,
    fees: 287.45,
    status: "In Range",
  },
  {
    id: "op-eth-velodrome-opt",
    pair: "OP / ETH",
    protocol: "Velodrome",
    chain: "Optimism",
    value: 6543.21,
    apy: 28.9,
    fees: 189.23,
    status: "In Range",
  },
  {
    id: "matic-eth-quickswap-poly",
    pair: "MATIC / ETH",
    protocol: "QuickSwap",
    chain: "Polygon",
    value: 3234.56,
    apy: 15.4,
    fees: 98.67,
    status: "Out of Range",
  },
  {
    id: "avax-usdc-traderjoe-avax",
    pair: "AVAX / USDC",
    protocol: "Trader Joe",
    chain: "Avalanche",
    value: 1567.89,
    apy: 22.1,
    fees: 67.34,
    status: "In Range",
  },
  {
    id: "sol-usdc-raydium-sol",
    pair: "SOL / USDC",
    protocol: "Raydium",
    chain: "Solana",
    value: 620.94,
    apy: 45.6,
    fees: 21.52,
    status: "In Range",
  },
];