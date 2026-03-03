import { AerodromePosition } from './aerodrome';

export type OrcaPosition = AerodromePosition;

export async function fetchOrcaPositions(account: string): Promise<AerodromePosition[]> {
  try {
    const res = await fetch(`/api/orca?account=${account}`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.positions || [];
  } catch {
    return [];
  }
}
