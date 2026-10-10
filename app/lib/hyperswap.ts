import { fetchPositionsJson } from './positionsFetch';
import { AerodromePosition } from './aerodrome';
import { applyTruncationNotices, type RouteTruncation } from './enumerationTruncation';

export async function fetchHyperSwapPositions(account: string): Promise<AerodromePosition[]> {
  try {
    const data = await fetchPositionsJson<{ positions?: Array<AerodromePosition & { fee?: number }>; truncated?: RouteTruncation[]; error?: string }>(`/api/hyperswap?account=${account}`);

    applyTruncationNotices('HyperEVM', account, data.truncated as RouteTruncation[] | undefined);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (data.positions || []).map((p: any): AerodromePosition => ({
      ...p,
      feeTier: p.fee,
    }));
  } catch (error) {
    console.error('Failed to fetch HyperSwap positions:', error);
    // A failed request is not "no positions" (positionsFetch.ts): the page keeps the last good rows.
    throw error;
  }
}
