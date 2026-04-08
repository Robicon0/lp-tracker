// Shared on-chain P&L + Impermanent Loss computation for any LP position whose
// activity history is available (deposit/withdrawal/fee_claim events with
// per-event historical prices). Pure function — no React, no I/O.

export interface ActivityEventForPnL {
  type: 'deposit' | 'withdrawal' | 'fee_claim' | 'reward_claim';
  timestamp: number;
  amount0: number;
  amount1: number;
  usdAtTime: number | null;
  // Per-event historical prices. Both must be non-null on at least one deposit
  // event for IL math to be possible. (Bluefin/Orca/Raydium currently always
  // return null here — that's intentional, those chains will gain entry-price
  // support in a later phase.)
  price0AtTime: number | null;
  price1AtTime: number | null;
}

export interface PositionPnLInput {
  /** Current USD value of the LP position. */
  currentValue: number;
  /** Currently unclaimed fees in USD (already valued at current prices upstream). */
  unclaimedFeesUSD: number;
  /** Current token0 price (USD). */
  price0: number;
  /** Current token1 price (USD). */
  price1: number;
  /** Activity events from the on-chain activity route, oldest-first or newest-first — order is normalised internally. */
  events: ActivityEventForPnL[];
}

export type PositionPnLStatus =
  | { ok: true; data: PositionPnLData }
  | { ok: false; reason: 'no_deposits' | 'no_entry_prices' };

export interface PositionPnLData {
  /** USD value of all on-chain deposits at the time they were made. */
  initialValue: number;
  /** Live USD value of the position right now. */
  currentValue: number;
  /** Sum of every fee_claim/reward_claim event in USD (using per-event prices when available). */
  feesCollected: number;
  /** Currently unclaimed fees in USD. */
  feesUnclaimed: number;
  /** (currentValue + feesCollected + feesUnclaimed) − initialValue. */
  netPnlUSD: number;
  /** netPnlUSD as a percentage of initialValue. */
  netPnlPct: number;
  /** Impermanent Loss percentage from the standard formula 2√r/(1+r) − 1, where r = currentRatio / entryRatio. */
  ilPct: number;
  /** Impermanent Loss in USD: hodlValue × (ilPct / 100). */
  ilUSD: number;
  /** USD value today of the originally deposited tokens, if held instead of LP'd. */
  hodlValue: number;
  /** True when (feesCollected + feesUnclaimed) ≥ |ilUSD|. Only meaningful when IL is negative. */
  feesOffsetIL: boolean;
  /** Number of deposit events used to compute the entry. */
  depositCount: number;
  /** USD-weighted entry price for token0. */
  entryPrice0: number;
  /** USD-weighted entry price for token1. */
  entryPrice1: number;
  /** Unix timestamp of the first on-chain deposit. */
  firstDepositTs: number;
}

/**
 * Compute P&L + IL from on-chain activity. Returns `{ok:false}` when entry data
 * is unavailable so the UI can show an honest "Entry data unavailable" message
 * instead of fabricating zeroes.
 */
