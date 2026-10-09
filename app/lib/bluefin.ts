import { AerodromePosition } from './aerodrome';
import { fetchPositionList } from './positionsFetch';

export type BluefinPosition = AerodromePosition;

// Throws on a failed request (see positionsFetch.ts): a failure is not "no positions".
export function fetchBluefinPositions(account: string): Promise<AerodromePosition[]> {
  return fetchPositionList(`/api/bluefin?account=${account}`);
}
