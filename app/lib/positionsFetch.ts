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

/**
 * The same rule for a wrapper that reads more than `positions` from the body
 * (truncation notices): a non-200 or an `error` body THROWS, never an empty list.
 */
export async function fetchPositionsJson<T extends { error?: string }>(url: string): Promise<T> {
  const res = await fetch(url);
  let data: T | null = null;
  try { data = (await res.json()) as T; } catch { /* a non-JSON body is a failed request */ }
  if (!res.ok || !data || data.error) {
    throw new Error(`positions request failed: HTTP ${res.status}${data?.error ? ` (${data.error})` : ''}`);
  }
  return data;
}
