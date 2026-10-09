import { AerodromePosition } from './aerodrome';
import { fetchPositionList } from './positionsFetch';

export type RaydiumPosition = AerodromePosition;

// Throws on a failed request (see positionsFetch.ts): a failure is not "no positions".
export function fetchRaydiumPositions(account: string): Promise<AerodromePosition[]> {
  return fetchPositionList(`/api/raydium?account=${account}`);
}
