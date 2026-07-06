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
- Solana: Orca (incl. closed-position Capital G/L), Raydium (open only; closed queued)
- Sui: Bluefin, Cetus, Momentum (full: dashboard, activity, P&L, closed-position Capital G/L)
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

**Sprint 4: Clickable Capital G/L breakdown.**

**Goal:** trust-through-transparency — make the analytics Capital G/L figure expand to a
per-position breakdown (deposited vs withdrawn USD, open/close dates, fees, per closed
position, per chain/protocol) so users can verify the number themselves. The Sprint 2.2b
`SuiClosedPosition` and Sprint 3-FREE `SolanaClosedPosition` summary fields (`depositUSD` /
`withdrawalUSD` / `feesUSD` / `capitalGL` / `sourceBreakdown`) are already shaped for exactly
this; EVM closed positions carry the same figures via `perPosition[id]`
(`closingValue − initialValue`). The Sprint 3-FREE B7 19-row reconciliation table
(`reports/sprint-3-free-phase-b-report.md`) is the reference for what the breakdown should
let a user see.

**Hard constraint:** display-only sprint — NO valuation-logic changes (numbers shown must be
byte-identical to what `aggregate()` already computes); additive; investigate-first for any
number that looks off rather than reshaping it in the UI.

**Status:** not started.

**MILESTONE (Sprint 3-FREE `d1bf447`): cross-chain Capital G/L is COMPLETE across
EVM + Sui + Solana** — every supported chain's closed positions now reconstruct and fold into
Capital G/L, delivered on FREE infrastructure (Alchemy free tier; the planned $49/mo Helius
upgrade was never needed). The **Alchemy free-tier paced-scan pattern** is the documented
template for any future chain needing tx-history reconstruction (see architecture-principles
Rule 5 Category B): serial small batches (20 tx/HTTP call, ~120 ms gap) + exponential backoff
on 429/−32005 + retry-until-complete (the free tier throttles under burst — a naive burst
dropped 37% of txs — but always completes with backoff; target 100% completeness, not speed) +
immutable Redis cache (`closed_pos_solana_v1`) so the ~25–40k-CU scan is paid ONCE per wallet.
Budget: ~750–1,190 fresh Solana wallets/month on the free 30M CU; paid tier only at sustained
hundreds of NEW Solana wallets/day.

**Carry-overs (not blockers):**
- **⚠️ DEPLOY BLOCKER for closed-Solana in production: `ALCHEMY_SOLANA_RPC` must be added to
  Vercel env vars** (Settings → Environment Variables — it currently exists only in
  `.env.local`). The engine degrades gracefully without it (returns no closed positions,
  never errors), so production silently shows NO Solana Capital G/L until the var is set.
- **Closed positions are counted everywhere but not yet shown as Closed rows** — Sui
  (Cetus/Bluefin/Momentum) AND now Solana (Orca) closed positions fold into Capital G/L +
  Fee Income but have no dashboard/Closed-tab rows (queue item "UI for closed rows").
- **Sheet reconciliation gap (~$610) is valuation basis, NOT a scan miss:** Osho's Business
  P&L records ~$2,370 Orca fees vs $1,760.01 on-chain (`collect_fees` complete, 0 dropped
  legs, rewards $0) — the delta is DeFiLlama daily-close vs sheet-recorded prices on
  volatile-ZEC days. Chain is authoritative; the 19-row table in
  `reports/sprint-3-free-phase-b-report.md` is the line-by-line reconciliation artifact.
- **First-ever scan latency per Solana wallet is ~40–120 s** (background, non-blocking,
  paced free-tier scan) — paid once per wallet, then Redis-warm (~0.2–0.8 s) for every
  instance/user thereafter. Do not "optimize" this by burst-parallelizing: the free tier
  drops ~37% of txs under burst (Phase A proven); backoff-to-100% is the requirement.
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
- **Sprint 1.13 cold-load full-page browser timing not headlessly measured** —
  verified structurally + warm baseline (~8s); eyeball on the deploy.
