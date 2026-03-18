export interface AerodromePosition {
  id: string;
  pair: string;
  protocol: string;
  chain: string;
  value: number;
  apy: number;
  fees: number;
  status: 'In Range' | 'Out of Range' | 'Closed';
  // Optional enriched fields present on CLMM positions
  amount0?: number;
  amount1?: number;
  token0Symbol?: string;
  token1Symbol?: string;
  fees0?: number;
  fees1?: number;
  tickLower?: number;
  tickUpper?: number;
  feeTier?: number; // fee percentage e.g. 0.3 means 0.3%
  token0Decimals?: number;
  token1Decimals?: number;
  liquidity?: string;
  price0?: number;
  price1?: number;
  token0Address?: string;
  token1Address?: string;
  walletAddress?: string;
}

interface AerodromeResponse {
  positions: AerodromePosition[];
  count: number;
  account: string;
  error?: string;
}

export async function fetchAerodromePositions(account: string): Promise<AerodromePosition[]> {
  try {
    const response = await fetch(`/api/aerodrome?account=${account}`);
    const data: AerodromeResponse = await response.json();

    if (data.error) {
      console.error('Aerodrome API error:', data.error);
      return [];
    }

    return (data.positions || []).map((p: AerodromePosition) => ({ ...p }));
  } catch (error) {
    console.error('Failed to fetch Aerodrome positions:', error);
    return [];
  }
}