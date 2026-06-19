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

**Sprint 1.8c: Slush wallet disconnect on Sui.**

**Goal:** Stop the Sui (Slush) wallet from disconnecting on dashboard→detail
navigation and on refresh. Fully diagnosed (Sprint 1.8 investigation 2026-06-18):
1. The dashboard navigates via `window.location.href` ([dashboard/page.tsx:1809,
   1948], analytics/page.tsx:2360) — a HARD reload that remounts the provider tree.
2. On the reload, `useWallets()` is transiently empty before Slush re-registers,
   and `WalletRestoreEffect.tsx:89-100` then DELETES `dapp-kit:wallet-connection-info`,
   breaking autoConnect → user must manually reconnect.

**Proposed fix (additive):** (a) replace `window.location.href` with Next
`router.push` (client nav, no reload); (b) gate the WalletRestoreEffect deletion
on a STABLE readiness signal (wallets had a chance to register) rather than the
transient mount-time empty.

**Status:** Not started. Sprint 1.8b (`0b9e3a0`) shipped Performance Metrics +
Yield/APR projections for new positions (uncollected-based fallback, honest
source labels). Browser paint for 1.8b not headlessly verifiable — eyeball the
new ZEC position's projections on the deploy.

**Carry-overs (not blockers):**
- **Bluefin/Momentum guard live-verification** still pending (no live Sui CLMM
  position on queryable wallets). Byte-identical for healthy positions.
- **Raydium settled-only** — possible under-reporting enhancement, not underflow.

---

## Sprint queue

In order. One active at a time. Each sprint must ship before the next
begins.

1. **Slush wallet disconnect on Sui** (active, Sprint 1.8c) — replace dashboard
   `window.location.href` with `router.push`; gate the `WalletRestoreEffect`
   deletion of dapp-kit connection state on a stable readiness signal rather than
   the transient empty-`useWallets()` window (fully diagnosed; see Active sprint).
2. **Sui closed positions via RemoveLiquidityV2Event** (Sprint 1.9) — recover
   closed Sui positions from on-chain events (objects destroyed on close,
   events preserved).
3. **Account 1 Aerodrome investigation** (Sprint 2) — diagnostic harness
   against Account 1 wallets to identify missing/wrong/excluded positions
   (manual ~$57 platform vs hundreds expected).
4. **Closed Solana position fee recovery via Helius** (Sprint 3) — Solana event
   indexer; parse Orca/Raydium program instructions from wallet tx history.
5. **Closed Sui position fee recovery** — Sui event indexer on free public RPC
   (Bluefin/Cetus/Momentum package addresses).
6. **Momentum activity route** — modeled on Bluefin, uses the Sui indexer.
7. **Capital G/L expansion to Sui + Solana** — wire indexed events into
   Capital G/L sum. Remove "EVM only" UI label.
8. **UI for closed Sui + Solana positions** — Closed tab support.

---

## Recent fixes

Most recent first. Commit hashes are authoritative; descriptions are
shorthand.

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
- **`d2ff9d6`** — Sprint 1.7d: Orca variable-length (`DynamicTickArray`) tick
  decoder. Sprint 1.7c found the ZEC/USDC underflow was a *symptom*: Orca ships
  two tick-array formats, and the route only decoded the legacy fixed 9956-byte
  `TickArray` (disc 69,97,…; ticks at `12+idx*113`). Pools on the newer
  variable-length `DynamicTickArray` (disc 17,216,246,142,225,199,218,56; header
  60 = disc8+startTickIndex4+whirlpool32+tickBitmap16; then 88 borsh-enum ticks,
  1 byte Uninitialized / 113 Initialized) were read out-of-bounds → `feeGrowthOutside`
  0 → `feeGrowthInside` 0 → underflow → Sprint 1.7 guard zeroed real fees. Fix
  (additive): `fetchTickFeeGrowthOutside` dispatches on the account discriminator;
  legacy path byte-identical; new `readDynamicTick` walks the enum array (fgA/fgB
  at element+33/+49). Layout from orca-so/whirlpools source; discriminators
  confirmed via Anchor sha256; validated vs on-chain sizes. New `[PRICE_LOG]`
  `tick_decoder_used` + `unsupported_tick_array_format`. Guard preserved as a
  safety net (now never fires for ZEC). Verified: ZEC pending `$0 → $141.58`
  (real fees, settled still $0), feeGrowthInside > checkpoint, 0 underflow/
  unsupported events; no regression (Account 2 ProjectX $1,776.29, redis hits,
  0 cg-spot). No live legacy-format Orca position available to exercise; legacy
  decode unchanged.
- **`1dd862c`** — Sprint 1.7: guard CLMM fee-growth underflow in Orca
  pending-fee math. `calcPendingFee` computed `(feeGrowthInside − checkpoint) &
  U128_MASK` with no underflow guard; for out-of-range positions the recomputed
  inside lands marginally below the stored checkpoint, so the unsigned masked
  subtraction wraps to ~2^128 → × liquidity / decimals × price = sextillion-scale
  USD fees. Account 1 ZEC/USDC (Orca) read `$1.908e24`, leaking into analytics
  top-level Unclaimed Fees (`Σ p.fees`) and forcing a `value_overflow` exclusion
  in LP P&L (via `netPnlUSD`). Fix (additive): `calcPendingFee` returns
  `{fee, guarded, wrappedDelta}`; high-bit-set delta (`≥ 2^127`) → 0 for that
  side (a real accrual can't reach 2^127); settled `feeOwedA/B` untouched; both
  token sides symmetric. New `[PRICE_LOG]` `fee_underflow_detected` (per side) +
  `fee_plausibility_exceeded` ($1e12 route-boundary cap). Rule 1b added to
  pricing-invariants.md. No cache bump (`pos.fees` is live, 60s staleTime;
  `lp-pnl-events-v23` caches activity events only). Verified: ZEC `1.908e24 → $0`
  (value $5,176 unchanged), 2 underflow events, 0 cap firings; no regression
  (Account 2 ProjectX $1,776.29, redis hits present, 0 HyperEVM cg-spot).
  **Scope: Orca only — Raydium/Bluefin/Cetus/Momentum follow in Sprint 1.7b.**
- **`5af4d33`** — Sprint 1.6: Upstash Redis persistent price cache. New
  `app/lib/redisPriceCache.ts` (Upstash REST) is Tier 1 above the in-process
  historical-price cache in `cgPriceHistory.ts`: `fetchTokenPriceAtDate` checks
  Redis first (cross-instance, cross-user), falls through to in-process +
  CoinGecko on miss, writes back fire-and-forget (30d TTL). Keyed by
  coingeckoId (`price:historical:{id}:{YYYYMMDD}`, UTC). No-op stub if env vars
  absent. CETUS spot+LKG / Sui historical / stablecoins excluded by
  construction (separate modules / anchored upstream — no per-chain branch).
  New `[PRICE_LOG]` sources `redis-cache-hit/miss/error` + optional
  `route_summary.redis_cache_hits/misses` on the 5 EVM activity routes. Cache
  bumps v22→v23 (lp-pnl-events), v14→v15 (analytics-activity). Verified
  localhost (Account 2 ProjectX): cold-instance/cold-Redis → 5 misses, all
  resolved, 0 errors; restart/warm-Redis → 5 hits, 0 miss, identical $372.89;
  4-position total $1,776.29 (manual $1,780.44, −0.23%); the lone
  transient-pending HYPE claim (2026-03-13) resolves once warmed and persists
  in Redis (37.35, 30d TTL). 0 HyperEVM cg-spot (Sprint 1.5 invariant holds).
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
