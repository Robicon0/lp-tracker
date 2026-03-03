import { AerodromePosition } from './aerodrome';

export type BluefinPosition = AerodromePosition;

export async function fetchBluefinPositions(account: string): Promise<AerodromePosition[]> {
  try {
    const res = await fetch(`/api/bluefin?account=${account}`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.positions || [];
  } catch {
    return [];
  }
}