- **Token-resolver coverage** — Tier 2 routes (uniswap/v3, pancakeswap) + activity
  routes still use hardcoded maps; future sprint migrates + removes them (Rule 9).
- **Sprint POSITION-DETAIL numeric-eyeball follow-up (`82d4954`)** — the Sui pending-reward
  reads were proven numerically on Cetus ($81.10 vs on-chain $81.09) but only STRUCTURALLY on
  Bluefin/Momentum (no live non-zero pending-reward position existed in the test sample; code
  is identical to the proven Cetus path). **The first time a live Bluefin or Momentum position
  has non-zero pending rewards, eyeball DefiDesh's Uncollected total against the protocol app**
  to confirm the numeric match. Contract invariant (k).

---

## Sprint queue

In order. One active at a time. Each sprint must ship before the next begins.
_(Sprint 4 — clickable Capital G/L breakdown — is the ACTIVE sprint above.)_

1. **Raydium closed positions** — extend the Sprint 3-FREE Solana engine
   (`solanaClosedPositions.ts`) to Raydium CLMM: same Alchemy paced scan + same
   value-by-on-chain-mint cascade; Raydium discriminators + account layout are the only new
   work. No known user impact yet (Account 1 has 0 Raydium positions) — ship when a real
   Raydium user need appears or bundle with the next Solana-touching sprint.
2. **Sprint POSITION-DETAIL-2** — the deferred pending-reward paths from Sprint POSITION-DETAIL
   (`82d4954`): **B3** Solana pending rewards (Orca whirlpool `rewardInfos` offsets already
   documented in orca/route.ts comments; Raydium equivalent) so Orca/Raydium detail pages show
   reward emissions like the Sui ones now do; **B4** EVM gauge emissions (Aerodrome/Velodrome
   staked AERO/VELO via the gauge `earned()`) — **staked EVM positions (e.g. Osho's Aerodrome
   WETH/USDC) UNDER-REPORT uncollected value vs the protocol UI until B4 ships**. Same Contract
   invariant (k): value pending rewards at current spot (Rule 2), never a fee-claim (Rule 1a).
3. **Sprint PERFORMANCE-2 (hardening candidates)** — the deferred Phase A items:
   **#4** Redis-cache the Aerodrome positions route's ever-owned tokenId scan +
   closed-position reconstruction (~30 s, the remaining first-load straggler — non-blocking
   behind the "still scanning" chip); **#5** Redis-cache CLOSED positions' activity route
   outputs (immutable — extend the Sprint 1.14 deposit-cache pattern beyond HyperEVM);
   **#6** move `withActivityRouteCache` success results to Redis (5-min TTL, errors never
   cached) so route outputs are shared across instances/users.
4. **Orca APR-fallback + reward-eyeball verification** — the deferred numeric eyeballs:
   (a) the Sprint POSITION-DETAIL derived-APR fallback on the new open Orca positions
   (ZEC/USDC showed ~213.4% at ship; re-ranged since) vs the Orca app; (b) Contract
   invariant (k) — the first live non-zero Bluefin/Momentum pending reward vs the protocol
   app (code-identical to the proven Cetus path, verified structurally only).
5. **UI for closed Sui + Solana positions** — Closed tab support (Sui + Solana closed
   positions are retrieved for Capital G/L but not yet shown as Closed rows).
6. **tokenResolver coverage + cleanup** — migrate Tier 2 (uniswap/v3,
   pancakeswap) and the activity routes to `resolveToken`, then remove the
   per-route `KNOWN_COINS`/`KNOWN_TOKENS`/`TOKENS` maps once resolver coverage is
   proven in production (architecture-principles Rule 9).
7. **EVM per-event token resolution (hardening, not blocking)** — apply the Sprint
   TOKEN-RESOLUTION per-event pool-context pattern to the EVM wallet-scope fee scans
   (aerodrome/velodrome/uniswap). EVM is NOT currently broken — its fallback addresses are
   correct and Sprint 2.1b (`5b8f6b7`) routes closed positions through per-position scans
   with correct context, so the single-representative-pool risk is mitigated — but resolving
   each Collect event's token0/token1 from its pool on-chain would remove the last residual
   of the same bug class. Verify-and-document only until a real EVM user impact surfaces.
