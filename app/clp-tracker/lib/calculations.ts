import type {
  FeeClaim,
  PortfolioSummary,
  Position,
  Transfer,
  Withdrawal,
} from "./types";
import { normalizeToken } from "./nameNormalization";
import { isExpensedTransfer } from "./transferState";

const MS_PER_DAY = 1000 * 60 * 60 * 24;

function toFinite(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function calcDaysActive(
  entryDatetime: string,
  exitDatetime?: string | null,
): number {
  const entry = new Date(entryDatetime).getTime();
  if (Number.isNaN(entry)) return 0;

  const endRaw = exitDatetime ? new Date(exitDatetime).getTime() : Date.now();
  const end = Number.isNaN(endRaw) ? Date.now() : endRaw;

  const diff = (end - entry) / MS_PER_DAY;
  return diff > 0 ? diff : 0;
}

export function calcTotalFees(claimed: number, newFees: number): number {
  return toFinite(claimed) + toFinite(newFees);
}

export function calcPriceDiff(currentBalance: number, deposited: number): number {
  return toFinite(currentBalance) - toFinite(deposited);
}

export function calcProfit(priceDiff: number, fees: number): number {
  return toFinite(priceDiff) + toFinite(fees);
}

export function calcClosedProfit(
  scalp: number | null,
  fees: number,
): number {
  return toFinite(scalp) + toFinite(fees);
}

// Branches on status: closed positions realize profit from Scalp + Fees,
// active positions from Price Diff + Fees. Single source of truth so every
// surface (Dashboard, Positions, Total P&L) agrees (Invariant #6).
export function calcPositionProfit(
  position: Position,
  totalFees: number,
  priceDiff: number,
): number {
  if (position.status === "closed") {
    return calcClosedProfit(position.scalp, totalFees);
  }
  return calcProfit(priceDiff, totalFees);
}

export function calcFeeAPR(
  fees: number,
  deposited: number,
  daysActive: number,
): number {
  if (deposited <= 0 || daysActive <= 0) return 0;
  return (fees / deposited) * (365 / daysActive) * 100;
}

export function calcDailyAPR(feeAPR: number): number {
  return toFinite(feeAPR) / 365;
}

export function calcMonthlyAPR(feeAPR: number): number {
  return toFinite(feeAPR) / 12;
}

export function calcYearlyAPR(
  fees: number,
  daysActive: number,
  deposited: number,
): number {
  return calcFeeAPR(fees, deposited, daysActive);
}

export function calcROI(profit: number, deposited: number): number {
  if (deposited <= 0) return 0;
  return (profit / deposited) * 100;
}

export function calcADF(fees: number, daysActive: number): number {
  if (daysActive <= 0) return 0;
  return fees / daysActive;
}

export interface ILResult {
  lowerPrice: number;
  upperPrice: number;
  currentRatio: number;
  futureRatio: number;
  inRange: boolean;
  initialToken0: number;
  initialToken1: number;
  futureToken0: number;
  futureToken1: number;
  hodlValue: number;
  lpValue: number;
  lpWithYield: number;
  yieldEarned: number;
  ilDollar: number;
  ilPercent: number;
  hodlPct: number;
  lpPct: number;
  daysToCover: number;
  apr: number;
  yieldPct: number;
}

export function calcIL(
  p0: number,
  p1: number,
  f0: number,
  f1: number,
  inv: number,
  lowerPct: number,
  upperPct: number,
  dailyYield: number,
  days: number,
  token0Count?: number,
  token1Count?: number,
): ILResult {
  const cr = p0 / p1;
  const fr = f0 / f1;
  const lp = cr * (1 + lowerPct / 100);
  const up = cr * (1 + upperPct / 100);
  const inR = fr >= lp && fr <= up;
  const spa = Math.sqrt(lp);
  const spb = Math.sqrt(up);
  const sp0 = Math.sqrt(cr);
  const sp1 = Math.sqrt(fr);
  // Initial amounts per unit of liquidity branch on where the entry
  // price sits relative to the range: at/below the bottom the position
  // is 100% token0, at/above the top it is 100% token1.
  let t0pL: number;
  let t1pL: number;
  if (cr <= lp) {
    t0pL = 1 / spa - 1 / spb;
    t1pL = 0;
  } else if (cr >= up) {
    t0pL = 0;
    t1pL = spb - spa;
  } else {
    t0pL = 1 / sp0 - 1 / spb;
    t1pL = sp0 - spa;
  }
  const vpL = t0pL * cr + t1pL;
  // Liquidity from actual token amounts when available — Deposited USD
  // may be valued at a different price than entryPrice (DEX interfaces
  // report live market value), which would skew L by the mismatch ratio.
  const t0 = toFinite(token0Count);
  const t1 = toFinite(token1Count);
  let L: number;
  if (t0 > 0 && t1 > 0 && t0pL > 0 && t1pL > 0) {
    // Case 1 — two-sided position with entry price inside the range.
    // Solve for L using BOTH token amounts simultaneously (quadratic
    // method), removing the single-side entry-price sensitivity that
    // amplified out-of-range projections when Deposited USD / entry
    // price drifted from the actual on-chain valuation.
    //   A·L² − B·L − C = 0, positive root only.
    const A = 1 - spa / spb;
    const B = t0 * spa + t1 / spb;
    const C = t0 * t1;
    L = A > 0 ? (B + Math.sqrt(B * B + 4 * A * C)) / (2 * A) : 0;
  } else if (t1 > 0 && t1pL > 0) {
    // Case 2 — single-sided (quote only) or entry outside range.
    L = t1 / t1pL;
  } else if (t0 > 0 && t0pL > 0) {
    // Case 2 — single-sided (base only) or entry outside range.
    L = t0 / t0pL;
  } else {
    // Case 3 — legacy records with no token counts: value-based fallback.
    L = vpL > 0 ? inv / vpL : 0;
  }
  const it0 = L * t0pL;
  const it1 = L * t1pL;
  let ft0: number;
  let ft1: number;
  if (fr <= lp) {
    ft0 = L * (1 / spa - 1 / spb);
    ft1 = 0;
  } else if (fr >= up) {
    ft0 = 0;
    ft1 = L * (spb - spa);
  } else {
    ft0 = L * (1 / sp1 - 1 / spb);
    ft1 = L * (sp1 - spa);
  }
  const hv0 = it0 * f0;
  const hv1 = it1 * f1;
  const hodl = hv0 + hv1;
  const fv0 = ft0 * f0;
  const fv1 = ft1 * f1;
  const lpValue = fv0 + fv1;
  const apr = dailyYield * 365;
  const yieldPct = dailyYield * days;
  const yieldEarned = inv * (yieldPct / 100);
  const lpWithYield = lpValue + yieldEarned;
  const ilDollar = lpValue - hodl;
  const ilPercent = hodl > 0 ? (ilDollar / hodl) * 100 : 0;
  const dailyYieldDollar = (apr / 100 / 365) * inv;
  const daysToCover =
    dailyYieldDollar > 0 ? Math.abs(ilDollar) / dailyYieldDollar : 99999;
  const hodlPct = inv > 0 ? ((hodl - inv) / inv) * 100 : 0;
  const lpPct = inv > 0 ? ((lpWithYield - inv) / inv) * 100 : 0;
  return {
    lowerPrice: lp,
    upperPrice: up,
    currentRatio: cr,
    futureRatio: fr,
    inRange: inR,
    initialToken0: it0,
    initialToken1: it1,
    futureToken0: ft0,
    futureToken1: ft1,
    hodlValue: hodl,
    lpValue,
    lpWithYield,
    yieldEarned,
    ilDollar,
    ilPercent,
    hodlPct,
    lpPct,
    daysToCover,
    apr,
    yieldPct,
  };
}

export interface ILInput {
  entryPrice: number;
  rangeDown: number;
  rangeUp: number;
  deposited: number;
  token0Count?: number;
  token1Count?: number;
}

// Single source of truth for out-of-range projections — every surface
// (position form, Pool P&L) must go through this wrapper (Invariant #6).
export function computePositionIL(
  input: ILInput,
  futurePrice: number,
): ILResult | null {
  const { entryPrice, rangeDown, rangeUp, deposited, token0Count, token1Count } =
    input;
  if (
    ![entryPrice, rangeDown, rangeUp, deposited, futurePrice].every(
      Number.isFinite,
    ) ||
    entryPrice <= 0 ||
    rangeDown <= 0 ||
    rangeUp <= 0 ||
    deposited <= 0 ||
    futurePrice <= 0 ||
    rangeUp <= rangeDown
  ) {
    return null;
  }
  const lowerPct = ((rangeDown - entryPrice) / entryPrice) * 100;
  const upperPct = ((rangeUp - entryPrice) / entryPrice) * 100;
  return calcIL(
    entryPrice,
    1,
    futurePrice,
    1,
    deposited,
    lowerPct,
    upperPct,
    0,
    0,
    token0Count,
    token1Count,
  );
}

// position.claimed is a derived value, not a user input (Invariant #10):
// the sum of stableAmount across ALL claims linked to the position —
// stableAmount means "USD value of the claim" regardless of conversion
// status (Sprint 5). Legacy claims saved without a USD value hold null and
// contribute $0 until claim-time historical pricing lands (Sprint 8 /
// Invariant #2). Falls back to the stored value only for positions with no
// valued claims logged.
export function getEffectiveClaimed(
  position: Position,
  allClaims: FeeClaim[],
): number {
  const relatedClaims = allClaims.filter(
    (c) => c.positionId === position.id && c.stableAmount !== null,
  );
  if (relatedClaims.length > 0) {
    return relatedClaims.reduce((sum, c) => sum + toFinite(c.stableAmount), 0);
  }
  return toFinite(position.claimed);
}

// newFees (unclaimed accrued fees) stays manual by definition — those fees
// don't exist as claim records yet. Only claimed is derived.
export function getEffectiveTotalFees(
  position: Position,
  allClaims: FeeClaim[],
): number {
  return getEffectiveClaimed(position, allClaims) + toFinite(position.newFees);
}

// Deposited USD is a derived value, not a user input (Invariant #9):
// (base token count × entry price) + quote token count, quote being a $1
// stablecoin by convention. Every calculation or display that reads
// position.deposited must go through this helper so legacy records with a
// mistyped stored value display corrected numbers. Falls back to the
// stored value only when token counts are missing/zero.
export function getEffectiveDeposited(position: Position): number {
  const base = toFinite(position.token1Count);
  const entry = toFinite(position.entryPrice);
  const quote = toFinite(position.token2Count);
  const computed =
    (base > 0 && entry > 0 ? base * entry : 0) + (quote > 0 ? quote : 0);
  if (computed > 0) return computed;
  return toFinite(position.deposited);
}

export interface TokenPnLRow {
  token: string;
  activeCount: number;
  closedCount: number;
  unrealized: number;
  realized: number;
  shortPnl: number;
  fees: number;
  netPnl: number;
}

// Sprint 6: per-token P&L books, mirroring the Google Sheet's Pool P&L 0
// tab. Positions group by base token symbol (token1Symbol). Realized =
// closed positions' (final balance − deposited); Unrealized = active
// positions' (current balance − deposited); Short P&L sums shortTotal.
// Net = realized + unrealized + short. Fee income is informational only
// and stays OUT of netPnl — the sheet keeps fees out of the token books
// (per-token fee income lives in Total P&L's Fee Income Breakdown).
export function calcTokenPnL(
  positions: Position[],
  allClaims: FeeClaim[],
): TokenPnLRow[] {
  const map = new Map<string, TokenPnLRow>();
  for (const p of positions) {
    const token = (p.token1Symbol || "").trim().toUpperCase() || "—";
    let row = map.get(token);
    if (!row) {
      row = {
        token,
        activeCount: 0,
        closedCount: 0,
        unrealized: 0,
        realized: 0,
        shortPnl: 0,
        fees: 0,
        netPnl: 0,
      };
      map.set(token, row);
    }
    const principalDiff = toFinite(p.currentBalance) - getEffectiveDeposited(p);
    if (p.status === "closed") {
      row.closedCount += 1;
      row.realized += principalDiff;
    } else {
      row.activeCount += 1;
      row.unrealized += principalDiff;
    }
    if (p.shortTotal !== null && Number.isFinite(p.shortTotal)) {
      row.shortPnl += p.shortTotal;
    }
    row.fees += getEffectiveTotalFees(p, allClaims);
  }
  const rows = Array.from(map.values());
  for (const row of rows) {
    row.netPnl = row.realized + row.unrealized + row.shortPnl;
  }
  rows.sort((a, b) => b.netPnl - a.netPnl);
  return rows;
}

// Business P&L (mirrors the Business P&L sheet): lifetime reward-token
// quantities from claim records, valued at user-entered current prices.
// "Usdc Converted" is the claim-time USD value (stableAmount); the sheet's
// P&L is the gap between claim-time value and today's value if held in kind.
export interface BusinessTokenRow {
  token: string;
  quantity: number;
  price: number | null;
  usdValue: number | null;
}

export interface BusinessPnL {
  tokenRows: BusinessTokenRow[];
  allTotal: number;
  unpricedTokens: string[];
  usdcConverted: number;
  pnl: number;
}

const STABLE_SYMBOLS = new Set(["USDC", "USDT", "DAI", "USD"]);

// Stablecoins are anchored to $1 rather than priced, current or historical.
// Exported so the historical price route uses the same list as every other
// calculation — a symbol treated as stable in one place and volatile in
// another would value the same close two different ways (Invariant #6).
export function isStableSymbol(symbol: string): boolean {
  return STABLE_SYMBOLS.has(symbol.trim().toUpperCase());
}

export function calcBusinessPnL(
  claims: FeeClaim[],
  prices: Record<string, number>,
): BusinessPnL {
  const quantities = new Map<string, number>();
  let usdcConverted = 0;

  const add = (symbol: string, amount: number) => {
    // DELIBERATE FINANCIAL MERGE (user-authorized): normalizeToken folds WETH
    // into ETH (and WBTC/CBBTC into BTC), so the combined quantity is priced
    // once at the canonical token's price. Business-P&L-only — see the token
    // NOTE in nameNormalization.ts and CLAUDE.md.
    const token = normalizeToken(symbol);
    if (token === "" || !Number.isFinite(amount) || amount === 0) return;
    quantities.set(token, (quantities.get(token) ?? 0) + amount);
  };

  for (const claim of claims) {
    add(claim.token1Symbol, claim.token1Amount);
    add(claim.token2Symbol, claim.token2Amount);
    if (claim.stableAmount !== null && Number.isFinite(claim.stableAmount)) {
      usdcConverted += claim.stableAmount;
    }
  }

  const tokenRows: BusinessTokenRow[] = [];
  const unpricedTokens: string[] = [];
  let allTotal = 0;

  for (const [token, quantity] of quantities) {
    let price: number | null = Number.isFinite(prices[token])
      ? prices[token]
      : null;
    if (price === null && STABLE_SYMBOLS.has(token)) price = 1;
    const usdValue = price === null ? null : quantity * price;
    if (usdValue === null) unpricedTokens.push(token);
    else allTotal += usdValue;
    tokenRows.push({ token, quantity, price, usdValue });
  }

  tokenRows.sort((a, b) => (b.usdValue ?? 0) - (a.usdValue ?? 0));
  return {
    tokenRows,
    allTotal,
    unpricedTokens,
    usdcConverted,
    // Current value MINUS claim-time value, so the sign reads the way every
    // other P&L in the app does: positive = holding the reward tokens has paid
    // off (green), negative = cashing out at claim time would have been better
    // (red). The Sprint 7 sheet subtracted the other way round, which inverted
    // the colour against its own meaning.
    pnl: allTotal - usdcConverted,
  };
}

// Yield accumulated strictly after a checkpoint date — the sheet's
// "Accumulate the yield after <date>" rows, derived instead of hardcoded.
export function calcYieldAfter(claims: FeeClaim[], dateIso: string): number {
  const cutoff = new Date(dateIso).getTime();
  if (!Number.isFinite(cutoff)) return 0;
  let total = 0;
  for (const claim of claims) {
    if (claim.stableAmount === null || !Number.isFinite(claim.stableAmount)) {
      continue;
    }
    const t = new Date(claim.date).getTime();
    if (Number.isFinite(t) && t > cutoff) total += claim.stableAmount;
  }
  return total;
}

// Money taken out of the business strictly after a checkpoint date — the same
// cutoff rule as calcYieldAfter, and deliberately the SAME definition of "out"
// as the Transfers page's Expenses card: logged withdrawals PLUS any transfer
// whose money state is Expense. The expense test is isExpensedTransfer from
// lib/transferState, never a second inline predicate, so this figure and the
// Expenses card can never disagree about what counts (Invariant #6). With a
// cutoff before every record it reproduces balance.withdrawn exactly.
export function calcExpensesAfter(
  transfers: Transfer[],
  withdrawals: Withdrawal[],
  dateIso: string,
): number {
  const cutoff = new Date(dateIso).getTime();
  if (!Number.isFinite(cutoff)) return 0;
  let total = 0;
  for (const w of withdrawals) {
    const t = new Date(w.date).getTime();
    if (Number.isFinite(t) && t > cutoff) total += toFinite(w.amount);
  }
  for (const tr of transfers) {
    if (!isExpensedTransfer(tr)) continue;
    const t = new Date(tr.date).getTime();
    if (Number.isFinite(t) && t > cutoff) total += toFinite(tr.amount);
  }
  return total;
}

// Unconverted holdings: reward tokens from claims NOT cashed out to stable
// (the sheet's "Still in X" rows). Only these are still price-exposed; a
// converted claim's tokens were already sold. Cost basis per claim side:
// stablecoin sides count at face value, and the remaining stableAmount is
// attributed to the volatile side(s). Claims with no stableAmount have
// unknown cost basis and are flagged (excluded from cost basis / P&L only).
export interface HoldingRow {
  token: string;
  quantity: number;
  price: number | null;
  currentValue: number | null;
  costBasis: number | null;
  pnl: number | null;
}

export interface UnconvertedHoldings {
  rows: HoldingRow[];
  totalCurrentValue: number;
  totalCostBasis: number;
  totalPnl: number;
  unpricedTokens: string[];
  hasUnknownCostBasis: boolean;
}

export interface UnconvertedHoldingsOptions {
  // Drop stablecoin sides from the rows AND the totals. Business P&L's
  // Unconverted Holdings table exists to show PRICE EXPOSURE, and a stablecoin
  // has none — its value is already counted as realized in Converted Fees, so
  // listing it here reads as a second, unrealized copy of the same money.
  // Off by default so every existing caller (the Dashboard and Total P&L
  // "still held at today's value" notes) keeps the figure it has always shown.
  excludeStables?: boolean;
}

export function calcUnconvertedHoldings(
  claims: FeeClaim[],
  prices: Record<string, number>,
  options: UnconvertedHoldingsOptions = {},
): UnconvertedHoldings {
  const excludeStables = options.excludeStables === true;
  const quantities = new Map<string, number>();
  const costBasis = new Map<string, number>();
  // Tokens where at least one contributing claim lacks a claim-time value.
  // Their cost basis is only partial, so we refuse to show a P&L for them
  // rather than report a misleadingly inflated gain (North Star: auditable).
  const unknownBasisTokens = new Set<string>();
  let hasUnknownCostBasis = false;

  const addQty = (symbol: string, amount: number): string | null => {
    // Same user-authorized merge as calcBusinessPnL — WETH holdings roll into
    // the ETH bucket and are valued at ETH's price.
    const token = normalizeToken(symbol);
    if (token === "" || !Number.isFinite(amount) || amount === 0) return null;
    quantities.set(token, (quantities.get(token) ?? 0) + amount);
    return token;
  };

  const addCost = (token: string, value: number) => {
    if (!Number.isFinite(value)) return;
    costBasis.set(token, (costBasis.get(token) ?? 0) + value);
  };

  for (const claim of claims) {
    if (claim.convertedToStable) continue;

    // Collect this claim's held sides (token + amount), skipping empties. When
    // stables are excluded they still take part in the cost-basis arithmetic
    // below — the residual owed to the volatile side is stableAmount minus the
    // stable face value — they just never become a quantity, a row or a total.
    const sides: Array<{ token: string; amount: number }> = [];
    for (const [symbol, amount] of [
      [claim.token1Symbol, claim.token1Amount],
      [claim.token2Symbol, claim.token2Amount],
    ] as Array<[string, number]>) {
      const token = normalizeToken(symbol);
      if (token === "" || !Number.isFinite(amount) || amount === 0) continue;
      if (!(excludeStables && STABLE_SYMBOLS.has(token))) addQty(symbol, amount);
      sides.push({ token, amount });
    }
    if (sides.length === 0) continue;

    // Cost basis needs the claim-time USD value; without it, mark every side
    // as unknown-basis and flag globally.
    if (claim.stableAmount === null || !Number.isFinite(claim.stableAmount)) {
      hasUnknownCostBasis = true;
      for (const s of sides) unknownBasisTokens.add(s.token);
      continue;
    }

    // Stable sides count at face value; volatile side(s) split the remainder.
    const stableSides = sides.filter((s) => STABLE_SYMBOLS.has(s.token));
    const volatileSides = sides.filter((s) => !STABLE_SYMBOLS.has(s.token));
    let stableFace = 0;
    for (const s of stableSides) {
      // No basis entry for a token that has no quantity to carry it.
      if (!excludeStables) addCost(s.token, s.amount);
      stableFace += s.amount;
    }
    const residual = claim.stableAmount - stableFace;
    if (volatileSides.length === 0) continue;
    if (volatileSides.length === 1) {
      addCost(volatileSides[0].token, residual);
    } else {
      // Rare multi-volatile claim: split residual by current price weight,
      // falling back to equal split when prices are missing.
      let weightTotal = 0;
      const weights = volatileSides.map((s) => {
        const p = Number.isFinite(prices[s.token]) ? prices[s.token] : 0;
        const w = p > 0 ? s.amount * p : 0;
        weightTotal += w;
        return w;
      });
      volatileSides.forEach((s, i) => {
        const share =
          weightTotal > 0 ? weights[i] / weightTotal : 1 / volatileSides.length;
        addCost(s.token, residual * share);
      });
    }
  }

  const rows: HoldingRow[] = [];
  const unpricedTokens: string[] = [];
  let totalCurrentValue = 0;
  let totalCostBasis = 0;
  let totalPnl = 0;

  for (const [token, quantity] of quantities) {
    let price: number | null = Number.isFinite(prices[token])
      ? prices[token]
      : null;
    if (price === null && STABLE_SYMBOLS.has(token)) price = 1;
    const currentValue = price === null ? null : quantity * price;
    // A token with any unknown-basis contribution has no trustworthy cost
    // basis or P&L — show "—" instead of a partial (inflated) figure.
    const basis =
      unknownBasisTokens.has(token) || !costBasis.has(token)
        ? null
        : (costBasis.get(token) as number);
    const pnl =
      currentValue === null || basis === null ? null : currentValue - basis;

    if (currentValue === null) unpricedTokens.push(token);
    else totalCurrentValue += currentValue;
    if (basis !== null) totalCostBasis += basis;
    if (pnl !== null) totalPnl += pnl;

    rows.push({ token, quantity, price, currentValue, costBasis: basis, pnl });
  }

  rows.sort((a, b) => (b.currentValue ?? 0) - (a.currentValue ?? 0));
  return {
    rows,
    totalCurrentValue,
    totalCostBasis,
    totalPnl,
    unpricedTokens,
    hasUnknownCostBasis,
  };
}

// Range Health (Sprint 11): how close a position's current price is to
// falling out of its range. currentPrice, rangeDown, rangeUp share the same
// units (quote per base). "close" fires within thresholdPct of either edge.
export type RangeStatus = "safe" | "close" | "out" | "unknown";

export interface RangeHealth {
  status: RangeStatus;
  currentPrice: number | null;
  bandPosition: number | null; // 0 = at bottom edge, 1 = at top edge
  distanceToLowerPct: number | null; // (P − down)/P·100; negative if below
  distanceToUpperPct: number | null; // (up − P)/P·100; negative if above
  nearestEdgePct: number | null; // smaller of the two distances, in %
}

export function calcRangeHealth(
  currentPrice: number | null,
  rangeDown: number,
  rangeUp: number,
  thresholdPct = 5,
): RangeHealth {
  const unknown: RangeHealth = {
    status: "unknown",
    currentPrice: null,
    bandPosition: null,
    distanceToLowerPct: null,
    distanceToUpperPct: null,
    nearestEdgePct: null,
  };
  if (
    currentPrice === null ||
    !Number.isFinite(currentPrice) ||
    currentPrice <= 0 ||
    !Number.isFinite(rangeDown) ||
    !Number.isFinite(rangeUp) ||
    rangeUp <= rangeDown
  ) {
    return unknown;
  }

  const distanceToLowerPct = ((currentPrice - rangeDown) / currentPrice) * 100;
  const distanceToUpperPct = ((rangeUp - currentPrice) / currentPrice) * 100;
  const bandPosition = (currentPrice - rangeDown) / (rangeUp - rangeDown);
  const nearestEdgePct = Math.min(distanceToLowerPct, distanceToUpperPct);

  let status: RangeStatus;
  if (currentPrice <= rangeDown || currentPrice >= rangeUp) {
    status = "out";
  } else if (nearestEdgePct <= thresholdPct) {
    status = "close";
  } else {
    status = "safe";
  }

  return {
    status,
    currentPrice,
    bandPosition,
    distanceToLowerPct,
    distanceToUpperPct,
    nearestEdgePct,
  };
}

export interface TokenSplit {
  baseCount: number;
  quoteCount: number;
}

// Splits a deposited USD amount into the base/quote token counts a CLMM
// position actually holds at `entryPrice` inside [rangeDown, rangeUp].
//
// Per unit of liquidity L the position holds
//   base  = 1/√P − 1/√Pb      quote = √P − √Pa
// so its value in quote terms is L × (2√P − P/√Pb − √Pa). Inverting that
// gives L from a known deposit, and the two amounts follow. Branches on
// entry vs. range exactly as calcIL does (Invariant #6 — the same position
// shape must produce the same amounts here and in the IL projection):
// at/below the bottom the position is 100% base, at/above the top 100%
// quote. Note the 50/50 split sits at the GEOMETRIC mean √(Pa·Pb), not the
// arithmetic midpoint of the range.
//
// Returns null when the inputs cannot describe a position (non-positive or
// non-finite values, inverted range) so callers leave token counts alone
// rather than writing zeros.
export function splitDepositedIntoTokens(
  deposited: number,
  entryPrice: number,
  rangeDown: number,
  rangeUp: number,
): TokenSplit | null {
  const liquidity = liquidityFromDeposited(
    deposited,
    entryPrice,
    rangeDown,
    rangeUp,
  );
  if (liquidity === null) return null;
  return tokensFromLiquidity(liquidity, entryPrice, rangeDown, rangeUp);
}

// Token amounts and position value per unit of liquidity. The single place
// the CLMM branch structure lives — everything below is built from it, so a
// position's shape can never be described two different ways.
interface PerLiquidity {
  basePerL: number;
  quotePerL: number;
  valuePerL: number;
}

function perLiquidity(
  entryPrice: number,
  rangeDown: number,
  rangeUp: number,
): PerLiquidity | null {
  const inputs = [entryPrice, rangeDown, rangeUp];
  if (inputs.some((v) => !Number.isFinite(v) || v <= 0)) return null;
  if (rangeUp <= rangeDown) return null;

  const spa = Math.sqrt(rangeDown);
  const spb = Math.sqrt(rangeUp);
  let basePerL: number;
  let quotePerL: number;
  if (entryPrice <= rangeDown) {
    basePerL = 1 / spa - 1 / spb;
    quotePerL = 0;
  } else if (entryPrice >= rangeUp) {
    basePerL = 0;
    quotePerL = spb - spa;
  } else {
    const sp0 = Math.sqrt(entryPrice);
    basePerL = 1 / sp0 - 1 / spb;
    quotePerL = sp0 - spa;
  }
  const valuePerL = basePerL * entryPrice + quotePerL;
  if (!Number.isFinite(valuePerL) || valuePerL <= 0) return null;
  return { basePerL, quotePerL, valuePerL };
}

// Liquidity (L) implied by depositing `deposited` at `entryPrice`. This is
// what stays fixed as the entry price is nudged around — the size of the
// position, independent of where the price happens to sit.
export function liquidityFromDeposited(
  deposited: number,
  entryPrice: number,
  rangeDown: number,
  rangeUp: number,
): number | null {
  if (!Number.isFinite(deposited) || deposited <= 0) return null;
  const per = perLiquidity(entryPrice, rangeDown, rangeUp);
  if (per === null) return null;
  const liquidity = deposited / per.valuePerL;
  return Number.isFinite(liquidity) && liquidity > 0 ? liquidity : null;
}

export function tokensFromLiquidity(
  liquidity: number,
  entryPrice: number,
  rangeDown: number,
  rangeUp: number,
): TokenSplit | null {
  if (!Number.isFinite(liquidity) || liquidity <= 0) return null;
  const per = perLiquidity(entryPrice, rangeDown, rangeUp);
  if (per === null) return null;
  const baseCount = liquidity * per.basePerL;
  const quoteCount = liquidity * per.quotePerL;
  if (!Number.isFinite(baseCount) || !Number.isFinite(quoteCount)) return null;
  return { baseCount, quoteCount };
}

// What a position of fixed size is worth at a given entry price — the LP
// value curve. Rises with price (dV/dP = L(1/√P − 1/√Pb) > 0 below the top)
// and flattens completely once price passes the top of the range, because
// the position is then entirely quote token.
export function depositedFromLiquidity(
  liquidity: number,
  entryPrice: number,
  rangeDown: number,
  rangeUp: number,
): number | null {
  if (!Number.isFinite(liquidity) || liquidity <= 0) return null;
  const per = perLiquidity(entryPrice, rangeDown, rangeUp);
  if (per === null) return null;
  const deposited = liquidity * per.valuePerL;
  return Number.isFinite(deposited) && deposited > 0 ? deposited : null;
}

export interface EntryPriceFromDeposited {
  entryPrice: number;
  // Value is flat above the top of the range, so no entry price can produce
  // a deposit larger than maxDeposited — the caller gets the top of the
  // range back and `clamped` set, rather than a silently wrong price.
  clamped: boolean;
  maxDeposited: number;
}

// Inverse of depositedFromLiquidity: the entry price at which a position of
// this size is worth `deposited`. Monotonic in price, so the answer is
// unique wherever one exists.
export function entryPriceFromDeposited(
  deposited: number,
  liquidity: number,
  rangeDown: number,
  rangeUp: number,
): EntryPriceFromDeposited | null {
  if (!Number.isFinite(deposited) || deposited <= 0) return null;
  if (!Number.isFinite(liquidity) || liquidity <= 0) return null;
  if (
    !Number.isFinite(rangeDown) ||
    !Number.isFinite(rangeUp) ||
    rangeDown <= 0 ||
    rangeUp <= rangeDown
  ) {
    return null;
  }

  const spa = Math.sqrt(rangeDown);
  const spb = Math.sqrt(rangeUp);
  const maxDeposited = liquidity * (spb - spa);
  const atRangeDown = liquidity * (1 / spa - 1 / spb) * rangeDown;

  if (deposited >= maxDeposited) {
    return { entryPrice: rangeUp, clamped: true, maxDeposited };
  }
  // Below the range the position is 100% base token, so value is simply
  // linear in price — no quadratic needed, and no lower bound to clamp at.
  if (deposited <= atRangeDown) {
    const basePerL = 1 / spa - 1 / spb;
    const entryPrice = deposited / (liquidity * basePerL);
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) return null;
    return { entryPrice, clamped: false, maxDeposited };
  }

  // Inside the range, with x = √P:
  //   L(2x − x²/√Pb − √Pa) = V   ⇒   x² − 2√Pb·x + √Pb(√Pa + V/L) = 0
  // The lower root is the one that lands inside the range.
  const c = spb * (spa + deposited / liquidity);
  const disc = spb * spb - c;
  if (disc < 0) return null;
  const x = spb - Math.sqrt(disc);
  const entryPrice = x * x;
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return null;
  return { entryPrice, clamped: false, maxDeposited };
}

