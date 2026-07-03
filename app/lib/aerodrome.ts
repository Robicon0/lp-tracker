export interface AerodromePosition {
  id: string;
  pair: string;
  protocol: string;
  chain: string;
  value: number;
  apy: number;
  fees: number;
  status: 'In Range' | 'Out of Range' | 'Closed';
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

    return (data.positions || []).map((p: AerodromePosition) => ({ ...p }));
  } catch (error) {
    console.error('Failed to fetch Aerodrome positions:', error);
    return [];
  }
}