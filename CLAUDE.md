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

**Sprint EMAIL: Homepage email capture.**

**Goal:** One-day sprint — add an email-capture field to the homepage (waitlist /
updates). Server-side store; **no wallet coupling** (wallet-security forward-looking
note: gating/identity must stay architecturally separate from wallet logic, and
this is a no-wallet feature). Validate + persist server-side; no client-only store.

**Hard constraint:** investigate-first; additive; server-side persistence only;
keep wallet logic untouched (wallet-security forward-looking note).

**Status:** Not started.

**Note — Sprint 2.2b (Sui closed-position Capital G/L) shipped as `bb7fc0d`:** closed
Cetus + Bluefin positions are now reconstructed from wallet tx history (their objects
are destroyed on close) and folded into Capital G/L alongside EVM; UI label is now
"EVM + Sui (Cetus, Bluefin)". See Recent fixes. **Closed-position valuation cascade
(per side; NEVER current spot — Rule 1a):** stablecoin → $1 (tokenConstants) →
event-captured `current_sqrt_price` at the deposit/withdrawal **block**
(historical-by-construction, the Sui analogue of Sprint 2.1b's EVM sqrtPriceX96
archive read — NOT a current/spot query) → DeFiLlama historical-by-coin-type →
CoinGecko SUI historical → pending. Deposits/withdrawals take the sqrtPrice path; fee
claims (which carry no sqrtPrice) take historical-per-side. **Future protocol
additions inherit this cascade** via `app/lib/suiClosedPositions.ts` (Protocol
Correctness Contract). Reward claims are NOT valued in the closed-position path (Cap
G/L excludes them — Rule 4; the displayed Fees Collected already recovers closed-Sui
fees+rewards via the existing wallet-scope `positionId=all` pipeline). **Momentum
deferred to Sprint MOMENTUM** — its deposit/withdrawal events are self-contained, but
it's folded in alongside building its activity route. **Sprint 2.2c (FIX-C) queued:**
an open-position SUI fee-claim cg-spot leak found during 2.2b — see Known limitations.

**Carry-overs (not blockers):**
- **Sui closed positions now Capital-G/L-integrated for Cetus + Bluefin only**
  (Sprint 2.2b) — Momentum's 2 closed positions and the Solana closed positions are
  still excluded (Sprint MOMENTUM / Sprint 3).
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

In order. One active at a time. Each sprint must ship before the next
begins.

1. **Homepage email capture** (active, Sprint EMAIL) — one-day sprint: add an
   email-capture field to the homepage (waitlist / updates). Server-side store; no
   wallet coupling (wallet-security forward-looking note).
2. **Momentum activity route + closed-position integration** (Sprint MOMENTUM) —
   build the Momentum activity route modeled on Bluefin (Rule 1a historical-only
   fee-claim cascade from the start: stable → $1; SUI → CG-historical → DeFiLlama;
   other non-stable → DeFiLlama; else pending; no spot — the Bluefin `17c5101`
   template), AND fold Momentum's closed positions into Capital G/L via the Sprint
   2.2b `suiClosedPositions.ts` lib (add `'momentum'` to `SuiClmmProtocol`; its
   deposit/withdrawal events are self-contained — verified Sprint 2.2 Phase A).
3. **Sui open-position fee-claim FIX-C hardening** (Sprint 2.2c) — Cetus + Bluefin
   *open*-position fee USD can fall to cg-spot via `getCachedSuiPriceForTimestamp`'s
   FIX-C `spotFallback` on a CoinGecko-historical miss, before DeFiLlama is tried
   (Rule 1a leak). Point those routes' SUI side at the new `getHistoricalOnlySuiPrice`
   → DeFiLlama → pending (the Sprint 2.2b closed-position path). See Known limitations.
4. **Closed Solana position fee recovery via Helius** (Sprint 3) — Solana event
   indexer; parse Orca/Raydium program instructions from wallet tx history; feeds
   Capital G/L.
5. **Clickable Capital G/L breakdown** (Sprint 4) — trust-through-transparency:
   make the Capital G/L figure expand to a per-position breakdown (deposited vs
   withdrawn USD, per closed position) so users can verify the number. The Sprint
   2.2b `SuiClosedPosition` summary fields are already shaped for this.
6. **UI for closed Sui + Solana positions** — Closed tab support (Sui closed
   positions are now retrieved for Capital G/L but not yet shown as Closed rows).
7. **tokenResolver coverage + cleanup** — migrate Tier 2 (uniswap/v3,
   pancakeswap) and the activity routes to `resolveToken`, then remove the
   per-route `KNOWN_COINS`/`KNOWN_TOKENS`/`TOKENS` maps once resolver coverage is
   proven in production (architecture-principles Rule 9).

