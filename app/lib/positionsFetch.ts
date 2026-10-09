// The one client fetch for a positions route.
//
// A failed request THROWS. It used to return `[]`, which is indistinguishable
// from "this wallet has no positions": the rows vanished and the totals dropped
// with nothing on screen to say why. Throwing lets the query layer do what it
// already does for a failed source — keep the last good rows, retry, and name
// the source that could not load (`failedSources`).
import type { AerodromePosition } from './aerodrome';

export async function fetchPositionList(url: string): Promise<AerodromePosition[]> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`positions request failed: HTTP ${res.status}`);
  const data = await res.json();
  return data.positions || [];
}
