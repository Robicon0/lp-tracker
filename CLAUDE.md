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

**Sprint 1.13: HyperEVM cold-cache performance.**

**Goal:** Reduce the HyperEVM cold-start cost so the FIRST user of a cold Vercel
instance doesn't pay the full serialized CoinGecko-historical + archive-scan
penalty. Two known cost sources (see Known limitations): (1) the per-IP-paced
CoinGecko historical prewarm (`withCgPacing`, concurrency 1, ~1.1s gap) which
makes a closed HyperEVM position with N unique claim dates take ~N×1.1s cold,
and (2) the Tier-2 Chainstack archive scan (~500 chunks, ~100s under burst when
Etherscan Tier 1 is exhausted). Investigate-first: measure where cold-start time
actually goes (the `deposit_retrieval.latency_ms` + `route_summary.duration_ms` +
redis hit-rate fields already exist), then target the dominant cost. Note Sprint
1.12 added DeFiLlama historical as a Redis-cached secondary source — but DeFiLlama
has NO HyperEVM coverage, so HyperEVM claims still rely on CoinGecko + the Redis
warm-path; cold-cache HyperEVM remains the target here.

**Hard constraint:** additive-only; Rule 1/1a unchanged (no spot for claims);
no cache bump unless cache shape changes. Conservative params accommodate the
slowest chain (architecture Rule 6).

**Status:** Not started — investigate-first.

**Carry-overs (not blockers):**
- **Cetus FIX-A cg-spot for claims (latent Rule 1a deviation)** — surfaced in
  Sprint 1.12 verification: Cetus values a non-SUI/non-stable fee-claim side at
  CURRENT cg-spot (`app/api/cetus/activity/route.ts` FIX-A, documented
  CoinGecko-budget tradeoff, pre-existing — NOT introduced by 1.12). Sprint 1.12
  left it untouched (its DeFiLlama branch is additive null-only and the spot
  fallback pre-empts it). Candidate follow-up: route Cetus claims through
  DeFiLlama claim-date historical before the spot fallback (a "replace", needs a
  decision like the Orca one in 1.12).
- **Sprint 1.12 Solana route not live-exercised** — Account 1's Orca ZEC/USDC +
  SOL/USDC positions are freshly opened (deposit-only, no fee claims), so the new
  Solana DeFiLlama claim path wasn't exercised end-to-end on a reachable wallet.
  Helper proven by canary; production `defillama_historical_used` /
  `fee_claim_resolution source=defillama-historical` logs will confirm rescue.
- **Token-resolver coverage** — Tier 2 routes (uniswap/v3, pancakeswap) + activity
  routes still use hardcoded maps; future sprint migrates + removes them (Rule 9).
- **Bluefin/Momentum guard live-verification** still pending (no live Sui CLMM
  position on queryable wallets). Byte-identical for healthy positions.

---

## Sprint queue

In order. One active at a time. Each sprint must ship before the next
begins.

1. **HyperEVM cold-cache performance** (active, Sprint 1.13) — cut the cold-start
   CoinGecko-historical + archive-scan penalty for the first user of a cold
   instance. Investigate-first; additive; Rule 1/1a unchanged (see Active sprint).
2. **HyperEVM deposit-history retrieval reliability** (Sprint 1.14) — harden the
   3-tier deposit-history fallback (Etherscan V2 → Chainstack archive →
   client-fallback) so `deposit_retrieval` failures (`all-tiers-exhausted`,
   `etherscan-429`) don't drop closed-position deposits.
3. **Account 1 Aerodrome accounting investigation** (Sprint 2.1) — reassess the
   "~$57 vs hundreds" symptom; Sprint 1.11 likely fixed the closed-position
   Capital-G/L half. Fresh diagnostic over open + closed + activity vs
   Google-Sheet ground truth only if the symptom persists.
4. **Sui closed positions via RemoveLiquidityV2Event** (Sprint 2.2) — recover
   closed Sui positions from on-chain events (objects destroyed on close).
5. **Closed Solana position fee recovery via Helius** (Sprint 3) — Solana event
   indexer; parse Orca/Raydium program instructions from wallet tx history.