---

## Recent fixes

Most recent first. Commit hashes are authoritative; descriptions are
shorthand.

- **`bb7fc0d`** — Sprint 2.2b: Sui closed-position Capital G/L integration for Cetus +
  Bluefin (Sprint 2.2 Phase A was the read-only investigation that approved this). A
  closed Sui CLMM position's object is DESTROYED on close, so `suix_getOwnedObjects`
  can't return it (unlike an EVM NFT). New `app/lib/suiClosedPositions.ts` reconstructs
  each closed position's lifecycle from wallet tx history (the SAME
  `suix_queryTransactionBlocks` + multiGet the activity routes already run; closed =
  ever-opened ∧ not-currently-owned) and values it via the historical-ONLY cascade
  (stable $1 → event-captured `current_sqrt_price` at the deposit/withdrawal BLOCK,
  historical-by-construction like the 2.1b EVM sqrtPriceX96 archive read, NOT spot →
  DeFiLlama-historical → CG-SUI-historical → pending), then reuses the EVM engine
  `computePositionPnL` so `capitalGL = closingValue − initialValue` (Rule 4; fees
  separate). New `/api/sui-closed-positions` route; `useLpPnl` folds results into
  `capitalGL` alongside EVM (`'Sui'` added to `CAPITAL_GL_CHAINS`) via a SEPARATE ref
  immune to the positions-array eviction. Rule-1a hardening: added
  `getHistoricalOnlySuiPrice` (reads ONLY the pure historical cache, never the FIX-C
  cg-spot `spotFallback` that `getCachedSuiPriceForTimestamp` can return). Redis cache
  `closed_pos_sui_v1` (Sprint 1.14 immutable contract: 30d TTL, own client, no-op
  stub, fire-and-forget, never cache empty); cold ~49s scan → warm ~1s. New
  `[PRICE_LOG] sui_closed_position_valued`. **lp-pnl-events / analytics-activity NOT
  bumped** (their per-position event caches are byte-identical — closed Sui has its
  own key). UI label "EVM only" → "EVM + Sui (Cetus, Bluefin)". Reward claims NOT
  valued here (Cap G/L excludes them; displayed Fees Collected already recovers
  closed-Sui fees+rewards via the wallet-scope `positionId=all` pipeline). Verified
  (both accounts, per-position reconciled vs on-chain tx digests, user-approved at the
  B7 gate): A1 Sui contribution −$6,792.57 (27 pos), A2 −$13,578.28 (25); combined Cap
  G/L A1 ~−$3,571→−$10,364, A2 ~−$1,861→−$15,439 (~3% off the Phase A daily-price
  estimates, the gap is sqrtPrice exact-block vs daily); 0 pending, 0 spot across all
  52; build+tsc clean. **Momentum deferred to Sprint MOMENTUM; FIX-C → Sprint 2.2c.**
- **`17c5101`** — Sprint NEW: Bluefin fee claims historical-only — the LAST cg-spot
  fee-claim leak on the platform. Sprint 1.15's investigation flagged that Bluefin
  (and Momentum) carried the same latent FIX-A pattern Cetus had. CONFIRMED in the
  Bluefin activity route: fee claims started `pxA=fallbackA`/`pxB=fallbackB` (current
  spot query params) and set `usdAtTime` non-null whenever any spot was passed,
  PRE-EMPTING the Sprint 1.12 DeFiLlama block (which only fired when
  `usdAtTime==null`) — so DeFiLlama was effectively dead code for fee claims and the
  SUI/non-stable sides rode current spot on cold-cache loads (Rule 1a leak). FIX
  (REPLACE, user-approved like 1.12/1.15/2.1b): a dedicated `else if (ev.type ===
  'fee_claim')` branch placed before the deposit/withdrawal spot last-resort, valuing
  fee claims claim-date historical-ONLY per side — stablecoin → $1; SUI →
  CoinGecko-historical → DeFiLlama-historical → pending; other non-stable →
  DeFiLlama-historical → pending; NO spot. DeFiLlama is folded in as a first-class
  historical tier and the prewarm is WIDENED to include the SUI side (cold CG-history
  SUI miss → DeFiLlama, not spot), mirroring Cetus 1.15. Deposit/withdrawal spot
  last-resort (Rule 2) PRESERVED; reward branch PRESERVED byte-identical (Bluefin
  reward events carry only a symbol, no coin type; empirical historical migration
  deferred, same caution as the CETUS spot+LKG exception). **MOMENTUM was a no-op** —
  dashboard-only, NO activity route / NO fee-claim path (unsupported in `useLpPnl`),
  so no leak; its cascade is deferred into the future "Momentum activity route"
  sprint. Cache bumps: bluefin-activity v3→v4, analytics-activity v16→v17,
  lp-pnl-events v24→v25. Verified (Account 2, Bluefin wallet-scope, spot priceA=2.0
  passed like prod): fee claims 19/19 historical (10 defillama-historical + 9
  sui-historical), **0 cg-spot / 0 unknown**; route_summary 38/38 resolved 0 failed;
  defillama_historical 10 used / 0 missing / 0 error; the 10 cg-spot in the breakdown
  are all REWARD claims (untouched path); build+tsc clean. **Platform-wide: Rule 1a
  now fully enforced — every fee claim on every protocol on every chain is historical
  only** (sole exception: CETUS reward-token spot+LKG, a designated source not a
  fallback).
