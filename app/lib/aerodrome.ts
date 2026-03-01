export interface AerodromePosition {
  id: string;
  pair: string;
  protocol: string;
  chain: string;
  value: number;
  apy: number;
  fees: number;
  status: 'In Range' | 'Out of Range';
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

    return (data.positions || []).map((p) => ({
      id: p.id,
      pair: p.pair,
      protocol: p.protocol,
      chain: p.chain,
      value: p.value,
      apy: p.apy,
      fees: p.fees,
      status: p.status,
    }));
  } catch (error) {
    console.error('Failed to fetch Aerodrome positions:', error);
    return [];
  }
}