6. **Closed Sui position fee recovery** — Sui event indexer on free public RPC.
7. **Momentum activity route** — modeled on Bluefin, uses the Sui indexer.
8. **Capital G/L expansion to Sui + Solana** — wire indexed events into the
   Capital G/L sum. Remove "EVM only" UI label.
9. **UI for closed Sui + Solana positions** — Closed tab support.
10. **tokenResolver coverage + cleanup** — migrate Tier 2 (uniswap/v3,
   pancakeswap) and the activity routes to `resolveToken`, then remove the
   per-route `KNOWN_COINS`/`KNOWN_TOKENS`/`TOKENS` maps once resolver coverage is
   proven in production (architecture-principles Rule 9).

---

## Recent fixes

Most recent first. Commit hashes are authoritative; descriptions are
shorthand.

- **`5bad502`** — Sprint 1.12: wire DeFiLlama historical-by-contract as a
  SECONDARY claim-date price source (CoinGecko historical stays primary). New
  `app/lib/defillamaPriceHistory.ts` (`fetchDefillamaPriceAtDate` /
  `prewarmDefillamaPrices` / `getCachedOnlyDefillamaPrice`) →
  `coins.llama.fi/prices/historical/{ts}/{dlChain}:{addr}`, keyed by on-chain
  contract/mint/coin-type so it prices the Sui/Solana long-tail CoinGecko can't
  map to an id. Own Redis namespace `price:historical:defillama:*` (30d TTL,
  fire-and-forget, no-op stub), in-process + negative + in-flight caches, polite
  rate gate (≤5 concurrent, ≥200ms). 3 new `[PRICE_LOG]` events
  (`defillama_historical_used`/`_missing`/`_error`). **Rule 1a preserved on BOTH
  sources** — DeFiLlama used ONLY via the historical endpoint with the claim's
  own timestamp (±24h same-UTC-day guard), NEVER current/spot; both miss → claim
  stays pending. **Solana (orca/raydium):** DeFiLlama-by-mint is now the PRIMARY
  claim-date source (no CG-historical path existed there) — REPLACES the prior
  current-spot/zero fee-side fallback (Account 1 ZEC/USDC + SOL/USDC return
  price0=0, which dropped the non-stable side to $0); deposits/withdrawals keep
  spot last-resort (Rule 2); added `fee_claim_resolution` instrumentation.
  **Sui (cetus/bluefin):** ADDITIVE fallback — fires ONLY when the existing path
  (on-chain SUI historical + stablecoin $1) leaves a fee claim null; reward claims
  NOT routed through DeFiLlama (CETUS spot+LKG exception preserved; Bluefin reward
  events carry no coin type). HyperEVM unchanged (DeFiLlama has no `hyperliquid`
  coverage — verified). No cache bump. Verified: build+tsc clean; helper canary
  PASS (ZEC $245.71 / SOL $83.37 / Sui DEEP $0.0272 via defillama-historical;
  bogus→missing/null; in-process + Redis cross-process tiers); Account 2
  Bluefin+Cetus byte-identical (0 DeFiLlama events fired); ProjectX 3/3 still
  resolved (Sprint 1.11 intact); 0 `defillama-current` anywhere. Caveats (see
  carry-overs): Solana route not live-exercised (Account 1 Orca positions are
  deposit-only); Cetus has a pre-existing cg-spot-for-claims FIX-A path (out of
  scope, flagged).
