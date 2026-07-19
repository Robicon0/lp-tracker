import { AerodromePosition } from './aerodrome';

// DefiTuna (Solana) — wrapper protocol over Orca (Sprint WRAPPER-PROTOCOLS).
// Positions are leveraged; `value` is EQUITY (total − debt) and
// `selfReportedPnl` carries the deposited-collateral basis (see the route).
export async function fetchDefiTunaPositions(account: string): Promise<AerodromePosition[]> {
  try {
    const res = await fetch(`/api/defituna?account=${account}`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.positions || [];
  } catch {
    return [];
  }
}
