import { fetchPositionsJson } from './positionsFetch';
import { AerodromePosition } from './aerodrome';

export async function fetchPancakeSwapPositions(account: string): Promise<AerodromePosition[]> {
  try {
    const data = await fetchPositionsJson<{ positions?: Array<AerodromePosition & { fee?: number }>; error?: string }>(`/api/pancakeswap?account=${account}`);
    return (data.positions || []).map((p: AerodromePosition & { fee?: number }) => ({
      ...p,
      feeTier: p.fee,
    }));
  } catch (error) {
    console.error('Failed to fetch PancakeSwap positions:', error);
    // A failed request is not "no positions" (positionsFetch.ts): the page keeps the last good rows.
    throw error;
  }
}