- **`5b8f6b7`** — Sprint 2.1b: Aerodrome/Velodrome closed-position Fee Income fix +
  cg-spot Rule 1a cleanup. Investigation (Sprint 2.1, read-only) found the
  long-standing "~$57 vs hundreds" Account-1 Aerodrome symptom is largely resolved
  (1.10/1.11/1.13/1.14 side effects) BUT a residual bug remained: closed
  Aerodrome/Velodrome positions were skipped per-position
  (`useAllPositionsActivity.ts`) and delegated to the wallet-scope `positionId=all`
  scan, which prices EVERY ever-owned tokenId with ONE representative pool context.
  A wallet with 2+ pairs where a non-largest pair is fully closed had that pair's
  Collect events decoded with the WRONG decimals/pool → crushed to ~$0. Account 1's
  closed USDC/cbBTC NFT 50087147: true lifetime fees ~$296 shown as $0.21; Aerodrome
  Fee Income $1,277.67 vs true ~$1,576. FIX (REPLACE, user-approved like 1.12/1.15):
  closed Aerodrome/Velodrome positions with resolved token context (token0Address +
  token1Address + poolAddress all present) now flow through the SAME per-position
  scan used by Capital G/L + the LP P&L "Fees Collected" card; wallet-scope retained
  as a SAFETY NET for context-less burned positions; analytics Fee Income dedup now
  keys on (protocol, txHash, **logIndex**) — propagated from both EVM V3 routes — so
  per-position values win over the wallet-scope duplicate. BONUS (Rule 1a): the
  cg-spot last resort is REMOVED from the Aerodrome AND Velodrome activity routes;
  fee claims value historical-only (sqrtPriceX96 archive → CoinGecko historical →
  DeFiLlama historical-by-contract, prewarmed only for sqrtPrice-missed claims →
  pending), same template as Cetus 1.15. Cache bumps: analytics-activity v15→v16,
  lp-pnl-events v23→v24. Verified (Account 1): cbBTC $0.21→~$296; merged Fee Income
  ~$1,576; 45/45 wallet-scope claims deduped (per-position wins); **0 cg-spot for
  aerodrome/velodrome fee claims** (3 formerly-leaking claims now defillama-
  historical); Capital G/L computation path byte-identical (A/B stash-proven
  old==new — the −$2,670→−$2,755 numeric drift is pre-existing sqrtPrice-archive
  run-to-run variance on one single-sided withdrawal block, NOT this fix);
  build+tsc clean. Velodrome fix is platform-prophylactic (Account 1 has 0
  Velodrome positions). **Bluefin/Momentum still carry the spot-fee-claim leak →
  now the active sprint.**
- **`4752416`** — Sprint 1.15: Cetus fee claims route through DeFiLlama historical
  before any spot (Rule 1a fix). Eliminates the latent FIX-A violation surfaced in
  1.12: Cetus FEE claims fell back to CURRENT cg-spot when CoinGecko SUI-historical
  missed (cold/rate-limited) or for a non-SUI/non-stable side, and the USDC stable
  side was priced off the current-spot fallback rather than $1-anchored. Fix
  (REPLACE, user-approved like the 1.12 Orca decision): fee claims are now valued
  historical-ONLY, per side — stablecoin → $1; SUI side → CoinGecko historical then
  DeFiLlama historical-by-coin-type; any other non-stable side → DeFiLlama
  historical; if a side can't be priced historically the claim stays pending (no
  spot). The cg-spot / FIX-A fee-claim fallback is REMOVED; the 1.12 DeFiLlama
  prewarm is expanded to include the SUI side; the 1.12 null-only DeFiLlama block
  is folded into the cascade as a first-class historical tier (reuses the 1.12
  helper). **Memory #28 CETUS reward-token spot+LKG path PRESERVED** (separate
  reward_claim branch). No cache bump. Verified (Account 2 USDC/SUI): build+tsc
  clean; 3/3 fee claims via sui-historical with USDC=$1; **0 cg-spot for fee_claims**
  (the only cg-spot are 3 reward_claim/CETUS — the designated exception); DeFiLlama-
  SUI fallback warmed + wired (`defillama_historical_used` for 0x2::sui::SUI at all
  3 dates); Bluefin 38/38 unchanged; scope limited to cetus/activity + docs.
  CG-miss→DeFiLlama-SUI proven by construction (CoinGecko can't be forced to miss
  locally). **Bluefin/Momentum carry the same latent pattern → queued follow-up.**
