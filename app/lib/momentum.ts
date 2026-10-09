import { AerodromePosition } from './aerodrome';
import { fetchPositionList } from './positionsFetch';

export type MomentumPosition = AerodromePosition;

// Throws on a failed request (see positionsFetch.ts): a failure is not "no positions".
export function fetchMomentumPositions(account: string): Promise<AerodromePosition[]> {
  return fetchPositionList(`/api/momentum?account=${account}`);
}
