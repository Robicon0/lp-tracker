// app/lib/evmClaimPrice.ts
//
// Fee-claim valuation for the EVM routes that read Uniswap-V3-style Collect
// events by contract address (Uniswap V3 on every chain, PancakeSwap on BNB):
// pricing-invariants Rule 1, the same claim-day basis as the Sui routes.
//
//   stablecoin side          → $1
//   any other side           → DeFiLlama's price for that UTC day by contract
//                              address (`claimDayPrice.ts`); the nearest earlier
//                              day (≤ 3 back) is used and MARKED (`nearby`)
//   a side with no amount    → needs no price
//   otherwise                → unpriced (null): never the pool's spot, never
//                              today's price, never $0 (Rule 1a)
//
// Before this (ITEM 0e) a claim the pool-price and CoinGecko-cache steps missed
// fell through to TODAY's spot price, unmarked.

import { prewarmClaimDayPrices, getClaimDayPrice, type ClaimChain } from './claimDayPrice';

const CLAIM_CHAINS = new Set<ClaimChain>(['ethereum', 'arbitrum', 'optimism', 'base', 'polygon', 'bnb']);
export function asClaimChain(chain: string): ClaimChain | null {
  const c = chain.trim().toLowerCase();
  return CLAIM_CHAINS.has(c as ClaimChain) ? (c as ClaimChain) : null;
}

export interface EvmClaimSides {
  chain: string;
  token0: string;
  token1: string;
  isStable0: boolean;
  isStable1: boolean;
}

/** Fetches every claim day this route will ask for (one batched request per pass). Never throws. */
export async function prewarmEvmClaimPrices(sides: EvmClaimSides, timestamps: number[]): Promise<void> {
  const chain = asClaimChain(sides.chain);
  const ts = timestamps.filter((t) => Number.isFinite(t) && t > 0);
  if (!chain || ts.length === 0) return;
  const items: Array<{ chain: ClaimChain; coin: string; timestamps: number[] }> = [];
  if (!sides.isStable0 && sides.token0) items.push({ chain, coin: sides.token0, timestamps: ts });
  if (!sides.isStable1 && sides.token1) items.push({ chain, coin: sides.token1, timestamps: ts });
  if (items.length > 0) await prewarmClaimDayPrices(items);
}

export interface EvmClaimPrice {
  price0: number | null;
  price1: number | null;
  usd: number | null;
  /** True when a side was priced from an earlier day. */
  nearby: boolean;
  /** For [PRICE_LOG]: stablecoin-fixed | claim-day | nearby-day | unknown. */
  src: string;
}

export function priceEvmFeeClaim(sides: EvmClaimSides, amount0: number, amount1: number, ts: number): EvmClaimPrice {
  const chain = asClaimChain(sides.chain);
  let nearby = false;
  const side = (token: string, stable: boolean, amount: number): number | null => {
    if (stable) return 1;
    if (!chain || !(ts > 0)) return amount === 0 ? 0 : null;
    const p = getClaimDayPrice(chain, token, ts);
    if (p) { if (p.basis === 'nearby-day') nearby = true; return p.price; }
    return amount === 0 ? 0 : null;
  };
  const price0 = side(sides.token0, sides.isStable0, amount0);
  const price1 = side(sides.token1, sides.isStable1, amount1);
  if (price0 == null || price1 == null) {
    return { price0, price1, usd: null, nearby: false, src: 'unknown' };
  }
  const usd = amount0 * price0 + amount1 * price1;
  const src = sides.isStable0 && sides.isStable1 ? 'stablecoin-fixed' : nearby ? 'nearby-day' : 'claim-day';
  return { price0, price1, usd, nearby: nearby && usd > 0, src };
}