export interface EntryPriceFromTokens {
  entryPrice: number;
  // "two-sided" solved the quadratic from both amounts; "base-only" and
  // "quote-only" sit on a range boundary and need no solving.
  shape: "two-sided" | "base-only" | "quote-only";
}

// Solves the entry price implied by the token amounts actually deposited —
// the reverse of splitDepositedIntoTokens. Lets a position be recorded from
// on-chain transaction amounts instead of a typed (estimated) price.
//
// With x = √P, the two CLMM amount formulas give a ratio that rearranges to
//   (a0·√pU)x² + (a1 − a0·√pU·√pL)x − a1·√pU = 0
// C is negative whenever a1 > 0, so the roots straddle zero and only the
// positive one is physical.
//
// The ratio a0/a1 falls monotonically from ∞ at the bottom of the range to 0
// at the top, so any two positive amounts map to exactly one price strictly
// inside the range — a two-sided pair cannot be "out of range". Single-sided
// input is the only way to land on a boundary, and it is solved directly
// rather than through the quadratic (a0 = 0 would divide by zero).
export function entryPriceFromTokens(
  baseCount: number,
  quoteCount: number,
  rangeDown: number,
  rangeUp: number,
): EntryPriceFromTokens | null {
  if (!Number.isFinite(baseCount) || !Number.isFinite(quoteCount)) return null;
  if (baseCount < 0 || quoteCount < 0) return null;
  if (
    !Number.isFinite(rangeDown) ||
    !Number.isFinite(rangeUp) ||
    rangeDown <= 0 ||
    rangeUp <= rangeDown
  ) {
    return null;
  }
  if (baseCount === 0 && quoteCount === 0) return null;

  // All quote token means price has reached the top of the range; all base
  // token means it has reached the bottom.
  if (baseCount === 0) {
    return { entryPrice: rangeUp, shape: "quote-only" };
  }
  if (quoteCount === 0) {
    return { entryPrice: rangeDown, shape: "base-only" };
  }

  const spU = Math.sqrt(rangeUp);
  const spL = Math.sqrt(rangeDown);
  const a = baseCount * spU;
  const b = quoteCount - baseCount * spU * spL;
  const c = -quoteCount * spU;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const x = (-b + Math.sqrt(disc)) / (2 * a);
  if (!Number.isFinite(x) || x <= 0) return null;
  const entryPrice = x * x;
  // Defensive only (Invariant #8) — unreachable for positive amounts given
  // the monotonicity above, but a NaN or out-of-band price must never reach
  // the IL projections.
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return null;
  if (entryPrice < rangeDown || entryPrice > rangeUp) return null;
  return { entryPrice, shape: "two-sided" };
}

