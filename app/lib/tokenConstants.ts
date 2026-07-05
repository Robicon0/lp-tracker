// app/lib/tokenConstants.ts
//
// Canonical, hardcoded token identities for DefiDesh's shared token resolver
// (app/lib/tokenResolver.ts, Sprint 1.10). This file holds the two things that
// MUST NEVER be auto-discovered:
//
//   1. HIGH-STAKES native chain tokens (SOL, SUI, ETH/WETH, HYPE/WHYPE, plus
//      the canonical wrapped BTC the existing routes already pin). A wrong
//      price for one of these corrupts every position on that chain — they are
//      pinned explicitly so an upstream lookup can never mis-resolve them.
//   2. CANONICAL stablecoins per chain (USDC variants incl. native/Wormhole/
//      bridged, USDT, DAI). These anchor to their CoinGecko id (usd-coin /
//      tether / dai) so they always price to ~$1 via the existing CoinGecko
//      pipeline — matching today's dashboard-route behaviour exactly (the
//      dashboard routes price stables via CoinGecko `usd-coin`, NOT a hardcoded
//      $1; the hardcoded-$1 rule is for fee-claim valuation, out of scope here).
//
// Everything NOT in this file is auto-discovered at runtime by the resolver
// (CoinGecko contract lookup -> on-chain metadata -> CoinGecko symbol search).
//
// Entries here are consolidated verbatim from the per-route hardcoded maps that
// existed before Sprint 1.10 (cetus / bluefin / momentum / orca / raydium /
// hyperswap / aerodrome / velodrome / uniswap-v3), so a token that resolves via
// this table produces the SAME (symbol, decimals, cgId) those routes produced —
// preserving byte-identity for previously-mapped tokens.

export type Chain =
  | 'solana'
  | 'sui'
  | 'hyperevm'
  | 'ethereum'
  | 'arbitrum'
  | 'optimism'
  | 'base'
  | 'polygon';

export interface ConstantToken {
  symbol: string;
  decimals: number;
  cgId: string; // CoinGecko id — these are always priceable
}

// ── CoinGecko asset-platform ids ─────────────────────────────────────────────
// VERIFIED LIVE in Sprint 1.10 Phase A2 against /api/v3/coins/{platform}/contract
// and cross-checked against /api/v3/asset_platforms. `null` => CoinGecko has no
// contract platform for that chain (none currently; kept for future chains).
//   solana ✓ (USDC -> usd-coin)   sui ✓ (raw `::`, sui-network 404s)
//   hyperevm ✓ (name "HyperEVM"; distinct from the L1 platform "hyperliquid")
//   EVM ids re-used from app/api/aave-v3/rates/route.ts (already in production).
export const CG_PLATFORM: Record<Chain, string | null> = {
  solana: 'solana',
  sui: 'sui',
  hyperevm: 'hyperevm',
  ethereum: 'ethereum',
  arbitrum: 'arbitrum-one',
  optimism: 'optimistic-ethereum',
  base: 'base',
  polygon: 'polygon-pos',
};

// ── DeFiLlama chain slugs ────────────────────────────────────────────────────
// Used by the resolver's DeFiLlama COVERAGE CHECK only (Sprint 1.10 keeps
// DeFiLlama pricing out of the live path — it only records whether a token
// exists there, for a future pricing-integration sprint). HyperEVM is
// "hyperliquid" on DeFiLlama.
export const DEFILLAMA_CHAIN: Record<Chain, string> = {
  solana: 'solana',
  sui: 'sui',
  hyperevm: 'hyperliquid',
  ethereum: 'ethereum',
  arbitrum: 'arbitrum',
  optimism: 'optimism',
  base: 'base',
  polygon: 'polygon',
};

