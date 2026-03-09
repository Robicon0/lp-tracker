import { AerodromePosition } from './aerodrome';

export type MomentumPosition = AerodromePosition;

export async function fetchMomentumPositions(account: string): Promise<AerodromePosition[]> {
  try {
    const res = await fetch(`/api/momentum?account=${account}`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.positions || [];
  } catch {
    return [];
  }
}