export function calcWideRangePercent(
  rangeDown: number,
  rangeUp: number,
): number {
  if (
    rangeDown <= 0 ||
    !Number.isFinite(rangeDown) ||
    !Number.isFinite(rangeUp)
  ) {
    return 0;
  }
  return ((rangeUp - rangeDown) / rangeDown) * 100;
}

export interface OverallPnL {
  activeCurrentValue: number;
  convertedFees: number;
  expenses: number;
  initialCapital: number;
  overall: number;
  // Claims marked converted but saved without a USD value contribute nothing
  // and are counted here so the UI can say so rather than quietly understate.
  unvaluedConvertedClaims: number;
  // Claims marked NOT converted that nonetheless hold a stablecoin leg, and
  // the dollars that leg contributes. Surfaced so the in-app diagnostic can
  // report the exact impact of the per-leg rule on the user's own data
  // without recomputing it a second way (Invariant #6).
  mixedStableClaims: number;
  mixedStableRecovered: number;
}

// The face value of a claim's stablecoin legs. A stable leg is already in
// stablecoin — it never was volatile and never needed converting — so it is
// realized money regardless of the claim's overall convertedToStable flag.
// Uses the same stable set as every other calculation (isStableSymbol).
export function claimStableFace(claim: FeeClaim): number {
  let face = 0;
  if (isStableSymbol(claim.token1Symbol) && Number.isFinite(claim.token1Amount)) {
    face += Math.max(0, claim.token1Amount);
  }
  if (isStableSymbol(claim.token2Symbol) && Number.isFinite(claim.token2Amount)) {
    face += Math.max(0, claim.token2Amount);
  }
  return face;
}

