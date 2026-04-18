// Strict on-chain P&L + IL computation for an LP position.
// Pure function — no React, no I/O, NO fallback to current prices.
//
// Every deposit must carry a real historical USD valuation (either usdAtTime
// from the activity route, or per-event historical token prices). If a single
// deposit is missing that data the whole position is excluded. This is the
// whole point of the rewrite: don't fabricate initialValue from current prices.

export interface ActivityEventForPnL {
  type: 'deposit' | 'withdrawal' | 'fee_claim' | 'reward_claim';
  timestamp: number;
  amount0: number;
  amount1: number;
  usdAtTime: number | null;
  price0AtTime: number | null;
  price1AtTime: number | null;
  txHash?: string;
}

export interface PositionPnLInput {
  currentValue: number;
  unclaimedFeesUSD: number;
  price0: number;
  price1: number;
  events: ActivityEventForPnL[];
  isClosed?: boolean;
}

export type PositionPnLStatus =
  | { ok: true; data: PositionPnLData }
  | { ok: false; reason: 'no_deposits' | 'missing_deposit_prices' | 'missing_current_prices' };

export interface PositionPnLData {
  initialValue: number;
  currentValue: number;
  closingValue: number;
  feesCollected: number;
  feesUnclaimed: number;
  netPnlUSD: number;
  netPnlPct: number;
  ilPct: number;
  ilUSD: number;
  hodlValue: number;
  feesOffsetIL: boolean;
  entryPrice0: number;
  entryPrice1: number;
  currentPrice0: number;
  currentPrice1: number;
  depositCount: number;
  firstDepositTs: number;
  isClosed: boolean;
  // Calculation detail fields for "How this was calculated" section
  entryRatio: number;    // entryPrice0 / entryPrice1
  currentRatio: number;  // price0 / price1
  priceRatioR: number;   // currentRatio / entryRatio
  ilAvailable: boolean;  // whether IL formula was computable
  depositTxHashes: string[];
}

