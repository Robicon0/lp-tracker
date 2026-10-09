// Size limit for a closed-position response, shared by the Sui and Solana routes.
//
// A closed position carries its events, about 1.4 KB each on the wire, and a
// function response is limited to 4.5 MB. A wallet with several thousand closed
// positions (a re-ranging bot) would exceed that and fail with no body at all —
// an error instead of an answer. So the response carries the most recently
// closed positions up to the limit and SAYS how many there are in total.

import type { RouteTruncation } from './enumerationTruncation';

export const MAX_CLOSED_POSITIONS_RETURNED = 2_500;

export function capClosedPositions<T>(
  all: T[],
  closedTsOf: (p: T) => number,
  max: number = MAX_CLOSED_POSITIONS_RETURNED,
): { positions: T[]; notice: RouteTruncation | null } {
  if (all.length <= max) return { positions: all, notice: null };
  const positions = [...all].sort((a, b) => closedTsOf(b) - closedTsOf(a)).slice(0, max);
  return {
    positions,
    notice: { scope: 'closed positions', cap: max, returned: positions.length, knownTotal: all.length, reason: 'response-cap' },
  };
}
