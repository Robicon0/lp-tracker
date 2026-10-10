import { fetchPositionsJson } from './positionsFetch';
import { AerodromePosition } from './aerodrome';
import { applyTruncationNotices, type RouteTruncation } from './enumerationTruncation';

export type VelodromePosition = AerodromePosition;

interface VelodromeResponse {
  positions: VelodromePosition[];
  // Queue item C Phase 1 — present only when an enumeration cap bound.
  truncated?: RouteTruncation[];
  error?: string;
}

export async function fetchVelodromePositions(account: string): Promise<VelodromePosition[]> {
  try {
    const data = await fetchPositionsJson<VelodromeResponse>(`/api/velodrome?account=${account}`);

    // Record (or clear) the truncation notice for this source+wallet. Only
    // reached on a SUCCESSFUL response — a failed fetch must never be read as
    // evidence that the enumeration was complete.
    applyTruncationNotices('Velodrome', account, data.truncated);

    return (data.positions || []).map((p) => ({ ...p }));
  } catch (error) {
    console.error('Failed to fetch Velodrome positions:', error);
    // A failed request is not "no positions" (positionsFetch.ts): the page keeps the last good rows.
    throw error;
  }
}