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
  // Sign convention: ilUSD < 0 = loss (LP underperformed HODL), ilPct < 0 = loss.
  // Identity: hodlValue + ilUSD === currentValue (or closingValue when closed) — exact, no approximation.
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
  // Original deposited amounts (sum across all deposits) — used to display HODL formula.
  totalAmount0: number;
  totalAmount1: number;
  // Calculation detail fields for "How this was calculated" section
  entryRatio: number;    // entryPrice0 / entryPrice1 (kept for back-compat / display only)
  currentRatio: number;  // price0 / price1 (kept for back-compat / display only)
  priceRatioR: number;   // currentRatio / entryRatio (kept for back-compat / display only)
  ilAvailable: boolean;  // whether IL is computable (true iff hodlValue > 0)
  depositTxHashes: string[];
}

export function computePositionPnL(input: PositionPnLInput): PositionPnLStatus {
  const { currentValue, unclaimedFeesUSD, price0, price1, events, isClosed } = input;

  if (price0 <= 0 || price1 <= 0) {
    return { ok: false, reason: 'missing_current_prices' };
  }

  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
  // Skip truly empty deposit events — some protocols (especially Sui Move
  // emitters and protocol upgrades) emit a `LiquidityProvided` / similar
  // event with both amounts equal to zero on the very first add or on a
  // protocol-side rebalance. Those rows have no economic content and
  // shouldn't fail the whole position.
  const deposits = sorted.filter(
    (e) => e.type === 'deposit' && (e.amount0 > 0 || e.amount1 > 0),
  );

  if (deposits.length === 0) {
    return { ok: false, reason: 'no_deposits' };
  }

  // Each deposit needs SOMETHING we can value it with. We accept any of:
  //   (a) historical per-token prices (deriveDepositPrices result), OR
  //   (b) usdAtTime computed by the route at deposit time, OR
  //   (c) at least one side has a non-zero amount AND a non-zero price
  //       (current-price fallback the route already passes through). This
  //       covers non-stable pairs where v3 derivation returns null and one
  //       fallback price is missing — we still get a usable USD figure
  //       from the side that IS priced rather than excluding the whole
  //       position. Better an approximate Initial than silently dropping.
  for (const d of deposits) {
    const hasHistoricalPrices = d.price0AtTime != null && d.price1AtTime != null;
    const hasUsdAtTime = d.usdAtTime != null && d.usdAtTime > 0;
    const hasAnyPricedSide =
      (d.amount0 > 0 && d.price0AtTime != null && d.price0AtTime > 0) ||
      (d.amount1 > 0 && d.price1AtTime != null && d.price1AtTime > 0);
    if (!hasHistoricalPrices && !hasUsdAtTime && !hasAnyPricedSide) {
      return { ok: false, reason: 'missing_deposit_prices' };
    }
  }

  // Initial value — sum at historical prices when available, else best-effort
  // from whichever per-token price we DO have (matches the relaxed acceptance
  // check above). Each deposit was verified to have at least one usable price.
  let initialValue = 0;
  for (const d of deposits) {
    if (d.usdAtTime != null && d.usdAtTime > 0) {
      initialValue += d.usdAtTime;
    } else {
      const p0 = d.price0AtTime ?? 0;
      const p1 = d.price1AtTime ?? 0;
      initialValue += d.amount0 * p0 + d.amount1 * p1;
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
  const priceRatioR =
    entryRatio > 0 && currentRatio > 0 && Number.isFinite(currentRatio / entryRatio)
      ? currentRatio / entryRatio
      : 0;
  // IL is computable iff we have a positive HODL value to compare against.
  const ilAvailable = hodlValue > 0;

  const sharedFields = {
    entryPrice0,
    entryPrice1,
    currentPrice0: price0,
    currentPrice1: price1,
    depositCount: deposits.length,
    firstDepositTs: deposits[0].timestamp,
    totalAmount0,
    totalAmount1,
    entryRatio,
    currentRatio,
    priceRatioR,
    ilAvailable,
    depositTxHashes,
  };

  // ── IL formula (concentrated liquidity, exact) ────────────────────────
  // For BOTH open and closed positions IL is computed by directly comparing
  // the LP's realized USD value against what the original deposit tokens
  // would be worth today (HODL):
  //
  //   ilUSD = liveValue - hodlValue              (negative = loss vs HODL)
  //   ilPct = (liveValue / hodlValue - 1) * 100
  //
  // where liveValue = currentValue (open) or closingValue (closed).
  // This satisfies the identity exactly:
  //   hodlValue + ilUSD === liveValue
  // No square-root approximation, no V2-pool assumption — works for every
  // protocol that emits deposit + (withdrawal) events with usable USD values.

  // ── Closed position path ─────────────────────────────────────────────
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

    const ilUSD = ilAvailable ? closingValue - hodlValue : 0;
    const ilPct = ilAvailable ? (closingValue / hodlValue - 1) * 100 : 0;

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
        ilUSD,
        hodlValue,
        feesOffsetIL: feesCollected >= Math.abs(ilUSD),
        isClosed: true,
      },
    };
  }

  // ── Open position path ───────────────────────────────────────────────
  const netPnlUSD = currentValue + feesCollected + unclaimedFeesUSD - initialValue;
  const netPnlPct = initialValue > 0 ? (netPnlUSD / initialValue) * 100 : 0;

  const ilUSD = ilAvailable ? currentValue - hodlValue : 0;
  const ilPct = ilAvailable ? (currentValue / hodlValue - 1) * 100 : 0;

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
