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

export async function fetchUniswapV3Positions(account: string): Promise<UniswapPosition[]> {
  void checkUnsupportedUniswap(account);
  try {
    const data = await fetchPositionsJson<UniswapResponse>(`/api/uniswap/v3?account=${account}`);

    // Label MUST match PositionsContext's source label so the banner names the
    // same source the user sees elsewhere.
    applyTruncationNotices('Uniswap V3', account, data.truncated);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (data.positions || []).map((p: any): UniswapPosition => ({
      ...p,
      feeTier: p.fee, // API returns fee tier as `fee` (e.g. 0.3 = 0.3%)
    }));
  } catch (error) {
    console.error('Failed to fetch Uniswap V3 positions:', error);
    // A failed request is not "no positions" (positionsFetch.ts): the page keeps the last good rows.
    throw error;
  }
}