- **`d57f051`** — Sprint 1.11: fix cold-cache exclusion of closed HyperEVM
  positions on first analytics load. Root cause was NOT token resolution
  (HYPE/USDC are in hyperswap's hardcoded map; the resolver never touches them):
  `computePositionPnL` gated EVERY position on current price (`price0/price1 > 0`)
  BEFORE the closed-position branch. A closed position's Capital G/L / initial /
  closing / netPnl / fees all come from HISTORICAL events — current price feeds
  only hodlValue/IL (which degrade via `ilAvailable`). So when the position route
  returned `price0=0` (a cold-instance CoinGecko SPOT 429 during the parallel
  8-route analytics fetch; the spot path is un-paced), the wallet's closed
  HyperEVM/ProjectX positions were spuriously excluded — dropped from Capital G/L
  (`CAPITAL_GL_CHAINS` includes HyperEVM) and shown with a bogus "Current price
  data unavailable" banner that vanished on refresh once the 60s spot cache
  warmed (Capital G/L −$2,774 cold → −$1,808 warm). Fix (Approach C, additive,
  1 line in `positionPnl.ts`): gate `price0/price1 > 0` for OPEN positions only;
  closed positions compute from history (IL "unavailable" if current price
  missing). Warm-cache closed positions byte-identical; open unchanged; genuine
  data gaps still exclude via `no_deposits`/`missing_deposit_prices`. No cache
  bump. Verified: build+tsc clean; deterministic unit test 5/5 (closed+price0=0
  now included w/ correct Capital G/L; warm-closed byte-identical; open+price0=0
  still excluded; closed+no-deposits → no_deposits); live smoke 0 regression
  (Orca/ZEC resolution, Cetus pending $348, 0 underflow). The "ProjectX missing
  from Fee Income" half is a SEPARATE root cause (cold historical-claim cache) →
  Sprint 1.12. The 429 trigger isn't locally reproducible (low CG load).
- **`140d908`** — Sprint 1.10: platform-wide automatic token resolution. New
  `app/lib/tokenResolver.ts` (`resolveToken`) + `app/lib/tokenConstants.ts`
  (native tokens + canonical stables per chain — the only pinned identities;
  everything else auto-discovers). Cascade: Redis → hardcoded constants →
  CoinGecko contract lookup (`/coins/{platform}/contract/{addr}`, platforms
  verified live: solana, sui, hyperevm, ethereum, arbitrum-one,
  optimistic-ethereum, base, polygon-pos) → on-chain metadata (authoritative
  symbol+decimals) → CoinGecko symbol search → DeFiLlama coverage check
  (informational only this sprint) → graceful unresolvable (Option A). New
  `[PRICE_LOG]` `token_resolver_used` + `token_resolution_failed`. **Tier 1**
  (cetus, bluefin, momentum, orca, raydium, hyperswap): the LAST-RESORT
  symbol-search fallback now calls `resolveToken`; hardcoded fast paths
  untouched → previously-mapped tokens byte-identical (proven: resolver fired
  0× for every mapped-token position + git-stash A/B identical). **Tier 3**
  (aerodrome, velodrome): unmapped pool tokens resolve symbol+decimals from
  on-chain truth instead of the blind `decimals=18` default — silent
  amount-corruption class eliminated. No cache bump. Verified (Accounts 1&2):
  build+tsc clean; resolver live on unmapped Orca ZEC mint →
  `omnibridge-bridged-zcash-solana` dec 8 (0.03% from old `zcash` path); Cetus
  pending fees intact ($26,495/$346); 0 underflow; 0 resolution-failed.
  **Sprint 2.1 NOT resolved** (Account 1 Aerodrome healthy $8,922, mapped
  tokens — Tier-3 class N/A). Tier 2 (uniswap/v3, pancakeswap) + activity
  routes still queued.
- **`0b9e3a0`** — Sprint 1.8b: Performance Metrics + Yield/APR Projections fall
  back to an uncollected-fees-based estimate for new positions with no claim
  history (were em-dash / N/A from day 1). New shared `app/lib/positionProjections.ts`
  (`computePositionProjection`: claims → uncollected → none). Position detail page
  feeds `actualAPR`/`actualDailyIncome` from it (byte-identical when claims exist)
  and labels the source honestly (Memory #14): "from uncollected (early estimate)"
  vs "from real claims". Yield & APR Projections keep the pool-APY path when
  `hasApr`, else fall back to the uncollected projection (per user decision). Fee
  Income Rate + Estimated APR untouched. UI-only (no route changes, no cache
  bump). Verified: canary math (new ZEC $41.65/1d/$4700 → 'uncollected', 323.5%
  APR, $15,202/yr) + byte-identity for claims; live ZEC input $63.08, apy 0. Browser
  paint not headlessly verifiable — eyeball on deploy.
- **`a6a6e75`** — Sprint 1.8: implement Cetus pending-fee computation
  (platform-wide; was hardcoded `fees:0` since the original integration
  `4339ad87`, March 2026 — every Cetus position worldwide showed $0 uncollected).
  Cetus keeps per-position fee state in the pool's `position_manager`
  LinkedTable (`PositionInfo`: `fee_growth_inside` checkpoints + `fee_owned`),
  NOT on the position object, and tick `fee_growth_outside` in the `tick_manager`
  move_stl SkipList (u64 score = `tickIndex + 443636`). New `computeCetusPendingFees`
  + `fetchCetusTick` (with a defensive returned-index guard) fetch those via
  `getDynamicFieldObject` and compute through the shared `calcFeeGrowthInside` +
  `safeCalcPendingFee` + `emitFeeUnderflow`; `total = fee_owned + guarded delta`.
  New `[PRICE_LOG]` `cetus_pending_fee_computed` + `cetus_pending_fee_read_failed`
  (fallback to 0 on read failure). CETUS reward spot+LKG untouched (separate
  activity route; `rewards[]` never read). No cache bump. Verified: Account 1
  USDC/SUI `$0 → $126.54` (canary $125.09, +1.2%), Account 2 `$260.28`, 0
  read-failed/underflow; ProjectX $1,776.29, redis hits, 0 cg-spot. SKILL.md +
  add-new-protocol note for pool-owned fee-table Sui protocols.
- **`f7842c8`** — Sprint 1.7e: shared CLMM utilities + apply across protocols.
  New `app/lib/clmmFeeMath.ts` (`safeCalcPendingFee` underflow guard +
  `calcFeeGrowthInside` + `emitFeeUnderflow`, moved verbatim from Orca) and
  `app/lib/clmmTickDecoder.ts` (`solanaCLMMTickRegistry` + `anchorDiscriminator`).
  Orca refactored to import/register into them (byte-identical to 1.7d); Bluefin
  and Momentum route their pending-fee math through `safeCalcPendingFee`. Phase A
  finding: protocols aren't uniform — only Orca/Bluefin/Momentum compute pending
  fees; Raydium is settled-only and Cetus returns `fees:0` (guard N/A). Sui ticks
  are JSON dynamic fields (no buffer registry — would be leaky); Solana ticks are
  binary buffers (registry fits). New `.claude/skills/add-new-protocol/SKILL.md`
  (Protocol Correctness Contract) + architecture-principles Rule 8 (shared CLMM
  utils canonical; inline guards/decoders forbidden). Verified: Orca exercises
  BOTH Solana formats live (legacy_fixed + variable_length), 0 underflow/
  unsupported; ProjectX $1,776.29, redis hits, 0 cg-spot. Bluefin/Momentum live-
  verification pending (no test positions). No cache bump.
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

**HyperEVM Tier 2 archive scan is slow under burst.** When Etherscan
(Tier 1) is exhausted and the Chainstack archive fallback fires, scanning
~500 chunks (`SCAN_DEPTH` 5M / `LOG_CHUNK` 10k) at `LOG_CONCURRENCY` 3 +
200ms batch delay can take ~100s per position under concurrent contention
(now visible via the `deposit_retrieval` event's `latency_ms`, observed in
`e1213bd` verification). Within Vercel's 300s function budget and only on
the rare Etherscan-exhaustion path, but a future optimization target.

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

**Sui closed positions not yet retrievable.** Position objects destroyed
on close. Solution exists in plan (event reconstruction); implementation
queued as Sprint 3.

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
  historical-price cache (Sprint 1.6). Env: `PRICE_CACHE_KV_REST_API_URL` +
  `PRICE_CACHE_KV_REST_API_TOKEN` (pass explicitly to the `@upstash/redis`
  client — it auto-reads only `UPSTASH_*`/`KV_*`, not `PRICE_CACHE_KV_*`).
  Connected to Production/Preview/Development; shared, so avoid broad flushes.

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
- `lp-pnl-events-v23`
- `analytics-activity-v15`
- `cetus-activity-v3`
- `bluefin-activity-v3`

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
