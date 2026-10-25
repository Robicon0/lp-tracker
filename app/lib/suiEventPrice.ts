// Price both sides of a Sui CLMM pool from the sqrt price a liquidity event
// carries.
//
// Cetus and Bluefin stamp `current_sqrt_price` — the pool's own price in that
// transaction — on every add/remove-liquidity event. It is historical by
// construction (the price AT that block, not a current/spot read), which makes
// it the Sui counterpart of the EVM archive sqrtPriceX96 read (pricing-invariants
// Rule 2). The closed-position engine already values deposits and withdrawals
// this way; this is the same arithmetic for the per-position activity routes, so
// an OPEN position's deposit is valued on the same basis as a closed one's
// instead of from a range-boundary estimate.
//
// Only a pool with a stablecoin side can be anchored to USD here. Any other
// pair returns null and the caller tries `sidePricesFromDayPrices` below.

import { isSuiStableType, isSuiCoin, priceSuiClaimSide, type ClaimSideInput } from './suiClaimPrice';

export interface SidePrices { price0: number; price1: number }

export function sidePricesFromEventSqrt(
  sqrtPriceX64: unknown,
  decimalsA: number,
  decimalsB: number,
  aIsStable: boolean,
  bIsStable: boolean,
): SidePrices | null {
  if (sqrtPriceX64 == null || (!aIsStable && !bIsStable)) return null;
  let raw: bigint;
  try { raw = BigInt(sqrtPriceX64 as string); } catch { return null; }
  if (raw <= 0n) return null;
  const s = Number(raw) / 2 ** 64;
  const bPerA = s * s * 10 ** (decimalsA - decimalsB); // human B per human A
  if (!Number.isFinite(bPerA) || bPerA <= 0) return null;
  if (bIsStable) return { price0: bPerA, price1: 1 };
  return { price0: 1, price1: 1 / bPerA };
}

/**
 * Deposit and withdrawal legs the stablecoin anchor above cannot price: a pool
 * with no stablecoin side (X / SUI, X / Y), or an event with no sqrt price (Cetus
 * V1, Momentum). Each side is valued at its own day price (DeFiLlama's point
 * nearest noon UTC, the stored day map claims use, read after
 * `prewarmSuiClaimPrices`); a side with no day price is priced from the other
 * through the event's own pool price. Only an exact day counts: a nearby day
 * returns null and the caller keeps its marked estimate. Same shape as the
 * closed engine (`valueEvent` in suiClosedPositions.ts), so a position is valued
 * on one basis open and closed. A side whose amount is zero needs no price
 * (null). Returns null when a side that holds tokens stays unpriced.
 */
export interface DayLegInput {
  coinTypeA: string;
  coinTypeB: string;
  decimalsA: number;
  decimalsB: number;
  amountA: number;
  amountB: number;
  sqrtPriceX64: unknown;
  ts: number;
}

export function sidePricesFromDayPrices(i: DayLegInput): { price0: number | null; price1: number | null } | null {
  if (!i.coinTypeA || !i.coinTypeB) return null;
  const day = (ct: string): number | null => {
    if (isSuiStableType(ct)) return 1;
    const s = priceSuiClaimSide(ct, false, isSuiCoin(ct), i.ts);
    return s.price != null && s.price > 0 && !s.nearby ? s.price : null;
  };
  let p0 = day(i.coinTypeA);
  let p1 = day(i.coinTypeB);
  if ((p0 == null) !== (p1 == null) && i.sqrtPriceX64 != null) {
    let raw: bigint | null = null;
    try { raw = BigInt(i.sqrtPriceX64 as string); } catch { raw = null; }
    if (raw != null && raw > 0n) {
      const s = Number(raw) / 2 ** 64;
      const bPerA = s * s * 10 ** (i.decimalsA - i.decimalsB);
      if (Number.isFinite(bPerA) && bPerA > 0) {
        if (p0 == null) p0 = (p1 as number) * bPerA;
        else p1 = p0 / bPerA;
      }
    }
  }
  if ((i.amountA > 0 && p0 == null) || (i.amountB > 0 && p1 == null)) return null;
  if (i.amountA <= 0 && i.amountB <= 0) return null;
  return { price0: p0, price1: p1 };
}

/** Sides of deposit / withdrawal legs to prewarm for `sidePricesFromDayPrices`. */
export function dayLegSides(coinTypeA: string, coinTypeB: string, events: Array<{ type: string; timestamp: number; sqrtPrice?: unknown }>): ClaimSideInput[] {
  if (!coinTypeA || !coinTypeB) return [];
  const stA = isSuiStableType(coinTypeA), stB = isSuiStableType(coinTypeB);
  const out: ClaimSideInput[] = [];
  for (const e of events) {
    if (e.type !== 'deposit' && e.type !== 'withdrawal') continue;
    // A one-stable pool with a sqrt price is priced by the anchor above: no lookup.
    if (stA !== stB && e.sqrtPrice != null) continue;
    out.push({ coinType: coinTypeA, isStable: stA, isSui: isSuiCoin(coinTypeA), ts: e.timestamp });
    out.push({ coinType: coinTypeB, isStable: stB, isSui: isSuiCoin(coinTypeB), ts: e.timestamp });
  }
  return out;
}