8. **Sprint SPOT-RESILIENCE-V2 (optional, non-blocking)** — the fuller version of the spot
   fix: `null`/"pending" propagation from `fetchCachedCoinGeckoPrices` through the position
   type + `useLpPnl` + `positionPnl` + a distinct softer UI banner ("Price refreshing…"), plus
   per-tier staleness caps (Tier B 10-min LKG / Tier C pending-not-LKG). Sprint SPOT-RESILIENCE
   `92e779a` already resolves the bogus banner via LKG; V2 is a larger, higher-risk change —
   **ship ONLY if a user-visible need emerges** (e.g. a genuinely-dead token showing a stale
   price is judged confusing). Not currently planned.
9. **Sui wallet-scope tx-history scan latency (optional, non-blocking)** — after Sprint
   SUI-HISTORICAL-REDIS `776fcaa` the Sui wallet-scope routes drop from ~111 s to ~18–20 s; the
   residual floor is the **~17 s public-Sui-RPC `queryTransactionBlocks` + `multiGet` scan** (240
   digests / wallet). A future sprint could cache the wallet's parsed tx-history / event set
   cross-instance (immutable ledger) or use a faster RPC. **Address only if <10 s becomes a UX
   need** — the Fee-Income regression is already resolved at ~18–20 s.

---

## Recent fixes

Most recent first. Commit hashes are authoritative; descriptions are
shorthand.

- **`d1bf447`** — Sprint 3-FREE: Solana (Orca) closed-position Capital G/L on FREE Alchemy
  infra. **MILESTONE: cross-chain Capital G/L COMPLETE across EVM + Sui + Solana** — the
  planned $49/mo Helius upgrade was never needed. NEW `app/lib/solanaClosedPositions.ts`
  (mirrors `suiClosedPositions.ts`): paced `ALCHEMY_SOLANA_RPC` wallet-history scan (serial
  20-tx batches + exponential backoff + retry-until-complete — Helius free could NOT complete
  this; Alchemy free throttles but finishes 100%), Orca Whirlpool Anchor-discriminator parse,
  **vault-transfer-matched** reconstruction, closed = ever-opened − currently-owned (live
  `getNftMints` — handles re-ranging), historical-only valuation (stable $1 →
  DeFiLlama-by-mint → CG-historical-by-resolver-cgId → pending; **never spot**, Rule 1a),
  Capital G/L = withdrawal − deposit (Rule 4), reuses `computePositionPnL` (no per-chain
  branches), Redis `closed_pos_solana_v1:orca:{wallet}` (30 d, immutable contract,
  empty-never-cached). NEW `/api/solana-closed-positions`; `useLpPnl` "Solana" in
  `CAPITAL_GL_CHAINS` + `solanaClosedRef`; `useWalletLevelFees` folds closed-Orca fee claims
  into Fee Income (txHash+amount dedup); label → "EVM + Sui + Solana (Orca)". **Bundled mint
  cleanup (invariant i):** wrong ZEC + invalid placeholder ORCA entries deleted from
  orca/route.ts + solana/balances; verified ZEC `A7bdiYdS…` pinned in `tokenConstants.ts`
  (dec 8, `omnibridge-bridged-zcash-solana`). **Two engine bugs found in B7 and fixed
  architecturally:** (1) the position's account index VARIES by instruction (collect_fees
  idx 2; liquidity instrs idx 3 — extra authority account) → identify by ever-opened-set
  match, never a fixed index; (2) 14 deposits used a non-standard Orca liquidity-add
  discriminator (`effb097c…` ≠ sha256 of any known name) → unclassified instrs are inferred
  from vault-transfer DIRECTION (all-in = deposit, all-out = withdrawal), no opaque hex
  hardcodes. Verified (B7): 19 closed positions, fees **$1,760.01**, Capital G/L
  **−$1,818.78**; 3 ground-truth PDAs reconcile to ≤$0.09 (ZEC/USDC `FDhkNvkf` $657.84 Δ$0.00);
  630/630 txs, 0 dropped; **0 pending, 0 spot**; `computePositionPnL` 19/19 byte-identical;
  warm route 0.23 s; A2 unchanged (no Solana); tsc + build clean. **No localStorage cache
  bumps** (closed positions never in the dashboard array; orca/balances outputs
  byte-identical — removed entries were invalid keys that could never match). ~$610
  sheet-vs-chain gap = ZEC valuation basis (chain authoritative); 19-row table in
  `reports/sprint-3-free-phase-b-report.md`. **⚠️ `ALCHEMY_SOLANA_RPC` must be added to
  Vercel env vars.** Raydium closed positions → queue.
