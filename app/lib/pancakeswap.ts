import { AerodromePosition } from './aerodrome';

export async function fetchPancakeSwapPositions(account: string): Promise<AerodromePosition[]> {
  try {
    const res = await fetch(`/api/pancakeswap?account=${account}`);
    const data = await res.json();
    if (data.error) {
      console.error('PancakeSwap API error:', data.error);
      return [];
    }
    return (data.positions || []).map((p: AerodromePosition & { fee?: number }) => ({
      ...p,
      feeTier: p.fee,
    }));
  } catch (err) {
    console.error('Failed to fetch PancakeSwap positions:', err);
    return [];
  }
}