// The realized (already-in-stablecoin) dollars an UNCONVERTED claim still
// contributes to Overall P&L. Converted claims return 0 here because their
// whole stableAmount is counted by the converted branch instead — this
// function is only the "not converted" half of the per-leg rule.
//
// Clamped to the claim's typed total when one exists, so a mistyped leg amount
// can never contribute more than the whole claim was worth (Invariant #8).
// With no typed total (legacy unvalued claim), the stable leg's face value
// stands on its own — it is known money regardless.
//
// Single source of the rule: calcOverallPnL and the in-app diagnostic both
// call this, so the reported recovery can never disagree with the figure
// actually added to Overall P&L (Invariant #6).
export function claimStableRealized(claim: FeeClaim): number {
  if (claim.convertedToStable) return 0;
  const face = claimStableFace(claim);
  if (face <= 0) return 0;
  const typed = claim.stableAmount;
  const cap = Number.isFinite(typed) ? (typed as number) : face;
  return Math.max(0, Math.min(face, cap));
}

export interface MixedStableClaimRow {
  claim: FeeClaim;
  stableFace: number;
  recovered: number;
  typedTotal: number | null;
  clamped: boolean;
}

// Every unconverted claim whose stablecoin leg now counts. Powers the one-time
// in-app diagnostic that reports this fix's real impact on the user's own data
// (which cannot be computed outside their browser — localStorage).
export function findMixedStableClaims(claims: FeeClaim[]): MixedStableClaimRow[] {
  const rows: MixedStableClaimRow[] = [];
  for (const claim of claims) {
    const recovered = claimStableRealized(claim);
    if (recovered <= 0) continue;
    const stableFace = claimStableFace(claim);
    const typedTotal = Number.isFinite(claim.stableAmount)
      ? (claim.stableAmount as number)
      : null;
    rows.push({
      claim,
      stableFace,
      recovered,
      typedTotal,
      clamped: recovered < stableFace - 1e-9,
    });
  }
  return rows.sort((a, b) => b.recovered - a.recovered);
}

