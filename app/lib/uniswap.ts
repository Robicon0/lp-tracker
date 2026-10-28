import { fetchPositionsJson } from './positionsFetch';
import { AerodromePosition } from './aerodrome';
import { applyTruncationNotices, unsupportedUncheckedNotice, type RouteTruncation } from './enumerationTruncation';

// Reuse the same interface — works for any protocol
export type UniswapPosition = AerodromePosition;

interface UniswapResponse {
  positions: UniswapPosition[];
  count: number;
  account: string;
  chains: string[];
  // Queue item C Phase 1 — present only when an enumeration cap bound.
  truncated?: RouteTruncation[];
  error?: string;
}

/**
 * Counts the wallet's Uniswap positions DefiDesh cannot read yet (V4, chains the
 * V3 route does not scan) and shows them as a notice under the source "Uniswap".
 * Runs beside the position list and never blocks or fails it; a failed request
 * is itself a notice ("couldn't check"), never silence.
 */
async function checkUnsupportedUniswap(account: string): Promise<void> {
  try {
    const res = await fetch(`/api/uniswap/unsupported?account=${account}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { truncated?: RouteTruncation[] };
    applyTruncationNotices('Uniswap', account, data.truncated ?? []);
  } catch (error) {
    console.error('Uniswap unsupported-position check failed:', error);
    applyTruncationNotices('Uniswap', account, [unsupportedUncheckedNotice('V4 / other chains')]);
  }
}

// The route is asked for in two halves, as Aerodrome is, so the open rows never
// wait for the burned-NFT recovery's archive log scans:
//
//   fetchUniswapV3Positions        scope=open   — every position the wallet holds
//   fetchUniswapV3ClosedPositions  scope=closed — burned positions, from history
//
// Each is its own source in PositionsContext ("Uniswap V3", "Uniswap V3
// history"), so the closed half stays in `pendingSources` (totals marked) until
// it lands, and a failed half is named. Notices are keyed per half: a clean
// answer from one must not clear a notice the other raised.
async function fetchUniswapV3Scope(
  account: string,
  scope: 'open' | 'closed',
  noticeSource: string,
): Promise<UniswapPosition[]> {
  try {
    const data = await fetchPositionsJson<UniswapResponse>(`/api/uniswap/v3?account=${account}&scope=${scope}`);

    // Label MUST match PositionsContext's source label so the banner names the
    // same source the user sees elsewhere.
    applyTruncationNotices(noticeSource, account, data.truncated);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (data.positions || []).map((p: any): UniswapPosition => ({
      ...p,
      feeTier: p.fee, // API returns fee tier as `fee` (e.g. 0.3 = 0.3%)
    }));
  } catch (error) {
    console.error(`Failed to fetch Uniswap V3 positions (${scope}):`, error);
    // A failed request is not "no positions" (positionsFetch.ts): the page keeps the last good rows.
    throw error;
  }
}

export function fetchUniswapV3Positions(account: string): Promise<UniswapPosition[]> {
  void checkUnsupportedUniswap(account);
  return fetchUniswapV3Scope(account, 'open', 'Uniswap V3');
}

export function fetchUniswapV3ClosedPositions(account: string): Promise<UniswapPosition[]> {
  return fetchUniswapV3Scope(account, 'closed', 'Uniswap V3 history');
}
