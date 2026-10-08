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
// pair returns null and the caller keeps its existing cascade.

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