// Where the business stands against the capital it started with.
//
//   Overall P&L = current value of open positions
//               + fees claimed AND converted to stablecoin, all positions
//               − transfers classified as a real expense
//               − initial capital
//
// Conversion-gated PER LEG, not per claim (user-approved 2026-07-28): this
// measures money actually banked, so a fee leg still held as a volatile token
// is excluded and stays in the Business P&L page's Unconverted Holdings view —
// but a STABLECOIN leg was never volatile and never needed converting, so it
// counts even when the claim as a whole is marked "not converted". The old
// all-or-nothing gate dropped the USDC side of mixed claims entirely and
// understated Overall P&L. That still makes it the second conversion-gated
// metric in the app, alongside Total P&L's per-token stable contributed —
// everywhere else stableAmount means USD value regardless of conversion
// (Invariant #10).
//
// Closed positions contribute only through their converted fees: their
// principal was withdrawn and is not held anywhere the app can see.
// A claim marked converted to stablecoin but saved without a USD value. It
// silently contributes $0 to Overall P&L, so the Claims page surfaces these
// for the user to fill in. Single predicate shared with calcOverallPnL's
// count so the banner and the P&L figure can never disagree about which
// claims are affected.
export function isUnvaluedConvertedClaim(claim: FeeClaim): boolean {
  return (
    claim.convertedToStable === true &&
    (claim.stableAmount === null || !Number.isFinite(claim.stableAmount))
  );
}

