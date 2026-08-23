import { applyTruncationNotices, type RouteTruncation } from './enumerationTruncation';
export interface AerodromePosition {
  id: string;
  pair: string;
  protocol: string;
  chain: string;
  value: number;
  apy: number;
  fees: number;
  status: 'In Range' | 'Out of Range' | 'Closed';
  // Wrapper protocols (DefiTuna etc., Sprint WRAPPER-PROTOCOLS): the managing
  // protocol's own API reports the position's P&L basis directly — the user's
  // deposited collateral (USD) and open date. When present, useLpPnl builds
  // this position's PositionPnLData from these self-reported figures instead
  // of fetching an activity route (none exists — the wrapper holds the
  // underlying LP position in its vault). `value` on such positions is EQUITY
  // (total − debt), never the raw LP total; `fees` is pending yield.
  selfReportedPnl?: { initialValueUSD: number; openedTs?: number };
  // Wrapper-protocol DISPLAY metadata (Sprint WRAPPER-PROTOCOLS Phase 2 Part 1).
  // Purely presentational — every figure here is passed through verbatim from
  // the managing protocol's API and NOTHING in the P&L pipeline reads it.
  // `value`/`fees`/`selfReportedPnl` remain the sole valuation inputs, so a
  // wrapper position's totals are identical with or without this field.
  // Prices (entry/liquidation/current) are quoted in token B per token A, the
  // convention the wrapper's own UI uses. `liquidationLower`/`liquidationUpper`
  // are 0 when that side cannot liquidate — render as "n/a", never as "$0.00".
  wrapperMeta?: {
    protocolName: string;        // e.g. "DefiTuna" — for labelling the panel
    leverage?: number;           // e.g. 3.91 → "3.91×"
    entryPrice?: number;
    currentPrice?: number;       // pool price at fetch time (same units as entry)
    liquidationLower?: number;   // 0 ⇒ not applicable
    liquidationUpper?: number;   // 0 ⇒ not applicable
    debtUSD?: number;            // current debt incl. accrued interest
    collateralUSD?: number;      // user-deposited collateral
    totalUSD?: number;           // gross LP value (equity + debt)
    pendingYieldUSD?: number;    // uncollected yield
    state?: string;              // Normal | Liquidated | ClosedByLimitOrder
  };
  // Optional enriched fields present on CLMM positions
  amount0?: number;
  amount1?: number;
  token0Symbol?: string;
  token1Symbol?: string;
  fees0?: number;
  fees1?: number;
  tickLower?: number;
  tickUpper?: number;
  feeTier?: number; // fee percentage e.g. 0.3 means 0.3%
  token0Decimals?: number;
  token1Decimals?: number;
  liquidity?: string;
  price0?: number;
  price1?: number;
  token0Address?: string;
  token1Address?: string;
  coinTypeA?: string;
  coinTypeB?: string;
  walletAddress?: string;
  // Pool-level statistics (optional — populated when available from DefiLlama)
  poolTvl?: number;
  pool24hVolume?: number;
  // On-chain pool address — used to query observe() for historical prices.
  // Populated by EVM V3-style routes (Uniswap V3, Aerodrome CL, Velodrome CL,
  // HyperSwap/KittenSwap/PRJX, PancakeSwap). Absent for non-V3 protocols.
  poolAddress?: string;
  // Sprint POSITION-DETAIL — pending (unclaimed) REWARD EMISSIONS, separate from
  // trading fees (fees/fees0/fees1 stay fees-only so analytics aggregation is
  // untouched). Read from on-chain rewarder state per position (Protocol
  // Correctness Contract invariant (k)): the position-detail Uncollected panel
  // folds these into its total so it matches the protocol's own claimable UI.
  // Valued at CURRENT SPOT (Rule 2 current-value domain, same as uncollected
  // fees). Absent/empty when the pool has no active rewarders.
  pendingRewards?: Array<{ symbol: string; coinType: string; amount: number; usd: number }>;
  rewardsUsd?: number;
}

interface AerodromeResponse {
  positions: AerodromePosition[];
  count: number;
  account: string;
  // Queue item C Phase 1 — present only when an enumeration cap bound.
  truncated?: RouteTruncation[];
  error?: string;
}

export async function fetchAerodromePositions(account: string): Promise<AerodromePosition[]> {
  try {
    const response = await fetch(`/api/aerodrome?account=${account}`);
    const data: AerodromeResponse = await response.json();

    if (data.error) {
      console.error('Aerodrome API error:', data.error);
      return [];
    }

    // Record (or clear) the truncation notice for this source+wallet. Only
    // reached on a SUCCESSFUL response — a failed fetch must never be read as
    // evidence that the enumeration was complete.
    applyTruncationNotices('Aerodrome', account, data.truncated);

    return (data.positions || []).map((p: AerodromePosition) => ({ ...p }));
  } catch (error) {
    console.error('Failed to fetch Aerodrome positions:', error);
    return [];
  }
}