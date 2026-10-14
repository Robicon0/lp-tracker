import { AerodromePosition } from './aerodrome';
import { fetchPositionsJson } from './positionsFetch';
import { applyTruncationNotices, type RouteTruncation } from './enumerationTruncation';

export type CetusPosition = AerodromePosition;

interface CetusResponse {
  positions: CetusPosition[];
  // Present only when pool statistics (fee APR) are the last known copy or unavailable.
  truncated?: RouteTruncation[];
  error?: string;
}

// Throws on a failed request (see positionsFetch.ts): a failure is not "no positions".
export async function fetchCetusPositions(account: string): Promise<AerodromePosition[]> {
  const data = await fetchPositionsJson<CetusResponse>(`/api/cetus?account=${account}`);
  // Only reached on a successful response; an absent list clears an earlier notice.
  applyTruncationNotices('Cetus', account, data.truncated);
  return data.positions || [];
}