export interface ConvertedFees {
  convertedFees: number;
  unvaluedConvertedClaims: number;
  mixedStableClaims: number;
  mixedStableRecovered: number;
}

// Realized fee income: the claim-time USD value of everything actually cashed
// out. A converted claim contributes its whole stableAmount; an unconverted one
// contributes only its stablecoin leg, which was never volatile and so needed no
// converting (9633297). Lifted out of calcOverallPnL unchanged so Business P&L
// can show the SAME figure without a second implementation — two ways of
// counting realized fees would eventually disagree (Invariant #6).
export function calcConvertedFeesDetail(claims: FeeClaim[]): ConvertedFees {
  let convertedFees = 0;
  let unvaluedConvertedClaims = 0;
  let mixedStableClaims = 0;
  let mixedStableRecovered = 0;
  for (const c of claims) {
    if (c.convertedToStable) {
      if (isUnvaluedConvertedClaim(c)) {
        unvaluedConvertedClaims += 1;
        continue;
      }
      convertedFees += c.stableAmount as number;
      continue;
    }
    // Not converted overall — but any stablecoin leg is already realized.
    const realized = claimStableRealized(c);
    if (realized <= 0) continue;
    convertedFees += realized;
    mixedStableClaims += 1;
    mixedStableRecovered += realized;
  }
  return {
    convertedFees,
    unvaluedConvertedClaims,
    mixedStableClaims,
    mixedStableRecovered,
  };
}

