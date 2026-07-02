# CLAUDE.md

This file is the front door for Claude Code sessions on DefiDesh. It is
read at the start of every session via the `sprint-start` skill. Stable
rules and reusable patterns live in `.claude/rules/` and `.claude/skills/`.
This file holds only what changes session-to-session: active sprint,
queue, recent fixes, known limitations.

---

## Project identity

**DefiDesh** (defidesh.com) is a public multi-chain DeFi LP position
tracker. Vision: the world's best LP tracker — accurate real-time data
for any wallet on any chain, at scale for thousands of users globally.
"Desh" means everything about crypto in one place; future scope includes
news, trends, token research, and macro sections.

**Stack:** Next.js App Router / TypeScript / Tailwind CSS / Recharts,
deployed on Vercel Pro. Neon Postgres. GitHub: `Robicon0/lp-tracker`,
branch `main`. Local dev: `~/lp-tracker-fresh`. Twitter: `@defidesh`.

**Chains and protocols:**
- EVM (Base, Arbitrum, Optimism, Ethereum, Polygon, HyperEVM): Aerodrome,
  Uniswap V3, Velodrome, HyperSwap, KittenSwap, ProjectX
- Solana: Orca, Raydium
- Sui: Bluefin, Cetus, Momentum (dashboard only; activity/P&L pending)
- Lending/borrowing: AAVE V3, Dolomite, Kamino, Jupiter Lend, Suilend,
  AlphaFi, HyperLend, Hypurr, HypurrFi

---

## How to start every session

Invoke the `sprint-start` skill before doing anything else. It runs the
six-step startup sequence: read this file, scan `.claude/rules/`, check
recent commits, confirm the active sprint, state the methodology, wait
for the specific task.

---

## Active sprint

**Sprint 3: Closed Solana position fee recovery via Helius.**

**Goal:** Recover closed Solana (Orca, Raydium) positions for Capital G/L + Fee Income.
A Solana CLMM position's state is DESTROYED on close (like Sui — Category B), so build a
Solana event indexer that parses Orca/Raydium program instructions from the wallet's tx
history and reconstructs deposit/withdrawal/fee lifecycle, then values it via the same
Rule-1a historical-only cascade (DeFiLlama-by-mint primary per Sprint 1.12; stable → $1;
never spot). Feeds Capital G/L exactly like the Sui closed-position path
(`suiClosedPositions.ts`) does for Cetus/Bluefin/Momentum — reuse `computePositionPnL`,
no per-chain branches.

**GATING DEPENDENCY (decide before starting):** the closed-Solana tx-history parse needs
**paid Helius** (~$49/mo) for speed — the free tier is too slow to scan a wallet's full
program-instruction history within the route budget. This is a budget decision for Osho;
Sprint 3 is **blocked on that approval** (see Business context). Until then, Solana closed
positions remain excluded from Capital G/L (label already scopes to "EVM + Sui").

**Hard constraint:** investigate-first; additive; historical-only (Rule 1a), no spot in
any fee/capital path; reuse the closed-position engine pattern + `computePositionPnL`
(Protocol Correctness Contract), no per-chain branches.

**Status:** Phase A (read-only investigation) COMPLETE — **gated on the Helius paid-upgrade
decision**. Phase A empirically confirmed (live free-tier scan of Account 1's Solana wallet):
Helius **Developer at $49/mo (50 RPS)** is required — the free tier (10 RPS) 429-storms the
N+1 `getSignaturesForAddress`→`getTransaction` backfill (22 HTTP 429s on one 649-tx wallet in
90s), exceeding the route budget for any non-trivial wallet. Orca = Category B (the NFT is
burned on close → `getNftMints`'s `amount===1` filter can't see it → closed positions need
wallet-tx-history reconstruction). On-chain surprise to resolve before Phase B: **Account 1
has 18 closed Orca positions, not 2** (the 2 sheet positions match — SOL/USDC `79rS8kcm…`,
ZEC/USDC `FDhkNvkf…` — plus 15 re-range artifacts that net ≈$0 and 1 omitted Nov-2025 SOL/USDC
position); summing all 18 per-position capitalGL ≈ correct realized total. Also (confirmed
again in Sprint SOLANA-CURRENT-PRICE Phase A): the ZEC mint Osho actually LP'd is `A7bdiYdS…`
(→ CoinGecko id `omnibridge-bridged-zcash-solana` $395.99; DeFiLlama-priceable), NOT the
`zRwbz…` hardcoded at orca/route.ts:34; and the ORCA entry there is a **placeholder mint**
(`orcaEKTdK7…ABCDE`, real is `…uGZE`). **Sprint 3 must correct BOTH via "value by the on-chain
mint," never a hardcoded map** (the Sprint TOKEN-RESOLUTION lesson applied to Solana from day
one). Ship Orca-only; Raydium deferred (Account 1 has 0 Raydium positions). Full findings in
memory `sprint-3-phase-a-findings`.

**Note — Sprint SPOT-RESILIENCE (tiered Redis LKG for the CoinGecko spot path) shipped as
`92e779a`:** fixed the persistent "Current price data unavailable" banner on OPEN Orca
positions (SOL/USDC + ZEC/USDC) — a platform-wide spot-path fragility (also hit a Sui Cetus
position), NOT a Solana-specific bug. See Recent fixes + Protocol Correctness Contract
invariant (j).

**Note — Sprint TOKEN-RESOLUTION (per-event Sui pool resolution) shipped as `a866576`:** an
out-of-band fix for a platform Fee-Income bug found while verifying Bluefin records (~$3,847
missing for closed-only Sui wallets). See Recent fixes. Sprint 3's Solana indexer MUST inherit
its per-event-token-resolution-from-on-chain-state pattern (Protocol Correctness Contract
invariant (i)).

**Note — Sprint MOMENTUM (Momentum activity route + closed-position Capital G/L) shipped
as `750f566`:** Sui Capital G/L is now COMPLETE across all three Sui CLMM protocols
(Cetus, Bluefin, Momentum). See Recent fixes.

**Carry-overs (not blockers):**
- **Sui closed positions Capital-G/L-integrated for ALL three Sui CLMM protocols**
  (Cetus + Bluefin Sprint 2.2b; Momentum Sprint MOMENTUM `750f566`) — only Solana closed
  positions remain excluded (this sprint, gated on Helius). Sui closed positions are
  counted in Capital G/L but not yet shown as Closed rows (Sprint 4 queue item).
- **CG-historical vs DeFiLlama-historical per-position daily-price tolerance (Sprint
  MOMENTUM finding):** the Sui closed-position SUI side prefers CoinGecko-historical
  (`getHistoricalOnlySuiPrice`) and falls to DeFiLlama-historical-by-coin-type only when
  CoinGecko 429s — BOTH are Rule 1c valid claim-date historical sources, never spot. So a
  position's per-event SUI price (and thus its Capital G/L) can vary by the daily-price
  delta between the two sources depending on which answered (e.g. Momentum A1 verified at
  −$306.59 combined vs a −$311.85 DeFiLlama-only scratch estimate, −1.7%). This is
  expected daily-granularity tolerance, NOT a leak; the wallet-scope combined figure is
  stable within a few percent.
