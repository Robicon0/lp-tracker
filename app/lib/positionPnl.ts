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
  // ITEM 0b — which PRICE BASIS actually valued this event. An activity route
  // may substitute CURRENT SPOT for a deposit's / withdrawal's claim-date
  // historical price when that price is not warm in the cache. The substituted
  // event is otherwise INDISTINGUISHABLE from a correctly-priced one (it
  // carries a non-null usdAtTime and non-null per-token prices), so without
  // this marker the substitution is silent and the position's Capital G/L
  // changes between loads with nothing reporting it.
  //
  // Set ONLY when the route actually substituted. Absent = priced on its own
  // historical basis (sqrtPriceX96 at the event block, tick-derived, or
  // claim-date historical).
  priceBasis?: 'current-spot-substituted' | 'tick-derived-estimate';
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
  | { ok: false; reason: 'no_deposits' | 'missing_deposit_prices' | 'missing_current_prices' | 'value_overflow' };

// Sanity ceiling for any single position's USD-denominated metric.
// $10M per position is comfortably above any realistic retail LP — anything
// over this is almost certainly raw-uint256 leaking through a decimals mismatch
// or a malformed event payload. Whole position is rejected rather than letting
// a single garbage value poison the aggregated totals (Total Deposited / IL /
// Net P&L showing trillions of dollars). Applies to initialValue, currentValue,
// closingValue, and |ilUSD| — fees are NOT capped here (they go through the
// feeIncome pipeline which has its own validation per event).
const SINGLE_POSITION_USD_CEILING = 10_000_000;

function withinSanityCeiling(v: number): boolean {
  return Number.isFinite(v) && Math.abs(v) <= SINGLE_POSITION_USD_CEILING;
}

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
  // Count of fee_claim / reward_claim events that have NO historical USD
  // valuation (the activity route left usdAtTime AND both price0/1AtTime null
  // rather than fall back to current spot — pricing-invariants Rule 1). These
  // contribute $0 to feesCollected and are surfaced to the user as "N claims
  // pending price resolution" instead of being silently dropped or mis-valued.
  // Optional/back-compat: absent === 0 (e.g. buildFallbackPnL constructs its
  // own PnL object).
  pendingClaimCount?: number;
  /**
   * Deposit/withdrawal events valued at CURRENT spot because their claim-date
   * historical price was unavailable. > 0 means this position's realised value
   * is not yet final — see the withdrawal loop for why this drives Capital G/L
   * non-determinism.
   */
  spotFallbackEventCount?: number;
  /**
   * ITEM 0b — deposit/withdrawal events valued from the position's TICK-BOUNDARY
   * estimate rather than the price at their own block. > 0 means Capital G/L is
   * APPROXIMATE (and, for a closed position, structurally near $0 because the
   * same estimate values both sides). Disclosed to the user, kept IN the totals,
   * and NOT retried — the estimate does not change on a re-fetch.
   */
  estimatedBasisEventCount?: number;
}