// ── Identifier normalization ─────────────────────────────────────────────────
// Each chain identifies tokens differently and the existing routes normalize
// differently. The resolver and this table MUST agree, so normalization lives
// here and is the single source of truth.
//   EVM / HyperEVM : lowercase 0x address
//   Solana         : mint base58 as-is (case-sensitive — NEVER lowercase)
//   Sui            : 0x-prefixed, leading zeros of the address part stripped
//                    (matches cetus/route.ts normalizeCoinType)
export function normalizeSuiType(ct: string): string {
  if (!ct) return ct;
  const prefixed = ct.startsWith('0x') ? ct : `0x${ct}`;
  return prefixed.replace(/^0x0+([0-9a-f]+::)/, '0x$1');
}

export function normalizeIdentifier(chain: Chain, raw: string): string {
  if (!raw) return raw;
  if (chain === 'sui') return normalizeSuiType(raw);
  if (chain === 'solana') return raw.trim(); // base58, case-sensitive
  return raw.toLowerCase().trim(); // EVM family
}

// ── High-stakes native tokens ────────────────────────────────────────────────
// Keyed by NORMALIZED identifier. Pinned so an upstream lookup can never
// mis-resolve the chain's headline asset.
const NATIVE: Record<Chain, Record<string, ConstantToken>> = {
  solana: {
    So11111111111111111111111111111111111111112: { symbol: 'SOL', decimals: 9, cgId: 'solana' },
    // ZEC on Solana (Sprint 3-FREE) — the VERIFIED mint Osho actually LPs on Orca
    // (decimals 8 confirmed on-chain via DAS; CoinGecko id verified priceable,
    // DeFiLlama-by-mint priceable). Pinned as a high-stakes identity because the
    // previous per-route hardcode carried a WRONG mint for this token (architecture
    // Rule 9: high-stakes pins live here; everything else auto-resolves). Makes ZEC
    // decimals deterministic even if a DAS metadata lookup misses.
    A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS: { symbol: 'ZEC', decimals: 8, cgId: 'omnibridge-bridged-zcash-solana' },
  },
  sui: {
    '0x2::sui::SUI': { symbol: 'SUI', decimals: 9, cgId: 'sui' },
  },
  hyperevm: {
    // Native HYPE pseudo-address used inside V3 pool slots (no ERC-20 there).
    '0x5555555555555555555555555555555555555555': { symbol: 'HYPE', decimals: 18, cgId: 'hyperliquid' },
    '0xadcb2f358eae6492f61a5f87eb8893d09391d160': { symbol: 'WHYPE', decimals: 18, cgId: 'hyperliquid' },
  },
  ethereum: {
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': { symbol: 'WETH', decimals: 18, cgId: 'ethereum' },
  },
  arbitrum: {
    '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': { symbol: 'WETH', decimals: 18, cgId: 'ethereum' },
  },
  optimism: {
    '0x4200000000000000000000000000000000000006': { symbol: 'WETH', decimals: 18, cgId: 'ethereum' },
  },
  base: {
    '0x4200000000000000000000000000000000000006': { symbol: 'WETH', decimals: 18, cgId: 'ethereum' },
  },
  polygon: {
    '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619': { symbol: 'WETH', decimals: 18, cgId: 'ethereum' },
  },
};

