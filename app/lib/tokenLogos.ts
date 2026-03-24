// Token logo URLs from CoinGecko CDN — falls back to colored circle in TokenCircle component
export const TOKEN_LOGOS: Record<string, string> = {
  // Stablecoins
  USDC:     "https://assets.coingecko.com/coins/images/6319/small/usdc.png",
  "USDC.e": "https://assets.coingecko.com/coins/images/6319/small/usdc.png",
  USDbC:    "https://assets.coingecko.com/coins/images/6319/small/usdc.png",
  USDT:     "https://assets.coingecko.com/coins/images/325/small/Tether.png",
  DAI:      "https://assets.coingecko.com/coins/images/9956/small/Badge_Dai.png",
  USDS:     "https://assets.coingecko.com/coins/images/33051/small/usds.png",
  // Ethereum / EVM
  ETH:      "https://assets.coingecko.com/coins/images/279/small/ethereum.png",
  WETH:     "https://assets.coingecko.com/coins/images/2518/small/weth.png",
  BTC:      "https://assets.coingecko.com/coins/images/1/small/bitcoin.png",
  WBTC:     "https://assets.coingecko.com/coins/images/7598/small/wrapped_bitcoin_wbtc.png",
  cbBTC:    "https://assets.coingecko.com/coins/images/40143/small/cbbtc.png",
  tBTC:     "https://assets.coingecko.com/coins/images/11224/small/0x18084fba666a33d37592fa2633fd49a74dd93a88.png",
  // Solana
  SOL:      "https://assets.coingecko.com/coins/images/4128/small/solana.png",
  WSOL:     "https://assets.coingecko.com/coins/images/4128/small/solana.png",
  // Sui
  SUI:      "https://assets.coingecko.com/coins/images/26375/small/sui-ocean-square.png",
  // Other L1/L2
  MATIC:    "https://assets.coingecko.com/coins/images/4713/small/polygon.png",
  POL:      "https://assets.coingecko.com/coins/images/4713/small/polygon.png",
  ARB:      "https://assets.coingecko.com/coins/images/16547/small/arb.jpg",
  OP:       "https://assets.coingecko.com/coins/images/25244/small/Optimism.png",
  BNB:      "https://assets.coingecko.com/coins/images/825/small/bnb-icon2_2x.png",
  WBNB:     "https://assets.coingecko.com/coins/images/825/small/bnb-icon2_2x.png",
  AVAX:     "https://assets.coingecko.com/coins/images/12559/small/Avalanche_Circle_RedWhite_Trans.png",
  // DeFi / HyperEVM
  HYPE:     "https://assets.coingecko.com/coins/images/40845/small/hype.png",
  WHYPE:    "https://assets.coingecko.com/coins/images/40845/small/hype.png",
  UNI:      "https://assets.coingecko.com/coins/images/12504/small/uni.jpg",
  AAVE:     "https://assets.coingecko.com/coins/images/12645/small/aave-token-round.png",
  CRV:      "https://assets.coingecko.com/coins/images/12124/small/Curve.png",
};

export function getTokenLogo(symbol: string): string | null {
  return TOKEN_LOGOS[symbol] ?? TOKEN_LOGOS[symbol.toUpperCase()] ?? null;
}