// The dollar figure alone, for callers that only need the number.
export function calcConvertedFees(claims: FeeClaim[]): number {
  return calcConvertedFeesDetail(claims).convertedFees;
}

export function calcOverallPnL(
  positions: Position[],
  claims: FeeClaim[],
  transfers: Transfer[],
  initialCapital: number,
): OverallPnL {
  let activeCurrentValue = 0;
  for (const p of positions) {
    if (p.status === "active") activeCurrentValue += toFinite(p.currentBalance);
  }

  const {
    convertedFees,
    unvaluedConvertedClaims,
    mixedStableClaims,
    mixedStableRecovered,
  } = calcConvertedFeesDetail(claims);

  // Expenses are no longer part of Overall P&L (user-confirmed formula change):
  // Overall P&L measures pure LP business performance; personal spending /
  // withdrawals live on the Transfers page's Available Balance instead. The
  // total is still surfaced (for reference), just not subtracted here.
  let expenses = 0;
  for (const t of transfers) {
    if (t.moneyStatus === "expense") expenses += toFinite(t.amount);
  }

  const capital = toFinite(initialCapital);
  return {
    activeCurrentValue,
    convertedFees,
    expenses,
    initialCapital: capital,
    overall: activeCurrentValue + convertedFees - capital,
    unvaluedConvertedClaims,
    mixedStableClaims,
    mixedStableRecovered,
  };
}

// Transfers logged before expense tracking existed, i.e. never classified.
export function countUnclassifiedTransfers(transfers: Transfer[]): number {
  return transfers.filter((t) => t.moneyStatus === undefined).length;
}

// Scalp is ALWAYS the price difference on a closed position:
//   Scalp = Final Withdrawn Amount − Deposited
// Fees are tracked entirely separately and never belong here.
export function calcScalpFromWithdrawn(
  currentBalance: number,
  deposited: number,
): number {
  return toFinite(currentBalance) - toFinite(deposited);
}

export interface SuspectScalpRow {
  position: Position;
  deposited: number;
  withdrawn: number;
  storedScalp: number;
  correctScalp: number;
  profitOverstatedBy: number;
}

// Closed positions whose stored Scalp is zero/unset while the money actually
// moved — the signature of the old blank-Scalp bug, where Profit showed fees
// alone and ignored a real price gain or loss.
//
// Reports rather than repairs: a genuine round-trip really does have Scalp 0,
// and those are indistinguishable from the bug by value alone. Only the user
// can say which is which, so this feeds a prompt, never an automatic rewrite.
export function findSuspectScalpPositions(
  positions: Position[],
  toleranceUsd = 0.01,
): SuspectScalpRow[] {
  const rows: SuspectScalpRow[] = [];
  for (const p of positions) {
    if (p.status !== "closed") continue;
    const storedScalp = toFinite(p.scalp);
    if (storedScalp !== 0) continue;
    const deposited = getEffectiveDeposited(p);
    const withdrawn = toFinite(p.currentBalance);
    const correctScalp = calcScalpFromWithdrawn(withdrawn, deposited);
    if (Math.abs(correctScalp) <= toleranceUsd) continue;
    rows.push({
      position: p,
      deposited,
      withdrawn,
      storedScalp,
      correctScalp,
      // Profit currently reads as fees alone, so it is overstated by exactly
      // the missing scalp (understated when the scalp is a gain).
      profitOverstatedBy: -correctScalp,
    });
  }
  return rows.sort(
    (a, b) => Math.abs(b.correctScalp) - Math.abs(a.correctScalp),
  );
}

