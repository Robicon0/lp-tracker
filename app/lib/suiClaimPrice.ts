// app/lib/suiClaimPrice.ts
//
// The ONE valuation of a Sui fee or reward claim side, shared by the Cetus,
// Bluefin and Momentum activity routes (pricing-invariants Rule 1 / 1a).
//
// Per side, by COIN TYPE, at the claim's own UTC day, never spot:
//   stablecoin → $1
//   SUI        → CoinGecko historical day price, else the DeFiLlama day price
//   any other  → the DeFiLlama day price (`claimDayPrice.ts`)
// The DeFiLlama day price may come from the nearest earlier day (≤ 3 days);
// such a side reports `nearby: true` and the claim is marked so the page shows
// Fees `≈` with a count. Anything else stays unpriced (null): never $0.
//
// Reward tokens are identified by the coin type the event carries
// (Cetus `rewarder_type`, Bluefin `reward_type`, Momentum `reward_coin_type`),
// never by a symbol match against the pool's sides.

import { normalizeSuiType } from './tokenConstants';
import { resolveToken } from './tokenResolver';
import { prewarmSuiPricesForTimestamps, getHistoricalOnlySuiPrice } from './suiPriceHistory';
import { prewarmClaimDayPrices, getClaimDayPrice } from './claimDayPrice';

export const SUI_CANONICAL = '0x2::sui::sui';

// Canonical Sui stablecoin coin types (lowercase) and stablecoin CoinGecko ids.
const STABLE_TYPES = new Set([
  '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::usdc',
  '0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::coin', // USDT
  '0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::coin', // wUSDC
]);
const STABLE_CGIDS = new Set(['usd-coin', 'tether', 'dai']);

export function isSuiStableType(ct: string): boolean { return STABLE_TYPES.has(normalizeSuiType(ct).toLowerCase()); }
export function isSuiCoin(ct: string): boolean { return normalizeSuiType(ct).toLowerCase() === SUI_CANONICAL; }

/** A coin type from an event field: a string or a `{ name }` TypeName, with or without `0x`. */
export function suiCoinTypeFromEvent(v: unknown): string {
  const raw = typeof v === 'string' ? v : (v && typeof v === 'object' && typeof (v as { name?: unknown }).name === 'string') ? (v as { name: string }).name : '';
  return raw ? normalizeSuiType(raw) : '';
}

export interface SuiRewardMeta { coinType: string; symbol: string; decimals: number; decimalsKnown: boolean; isStable: boolean; isSui: boolean }

/**
 * Identity of each reward coin type. `hint` carries decimals the event itself
 * states (Bluefin `reward_decimals`); otherwise the shared token resolver reads
 * them. Unknown decimals → `decimalsKnown: false` (the claim stays unpriced:
 * scaling by a guessed exponent is wrong by orders of magnitude).
 */
export async function resolveSuiRewardMetas(coinTypes: string[], hint?: Map<string, number>): Promise<Map<string, SuiRewardMeta>> {
  const out = new Map<string, SuiRewardMeta>();
  await Promise.all([...new Set(coinTypes.filter(Boolean))].map(async (ct) => {
    const isSui = isSuiCoin(ct);
    let decimals = 0, decimalsKnown = false, cgId: string | null = null;
    let symbol = ct.split('::').pop() ?? 'REWARD';
    const h = hint?.get(ct);
    if (h != null && Number.isInteger(h) && h >= 0 && h <= 36) { decimals = h; decimalsKnown = true; }
    try {
      const tok = await resolveToken({ chain: 'sui', suiType: ct });
      cgId = tok.cgId;
      if (tok.symbol) symbol = tok.symbol;
      if (!decimalsKnown && tok.decimals > 0) { decimals = tok.decimals; decimalsKnown = true; }
    } catch { /* decimals stay unknown unless the event stated them */ }
    if (isSui) { decimals = 9; decimalsKnown = true; }
    const isStable = isSuiStableType(ct) || (cgId != null && STABLE_CGIDS.has(cgId));
    out.set(ct, { coinType: ct, symbol, decimals, decimalsKnown, isStable, isSui });
  }));
  return out;
}

export interface ClaimSideInput { coinType: string; isStable: boolean; isSui: boolean; ts: number }

/** Fetches every price the claims below need (awaited; never throws). */
export async function prewarmSuiClaimPrices(sides: ClaimSideInput[]): Promise<void> {
  const suiTs: number[] = [];
  const byCoin = new Map<string, number[]>();
  for (const s of sides) {
    if (!s.coinType || s.isStable || !(s.ts > 0)) continue;
    if (s.isSui) suiTs.push(s.ts);
    (byCoin.get(s.coinType) ?? byCoin.set(s.coinType, []).get(s.coinType)!).push(s.ts);
  }
  await Promise.all([
    suiTs.length ? prewarmSuiPricesForTimestamps(suiTs).catch(() => {}) : Promise.resolve(),
    byCoin.size ? prewarmClaimDayPrices([...byCoin].map(([coin, timestamps]) => ({ chain: 'sui' as const, coin, timestamps }))) : Promise.resolve(),
  ]);
}

export type ClaimSideSource = 'stablecoin-fixed' | 'sui-historical' | 'defillama-historical' | 'unknown';
export interface ClaimSidePrice { price: number | null; src: ClaimSideSource; nearby: boolean }

/** One side of a claim, at its claim day (after `prewarmSuiClaimPrices`). */
export function priceSuiClaimSide(coinType: string, isStable: boolean, isSui: boolean, ts: number): ClaimSidePrice {
  if (isStable) return { price: 1, src: 'stablecoin-fixed', nearby: false };
  if (isSui) {
    const h = getHistoricalOnlySuiPrice(ts);
    if (h != null && h > 0) return { price: h, src: 'sui-historical', nearby: false };
  }
  const d = coinType ? getClaimDayPrice('sui', coinType, ts) : null;
  if (d) return { price: d.price, src: 'defillama-historical', nearby: d.basis === 'nearby-day' };
  return { price: null, src: 'unknown', nearby: false };
}
