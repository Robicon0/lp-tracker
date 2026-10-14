import { AerodromePosition } from './aerodrome';
import { fetchPositionsJson } from './positionsFetch';
import { applyTruncationNotices, type RouteTruncation } from './enumerationTruncation';

export type OrcaPosition = AerodromePosition;

interface OrcaResponse {
  positions: OrcaPosition[];
  // Present only when pool statistics (fee APR, TVL) could not be read.
  truncated?: RouteTruncation[];
  error?: string;
}

// Throws on a failed request (see positionsFetch.ts): a failure is not "no positions".
export async function fetchOrcaPositions(account: string): Promise<AerodromePosition[]> {
  const data = await fetchPositionsJson<OrcaResponse>(`/api/orca?account=${account}`);
  // Only reached on a successful response; an absent list clears an earlier notice.
  applyTruncationNotices('Orca', account, data.truncated);
  return data.positions || [];
}
