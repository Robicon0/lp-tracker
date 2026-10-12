import { AerodromePosition } from './aerodrome';
import { fetchPositionsJson } from './positionsFetch';
import { applyTruncationNotices, type RouteTruncation } from './enumerationTruncation';

export type RaydiumPosition = AerodromePosition;

interface RaydiumResponse {
  positions: RaydiumPosition[];
  // Present only when pool statistics (fee APR, TVL) could not be read.
  truncated?: RouteTruncation[];
  error?: string;
}

// Throws on a failed request (see positionsFetch.ts): a failure is not "no positions".
export async function fetchRaydiumPositions(account: string): Promise<AerodromePosition[]> {
  const data = await fetchPositionsJson<RaydiumResponse>(`/api/raydium?account=${account}`);
  // Only reached on a successful response; an absent list clears an earlier notice.
  applyTruncationNotices('Raydium', account, data.truncated);
  return data.positions || [];
}
