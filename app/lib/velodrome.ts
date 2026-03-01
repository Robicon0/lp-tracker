import { AerodromePosition } from './aerodrome';

export type VelodromePosition = AerodromePosition;

interface VelodromeResponse {
  positions: VelodromePosition[];
  error?: string;
}

export async function fetchVelodromePositions(account: string): Promise<VelodromePosition[]> {
  try {
    const response = await fetch(`/api/velodrome?account=${account}`);
    const data: VelodromeResponse = await response.json();

    if (data.error) {
      console.error('Velodrome API error:', data.error);
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
    console.error('Failed to fetch Velodrome positions:', error);
    return [];
  }
}