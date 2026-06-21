# Instrumentation

This file documents the `[PRICE_LOG]` structured instrumentation system —
the permanent diagnostic infrastructure that makes investigate-first
debugging possible. Every developer touching pricing or activity routes
must understand this system.

## Core principle

DefiDesh debugs by reading evidence, not by guessing. The `[PRICE_LOG]`
system emits structured JSON events to stdout during route execution.
These events are captured, grepped, and analyzed before any fix is written.
The system is the single source of truth for what actually happened during
a request.

---

## Rule 1: All instrumentation lives in priceLogger.ts

The instrumentation module is `app/lib/priceLogger.ts`. All emit calls go
through this module. Inline `console.log` statements scattered across
activity routes are forbidden as a long-term pattern — if you need to log
something repeatedly, add it to priceLogger.ts with a proper event type.

### Why a central module
- Consistent JSON structure makes grep-based analysis reliable
- Adding fields or refactoring is a one-file change instead of
  hundreds of inline edits
- Event type discoverability — a new contributor reads priceLogger.ts and
  learns what's tracked

---

## Rule 2: Event schemas

The system emits five event types. Each has a fixed JSON shape.

### `price_lookup`
Emitted when a price is resolved for a token at a specific time.

Required fields:
- `event: "price_lookup"`
- `token` — the token symbol or address being priced
- `chain` — the chain identifier
- `timestamp` — the time the price is for (ISO 8601 or Unix seconds)
- `source` — see source enum below
- `price` — the resolved USD price, or null if unresolved
- `latency_ms` — how long the resolution took

### `fee_claim_resolution`
Emitted when a fee claim is valued in USD.

Required fields:
- `event: "fee_claim_resolution"`
- `protocol` — the protocol the claim is from
- `chain` — the chain identifier
- `position_id` — the NFT ID or position identifier
- `claim_timestamp` — when the claim happened
- `token_a` and `token_b` — token symbols/addresses
- `amount_a` and `amount_b` — raw token amounts
- `price_a` and `price_b` — USD prices used
- `usd_value` — final USD valuation
- `source_a` and `source_b` — pricing source for each token

### `route_summary`
Emitted once per activity route invocation, summarizing the whole run.

Required fields:
- `event: "route_summary"`
- `route` — the route path (e.g., `/api/activity/cetus`)
- `wallet` — the wallet address being queried
- `chain` — the chain identifier
- `total_positions` — how many positions were discovered
- `resolved_positions` — how many were successfully priced
- `failed_positions` — how many failed to price
- `duration_ms` — total route execution time

The ratio `resolved_positions / total_positions` is the primary
verification metric used in fix prompts. Target is always 100%.

The HyperEVM activity route additionally sets three optional deposit-retrieval
fields on its `route_summary` (one position per invocation, so each is 0 or 1):

- `deposits_total` — positions whose deposit history was attempted
- `deposits_resolved` — positions that retrieved deposit history successfully
- `deposits_failed` — positions that failed all in-route tiers

These are optional and only emitted by the HyperEVM route; other routes that
emit `route_summary` omit them.

The five EVM activity routes that resolve CoinGecko historical prices through
`cgPriceHistory` (aerodrome, velodrome, uniswap, pancakeswap, hyperswap)
additionally set two optional persistent-cache fields (Upstash Redis, Sprint 1.6):

- `redis_cache_hits` — historical-price lookups served from Redis this invocation
- `redis_cache_misses` — lookups that missed Redis and fell through to CoinGecko