- **HyperEVM Tier 2 archive is a non-functional fallback for positions >~57 days
  old** (Sprint 1.14) — mitigated for CLOSED positions by the Redis deposit cache;
  OPEN HyperEVM positions >57 days rely on Tier 1 (but have the value>0 client
  fallback, so no banner). Paid Chainstack archive would be the only real Tier-2
  fix; deferred (budget).
- **Sprint 1.12 Solana route not live-exercised** — Account 1's Orca ZEC/USDC +
  SOL/USDC positions are deposit-only (no fee claims yet). Production
  `defillama_historical_used` logs will confirm rescue.
- **Sprint 1.13 cold-load full-page browser timing not headlessly measured** —
  verified structurally + warm baseline (~8s); eyeball on the deploy.
- **Token-resolver coverage** — Tier 2 routes (uniswap/v3, pancakeswap) + activity
  routes still use hardcoded maps; future sprint migrates + removes them (Rule 9).

---

## Sprint queue

In order. One active at a time. Each sprint must ship before the next begins.
_(Sprint TOKEN-RESOLUTION `a866576` + Sprint SPOT-RESILIENCE `92e779a` shipped out-of-band —
see Recent fixes.)_

1. **Closed Solana position fee recovery via Helius** (active, Sprint 3; Phase A done) —
   Solana event indexer; parse Orca/Raydium program instructions from wallet tx history;
   feeds Capital G/L. **GATED on the paid Helius Developer ($49/mo, 50 RPS) upgrade decision**
   — Phase A empirically confirmed the free tier (10 RPS) is too slow. Phase B must value by
   the on-chain mint (DeFiLlama-by-mint), never a hardcoded map (Sprint TOKEN-RESOLUTION
   lesson), and inherit per-event token resolution from on-chain pool state from day one
   (Protocol Correctness Contract invariant (i)). **Also corrects the wrong ZEC mint
   (`zRwbz…` → `A7bdiYdS…`) and placeholder ORCA mint (`…ABCDE` → `…uGZE`) in orca/route.ts by
   valuing OPEN Solana positions from the on-chain mint too** (not just closed). Orca-only
   first; Raydium deferred.
2. **Clickable Capital G/L breakdown** (Sprint 4) — trust-through-transparency:
   make the Capital G/L figure expand to a per-position breakdown (deposited vs
   withdrawn USD, per closed position) so users can verify the number. The Sprint
   2.2b `SuiClosedPosition` summary fields are already shaped for this.
3. **UI for closed Sui + Solana positions** — Closed tab support (Sui closed
   positions are now retrieved for Capital G/L but not yet shown as Closed rows).
4. **tokenResolver coverage + cleanup** — migrate Tier 2 (uniswap/v3,
   pancakeswap) and the activity routes to `resolveToken`, then remove the
   per-route `KNOWN_COINS`/`KNOWN_TOKENS`/`TOKENS` maps once resolver coverage is
   proven in production (architecture-principles Rule 9).
5. **EVM per-event token resolution (hardening, not blocking)** — apply the Sprint
   TOKEN-RESOLUTION per-event pool-context pattern to the EVM wallet-scope fee scans
   (aerodrome/velodrome/uniswap). EVM is NOT currently broken — its fallback addresses are
   correct and Sprint 2.1b (`5b8f6b7`) routes closed positions through per-position scans
   with correct context, so the single-representative-pool risk is mitigated — but resolving
   each Collect event's token0/token1 from its pool on-chain would remove the last residual
   of the same bug class. Verify-and-document only until a real EVM user impact surfaces.
6. **Sprint SPOT-RESILIENCE-V2 (optional, non-blocking)** — the fuller version of the spot
   fix: `null`/"pending" propagation from `fetchCachedCoinGeckoPrices` through the position
   type + `useLpPnl` + `positionPnl` + a distinct softer UI banner ("Price refreshing…"), plus
   per-tier staleness caps (Tier B 10-min LKG / Tier C pending-not-LKG). Sprint SPOT-RESILIENCE
   `92e779a` already resolves the bogus banner via LKG; V2 is a larger, higher-risk change —
   **ship ONLY if a user-visible need emerges** (e.g. a genuinely-dead token showing a stale
   price is judged confusing). Not currently planned.
7. **Sui wallet-scope tx-history scan latency (optional, non-blocking)** — after Sprint
   SUI-HISTORICAL-REDIS `776fcaa` the Sui wallet-scope routes drop from ~111 s to ~18–20 s; the
   residual floor is the **~17 s public-Sui-RPC `queryTransactionBlocks` + `multiGet` scan** (240
   digests / wallet). A future sprint could cache the wallet's parsed tx-history / event set
   cross-instance (immutable ledger) or use a faster RPC. **Address only if <10 s becomes a UX
   need** — the Fee-Income regression is already resolved at ~18–20 s.
8. **Sprint PERFORMANCE-2 (hardening candidates, non-blocking)** — the deferred Phase A items:
   **#4** Redis-cache the Aerodrome positions route's ever-owned tokenId scan + closed-position
   reconstruction (~30 s, the remaining first-load straggler — now non-blocking behind the
   "still scanning" chip); **#5** Redis-cache CLOSED positions' activity route outputs
   (immutable — extend the Sprint 1.14 deposit-cache pattern beyond HyperEVM); **#6** move
   `withActivityRouteCache` success results to Redis (5-min TTL, errors never cached) so route
   outputs are shared across instances/users. Ship when performance next becomes the priority.

---

## Recent fixes

Most recent first. Commit hashes are authoritative; descriptions are
shorthand.