- **`65d6328`** — Sprint 1.14: persist closed-position deposit history in Redis
  (fixes the "Deposit history could not be retrieved" banner on 1 of 4 Account 2
  ProjectX positions, which persisted past Sprint 1.13). DIAGNOSIS: these closed
  positions are retrievable ONLY via Tier 1 (Etherscan V2, `fromBlock=0`). Tier 2
  (Chainstack archive) is a non-functional fallback for them — it scans only the
  last `SCAN_DEPTH`≈5M blocks = **~57 days** at HyperEVM's ~1s block time, but the
  deposits are 68-97 days old (blocks 29.25M-32.5M vs a 33.45M window floor), AND
  a true `fromBlock=0` archive query is **plan-blocked** (`-32002`). So when
  Etherscan's free-tier rate limit throttles Tier 1 for one position under
  concurrent production load, it falls to a Tier 2 that physically cannot find the
  deposit → 0 deposits → analytics excludes the closed (value=0, no client
  fallback) position. Sprint 1.13's dedup cut call VOLUME but can't help when the
  one remaining Etherscan call is throttled. FIX (additive, free-tier): a closed
  position's on-chain history is IMMUTABLE → new `app/lib/depositHistoryCache.ts`
  persists the raw logs in Upstash Redis keyed by `(nftManager, tokenId)`, 30d TTL
  (Sprint 1.6 contract). hyperswap/activity reads it first for closed positions
  (new `tier_used: 'redis-cache'`) and writes on the first complete live success;
  once warmed, every later load — any instance/user, even while Etherscan
  throttles — serves from Redis, never re-hitting Etherscan. CLOSED-only (`closed=1`
  from `pos.status` in both useLpPnl + useAllPositionsActivity); open positions
  never cached. Paired guards: Tier 1 now treats 0 IncreaseLiquidity logs as a
  FAILURE (`etherscan-increase-missing`) instead of a deposit-less "success"; an
  empty result is NEVER persisted. No cache-version bump (persistent Redis, not a
  versioned key; cached logs byte-identical to a fresh retrieval). Verified
  (Account 2, 4 closed ProjectX): build+tsc clean; cold → tier etherscan-v2 +
  Redis key written; restart → tier redis-cache, 0 Etherscan calls, byte-identical
  md5, claims 5/5 resolved, 0 cg-spot (Rule 1a); open-path writes no key; all 4
  persist. Prod Etherscan-throttle not locally reproducible (free key); mechanics
  verified.
- **`2dcd3cb`** — Sprint 1.13: server-side activity-route cache + in-flight dedup
  (HyperEVM cold-load fix). MEASURED root cause of the 3-5 min cold first load:
  the analytics page fetches every position's activity route 2-3× (useAll-
  PositionsActivity + useLpPnl + useWalletLevelFees each build the same URL and
  fetch independently) and the routes had NO server-side cache — so on a cold
  instance each redundant fetch re-ran the full expensive path (HyperEVM Ether-
  scan/archive deposit scan + every CoinGecko-historical claim through the
  process-wide concurrency-1 `withCgPacing` queue), and the extra volume fed
  CoinGecko free-tier 429 retry storms. Warm path was already ~8s (Redis short-
  circuits CG). Fix (additive): new `app/lib/activityRouteCache.ts`
  `withActivityRouteCache` wraps all 9 `/api/{protocol}/activity` GET handlers
  with (1) IN-FLIGHT DEDUP — concurrent identical requests share ONE computation
  (the dominant win, collapses the simultaneous multi-hook burst) and (2) a short
  TTL result cache (cache-versioning Rule 3: 5m success / 60s empty / errors never
  cached). In-process per-instance, keyed by pathname + sorted search params. New
  `[PRICE_LOG]` `activity_cache` event (hit|dedup|miss). Byte-identical by
  construction (a hit/dedup returns the exact route JSON — Rule 1a intact, no new
  CG/spot calls, Sprint 1.12 DeFiLlama path untouched). NO cache-version bump
  (in-process module cache, not a versioned key). Verified (Account 2, 4 closed
  ProjectX + Sui): build+tsc clean; 3 concurrent identical → 1 miss + 2 dedup,
  deposit scan ran ONCE (was 3×); 10 requests / 4 positions → 4 deposit scans (was
  up to 10), 4 miss + 5 dedup + 1 hit; TTL hit 0.04s; byte-identical md5 on
  hyperswap + bluefin; 0 errors, 0 cg-spot for claims, 0 DeFiLlama regression.
  Per-position activity work cut 2-3× → 1× on cold load. Full-page browser timing
  not headlessly measured (eyeball on deploy).
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

