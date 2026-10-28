// app/lib/priceFinal.ts
//
// "No price source covers this leg" — a FINAL answer, never retried.
//
// The pricing retry in useLpPnl re-fetches a position whose deposit or
// withdrawal had no historical price, on a ~320 s schedule. That is right for a
// price that FAILED to load (an archive read that errored, a spot read that
// threw): the next fetch can find it. It is wasted for a leg that NO source can
// ever price, and it is most of the cost of contract wallet 0x844e…7c97 (51 of
// its 66 Aerodrome positions, measured 2026-10-28): 19 positions in pools with
// two unknown tokens (no price at all) and 32 in WETH / cbBTC pools against an
// unknown token (the known side at today's price, marked). Every round returned
// the same answer.
//
// The two cases are told apart by WHY the historical tier had no price:
//   - the pool's price at a block can only be turned into dollars through a
//     stablecoin side (`applyStableAnchor` in v3HistoricalFeePrice.ts). With no
//     stablecoin side the resolver answers "no price" for every block without
//     reading the chain. That is the source answering "no price": FINAL.
//   - with a stablecoin side, a missing block price means the archive read
//     failed: NOT final, retried as before.
// A missing pool (the position route could not name it), or a spot read that
// threw, is never final either: those are failed reads.
//
// FINAL changes only the retry. The position stays in the list, unpriced or
// spot-valued and marked exactly as before, the totals keep their `≈`, and the
// page says "N positions could not be priced" — at once instead of after the
// schedule.

/** True when neither side of the pool is a stablecoin, so the historical pool
 *  price at a block can never be turned into dollars (same test as
 *  `applyStableAnchor`). */
export function hasNoStableAnchor(token0: string, token1: string, stablecoins: Set<string>): boolean {
  const t0 = (token0 || '').toLowerCase();
  const t1 = (token1 || '').toLowerCase();
  return !stablecoins.has(t0) && !stablecoins.has(t1);
}

/**
 * For one position on a Uniswap-V3-style activity route: is an unpriced or
 * substituted deposit / withdrawal leg FINAL (no source covers it)?
 * True only when the pool is known, neither side is a stablecoin, and no spot
 * read failed during the request.
 */
export function legPriceFinal(args: {
  pool: string | null | undefined;
  token0: string;
  token1: string;
  stablecoins: Set<string>;
  spotReadFailed: boolean;
}): boolean {
  if (!args.pool) return false;
  if (args.spotReadFailed) return false;
  // Both token addresses must be known: an empty address is a failed read
  // upstream, not an unknown token.
  if (!args.token0 || !args.token1) return false;
  return hasNoStableAnchor(args.token0, args.token1, args.stablecoins);
}

/** The per-event marker: a deposit / withdrawal that is unpriced or valued on a
 *  substitute basis, on a position whose legs are final. */
export function eventPriceFinal(
  type: string,
  usdAtTime: number | null,
  priceBasis: string | undefined,
  legsFinal: boolean,
): boolean {
  if (!legsFinal) return false;
  if (type !== 'deposit' && type !== 'withdrawal') return false;
  return usdAtTime == null || priceBasis != null;
}

interface EventLike {
  type: string;
  usdAtTime: number | null;
  priceBasis?: string;
  priceFinal?: boolean;
}

/**
 * Client side: is this position's pricing final? True when at least one
 * deposit / withdrawal is unpriced or substituted and EVERY such leg carries the
 * route's `priceFinal` marker. A position with one leg that failed to load is
 * not final (it keeps its retry).
 */
export function positionPricingFinal(events: EventLike[]): boolean {
  let open = 0;
  for (const e of events) {
    if (e.type !== 'deposit' && e.type !== 'withdrawal') continue;
    if (e.usdAtTime != null && e.priceBasis == null) continue;
    if (!e.priceFinal) return false;
    open += 1;
  }
  return open > 0;
}

interface PositionLike {
  protocol: string;
  status: string;
  token0Address?: string;
  token1Address?: string;
  token0Symbol?: string;
  token1Symbol?: string;
}

/**
 * A burned Uniswap V3 row from the closed half (`burnedPositionRecord`): no
 * token addresses, placeholder symbols, 18 decimals, no price. Its legs can
 * never be priced from this row, so it is final after its one fetch.
 */
export function isPlaceholderBurnedRow(p: PositionLike): boolean {
  return p.protocol === 'Uniswap V3' && p.status === 'Closed'
    && !p.token0Address && !p.token1Address
    && p.token0Symbol === 'TOKEN0' && p.token1Symbol === 'TOKEN1';
}
