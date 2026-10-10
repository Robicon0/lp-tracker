import { AerodromePosition } from './aerodrome';
import { fetchPositionList } from './positionsFetch';

// DefiTuna (Solana) — wrapper protocol over Orca (Sprint WRAPPER-PROTOCOLS).
// Positions are leveraged; `value` is EQUITY (total − debt) and
// `selfReportedPnl` carries the deposited-collateral basis (see the route).
//
// A failed request THROWS (positionsFetch.ts): the route answers 502 when the
// DefiTuna API cannot be read, and that is not "this wallet has no positions".
export async function fetchDefiTunaPositions(account: string): Promise<AerodromePosition[]> {
  return fetchPositionList(`/api/defituna?account=${account}`);
}
