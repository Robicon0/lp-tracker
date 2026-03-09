import { AerodromePosition } from './aerodrome';

export async function fetchHyperSwapPositions(account: string): Promise<AerodromePosition[]> {
  try {
    const response = await fetch(`/api/hyperswap?account=${account}`);
    const data = await response.json();

    if (data.error) {
      console.error('HyperSwap API error:', data.error);
      return [];
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (data.positions || []).map((p: any): AerodromePosition => ({
      ...p,
      feeTier: p.fee,
    }));
  } catch (error) {
    console.error('Failed to fetch HyperSwap positions:', error);
    return [];
  }
}