Both are computed as a snapshot delta against a baseline captured at handler
entry (the underlying counters live in `app/lib/redisPriceCache.ts` and are
process-wide). Under the parallel-route analytics load a single route's delta
also absorbs other concurrent routes' lookups, so per-route counts are
**approximate**; the process-wide hit rate `hits / (hits + misses)` — the
Sprint 1.6 success metric — is exact. Sui/Solana routes that emit
`route_summary` omit both fields (they don't use `cgPriceHistory`).

### `deposit_retrieval`
Emitted once per position per HyperEVM activity-route invocation. Captures
which tier of the 3-tier deposit-history fallback answered (or that all
failed), so deposit-retrieval success rate is measurable independently of
fee-claim pricing. Emitted even when retrieval returns zero events, so total
failures are observable.

Required fields:
- `event: "deposit_retrieval"`
- `protocol` — `projectx`, `hyperswap`, or `kittenswap`
- `chain` — the chain identifier (currently always `hyperevm`)
- `position_id` — the NFT token ID / position identifier
- `tier_used` — `redis-cache`, `etherscan-v2`, `chainstack-archive`,
  `client-fallback`, or `none`. `redis-cache` (Sprint 1.14) means a CLOSED
  position's immutable deposit logs were served from the persistent
  `depositHistoryCache.ts` without touching Etherscan/archive — the steady state
  for any closed position after its first successful live retrieval. The route
  emits `none` on total live failure, which triggers the client-side
  `client-fallback` tier in `useLpPnl.ts`.
- `result` — `success` or `failure`
- `latency_ms` — retrieval time across all tiers
- `events_count` — deposit (IncreaseLiquidity) events retrieved. NOTE (Sprint
  1.14): a real position ALWAYS has ≥1 deposit, so Tier 1 now treats 0 deposit
  logs as a retrieval FAILURE (Increase topic dropped / index gap), not a valid
  empty — see `etherscan-increase-missing` below. Only an empty wallet/position
  legitimately yields 0, and such a result is never persisted to the cache.

Optional field (present only on failure):
- `error_reason` — brief technical cause, e.g. `etherscan-429`,
  `etherscan-timeout`, `archive-unconfigured`, `all-tiers-exhausted`,
  `etherscan-429-increase` / `etherscan-increase-missing` (Sprint 1.14 — the
  load-bearing IncreaseLiquidity/deposit topic was rate-limited or absent, so
  Tier 1 fails rather than returning a deposit-less "success").

Reliability note (Sprint 1.14): Tier 2 (Chainstack archive) only scans the last
`SCAN_DEPTH` (~5M) blocks — ~57 days at HyperEVM's ~1s block time — and a true
`fromBlock=0` archive query is plan-blocked (`-32002`). So Tier 2 cannot serve a
position older than ~57 days; Tier 1 (Etherscan, `fromBlock=0`) is the only live
tier for those, and `redis-cache` is what makes a once-retrieved closed position
immune to Etherscan rate-limit drops thereafter.

### `lp_pnl_position_lookup`
Emitted when a single position's P&L is calculated.

Required fields:
- `event: "lp_pnl_position_lookup"`
- `position_id`
- `protocol`
- `chain`
- `initial_value_usd`
- `current_value_usd`
- `fees_collected_usd`
- `fees_unclaimed_usd`
- `capital_gain_loss_usd`
- `impermanent_loss_usd`
- `net_pnl_usd`

### `lp_pnl_summary`
Emitted once per LP P&L route invocation across all positions.

Required fields:
- `event: "lp_pnl_summary"`
- `wallet`
- `total_positions`
- `total_initial_value_usd`
- `total_current_value_usd`
- `total_fees_collected_usd`
- `total_capital_gain_loss_usd`
- `total_net_pnl_usd`

### `tick_decoder_used`
Emitted once per CLMM tick-array account read, recording which decoder format
answered (Sprint 1.7d). Orca ships two on-chain tick-array formats — the legacy
fixed 9956-byte `TickArray` and the variable-length `DynamicTickArray` (resizes
with initialized ticks). A decoder that only handles the legacy format silently
reads 0 for dynamic accounts, collapsing `feeGrowthInside` to 0 and firing the
Sprint 1.7 underflow guard as a false positive.

Required fields:
- `event: "tick_decoder_used"`
- `protocol` — e.g. `orca`
- `chain` — e.g. `solana`
- `positionId`
- `tickArrayAddress`
- `format` — `legacy_fixed` or `variable_length`

### `unsupported_tick_array_format`
Emitted when a tick-array account matches NEITHER known format. Returns 0 fee
growth (existing fallback) and surfaces the unknown account for a follow-up
sprint. Any occurrence in production warrants investigation (a third format).

Required fields:
- `event: "unsupported_tick_array_format"`
- `protocol`, `chain`, `positionId`, `tickArrayAddress`
- `discriminator` — comma-joined first-8 bytes
- `account_size`

### `token_resolver_used`
Emitted once per token-identity resolution by `app/lib/tokenResolver.ts` (Sprint
1.10) — the shared platform-wide resolver that replaced per-route hardcoded
token maps. Lets us monitor, at scale, how the resolver performs: what fraction
of tokens resolve via the hardcoded constants vs CoinGecko contract lookup vs
on-chain symbol search, and how long cold-cache discovery takes. The `source`
here is the RESOLVER CASCADE TIER (distinct from the price-resolution `source`
enum in Rule 3).

Required fields:
- `event: "token_resolver_used"`
- `chain` — `solana` | `sui` | `hyperevm` | `ethereum` | `arbitrum` | `optimism` | `base` | `polygon`
- `identifier` — the NORMALIZED on-chain id (lowercased EVM addr / base58 mint / normalized Sui type)
- `source` — `redis-cache` | `hardcoded-constant` | `cg-contract` | `onchain-symbol-search` | `defillama` | `unresolvable`
- `priceable` — boolean; true iff a CoinGecko id was discovered (stablecoins carry a cgId, so they are priceable)
- `cgId` — the resolved CoinGecko id, or null
- `symbol` — always present (on-chain truth / fallback)
- `decimals` — always present (NEVER a blind 18 default — this is the Tier-3 fix)
- `latencyMs`

### `token_resolution_failed`
Emitted when the resolver could NOT discover a CoinGecko id for a token (Sprint
1.10). The token still renders with correct on-chain symbol + decimals (Option
A: amount visible, "price unavailable"), so this is a price DISCOVERABILITY gap,
NOT a crash. Should be RARE; a cluster of these for one chain warrants
investigation (e.g. a CoinGecko platform regression). `lastSourceTried` is
`defillama` (exists upstream, not yet priced this sprint) or `unresolvable`.

Required fields:
- `event: "token_resolution_failed"`
- `chain`
- `identifier`
- `lastSourceTried`
- `symbol`
- `decimals`

### `defillama_historical_used` / `defillama_historical_missing` / `defillama_historical_error`

Emitted by `app/lib/defillamaPriceHistory.ts` (Sprint 1.12), the SECONDARY
claim-date historical price source (CoinGecko historical is primary; see
pricing-invariants Rule 1c). DeFiLlama is keyed by on-chain contract/mint/coin
type, so it prices the long-tail CoinGecko can't map to an id. It is consulted
ONLY when CoinGecko has no usable claim-date price, and ONLY via the
`/prices/historical/{ts}/...` endpoint with the claim's own timestamp — Rule 1a
holds, current/spot is never used for a claim.

- `defillama_historical_used` — a claim-date price was found (rescued a claim
  CoinGecko missed). Fields: `chain`, `contract`, `date` (YYYYMMDD UTC), `price`,
  `latencyMs`.
- `defillama_historical_missing` — DeFiLlama has no data for that contract+date
  (404 / empty `coins` / zero price / point >24h from the claim). The claim
  stays **pending** (correct — never spot-valued). Negative-cached. Fields:
  `chain`, `contract`, `date`.
- `defillama_historical_error` — transient fetch/parse/5xx/timeout failure. NOT
  negative-cached (retried next request). Should be RARE; a cluster warrants
  investigation. Fields: `chain`, `contract`, `date`, `reason`.

Verification greps: a successful rescue shows `defillama_historical_used` with a
positive `price`; `_missing` is acceptable for genuinely-unpriceable tokens;
`_error` should not dominate. A `fee_claim_resolution` event whose `notes`
contain `source=defillama-historical` confirms a claim was valued from this
source. There is NO `defillama-current` claim path — its absence is the Rule 1a
guarantee for this source.

### `activity_cache`

Emitted once per activity-route invocation by the shared server-side cache
(Sprint 1.13, `app/lib/activityRouteCache.ts`). The analytics page fetches each
position's activity route 2-3× (useAllPositionsActivity + useLpPnl +
useWalletLevelFees), and the routes had no server-side cache — so on a cold
instance the expensive Etherscan/archive deposit scan AND the CoinGecko-historical
claim lookups ran 2-3× per position, the dominant cause of the 3-5 min cold first
load. This event reports which path served each request.

