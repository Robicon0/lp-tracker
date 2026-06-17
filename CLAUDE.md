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

**Sprint 1.7e: Propagate the CLMM underflow guard to the remaining CLMM
protocols — WITH per-protocol tick-decoder verification.**

**Goal:** Apply the Orca underflow guard (`1dd862c`) to **Raydium, Bluefin,
Cetus, and Momentum** — but, per the Sprint 1.7c/1.7d lesson, **first verify
each protocol's tick / fee-growth decoder reads all current on-chain account
formats**. An underflow firing can be a *symptom of a decoder gap* (as it was
for Orca's DynamicTickArray), not a benign out-of-range zero. For each
protocol: confirm the tick-array/fee-growth account layout against an official
source, add the high-bit (`≥ 2^127` → 0) guard as a safety net, and add
`tick_decoder_used` / `fee_underflow_detected` instrumentation. Do NOT assume a
guard-fire means "fees are zero."

**Status:** Not started. Sprint 1.7 (`1dd862c`) shipped the guard for Orca;
Sprint 1.7c found the underflow was a *symptom* of an unsupported Orca
DynamicTickArray format; Sprint 1.7d (`d2ff9d6`) fixed the Orca decoder so the
guard no longer fires there (ZEC/USDC pending fees $0 → $141.58 real). Each of
Raydium/Bluefin/Cetus/Momentum shares the unguarded masked-subtraction pattern
AND may have its own decoder-format gaps to check.

---

## Sprint queue

In order. One active at a time. Each sprint must ship before the next
begins.

1. **CLMM underflow guard + decoder verification — Raydium/Bluefin/Cetus/
   Momentum** (active, Sprint 1.7e) — port the Orca underflow guard (`1dd862c`)
   to the four remaining CLMM routes, but first verify each one's tick/fee-growth
   decoder handles all current on-chain account formats (per the 1.7c/1.7d
   DynamicTickArray lesson). Reuse the high-bit guard + `tick_decoder_used` /
   `fee_underflow_detected` instrumentation.
2. **USDC/SUI Cetus exclusion inconsistency** (Sprint 1.8) — investigate why a
   Cetus USDC/SUI position is excluded inconsistently between dashboard and
   analytics.
3. **Sui closed positions via RemoveLiquidityV2Event** (Sprint 1.9) — recover
   closed Sui positions from on-chain events (objects destroyed on close,
   events preserved).
4. **Account 1 Aerodrome investigation** (Sprint 2) — diagnostic harness
   against Account 1 wallets to identify missing/wrong/excluded positions
   (manual ~$57 platform vs hundreds expected).
5. **Closed Solana position fee recovery via Helius** (Sprint 3) — Solana event
   indexer; parse Orca/Raydium program instructions from wallet tx history.
6. **Closed Sui position fee recovery** — Sui event indexer on free public RPC
   (Bluefin/Cetus/Momentum package addresses).
7. **Momentum activity route** — modeled on Bluefin, uses the Sui indexer.
8. **Capital G/L expansion to Sui + Solana** — wire indexed events into
   Capital G/L sum. Remove "EVM only" UI label.
9. **UI for closed Sui + Solana positions** — Closed tab support.

---

## Recent fixes

Most recent first. Commit hashes are authoritative; descriptions are
shorthand.

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
- **`f07ff19`** — Sprint 1.5: enforce pricing-invariants Rule 1 for
  HyperEVM fee claims. Removed the current-spot fallback for fee-claim
  valuation (deposits/withdrawals unchanged — Rule 2 spot last-resort
  kept); claims that miss every historical tier now stay UNRESOLVED
  (`usdAtTime` null), never $0, never spot. Prewarm cap 25s→60s. New
  `route_summary.claim_pricing_succeeded` boolean + `pendingClaimCount`
  threaded to a "N claims pending price resolution" analytics notice.
  Cache bumps v21→v22 (lp-pnl-events), v13→v14 (analytics-activity).
  Root cause: Account 2 ProjectX over-reported $2,243.69 vs manual
  $1,780.44 (+26%) — 20 HYPE claims valued at spot (~$63) not claim-date
  (~$41.73) when the awaited prewarm timed out under CG pressure (not
  double-counting; counts reconcile 19≈20≈19+1). Verified localhost:
  0 `fee_claim_resolution` events with `source=cg-spot` across 2 cold
  runs; unresolved claims correctly null + `pending`. Production
  verification pending (Account 2 analytics; expect cg-spot=0, ProjectX
  total near $1,780).
- **`e1213bd`** — HyperEVM deposit-retrieval hardening (Sprint 1).
  Module-level Etherscan V2 concurrency gate (max 3 in-flight, headroom
  under ~5 req/sec) + exponential backoff (1/2/4s) on HTTP-429 and the
  HTTP-200 "Max calls per sec" soft-limit body; falls through to
  Chainstack archive (Tier 2 unchanged) then client fallback (Tier 3).
  New structured `[PRICE_LOG]` `deposit_retrieval` event + `route_summary`
  `deposits_*` fields. Verified: 20/20 retrieval success under 5×
  concurrent burst (Account 2, 4 closed ProjectX), 47 backoffs all
  recovered, 0 cascading failures, 0 dropped positions.
- **`751743b`** — Client data layer architectural pass. Per-endpoint
  concurrency limiter (MAX_PER_ENDPOINT=2), increased attempt timeouts
  (60/60/90s), differentiated cache TTL (success 5min, empty 60s,
  errors uncached), cache version bumped to v21.
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
