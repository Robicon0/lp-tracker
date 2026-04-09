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
  | { ok: false; reason: 'no_deposits' };

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
  /** True when at least one deposit had real historical entry prices (non-fallback). */
  ilAvailable: boolean;
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

  // 2. Split deposits by whether they have historical entry prices.
  //    Deposits with prices → used for entry-price weighted average + IL
  //    Deposits without prices → counted for HODL amounts and fall back to current prices for initialValue
  const depositsWithPrices = deposits.filter(
    (e) => e.price0AtTime != null && e.price1AtTime != null,
  );
  const ilAvailable = depositsWithPrices.length > 0;

  // 3. initialValue — sum across ALL deposits, using whatever value is available:
  //    priority 1: usdAtTime (route already picked best price for the event)
  //    priority 2: historical per-event prices
  //    priority 3: current prices × amounts (so initialValue is always computable)
  let initialValue = 0;
  for (const d of deposits) {
    if (d.usdAtTime != null && d.usdAtTime > 0) {
      initialValue += d.usdAtTime;
    } else if (d.price0AtTime != null && d.price1AtTime != null) {
      initialValue += d.amount0 * d.price0AtTime + d.amount1 * d.price1AtTime;
    } else {
      // Fallback: value at current prices. This gives initialValue ≈ hodlValue,
      // meaning netPnl will only reflect (currentValue + fees) − hodlValue ≈
      // (currentValue − hodlValue) + fees — i.e. IL + fees, which is the best
      // we can do without historical prices.
      initialValue += d.amount0 * price0 + d.amount1 * price1;
    }
  }

  // 4. Total deposited amounts (HODL basis) — sum across ALL deposits.
  const totalAmount0 = deposits.reduce((s, e) => s + e.amount0, 0);
  const totalAmount1 = deposits.reduce((s, e) => s + e.amount1, 0);

  // 5. Entry prices: USD-weighted average across priced deposits ONLY.
  //    When no priced deposits exist, entry prices stay 0 and IL is skipped.
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

  const entryPrice0 = weightSum > 0 ? weightedP0 / weightSum : 0;
  const entryPrice1 = weightSum > 0 ? weightedP1 / weightSum : 0;

  // 6. HODL value at current prices
  const hodlValue = totalAmount0 * price0 + totalAmount1 * price1;

  // 7. Fees collected (claims) from on-chain history
  const feesCollected = sorted
    .filter((e) => e.type === 'fee_claim' || e.type === 'reward_claim')
    .reduce((sum, e) => {
      if (e.usdAtTime != null) return sum + e.usdAtTime;
      return sum + e.amount0 * price0 + e.amount1 * price1;
    }, 0);

  // 8. Net P&L
  const netPnlUSD = currentValue + feesCollected + unclaimedFeesUSD - initialValue;
  const netPnlPct = initialValue > 0 ? (netPnlUSD / initialValue) * 100 : 0;

  // 9. Impermanent Loss — only when we have real historical entry prices.
  //    Otherwise IL is 0 (unknown) rather than a fabricated number.
  let ilPct = 0;
  let ilUSD = 0;
  if (ilAvailable && entryPrice0 > 0 && entryPrice1 > 0 && price0 > 0 && price1 > 0) {
    const entryRatio   = entryPrice0 / entryPrice1;
    const currentRatio = price0       / price1;
    const r = currentRatio / entryRatio;
    if (r > 0 && Number.isFinite(r)) {
      const ilRaw = (2 * Math.sqrt(r)) / (1 + r) - 1;
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
      ilAvailable,
      depositCount: deposits.length,
      entryPrice0,
      entryPrice1,
      firstDepositTs: depositsWithPrices[0]?.timestamp ?? deposits[0].timestamp,
    },
  };
}