Required fields:
- `event: "activity_cache"`
- `route` — route pathname, e.g. `/api/hyperswap/activity`
- `status` — `miss` (computed fresh; cached for next time) | `dedup` (an identical
  request was already in flight; awaited it instead of recomputing — the dominant
  cold-load win, collapsing the simultaneous multi-hook burst into ONE
  computation) | `hit` (served from the TTL result cache: 5 min success / 60 s
  empty / errors never cached, per cache-versioning Rule 3)
- `ms` — time spent serving (compute time for `miss`; wait time for `dedup`)

Verification: over a cold load, `(dedup + hit) / total` is the fraction of
redundant route work eliminated. A healthy cold load shows roughly one `miss` per
unique position-URL plus `dedup`/`hit` for the redundant multi-hook refetches. A
cache HIT/dedup returns the EXACT JSON the route produced — claims still valued
claim-date-only (Rule 1a), no new CoinGecko/spot calls.

---

## Rule 3: Source enum

The `source` field in `price_lookup` and `fee_claim_resolution` events
must use one of these values:

| Source value           | Meaning                                                  |
|------------------------|----------------------------------------------------------|
| `sqrtPriceX96`         | Price derived from on-chain V3 pool sqrtPrice + tick     |
| `cg-historical-cache`  | CoinGecko historical price, returned from cache          |
| `cg-historical-fetch`  | CoinGecko historical price, fresh fetch (cold path)      |
| `cg-spot`              | CoinGecko spot price (current)                           |
| `symbol-search`        | CoinGecko symbol-to-ID lookup                            |
| `sui-historical`       | Sui-specific historical pricing path                     |
| `stablecoin-fixed`     | Hardcoded $1 for stablecoins                             |
| `redis-cache-hit`      | Historical price returned from the Upstash Redis persistent cache (Sprint 1.6, Tier 1) |
| `redis-cache-miss`     | Redis had no entry; fell through to in-process cache + CoinGecko (emitted by cgPriceHistory) |
| `redis-cache-error`    | Redis lookup failed; treated as a miss (emitted by redisPriceCache) |
| `etherscan-v2-success`       | Deposit history retrieved via Etherscan V2 (Tier 1) |
| `etherscan-v2-failure`       | Etherscan V2 deposit retrieval failed (Tier 1)      |
| `chainstack-archive-success` | Deposit history retrieved via Chainstack archive (Tier 2) |
| `chainstack-archive-failure` | Chainstack archive deposit retrieval failed (Tier 2) |
| `client-fallback`            | Deposit value synthesized client-side (Tier 3, buildFallbackPnL) |
| `unknown`              | Resolution failed or source could not be determined      |