**Claim-date historical pricing** (two sources — see pricing-invariants Rule 1c):
- `app/lib/cgPriceHistory.ts` — `fetchTokenPriceAtDate(cgId, ts)`, CoinGecko
  historical (PRIMARY), wrapped by the Sprint 1.6 Redis tier (`redisPriceCache.ts`).
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

**Sui closed positions — Capital G/L RESOLVED for Cetus + Bluefin (Sprint 2.2b
`bb7fc0d`).** The position object is destroyed on close, but `app/lib/
suiClosedPositions.ts` reconstructs the lifecycle from wallet tx history and folds
Capital G/L into `useLpPnl` (Redis-cached `closed_pos_sui_v1`). Remaining gaps:
**Momentum** closed positions are NOT yet included (Sprint MOMENTUM — its events are
self-contained but folded in with its activity route); closed Sui positions are not
yet shown as **Closed rows** in the dashboard/Closed tab (only counted in Capital
G/L — separate queue item); and **reward claims** are not valued in the
closed-position path (Cap G/L excludes them by Rule 4; the displayed Fees Collected
already recovers closed-Sui fees+rewards via the wallet-scope pipeline).

**Sui open-position fee-claim cg-spot leak (Sprint 2.2c, queued).** The Cetus (1.15)
and Bluefin (Sprint NEW) *open*-position fee cascades call
`getCachedSuiPriceForTimestamp` for the SUI side, which can return the FIX-C
`spotFallback` (current cg-spot) when CoinGecko historical misses — BEFORE DeFiLlama
is tried — so an open-position SUI fee claim can be spot-valued under a CG-historical
miss (a Rule 1a leak). Found during Sprint 2.2b; the closed-position path already
avoids it via the new `getHistoricalOnlySuiPrice`. Fix: point the open-position
routes' SUI side at `getHistoricalOnlySuiPrice` → DeFiLlama → pending. Queued as
Sprint 2.2c (after EMAIL / MOMENTUM); not a closed-position-scope issue so deferred.

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
- Neon Postgres
- Upstash Redis (`defidesh-price-cache`, free tier, us-east-1) — persistent
  historical-price cache (Sprint 1.6) + DeFiLlama claim prices (Sprint 1.12,
  `price:historical:defillama:*`) + closed-position deposit history (Sprint 1.14,
  `deposit:logs:hyperevm:{nftManager}:{tokenId}`, 30d TTL). Env:
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
- `lp-pnl-events-v25` (Sprint NEW — Bluefin fee claims historical-only,
  current-spot fallback removed; parity with analytics-activity v17. NOT bumped in
  Sprint 2.2b — its per-position event cache is byte-identical; closed Sui has its
  own key)
- `analytics-activity-v17` (Sprint NEW — Bluefin fee claims historical-only
  re-resolve in lockstep with LP-P&L. NOT bumped in 2.2b — same reason)
- `cetus-activity-v3`
- `bluefin-activity-v4` (Sprint NEW — Bluefin fee claims valued claim-date
  historical-only: stable → $1; SUI → CG-historical → DeFiLlama; other
  non-stable → DeFiLlama; else pending; current-spot fallback removed, Rule 1a)
- `closed_pos_sui_v1` (Sprint 2.2b — Upstash Redis cache of reconstructed CLOSED
  Cetus/Bluefin positions' Capital G/L, keyed `closed_pos_sui_v1:{protocol}:{wallet}`,
  30d TTL, Sprint 1.14 immutable contract. Bump to invalidate on a closed-position
  valuation-logic change. Env: `PRICE_CACHE_KV_*`, shared Upstash DB — avoid flushes)

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