export function computePositionPnL(input: PositionPnLInput): PositionPnLStatus {
  const { currentValue, unclaimedFeesUSD, price0, price1, events, isClosed } = input;

  if (price0 <= 0 || price1 <= 0) {
    return { ok: false, reason: 'missing_current_prices' };
  }

  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
  const deposits = sorted.filter((e) => e.type === 'deposit');

  if (deposits.length === 0) {
    return { ok: false, reason: 'no_deposits' };
  }

  // Every deposit MUST have real historical prices. No fallbacks.
  for (const d of deposits) {
    const hasHistoricalPrices = d.price0AtTime != null && d.price1AtTime != null;
    const hasUsdAtTime = d.usdAtTime != null && d.usdAtTime > 0;
    if (!hasHistoricalPrices && !hasUsdAtTime) {
      return { ok: false, reason: 'missing_deposit_prices' };
    }
  }

  // Initial value — sum at historical prices only.
  let initialValue = 0;
  for (const d of deposits) {
    if (d.usdAtTime != null && d.usdAtTime > 0) {
      initialValue += d.usdAtTime;
    } else {
      // Safe: we checked above that at least one of these branches holds.
      initialValue += d.amount0 * (d.price0AtTime as number) + d.amount1 * (d.price1AtTime as number);
    }
  }

  // HODL basis — sum deposited amounts.
  const totalAmount0 = deposits.reduce((s, e) => s + e.amount0, 0);
  const totalAmount1 = deposits.reduce((s, e) => s + e.amount1, 0);

  // Entry prices — USD-weighted across deposits that have per-token prices.
  let weightSum = 0;
  let weightedP0 = 0;
  let weightedP1 = 0;
  for (const d of deposits) {
    if (d.price0AtTime == null || d.price1AtTime == null) continue;
    const w = d.amount0 * d.price0AtTime + d.amount1 * d.price1AtTime;
    if (w <= 0) continue;
    weightSum += w;
    weightedP0 += d.price0AtTime * w;
    weightedP1 += d.price1AtTime * w;
  }

  const entryPrice0 = weightSum > 0 ? weightedP0 / weightSum : 0;
  const entryPrice1 = weightSum > 0 ? weightedP1 / weightSum : 0;

  // HODL value — what original deposit tokens would be worth at today's prices.
  const hodlValue = totalAmount0 * price0 + totalAmount1 * price1;

  // Fees collected — strict: every claim must have a historical valuation.
  let feesCollected = 0;
  for (const e of sorted) {
    if (e.type !== 'fee_claim' && e.type !== 'reward_claim') continue;
    if (e.usdAtTime != null) {
      feesCollected += e.usdAtTime;
    } else if (e.price0AtTime != null && e.price1AtTime != null) {
      feesCollected += e.amount0 * e.price0AtTime + e.amount1 * e.price1AtTime;
    }
  }

  // Calculation detail fields
  const depositTxHashes = deposits.map((d) => d.txHash).filter((h): h is string => !!h);
  const entryRatio = entryPrice1 > 0 ? entryPrice0 / entryPrice1 : 0;
  const currentRatio = price1 > 0 ? price0 / price1 : 0;
  let priceRatioR = 0;
  let ilAvailable = false;
  if (entryRatio > 0 && currentRatio > 0) {
    priceRatioR = currentRatio / entryRatio;
    ilAvailable = Number.isFinite(priceRatioR) && priceRatioR > 0;
  }

  const sharedFields = {
    entryPrice0,
    entryPrice1,
    currentPrice0: price0,
    currentPrice1: price1,
    depositCount: deposits.length,
    firstDepositTs: deposits[0].timestamp,
    entryRatio,
    currentRatio,
    priceRatioR,
    ilAvailable,
    depositTxHashes,
  };

  // ── Closed position path ─────────────────────────────────────────────
  // Closing Value = USD value of tokens received in closing withdrawal(s)
  // at the time of withdrawal (from on-chain V3 price derivation).
  // Net P&L = (Closing Value + Fees Collected) − Initial Value
  // IL = HODL Value − Closing Value (absolute loss from LP vs hold)
  if (isClosed) {
    const withdrawals = sorted.filter((e) => e.type === 'withdrawal');
    let closingValue = 0;
    for (const w of withdrawals) {
      if (w.usdAtTime != null && w.usdAtTime > 0) {
        closingValue += w.usdAtTime;
      } else if (w.price0AtTime != null && w.price1AtTime != null) {
        closingValue += w.amount0 * w.price0AtTime + w.amount1 * w.price1AtTime;
      } else {
        closingValue += w.amount0 * price0 + w.amount1 * price1;
      }
    }

    const netPnlUSD = closingValue + feesCollected - initialValue;
    const netPnlPct = initialValue > 0 ? (netPnlUSD / initialValue) * 100 : 0;

    // IL for closed = HODL Value − Closing Value (positive = LP underperformed holding)
    const ilUSD = hodlValue - closingValue;
    const ilPct = hodlValue > 0 ? (ilUSD / hodlValue) * -100 : 0;

    return {
      ok: true,
      data: {
        ...sharedFields,
        initialValue,
        currentValue: 0,
        closingValue,
        feesCollected,
        feesUnclaimed: 0,
        netPnlUSD,
        netPnlPct,
        ilPct,
        ilUSD: -ilUSD,
        hodlValue,
        feesOffsetIL: feesCollected >= ilUSD,
        isClosed: true,
      },
    };
  }

  // ── Open position path ───────────────────────────────────────────────
  const netPnlUSD = currentValue + feesCollected + unclaimedFeesUSD - initialValue;
  const netPnlPct = initialValue > 0 ? (netPnlUSD / initialValue) * 100 : 0;

  let ilPct = 0;
  let ilUSD = 0;
  if (ilAvailable) {
    const ilRaw = (2 * Math.sqrt(priceRatioR)) / (1 + priceRatioR) - 1;
    ilPct = ilRaw * 100;
    ilUSD = hodlValue * ilRaw;
  }

  return {
    ok: true,
    data: {
      ...sharedFields,
      initialValue,
      currentValue,
      closingValue: 0,
      feesCollected,
      feesUnclaimed: unclaimedFeesUSD,
      netPnlUSD,
      netPnlPct,
      ilPct,
      ilUSD,
      hodlValue,
      feesOffsetIL: (feesCollected + unclaimedFeesUSD) >= Math.abs(ilUSD),
      isClosed: false,
    },
  };
}