The five deposit-retrieval values describe which **log source** answered a
HyperEVM deposit-history request; they are distinct from the price-resolution
sources above and pair with the `deposit_retrieval` event's `tier_used` field.

### Adding a new source
When a new pricing source is introduced (e.g., a paid CoinGecko key path,
or a new on-chain oracle), add it to this enum. Never use ad-hoc strings.

---

## Rule 4: Log capture

In development, the dev server prints `[PRICE_LOG]` lines to stdout. To
capture them for analysis:

```bash
# Tail dev server output to a file
npm run dev 2>&1 | tee /tmp/devserver.log

# Or, in a separate terminal, watch the log
tail -f /tmp/devserver.log | grep '\[PRICE_LOG\]'
```

In production, `[PRICE_LOG]` lines appear in Vercel's runtime logs. Filter
by the `[PRICE_LOG]` prefix to isolate diagnostic events from application
logs.

---

## Rule 5: Analysis patterns

### Verify a route's resolution rate after a fix

```bash
grep '"event":"route_summary"' /tmp/devserver.log | tail -20
```

This shows the last 20 route invocations with their resolved/total counts.
The primary verification metric for any pricing fix.

### Find all failures for a specific protocol

```bash
grep '"event":"fee_claim_resolution"' /tmp/devserver.log \
  | grep '"protocol":"cetus"' \
  | grep '"source_a":"unknown"\|"source_b":"unknown"'
```

