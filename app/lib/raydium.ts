import { AerodromePosition } from './aerodrome';

export type RaydiumPosition = AerodromePosition;

export async function fetchRaydiumPositions(account: string): Promise<AerodromePosition[]> {
  try {
    const res = await fetch(`/api/raydium?account=${account}`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.positions || [];
  } catch {
    return [];
  }
}