// ── Canonical stablecoins (USDC variants, USDT, DAI) ──────────────────────────
// Keyed by NORMALIZED identifier. Anchored to their CoinGecko id so they always
// price ~$1 through the existing CoinGecko pipeline. Consolidated from the
// per-route maps (this is the cross-chain USDC-variant list DefiDesh had been
// maintaining reactively, now in one place).
const STABLES: Record<Chain, Record<string, ConstantToken>> = {
  solana: {
    EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: 'USDC', decimals: 6, cgId: 'usd-coin' },
    Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: 'USDT', decimals: 6, cgId: 'tether' },
  },
  sui: {
    // Native Circle USDC.
    '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC': { symbol: 'USDC', decimals: 6, cgId: 'usd-coin' },
    // Wormhole USDC.
    '0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN': { symbol: 'wUSDC', decimals: 6, cgId: 'usd-coin' },
    // Wormhole USDT.
    '0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN': { symbol: 'USDT', decimals: 6, cgId: 'tether' },
  },
  hyperevm: {
    '0xb88339cb7199b77e23db6e890353e22632ba630f': { symbol: 'USDC', decimals: 6, cgId: 'usd-coin' },
    '0x24ac48bf01fd6cb1c3836d08b3edc70a9c4380ca': { symbol: 'USDC', decimals: 6, cgId: 'usd-coin' },
    '0x3061caa1ce7c018ce68eae5795b2086cfdb4e148': { symbol: 'USDC', decimals: 6, cgId: 'usd-coin' },
    // USD₮0 (Tether USD on HyperEVM).
    '0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb': { symbol: 'USDT', decimals: 6, cgId: 'tether' },
  },
  ethereum: {
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { symbol: 'USDC', decimals: 6, cgId: 'usd-coin' },
    '0xdac17f958d2ee523a2206206994597c13d831ec7': { symbol: 'USDT', decimals: 6, cgId: 'tether' },
    '0x6b175474e89094c44da98b954eedeac495271d0f': { symbol: 'DAI', decimals: 18, cgId: 'dai' },
  },
  arbitrum: {
    '0xaf88d065e77c8cc2239327c5edb3a432268e5831': { symbol: 'USDC', decimals: 6, cgId: 'usd-coin' },
    '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8': { symbol: 'USDC.e', decimals: 6, cgId: 'usd-coin' },
    '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': { symbol: 'USDT', decimals: 6, cgId: 'tether' },
    '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1': { symbol: 'DAI', decimals: 18, cgId: 'dai' },
  },
  optimism: {
    '0x0b2c639c533813f4aa9d7837caf62653d097ff85': { symbol: 'USDC', decimals: 6, cgId: 'usd-coin' },
    '0x7f5c764cbc14f9669b88837ca1490cca17c31607': { symbol: 'USDC.e', decimals: 6, cgId: 'usd-coin' },
    '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58': { symbol: 'USDT', decimals: 6, cgId: 'tether' },
    '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1': { symbol: 'DAI', decimals: 18, cgId: 'dai' },
  },
  base: {
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { symbol: 'USDC', decimals: 6, cgId: 'usd-coin' },
    '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': { symbol: 'USDbC', decimals: 6, cgId: 'usd-coin' },
    '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': { symbol: 'DAI', decimals: 18, cgId: 'dai' },
  },
  polygon: {
    '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359': { symbol: 'USDC', decimals: 6, cgId: 'usd-coin' },
    '0x2791bca1f2de4661ed88a30c99a7a9449aa84174': { symbol: 'USDC.e', decimals: 6, cgId: 'usd-coin' },
    '0xc2132d05d31c914a87c6611c10748aeb04b58e8f': { symbol: 'USDT', decimals: 6, cgId: 'tether' },
    '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063': { symbol: 'DAI', decimals: 18, cgId: 'dai' },
  },
};

// Merged lookup: native first, stables second (native wins on any overlap,
// though there is none). Keyed by NORMALIZED identifier.
const HARDCODED: Record<Chain, Record<string, ConstantToken>> = (() => {
  const out = {} as Record<Chain, Record<string, ConstantToken>>;
  (Object.keys(CG_PLATFORM) as Chain[]).forEach((chain) => {
    out[chain] = { ...(STABLES[chain] ?? {}), ...(NATIVE[chain] ?? {}) };
  });
  return out;
})();

// Returns the hardcoded high-stakes identity for a normalized identifier, or
// null if the token is not pinned (and therefore eligible for auto-discovery).
export function lookupHardcodedToken(
  chain: Chain,
  normalizedId: string,
): ConstantToken | null {
  return HARDCODED[chain]?.[normalizedId] ?? null;
}
