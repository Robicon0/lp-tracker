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
  // Persistent historical-price cache tier (Upstash Redis, Sprint 1.6).
  // Sits ABOVE cg-historical-* — a redis-cache-hit means CoinGecko was never
  // called. redis-cache-miss is emitted by cgPriceHistory before it falls
  // through to the in-process cache + CoinGecko; redis-cache-error means the
  // Redis lookup failed and was treated as a miss. See app/lib/redisPriceCache.ts.
  | 'redis-cache-hit'
  | 'redis-cache-miss'
  | 'redis-cache-error'
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
  // Persistent-cache (Upstash Redis, Sprint 1.6) hit/miss counts for this
  // invocation, computed as a snapshot delta around the route's work. Optional:
  // only routes that resolve CoinGecko historical prices via cgPriceHistory
  // populate them (the Sui/Solana routes that emit route_summary omit them).
  // The hit rate hits/(hits+misses) is the Sprint 1.6 success metric. Counts
  // are approximate per-route under concurrent load (the delta absorbs other
  // routes' lookups too); the process-wide rate is exact.
  redis_cache_hits?: number;
  redis_cache_misses?: number;
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
  // 'redis-cache' (Sprint 1.14): a CLOSED position's immutable deposit logs were
  // served from the persistent Upstash cache (depositHistoryCache.ts) without
  // touching Etherscan/archive — so a throttled Etherscan can no longer drop the
  // deposit. Written once on the first complete (>=1 deposit) live success.
  tier_used: 'etherscan-v2' | 'chainstack-archive' | 'redis-cache' | 'client-fallback' | 'none';
  result: 'success' | 'failure';
  latency_ms: number;
  events_count: number; // deposit events retrieved (0 is a valid success)
  error_reason?: string; // present only on failure
}

// Emitted when a CLMM pending-fee calculation detects a u128 underflow in
// (feeGrowthInside − checkpoint) and guards it to 0 (Sprint 1.7). For an
// out-of-range position the recomputed feeGrowthInside can land marginally
// below the stored checkpoint; the unsigned masked subtraction then wraps into
// the upper half of u128 (~2^128) instead of producing a small negative, which
// — unguarded — yields implausible (sextillion-scale) USD fees. One event per
// affected token side. Lets us measure how often the guard fires in production.
interface FeeUnderflowEvent {
  event: 'fee_underflow_detected';
  protocol: string;     // e.g. "orca"
  chain: string;        // e.g. "solana"
  positionId: string;
  pair: string;         // e.g. "ZEC / USDC"
  side: 'token0' | 'token1';
  raw_wrapped_value: string;  // the wrapped u128 delta (bigint as decimal string)
  status: 'guarded_to_zero';
}

// Belt-and-suspenders route-boundary guard (Sprint 1.7). Even with the
// per-side underflow guard above, if a position's total USD fees still exceed a
// plausibility ceiling (no real LP position approaches $1e12 in fees), the
// position's fees are zeroed in the response rather than poisoning
// dashboard/analytics totals, and the event is surfaced for analysis. Catches
// any future overflow class the underflow guard doesn't anticipate.
interface FeePlausibilityEvent {
  event: 'fee_plausibility_exceeded';
  protocol: string;     // e.g. "orca"
  chain: string;        // e.g. "solana"
  positionId: string;
  pair: string;
  fees_usd: number;     // the implausible value that was rejected
  status: 'zeroed';
}

// Emitted once per CLMM tick-array account read, recording which decoder format
// answered (Sprint 1.7d). Orca ships two on-chain tick-array account formats:
// the legacy fixed 9956-byte `TickArray` and the newer variable-length
// `DynamicTickArray` (resizes with initialized ticks). A decoder that only
// handles the legacy format silently reads 0 for dynamic accounts → feeGrowthInside
// collapses to 0 → the Sprint 1.7 underflow guard fires as a false positive,
// masking real pending fees. This event lets us see which format each position's
// tick arrays use in production.
interface TickDecoderUsedEvent {
  event: 'tick_decoder_used';
  protocol: string;        // e.g. "orca"
  chain: string;           // e.g. "solana"
  positionId: string;
  tickArrayAddress: string;
  format: 'legacy_fixed' | 'variable_length';
}