// Data Health detectors moved to lib/dataHealth.ts (consolidated across
// Positions, Claims, and Transfers). Re-exported here so existing import
// sites keep working unchanged and results stay identical.
export {
  findSymbolPairMismatches,
  findClaimSymbolMismatches,
  summarizeClaimContamination,
  correctClaimSymbols,
} from "./dataHealth";
export type {
  SymbolPairMismatchRow,
  ClaimSymbolMismatchRow,
  ClaimContaminationRow,
} from "./dataHealth";

export function calcPortfolioSummary(
  positions: Position[],
  allClaims: FeeClaim[] = [],
): PortfolioSummary {
  const summary: PortfolioSummary = {
    totalDeposited: 0,
    totalCurrentValue: 0,
    totalFees: 0,
    totalProfit: 0,
    averageAPR: 0,
    activePositions: 0,
    closedPositions: 0,
  };

  if (positions.length === 0) return summary;

  let aprWeightedNumerator = 0;
  let aprWeightDenominator = 0;

  for (const p of positions) {
    const deposited = getEffectiveDeposited(p);
    const fees = getEffectiveTotalFees(p, allClaims);
    const days = calcDaysActive(p.entryDatetime, p.exitDatetime);
    const priceDiff = calcPriceDiff(p.currentBalance, deposited);
    const profit = calcPositionProfit(p, fees, priceDiff);
    const apr = calcFeeAPR(fees, deposited, days);

    summary.totalDeposited += deposited;
    summary.totalCurrentValue += toFinite(p.currentBalance);
    summary.totalFees += fees;
    summary.totalProfit += profit;

    if (p.status === "active") summary.activePositions += 1;
    else summary.closedPositions += 1;

    if (deposited > 0) {
      aprWeightedNumerator += apr * deposited;
      aprWeightDenominator += deposited;
    }
  }

  summary.averageAPR =
    aprWeightDenominator > 0 ? aprWeightedNumerator / aprWeightDenominator : 0;

  return summary;
}

// ---------------------------------------------------------------------------
// Growth Target
// ---------------------------------------------------------------------------

// Average days in a calendar month (365.25 / 12). Months elapsed is a decimal
// so the running average reads the same way "Days Active" already does
// elsewhere in the app — not rounded to whole calendar months.
export const DAYS_PER_MONTH = 30.44;

export interface GrowthTarget {
  // Earliest entryDatetime across ALL positions, active and closed. Derived
  // live, never stored, so it stays correct if older positions are added later.
  startDate: string | null;
  monthsElapsed: number;
  // Price P&L across every position ever: scalp when closed, current − deposited
  // when open.
  positionEarnings: number;
  // Business P&L's "All Total" — every fee ever claimed, all tokens, valued at
  // today's price. Passed in rather than recomputed so the two surfaces can
  // never disagree (Invariant #6).
  feeEarnings: number;
  combinedEarnings: number;
  initialCapital: number;
  targetMonthlyPercent: number;
  cumulativeTarget: number;
  // Running average monthly rate actually achieved, as a percent of capital.
  averageMonthlyRate: number;
  // combinedEarnings − cumulativeTarget. Positive = ahead of target.
  difference: number;
  // Why the numbers can't be computed yet, so the UI prompts instead of
  // rendering NaN / a division by zero (Invariant #8).
  missing: {
    initialCapital: boolean;
    target: boolean;
    startDate: boolean;
  };
}

// How the LP business is tracking against a personal monthly growth goal,
// measured as a running average since the very first position was opened.
//
//   Combined Earnings = Σ (closed ? scalp : currentBalance − deposited)
//                     + Business P&L All Total (all fees, valued today)
//   Cumulative Target = Initial Capital × (Target % / 100) × Months Elapsed
//   Average Monthly Rate = (Combined Earnings / Initial Capital) / Months × 100
//
// SCOPE NOTE: deliberately BROADER than Overall P&L. This counts every
// position ever opened (not just active) and every fee earned including tokens
// still held un-converted (not just cashed-out ones). The two numbers are
// expected to differ; the UI labels both so they can't be confused.
export function calcGrowthTarget(
  positions: Position[],
  businessAllTotal: number,
  initialCapital: number,
  targetMonthlyPercent: number,
  now: Date = new Date(),
): GrowthTarget {
  let positionEarnings = 0;
  let earliest: number | null = null;
  let startDate: string | null = null;

  for (const p of positions) {
    positionEarnings +=
      p.status === "closed"
        ? toFinite(p.scalp)
        : toFinite(p.currentBalance) - getEffectiveDeposited(p);

    const t = new Date(p.entryDatetime).getTime();
    if (Number.isFinite(t) && (earliest === null || t < earliest)) {
      earliest = t;
      startDate = p.entryDatetime;
    }
  }

  const feeEarnings = toFinite(businessAllTotal);
  const combinedEarnings = positionEarnings + feeEarnings;
  const capital = toFinite(initialCapital);
  const targetPct = toFinite(targetMonthlyPercent);

  const monthsElapsed =
    earliest === null
      ? 0
      : Math.max(0, (now.getTime() - earliest) / 86400000 / DAYS_PER_MONTH);

  const cumulativeTarget = capital * (targetPct / 100) * monthsElapsed;
  const averageMonthlyRate =
    capital > 0 && monthsElapsed > 0
      ? (combinedEarnings / capital / monthsElapsed) * 100
      : 0;

  return {
    startDate,
    monthsElapsed,
    positionEarnings,
    feeEarnings,
    combinedEarnings,
    initialCapital: capital,
    targetMonthlyPercent: targetPct,
    cumulativeTarget,
    averageMonthlyRate,
    difference: combinedEarnings - cumulativeTarget,
    missing: {
      initialCapital: capital <= 0,
      target: targetPct <= 0,
      startDate: earliest === null,
    },
  };
}
