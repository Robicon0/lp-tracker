// app/lib/positionProjections.ts
//
// Shared, chain-/protocol-agnostic projection of an LP position's forward income.
// Used by the position detail page's Performance Metrics + Yield & APR Projections
// so EVERY position on EVERY chain and protocol shows meaningful projections —
// including brand-new positions that have accrued uncollected fees but have no
// claim history yet (Sprint 1.8b).
//
// Honesty (Memory #14): the returned `source` tells the UI exactly what powered
// the projection so it can label it — real claims vs an early estimate from
// uncollected fees. The UI must never present an uncollected-based estimate as
// if it came from real claims.
//
// Basis selection (in order):
//   1. Real claim history (claimedUSD > 0)  → source 'claims'
//   2. Else uncollected fees (uncollectedFeesUSD > 0) → source 'uncollected'
//   3. Else nothing to project              → source 'none' (UI shows em-dash)
//
// For the 'claims' path the math is byte-identical to the prior inline formulas
// (actualAPR = (claimedUSD/value)·(365/days)·100; dailyIncome = claimedUSD/days),
// so positions WITH claim history are unaffected.

export interface PositionProjection {
  source: 'claims' | 'uncollected' | 'none';
  daily: number | null;
  weekly: number | null;
  monthly: number | null;
  yearly: number | null;
  actualApr: number | null;          // annualized %, null when no basis or value <= 0
  actualAnnualIncome: number | null; // === yearly
}

const NONE: PositionProjection = {
  source: 'none', daily: null, weekly: null, monthly: null, yearly: null,
  actualApr: null, actualAnnualIncome: null,
};

export function computePositionProjection(input: {
  claimedUSD: number;
  uncollectedFeesUSD: number;
  positionValueUSD: number;
  daysActive: number;
}): PositionProjection {
  const { claimedUSD, uncollectedFeesUSD, positionValueUSD, daysActive } = input;

  // Need at least ~a day of history to annualize without wild over/under-shoot.
  if (!(daysActive >= 1)) return NONE;

  let basis: number;
  let source: 'claims' | 'uncollected';
  if (claimedUSD > 0) {
    basis = claimedUSD;
    source = 'claims';
  } else if (uncollectedFeesUSD > 0) {
    basis = uncollectedFeesUSD;
    source = 'uncollected';
  } else {
    return NONE;
  }

  const days = Math.max(1, daysActive); // clamp guards divide-by-zero (defensive)
  const daily = basis / days;
  const yearly = daily * 365;
  return {
    source,
    daily,
    weekly: daily * 7,
    monthly: daily * 30,
    yearly,
    actualApr: positionValueUSD > 0 ? (yearly / positionValueUSD) * 100 : null,
    actualAnnualIncome: yearly,
  };
}
