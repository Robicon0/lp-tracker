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
  // Deposit-history retrieval tiers (HyperEVM activity route). Distinct from
  // price-resolution sources above — they describe which log source answered.
  | 'etherscan-v2-success'
  | 'etherscan-v2-failure'
  | 'chainstack-archive-success'
  | 'chainstack-archive-failure'
  | 'client-fallback'
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
  // Deposit-history retrieval outcome for this invocation. Optional so the
  // other activity routes that emit route_summary remain unaffected; populated
  // only by the HyperEVM activity route, where deposit retrieval can fail.
  deposits_total?: number;
  deposits_resolved?: number;
  deposits_failed?: number;
  // True iff EVERY fee claim for this position resolved via a historical
  // source (cg-historical-cache / sqrtPriceX96 / stablecoin-fixed) — i.e.
  // zero claims fell through to the "unknown" bucket. False means at least
  // one claim is unresolved (historical price unavailable). Current spot is
  // NEVER used for fee claims (pricing-invariants Rule 1), so a false here
  // signals claims the user should see as "pending price resolution" rather
  // than mis-valued at spot. Production-observable metric for verifying the
  // claim-pricing fix at scale. Optional/HyperEVM-route-only, like the
  // deposits_* fields above. (Lives here, not on deposit_retrieval, because
  // deposit_retrieval is emitted before pricing runs.)
  claim_pricing_succeeded?: boolean;
}

// Emitted once per position per HyperEVM activity-route invocation. Captures
// which tier of the 3-tier deposit-history fallback answered (or that all
// failed), so deposit-retrieval success rate is measurable independently of
// fee-claim pricing. tier_used "client-fallback" is reserved for the consumer
// layer (buildFallbackPnL in useLpPnl.ts); this route emits "none" on total
// failure, which is what triggers that client-side fallback.
interface DepositRetrievalEvent {
  event: 'deposit_retrieval';
  protocol: string;     // projectx | hyperswap | kittenswap
  chain: string;        // "hyperevm"
  position_id: string;  // NFT tokenId / position identifier
  tier_used: 'etherscan-v2' | 'chainstack-archive' | 'client-fallback' | 'none';
  result: 'success' | 'failure';
  latency_ms: number;
  events_count: number; // deposit events retrieved (0 is a valid success)
  error_reason?: string; // present only on failure
}

export type PriceLogEvent =
  | LookupEvent
  | FeeClaimResolutionEvent
  | RouteSummaryEvent
  | DepositRetrievalEvent;

export function logPrice(event: PriceLogEvent): void {
  // Single-line JSON for grep/parse. Always server-side console.log.
  try {
    console.log('[PRICE_LOG] ' + JSON.stringify(event));
  } catch {
    // Defensive: never throw from the logger
  }
}