export function computePositionPnL(input: PositionPnLInput): PositionPnLStatus {
  const { currentValue, unclaimedFeesUSD, price0, price1, events, isClosed } = input;

  // Current price is only meaningful for an OPEN position: it drives the
  // mark-to-market `currentValue` and IL. A CLOSED position's headline numbers
  // — initialValue, closingValue, Capital G/L, netPnl, and fees — all come from
  // HISTORICAL deposit/withdrawal/claim events; current price feeds only
  // `hodlValue`/IL, which degrade gracefully (ilAvailable = hodlValue > 0).
  //
  // So gating a closed position on a current price it doesn't need spuriously
  // EXCLUDES it when the position route returns price0/price1 = 0 — e.g. a
  // cold-instance CoinGecko spot 429 during the parallel analytics fetch (the
  // 8 source routes fire in one Promise.all; the spot path is un-paced). That
  // dropped the wallet's closed HyperEVM/ProjectX positions from Capital G/L
  // and surfaced a bogus "Current price data unavailable" banner on first load,
  // which vanished on refresh once the 60s spot cache warmed (Sprint 1.11).
  // Gate OPEN positions only; closed positions proceed and compute from history.
  if (!isClosed && (price0 <= 0 || price1 <= 0)) {
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

  // Sanity ceiling — reject the whole position if initialValue is non-finite
  // or implausibly large (decimals mismatch / raw uint256 leak / malformed event).
  // Better to exclude one position than to poison Total Deposited with trillions.
  if (!withinSanityCeiling(initialValue)) {
    return { ok: false, reason: 'value_overflow' };
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
  // A claim with no historical valuation is NOT valued at current spot
  // (pricing-invariants Rule 1) and NOT counted as $0 — it's tallied as
  // "pending" so the UI can tell the user a fee value is unresolved rather
  // than silently understating lifetime fees.
  let feesCollected = 0;
  let pendingClaimCount = 0;
  let spotFallbackEventCount = 0;
  let estimatedBasisEventCount = 0;
  for (const e of sorted) {
    if (e.type !== 'fee_claim' && e.type !== 'reward_claim') continue;
    if (e.usdAtTime != null) {
      feesCollected += e.usdAtTime;
    } else if (e.price0AtTime != null && e.price1AtTime != null) {
      feesCollected += e.amount0 * e.price0AtTime + e.amount1 * e.price1AtTime;
    } else {
      pendingClaimCount += 1;
    }
  }

  // ITEM 0b — count events the ROUTE valued at current spot instead of their
  // own claim-date historical price. This is the third, previously-silent way
  // Capital G/L can be not-yet-final, and the only one that reported NOTHING:
  // a substituted event arrives with a non-null usdAtTime, so it never reaches
  // the withdrawal last-resort branch below and never got counted. Both sides
  // matter — when the substitution fires, the deposit AND the withdrawal of the
  // same position are valued with the SAME current prices, so the two converge
  // and that position's Capital G/L collapses toward $0 (the deposited ===
  // withdrawn fingerprint). Counting it here routes the position into the
  // existing ITEM 0 pending/retry machinery in useLpPnl — no new path.
  // TWO substitute bases, both non-historical, both with the same consequence:
  //   'current-spot-substituted' — today's price applied to a past event.
  //   'tick-derived-estimate'    — a price inferred from the position's own tick
  //                                RANGE. It is identical for EVERY event of the
  //                                position (it has no per-block input), so a
  //                                closed position's deposit and withdrawal come
  //                                out the SAME to the cent and Capital G/L
  //                                collapses to ~$0. Measured live on Account 1
  //                                position 71729936: dep === wd === $9,294.71
  //                                vs the true historical −$95.69.
  // They are counted SEPARATELY because they need different handling:
  //   spot  — TRANSIENT (the historical price simply isn't warm yet), so the
  //           position is worth re-fetching; the ITEM 0 retry resolves it.
  //   tick  — NOT transient. If the archive can't serve that block, retrying
  //           returns the identical estimate. Counting it as retryable evicts
  //           and re-fetches every position on a loop, which amplifies load
  //           (measured: 33 → 71 activity calls per load) and leaves the
  //           aggregate reading $0.00 because nothing is ever settled — worse
  //           than the bug, and a Rule 11 violation (never drop a position from
  //           totals). So tick-derived DISCLOSES ("≈ incomplete") while its
  //           value stays IN the totals, and is not retried.
  for (const e of sorted) {
    if (e.type !== 'deposit' && e.type !== 'withdrawal') continue;
    if (e.priceBasis === 'current-spot-substituted') spotFallbackEventCount += 1;
    else if (e.priceBasis === 'tick-derived-estimate') estimatedBasisEventCount += 1;
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
    pendingClaimCount,
    spotFallbackEventCount,
    estimatedBasisEventCount,
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
        // LAST RESORT: value the exit at CURRENT spot. Permitted by
        // pricing-invariants Rule 2 (a withdrawal is a point-in-time position
        // value, not historical earnings) and kept — but COUNTED, because it is
        // the direct cause of a non-deterministic Capital G/L.
        //
        // Which branch runs depends purely on whether the claim-date historical
        // price happened to be warm in the cache at that moment, so the SAME
        // closed position is valued historically on one load and at spot on the
        // next. Measured 2026-08-05 on Account 1: one position's withdrawn value
        // read $6,364.83 vs $7,019.10 across identical loads, and two such
        // positions accounted for the entire $738.81 Capital G/L spread.
        //
        // Counting it lets the caller mark the position "not finally priced yet"
        // so Capital G/L declares itself incomplete and retries, instead of
        // presenting a spot-derived figure as a settled historical total.
        spotFallbackEventCount += 1;
        closingValue += w.amount0 * price0 + w.amount1 * price1;
      }
    }

    // Sanity ceiling — closing value can leak raw uint256 just like initial
    // value (decimals mismatch / malformed withdrawal log). Reject the whole
    // position rather than let ~trillions land in aggregated closingValue.
    if (!withinSanityCeiling(closingValue) || !withinSanityCeiling(hodlValue)) {
      return { ok: false, reason: 'value_overflow' };
    }

    const netPnlUSD = closingValue + feesCollected - initialValue;
    const netPnlPct = initialValue > 0 ? (netPnlUSD / initialValue) * 100 : 0;

    const ilUSD = ilAvailable ? closingValue - hodlValue : 0;
    const ilPct = ilAvailable ? (closingValue / hodlValue - 1) * 100 : 0;

    if (!withinSanityCeiling(ilUSD) || !withinSanityCeiling(netPnlUSD)) {
      return { ok: false, reason: 'value_overflow' };
    }

    return {
      ok: true,
      data: {
        ...sharedFields,
        // MUST come after the spread: `sharedFields` snapshotted
        // spotFallbackEventCount BY VALUE before the withdrawal loop above ran,
        // so the spread alone would return the pre-loop count and silently
        // discard every withdrawal spot-fallback this position hit. Found while
        // fixing ITEM 0b — it made ITEM 0's withdrawal-side counter dead on the
        // CLOSED path, which is exactly where closed-position Capital G/L lives.
        spotFallbackEventCount,
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

  // Sanity ceiling — open path. `currentValue` comes from pos.value (positions
  // route) so should be safe, but hodl/IL/netPnl could still pick up garbage
  // from a bad initialValue path. Defensive check before returning.
  if (
    !withinSanityCeiling(currentValue) ||
    !withinSanityCeiling(hodlValue) ||
    !withinSanityCeiling(ilUSD) ||
    !withinSanityCeiling(netPnlUSD)
  ) {
    return { ok: false, reason: 'value_overflow' };
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
