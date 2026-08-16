// Display/grouping normalization for Chain, Token Symbol, and Platform names.
//
// Purpose: merge equivalent spellings so grouping/filters don't split one
// real-world thing across several buckets ("SOL" vs "Solana", "ETH" vs "WETH",
// "AERO" vs "Aerodrome", "Base" vs "BASE"). This is DISPLAY/GROUPING ONLY — it
// is never written back to a stored record. Callers pass a raw stored value and
// get a canonical label for grouping; the raw value stays untouched in storage.
//
// Two layers:
//   1. baseNormalize: trim + uppercase — folds pure case differences
//      ("Base"/"BASE", "Cetus"/"CETUS") for free.
//   2. alias maps: cross-spelling synonyms → one canonical key.
//
// Adding a new synonym is a ONE-LINE change to the relevant map below.
//
// NOTE (scope): token normalization is applied to organizational groupings
// whose totals are plain sums (e.g. Transfers "By Token"), where merging two
// rows leaves the grand total unchanged. It is deliberately NOT applied to
// Business P&L's per-token PRICED totals (calcBusinessPnL/calcTokenPnL/
// calcUnconvertedHoldings), because merging WETH into ETH there would re-price
// one leg and change a financial figure (allTotal/Net) — out of scope for this
// display-only batch. See CLAUDE.md.

function baseNormalize(raw: string): string {
  return raw.trim().toUpperCase();
}

// Raw (already base-normalized, i.e. UPPERCASE) → canonical grouping key.
// Canonical chain label is the full name where the user prefers it: "SOLANA"
// (not "SOL").
const CHAIN_ALIASES: Record<string, string> = {
  SOL: "SOLANA",
  ETHEREUM: "ETH",
  ARBITRUM: "ARB",
  ARBITRUMONE: "ARB",
  OPTIMISM: "OP",
};

const TOKEN_ALIASES: Record<string, string> = {
  WETH: "ETH",
  WBTC: "BTC",
  CBBTC: "BTC",
};

const PLATFORM_ALIASES: Record<string, string> = {
  AERODROME: "AERO",
  UNISWAPV3: "UNISWAP",
  "UNISWAP V3": "UNISWAP",
};

export function normalizeChain(raw: string): string {
  const key = baseNormalize(raw);
  return CHAIN_ALIASES[key] ?? key;
}

export function normalizeToken(raw: string): string {
  const key = baseNormalize(raw);
  return TOKEN_ALIASES[key] ?? key;
}

export function normalizePlatform(raw: string): string {
  const key = baseNormalize(raw);
  return PLATFORM_ALIASES[key] ?? key;
}
