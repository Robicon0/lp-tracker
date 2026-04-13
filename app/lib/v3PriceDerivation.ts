// Derive token USD prices at deposit time from V3 concentrated-liquidity math.
// No CoinGecko needed — uses deposited amounts + tick range to back-solve
// for the pool's sqrtPrice, then anchors to USD via stablecoin detection.

/**
 * Given a V3 deposit's token amounts and the position's tick range,
 * back-solve for the pool price at deposit time and return USD prices.
 *
 * Returns { price0, price1 } in USD, or null if derivation fails
 * (e.g. both amounts zero, or no stablecoin in the pair).
 */
export function deriveDepositPrices(
  amount0: number,
  amount1: number,
  tickLower: number,
  tickUpper: number,
  decimals0: number,
  decimals1: number,
  token0: string,
  token1: string,
  stablecoins: Set<string>,
): { price0: number; price1: number } | null {
  const isStable0 = stablecoins.has(token0.toLowerCase());
  const isStable1 = stablecoins.has(token1.toLowerCase());

  if (!isStable0 && !isStable1) return null;

  const poolPrice = derivePoolPrice(amount0, amount1, tickLower, tickUpper, decimals0, decimals1);
  if (poolPrice == null || poolPrice <= 0 || !Number.isFinite(poolPrice)) return null;

  // poolPrice = price of 1 human token0 in human token1
  if (isStable1) {
    return { price0: poolPrice, price1: 1.0 };
  }
  // token0 is stablecoin
  return { price0: 1.0, price1: 1.0 / poolPrice };
}

/**
 * Back-solve for the pool price (token0 priced in token1, human-readable)
 * from the V3 liquidity math:
 *   amount0_raw = L * (1/sqrtP - 1/sqrtP_upper)
 *   amount1_raw = L * (sqrtP - sqrtP_lower)
 *
 * Dividing eliminates L and yields a quadratic in sqrtP.
 */
function derivePoolPrice(
  amount0: number,
  amount1: number,
  tickLower: number,
  tickUpper: number,
  decimals0: number,
  decimals1: number,
): number | null {
  if (amount0 <= 0 && amount1 <= 0) return null;

  const sqrtPL = Math.pow(1.0001, tickLower / 2);
  const sqrtPU = Math.pow(1.0001, tickUpper / 2);

  if (amount0 > 0 && amount1 > 0) {
    // Price in range — solve quadratic a*x^2 + b*x + c = 0  where x = sqrtP
    const rawA0 = amount0 * Math.pow(10, decimals0);
    const rawA1 = amount1 * Math.pow(10, decimals1);

    const a = rawA0;
    const b = rawA1 / sqrtPU - rawA0 * sqrtPL;
    const c = -rawA1;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;

    const sqrtP = (-b + Math.sqrt(disc)) / (2 * a);
    if (sqrtP <= 0) return null;

    // raw price = sqrtP^2 ; human price = raw * 10^(d0-d1)
    return sqrtP * sqrtP * Math.pow(10, decimals0 - decimals1);
  }

  if (amount0 > 0) {
    // Price at or below lower tick
    return Math.pow(1.0001, tickLower) * Math.pow(10, decimals0 - decimals1);
  }

  // amount1 > 0: price at or above upper tick
  return Math.pow(1.0001, tickUpper) * Math.pow(10, decimals0 - decimals1);
}
