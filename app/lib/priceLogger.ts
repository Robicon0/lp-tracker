// app/lib/priceLogger.ts
// Structured price-lookup logger. Every line is prefixed [PRICE_LOG] for easy grep + removal.
// Server-side only. Safe to call from any route or lib function.

type Source =
  | 'sqrtPriceX96'
  | 'cg-historical-cache'
  | 'cg-historical-fetch'
  | 'cg-spot'
  | 'symbol-search'
  | 'sui-historical'
  | 'stablecoin-fixed'
  | 'unknown';

interface LookupAttempt {
  source: Source;
  token: string;       // symbol or address
  result: number | null;
  ms?: number;
  reason?: string;     // why null, if null
}

interface LookupEvent {
  event: 'price_lookup';
  caller: string;      // e.g. "aerodrome.fee_claim", "/api/prices", "v3HistoricalFeePrice"
  token: string;
  tokenAddress?: string;
  chain?: string;
  targetTimestamp?: number | 'now';
  attempts: LookupAttempt[];
  finalPrice: number | null;
  finalSource: Source | null;
  status: 'ok' | 'failed';
}

interface FeeClaimResolutionEvent {
  event: 'fee_claim_resolution';
  route: string;       // e.g. "aerodrome"
  positionId: string;
  claimId?: string;
  blockTimestamp: number;
  token0: { symbol: string; address?: string; amount: string };
  token1: { symbol: string; address?: string; amount: string };
  token0Usd: number | null;
  token1Usd: number | null;
  usdAtTime: number | null;
  status: 'ok' | 'failed_null_usdAtTime' | 'partial';
  notes?: string;
}

interface RouteSummaryEvent {
  event: 'route_summary';
  route: string;
  wallet: string;
  totalClaims: number;
  resolvedClaims: number;
  failedClaims: number;
  totalLookups: number;
  sourceBreakdown: Record<Source, number>;
  failures: Array<{ token: string; blockTimestamp: number; reason: string }>;
}

export type PriceLogEvent = LookupEvent | FeeClaimResolutionEvent | RouteSummaryEvent;

export function logPrice(event: PriceLogEvent): void {
  // Single-line JSON for grep/parse. Always server-side console.log.
  try {
    console.log('[PRICE_LOG] ' + JSON.stringify(event));
  } catch {
    // Defensive: never throw from the logger
  }
}