This isolates Cetus fee claims where at least one token failed to price.
Useful for diagnosing protocol-specific resolution failures.

### Count resolution sources

```bash
grep '"event":"price_lookup"' /tmp/devserver.log \
  | grep -oE '"source":"[^"]+"' \
  | sort | uniq -c | sort -rn
```

This produces a count of how many price lookups used each source. Useful
for understanding whether a fix shifted the workload as intended (e.g.,
did adding sqrtPriceX96 fallback actually increase its usage).

### Find slow resolutions

```bash
grep '"event":"price_lookup"' /tmp/devserver.log \
  | grep -oE '"latency_ms":[0-9]+' \
  | awk -F: '$2 > 5000' \
  | wc -l
```

This counts price lookups that took longer than 5 seconds. Useful for
identifying CoinGecko rate-limit pressure or slow RPC paths.

---

## Rule 6: Verification metric for every fix

Every fix that touches pricing or position resolution must define a target
`route_summary` metric before writing the fix.

### Example targets
- "Cetus route resolves 81/81 positions after fix, was 32/78"
- "ProjectX route resolves 100% of HYPE fee claims with claim-time price"
- "Aerodrome closed-position recovery returns 4 closed positions worth
  ~$743 in fees"

After the fix is implemented, the same `route_summary` events are checked
against the target. If the actual numbers match, the fix is verified
(per commit-protocol.md Rule 2). If they don't match, see commit-protocol.md
Rule 3 (stop and report).

---

## Rule 7: Diagnostic scripts

The repo contains a reusable diagnostic script at `scripts/lp-pnl-diag.ts`
(untracked in git for now — kept locally). It performs server-side
reproduction of the `computePositionPnL` function against route data.

Use this script when:
- A regression appears in production but is hard to reproduce locally
- A specific position is showing wrong values and you need to step through
  the calculation
- You want to verify a fix against historical data before deploying

The script is reusable — copy it, modify the inputs, run it. Do not
delete it.

---

## Rule 8: What instrumentation does not do

Instrumentation observes; it does not fix. It is a diagnostic system, not
a runtime safety system.

### Examples of misuse
- Adding a `[PRICE_LOG]` emit and considering a problem "tracked"
  without actually fixing it
- Using instrumentation as the primary error-handling path (errors
  should throw or return failure values; instrumentation captures that
  failure for later analysis)
- Treating high `unknown` source counts as acceptable because they're
  "logged"

The goal is always 100% known sources and 100% resolved positions.
Instrumentation just makes it possible to see how far we are from that
goal.

---

## When to amend this file

Amend instrumentation.md when:
- A new event type is added to priceLogger.ts
- A new source enum value is added
- A new analysis pattern proves useful enough to standardize
- A new diagnostic script is added to the repo

Update Rule 2 (event schemas), Rule 3 (source enum), or Rule 5 (analysis
patterns) accordingly. Never remove an event type or source value without
removing all downstream uses first.