- **`f4b58ac`** — Sprint PERFORMANCE: market_chart batch-fill + patient fetch + progressive
  rendering. Fixes the **>2-minute load on Dashboard AND Analytics** (both accounts). Phase A
  waterfall found three stacked causes; all three fixed:
  **(1) Batch-fill SUI historical dailies** — every CG `/coins/{id}/history` call shares ONE
  concurrency-1 queue with a 1100 ms gap; Sui routes need ~55–70 SUI dates and under page-load
  burst CG 429s kept the Redis tier from warming, so every load re-paid a 60–150 s serial crawl
  (Sui wallet-scope routes measured 168→>179 s; the Cetus PER-POSITION route >179 s was the
  dashboard killer). NEW `fetchDailyClosesRange(cgId, from, to)` in `cgPriceHistory.ts`: ONE
  `market_chart/range` call (span padded ≥92 d so CG returns DAILY 00:00 UTC points,
  **byte-identical to `/history` — verified 0.0000% on 11 dates**) fills every missing date;
  `suiPriceHistory.ts` prewarm is now tiered: in-process → parallel Redis reads → >5 missing =
  batch call → write all needed dates to the same `price:historical:sui:{YYYYMMDD}` keys →
  residual per-date fallback unchanged. **This is the standard pattern for any future
  historical-price backfill need** (generic, keyed by cgId). Rule 1c: same CG daily source,
  batched — DeFiLlama stays fallback; never spot.
  **(2) Patient fetch, no timeout-retry storms** (`useLpPnl.ts`) — the 60/60/90 s
  abort-and-retry pattern spawned up to 3 duplicate server executions per slow position
  (aborting a fetch does NOT stop the lambda) and burned ~213 s before marking a healthy
  position errored. Now ONE 150 s attempt; at most one retry, ONLY on network error / HTTP 5xx
  — **never on timeout**; the position stays "still loading", not errored.
  **(3) Progressive rendering** — `PositionsContext` now runs one React Query per (source,
  address) (`useQueries`) instead of a single `Promise.all` that blanked the page until the
  slowest route (Aerodrome ~35 s) though nine routes finish ≤4 s; rows render as each protocol
  resolves with a subtle fixed-height "still scanning: X" chip on the dashboard.
  `useWalletLevelFees` is progressive on first load / atomic-swap on refreshes (totals never
  dip); `useAllPositionsActivity` merges per-fetch. **Required for correctness: in-flight dedup**
  (by position id in useAllPositionsActivity, by URL in useWalletLevelFees) so per-wave effect
  re-runs attach to existing fetches instead of re-firing duplicates — this is the standard
  pattern for any hook consuming the streaming positions array.
  Verified (B7, local prod-mode server, real env): fee targets matched (A1 Bluefin $1,817.94 /
  Cetus $1,627.17 / Momentum $370.32; A2 $2,392.51 / $3,270.98 / $0), 0 dropped, 0 pending;
  Capital G/L byte-consistent (A1 Sui −$7,099.16 = 2.2b + MOMENTUM exactly; A2 −$13,578.28
  byte-identical to 2.2b). Timing: **Sui wallet-scope 111–179 s → 9–24 s** (scan-bound);
  **Cetus per-position >179 s → 10.7 s**; warm route 12 ms; **first meaningful render ~35 s →
  ~1–4 s**. No cache bumps (cached contents byte-identical). SPOT-RESILIENCE + closed-position
  engine untouched. **#4 aerodrome positions route (~30 s, now a non-blocking straggler behind
  the chip), #5 activity output caching, #6 Redis route cache → Sprint PERFORMANCE-2.**
