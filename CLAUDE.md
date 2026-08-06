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
- EVM wrappers: **vfat / Sickle** (Base, Optimism, Arbitrum, Ethereum) — LP positions held
  in a per-user Sickle contract wallet, discovered via `sickles(owner)` and scanned through
  the existing EVM readers. OPEN positions only; CLOSED are suppressed pending queue item A.
- Solana: Orca + Raydium (both full: open positions, closed-position Capital G/L, lifetime fees)
- Solana wrappers: **DefiTuna** (leveraged LP held in the protocol's vault — OPEN positions
  across BOTH AMM backends, Orca and Fusion, with EQUITY semantics + leverage/debt/
  liquidation detail page. Closed-position Capital G/L NOT yet built — sprint queue item 1.
  DefiTuna's separate LENDING product is not integrated — queue item 2.)
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

**Sprint WRAPPER-PROTOCOLS (Gap 2): positions held via position-manager wrappers.**

**Goal:** LP positions managed by wrapper protocols (DefiTuna on Solana first —
proven usage in Krishna's history; then survey Kamino vaults etc.) are INVISIBLE
today because the position NFT/object sits in the wrapper's vault, not the user's
wallet. Per the completeness directive (2026-07-19), a user with a wrapped
position currently sees NOTHING — a critical missing-position class. Phase A:
enumerate wrapper protocols with real usage, their position-discovery mechanism
(DefiTuna has a public API: api.defituna.com/api/v1/users/{wallet}/tuna-positions
— verified live, returns empty for wallets without positions), and the
Protocol Correctness Contract surface for each. Investigate-first; plan with
Osho before building.

**Status:** Phase 1 SHIPPED (`4c450a1`, 2026-07-20) — DefiTuna OPEN positions live
(hybrid API+on-chain-verify, EQUITY semantics, selfReportedPnl mechanism in useLpPnl).
Phase 2 **Phase A investigation COMPLETE**, **Part 1 SHIPPED** (`4a25c69`, 2026-07-21 —
wrapper detail page), **Part 2 CLOSED with NO code required** (2026-07-21 — Fusion already
works; see below). **Part 3 is the next DefiTuna work**, blocked on the interest-accounting
decision. Investigation artifacts: `reports/wrapper-protocols-phase2-report.md` and
`reports/wrapper-protocols-phase2-part2-fusion-report.md`.

**DefiTuna position-class coverage (census 2026-07-21, on-chain, all three classes).**
Counts are *funded/live* positions (liquidity>0 for LP, deposits>0 for lending) — raw
account counts overstate badly (1,116 LP accounts → only 556 live; 17,512 lending accounts
→ only 7,602 funded), so always filter before quoting a number.

| Position class | Backends | Funded | Wallets | Status |
|---|---|---:|---:|---|
| `TunaLpPosition` | **Orca ✅ + Fusion ✅** | 556 | 318 | **fully covered, both backends** |
| `LendingPosition` | n/a (lending) | **7,602** | **5,640** | **invisible — new backlog item** |
| `TunaSpotPosition` | Orca/Fusion/Jupiter | — | **9** | invisible — **NOT worth building** |

**⚠️ SUPERSEDED: the earlier "Phase 1 covers ~1 of 6 DefiTuna surfaces" claim was WRONG.**
It assumed Fusion needed separate support. It does not — see the Part 2 finding below. LP is
fully covered across both AMM backends; the real remaining gap is LENDING, not Fusion.

**PART 2 FINDING (2026-07-21): Fusion LP already works — it shipped free with Phase 1.**
Fusion usage is real and substantial (168 live positions / **107 wallets** / 30.3% of live
Tuna LP positions; 72 of 107 markets; **$601k = 50.6% of DefiTuna's borrowed capital**), but
requires ZERO new code: Fusion positions are the **same `TunaLpPosition` account type, same
discriminator `4cc5a133e80f89dc`, same 339 bytes, same `authority @ 11`**, and are returned
by the **same `/users/{w}/tuna-positions` endpoint**. `market → pool → provider`
(`"orca"|"fusion"`) is the only distinguisher. `FusionPool` vs `Whirlpool` differs in the
IDL but **DefiDesh never reads the AMM pool account** — Phase 1 consumes the API's embedded
`market.pool` object (mints, `tick_current_index`, `price`, per-mint `decimals`), which the
API normalises across both backends. That Phase 1 design decision is what made Fusion free.
VERIFIED live on the UNMODIFIED route: mixed wallet `6NcbT9g7xDTa…` → **19/19 positions
(12 fusion + 7 orca), equity exact to the cent vs the API's own total−debt, range status
correct on every one, 0 on-chain verification failures**; pure-Fusion wallet
`upgMGFHGxJ58…` → all 7 render. Part 1's detail panel populates fully for Fusion too
(decimals correct 9/6 and 6/6). Liquidation bounds: **every** leveraged position on **both**
backends reports exactly one non-zero bound (0% both-zero); both-zero occurs only at 1.00×
unleveraged, where "n/a" is correct. NOTE: sampled Fusion leveraged positions liquidate on
the **LOWER** bound (Orca sample was UPPER) — Part 1 picks the nearest non-zero bound and
handles both, now confirmed live in both directions.

**Regression wallets for DefiTuna (third-party, use for any future Tuna work):**
`6NcbT9g7xDTaBpAVJGjfQK4jW81KxBA5zH3nPdQVu9od` (19 positions, mixed fusion+orca — best
single regression wallet) · `upgMGFHGxJ58kBxpiEhLzV5AJ9SkZiGx3hxAxc7TZfn` (7, 100% Fusion)
· `2rr3SFuM8YNFcn9RUvqGNPki8rxaXjHDscQuy7wNJTpn` (7, all Orca — the Phase 1 / Part 1 wallet).

Phase A findings (kept for Part 3 / Part 4):
- Program: `tuna4uSQZncNeeiAMKbstuxA9CUkHH6HmC64wgmnogD` (Anchor). Account type is
  `TunaLpPosition` = 339 bytes, owner = tuna program, **authority (user wallet) at byte
  offset 11** — CONFIRMED against the IDL (8 disc + `version:u16` + `bump:[u8;1]`; fields
  sum to exactly 339). Trustless discovery via `getProgramAccounts(memcmp offset 11 =
  wallet)` verified working. **Drop the `dataSize: 339` filter** previously recommended
  here: `version` is the FIRST field, so the layout is explicitly versioned and a future
  `version: 2` may resize. Phase 1's `verifyOnChain` already filters on owner+authority
  only and is safe.
- **⚠️ `getProgramAccounts` is NOT available on the free Alchemy tier** (429s regardless of
  backoff). It must route through Helius. The closed-position scan engine currently runs on
  `ALCHEMY_SOLANA_RPC` — Part 3 must account for this split.
- **The Anchor IDL is PUBLISHED ON-CHAIN** at `EooDyoDKbettJ6dvuuikga95ZLxKa2FifjrCicVm8HmP`
  (Anchor convention: `createWithSeed(findProgramAddress([], program), "anchor:idl",
  program)`); 15,936 bytes, zlib-decompresses to JSON: 66 instructions, 10 account types,
  18 types, full error table. Removes essentially all layout guesswork from Parts 2–4.
- `TunaPositionState` enum = **`Normal | Liquidated | ClosedByLimitOrder`**, and the IDL has
  four `liquidate_tuna_lp_position_*` instructions. A LIQUIDATED position has fundamentally
  different economics (collateral can be wiped, liquidation fee taken) — treating one as an
  ordinary close reports a silently far-too-favourable Capital G/L. Also
  `rebalance_tuna_lp_position_*`: an auto-rebalance must NOT be read as a close.
- Live instruction vocabulary (200-signature scan of `2rr3SFuM…`, 55 tuna txs):
  `OpenAndIncreaseTunaLpPositionOrca` ×17, `DecreaseTunaLpPositionOrca` ×12,
  **`CloseTunaLpPositionOrca` ×12**, `IncreaseTunaLpPositionOrca` ×7,
  **`RepayTunaLpPositionDebt` ×3** (a SEPARATE instruction, sometimes in a different tx from
  the close), `SetTunaLpPositionFlags` ×3, `SetTunaLpPositionLimitOrders` ×2. Anchor
  instruction names appear in PLAINTEXT logs — no discriminator matching needed.
- 117 `Program data:` Anchor events observed, but the IDL publishes **`events: []`** and the
  sample discriminator `e1ca49af932ba096` matched none of 27 guessed names. Event decoding
  is NOT yet possible; Part 3 should use the proven Orca approach (inner SPL transfers
  matched against pool vault addresses) and treat events as an optional precision upgrade.
- Public API (no key): `api.defituna.com/api/v1/users/{wallet}/tuna-positions` returns
  COMPLETE open-position data: total_a/b (LP totals), current_debt_a/b,
  deposited_collateral_a/b, yield_a/b (uncollected), compounded_yield, leverage,
  liquidation prices, ticks, entry_price, pnl_usd, opened_at, market → pool (underlying
  Orca pool, incl. `price` + per-mint `decimals`), plus /markets /pools /vaults /mints
  /oracle-prices.
- **The endpoint returns OPEN positions only.** `?state=closed` / `?status=closed` return
  HTTP 200 with an IDENTICAL item set — the param is SILENTLY IGNORED, not honoured-and-
  empty. (A response md5 diff is just live prices moving in the `markets`/`mints` blocks;
  a field-by-field item diff is zero.) Do not re-conclude "this wallet has no closed
  positions" from a 200. The item schema DOES carry `state`, `closed_at`, `pnl_usd`,
  `initial_debt_a/b`, `leftovers_a/b` — DefiTuna tracks closed state internally and simply
  won't serve it, so **asking them for a history endpoint is a free option worth taking
  before building Part 3**.
- Closed positions are **Category B** (CONFIRMED): `getProgramAccounts(authority=wallet)`
  returns exactly the API's open set (7 = 7, identical addresses, zero extras) despite 12
  `CloseTunaLpPositionOrca` in that wallet's history → accounts are rent-reclaimed on close.
- KEY VALUE SEMANTICS: Tuna positions are LEVERAGED — user's real value = EQUITY
  (total − debt), NEVER the raw LP total (would overstate by the borrowed funds). For a
  CLOSED leveraged position both Rule 4 terms change: deposit = COLLATERAL (not LP total),
  withdrawal = NET of debt repayment, plus `leftovers_a/b` residuals. **Accrued borrowing
  interest has no slot in Rule 4's `withdrawal − deposit` — this needs an explicit
  pricing-invariants decision from Osho and BLOCKS correct Part 3 numbers.**

_(Sprint 4 — clickable Capital G/L breakdown + closed rows — SHIPPED `00cd1bc`
2026-07-20; see Recent fixes.)_

**Carry-overs (not blockers):**
- **✅ RESOLVED 2026-07-21: `ALCHEMY_SOLANA_RPC` corrected in Vercel (production +
  preview).** The var had been set to the BARE API KEY since 2026-07-06 (found live
  2026-07-18: `/api/solana-closed-positions` 500'd with `Failed to parse URL from 7SWf…`,
  so Solana closed Capital G/L was missing from production totals). Fixed via
  `vercel env update ALCHEMY_SOLANA_RPC {production,preview}` to the full
  `https://solana-mainnet.g.alchemy.com/v2/<key>` form, then `35941fa` was redeployed
  (`dpl_FKW7d7QF…`) so the new value took effect. **Note the var is `type: sensitive`, so
  its value is write-only — unreadable via dashboard, `vercel env pull`, or the REST API
  with `?decrypt=true`. Format can never be confirmed by reading it; only by re-setting or
  by behaviour.** VERIFIED by forcing a genuine cold scan: deleted the Redis key
  `closed_pos_solana_v1:orca:{A1}` (backed up first) and re-requested → **93.5 s** live
  Alchemy scan (vs ~0.6 s warm), returning 20 Orca positions, Capital G/L −$1,729.23,
  fees $1,899.34, 0 pending, 0 spot-valued events (Rule 1a clean); the fresh scan
  reproduced the cached Capital G/L **to the cent** and the position-id set exactly. Cache
  repopulated automatically (30 d TTL). A warm cache hit is NOT proof the RPC works — the
  Upstash DB is shared across Production/Preview/Development, so a dev-written entry can
  mask a broken production RPC; only a forced cold scan proves it.
  **FIGURE SUPERSEDED: A1's Orca closed Capital G/L is −$1,729.23, not the −$1,818.78 this
  file previously recorded** (and A1's −$10,369.40 wallet total was the pre-fix figure with
  Orca missing entirely — not re-measured this session, treat as stale). −$1,729.23 is
  confirmed twice independently (warm cache + the 93.5 s cold rescan, identical to the
  cent). The −$1,818.78 was a one-off browser reading from the 2026-07-18 investigation
  that was never re-verified; the ~4.9% delta is ordinary DeFiLlama daily-close
  granularity across scan dates, not a regression.
- **Closed positions are counted everywhere but not yet shown as Closed rows** — Sui
  (Cetus/Bluefin/Momentum) AND Solana (Orca, Raydium) closed positions fold into Capital G/L +
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

**🟠 ITEM 0b — DISCLOSURE SHIPPED (2026-08-06), DETERMINISM STILL OPEN → see ITEM 0d, which
is the direct continuation and the NEXT thing to build.** The activity route silently
substituted a different price basis when a position's historical price wasn't available,
producing a plausible-looking but WRONG Capital G/L. **It no longer renders as final** — a
substituted valuation is marked and the total declares itself `≈ incomplete`. **The value
still varies between loads** (measured on healthy code, 3 loads: spread **$690.49**, position
`71729936` flipping between its historical $9,246.39 and its tick-derived $9,294.71), because
the flip happens upstream in the price cascade. ITEM 0d removes the flip.

**⚠️ A SECOND substitute basis was found during implementation and is the one that actually
fires in the browser.** The plan named only tier 3 (current spot). Tier 2 —
`deriveDepositPrices`, a TICK-BOUNDARY estimate — is what the client path actually hits,
because the client passes `tickLower`/`tickUpper` and tier 2 therefore covers for a failed
tier 1. It has NO per-block input, so **every event of a position gets the same price**,
which is the mechanism behind the deposited === withdrawn fingerprint. Both bases are now
marked; they are handled DIFFERENTLY (see the fix entry for `c18cbd8`).

_(Original problem statement below, kept because it is the baseline ITEM 0d measures against.)_

**⚠️ CORRECTION — the earlier description of this item was WRONG.** It said "one closed
position is returned by the API but INCONSISTENTLY INCLUDED in the aggregate", and pointed
the investigation at client-side inclusion/exclusion (`useLpPnl`'s eligibility filter, the
Rule 11 degrade funnel, an `isClosed` eviction, a render race). **None of those is the
cause.** Nothing is being included or excluded — the position is present in every run. It is
being **valued differently** run to run, on the SERVER, inside the activity route. Do not
re-derive the inclusion hypothesis.

**The mechanism** (`app/api/aerodrome/activity/route.ts:743-748`). For deposit and withdrawal
events the route runs a three-tier cascade:

1. **sqrtPriceX96 at the event's own block** (`histPrices`) — the correct historical basis.
2. `deriveDepositPrices` tick-boundary estimate (~line 676) — an approximation, not the
   event-block price.
3. **CURRENT SPOT** (`currentSpot0/1`) — `if (usdAtTime == null && ev.type !== 'fee_claim')`,
   a WHOLLY DIFFERENT price basis, applied silently.

Tier 3 assigns `price0AtTime`/`price1AtTime` = today's spot and computes a non-null
`usdAtTime`. **That is what makes it invisible**: downstream the event is indistinguishable
from a properly historically-priced one. In particular it **BYPASSES the ITEM 0 spot-fallback
counter** — `positionPnl.ts`'s `spotFallbackEventCount` only increments when `usdAtTime` is
null AND both prices are null (`positionPnl.ts:259-281`), which a route-substituted event
never is. So `capitalGLPricingPending` stays false, the total renders as final, and the
background retry never fires for these positions.

**Affected positions (Account 1, `0xD99a9e66…4F20`, Aerodrome/Base): `71729936`, `71734039`,
`71735590`** — three positions, not one.

**Signature symptom: deposited and withdrawn collapse to an IDENTICAL figure.** When tier 3
fires, both the deposit events and the withdrawal events of the same position are valued with
the SAME current-spot prices, so the two sides converge and that position's Capital G/L
collapses toward ~$0. On a warm load the same position values historically and contributes a
real, non-zero G/L. **Deposited === Withdrawn to the cent on a closed position is the
fingerprint of this bug, and is the fastest way to spot it in a harness diff.** (It also
explains why `Deposited` looked "stable" in the ITEM 0 diagnostic: the deposit side moves in
lockstep with the withdrawal side, so the two errors partly cancel in the wallet total while
Capital G/L moves.)

**Why the number changes per load:** identical to ITEM 0's root cause — the historical price
is read cached-only while the warm-up is fire-and-forget, so which tier answers depends purely
on cache warmth at that instant. ITEM 0 fixed the two paths that were *visible* (exclusion,
and the `positionPnl` spot fallback); this is the third path, and it is the one that reports
nothing at all.

**Not Aerodrome-specific.** The same tier-3 substitution exists in **six** activity routes:
`aerodrome` (743), `velodrome` (618), `hyperswap` (937), plus `bluefin`, `raydium`, `cetus`,
`orca`. Any fix is platform-level (architecture Rule 1), not a one-route patch.

**Rule status:** this does NOT violate pricing-invariants Rule 1a (that governs fee claims,
and fee claims correctly stay pending here). Rule 2 does permit spot as a last resort for a
deposit/withdrawal point-in-time value. The defect is that the substitution is **silent** —
Rule 11 requires degrading visibly, never differing silently, and a headline money figure
must not swap price bases without saying so.

**Acceptance:** across N identical loads the same wallet produces the SAME Capital G/L, or the
total declares itself incomplete and names the unpriced positions. Deposited must never equal
Withdrawn by way of a shared spot basis. Harness green:
`node scripts/capgl-determinism.mjs --runs 5` → `VERDICT: deterministic ✓`.
**Half met by `c18cbd8`:** the "declares itself incomplete" clause is satisfied on every load;
the "SAME Capital G/L" clause is NOT, and is ITEM 0d's job.

**✅ ITEM 0d — SHIPPED. The substitute-basis FLIP is eliminated; the residual is a different
mechanism, now isolated as ITEM 0g.** Redis-cached the per-event historical sqrtPriceX96
prices so tier 1 answers on every load.

**Verified:** with the archive RPC completely dead and a FRESH process (empty in-process
cache), `71729936` and `71734039` still price on the correct historical basis with exact
values (dep $9,246.39 / wd $9,150.70 and $9,153.80 / $8,818.06) — the identical condition
produced the tick-derived $9,294.71 collapse before. Across repeated loads every
sqrtPrice-priced position is now STABLE and `71729936` no longer flips; two consecutive
loads reproduced Capital G/L **−$3,656.47 to the cent**. Capital G/L spread from the
substitute-basis flip: **$690.49 → $0.00**.

**Not yet `deterministic ✓`** — see ITEM 0g. Original scoping kept below.

**Why this is the actual fix:** ITEM 0b proved the number moves because the CASCADE moves —
tier 1 (the pool's `sqrtPriceX96` at the event's own block, via the Tenderly archive) answers
on one load and not the next, and whichever lower tier catches it produces a different,
non-historical valuation. Marking made that honest; only making tier 1 RELIABLE makes it
stable. A closed position's per-event historical price is **IMMUTABLE** — the block is
finalized — so it is exactly the shape the repo already caches elsewhere.

**Shape:** the `evm_pos_ctx_v1` pattern (Sprint ITEM-A) applied to
`app/lib/v3HistoricalFeePrice.ts`'s `createHistoricalFeePriceResolver`: key on
`(chain, pool, blockNumber)`, 90 d TTL, **POSITIVE results only** (a null may be a transient
archive failure and freezing it in would permanently pin a position to the estimate). The
resolver already batches per block via `resolveMany`, so the cache slots in at that boundary.
**Expected result: the tick-derived path becomes rare, `pricingIncomplete` clears on a warm
wallet, and the harness goes `deterministic ✓`.** Complexity SMALL–MEDIUM. Verify with
`node scripts/capgl-determinism.mjs --runs 3` on production — spread must reach $0.00, and the
`≈` marker must disappear once warm.

**🔴 ITEM 0g — NEXT UP for determinism. On the FIRST load of a cold process ONE position is
still EXCLUDED for a cold deposit-date price, and the ITEM 0 retry does not resolve it within
the load.** _(Isolated 2026-08-06 as the residual after ITEM 0d; it is the ORIGINAL ITEM 0
exclusion path — `missing_deposit_prices` / `useLpPnl.ts:122` — not a price-basis problem.)_

**Signature:** run 1 of a fresh process shows **7 closed rows** and `⚠ 1 position could not…`;
runs 2 and 3 show **8 rows** and are identical to the cent. The dropped position
(deposited **$7,937.69**) is worth **$628.83–$1,572.87** of Capital G/L swing, which is now
the ENTIRE remaining spread. It is DISCLOSED on every occurrence, so no wrong number is
presented as final — this is a determinism gap, not a correctness one.

**Why ITEM 0d didn't cover it:** 0d warms the on-chain sqrtPriceX96 tier. This position fails
on the **CoinGecko historical deposit-date** price, a different source with its own Redis
namespace (`price:historical:{cgId}:{YYYYMMDD}`) filled by a FIRE-AND-FORGET prewarm.

**Shape of the fix (pick after measuring):** (a) confirm why the bounded retry (15 s × 8)
doesn't land it — it may be exhausting before the fire-and-forget prewarm completes, in which
case widening the window or awaiting the prewarm for CLOSED positions only is enough; or
(b) treat a closed position's deposit-date prices as immutable and persist them the way 0d
does. Complexity SMALL–MEDIUM. **Acceptance:** `node scripts/capgl-determinism.mjs --runs 3`
on production → `VERDICT: deterministic ✓`.

**🟡 ITEM 0e — Rule 1a LEAK: Uniswap and PancakeSwap can value a FEE CLAIM at current spot.**
_(Found 2026-08-06 while implementing ITEM 0b; recorded, deliberately NOT fixed there.)_
Every other route gates its spot last resort on `ev.type !== 'fee_claim'`. These two do not —
`app/api/uniswap/activity/route.ts:757` and `app/api/pancakeswap/activity/route.ts:~445` read
`if (usdAtTime == null)`, so a claim that misses sqrtPriceX96 AND CoinGecko-historical falls
through to `currentSpot0/1`. That is a **direct pricing-invariants Rule 1a violation** — the
exact failure that over-reported Account 2's ProjectX fees by 26% in Sprint 1.5 — and it is
distinct from ITEM 0b (which is about deposit/withdrawal valuation, where Rule 2 permits
spot). **Fix:** gate both branches on `ev.type !== 'fee_claim'` and let the claim stay pending,
matching Cetus/Bluefin/Aerodrome. Requires a `lp-pnl-events`/`analytics-activity` bump (fee
totals change). Complexity SMALL. Verify on a Uniswap wallet with a claim CoinGecko can't
price: the claim must report pending, never a spot figure.

**⚪ ITEM 0f — LOW / cosmetic: the determinism harness's row scraper also matches the
OPEN-positions table, so live price movement reads as "the position SET is unstable".**
_(Found 2026-08-06.)_ `scripts/capgl-determinism.mjs` selects any `<tr>` with ≥3 dollar cells,
which catches the main positions table as well as the Capital G/L breakdown; an open
position's mark-to-market value differing by cents between runs then prints as a set change
and can mask the real signal. **Fix:** scope the selector to the Capital G/L breakdown table
only. Affects the TESTING TOOL, not the product — no user impact. Complexity SMALL.

**🟡 ITEM 0c — MINOR: token symbol display is non-deterministic.** The SAME closed position
renders as `WETH / USDC` on one load and the generic `Aerodrome Position` placeholder on the
next, depending on whether token-symbol resolution landed. **Display-only — it does not move
any total** (verified: rows with drifting labels had identical dollar figures), which is why
it is filed separately and low. It was initially mistaken for position-set churn by the
determinism harness; the harness now keys rows on position identity and reports label drift
separately. Likely the same cold-cache shape as ITEM 0 but in `tokenResolver`. Complexity
SMALL.

> **🔴 NEXT UP — ITEM 0b.** ITEM 0 shipped largely fixed (71.5% variance reduction measured
> ON PRODUCTION); 0b is
> its narrow, isolated remainder and inherits the top-of-queue position. Both rank ABOVE
> queue items B and C and above WRAPPER-PROTOCOLS Part 3.

**🟠 ITEM 0 — Capital G/L non-determinism. LARGELY FIXED (`4fcc617`, 2026-08-05):
variance cut **71.5% ON PRODUCTION**, from a $2,297.38 spread to $654.28. NOT fully closed —
see ITEM 0b,
which is the narrow remaining cause and the next thing to investigate.**

**Shipped:** Capital G/L now DECLARES itself incomplete (`≈` + "incomplete — pricing N
positions…") instead of rendering a partial sum as final, retries the pending positions in
the background (bypassing both 5-minute caches, which is what made the first retry attempt a
no-op), and counts withdrawal events that fell back to CURRENT SPOT as not-yet-final. Result
across 3 identical loads: exclusions 4/3/1 → **0**, closed rows 5/6/8 → 7/7/8, and two of the
three runs were **identical to the cent**.

**Original evidence, kept because it is the baseline any future work measures against:**

**Evidence** (Account 1 `0xD99a9e66…4F20`, analytics, IDENTICAL build, NO code change between
runs, captured during Sprint SICKLE-CLOSED-REVERIFY):

```
run 1:  DEPOSITED $8,184.28 | CAPITAL G/L -$3,219.10 | NET P&L  +$110.66
run 2:  DEPOSITED $8,243.79 | CAPITAL G/L -$2,165.85 | NET P&L +$1,104.24
```

**$1,053 swing (~33%) in Capital G/L; NET P&L FLIPS SIGN** (−$331 → +$1,104 across the wider
sample). Every load renders confidently — no banner, no exclusion notice, no "still scanning"
hint. The user cannot tell which reading, if any, is right.

**Why this is item 0:**
1. **It is the product's core promise failing.** DefiDesh's pitch is "reconciled against
   on-chain truth, not estimates". A number that changes by a third on refresh is an
   estimate, and an unsignposted one.
2. **It is on OSHO'S OWN ACCOUNT** — the wallet used to validate everything else.
3. **It invalidates the project's verification method.** It sets a **±$1,000 measurement
   floor** on any Capital G/L reading, so every before/after comparison in this repo —
   including the ones that signed off recent sprints — is only trustworthy to about a
   thousand dollars. Sprint SICKLE-CLOSED-REVERIFY could confirm its target showed a GAIN
   but NOT the figure (+$14.61 local vs +$16.25 prod on the same commit). **Until this is
   fixed, do not trust a Capital G/L delta as evidence of anything.**

**✅ CAUSE IDENTIFIED FROM EVIDENCE 2026-08-05 (diagnostic run, `scripts/capgl-determinism.mjs`).
The earlier "leading hypothesis" below — queue item B, a failed enumeration — was WRONG.**

**What the evidence showed:**
- `deposited` and `current` are STABLE across loads; only `capitalGL` varies (spread $2,297
  over 3 loads: −$1,355.49 / −$2,274.08 / −$3,652.87). So OPEN-position valuation is fine.
- Every `/api` call returns **200** in every run, the call SET is identical, and no activity
  route returns zero events. **Not an RPC or enumeration failure.**
- Within a SINGLE load the value is completely stable (−$1,808.93 held from t=30 s to
  t=360 s). **It is not "still converging"** — each load reaches a DIFFERENT stable answer.
- The UI states the reason plainly: **"⚠ N positions could not be fully calculated and are
  excluded from totals: WETH / USDC (Aerodrome · Base) — Deposit price data unavailable"**
  (`useLpPnl.ts:122`, reason `missing_deposit_prices`). The excluded COUNT varies per load
  (4 / 3 / 1), and the number of closed rows moves inversely (5 / 6 / 8).

**Root cause:** Capital G/L depends on **claim/deposit-date HISTORICAL prices**, and the
activity routes read them **cached-only** (`getCachedOnlyTokenPrice` /
`getCachedOnlyDefillamaPrice`, aerodrome/activity ~721-723) while the warm-up is
**fire-and-forget** (`void prewarmTokenPrices(pairs).catch(...)`, ~line 564 — deliberately
not awaited so CoinGecko cannot blow the function timeout). So each page load values
whatever historical dates happen to be warm in Redis AT THAT MOMENT; every cold date makes
its position unpriceable, which EXCLUDES the position from the total. Different cache
warmth per load → different excluded subset → a different, confidently-rendered Capital G/L.

**Correction to the original report of this bug:** it claimed the failure was SILENT with
"no banner, no exclusion notice". **That was wrong** — the UI does surface both the count
and the per-position reason. The real defect is subtler and arguably worse: the exclusion is
disclosed, but the TOTAL is still presented as an authoritative figure, so two loads yield
two different "true" Capital G/L values, each with its own honest-looking footnote.

**Why it is a real bug and not just a documented tradeoff:** the fire-and-forget design is
deliberate and correct in intent (never block a route on CoinGecko). What was not intended
is a headline money figure silently changing by ~$2,300 depending on cache warmth. Any fix
must keep the non-blocking property — the likely shape is to make an incompletely-priced
Capital G/L *declare itself incomplete* rather than render as a total, and/or to hold the
prior complete value until pricing is whole.

**Superseded hypothesis (kept so it is not re-derived):**

**Leading hypothesis — NOT yet proven, and the investigation must establish cause before any
fix:** queue item B (a failed/partial enumeration returning an empty that is cached as
truth). `getEverOwnedTokenIds` was observed returning `[]` for a wallet with 3 known
positions under RPC throttling. If per-load a different subset of positions resolves, both
Deposited and Capital G/L shift. But **other candidates have NOT been excluded**: the
per-position LKG/degrade funnel (Rule 11 STALE/ESTIMATED/EXCLUDED) settling differently per
load; `withActivityRouteCache` TTL boundaries; partial closed-scan results; or the
progressive-aggregate render (Rule 10) being sampled before settle. **Do not assume B.**

**Investigation shape:** instrument one wallet across N identical loads and capture, per
load, the exact set of positions included in the aggregate plus each one's degrade state —
then diff the sets. The delta between runs names the cause. Expect to need a determinism
harness (repeat-load, compare, report variance) as a permanent regression guard; the absence
of one is why this went unnoticed for so long.

**Acceptance:** the same wallet on the same build produces the SAME Capital G/L across
repeated loads, or visibly declares incompleteness (Rule 11 — degrade, never silently
differ). Complexity UNKNOWN until the cause is named; the harness is SMALL.

_(Sprint WRAPPER-PROTOCOLS — DefiTuna wrapper positions — is the ACTIVE sprint above.
Phase 1 shipped `4c450a1`; Phase 2 Part 1 shipped `4a25c69`; Phase 2 Part 2 CLOSED with no
code required. **Part 3 (closed Tuna) is the next DefiTuna work** — but it is BLOCKED on the
accrued-interest pricing-invariants decision. **NOTE (2026-08-05): regardless of that
decision, ITEM 0 (Capital G/L non-determinism) is now the next thing to pick up — it ranks
above Part 3 and above queue items B and C, at the owner's direction.**)_

**✅ A. FIXED (`78e80db`, 2026-08-02) — EVM wallet-scope per-event pool context.**
_(Kept here rather than only in Recent fixes because the remaining caveats below are
load-bearing. Original title: "EVM wallet-scope closed-position scan applies ONE pool's
token decimals to EVERY event.")_

**What shipped:** all three EVM wallet-scope routes (Aerodrome, Velodrome, Uniswap V3) now
resolve EACH position's own pool context on-chain via NEW `app/lib/evmPoolContext.ts` and
fan out per position through the already-correct per-position path, returning a
per-position breakdown plus an `excluded[]` list. The `<= $50M` Uniswap band-aid is GONE.

**⚠️ Caveats that outlive the fix:**
- **Velodrome executed only its empty branch in testing** — no test wallet holds Velodrome
  positions. Structurally identical to Aerodrome (same Slipstream architecture) and
  compiles/returns valid empties, but no real position has flowed through it. Uniswap was
  verified on a SINGLE-decimal-pair wallet only. Owner-accepted risk (2026-08-02): a real
  wallet will surface any problem visibly rather than silently.
- **`SICKLE_CLOSED_SUPPRESSED` is UNCHANGED and closed vfat positions REMAIN SUPPRESSED.**
  That flag exists for the GAUGE-STAKING misclassification (below), which is unrelated to
  decimals and still unresolved. Do not delete the flag on the strength of this fix.
- **NEW finding — gauge-staked positions are misclassified as Closed.** vfat position
  `73551608` is staked (`ownerOf` = `0x6399ed67…79a8`, a gauge — NOT the owner), has ZERO
  `DecreaseLiquidity` logs, still holds ~$10k, and is booked as Closed with the full
  deposit as a loss (−$9,988.84). This is residual check **10a** from vfat Phase B, relaxed
  at ship time and now confirmed real. Needs its own scoping.
- **CORRECTION to the original Item A writeup:** it claimed the position's true deposit was
  ~$1.20 and the figure was wrong by ~5 orders of magnitude. **That was wrong.** The $1.20
  came from a diagnostic call that itself passed the wrong decimals (18/6 to a 6/8
  position) — the bug reproduced inside its own diagnosis. Raw on-chain: 9,210.35 USDC +
  0.01195 cbBTC ≈ **$10,285**, so ~$9,988.84 was approximately right. The decimals bug was
  still real (proven independently in both directions); only that one figure was misread.
_(Found live 2026-08-01 during vfat/Sickle Phase B verification. This is a REAL, ACTIVE,
USER-FACING BUG — not hardening, not deferred. It supersedes the "EVM is NOT currently
broken" claim in queue item 10, which is now known to be FALSE.)_

**Who is affected:** ANY wallet — vfat or not, watched, connected, or scanned — that has
CLOSED EVM positions across **two or more pools with different token-decimal pairs**. A
wallet whose pools all share one decimal pair is unaffected, which is why this went
unnoticed: the common single-pair case masks it.

**Mechanism:** the wallet-scope activity scan (`/api/{protocol}/activity?positionId=all`)
is called with ONE representative pool's `t0d`/`t1d` and applies those decimals to every
event it finds. An 18-decimal WETH amount decoded as 6-decimal inflates by **1e12**.

**Live evidence** (Sickle `0x06C3F412…e09f`, Base — reproduces identically as a plain
watched wallet, so it is NOT vfat-specific): the wallet-scope call returned deposit events
of **$342,298,111,238.86** and **$167,113,757,805.22**. The Capital G/L breakdown then
attributed **$9,988.84 deposited / $0.00 withdrawn** to a single closed USDC/cbBTC position
whose OWN per-position activity route reports a deposit of **$1.195** — wrong by ~5 orders
of magnitude, displayed to the user as a confident **−$9,988.84**.

**Why it is severe:** it is silent and plausible-looking. There is no exclusion banner and
no pending-claim notice — the number simply renders as fact, and it dominates Net P&L.
Per pricing-invariants, a wrong number is worse than a missing one.

**Fix:** resolve each event's REAL pool (and therefore its decimals) per event, exactly as
Sprint TOKEN-RESOLUTION (`a866576`) did for Sui via `suiPoolContext.ts` — the EVM analogue
of Contract invariant (i). The per-POSITION scans already carry correct context (Sprint
2.1b `5b8f6b7`); it is specifically the wallet-scope `positionId=all` path that is wrong.
Complexity MEDIUM. **Verify with a multi-decimal-pair wallet** — a single-pair wallet
cannot reproduce it.

**Current mitigation (partial, vfat only):** vfat/Sickle ships with CLOSED positions
suppressed (`SICKLE_CLOSED_SUPPRESSED` in `PositionsContext.tsx`) so vfat users see no
Capital G/L rather than a wrong one. **This does NOT protect non-vfat wallets**, which
remain exposed today. Delete that constant once this item ships.

**When re-enabling closed Sickle positions under this item, RE-INSTATE the two vfat
shipping gates** that were relaxed for the narrower Option-2 ship (owner decision,
2026-08-01, recorded in `reports/wrapper-protocol-landscape-survey-report.md`):
**(10a)** confirm a gauge-staked-through-a-Sickle position surfaces correctly — never
verified, no such Sickle was found; **(10b)** confirm long-tail token resolution on the
dust Sickle (pools `0x948e80fb…` / `0xcf88b8bf…`, which render `TOKEN0` placeholders) —
never verified, and unreachable today precisely because those are CLOSED positions.

**⚠️ B. ACTIVE BUG (scope-and-fix later) — a FAILED wallet enumeration returns an empty
result that is indistinguishable from "no positions", and gets CACHED as truth.**
_(Found 2026-08-02 while verifying Item A. NOT fixed there, deliberately — logged separately
so it can be scoped properly.)_

**Observed:** `getEverOwnedTokenIds` returned `[]` for a wallet with 3 known positions after
the public Tenderly gateway throttled. The route reported **"0 tokenIds, 0 resolved, 0
excluded"** — a confident, well-formed empty — and `withActivityRouteCache` cached it for
60 s. A fresh process returned all 3 correctly. **Pre-existing; unchanged by Item A** (the
old union code did the same thing).

**Why it matters:** the user sees "no closed positions" / zero fees, with no banner, no
exclusion, no error. It is the exact failure mode this project has now hit FOUR times —
`suiRpcIndexed` (fixed by throwing `SuiIndexUnavailableError`), the Sui wallet
self-disconnect (fixed by a settle gate), the Solana closed-scan empty-cache rule
(`stats.complete`), and now this. **The standing lesson: an empty result from an
asynchronous/remote source is NOT evidence of absence, and must never be cached as though
it were.**

**➡️ SEE ITEM 0 (top of queue).** The measurements below are the symptom that promoted
Capital G/L non-determinism to the top of the queue as its own investigation. Item B (a
failed enumeration cached as an empty) is the LEADING HYPOTHESIS for that symptom but is
**not proven** — item 0 must name the cause first, and may land here or elsewhere.

**⚠️ ESCALATED 2026-08-05 — this now demonstrably corrupts DISPLAYED DOLLAR FIGURES on
Osho's own account.** Measured during Sprint SICKLE-CLOSED-REVERIFY with an IDENTICAL build
and NO code change between runs, Account 1 (`0xD99a9e66…4F20`) analytics:

```
run 1:  DEPOSITED $8,184.28 | CAPITAL G/L -$3,219.10 | NET P&L  +$110.66
run 2:  DEPOSITED $8,243.79 | CAPITAL G/L -$2,165.85 | NET P&L +$1,104.24
```

A **$1,053 swing (~33%) in Capital G/L between two identical page loads**, with Net P&L
flipping sign. Each load looks confident — no banner, no exclusion notice. This is the
transient/partial-scan empty being treated as truth, landing directly in user-facing money.

**Second-order cost:** it sets a measurement floor of roughly ±$1,000 on any Capital G/L
reading, which silently undermines every before/after verification in this project. It is
why Sprint SICKLE-CLOSED-REVERIFY could confirm its target position showed a GAIN but could
not confirm the exact figure. **Fix this before trusting any further Capital G/L
comparison.**

**Shape of the fix:** `getEverOwnedTokenIds` must distinguish "scan completed, wallet
genuinely owns nothing" from "scan failed/partial" — return completeness alongside the ids
(the `stats.complete` pattern already proven in `solanaClosedPositions.ts`). Callers then
surface a failed enumeration in `excluded[]` rather than as an empty success, and the
activity-route cache must not store a non-complete empty. Complexity SMALL–MEDIUM.
**Verify by forcing the failure** (throttle or point at a dead RPC) and confirming the
route reports incompleteness rather than a clean zero.

**⚠️ C. BACKLOG (recorded, not fixed) — Sugar position enumeration is capped at 100 with
no pagination, so wallets with >100 positions are SILENTLY TRUNCATED.**
_(Found 2026-08-03 during Sprint GAUGE-STAKING. Recorded only — deliberately out of scope.)_

`app/api/aerodrome/route.ts` (and the Velodrome equivalent) calls Sugar as
`positionsByFactory(limit=100, offset=0, account, factory)` and never pages. Observed live:
a Base contract returned **exactly 100** positions — i.e. it hit the cap, and whatever lay
beyond it was invisible with no error, no banner, and no indication of truncation.

**Why it matters:** an active LP or a protocol/router contract with >100 positions silently
loses everything past the 100th from value, fees and P&L. Worse, the closed-position
reconstruction computes `everOwned - heldIds`, so a truncated `heldIds` makes genuinely-OPEN
positions look CLOSED — the same fabricated-loss failure mode Sprint GAUGE-STAKING just
fixed, arriving by a different route.

**Shape of the fix:** page with `offset` until a short page is returned, and treat a
full-limit page as "there may be more" rather than "that's all". If pagination cannot be
completed, surface incompleteness rather than returning a confident partial set — same
principle as queue item B. Complexity SMALL.

0. _(DONE — **Sprint WRAPPER-PROTOCOLS Phase 2 Part 1**: wrapper position-detail page,
   SHIPPED `4a25c69` 2026-07-21. See Recent fixes.)_
0b. _(CLOSED — **Sprint WRAPPER-PROTOCOLS Phase 2 Part 2** (Fusion LP): **NO CODE REQUIRED.**
   Investigate-first paid off — Fusion usage is real (107 wallets, 30.3% of live Tuna LP
   positions, 50.6% of borrowed capital) but the existing Phase 1 route already serves it
   correctly, verified 19/19 exact on a mixed wallet. See the Part 2 finding in the active
   sprint block + `reports/wrapper-protocols-phase2-part2-fusion-report.md`. Remaining
   optional follow-up: a browser eyeball of one Fusion position on the deployed site.)_
1. **Sprint WRAPPER-PROTOCOLS Phase 2 Part 3 — CLOSED Tuna positions (Capital G/L).**
   **← NEXT UP for DefiTuna work.**
   Category B tx-history reconstruction against the tuna program, same canonical pattern as
   `solanaClosedPositions.ts`. Complexity **LARGE** — see the Phase A findings in the active
   sprint block for the full instruction vocabulary, the IDL location, and the traps.
   **BLOCKED on a pricing-invariants decision:** how does accrued borrowing interest enter
   P&L? Rule 4's `withdrawal − deposit` has no slot for it. **Free option before building:
   ask DefiTuna whether a closed/history endpoint exists or is planned** — their data model
   already carries `closed_at` and `pnl_usd`, and a "yes" removes most of this part's cost.
   Sequence: (a) equity-aware lifecycle from `close`/`decrease`/`repay` via vault-transfer
   matching; (b) the `Liquidated` / `ClosedByLimitOrder` close paths (different economics —
   NOT ordinary closes) and rebalance-vs-close disambiguation; (c) Anchor event decoding as
   an optional precision upgrade (IDL publishes no event schemas today).
2. **DefiTuna LENDING (`LendingPosition`) — a LENDING-pattern integration, NOT an LP one.**
   Discovered during the Part 2 census (2026-07-21): **7,602 funded lending positions across
   5,640 distinct wallets — 17.7× more active wallets than DefiTuna LP (318)**, across 35
   deposit mints. Entirely invisible in DefiDesh today; the single largest missing DefiTuna
   position class by user count.
   **Scope it like AAVE / Suilend / Kamino Lend, NOT like the wrapper LP work.** Different
   economics: a lending deposit earns interest and has no range, no impermanent loss, no
   fees-vs-principal split, and no leverage/liquidation surface. It must NOT enter the LP
   positions array, must NOT use the `selfReportedPnl` wrapper mechanism, and must NOT be
   folded into LP P&L or Capital G/L — it belongs in the existing lending pipeline and the
   `/dashboard/lending` surface (architecture Rule 4: a new protocol works everywhere, but
   "everywhere" for a lending product is the lending surfaces).
   Discovery is trivial and already proven in the census:
   `getProgramAccounts(tuna4u…, memcmp{offset:0, bytes:<LendingPosition disc
   2ffffc2314f59df3>})` then decode the 155-byte layout — `authority @ 11`, `mint @ 43`,
   `deposited_funds @ 75` (u64), `deposited_shares @ 83` (u64), `vault @ 91`. **Filter
   `deposited_funds > 0`** — 9,910 of the 17,512 accounts are zero-balance leftovers (57%),
   so an unfiltered count roughly triples the real number. Needs Helius (free Alchemy 429s on
   `getProgramAccounts`). Vault/APY metadata is available from `/vaults` (141 entries) on the
   same public API used by the LP route.
   **Confirm DefiDesh-user demand before building.** The 5,640 figure is DefiTuna's ENTIRE
   user base, not DefiDesh's — it establishes the class matters at scale, not that a current
   DefiDesh user holds one. Complexity MEDIUM.
   _(Not built: `TunaSpotPosition` — the census found **11 accounts / 9 wallets**
   protocol-wide. Deliberately dropped from the queue; revisit only if a real user reports
   one.)_
3. **Sprint WRAPPER-PROTOCOLS Phase 2 Part 4 — Kamino Liquidity.** Highest-TVL non-Tuna
   wrapper on Solana. **A DIFFERENT wrapper shape from DefiTuna, and cheaper:** Kamino issues
   a fungible `shareMint` held in the USER'S OWN WALLET (not an NFT in a vault), so discovery
   is `user's SPL balances ∩ live shareMints` — trustless by construction, no protocol API
   needed, and DefiDesh ALREADY reads wallet token balances (Token Holdings page).
   `api.kamino.finance/strategies` → 5,608 strategies (515 `status=LIVE`), each
   `{address, shareMint, tokenAMint, tokenBMint, type, status}`; `/kvaults/vaults` returns
   vault on-chain state. NO per-user endpoint exists (4 patterns 404). The work is VALUATION:
   `shares × sharePrice`, share price from the strategy's on-chain holdings ÷ shares
   outstanding. Complexity MEDIUM. NOTE: `app/api/lending/kamino/route.ts` is Kamino **Lend**
   (obligations) — a different product, no reusable code; and Kamino's API is currently the
   top production runtime error (`Altcoins:reserves` 500s), so this needs Rule 11
   degrade-don't-drop treatment.
4. **Position-detail page is broken in SCAN mode for EVERY protocol** (found 2026-07-21
   during Phase 2 Part 1 verification; PRE-EXISTING, not caused by that change). Clicking any
   position row while in paste-a-wallet scan mode navigates to `/dashboard/position/{id}` and
   renders **"Position not found"** with the navbar showing "no wallet". Cause: row clicks use
   `window.location.href` (a FULL page navigation), which discards the in-memory `scanAddress`;
   the detail page then builds its identity from connected+watched only and finds nothing.
   Verified on BOTH a Raydium row and a DefiTuna row in the same session — it is universal,
   not wrapper-specific. Same class as the analytics scan-mode gap fixed in `e85f794`; the fix
   is the same shape: a Suspense-wrapped scan-mode listener on the detail page + carrying
   `?address=&chain=` through the row-click URL so it survives the hard load. SMALL, and
   user-visible immediately after a paste — a pasted wallet can see positions but cannot open
   any of them.
5. **Sprint POSITION-DETAIL-2** — the deferred pending-reward paths from Sprint POSITION-DETAIL
   (`82d4954`): **B3** Solana pending rewards (Orca whirlpool `rewardInfos` offsets already
   documented in orca/route.ts comments; Raydium equivalent) so Orca/Raydium detail pages show
   reward emissions like the Sui ones now do; **B4** EVM gauge emissions (Aerodrome/Velodrome
   staked AERO/VELO via the gauge `earned()`) — **staked EVM positions (e.g. Osho's Aerodrome
   WETH/USDC) UNDER-REPORT uncollected value vs the protocol UI until B4 ships**. Same Contract
   invariant (k): value pending rewards at current spot (Rule 2), never a fee-claim (Rule 1a).
   **B3 head start (Sprint RAYDIUM):** every reconstructed closed Raydium position already
   carries `rewardAmountsRaw[3]` (exact per-slot emission totals from
   `DecreaseLiquidityEvent`) — read it, don't re-scan; reward MINTS come from
   PoolState.reward_infos.
6. **Sprint PERFORMANCE-2 (hardening candidates)** — the deferred Phase A items:
   **#4** Redis-cache the Aerodrome positions route's ever-owned tokenId scan +
   closed-position reconstruction (~30 s, the remaining first-load straggler — non-blocking
   behind the "still scanning" chip); **#5** Redis-cache CLOSED positions' activity route
   outputs (immutable — extend the Sprint 1.14 deposit-cache pattern beyond HyperEVM);
   **#6** move `withActivityRouteCache` success results to Redis (5-min TTL, errors never
   cached) so route outputs are shared across instances/users.
7. **Orca APR-fallback + reward-eyeball verification** — the deferred numeric eyeballs:
   (a) the Sprint POSITION-DETAIL derived-APR fallback on the new open Orca positions
   (ZEC/USDC showed ~213.4% at ship; re-ranged since) vs the Orca app; (b) Contract
   invariant (k) — the first live non-zero Bluefin/Momentum pending reward vs the protocol
   app (code-identical to the proven Cetus path, verified structurally only).
8. _(DONE in Sprint 4 `00cd1bc` — closed Sui/Solana positions now render as Closed-tab
   rows with close dates.)_
9. **tokenResolver coverage + cleanup** — migrate Tier 2 (uniswap/v3,
   pancakeswap) and the activity routes to `resolveToken`, then remove the
   per-route `KNOWN_COINS`/`KNOWN_TOKENS`/`TOKENS` maps once resolver coverage is
   proven in production (architecture-principles Rule 9).
10. **EVM per-event token resolution — ⚠️ SUPERSEDED BY QUEUE ITEM A (see top of queue).**
   ~~EVM is NOT currently broken … the single-representative-pool risk is mitigated …
   verify-and-document only until a real EVM user impact surfaces.~~ **That premise is
   FALSE and this item is no longer "hardening, not blocking."** A real user impact DID
   surface (2026-08-01): on a wallet with closed positions across pools with different
   decimal pairs, the wallet-scope scan produced deposit events of $342bn/$167bn and a
   confident, silently-wrong Capital G/L of −$9,988.84 against a real ~$1.20 leg. The
   mitigation noted here only ever covered the per-POSITION path; the wallet-scope
   `positionId=all` path was never covered. Do the work under item A — this entry is kept
   only so the superseded reasoning is not re-derived from the old text.
11. **Sui wallet-scope tx-history scan latency (optional, non-blocking)** — after Sprint
   SUI-HISTORICAL-REDIS `776fcaa` the Sui wallet-scope routes drop from ~111 s to ~18–20 s; the
   residual floor is the **~17 s public-Sui-RPC `queryTransactionBlocks` + `multiGet` scan** (240
   digests / wallet). A future sprint could cache the wallet's parsed tx-history / event set
   cross-instance (immutable ledger) or use a faster RPC. **Address only if <10 s becomes a UX
   need** — the Fee-Income regression is already resolved at ~18–20 s.
12. **Resumable/background closed-Solana scan (optional, build ONLY if it surfaces)** — Sprint
   LPPNL-PERF `535453e` proved a 2,544-tx heavy wallet's isolated single scan completes in
   ~217 s, under the `maxDuration=300` budget, so no resumability was needed. A wallet heavier
   than **~3,000–3,500 txs** could still exceed 300 s single-scan on the free Alchemy tier.
   **Build the fix ONLY if such a wallet is reported in production:** a signature-cursor
   resumable scan (persist distilled per-position accumulator + cursor across requests,
   process oldest→newest so discovery precedes events, finalize+cache when the cursor drains)
   OR Vercel Fluid (800 s). Until then the degradation is graceful — partial LP P&L numbers +
   a "scanning Solana closed history…" badge + the 305 s client budget, never a 504-loop.

## Recent fixes

Most recent first. Commit hashes are authoritative; descriptions are
shorthand.

- **`934a5ca`** — **ITEM 0d: Redis-cache the historical sqrtPriceX96 prices — the flip that
  made Capital G/L non-deterministic is GONE.** ITEM 0b proved the number moved because the
  CASCADE moved: tier 1 (pool `sqrtPriceX96` at the event's own block) answered on one load
  and not the next, and the lower tiers produce a different, non-historical basis. A finalized
  block's pool price is IMMUTABLE, so `v3HistoricalFeePrice.ts` now persists it in Upstash
  (`evm_hist_price_v1:{chain}:{pool}:{blockHex}`, 90 d) on the `evm_pos_ctx_v1` contract —
  own client, `PRICE_CACHE_KV_*`, no-op stub when unset, never throws, fire-and-forget writes,
  **POSITIVE RESULTS ONLY** (persisting a null would pin the position to a substitute basis
  for 90 days — freezing in the exact bug). `chain` is now passed by all five callers and the
  Redis tier is SKIPPED rather than guessed when absent, because the same pool address exists
  on several chains. **Verified with the archive RPC fully dead and a FRESH process:** both
  target positions still priced historically and exactly (dep $9,246.39 / wd $9,150.70;
  $9,153.80 / $8,818.06) where the same condition previously produced the tick-derived
  dep === wd $9,294.71 collapse. Substitute-basis spread **$690.49 → $0.00**; two consecutive
  loads reproduced Capital G/L −$3,656.47 to the cent. **Still not `deterministic ✓`** — the
  first load of a cold process excludes one position ($7,937.69 deposited) on a cold
  CoinGecko deposit-date price and discloses it; that is ITEM 0g and a different mechanism.
  No cache bumps to `lp-pnl-events`/`analytics-activity` — a cached value is byte-identical to
  a live archive read.

- **`c18cbd8`** — **ITEM 0b: an activity route may no longer SILENTLY SWAP PRICE BASIS.** A
  deposit/withdrawal whose own historical price wasn't available was quietly valued on a
  different basis and rendered as settled. Every activity event now carries an additive
  `priceBasis`, set ONLY when a substitute basis was used, across **10 routes** (aerodrome,
  velodrome, hyperswap, uniswap, pancakeswap, bluefin, cetus, orca, raydium, momentum —
  uniswap/pancakeswap/momentum were NOT in the original scope but carry identical code, so
  excluding them would have left the same bug live).
  **TWO substitute bases, found to need DIFFERENT handling — this is the load-bearing
  detail:** (1) `current-spot-substituted` is TRANSIENT (the price simply isn't warm), so it
  counts as pending AND is retried — the ITEM 0 machinery resolves it, verified end-to-end
  with a cold-then-warm harness: first request returned dep === wd === $10,147.12, the
  cache-bypassing retry returned the true dep $9,246.39 / wd $9,150.70. (2)
  `tick-derived-estimate` (`deriveDepositPrices`) is NOT transient — re-fetching returns the
  identical estimate — so it DISCLOSES but is deliberately NOT retried. **Making it retryable
  was tried and reverted:** it evicted every position on a loop (activity calls 33 → 71) and
  left the aggregate reading **$0.00 even after 260 s**, worse than the bug and a Rule 11
  violation. It is now disclosed-and-kept-in-totals (degraded run: Deposited $8,243.79 /
  Capital G/L −$1,857.40, both STABLE, `≈` shown, 17 activity calls).
  **The tick-derived basis is the one that actually fires in the browser** — the client passes
  ticks, so tier 2 covers for a failed tier 1 — and because it has no per-block input it
  applies ONE price to every event of a position, which is exactly why a closed position's
  deposit and withdrawal collapse to an identical figure and its Capital G/L goes to ~$0.
  **A DEAD COUNTER from ITEM 0 was found and fixed en route:** `sharedFields` snapshotted
  `spotFallbackEventCount` BY VALUE before the closed-path withdrawal loop incremented it, and
  the closed return spread `...sharedFields` without re-specifying it — so ITEM 0's
  withdrawal-side spot counter never reached the returned data on the CLOSED path, which is
  precisely where closed-position Capital G/L lives. Proven against `HEAD`: pre-fix `0`,
  post-fix `1` on the same input. Harness gains a permanent guard for the deposited ===
  withdrawn fingerprint (fails only when it renders as FINAL; disclosed-incomplete reports ⚠).
  **NOT fully closed — determinism remains open (ITEM 0d).** On healthy code, 3 loads still
  spread **$690.49**, with `71729936` flipping between historical $9,246.39 and tick-derived
  $9,294.71; every run now declares `≈ incomplete`, so no wrong number is presented as final,
  but the value still moves. **Cache bumps: `lp-pnl-events` v28 → v29, `analytics-activity`
  v20 → v21** (a cached pre-marker event would keep rendering as settled).

- **`4fcc617`** — **Sprint CAPGL-DETERMINISM: Capital G/L stops presenting an INCOMPLETE
  sum as a final total.** Same wallet, same build, two loads → different money: Account 1's
  Capital G/L spread **$2,297.38** across 3 identical loads with Net P&L flipping sign.
  **Cause (from evidence, not guessed):** Capital G/L depends on claim-date HISTORICAL
  prices, which the activity routes read **cached-only** while the warm-up is
  **fire-and-forget** (deliberate — CoinGecko must never blow the function timeout). Each
  load therefore valued whatever dates were warm at that instant. Two distinct consequences,
  both fixed: (1) a cold DEPOSIT price EXCLUDED the position outright
  (`missing_deposit_prices`); (2) a cold WITHDRAWAL price silently fell back to **CURRENT
  SPOT** (`positionPnl.ts` withdrawal last resort) — no exclusion, no warning, just a
  different number. (2) accounted for **exactly** the $738.81 that remained after fixing (1)
  ($654.28 + $84.53 on two positions). FIX: NEW `capitalGLComplete` /
  `capitalGLPricingPending` (computed from a preserved `rawReason`, because the friendly
  string cannot be classified — "Deposit price data unavailable" is transient, "No deposit
  events found" is permanent) + spot-fallback event counting; the UI renders **`≈` + dimmed +
  "incomplete — pricing N positions…"** instead of a confident figure; and a **bounded
  background retry** (15 s × 8) resolves it to the real total. **The retry needed
  cache-BYPASS to work at all** — both the localStorage event cache AND the server's
  `withActivityRouteCache` hold successes for 5 min, so the first attempt replayed the
  identical unpriced body and changed nothing (measured: 3 positions still pending after
  200 s). Retries now skip the client cache and vary the URL; steady-state loads keep the
  full cache benefit. Verified with the NEW **`scripts/capgl-determinism.mjs`** harness
  (N loads → diff; exits 1 on any variance, CI-ready).
  **MEASURE ON PRODUCTION, NOT LOCALHOST.** Spread **$2,297.38 → $654.28 (−71.5%)** on
  defidesh.com. A local single-server run of the SAME commit reported $59.48 (−97.4%) —
  **do not quote that figure**: one warm local server has far less cold-cache surface than
  production's multiple instances under concurrent CoinGecko pressure, which is precisely
  the variable this bug turns on. The local number was measured first and briefly recorded
  here; production is the honest one. Exclusions **4/3/1 → 0** in both environments;
  `Deposited` stable in both. **NOT fully closed** — three positions are still silently
  re-priced at CURRENT SPOT inside the activity route itself, which bypasses this fix's
  spot-fallback counter entirely (**ITEM 0b**, next up — and note `Deposited` looking "stable"
  is itself a symptom of that bug, not evidence against it), and token symbols drift
  (**ITEM 0c**, display-only). The harness
  correctly still reports `NON-DETERMINISTIC ✗`; it also caught two of my own errors during
  the work (my `≈` marker broke its own regex — its gap-detector flagged the run unreliable
  rather than scraping null; and its row key had to move off the label once the label itself
  proved non-deterministic). No cache bumps.

- **`44f2ef2`** — **Sprint SICKLE-CLOSED-REVERIFY: `SICKLE_CLOSED_SUPPRESSED` REMOVED
  — closed vfat/Sickle positions are live again.** The flag was a stopgap added 2026-08-02
  when a Sickle showed a Capital G/L of −$9,988.84. **Its stated rationale was WRONG on both
  counts**: it blamed the wallet-scope DECIMALS bug and asserted the position's real value
  was "~$1.20". The $1.20 came from a diagnostic that itself passed 18/6 decimals to a 6/8
  position (the bug reproduced inside its own diagnosis), and the −$9,988.84 was actually
  GAUGE-STAKING misclassification. Both underlying causes are now fixed (`78e80db` decimals,
  `494725f` gauge), so the suppression was removed and `isDerivedSickle` deleted with it.
  **The replaced comment is kept as a HISTORY block** in `PositionsContext.tsx` — the lesson
  (verify a "correct" value with a method that cannot share the suspected bug) is worth more
  than the code it replaced. Verification: the ORIGINAL test wallet `0x06C3…e09f` turned out
  to have **ZERO genuinely-closed positions** (3 ever-owned, all live), so removal is a
  NO-OP there and it could never have demonstrated anything — a second Sickle was found via
  factory `Deploy` logs (`0xf61df878…6292`, owner `0xcc11dd1e…e82b`, 1 closed + 1 open) and
  its closed position now reports **Capital G/L +$14.61, a gain, with closed rows present**
  (was suppressed, +$0.00). `0x06C3…e09f` unchanged (3 open, 0 closed, +$0.00); no value
  >$50M anywhere. **Accounts 1 and 2 moved (~$565 / ~$300) but NOT because of this change** —
  `/api/vfat/sickles` returns `[]` for both, so the filter was structurally incapable of
  touching them, and an identical-build control run showed a LARGER swing (see queue item B).
  Two findings recorded rather than fixed: (a) the **Empty-Sugar gate**
  (`aerodrome/route.ts:373-374` returns early on zero open positions, so
  `buildClosedPositions` never runs) means a closed-ONLY Sickle still shows nothing —
  verified on a Sickle with 6 burned positions returning count=0; (b) **Sugar DOES return
  some gauge-staked positions**, so the `isStaked` badge only appears on ones Sugar misses —
  cosmetic inconsistency, not a correctness issue. No cache bumps.

- **`494725f`** — **Sprint GAUGE-STAKING: a STAKED position was booked as CLOSED with its
  whole deposit as a realized loss.** Staking a Slipstream CL position transfers its NFT to
  the pool's GAUGE. Sugar's `positionsByFactory` enumerates only DIRECTLY-HELD NFTs, so the
  position vanished from its result — and the closed reconstruction
  (`closedIds = everOwned.filter(id => !heldIds.has(id))`, aerodrome/route.ts:125) read that
  absence as closure. It never called `ownerOf`, never checked burn status, never consulted
  withdrawal events. Live: vfat Sickle `0x06C3F412…e09f` position `73551608` — ~$10k still
  staked and earning AERO — showed a **−$9,988.84** Capital G/L. **NOT vfat-specific:** any
  address, EOA or contract, that stakes is exposed; vfat merely stakes routinely. (Account 1
  was unaffected — 7 genuinely burned, 1 held, 0 staked.) FIX: NEW
  `app/lib/evmGaugeStaking.ts` resolves what ACTUALLY happened to each unreturned tokenId —
  `burned` (genuinely closed), `staked`, `third-party` (transferred/sold), or `unresolved`
  (RPC failure). **Only `burned` is emitted as Closed**; the rest are excluded or emitted
  OPEN, so no verdict can produce a fabricated loss. Gauge identity is **DOUBLE-CHECKED** —
  the holder must report `nft() == positionManager` AND be the address `voter.gauges(pool)`
  returns; either alone could be an arbitrary contract, and if they disagree the position is
  excluded. Staked positions are valued from the pool's REAL `slot0.sqrtPriceX96` via
  `amountsFromLiquidity` (deliberately NOT the midpoint approximation in
  `uniswap/v3/route.ts:286-297` — that is an estimate, and this feeds a displayed dollar
  value), emitted in the OPEN shape with additive `isStaked` + `gaugeAddress`, which also
  keeps them out of Capital G/L (Rule 4, closed-only). Applied to Aerodrome AND Velodrome.
  **Trap worth remembering: `positions(uint256)` is `0x99fbab88`** — an earlier attempt used
  a transposed `0x99fd0e82` and reverted on every tokenId, which looks exactly like "position
  doesn't exist". Verified: `73551608` now **In Range, isStaked, $9,911.02** (was Closed
  −$9,988.84); wallet Capital G/L **−$9,988.84 → +$0.00** with `9,988.84` absent from the
  page; portfolio $9.8K → $19.7K and Net P&L −$10,008 → −$98.92 as the live asset is counted;
  **Account 1 regression byte-clean — 8 total, 7 Closed, 1 open, 0 staked, unchanged.**
  ⚠️ **Velodrome could not be exercised — no available test wallet holds Velodrome
  positions.** Safe by construction though: if `VELODROME_VOTER` were wrong, detection fails
  to `third-party` → EXCLUDED, never back to a fabricated loss. No cache bumps.

- **`78e80db`** — **Sprint ITEM-A: EVM wallet-scope per-event pool context.** The
  wallet-scope closed-position scans (`positionId=all` / `tokenId=all`) enumerated EVERY
  tokenId a wallet ever owned, unioned their logs, and decoded them ALL with ONE
  representative pool's decimals — "whichever position happens to be open". Amounts are raw
  integers, so the wrong decimals mis-scale by a power of ten, in EITHER direction:
  **inflation** (representative USDC/cbBTC 6/8 applied to 18-dec WETH → deposit events of
  **$342,298,111,238** and **$167,113,757,805**) or **crushing** (representative WETH/USDC
  18/6 applied to 6-dec USDC → **14 fee claims under $0.50 on Account 1**, one of which was
  truly ~$294). Crushing is the more dangerous half: it looks plausible, no magnitude filter
  can catch it, and it silently UNDER-reports. Only wallets holding pools with DIFFERENT
  decimal pairs are affected, which is why it survived. FIX: NEW `app/lib/evmPoolContext.ts`
  — the EVM analogue of `suiPoolContext.ts` (Contract invariant (i)) — resolves each
  position's OWN pool + token pair on-chain (first Increase log → mint tx receipt → pool's
  Mint log, whose `address` IS the pool → `token0()`/`token1()` → decimals via `resolveToken`,
  **never a blind 18**), Redis-cached (`evm_pos_ctx_v1`, immutable, 90 d; only POSITIVE
  results persisted so a transient failure can't freeze in). All three routes then **fan out
  per position through the already-correct per-position path** rather than reimplementing
  pricing — so accuracy is identical by construction (verified: fan-out $4,920.08 === direct
  per-position $4,920.08). Adds a **per-position `positions[]` breakdown** so a WALLET-WIDE
  total can never be attributed to one position, and an **`excluded[]`** list — a position
  whose context won't resolve is surfaced, NEVER decoded with a foreign pool's decimals
  (Rule 11). Uniswap's batched array-topic `getLogs` was removed (the batching saved calls
  precisely BY discarding position association); `MAX_WALLET_IDS=30` preserved. **The `<=
  $50M` artifact filter in `useWalletLevelFees` is DELETED** — a band-aid that caught only
  inflation, never crushing, and would have discarded a legitimate large claim. Verified:
  Account 1 (both decimal pairs) 8/8 positions, 0 excluded, 0 artifacts, and its USDC/cbBTC
  position now reads **$296.16 vs the documented true $294**; vfat Sickle 3/3 with correct
  6/8 + 18/6, **0 events >$50M** (was two, at $342bn/$167bn); Uniswap Arbitrum 3/3.
  **⚠️ Velodrome executed only its empty branch — no test wallet holds Velodrome positions;
  Uniswap verified single-pair only. Owner-accepted risk.** **⚠️ `SICKLE_CLOSED_SUPPRESSED`
  is UNCHANGED — closed vfat positions REMAIN SUPPRESSED**, because the gauge-staking
  misclassification (queue item A caveats) is unrelated to decimals and still open.
  No cache bumps to `lp-pnl-events`/`analytics-activity`; new `evm_pos_ctx_v1` key only.

- **`866ead0`** — **EVM dashboard showed a STALE address as "Connected" and fetched
  every position against the WRONG wallet.** Confirmed in production: the user's chip showed
  a valid-looking address with ZERO positions while their actual Rabby account held the
  funds. Root cause: `defidesh-evm-addr` is treated as authoritative identity but is only
  ever corrected when wagmi holds an **active connection** — and an installed, unlocked,
  already-authorized wallet does **NOT** by itself make wagmi connected (wagmi reconnects
  only from its own stored state). So a stale address was displayed and queried
  **indefinitely**, and reloading did not fix it. Direct consequence of the `f64da31`
  session-persistence amendment, which made a cached address visually identical to a live
  connection with no reconciliation path. **Ruled out first** (all measured, not assumed): a
  locked wallet does NOT block fetching (simulated EIP-6963/1193 provider returning `[]` for
  `eth_accounts` — all 5 EVM routes fired, positions rendered); the routes are healthy
  (aerodrome 200/3, uniswap-v3/velodrome/hyperswap/pancakeswap 200/0, 0.6–1.7 s); and only
  two writers to the key exist, so it cannot be poisoned. Fixes: (1) NEW
  `evmIdentitySource: "live" | "restored"` + a separate `restoreEvmAddress()` so no call
  site can promote a cached address to authoritative; (2) **silent `reconnect()` on mount**
  — the core fix, promoting an already-authorized wallet to a live connection with no
  prompt; (3) NEW `EvmUnlockWatcher` listening to the injected provider's `accountsChanged`
  / `connect` DIRECTLY (wagmi only surfaces those for a connector it is ALREADY connected
  to — the failing case is the opposite) plus a `visibilitychange` sweep; (4) live always
  overwrites restored and rewrites storage. **No manual query invalidation needed** —
  `PositionsContext` keys queries by address, so correcting it refetches automatically.
  UI: a restored chip renders dashed + `LAST USED` with an honest tooltip, never
  "Connected" — applied to **BOTH** `Navbar.tsx` and `TerminalNavbar.tsx` (the dashboard
  renders the latter; editing only the former silently did nothing, caught in verification).
  Verified: stale+unlocked → corrected, In Range (2); stale+locked → honest `LAST USED`
  marker, 0 positions; **unlock mid-session with NO reload → chip flips, positions 0→2**;
  account switch live → chip/positions/storage all follow; **GUARD: explicit-disconnect flag
  still wins even with an unlocked wallet present** (wallet-security Rule 1 intact — silent
  reconnect is exactly the change that could have violated it); clean browser 0 errors.
  **`.claude/rules/wallet-security.md` Rule 1 AMENDED** — a restored identity must be
  VISIBLY distinct from a live connection, live must win, and reconciliation must not
  require a reload; the original wording permitted the restore but never required it be
  distinguishable, which is the gap that caused this. **Limit: verified against a SIMULATED
  provider, not a real Rabby extension** — real event timing may differ; the
  `visibilitychange` fallback covers a wallet that unlocks silently. Worth one real check:
  load with Rabby locked (expect dashed `LAST USED`), then unlock without touching the page.
  Note a visible behaviour change: the chip now shows `LAST USED` whenever the wallet is
  locked at load — intended honesty, not a regression. No cache bumps; identity layer only.

- **`5bec9df`** — **Sui/Solana wallets self-disconnected and had to be re-added by
  hand, every time.** Root cause: `app/components/WalletRestoreEffect.tsx` (mounted at the
  root, so it ran on every page) DESTROYED persisted state in response to an ambiguous
  reading from an asynchronously-initialising adapter. Two paths: (1) `useWallets()` is
  populated ASYNCHRONOUSLY — Wallet Standard extensions announce via window events after
  load, so the array is empty on first render whether or not a wallet exists; the code read
  `suiWallets.length === 0` as "not installed" and deleted our `defidesh-sui-addr` **AND
  dapp-kit's private `dapp-kit:wallet-connection-info`**. (2) `useCurrentAccount()` is null
  until autoConnect resolves, so ANY momentary null (extension hiccup, wallet switch,
  extension update, tab backgrounding) permanently deleted the saved address. **Deleting
  dapp-kit's key is what made it unrecoverable** — dapp-kit could no longer auto-reconnect,
  forcing a manual re-add. Reproduced live: both keys gone **within 500 ms** of page load;
  `defidesh_sui_disconnected` was never set, so this was NOT a regression of the
  disconnected-flag mechanism (that still works). Fixes: a **15 s settle gate** before any
  cleanup (deliberately generous — a 3 s window would have left the bug alive in the
  reported "correlates with browser restarts" case, where a cold-start extension can
  announce late and the key would be deleted moments before the adapter reconnects); a
  **2 s debounce** so a transient null cancels instead of destroying; **never touching
  another library's private storage** (`dapp-kit:wallet-connection-info`, Solana's
  `walletName`) — only our own `defidesh-*-addr`; **normalized** Sui comparison via the
  official `normalizeSuiAddress` (Solana stays exact — base58 is case-sensitive); and the
  **duplicate copy in `Navbar.tsx` removed** (−137 lines) so ONE component owns
  restore/persist/clear. Navbar keeps only the explicit-connect capture. A THIRD copy — an
  undebounced Sui clear still live in Navbar — was found and removed during the fix.
  Identical treatment applied to the Solana block (same structure, same latent bug).
  **THE RULE, worth not re-deriving: an "empty"/"absent" reading from an asynchronously
  initialising adapter is NOT EVIDENCE OF ABSENCE — never take a destructive action on it
  until it has settled.** `providers.tsx`'s `useClearOnConfirmedConnect` already skipped its
  first effect run for exactly this reason; the lesson simply hadn't been applied here. Same
  principle as `suiRpcIndexed()` throwing rather than returning a misleading empty.
  Verified: seeded identity survives 10 s (was gone in <500 ms), dapp-kit/walletName never
  deleted, explicit-disconnect flag still wins, EVM positions unaffected (In Range (2), 0
  errors). **Limit: could not install a real Sui extension headlessly, so the
  announce→restore→reconnect cycle is reasoned, not measured — worth one manual
  connect/close-browser/reopen check.** No cache bumps; display/identity layer only.
  **Bug 1 (EVM "connected but no positions" on a locked wallet) is NOT addressed here** —
  it did not reproduce (EVM position routes are server-side by address and never touch the
  extension; nothing clears EVM identity on a wagmi event). Open hypothesis: it was this
  same Sui bug misattributed. Needs the user to say which chain the missing positions were on.

- **`20693ca`** — **Sprint WRAPPER-PROTOCOLS: vfat / Sickle (EVM) — OPEN positions.**
  vfat deploys a **Sickle**, a per-user smart-contract wallet (one per user per chain)
  that HOLDS the user's AMM position NFTs — so the EOA owns nothing and DefiDesh's EVM
  readers returned **zero** for every vfat user. Same wrapper-invisibility class as
  DefiTuna, now on EVM; ~$30.9M TVL, concentrated on Base, wrapping the exact AMMs
  DefiDesh already decodes. Discovery is the whole fix: NEW `app/lib/vfatConfig.ts`
  (per-chain SickleFactory map — the address is **NOT uniform across chains**, so config,
  not branch, Rule 2), NEW `app/api/vfat/sickles` (one `eth_call` to
  `sickles(owner)` per chain, in parallel, deployed Sickles only, Rule 11 per-chain
  degrade), NEW `app/lib/vfatSickleCache.ts` (`vfat_sickles_v1`: a **deployed** address is
  immutable → 30 d; **"none found" → 5 min**, so a newly-created Sickle isn't hidden;
  a PARTIAL empty is never cached), NEW `app/lib/vfatSickle.ts` (client wrapper).
  `PositionsContext` builds `evmFetchAddresses = evmAddresses ∪ resolvedSickles` and drives
  the EVM fan-out from it. **`evmFetchAddresses` is deliberately SEPARATE from
  `evmAddresses`** (identity → wallet chips + `/api/wallets/register`): a Sickle is a
  derived sub-account and must never become a chip or a registered wallet — verified live
  (0 register POSTs, address absent from UI text, navbar shows the OWNER). Resolution is
  its own `useQueries` so it never gates first paint (Rule 10 — 311–404 ms measured).
  Simple approved fan-out: each Sickle scanned against ALL EVM fetchers, as watched
  wallets already work; per-chain-restricted fan-out and offline CREATE2 `predict()` are
  documented future optimizations. **Ethereum factory recovered** —
  `0x9D70B9E5ac2862C405D64A0193b4A4757Aab7F95` (truncated in the Phase A record), verified
  live. Verified on third-party wallet `0xD4bE…db87` → Sickle `0x06C3F412…e09f`: EOA
  through `/api/aerodrome` = **0 positions**, same UNMODIFIED reader at the Sickle = **3**;
  dashboard **In Range (2), Closed (0)**; Phase A's NFT `73552127` $4,904.64 → $4,904.86
  (+0.0045%, price drift); negative control clean; 0 page errors.
  **⚠️ SHIPPED AS OPTION 2 — CLOSED positions SUPPRESSED** (`SICKLE_CLOSED_SUPPRESSED`),
  deviating from the plan's "closed in scope", because verification exposed the
  **pre-existing non-vfat decimals bug now tracked as queue item A** (wallet-scope scan
  applied one pool's decimals to every event → $342bn/$167bn deposit events → a confident
  Capital G/L of −$9,988.84 vs a real ~$1.20 leg). **Proven not caused by this work** — the
  same Sickle added as an ordinary watched wallet reproduces it byte-identically.
  Suppression is scoped to DERIVED Sickles only (a user-added one behaves normally) and
  provably does not touch open numbers: Deposited $9,855.53 / Current Value / IL +$31.56
  identical on and off; only Capital G/L moves (−$9,988.84 → +$0.00). **Delete the constant
  when item A ships, and re-instate gates 10a/10b** (both relaxed by owner decision for
  this narrower ship — see item A and the report). **No cache bumps** to `lp-pnl-events` /
  `analytics-activity` (Sickle positions are new per-position entries; no existing entry
  changes shape); new `vfat_sickles_v1` key only. Report:
  `reports/wrapper-protocol-landscape-survey-report.md`.

- **`1986313` + `0f33321`** — **UI/DESIGN: design-token theme system (light + dark), home v2
  live, LP calculator.** NOT a sprint — accumulated local UI work shipped in one pass, and
  the first change to the product's visual layer since the terminal-green original. NEW
  `app/tokens.css` is now the **single source of truth for colour** (three tiers:
  primitives → semantic → component; only the SEMANTIC tier may be referenced by a
  component). **A raw hex in a .tsx is now a bug**, with ONE deliberate exception: chain/
  token BRAND colours (`--chain-solana` etc.), which are external identity and stay
  mode-invariant on purpose. Light mode swaps `data-theme` on `<html>` and rebinds the
  semantic tier only; `app/components/theme/ThemeScript.tsx` stamps the attribute in a
  BLOCKING inline `<head>` script (resolution order: stored choice → OS preference → dark)
  so there is no flash of the wrong theme — never move this to a `useEffect`. Tailwind v4
  `@theme inline` maps the tokens to utilities (`bg-surface`, `text-fg-muted`,
  `border-line`, `text-pos/neg/warn/info`, `text-accent`), which is why `inline` matters:
  it keeps the `var()` live so a swap is instant rather than a rebuild. **Home v2**
  (`app/components/home/*`) is gated on `NEXT_PUBLIC_HOME_V2 === "1"`, now set for
  **Production** in Vercel (Preview/Development deliberately NOT set — the old home still
  renders there). Restyled onto tokens: dashboard (+ lending, wallets, position detail),
  analytics, about, docs, wallet, watched, navbar, sidebars. NEW `/lp-calculator` (IL +
  hedging; standalone, **no navbar and unlinked from any nav — reachable only by direct
  URL**). Deps added: framer-motion, lucide-react, clsx, cva, tailwind-merge, radix Slot
  (shadcn base in `components/ui` + `lib/utils.ts`); playwright as a devDependency.
  `0f33321` is the follow-up that migrated the calculator itself onto the tokens (it had
  shipped fully dark in light mode), fixed its 390px layout (nested `grid-cols-2` was
  producing four ~80px columns; `flex-1` presets forced a min-width wider than the viewport
  and overlapped the next row), and fixed the **HYPE logo**: the page carried a private
  `TOKEN_IMAGES` map — the per-route token map **architecture Rule 9 forbids** — whose HYPE
  entry pointed at CoinGecko image id 37880, which answers **403 with an
  `application/xml` body**, so Chrome's Opaque Response Blocking rejected it and the logo
  was broken for every visitor; `tokenLogos.ts` already had the corrected id 50882 on
  `coin-images.coingecko.com` and the private copy simply never received it. Now imports
  the shared `TOKEN_LOGOS`. **NO pricing, valuation, position-discovery, or cache logic was
  touched anywhere in either commit — display layer only, so NO cache bumps.** Verified
  (Playwright, clean ephemeral profile, no wallet): 30 production page loads (10 pages ×
  light/dark/mobile) = **0 JS page errors, 0 console errors, 0 page-level horizontal
  scroll**, `data-theme` correct on all 10; calculator re-verified on a local production
  build across light+dark × 1440/390 × both tabs = 0 errors, 0 broken images, 0 page
  overflow. **Verification gotcha worth remembering: a `fullPage` screenshot does NOT
  trigger `whileInView` reveals**, so home v2's sections photograph blank unless the script
  scrolls the page first — that is a tooling artifact, not a bug.

- **`4a25c69`** — **Sprint WRAPPER-PROTOCOLS Phase 2 Part 1: leverage & liquidation on the
  wrapper detail page.** A leveraged LP user's most important number — distance to
  liquidation — was invisible product-wide; Phase 1 already FETCHED it and threw it away
  (route mapped positions down to the generic shape; `entry_price` /
  `liquidation_price_lower/upper` were never even parsed into `TunaItem`). NEW additive
  `AerodromePosition.wrapperMeta` (leverage, entry/current price, both liquidation prices,
  debt, collateral, gross total, pending yield, state) + a "Leverage & Liquidation" detail
  panel: equity vs debt vs gross LP value (labelled "NOT your value"), leverage on
  collateral, and distance-to-nearest-liquidation (red <10%). A `0.0` liquidation bound
  means that side CANNOT liquidate → renders **"n/a", never "$0.00"** (which would read as
  infinitely safe). `isReconstructed` drops `tuna-` (rows now clickable; sui-closed-/
  solana-closed- keep theirs). **NO calculation logic changed** — pass-through only, nothing
  in the P&L pipeline reads `wrapperMeta`, panel gated on `{wm && …}`. TWO LATENT DISPLAY
  BUGS fixed en route (exposed by the page becoming reachable): heading read "Token0 /
  Token1", and the price range read **$31,700,353,983 → $33,205,832,149** — `tickToUSD` fell
  back to EVM decimals (18/6) on a 9/6 Solana pair; the API returns `decimals` in the same
  `mints` block as the symbols and Phase 1 read one but dropped the other. Now $31.70 →
  $33.21, verified against the pool's own price (`tick_current −25545` → `1.0001^t × 10³ =
  77.7410` vs `pool.price 77.74147`). Verified live (Playwright, clean profile, third-party
  wallet `2rr3SFuM…`): equity $198.71 / debt $596.47 / gross $795.17 (exact) / 4.00× /
  16.7% from liquidation; detail headline === panel equity on 3/3 positions; Orca control
  (RAKA/A1 ZEC/USDC) unchanged, no panel, TOTAL VALUE === row exactly. Report:
  `reports/wrapper-protocols-phase2-part1-report.md`. No cache bumps.

- **`4c450a1`** — **Sprint WRAPPER-PROTOCOLS Phase 1: DefiTuna (Solana).** Wrapper-held
  leveraged Orca LP positions (NFT in Tuna's vault — invisible to the wallet census) now
  visible platform-wide. Hybrid source: DefiTuna public API primary + per-position
  ON-CHAIN verification (owner=tuna program, authority @ byte 11). EQUITY semantics
  (value = total − debt; fees = pending yield; tick-based range). NEW generic mechanism:
  `AerodromePosition.selfReportedPnl` → `useLpPnl.buildSelfReportedPnL` (netPnl = equity
  + yield − collateral, no activity route, no excluded-banner noise) — next wrapper
  protocol reuses it untouched. Verified on third-party wallet `2rr3SFuM…` (6 live
  positions, equity−collateral matches Tuna's own pnl; browser: allocation DefiTuna
  96%/$515, analytics Deposited $561.20/Net −$23.87, zero exclusions). No cache bumps.

- **`00cd1bc`** — **Sprint 4 SHIPPED: clickable Capital G/L breakdown + closed-rows UI**
  (queue item 4 folded in). Analytics Capital G/L cell click-expands to a per-closed-
  position table (pair/protocol/chain, opened/closed dates, deposited, withdrawn,
  lifetime fees, per-position G/L) built in aggregate() from EXACTLY the per-position
  values the total sums — footer === cell BY CONSTRUCTION (verified programmatically:
  −$12,779.66 exact, Withdrawn−Deposited === footer to the cent). New additive
  `LpPnlResult.closedRows`; `PositionMeta` carries openedTs/closedTs. Dashboard:
  reconstructed CLOSED Sui/Solana positions render as greyed Closed-tab rows with close
  dates (RAKA Closed 11 → 61), synthesized display-only (never in the source positions
  array), P&L from the same perPosition entries; dashboard now passes Sui/Solana wallet
  sets to useLpPnl (it previously never fetched closed reconstructions). Rows
  non-clickable (no live object for a detail page — follow-up candidate). Display-only,
  no valuation changes, no cache bumps.

- **`f64da31` + `f9c9f84`** — (1) **EVM session persistence** (owner-requested, wallet-security
  Rule 1 AMENDED): WalletAuthContext gains `evmAddress` — live wagmi address when unlocked,
  else the persisted last-confirmed address (`defidesh-evm-addr`) restored on load unless
  the `defidesh_evm_disconnected` flag is set; all 13 `useAccount` consumers now read the
  context identity (wagmi = mechanics only, same architecture Sol/Sui used). Verified: no
  extension → chip + all 5 EVM routes fire; flag set → "no wallet". (2) **Dashboard APY
  derived-APR fallback** (`f9c9f84`): pools absent from DefiLlama (Orca ZEC/USDC) show
  "~X% est." from own earnings instead of N/A — same formula as detail page/analytics.
  Also verified this session: RKHA Net P&L arithmetic EXACT (Net = Current − Deposited +
  Fees + Unclaimed + CapG/L = −$3,713.40; the pricing-invariants Rule 4 formula text
  differs from the implemented — flagged to Osho, code unchanged); RKHA closed-Sui
  CapG/L −$14,355.36 (26 pos) + EVM ≈ −$1,861 = −$16,216.88 shown.

- **`c96d7fa`** — Navbar wallet chips show WATCHED + SCANNED wallets, not only connected
  (the bar said "no wallet" while the pages below were full of watched-wallet positions).
  Chips mirror exactly what the pages compute over: scan mode → single `·SCAN` chip;
  otherwise connected + watched deduped, capped at 4 + "+N" overflow (hover lists rest).
  Verified LIVE: Krishna watched set shows all three chips; scan URL shows SUI·SCAN.

- **`e85f794`** — Analytics honors paste-a-wallet SCAN mode (wallet-security Rule 3
  parity): the paste flow showed positions on the dashboard but an EMPTY analytics page
  (the page built its wallet lists from connected+watched only and never read
  `scanAddress`, so zero /api calls fired). Fixed by mirroring PositionsContext's exact
  scan-override semantics in `app/analytics/page.tsx` (scan set ⇒ effective identity =
  ONLY the scanned address on its chain) + a Suspense-wrapped `AnalyticsScanModeListener`
  so `/analytics?address=&chain=` survives hard refresh (absent params do NOT clear an
  active scan — in-app nav keeps it). Verified LIVE on defidesh.com with a clean profile
  and ZERO watched wallets: `/analytics?address=0x15ace…2eff&chain=sui` renders full
  analytics (Cetus USDC/SUI $948.28, Sui closed Cap G/L −$2,147.75, lending, Earning
  Flows); pre-fix the same URL rendered the $0 empty state. Scan scope stays ONE
  address on ONE chain by design. No cache bumps.

- **`75d7619`** — DeFiLlama historical `searchWidth=24h`: the "1 claim pending" that never
  resolved (Krishna DEEP/SUI fee claim 2025-07-03) was a DeFiLlama SPARSE-SERIES gap —
  its default nearest-point search is narrower than our documented ±24h acceptance
  window, so `{coins:{}}` came back even though a same-day point existed 6.1 h later.
  `?searchWidth=24h` lets DeFiLlama return that point; the existing `MAX_TS_DRIFT_SEC`
  ±24h validation still gates it (Rule 1c unchanged, never spot). Platform-level: any
  sparse-coverage token. No cache bumps (in-process negative cache clears on deploy;
  misses were never Redis-persisted; client nulls are 5-min TTL). Verified LIVE: Krishna's
  pending-claims note GONE post-deploy; DEEP@2025-07-03 = $0.153162
  (`defillama_historical_used`). **NEW KNOWN LIMITATION discovered en route: CoinGecko
  free tier now rejects `/history` >365 days old (error 10012)** — DeFiLlama is the ONLY
  claim-date source for >1-year-old claims, so its coverage gaps become permanent
  pendings as positions age (see Known limitations).

- **`87db23d`** — Cetus V1 events + Tenderly throttle + honest Sui index fallback (Krishna
  DEEP/SUI investigation). (1) **Cetus V1 `AddLiquidityEvent`/`RemoveLiquidityEvent`**
  (original pkg `0x1eabed72…`, no V2 suffix, same fields, no `current_sqrt_price`) now
  parsed by cetus/activity AND suiClosedPositions — pre-V2 deposits/withdrawals were
  invisible → false "No deposit events found" → positions EXCLUDED from Capital G/L
  (or WRONG Cap G/L on a missed V1 withdrawal). V2 txs emit only V2 events (verified
  live) so no double count; package allowlist keeps Momentum's identical names out.
  **Cache bumps: lp-pnl-events v28, analytics-activity v20, cetus-activity v5,
  closed_pos_sui v2.** (2) **Tenderly 403**: the public Base gateway hard-throttles
  concurrent getLogs per IP (403 on Vercel's shared IP; serial calls instant) —
  `evmRpcPost` backoff-retries 403/429 (serial inside the semaphore slot),
  TENDERLY_CONCURRENCY 8→2, optional keyed `TENDERLY_NODE_RPC` env (rpcUrlFromEnv),
  throttle errors fall through to publicnode instead of the terminal throw→500.
  (3) **`suiRpcIndexed()`**: object-filter queries (ChangedObject/InputObject) pinned to
  the PRIMARY endpoint; the public fullnode answers a silent `{data:[]}` for indexes it
  doesn't serve, so unavailability now THROWS `SuiIndexUnavailableError` ("I don't
  know") instead of masquerading as "no results". Verified LIVE on defidesh.com
  (browser): Krishna settled excluded=0 (was 4), Cap G/L −$6,110.45 (was −$4,317.77
  with DEEP/SUI + 3 Aerodrome missing), fees +$3,166.33 (was $2,398.40); RAKA
  regression-clean (deposited byte-identical $27,575.35; Cap G/L −$12,125.39 vs
  −$12,432.75 = 2.5% closed-Sui rescan daily-price tolerance). NOTE: Alchemy's Sui
  object-filter indexes are ~1-yr shallow (returned 3 of 5 txs for the DEEP/SUI
  position) — ChangedObject is a weak net; FromAddress reached 2025-02 complete.

- _(`7784ed2` — RPC env-var URL guard (`app/lib/rpcEnv.ts` `rpcUrlFromEnv`): a MALFORMED
  URL-typed RPC env var now behaves exactly like UNSET instead of throwing a hard 500 that
  silently corrupts Capital G/L. **Standing pattern: ANY URL-typed RPC env var must be read
  via `rpcUrlFromEnv`, never `process.env.X` straight into `fetch`** — rolled off this list;
  see git history.)_

- _(Sprint SPOT-RESILIENCE-V2 `c6e31ee` — per-position last-known-good (LKG) + degrade funnel
  (STALE→ESTIMATED→EXCLUDED) so a transient per-position failure never deletes a position from
  LP P&L totals; NEW `app/lib/evmRpc.ts`; architecture Rule 11 — rolled off this list; see git
  history + memory.)_
- _(Sprint SUI-RPC-RELIABILITY `8d82287` — shared paced+failover Sui RPC client
  (`app/lib/suiRpc.ts`, 12 s timeout + semaphore 8) fixes the "N Sui positions failed — RPC
  timeout" dropped-position bug; Contract invariant (l) — rolled off this list; see git
  history + memory.)_
- _(Sprint LPPNL-PERF `535453e` — killed the 5-min analytics "calculating…" spinner
  (progressive aggregate render, architecture Rule 10) + closed-Solana Cap G/L always
  complete (`maxDuration=300` + in-flight dedup) — rolled off this list; see git history +
  memory.)_
- _(Sprint RAYDIUM `d7c6c81` — Raydium closed-position Cap G/L + fix for a SILENT
  platform-wide open-position failure (bump-first layout broke the memcmp lookup); Solana now
  Orca+Raydium full parity — rolled off this list; see git history + memory.)_
- _(Sprint 3-FREE `d1bf447` — MILESTONE: cross-chain Capital G/L COMPLETE (EVM+Sui+Solana) on
  FREE Alchemy; Solana (Orca) closed-position reconstruction via paced-scan pattern — rolled
  off this list; see git history + memory.)_
- _(Sprint POSITION-DETAIL `82d4954` — Sui pending REWARD emissions on the detail page +
  derived-APR fallback for long-tail pools; B3 Solana rewards / B4 EVM gauge → POSITION-DETAIL-2
  — rolled off this list; see git history + memory.)_
- _(Sprint PERFORMANCE `f4b58ac` — market_chart batch-fill (`fetchDailyClosesRange`) +
  patient fetch + progressive rendering; >2-min load → first meaningful render ~1–4 s, Sui
  routes 9–24 s; baselines now a platform requirement (see Methodology); #4–#6 →
  Sprint PERFORMANCE-2 — rolled off this list; see git history.)_
- _(Sprint SUI-HISTORICAL-REDIS `776fcaa` — cross-instance Redis tier for SUI historical
  prices; fixes the post-deploy regression where the 3 Sui protocols vanished from the
  analytics Fee Income breakdown (cold-instance ~63s serial SUI-price crawl); Sui
  wallet-scope routes ~111s → ~18–20s — rolled off this list; see git history.)_
- _(Sprint SPOT-RESILIENCE `92e779a` — tiered Redis LKG for the CoinGecko SPOT path
  (`redisSpotCache.ts`, `cg_spot_v1`); fixed the persistent "Current price data unavailable"
  banner on OPEN positions; Rule 1a untouched (SPOT/Rule 2 path only); Contract invariant (j)
  — rolled off this list; see git history.)_
- _(Sprint TOKEN-RESOLUTION `a866576` — per-event Sui pool resolution for wallet-scope fee
  claims; fixed ~$3,847 missing Fee Income for closed-only Sui wallets (hardcoded
  single-pair fallback was the architectural root cause); `suiPoolContext.ts`; Contract
  invariant (i) — rolled off this list; see git history.)_
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

**Shared chain RPC transport** (canonical — Contract invariant (l), Sprint
SUI-RPC-RELIABILITY `8d82287`):
- `app/lib/suiRpc.ts` — `suiRpc(method, params)`: EVERY Sui read routes through
  it. Ordered endpoints (`SUI_RPC_URL`/Alchemy primary → public fullnode
  fallback) with automatic failover on timeout/429/5xx; 12 s per-call timeout;
  global concurrency semaphore 8. Never add a bare `fetch(SUI_RPC)` to a route.
  A new chain builds its shared client FIRST (Solana's paced-scan client in
  `solanaClosedPositions.ts` is the same principle for backfill scans).
- `app/lib/suiPoolContext.ts` also L2-caches immutable pool coinType/decimals in
  Redis (`sui_pool_ctx_v1:{poolId}`, 90 d) and batches via `sui_multiGetObjects`.

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

**Performance is a platform requirement (Sprint PERFORMANCE `f4b58ac` +
LPPNL-PERF `535453e` baselines).**
New sprints must not regress: **first meaningful render ~1–4 s** (positions stream
per source — never reintroduce an all-or-nothing `Promise.all` gate on the
positions array); **the analytics LP P&L aggregate block shows first numbers ~2 s
and NEVER an endless "calculating…" spinner for ANY wallet** (Sprint LPPNL-PERF —
cells render partial values once `included>0`, closed-scan progress shows as a
non-blocking badge, never a full-block skeleton); and **Sui activity routes
~10–24 s** (scan-bound; the SUI historical prewarm is batch-filled via
`fetchDailyClosesRange` + Redis). Any hook consuming the streaming positions array
MUST carry in-flight dedup (by position id or URL) so per-wave effect re-runs never
re-fire an in-flight fetch; the closed-scan routes are in-flight-deduped
(`withActivityRouteCache` + a module-level per-wallet promise map) so the concurrent
useLpPnl + useWalletLevelFees double-fetch collapses to ONE scan. **Any aggregate
block MUST render progressively — the "no partial totals reveal" all-or-nothing
gate is a removed anti-pattern (architecture-principles Rule 10).** Client fetch
policy is one patient attempt, retry only on network/5xx, never on timeout; the
closed-scan client fetch carries a 305 s budget so Capital G/L is never silently
pending forever. Long server scans set `maxDuration=300` (vercel.json glob
`app/api/**/*`). Verify these numbers as part of B7 for any sprint touching the
load path.

---

## Known limitations

**CoinGecko free-tier historical horizon is a ROLLING 365 days (found 2026-07-19).**
`/coins/{id}/history` returns error 10012 for dates >365 days old on the public plan.
Consequences: (1) any claim older than 1 year that isn't already warm in the Upstash
Redis historical cache can NEVER be CG-priced — DeFiLlama historical-by-contract is
the only remaining claim-date source, so DeFiLlama coverage gaps become permanent
pending claims as positions age (mitigated for sparse series by `75d7619`
searchWidth=24h; a token DeFiLlama doesn't cover at all stays pending per Rule 1a);
(2) the Redis historical cache's value grows over time — a warmed >1-year-old price
is irreplaceable on free infra; treat broad flushes of `price:historical:*` as
DATA LOSS, not just a slow rebuild. A paid CG key (~$129/mo) lifts the horizon;
deferred (budget) — revisit if >1-year-old pending claims accumulate in production.

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

**Solana closed positions — RESOLVED for BOTH protocols (Orca Sprint 3-FREE
`d1bf447`; Raydium Sprint RAYDIUM `d7c6c81`).** The position NFT is burned on
close, but `app/lib/solanaClosedPositions.ts` reconstructs each lifecycle from
wallet tx history via the FREE Alchemy endpoint (`ALCHEMY_SOLANA_RPC` — the paid
Helius upgrade was never needed), with ONE shared scan serving both protocols,
and folds Capital G/L + fees into `useLpPnl`/`useWalletLevelFees` (Redis-cached
`closed_pos_solana_v1:{orca|raydium}:{wallet}`). Sprint RAYDIUM also fixed a
SILENT PLATFORM-WIDE bug: Raydium OPEN positions returned `[]` for every user
(bump-first account layout broke the memcmp lookup — now direct PDA derivation).
Remaining gap: Closed-row UI (queue item 4, shared with Sui). Production requires
`ALCHEMY_SOLANA_RPC` in Vercel env vars — without it (or with a MALFORMED value) the
engine degrades gracefully to "no Solana closed positions" (no errors, silently
incomplete). **✅ Confirmed correct and live in production 2026-07-21** (see the
resolved carry-over above for the value-format incident and the cold-scan proof).
Because the degrade is silent and the var is `type: sensitive` (unreadable), the ONLY
way to verify this path is a forced cold scan — delete the wallet's
`closed_pos_solana_v1:{protocol}:{wallet}` Redis key and confirm the request takes
40–120 s rather than returning fast-and-empty.

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
  Capital G/L (Sprint 2.2b, `closed_pos_sui_v1:*`) + closed-Solana-position
  Capital G/L (Sprints 3-FREE/RAYDIUM, `closed_pos_solana_v1:{orca|raydium}:*`) +
  **SPOT-price LKG (Sprint SPOT-RESILIENCE `92e779a`, `cg_spot_v1:{cgId}` →
  `{usd, at}`, 24h retention / 5-min freshness; `app/lib/redisSpotCache.ts`)** +
  immutable Sui pool metadata (Sprint SUI-RPC-RELIABILITY `8d82287`,
  `sui_pool_ctx_v1:{poolId}`, 90d). Env:
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
- Alchemy Sui (`SUI_RPC_URL`, confirmed set in Vercel) — PRIMARY for ALL Sui reads via the
  shared `app/lib/suiRpc.ts` client (Sprint SUI-RPC-RELIABILITY `8d82287`: automatic
  failover to the public fullnode + 12 s timeout + concurrency semaphore 8 — never a bare
  fetch against a single endpoint; Contract invariant (l)).

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
- `lp-pnl-events-v28` / `analytics-activity-v20` / `cetus-activity-v5` /
  `closed_pos_sui_v2` (all `87db23d` — Cetus V1 Add/RemoveLiquidityEvent now parsed;
  pre-V2 deposits/withdrawals enter cached LP-P&L / Fee Income / closed-Sui
  reconstructions, so all four flush. closed_pos_sui v2 also rebuilds bluefin/momentum
  entries once — parsing unchanged there, shared version prefix, immutable re-scan.)
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
- `closed_pos_solana_v1` (Sprint 3-FREE `d1bf447` + Sprint RAYDIUM `d7c6c81` — Upstash
  Redis cache of reconstructed CLOSED Solana positions' Capital G/L + fees, per-protocol
  sub-keys `closed_pos_solana_v1:orca:{wallet}` and `:raydium:{wallet}` (ONE shared scan
  writes both). Non-empty: 30d TTL. **Refined empty rule (Sprint RAYDIUM, user-approved):
  an EMPTY result is cached ONLY when the scan was provably 100% complete
  (`stats.complete`), with a 24h TTL** — transient/partial-scan empties still never cache
  (Sprint 1.14 intent preserved); this stops single-AMM wallets re-paying the 40–120s scan
  every load. Caches a COMPUTED valued result → versioned key; bump on a valuation-logic
  change. `lp-pnl-events`/`analytics-activity` NOT bumped for either sprint — closed
  Solana positions were never in the dashboard positions array, and no Raydium
  localStorage entries could exist (the open-position route returned [] for everyone).
  Env: `PRICE_CACHE_KV_*`)

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