// Emitted when a CLMM tick-array account matches NEITHER known format (Sprint
// 1.7d). Returns 0 fee growth (existing fallback) but surfaces the unknown
// discriminator + size so a new format can be added in a follow-up sprint.
interface UnsupportedTickArrayFormatEvent {
  event: 'unsupported_tick_array_format';
  protocol: string;
  chain: string;
  positionId: string;
  tickArrayAddress: string;
  discriminator: string;   // comma-joined first-8 bytes
  account_size: number;
}

// Emitted once per Cetus position whose pending fees were successfully computed
// (Sprint 1.8). Cetus stores per-position fee state in the pool's
// position_manager LinkedTable + tick_manager SkipList (not on the position
// object), so computing pending fees requires extra dynamic-field reads. This
// event lets us measure ongoing health of that computation in production.
interface CetusPendingFeeComputedEvent {
  event: 'cetus_pending_fee_computed';
  positionId: string;
  poolId: string;
  pending_token0_raw: string;  // bigint as decimal string
  pending_token1_raw: string;
  pending_usd_total: number;
  // Sprint POSITION-DETAIL (additive): reward tokens with a non-zero pending
  // amount for this position (Contract invariant (k) observability).
  pending_reward_count?: number;
}

// Emitted when a Cetus pending-fee read fails (Sprint 1.8) — the route falls
// back to the pre-fix $0 display for that position (honest: it's what the user
// saw before) and surfaces the failure so we can monitor failure rate.
interface CetusPendingFeeReadFailedEvent {
  event: 'cetus_pending_fee_read_failed';
  positionId: string;
  poolId: string;
  reason: 'position_info_missing' | 'tick_lower_mismatch' | 'tick_upper_mismatch' | 'rpc_error';
}

// Emitted once per token-identity resolution by app/lib/tokenResolver.ts
// (Sprint 1.10). `source` records which tier of the resolver cascade answered;
// `priceable` is true iff a CoinGecko id was discovered (stablecoins carry a
// cgId, so they are priceable). Lets us monitor, in production, how the
// platform-wide resolver is performing — what fraction of tokens resolve via
// the hardcoded constants vs CoinGecko contract vs on-chain symbol search, and
// how long cold-cache discovery takes. `identifier` is the NORMALIZED on-chain
// id (lowercased EVM addr / base58 mint / normalized Sui type).
interface TokenResolverUsedEvent {
  event: 'token_resolver_used';
  chain: string;
  identifier: string;
  source:
    | 'redis-cache'
    | 'hardcoded-constant'
    | 'cg-contract'
    | 'onchain-symbol-search'
    | 'defillama'
    | 'unresolvable';
  priceable: boolean;
  cgId: string | null;
  symbol: string;
  decimals: number;
  latencyMs: number;
}

// Emitted when the resolver could NOT discover a CoinGecko id for a token
// (Sprint 1.10). The token still renders with correct on-chain symbol/decimals
// (Option A: amount visible, "price unavailable"), so this is NOT a crash — it
// is a discoverability gap to monitor. Should be RARE; any cluster of these for
// a given chain warrants investigation (e.g. a CoinGecko platform regression).
interface TokenResolutionFailedEvent {
  event: 'token_resolution_failed';
  chain: string;
  identifier: string;
  lastSourceTried: string; // 'defillama' (exists upstream, not yet priced) | 'unresolvable'
  symbol: string;
  decimals: number;
}

// DeFiLlama historical-by-contract claim pricing (Sprint 1.12). A SECONDARY
// claim-date historical source consulted ONLY when CoinGecko historical has no
// usable price for a claim token (cold cache, or a token CoinGecko can't price
// historically). Rule 1a is preserved: this uses the DeFiLlama HISTORICAL
// endpoint with the claim's OWN timestamp — NEVER current/spot. Events:
//   _used    = a claim-date price was found (rescued a claim CoinGecko missed)
//   _missing = DeFiLlama has no data for that contract+date → claim stays
//              pending (correct — never spot-valued). Negative-cached.
//   _error   = transient fetch/parse/5xx failure → NOT negative-cached, retried
//              next request. Should be rare; a cluster warrants investigation.
interface DefillamaHistoricalUsedEvent {
  event: 'defillama_historical_used';
  chain: string;
  contract: string;
  date: string;        // YYYYMMDD (UTC) the price is for
  price: number;
  latencyMs: number;
}
interface DefillamaHistoricalMissingEvent {
  event: 'defillama_historical_missing';
  chain: string;
  contract: string;
  date: string;
}
interface DefillamaHistoricalErrorEvent {
  event: 'defillama_historical_error';
  chain: string;
  contract: string;
  date: string;
  reason: string;
}

