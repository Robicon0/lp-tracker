// A position route must never answer "this position is worth $0" because a READ
// FAILED.
//
// Every position route computes `value = amount0 × price0 + amount1 × price1`,
// with the amounts coming from the pool's live state. When the pool read did not
// come back, the amounts fell to 0 and the route returned a well-formed position
// worth $0.00 — and the dashboard total dropped by that position's whole value
// for one refresh, with no error anywhere. A missing price for a pinned token
// (the chain's native coin, a canonical stablecoin) did the same.
//
// A zero that comes from a failed read is not a value. The route now answers
// 503 instead, the client wrapper throws, and the page keeps the last good rows
// for that source and names the source that could not load — the existing
// behaviour for any failed positions request. A position with NO liquidity is
// worth $0 legitimately and is never flagged.
//
// A price is only treated as a failed read for PINNED tokens (tokenConstants):
// those always have a price, so 0 means the lookup failed. A long-tail token
// that genuinely has no price source keeps rendering with "price unavailable".

import { NextResponse } from 'next/server';
import { lookupHardcodedToken } from './tokenConstants';

type PinnedChain = Parameters<typeof lookupHardcodedToken>[0];

export interface PositionRead {
  id: string;
  /** The position holds liquidity (a closed / empty position is worth 0 legitimately). */
  live: boolean;
  /** The pool's live state was read. */
  poolRead: boolean;
  sides: Array<{ token: string; amount: number; price: number }>;
}

export function createPositionReadGuard(protocol: string, chain: PinnedChain) {
  const failed: Array<{ id: string; reason: string }> = [];
  return {
    check(p: PositionRead): void {
      if (!p.live) return;
      if (!p.poolRead) { failed.push({ id: p.id, reason: 'pool state not read' }); return; }
      for (const s of p.sides) {
        if (s.amount > 0 && !(s.price > 0) && lookupHardcodedToken(chain, s.token)) {
          failed.push({ id: p.id, reason: 'price not read for a pinned token' });
          return;
        }
      }
    },
    /** A 503 naming the unreadable positions, or null when every live position was read. */
    response(): NextResponse | null {
      if (failed.length === 0) return null;
      console.error(`[${protocol}] position read failed, answering 503 instead of a zero value:`, JSON.stringify(failed).slice(0, 400));
      return NextResponse.json(
        { error: 'position-read-failed', protocol, unreadable: failed },
        { status: 503 },
      );
    },
  };
}
