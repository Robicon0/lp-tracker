import { AerodromePosition } from './aerodrome';

export type CetusPosition = AerodromePosition;

export async function fetchCetusPositions(account: string): Promise<AerodromePosition[]> {
  try {
    const res = await fetch(`/api/cetus?account=${account}`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.positions || [];
  } catch {
    return [];
  }
}
