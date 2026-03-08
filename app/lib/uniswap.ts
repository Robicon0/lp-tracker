import { AerodromePosition } from './aerodrome';

// Reuse the same interface — works for any protocol
export type UniswapPosition = AerodromePosition;

interface UniswapResponse {
  positions: UniswapPosition[];
  count: number;
  account: string;
  chains: string[];
  error?: string;
}

export async function fetchUniswapV3Positions(account: string): Promise<UniswapPosition[]> {
  try {
    const response = await fetch(`/api/uniswap/v3?account=${account}`);
    const data: UniswapResponse = await response.json();

    if (data.error) {
      console.error('Uniswap V3 API error:', data.error);
      return [];
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (data.positions || []).map((p: any): UniswapPosition => ({
      ...p,
      feeTier: p.fee, // API returns fee tier as `fee` (e.g. 0.3 = 0.3%)
    }));
  } catch (error) {
    console.error('Failed to fetch Uniswap V3 positions:', error);
    return [];
  }
}