- **`82d4954`** — Sprint POSITION-DETAIL: Sui pending REWARD emissions + Estimated-APR
  fallback (position-detail page only). **Bug 1** — the Uncollected panel didn't match the
  protocol's own claimable UI: the Sui routes computed pending TRADING FEES only; pending
  REWARD EMISSIONS were never read (Cetus USDC/SUI `0x63301cc4` showed $64.39 vs the Cetus
  app's $71.42 — the gap WAS the rewards). **Fix (Cetus/Bluefin/Momentum):** compute
  per-rewarder pending amounts from data the routes ALREADY fetch — pool rewarder state
  (`reward_coin_type` + `reward_growth_global`) + the position's per-rewarder checkpoint
  (`reward_growth_inside_last` + `coins_owed*`) + the tick nodes' `reward_growths_outside[]`
  — same Q64 growth math + underflow guard as fees, **zero extra Sui RPC** (all fields ride
  objects already fetched; shapes verified LIVE on-chain, never docs). New
  `app/lib/suiRewardMeta.ts` resolves each reward coin type (invariant (i), never hardcoded)
  and prices it at CURRENT SPOT via the SPOT-RESILIENCE tiered helper (invariant (j) — Rule 2
  current-value domain, so Rule 1a claim valuation is UNTOUCHED). Exposed as optional
  `pendingRewards[]` + `rewardsUsd` on the position type — **SEPARATE from `fees0/fees1`** so
  analytics aggregation over `fees` is byte-identical. Detail-page Uncollected panel adds
  reward rows + folds them into the total (matches "Claimable Yield"). **Bug 2** — Estimated
  APR showed N/A for long-tail pools (ZEC/USDC absent from Orca's pool list; Momentum
  hardcodes `apy 0`). **Fix (`position/[id]/page.tsx`, frontend-only):** when `pos.apy <= 0`,
  derive APR from the position's own observables `(lifetime claimed + uncollected incl.
  rewards) / age × 365 / value`, labeled "derived from position earnings"; guarded to
  "— / too early to estimate" when <24 h or zero earnings; pool-APY path unchanged when a real
  number exists. Any pool, any chain, zero per-token config. Verified (B7, local prod-mode +
  same-minute on-chain recompute): **Cetus total $81.10 vs on-chain claimable $81.09** (reward
  amounts byte-identical); A2 Cetus rewards $17.17; Bluefin/Momentum zero-accrual paths clean
  (**non-zero path verified STRUCTURALLY — code-identical to the proven Cetus path; must be
  eyeballed vs the protocol app the first time a live non-zero Bluefin/Momentum reward
  exists**); ZEC/USDC N/A → ~213.4% derived; SOL/USDC +97.3% unchanged; A2 Cetus `fees 149.51`
  byte-identical local vs prod. tsc + build clean. **No cache bumps** (fees byte-identical;
  rewards additive). **B3 (Solana pending rewards) + B4 (EVM gauge emissions) → Sprint
  POSITION-DETAIL-2.** Full B7 report in `reports/position-detail-phase-b-report.md`.
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
- _(Sprint MOMENTUM `750f566` — Momentum (Sui) activity route + closed-position Capital G/L;
  completed Sui Capital G/L across all three Sui CLMM protocols (Cetus, Bluefin, Momentum);
  A1 −$306.59 / A2 $0, 0 spot, 0 pending; cache bumps lp-pnl-events v27 /
  analytics-activity v19 — rolled off this list; see git history.)_
- _(Sprint EMAIL `5b583f7` — homepage ship-notification email capture: `POST /api/subscribe`
  + `subscribers` table (email-only list, NOT accounts), server-side validation, idempotent,
  no existence leak, 5/IP/hr rate limit; `ShipNotifications` client component — rolled off this
  list; see git history.)_
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
rewards historical-only via `reward_coin_type`, no spot+LKG exception). **Solana (Orca)
closed-position Capital G/L shipped in Sprint 3-FREE (`d1bf447`) — cross-chain Capital
G/L is now COMPLETE across EVM + Sui + Solana** (Raydium queued; no user impact yet).

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

**Solana closed positions — RESOLVED for Orca in Sprint 3-FREE (`d1bf447`).**
The position NFT is burned on close, but `app/lib/solanaClosedPositions.ts`
reconstructs each lifecycle from wallet tx history via the FREE Alchemy endpoint
(`ALCHEMY_SOLANA_RPC` — the paid Helius upgrade was never needed) and folds
Capital G/L + fees into `useLpPnl`/`useWalletLevelFees` (Redis-cached
`closed_pos_solana_v1`, immutable). Remaining gaps: **Raydium** closed positions
(queue item 1 — same engine, Raydium discriminators; no known user impact yet)
and Closed-row UI (queue item 5, shared with Sui). ⚠️ Production requires
`ALCHEMY_SOLANA_RPC` in Vercel env vars — without it the engine degrades
gracefully to "no Solana closed positions" (no errors, silently incomplete).

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
- Alchemy — EVM chains; **Solana archival tx-history (`ALCHEMY_SOLANA_RPC`, free tier,
  Sprint 3-FREE)** — powers the closed-position wallet scan (~25–40k CU once per wallet,
  ~750–1,190 fresh Solana wallets/month on the free 30M CU/mo; paced scan REQUIRED — the
  free tier drops txs under burst but completes 100% with backoff). ⚠️ Must be set in
  Vercel env vars (currently `.env.local` only).
- Helius — Solana dashboard/positions routes (`HELIUS_API_KEY`). The $49/mo paid upgrade
  once planned for closed-position tx history is NO LONGER NEEDED (Alchemy free covers it).

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
- `closed_pos_solana_v1` (Sprint 3-FREE `d1bf447` — Upstash Redis cache of reconstructed
  CLOSED Solana (Orca) positions' Capital G/L + fees, keyed
  `closed_pos_solana_v1:orca:{wallet}`, 30d TTL, Sprint 1.14 immutable contract
  (empty-never-cached, fire-and-forget, no-op stub without env). Caches a COMPUTED
  valued result → versioned key; bump on a closed-position valuation-logic change.
  `lp-pnl-events`/`analytics-activity` NOT bumped for Sprint 3-FREE — closed Solana
  positions were never in the dashboard positions array, so cached contents are
  byte-identical (same reasoning as Sprint 2.2b). Env: `PRICE_CACHE_KV_*`)

---

## Business context

DefiDesh is in trust-building phase. No subscription revenue yet. Only
paid infrastructure is Vercel Pro ($20/month). Paid services deferred
until traffic justifies: CoinGecko paid (~$129/mo at 100+ daily users),
Chainstack archival (~$49/mo, would drop HyperEVM CG workaround). The
Helius $49/mo upgrade once planned for closed-Solana history is OFF the
list — Sprint 3-FREE delivered it on Alchemy's free tier (~750–1,190
fresh Solana wallets/month; a paid Alchemy tier only becomes relevant at
sustained hundreds of NEW Solana wallets/day, since closed-position scans
are once-per-wallet then Redis-cached).

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