// Emitted once per CLOSED Sui position valued by app/lib/suiClosedPositions.ts
// (Sprint 2.2b). A closed Sui position's object is destroyed on close, so its
// Capital G/L is reconstructed from wallet-tx-history events and valued by the
// historical cascade (stablecoin $1 → event-embedded sqrtPrice (block price, NOT
// spot) → DeFiLlama historical → CoinGecko historical → pending). `sourceBreakdown`
// keys are the cascade tiers used across the position's events; `cg-spot` MUST
// NEVER appear (Rule 1a). `pendingEventCount` > 0 means some event could not be
// priced historically and was left out (surfaced to the user, never spot-valued).
interface SuiClosedPositionValuedEvent {
  event: 'sui_closed_position_valued';
  protocol: string;            // cetus | bluefin
  positionId: string;
  pair: string;
  depositUSD: number;
  withdrawalUSD: number;
  feesUSD: number;
  capitalGL: number;           // withdrawalUSD − depositUSD (Rule 4; NO fees)
  pendingEventCount: number;
  sourceBreakdown: Record<string, number>;
}

// Sprint 3-FREE — emitted once per CLOSED Solana (Orca) position valued by
// app/lib/solanaClosedPositions.ts. A closed Solana CLMM position's NFT is
// BURNED on close, so it's reconstructed from wallet tx history (scanned via
// the free Alchemy endpoint) and valued historical-only (DeFiLlama-by-mint →
// CoinGecko-historical → pending; stable $1; NEVER spot, Rule 1a) using the
// REAL on-chain mints (invariant i). Mirrors sui_closed_position_valued.
// sourceBreakdown keys are cascade tiers: stablecoin-fixed | defillama-historical
// | cg-historical | pending | zero_amount. `cg-spot`/any spot tier MUST NEVER appear.
interface SolanaClosedPositionValuedEvent {
  event: 'solana_closed_position_valued';
  protocol: string;            // orca | raydium
  positionId: string;          // position PDA (["position", nftMint] under the protocol's program)
  pair: string;
  depositUSD: number;
  withdrawalUSD: number;
  feesUSD: number;
  capitalGL: number;           // withdrawalUSD − depositUSD (Rule 4; NO fees)
  pendingEventCount: number;
  sourceBreakdown: Record<string, number>;
}

// Emitted once per activity-route invocation by the shared server-side cache
// (Sprint 1.13, app/lib/activityRouteCache.ts). The analytics page fetches each
// position's activity route 2-3x (useAllPositionsActivity + useLpPnl +
// useWalletLevelFees), and the routes had NO server-side cache — so on a cold
// instance the expensive deposit scan + CoinGecko-historical work ran 2-3x per
// position. This event reports which path served the request:
//   miss  = computed fresh (the expensive path; cached for next time)
//   dedup = an identical request was already in flight; awaited it instead of
//           recomputing (the dominant cold-load win — collapses the simultaneous
//           multi-hook burst into ONE computation)
//   hit   = served from the TTL result cache (5m success / 60s empty)
// `status` distribution over a cold load is the production-observable metric:
// dedup+hit / total is the fraction of redundant route work eliminated.
interface ActivityCacheEvent {
  event: 'activity_cache';
  route: string;   // route pathname, e.g. "/api/hyperswap/activity"
  status: 'hit' | 'dedup' | 'miss';
  ms?: number;     // time spent serving (compute time for miss; wait time for dedup)
}

export type PriceLogEvent =
  | LookupEvent
  | ActivityCacheEvent
  | FeeClaimResolutionEvent
  | RouteSummaryEvent
  | DepositRetrievalEvent
  | FeeUnderflowEvent
  | FeePlausibilityEvent
  | TickDecoderUsedEvent
  | UnsupportedTickArrayFormatEvent
  | CetusPendingFeeComputedEvent
  | CetusPendingFeeReadFailedEvent
  | TokenResolverUsedEvent
  | TokenResolutionFailedEvent
  | SuiClosedPositionValuedEvent
  | SolanaClosedPositionValuedEvent
  | DefillamaHistoricalUsedEvent
  | DefillamaHistoricalMissingEvent
  | DefillamaHistoricalErrorEvent;

export function logPrice(event: PriceLogEvent): void {
  // Single-line JSON for grep/parse. Always server-side console.log.
  try {
    console.log('[PRICE_LOG] ' + JSON.stringify(event));
  } catch {
    // Defensive: never throw from the logger
  }
}
