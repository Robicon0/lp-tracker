// Curated symbol → price-service ID map (Sprint 8.5). Tickers are ambiguous
// across price APIs (many tokens share "ETH"), so we hand-verify the IDs for
// the tokens users actually hold. Anything not listed here stays on manual
// price entry — never guessed — per the Curated-list + manual-fallback gate.
//
// coingecko: the CoinGecko coin ID (https://api.coingecko.com/api/v3/coins/list).
// Keys are UPPERCASE symbols to match how claim symbols are stored.

export interface TokenPriceId {
  coingecko: string;
}

export const TOKEN_PRICE_IDS: Record<string, TokenPriceId> = {
  // Majors
  BTC: { coingecko: "bitcoin" },
  ETH: { coingecko: "ethereum" },
  WETH: { coingecko: "weth" },
  WBTC: { coingecko: "wrapped-bitcoin" },
  CBBTC: { coingecko: "coinbase-wrapped-btc" },
  SOL: { coingecko: "solana" },
  SUI: { coingecko: "sui" },
  HYPE: { coingecko: "hyperliquid" },
  ZEC: { coingecko: "zcash" },
  // L2 / ecosystem tokens seen in the sheet
  ARB: { coingecko: "arbitrum" },
  OP: { coingecko: "optimism" },
  AERO: { coingecko: "aerodrome-finance" },
  ORCA: { coingecko: "orca" },
  // Stablecoins (also anchored to $1 in calculations as a safety net)
  USDC: { coingecko: "usd-coin" },
  USDT: { coingecko: "tether" },
  DAI: { coingecko: "dai" },
};

export function resolveCoingeckoId(symbol: string): string | null {
  const key = symbol.trim().toUpperCase();
  return TOKEN_PRICE_IDS[key]?.coingecko ?? null;
}