export function computePositionPnL(input: PositionPnLInput): PositionPnLStatus {
  const { currentValue, unclaimedFeesUSD, price0, price1, events } = input;

  // 1. Sort chronologically and pull out deposits
  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
  const deposits = sorted.filter((e) => e.type === 'deposit');

  if (deposits.length === 0) {
    return { ok: false, reason: 'no_deposits' };
  }

  // 2. Need per-event historical prices on the deposits to compute initialValue
  //    AND IL. If a deposit has no per-event prices, skip it for the entry-price
  //    average but still count its amounts for HODL.
  const depositsWithPrices = deposits.filter(
    (e) => e.price0AtTime != null && e.price1AtTime != null,
  );

  if (depositsWithPrices.length === 0) {
    return { ok: false, reason: 'no_entry_prices' };
  }

  // 3. initialValue = sum of usdAtTime across deposits where it's available;
  //    fall back to amount × historical-price if usdAtTime missing for some reason.
  let initialValue = 0;
  for (const d of depositsWithPrices) {
    if (d.usdAtTime != null) {
      initialValue += d.usdAtTime;
    } else if (d.price0AtTime != null && d.price1AtTime != null) {
      initialValue += d.amount0 * d.price0AtTime + d.amount1 * d.price1AtTime;
    }
  }

  // 4. Total deposited amounts (HODL basis) — sum across ALL deposits, not just
  //    the priced ones, because amounts are always known even if prices weren't.
  const totalAmount0 = deposits.reduce((s, e) => s + e.amount0, 0);
  const totalAmount1 = deposits.reduce((s, e) => s + e.amount1, 0);

  // 5. Entry prices: USD-weighted average across priced deposits.
  //    weight_i = usdAtTime_i (proxy for "how much of the entry this deposit was")
  //    entryP_i = sum(price_i * weight_i) / sum(weight_i)
  let weightSum = 0;
  let weightedP0 = 0;
  let weightedP1 = 0;
  for (const d of depositsWithPrices) {
    const w = d.usdAtTime ?? (d.amount0 * (d.price0AtTime ?? 0) + d.amount1 * (d.price1AtTime ?? 0));
    if (w <= 0) continue;
    weightSum += w;
    weightedP0 += (d.price0AtTime as number) * w;
    weightedP1 += (d.price1AtTime as number) * w;
  }

  if (weightSum <= 0) {
    return { ok: false, reason: 'no_entry_prices' };
  }

  const entryPrice0 = weightedP0 / weightSum;
  const entryPrice1 = weightedP1 / weightSum;

  // 6. HODL value at current prices
  const hodlValue = totalAmount0 * price0 + totalAmount1 * price1;

  // 7. Fees collected (claims) from on-chain history
  const feesCollected = sorted
    .filter((e) => e.type === 'fee_claim' || e.type === 'reward_claim')
    .reduce((sum, e) => {
      if (e.usdAtTime != null) return sum + e.usdAtTime;
      // Fallback: value claim at current prices when historical USD missing
      return sum + e.amount0 * price0 + e.amount1 * price1;
    }, 0);

  // 8. Net P&L
  const netPnlUSD = currentValue + feesCollected + unclaimedFeesUSD - initialValue;
  const netPnlPct = initialValue > 0 ? (netPnlUSD / initialValue) * 100 : 0;

  // 9. Impermanent Loss via the canonical V2 formula:
  //    r = (P0_now / P1_now) / (P0_entry / P1_entry)
  //    IL = 2√r / (1 + r) − 1
  let ilPct = 0;
  let ilUSD = 0;
  if (entryPrice0 > 0 && entryPrice1 > 0 && price0 > 0 && price1 > 0) {
    const entryRatio   = entryPrice0 / entryPrice1;
    const currentRatio = price0       / price1;
    const r = currentRatio / entryRatio;
    if (r > 0 && Number.isFinite(r)) {
      const ilRaw = (2 * Math.sqrt(r)) / (1 + r) - 1;
      // ilRaw is always ≤ 0 by construction (Jensen's inequality on √)
      ilPct = ilRaw * 100;
      ilUSD = hodlValue * ilRaw;
    }
  }

  const totalFees = feesCollected + unclaimedFeesUSD;
  const feesOffsetIL = totalFees >= Math.abs(ilUSD);

  return {
    ok: true,
    data: {
      initialValue,
      currentValue,
      feesCollected,
      feesUnclaimed: unclaimedFeesUSD,
      netPnlUSD,
      netPnlPct,
      ilPct,
      ilUSD,
      hodlValue,
      feesOffsetIL,
      depositCount: deposits.length,
      entryPrice0,
      entryPrice1,
      firstDepositTs: depositsWithPrices[0]?.timestamp ?? deposits[0].timestamp,
    },
  };
}
