import { AerodromePosition } from './aerodrome';
import { fetchPositionList } from './positionsFetch';

export type CetusPosition = AerodromePosition;

// Throws on a failed request (see positionsFetch.ts): a failure is not "no positions".
export function fetchCetusPositions(account: string): Promise<AerodromePosition[]> {
  return fetchPositionList(`/api/cetus?account=${account}`);
}
