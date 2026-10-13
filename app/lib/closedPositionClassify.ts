// What the page does with ONE reconstructed closed position (Sui / Solana).
// Pure: no React, no I/O.
//
// Standing rule (i): no closed position is dropped silently. A position the
// engine returned is one of three things, and each one is shown:
//   priced             — every deposit and withdrawal leg has a USD value; it
//                        is a normal Closed row and is in Capital G/L.
//   not-priced         — a leg has no USD value (a token with no historical
//                        price and no pool price to reach it through). It is a
//                        row marked "not priced" with its token amounts and
//                        whatever IS priced, and it is in NO total.
//   history-incomplete — withdrawals or fee claims but no deposit: the deposit
//                        could not be read. A row marked "history incomplete",
//                        in no total.
//
// The test is on the LEGS, not on computePositionPnL's verdict, because that
// engine accepts a half-priced deposit (it values the priced side only) and
// values an unpriced withdrawal at the current price, which here is 0: the first
// understates the deposit, the second shows a loss the size of the deposit.

import { computePositionPnL, type ActivityEventForPnL, type PositionPnLData } from './positionPnl';

export type UnpricedKind = 'not-priced' | 'history-incomplete';

export interface UnpricedClosedDetail {
  kind: UnpricedKind;
  /** Deposit / withdrawal / fee events with no USD value (the route's `pendingEventCount` when it gives one). */
  unpricedEvents: number;
  depositAmount0: number;
  depositAmount1: number;
  withdrawalAmount0: number;
  withdrawalAmount1: number;
  /** Sums over the events that DO have a USD value. Shown on the row, in no total. */
  pricedDepositUSD: number;
  pricedWithdrawalUSD: number;
  pricedFeesUSD: number;
  /** Why, in a few words, for the notice. */
  why: string;
}

export type ClosedVerdict =
  | { kind: 'priced'; data: PositionPnLData }
  | ({ kind: UnpricedKind } & { detail: UnpricedClosedDetail })
  /** Nothing with an amount: an empty position, not a position to show. */
  | { kind: 'empty' };

const isLeg = (e: ActivityEventForPnL) => e.type === 'deposit' || e.type === 'withdrawal';
const hasAmount = (e: ActivityEventForPnL) => e.amount0 > 0 || e.amount1 > 0;
const isFee = (e: ActivityEventForPnL) => e.type === 'fee_claim' || e.type === 'reward_claim';

export function classifyReconstructedClosed(sp: {
  events: ActivityEventForPnL[];
  pendingEventCount?: number;
}): ClosedVerdict {
  const events = sp.events ?? [];
  if (!events.some(hasAmount)) return { kind: 'empty' };

  const legs = events.filter((e) => isLeg(e) && hasAmount(e));
  const deposits = legs.filter((e) => e.type === 'deposit');
  const unpricedLegs = legs.filter((e) => e.usdAtTime == null);
  const countedUnpriced = events.filter((e) => hasAmount(e) && e.usdAtTime == null).length;

  const detail = (kind: UnpricedKind, why: string): UnpricedClosedDetail => {
    const sum = (type: string, f: (e: ActivityEventForPnL) => number) =>
      events.filter((e) => e.type === type).reduce((t, e) => t + f(e), 0);
    const usd = (e: ActivityEventForPnL) => (e.usdAtTime != null ? e.usdAtTime : 0);
    return {
      kind,
      unpricedEvents: typeof sp.pendingEventCount === 'number' ? Math.max(sp.pendingEventCount, countedUnpriced) : countedUnpriced,
      depositAmount0: sum('deposit', (e) => e.amount0),
      depositAmount1: sum('deposit', (e) => e.amount1),
      withdrawalAmount0: sum('withdrawal', (e) => e.amount0),
      withdrawalAmount1: sum('withdrawal', (e) => e.amount1),
      pricedDepositUSD: sum('deposit', usd),
      pricedWithdrawalUSD: sum('withdrawal', usd),
      pricedFeesUSD: events.filter(isFee).reduce((t, e) => t + usd(e), 0),
      why,
    };
  };

  if (deposits.length === 0) {
    return { kind: 'history-incomplete', detail: detail('history-incomplete', 'no deposit was found in its history') };
  }
  if (unpricedLegs.length > 0) {
    const d = unpricedLegs.filter((e) => e.type === 'deposit').length;
    const w = unpricedLegs.length - d;
    const parts = [d > 0 ? `${d} deposit${d === 1 ? '' : 's'}` : '', w > 0 ? `${w} withdrawal${w === 1 ? '' : 's'}` : ''].filter(Boolean);
    return { kind: 'not-priced', detail: detail('not-priced', `${parts.join(' and ')} with no price`) };
  }
  const pnl = computePositionPnL({ currentValue: 0, unclaimedFeesUSD: 0, price0: 0, price1: 0, events, isClosed: true });
  if (!pnl.ok) {
    const why = pnl.reason === 'value_overflow' ? 'its amounts give an implausible value'
      : pnl.reason === 'missing_withdrawal_prices' ? 'a withdrawal has no price'
      : pnl.reason === 'missing_deposit_prices' ? 'a deposit has no price'
      : 'it could not be valued';
    return { kind: 'not-priced', detail: detail('not-priced', why) };
  }
  return { kind: 'priced', data: pnl.data };
}
