import { AerodromePosition } from './aerodrome';
import { fetchPositionList } from './positionsFetch';

export type OrcaPosition = AerodromePosition;

// Throws on a failed request (see positionsFetch.ts): a failure is not "no positions".
export function fetchOrcaPositions(account: string): Promise<AerodromePosition[]> {
  return fetchPositionList(`/api/orca?account=${account}`);
}