- **`776fcaa`** — Sprint SUI-HISTORICAL-REDIS: cross-instance Redis tier for SUI historical
  prices. Fixes the **post-deploy regression where the 3 Sui protocols (Cetus, Bluefin,
  Momentum) vanished from the analytics Fee Income breakdown**. Root cause (Sprint
  SPOT-RESILIENCE post-ship investigation): the Sui wallet-scope activity routes took
  **~100–120 s on cold Vercel instances** because `app/lib/suiPriceHistory.ts` had ONLY an
  in-process Map cache — **no cross-instance Redis tier** (unlike `cgPriceHistory` Sprint 1.6 and
  `defillamaPriceHistory` Sprint 1.12) — so every cold instance re-fetched each claim date's SUI
  historical price serially through the 1100 ms-gap `withCgPacing` queue (~57 dates × 1.1 s ≈
  63 s). The client rendered before the slow Sui routes finished, dropping the closed-only Sui
  protocols (whose fees come SOLELY from these wallet-scope routes) while fast EVM/Orca
  per-position fees remained. **NOT caused by SPOT-RESILIENCE's code** (bluefin/momentum don't
  import `priceCache`; their route code is byte-identical before/after `92e779a`) — the deploy
  merely cold-started instances and surfaced the pre-existing latency. **Fix:** reuse the Sprint
  1.6 shared helper `redisPriceCache.ts` with cgId `sui` (key `price:historical:sui:{YYYYMMDD}`,
  30 d TTL). `fetchSuiPriceAtDate` checks Redis BEFORE the CoinGecko fetch (populates the
  in-process cache on a hit); on a CoinGecko success, fire-and-forget writes to Redis. **Pure
  historical path — never spot (Rule 1a holds)**; the FIX-C `spotFallback` (cg-spot recovery) is
  UNTOUCHED (out of scope; already Redis-backed via SPOT-RESILIENCE's `cg_spot_v1`). Verified
  (B7, real `suiPriceHistory` + real Upstash): cross-instance sim — prime populates Redis from
  CoinGecko; a fresh process with CoinGecko forced 503 serves **byte-identical** prices from
  Redis. Timing: 20 dates **22,025 ms cold** (1,101 ms/date serial) → **299 ms warm Redis**
  (15 ms/date) = **~74× faster/date**. Projected Bluefin A1 route **~111 s → ~18–20 s** (SUI
  historical prewarm ~63 s → ~1 s; **residual ~17 s public-Sui-RPC tx scan is a separate,
  out-of-scope concern** — future sprint if UX needs <10 s). Data integrity: Redis stores exact
  CoinGecko values, fee USD unchanged (~$1,828 Bluefin A1); 0 dropped, 0 null. No regressions
  (spot path / EVM / Orca / Capital G/L unchanged). **No cache-version bumps** (server-side
  historical, upstream of localStorage). All historical price paths on all chains now have a
  cross-instance Redis tier — this closed the last gap.
- **`92e779a`** — Sprint SPOT-RESILIENCE: tiered Redis-backed last-known-good (LKG) for the
  CoinGecko SPOT path. Fixed the **persistent "Current price data unavailable" banner on OPEN
  positions** (Account 1 SOL/USDC + ZEC/USDC on Orca; the same class earlier hit a Sui Cetus
  position). Root cause: `fetchCachedCoinGeckoPrices` (`priceCache.ts`) had only a 60 s
  in-process Map cache (no cross-instance tier, unlike the Sprint 1.6 historical path), so
  under the analytics page's concurrent multi-route load a **cold Vercel instance 429s
  CoinGecko and returned 0** → `price0/price1 = 0` → `positionPnl.ts:104` `missing_current_prices`
  guard fired the bogus banner on every load. **Fix (contained in the shared spot helper — the
  ~20 callers are UNCHANGED, return type stays `Record<string,number>`):** NEW
  `app/lib/redisSpotCache.ts` — cross-instance Upstash Redis spot tier, key `cg_spot_v1:{cgId}`,
  stores `{usd, at}`, 24 h LKG retention / 5-min freshness, Sprint 1.6 no-op-stub contract (own
  client, never throws, fire-and-forget). `fetchCachedCoinGeckoPrices` tiered policy: **Tier A**
  stablecoin cgIds (usd-coin/tether/dai) → always **$1** (Rule 3; also removes them from the
  CoinGecko request, cutting 429 pressure); **Tier B/C** on a live-fetch miss → return the
  last-known price (in-process or Redis LKG, ANY age) instead of 0 — so a returned **0 means
  "genuinely unpriceable"** (no price ever seen), which is exactly when the
  `missing_current_prices` guard SHOULD fire (**no `positionPnl`/plumbing change** — the guard
  is correct by construction). **Part 2** a standalone **concurrency-2** spot-fetch queue
  (deliberately NOT the shared `withCgPacing` concurrency-1 chain, to avoid a nesting deadlock
  with `tokenResolver`'s historical CoinGecko calls). **Rule 1a untouched** — this is the
  SPOT/current-value path (Rule 2), NOT the historical fee-claim path; **Fee Income + Capital
  G/L unchanged** (they read the historical caches — Bluefin still ~$1,818 / ~$2,382).
  **Scope deviations (user-approved):** (1) kept the number return type + used LKG instead of
  null/pending propagation + `positionPnl` change (would touch ~20 callers + position type +
  useLpPnl + banner); (2) uniform LKG (any-age, 24 h TTL) rather than per-tier staleness caps
  (nothing to fall to without null/pending plumbing); (3) UI banner copy ("Price refreshing")
  deferred — the banner now shows ONLY for genuinely-unpriceable tokens (correct). A follow-up
  **Sprint SPOT-RESILIENCE-V2** (null/pending propagation + per-tier caps + softer banner copy)
  is queued as OPTIONAL, ship only if a user-visible need emerges. Verified (B7, real
  `fetchCachedCoinGeckoPrices` + real Upstash, simulated 429): Tier A → $1; Redis-fresh
  cross-instance → served the cached price (not 0); Redis-stale → LKG (not 0);
  genuinely-unpriceable → 0 (guard applies); live fetch → priced + written to Redis; tsc + build
  clean. **New Redis namespace `cg_spot_v1`; no localStorage cache bumps** (spot is upstream of
  `lp-pnl-events`/`analytics-activity`). Stablecoin current values shift ~0.03% (0.9997→$1,
  Rule-3-consistent). The wrong ZEC + placeholder ORCA mints are NOT fixed here (Sprint 3, via
  value-by-on-chain-mint).
- **`a866576`** — Sprint TOKEN-RESOLUTION: per-event Sui pool resolution for wallet-scope
  fee claims. The Bluefin `BLUEFIN_FALLBACK` typo discovered **~$3,847 missing Fee Income for
  closed-only wallets** (A1 $142.59 vs $1,818.55; A2 $211.37 vs $2,382.53). **Root cause was
  architectural** — the wallet-scope (`positionId=all`) fee pipelines priced EVERY fee claim
  with a single representative `(coinTypeA, coinTypeB)` from a hardcoded fallback context that
  assumed one token pair per protocol per wallet; `BLUEFIN_FALLBACK.coinTypeB` held a
  corrupted USDC address (`…50a4ae…` vs real `…50a5ae…`), so every closed-position fee claim's
  USDC side priced to null and the whole claim was DROPPED (only SUI rewards survived via the
  spot-capable reward path → Bluefin showed ~8%). **Fixed** by a new shared lib
  `app/lib/suiPoolContext.ts` (`resolveSuiPoolContext`/`resolveSuiPoolContexts`) that resolves
  each fee claim's REAL pool `(coinTypeA/B + decimals)` from its on-chain pool object per event
  — Bluefin/Momentum fee events carry `pool_id`, Cetus carries `pool` (immutable `Pool<A,B>`
  type params → cached in-process, no TTL). Bluefin/Cetus/Momentum activity routes now price
  each wallet-scope fee claim through the SAME historical cascade (stable→$1 / SUI
  `getHistoricalOnlySuiPrice` / DeFiLlama-by-coin-type / else **pending**) using the correct
  token per side — NEVER a guessed/hardcoded type, NEVER spot (Rule 1a); an unresolvable pool
  is surfaced as `pending_pool_unresolved`, never silently dropped. Same pattern hardened
  across all three Sui CLMM protocols (Cetus/Momentum were NOT actively dropping fees — their
  fallbacks happened to match the real pools — but now use the same resilient code path).
  Per-position mode unchanged (already gets the right coin types from the open position).
  **EVM verified unaffected** (Sprint 2.1b `5b8f6b7` per-position scans mitigate the same bug
  class; correct fallback addresses). `BLUEFIN_FALLBACK.coinTypeB` corrected to native USDC
  for hygiene (now inert for fee pricing). Verified (B7, claim-date DeFiLlama-historical
  replication): Bluefin A1 →~$1,828.63 (+0.6%), A2 →~$2,420.24 (+1.6%); **all 47 dropped
  fee_claims recovered, 0 pending**; Cetus/Momentum fee USD byte-identical (no regression);
  Capital G/L (`suiClosedPositions.ts`) + EVM untouched; non-Osho SUI/USDT simulation prices
  both sides correctly; tsc + build clean. **No cache bumps** (per-position byte-identical;
  wallet-scope `useWalletLevelFees` has no persistent cache; the route-level
  `withActivityRouteCache` is in-process URL-keyed and clears on deploy; `suiPoolContext` is a
  new in-process cache with no version). **Sprint 3 (Solana) Phase B must inherit this
  per-event-token-resolution-from-on-chain-state pattern from day one (Contract invariant (i)).**
- **`750f566`** — Sprint MOMENTUM: Momentum (Sui) activity route + closed-position
  Capital G/L. Completes Sui Capital G/L — **all three Sui CLMM protocols (Cetus,
  Bluefin, Momentum) now reconstruct closed positions** and fold realized Capital G/L +
  lifetime fees into analytics, valued historical-only (Rule 1a) from day one. NEW
  `app/api/momentum/activity/route.ts` modeled on Bluefin (`17c5101`),
  `withActivityRouteCache`, per-position + wallet-scope (`positionId=all`). Event mapping
  (verified on-chain, Phase A): position-id field `position_id`; amounts
  `amount_x`/`amount_y`; `AddLiquidityEvent`=deposit, `RemoveLiquidityEvent`=withdrawal,
  `FeeCollectedEvent`=fee_claim, `CollectPoolRewardEvent`=reward_claim (carries the FULL
  `reward_coin_type`, so rewards are valued historical-only via `resolveToken` — **no
  spot+LKG exception needed**, unlike the CETUS reward token); ever-owned set from
  `AddLiquidityEvent`+`OpenPositionEvent`. Fee/reward claims CLAIM-DATE historical ONLY:
  stable→$1; SUI→`getHistoricalOnlySuiPrice` (pure historical, NOT the spot-capable
  `getCachedSuiPriceForTimestamp`)→DeFiLlama→pending; other non-stable→DeFiLlama→pending;
  **NO spot** (the Rule 2 deposit/withdrawal spot last-resort is unreachable by claims).
  `suiClosedPositions.ts`: `'momentum'` added to `SuiClmmProtocol` + `MOMENTUM_PKG` +
  `POSITION_TYPE`/`POSITION_ID_FIELD`/`eventPackageMatches` + a `parseCloseEvent` momentum
  branch (`amount_x`/`amount_y`; **`sqrt` ALWAYS null** — Momentum liquidity events carry
  no `current_sqrt_price`, so every deposit/withdrawal rides the existing historical-sides
  fallback, Rule-1a-clean for SUI/USDC). Valuation cascade / Redis cache /
  `computePositionPnL` UNCHANGED; `sui-closed-positions` route folds momentum in.
  `useLpPnl` (ACTIVITY_PROTOCOLS + buildActivityUrl + closed-DTO union + label map);
  `useWalletLevelFees` (Momentum SUI/USDC fallback context + wallet-scope scan recovers
  closed `FeeCollectedEvent`s into Fee Income); analytics label →
  "EVM + Sui (Cetus, Bluefin, Momentum)". Cache bumps: lp-pnl-events v26→v27,
  analytics-activity v18→v19 (`closed_pos_sui_v1` NOT bumped — Momentum uses the new
  `:momentum:` key namespace; cetus/bluefin entries byte-identical). Verified (both Sui
  wallets, live engine): **A1 2 closed positions combined −$306.59** (within 1.7% of the
  −$311.85 Phase A estimate; per-position daily-price variance is CG-historical-preferred
  vs DeFiLlama-fallback, both Rule 1c), **A2 exactly $0** (no Momentum LP positions, only
  swaps); **0 spot, 0 pending** across all events; per-position fees reconcile on-chain to
  `FeeCollectedEvent` amounts; tsc + build clean. **Solana closed positions remain the
  last excluded closed-position chain → Sprint 3 (gated on paid Helius).**
- **`5b583f7`** — Sprint EMAIL: homepage email capture (ship notifications). Adds a
  privacy-respecting email-capture section to the homepage so visitors can subscribe to
  ship notifications — a simple email-only list, **NOT user accounts** (no login, no
  password, no wallet coupling; gating/identity stays architecturally separate per the
  wallet-security forward-looking note). New `POST /api/subscribe`
  (`app/api/subscribe/route.ts`) mirrors the existing `position-entries` pattern
  (`@vercel/postgres` `sql.query`, `isDbConfigured()` guard, idempotent
  `CREATE TABLE IF NOT EXISTS subscribers`): server-side RFC-shape validation, email
  lowercased before storage (case-insensitive UNIQUE), duplicates `ON CONFLICT DO
  NOTHING` and return **200 — no existence leak** (privacy), `x-forwarded-for` captured
  for spam-protection only, best-effort in-memory **5/IP/hour** rate limit, opaque 500 on
  DB error. New `ShipNotifications` client component matches the hero SCAN-input terminal
  aesthetic (`#00ff41`, `>_` prefix, JetBrains Mono — used the established brand green,
  not the prompt's `#4ade80` which appears nowhere in the codebase); inline confirmation
  replaces the input on success with **no layout shift**; a11y `role=status`/`role=alert`,
  `aria-label`, real submit `<button>` in a `<form>`. Wired into `app/page.tsx` between
  FEATURES and the footer (user-confirmed placement; the FEATURES section sits between
  Supported Protocols and the footer). **No new deps, env vars, or cache-version bumps.**
  Verified locally against Neon: valid→200, duplicate(diff case)→200 single row,
  invalid/empty→400 `invalid_email`, 6th/IP/hour→429; schema + dedup + rate-limit + IP
  capture confirmed, test rows cleaned up; tsc + build clean. **No email-sending,
  unsubscribe endpoint, captcha, or analytics** — deferred per Memory #29 (wait for
  traction). Export subscribers via manual SQL when an announcement goes out.
- _(Sprint 2.2c `bfabf3f` — open-position SUI fee-claim cg-spot leak closed: the 2 fee-claim
  + 2 `[PRICE_LOG]` sites in cetus/bluefin now call `getHistoricalOnlySuiPrice` (never the
  FIX-C spotFallback); reward sites untouched (Memory #28 exception). Cache bumps v26/v18/v4/v5
  — rolled off this list; see git history.)_
- _(Sprint 2.2b `bb7fc0d` — Sui closed-position Capital G/L for Cetus + Bluefin:
  `app/lib/suiClosedPositions.ts` reconstructs destroyed-object positions from wallet tx
  history, values them historical-only, reuses `computePositionPnL`; Redis `closed_pos_sui_v1`;
  `getHistoricalOnlySuiPrice` added — rolled off this list; see git history.)_
- _(Sprint NEW `17c5101` — Bluefin fee claims historical-only (the last cg-spot fee-claim
  leak); DeFiLlama folded in as a first-class historical tier — rolled off this list; see git
  history.)_
- _(Sprint 2.1b `5b8f6b7` — Aerodrome/Velodrome closed positions route through per-position
  scans with correct context (cbBTC $0.21→~$296); cg-spot removed from both routes' fee claims;
  dedup keys on (protocol, txHash, logIndex) — rolled off this list; see git history.)_
- _(Sprint 1.15 `4752416` — Cetus fee claims route through DeFiLlama historical
  before any spot, removing the latent FIX-A cg-spot fee-claim fallback;
  historical-ONLY per side (stable $1 / SUI CG→DeFiLlama / other non-stable
  DeFiLlama / else pending). Memory #28 CETUS reward spot+LKG preserved — rolled off
  this list; see git history.)_
- _(Sprint 1.14 `65d6328` — persist a CLOSED HyperEVM position's immutable deposit
  logs in Upstash Redis (`depositHistoryCache.ts`, keyed `(nftManager, tokenId)`,
  30d TTL) so a throttled free-tier Etherscan can't drop them; Tier 2 archive only
  covers ~57 days and true `fromBlock=0` is plan-blocked — rolled off this list; see
  git history.)_
- _(Sprint 1.13 `2dcd3cb` — server-side activity-route cache + in-flight dedup
  (`app/lib/activityRouteCache.ts` `withActivityRouteCache` wraps all 9
  `/api/{protocol}/activity` GETs): collapses the 2-3× redundant multi-hook fetch
  per position into ONE computation (the HyperEVM cold-load fix), in-process,
  byte-identical, no version bump — rolled off this list; see git history.)_
- _(Sprint 1.12 `5bad502` — DeFiLlama historical-by-contract wired as a SECONDARY
  claim-date price source (`app/lib/defillamaPriceHistory.ts`), keyed by on-chain
  contract/mint/coin-type for the Sui/Solana long-tail; PRIMARY for Solana
  orca/raydium, additive null-only fallback for Sui cetus/bluefin; Rule 1a preserved
  (historical endpoint only, never current/spot) — rolled off this list; see git
  history.)_
- _(Sprint 1.11 `d57f051` — gate `price0/price1 > 0` for OPEN positions only in
  `computePositionPnL` so a cold-instance spot-429 (`price0=0`) no longer spuriously
  excludes closed HyperEVM positions from Capital G/L; closed positions compute from
  historical events — rolled off this list; see git history.)_
- _(Sprint 1.10 `140d908` — platform-wide automatic token resolution
  (`app/lib/tokenResolver.ts` + `tokenConstants.ts`); Tier-3 (aerodrome/velodrome)
  unmapped pool tokens resolve decimals from on-chain truth, not blind `=18` —
  rolled off this list; see git history.)_
- _(Sprint 1.8b `0b9e3a0` — Performance Metrics + Yield/APR Projections fall back
  to an uncollected-fees estimate for new positions with no claim history — rolled
  off this list; see git history.)_
- _(Sprint 1.8 `a6a6e75` — Cetus pending-fee computation (pool-owned fee table:
  position_manager LinkedTable + tick SkipList) — rolled off this list; see git
  history.)_
- _(Sprint 1.7e `f7842c8` — shared CLMM utilities (clmmFeeMath / clmmTickDecoder)
  applied across Orca/Bluefin/Momentum — rolled off this list; see git history.)_
- _(Sprint 1.7d `d2ff9d6` — Orca variable-length `DynamicTickArray` tick decoder
  — rolled off this list; see git history.)_
- _(Sprint 1.7 `1dd862c` — Orca CLMM fee-growth underflow guard — rolled off
  this list; see git history.)_
- _(Sprint 1.6 `5af4d33` — Upstash Redis persistent historical-price cache —
  rolled off this list; see git history.)_
---

## Where things live

**Stable rules** (always loaded, small):
- `.claude/rules/pricing-invariants.md` — fee valuation, exceptions,
  display currency, capital G/L formula
- `.claude/rules/architecture-principles.md` — platform-level fixes,
  no per-chain branches, additive-only, sprint discipline
- `.claude/rules/cache-versioning.md` — version bump protocol, current
  versions, TTL by result type
- `.claude/rules/wallet-security.md` — auto-connect prohibition,
  connected/watched parity, duplicate rejection, persistence rules
- `.claude/rules/commit-protocol.md` — build clean before commit,
  verification before "done", stop-and-report threshold
- `.claude/rules/instrumentation.md` — `[PRICE_LOG]` event schemas,
  source enum, analysis patterns

**Skills** (loaded on demand when invoked):
- `.claude/skills/sprint-start/SKILL.md` — session startup sequence
- `.claude/skills/investigate-first/SKILL.md` — 8-step debugging
  methodology
- `.claude/skills/fix-prompt-template/SKILL.md` — Claude Code prompt
  structure (Investigation / Implementation / Verification)
- `.claude/skills/burned-nft-recovery/SKILL.md` — EVM closed-position
  recovery pattern
- `.claude/skills/add-new-protocol/SKILL.md` — Protocol Correctness
  Contract for integrating any new protocol on any chain (shared CLMM
  utilities, decoder coverage, UI surfaces, wallet security)

**Shared CLMM utilities** (canonical — see architecture-principles Rule 8):
- `app/lib/clmmFeeMath.ts` — `safeCalcPendingFee` (u128 underflow guard),
  `calcFeeGrowthInside`, `emitFeeUnderflow`. Used by Orca, Bluefin, Momentum.
- `app/lib/clmmTickDecoder.ts` — `solanaCLMMTickRegistry` (binary tick-array
  dispatch) + `anchorDiscriminator`. Solana only; Sui uses JSON extraction.

**Shared token resolution** (canonical — see architecture-principles Rule 9):
- `app/lib/tokenResolver.ts` — `resolveToken({chain, contractAddress|mint|suiType})`
  → `{symbol, decimals, cgId, priceable, source}`. Cascade: Redis → constants →
  CoinGecko contract → on-chain metadata → CoinGecko symbol search → DeFiLlama
  coverage → unresolvable. Used (long-tail fallback) by cetus, bluefin, momentum,
  orca, raydium, hyperswap, aerodrome, velodrome.
- `app/lib/tokenConstants.ts` — pinned native tokens + canonical stables per
  chain (the only identities that never auto-resolve), `CG_PLATFORM` /
  `DEFILLAMA_CHAIN` slugs, and identifier normalization.
- `app/lib/suiPoolContext.ts` (Sprint TOKEN-RESOLUTION `a866576`) —
  `resolveSuiPoolContext(poolId)` / `resolveSuiPoolContexts(poolIds)` →
  `{coinTypeA, coinTypeB, decimalsA, decimalsB}` from a Sui CLMM pool's on-chain
  `Pool<A,B>` type params (immutable → in-process Map cache, no TTL). The
  bluefin/cetus/momentum activity routes call it to resolve each wallet-scope fee
  claim's REAL pool per event instead of a single hardcoded representative pair
  (Protocol Correctness Contract invariant (i)).

**Claim-date historical pricing** (two sources — see pricing-invariants Rule 1c):
- `app/lib/cgPriceHistory.ts` — `fetchTokenPriceAtDate(cgId, ts)`, CoinGecko
  historical (PRIMARY), wrapped by the Sprint 1.6 Redis tier (`redisPriceCache.ts`).
  Also `fetchDailyClosesRange(cgId, from, to)` (Sprint PERFORMANCE `f4b58ac`) — ONE
  `market_chart/range` call returning every daily close in the span (byte-identical
  to `/history`; span padded ≥92 d for daily granularity). The standard pattern for
  any historical-price backfill: N missing dates = 1 CG call, written to the same
  `price:historical:{cgId}:{YYYYMMDD}` Redis keys. Used by `suiPriceHistory.ts`'s
  tiered prewarm (in-process → Redis → batch → per-date fallback).
- `app/lib/defillamaPriceHistory.ts` (Sprint 1.12) — `fetchDefillamaPriceAtDate` /
  `prewarmDefillamaPrices` / `getCachedOnlyDefillamaPrice`, DeFiLlama
  historical-by-contract (SECONDARY), keyed by on-chain contract/mint/coin-type,
  own Redis namespace `price:historical:defillama:*`. Used by orca/raydium
  (PRIMARY there) + cetus/bluefin (additive null-only). Claim-date only, never
  spot (Rule 1a). No HyperEVM coverage.

---

## Methodology

Investigate-first, always. Before any fix:

1. Instrument and capture logs
2. Diagnose root cause from evidence
3. Plan with Osho in plain language, get explicit confirmation
4. Write thorough Claude Code prompt using `fix-prompt-template`
5. Verify post-fix `route_summary` matches expected numbers
6. Commit and push automatically when verified — never ask permission
7. Stop and report if verification gap is significant (20%+)

All changes are additive unless explicitly replacing broken logic.
Every fix is a platform fix that benefits all current and future users
with similar position shapes. Never wallet-specific framing.

**Performance is a platform requirement (Sprint PERFORMANCE `f4b58ac` baselines).**
New sprints must not regress: **first meaningful render ~1–4 s** (positions stream
per source — never reintroduce an all-or-nothing `Promise.all` gate on the
positions array) and **Sui activity routes ~10–24 s** (scan-bound; the SUI
historical prewarm is batch-filled via `fetchDailyClosesRange` + Redis). Any hook
consuming the streaming positions array MUST carry in-flight dedup (by position id
or URL) so per-wave effect re-runs never re-fire an in-flight fetch; client fetch
policy is one patient attempt, retry only on network/5xx, never on timeout. Verify
these numbers as part of B7 for any sprint touching the load path.

---

## Known limitations

**HyperEVM has no archival `eth_call`.** Chainstack returns -32002
"Archive Debug Trace not available on plan." Public RPC at
`rpc.hyperliquid.xyz/evm` is non-archival for state. The sqrtPriceX96
resolver cannot run on HyperEVM. Claim-time pricing for HyperSwap,
KittenSwap, ProjectX must use CG-historical awaited for closed
positions, fire-and-forget for open.

**HyperEVM Tier 2 archive is a non-functional fallback for positions older than
~57 days (Sprint 1.14 finding).** It scans only the last `SCAN_DEPTH` 5M blocks,
which at HyperEVM's ~1s (~984ms) block time is **~57 days** — and a true
`fromBlock=0` archive query is plan-blocked (`-32002`, see above). So a position
whose deposit predates the window can't be served by Tier 2 at all; Tier 1
(Etherscan V2, `fromBlock=0`) is the only live tier for it. When Etherscan
throttles Tier 1 under production load, the deposit is dropped → exclusion banner.
**Mitigated for CLOSED positions in Sprint 1.14 (`65d6328`):**
`app/lib/depositHistoryCache.ts` persists a closed position's immutable deposit
logs in Redis (keyed by `(nftManager, tokenId)`, 30d TTL), so after the first
successful retrieval it's served from cache forever (`tier_used: redis-cache`),
never re-hitting Etherscan. OPEN HyperEVM positions older than 57 days still rely
on Tier 1 (they're not cached, since they can gain deposits) — but they have the
client-side value>0 fallback, so no banner. A paid Chainstack archive tier (or
narrowing the scan by a known deposit block) remains the only way to make Tier 2
a real fallback for open old positions; deferred (budget decision).

**Server-side cross-user price cache — RESOLVED in Sprint 1.6 (`5af4d33`).**
The persistent cross-request price cache ("Option C") is now built:
`app/lib/redisPriceCache.ts` wraps the CoinGecko historical path in
`cgPriceHistory.ts` with Upstash Redis (Tier 1, 30d TTL), so a warmed
claim-date price survives across cold starts, requests, positions, and users.
This addresses the Sprint 1.5 failure mode where the awaited CG-historical
prewarm could time out under concurrent CG pressure (even at the 60s cap),
leaving HYPE fee claims UNRESOLVED. Prewarm cap left at 60s for now; consider
lowering to 25s once production cache-hit rate is observed >80% over several
days (track `route_summary.redis_cache_hits/misses` and
`claim_pricing_succeeded`). Note: the Upstash DB (`defidesh-price-cache`, free
tier) is shared across Production/Preview/Development — avoid broad key
flushes. A genuinely-unpriceable claim date still stays UNRESOLVED by design
(never spot-valued); Redis only eliminates pending-claims caused by transient
CG rate-limit/timeout.

**Empty-Sugar edge case (Aerodrome, Velodrome).** For wallets with zero
open positions, the Sugar contract's enumeration returns empty, causing
`buildClosedPositions` to be skipped. Fees are recovered but closed-record
display is gated. Pending fix.

**Sui closed positions — Capital G/L COMPLETE for ALL THREE Sui CLMM protocols
(Cetus + Bluefin Sprint 2.2b `bb7fc0d`; Momentum Sprint MOMENTUM `750f566`).** The
position object is destroyed on close, but `app/lib/suiClosedPositions.ts`
reconstructs each lifecycle from wallet tx history and folds Capital G/L into
`useLpPnl` (Redis-cached `closed_pos_sui_v1`, now `:cetus:` / `:bluefin:` / `:momentum:`
key namespaces). Momentum rides the historical-sides fallback (its liquidity events
carry no `current_sqrt_price`, so the sqrtprice-historical PRIMARY never fires —
stable $1 + SUI CG/DeFiLlama historical, which is exact for SUI/USDC pools). Remaining
gaps: closed Sui positions are not yet shown as **Closed rows** in the dashboard/Closed
tab (only counted in Capital G/L — Sprint 3 queue item, NOT the Solana sprint); and
**reward claims** are not valued in the closed-position Capital G/L path (Cap G/L
excludes them by Rule 4; the displayed Fees Collected already recovers closed-Sui
fees+rewards via the wallet-scope pipeline — Momentum's wallet-scope route now values
rewards historical-only via `reward_coin_type`, no spot+LKG exception). **Solana** is
the only chain still missing closed-position Capital G/L (Sprint 3, gated on Helius).

**Sui open-position fee-claim cg-spot leak — RESOLVED (Sprint 2.2c `bfabf3f`).** The
Cetus (1.15) and Bluefin (Sprint NEW) *open*-position fee cascades called
`getCachedSuiPriceForTimestamp` for the SUI side, which returns the FIX-C `spotFallback`
(current cg-spot) when CoinGecko historical misses — and, being non-null, PRE-EMPTED the
DeFiLlama-historical tier — so an open-position SUI fee claim could be spot-valued (Rule
1a leak). Fixed: the 2 fee-claim sites + 2 `[PRICE_LOG]` re-derivation sites now call
`getHistoricalOnlySuiPrice` (pure historical → DeFiLlama → pending; no spot). The 2
reward-claim sites are untouched (CETUS reward spot+LKG is the designated Memory #28
exception; Bluefin reward historical migration remains deferred). Platform-wide, **every
fee claim on every protocol on every chain is now historical-only** — the sole exception
is the CETUS reward token's designated spot+LKG path.

**Solana closed positions not yet retrievable.** Position state destroyed
on close. Solution exists in plan (transaction history parsing); requires
Helius RPC paid upgrade for speed. Implementation queued as Sprint 5.

**Suilend APY not showing.** Reserve interest rate fields need parsing.
AlphaFi and Dolomite APY now working from on-chain data.

**Pool Statistics N/A for some pools.** Low priority backlog item.

---

## Wallet addresses for verification

Osho's two accounts. Never mix in analysis.

**Account 1:**
- EVM: `0xD99a9e66d000d4024dC77f00f784Cc45F8804F20`
- Solana: `GndR...pogC`
- Sui: `0xdc...c30d`

**Account 2:**
- EVM: `0xEf93B7f19dcEf8E5f9c5F41CBBCe9e78B16B8d0C`
- Sui: `0x8ef8c104d43e55b11fc6afcd58088274fabff2d30480dd4c4283ff834ac2297d`

Manual claim records (Google Sheets ground truth) are kept per-account.
Always state which account the affected wallet belongs to before
investigating.

---

## Tools and resources

**Development:**
- IDE: VS Code with Claude Code extension
- Strategy/prompting: Claude.ai (this conversation)
- Repo: `Robicon0/lp-tracker`, branch `main`

**Hosting and database:**
- Vercel Pro ($20/month) — auto-deploys from `main`
- Neon Postgres (`@vercel/postgres`, env `POSTGRES_URL`; helper `app/lib/db.ts` →
  `sql`, `isDbConfigured()`). Tables: `position_manual_entries` (manual closed-position
  deposit/withdrawal entries), `portfolio_snapshots` / `position_snapshots` (snapshots),
  `wallets` (registered wallets), and **`subscribers`** (Sprint EMAIL `5b583f7` —
  homepage ship-notification email capture; columns `id SERIAL PK`, `email TEXT UNIQUE`
  stored lowercased, `created_at TIMESTAMPTZ`, `ip_address TEXT` nullable, index
  `subscribers_email_idx`). The `subscribers` table is a **simple email-only list, NOT
  user accounts** — no login/password/wallet coupling; created idempotently by
  `app/api/subscribe/route.ts` on first POST. Export via manual SQL
  (`SELECT email FROM subscribers ORDER BY created_at`) when an announcement ships.
- Upstash Redis (`defidesh-price-cache`, free tier, us-east-1) — persistent
  historical-price cache (Sprint 1.6, `price:historical:{cgId}:{YYYYMMDD}` — now
  incl. `price:historical:sui:*` from Sprint SUI-HISTORICAL-REDIS `776fcaa`, which
  routed `suiPriceHistory.ts` through the same shared `redisPriceCache` helper) +
  DeFiLlama claim prices (Sprint 1.12, `price:historical:defillama:*`) +
  closed-position deposit history (Sprint 1.14,
  `deposit:logs:hyperevm:{nftManager}:{tokenId}`, 30d TTL) + closed-Sui-position
  Capital G/L (Sprint 2.2b, `closed_pos_sui_v1:*`) + **SPOT-price LKG (Sprint
  SPOT-RESILIENCE `92e779a`, `cg_spot_v1:{cgId}` → `{usd, at}`, 24h retention /
  5-min freshness; `app/lib/redisSpotCache.ts`)**. Env:
  `PRICE_CACHE_KV_REST_API_URL` + `PRICE_CACHE_KV_REST_API_TOKEN` (pass explicitly
  to the `@upstash/redis` client — it auto-reads only `UPSTASH_*`/`KV_*`, not
  `PRICE_CACHE_KV_*`). Connected to Production/Preview/Development; shared, so
  avoid broad flushes.

**RPC providers:**
- Chainstack `nanoreth` — HyperEVM (`HYPEREVM_ARCHIVE_RPC`)
- Alchemy — EVM chains, Solana
- Helius — Solana (paid upgrade needed for closed-position tx history
  speed)

**Price and pool data:**
- CoinGecko API — spot + historical (rate limit management active)
- On-chain sqrtPrice derivation — `app/lib/v3PriceDerivation.ts`
- DefiLlama — pool metadata
- Etherscan V2 API (chainid=999 for HyperEVM deposits) — `DefiDesh`
  API key in env

**Analytics:**
- Vercel Analytics (`@vercel/analytics`, added to `app/layout.tsx`
  outside Providers wrapper)

**Feedback:**
- Formspree floating feedback button

**Protocol-specific addresses:**
- Cetus packages: `0x1eabed72...` (fees/lifecycle),
  `0xdb5cd62a06c79695...` (V2 deposits/withdrawals),
  `0xdc67d6de3f00051c...` (V2 rewards)
- Cetus position field: `position`. Amounts: `amount_a` / `amount_b`
- Bluefin position field: `position_id`
- Velodrome fallback pool: `0x9763...7c8b` (USDC/WETH, reversed
  ordering)

**Cache versions (verify against code before bumping):**
- `lp-pnl-events-v27` (Sprint MOMENTUM — Momentum is now an ACTIVITY_PROTOCOL (open
  positions route to `/api/momentum/activity` instead of being surfaced as unsupported
  rejections) AND its closed positions fold into Capital G/L; both change cached LP-P&L
  output. Parity with analytics-activity v19. v26 was Sprint 2.2c: Cetus + Bluefin
  fee-claim SUI side → `getHistoricalOnlySuiPrice`)
- `analytics-activity-v19` (Sprint MOMENTUM — Momentum fee + historical-only reward
  claims now enter analytics Fee Income; re-resolve in lockstep with LP-P&L. v18 was
  Sprint 2.2c)
- `cetus-activity-v4` (Sprint 2.2c — Cetus fee-claim SUI side historical-only via
  `getHistoricalOnlySuiPrice`; FIX-C spotFallback no longer reachable for fee claims)
- `bluefin-activity-v5` (Sprint 2.2c — Bluefin fee-claim SUI side historical-only via
  `getHistoricalOnlySuiPrice`; FIX-C spotFallback no longer reachable for fee claims.
  v4 had: stable → $1; SUI → CG-historical → DeFiLlama; else pending)
- `momentum-activity` (Sprint MOMENTUM — NEW `/api/momentum/activity`, wrapped in the
  in-process `withActivityRouteCache` (URL-keyed, NO `-vN` suffix — clears on every
  deploy by construction, cache-versioning Rule 4). Fee/reward claims historical-only,
  Rule 1a; reward valued via `reward_coin_type` → resolveToken, never spot)
- `closed_pos_sui_v1` (Sprint 2.2b — Upstash Redis cache of reconstructed CLOSED Sui
  positions' Capital G/L, keyed `closed_pos_sui_v1:{protocol}:{wallet}`, now `:cetus:`
  / `:bluefin:` / `:momentum:` namespaces, 30d TTL, Sprint 1.14 immutable contract.
  NOT bumped for Sprint MOMENTUM — Momentum is a NEW protocol key, so cetus/bluefin
  entries are byte-identical. Bump to invalidate on a closed-position valuation-logic
  change. Env: `PRICE_CACHE_KV_*`, shared Upstash DB — avoid flushes)

---

## Business context

DefiDesh is in trust-building phase. No subscription revenue yet. Only
paid infrastructure is Vercel Pro ($20/month). Paid services deferred
until traffic justifies: CoinGecko paid (~$129/mo at 100+ daily users),
Helius (~$49/mo for closed Solana history speed), Chainstack archival
(~$49/mo, would drop HyperEVM CG workaround).

Multi-currency display (EUR, GBP, INR, JPY, SAR, AED, etc.) planned for
future. All internal pricing stays USD; FX conversion at UI layer only.

Subscription-based feature gating planned for future. Must remain
architecturally separate from wallet logic. Server-side only.

Osho is currently sole developer due to cost constraints. Plans to hire
team once platform generates income. Architecture must stay team-friendly.

---

## When to amend this file

Amend `CLAUDE.md` at the end of every session where work was committed.
Specifically:

- Move the just-completed sprint out of "Active sprint" and into recent
  fixes (with commit hash)
- Promote the next sprint in the queue to "Active sprint"
- Add the most recent commit to "Recent fixes" (keep the list to ~6
  entries — older ones drop off)
- Update "Known limitations" if a limitation was resolved or a new one
  discovered
- Update "Cache versions" if any version was bumped
- Update Osho's wallet address if changed (rare)

Do not amend stable rules here. If a stable rule needs to change, amend
the relevant file in `.claude/rules/`. This file stays focused on what
changes session-to-session.
