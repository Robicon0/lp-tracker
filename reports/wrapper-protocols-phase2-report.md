# Sprint WRAPPER-PROTOCOLS Phase 2 — Phase A Investigation Report

**Date:** 2026-07-21
**Status:** Investigation only. No implementation code written.
**Test wallet:** `2rr3SFuM8YNFcn9RUvqGNPki8rxaXjHDscQuy7wNJTpn` (third-party, 7 live Tuna
positions, 200 signatures of history — the same wallet used to verify Phase 1)

---

## Executive summary

| # | Area | Verdict | Complexity | Priority |
|---|---|---|---|---|
| 1 | Closed Tuna positions | Category B confirmed — tx-history reconstruction required | **Large** | **2nd** |
| 2 | Other wrappers (Kamino et al.) | Kamino is a *different* wrapper shape, cheaper than expected | **Medium** | **3rd** |
| 3 | Wrapper detail page | Rows correctly non-clickable; page has zero wrapper support | **Medium** | **1st** |

**Headline finding, and it is not any of the three questions asked:** Phase 1 covers
roughly **a quarter of DefiTuna's surface**. The on-chain IDL (which is published and
decodable — see §1.3) shows the program manages *three* position classes across *two*
AMM backends, and Phase 1 handles exactly one of six combinations. Closed-position
reconstruction is the smaller gap. Details in §1.7 — I recommend reading that before
committing to a Phase B scope.

**Two corrections to in-flight findings** are recorded in §4. I got two intermediate
reads wrong during this investigation and caught both; they are documented because
either one, left standing, would have sent Phase B down a wrong path.

---

## 1. Closed Tuna positions

### 1.1 The public API serves OPEN positions only — confirmed, with a caveat

Phase A recorded that state parameters are ignored. **Confirmed, but the evidence is
subtler than "the param does nothing":**

| Request | HTTP | items | distinct `state` |
|---|---|---|---|
| `/users/{w}/tuna-positions` | 200 | 7 | `{open}` |
| `?state=closed` | 200 | 7 | `{open}` |
| `?status=closed` | 200 | 7 | `{open}` |
| `/tuna-positions/closed` | 400 | — | — |
| `/tuna-positions/history` | 400 | — | — |
| `/users/{w}/positions`, `/history`, `/transactions`, `/activity` | 404 | — | — |

The two state-param responses have **different md5s from the plain call**, which looks
at first like the filter is doing something. It is not: a field-by-field diff of every
item shows **zero differing fields**, and the address sets are identical. The md5 delta
comes from live price fields in the sibling `markets` / `mints` blocks moving between
calls seconds apart.

This matters as a trap for Phase B: the endpoint returns `200` and a plausibly-shaped
body for a filter it silently ignores. Anyone spot-checking with `?state=closed` and
eyeballing a 200 would conclude closed positions "come back empty for this wallet"
rather than "this parameter does nothing."

**New finding — DefiTuna tracks closed state internally.** The item schema carries 40
fields including `state`, `closed_at`, `pnl_usd`, `initial_debt_a/b`, `leftovers_a/b`,
`flags`, `locked_at_slot`. `closed_at` is `None` and `state` is `open` for all 7 live
positions. So the data model supports closed positions; the public endpoint just will
not serve them. If DefiTuna ever exposes a history endpoint, most of Phase B's
valuation work becomes unnecessary — worth one email to them before building.

### 1.2 On-chain: Category B confirmed (accounts ARE destroyed on close)

Trustless discovery, no size filter:

```
getProgramAccounts(tuna4u…, memcmp{offset:11, bytes:wallet})
  → 7 accounts, all exactly 339 bytes
API open positions                → 7
IDENTICAL SETS                    → True
on-chain-only (would be CLOSED)   → 0
```

The wallet's history contains **12 `CloseTunaLpPositionOrca` instructions**, yet zero
closed-position accounts survive on chain. **`TunaLpPosition` accounts are
rent-reclaimed on close → Category B**, same as Orca and Raydium. The
`solanaClosedPositions.ts` reconstruction pattern is the right template.

> ⚠️ **`getProgramAccounts` is not available on the free Alchemy tier** — it returns
> `429` regardless of backoff (6 retries, exponential). Helius served it fine. Any
> Phase B trustless-discovery path must route through Helius, not `ALCHEMY_SOLANA_RPC`.
> This is a real constraint: the closed-position scan engine currently runs on Alchemy.

**Concrete user impact:** this one test wallet has 12 closed Tuna positions that
DefiDesh cannot see at all today. Not mispriced — entirely absent from Capital G/L.

### 1.3 The Anchor IDL is published on-chain — major Phase B accelerator

```
IDL account : EooDyoDKbettJ6dvuuikga95ZLxKa2FifjrCicVm8HmP
              (Anchor convention: createWithSeed(findProgramAddress([], program), "anchor:idl", program))
size        : 15,936 bytes → zlib-decompresses to valid JSON
contents    : 66 instructions, 10 account types, 18 types, full error table
```

This removes essentially all layout guesswork from Phase B. It also **independently
confirms Phase 1's decoding**: summing `TunaLpPosition` field widths gives exactly
**339 bytes**, with `authority` at byte **11** (8 disc + `version:u16` + `bump:[u8;1]`).

`TunaLpPosition` layout (abridged — full field list in the IDL):

```
@8   version u16          @11  authority pubkey     @43  pool pubkey
@75  mint_a pubkey        @107 mint_b pubkey        @139 position_mint pubkey
@171 liquidity u128       @187 tick_lower i32       @191 tick_upper i32
@195 loan_shares_a u64    @203 loan_shares_b u64
@211 loan_funds_a u64     @219 loan_funds_b u64
@227 leftovers_a u64      @235 leftovers_b u64
@255 state TunaPositionState                        @275 flags u32
@279 entry_sqrt_price u128
```

> **Correction to CLAUDE.md.** The Phase A note recommends discovery via
> `getProgramAccounts(memcmp offset 11, dataSize 339)`. The `dataSize` filter is
> *currently* correct but is an unnecessary fragility — `version: u16` is the first
> field, so the layout is explicitly versioned and a future `version: 2` may resize.
> Phase 1's `verifyOnChain` does **not** filter on size (owner + authority only) and is
> therefore already safe. Recommend dropping `dataSize` from the documented plan.

### 1.4 Instruction vocabulary (live, 200-signature scan → 55 Tuna txs)

| Instruction | Count | Lifecycle role |
|---|---|---|
| `OpenAndIncreaseTunaLpPositionOrca` | 17 | open + initial deposit |
| `DecreaseTunaLpPositionOrca` | 12 | partial withdrawal |
| `CloseTunaLpPositionOrca` | 12 | **close** |
| `IncreaseTunaLpPositionOrca` | 7 | add to position |
| `RepayTunaLpPositionDebt` | 3 | **debt repayment (separate instruction)** |
| `SetTunaLpPositionFlags` | 3 | config |
| `SetTunaLpPositionLimitOrders` | 2 | config |

Anchor instruction names appear in plaintext logs (`Program log: Instruction: …`),
so classification does not require discriminator matching — a simpler dispatch than
the Orca/Raydium engines needed.

### 1.5 Anchor events exist but are NOT yet decodable

**117 `Program data:` events across 55 Tuna transactions.** This looked like the
Raydium `DecreaseLiquidityEvent` path — exact per-event amounts, far better than
Orca's transfer inference. It is not usable yet:

- The decompressed IDL has **`events: []`** — no event schemas published.
- A sample event discriminator `e1ca49af932ba096` (121-byte payload) matched **none**
  of 27 candidate `event:<Name>` sha256 preimages.

So the events are emitted but their schema is not public. Phase B options: (a) brute-force
the discriminator against a larger name list, (b) infer payload structure empirically from
known-amount transactions, or (c) **skip events entirely and use the proven Orca approach**
— match inner SPL transfers against the pool's on-chain vault addresses. Option (c) is
lowest-risk and reuses existing code; recommend starting there and treating event decoding
as an optional precision upgrade.

### 1.6 Capital G/L for a closed leveraged position — yes, debt changes everything

Your instinct is right: this needs the same equity treatment as the open case, and
it is materially harder than the unleveraged Orca/Raydium reconstruction.

For an unleveraged closed position, Rule 4 is `withdrawal − deposit`. For a leveraged
one, the naive read is **wrong in both terms**:

- **Deposit must be collateral, not LP total.** The LP position is funded by
  collateral + borrowed principal. Using LP total overstates the user's capital by the
  borrowed amount — the exact error Phase 1's EQUITY semantics avoids for open positions.
- **Withdrawal must be net of debt repayment.** Gross LP withdrawal at close includes
  funds that immediately repay the loan. Only the residual is the user's.
- **`RepayTunaLpPositionDebt` is a separate instruction**, sometimes in a *different
  transaction* from the close. The reconstruction cannot assume close-and-repay are
  atomic; it must accumulate debt-repayment events across the position's whole lifetime.
- **`leftovers_a/b` is a real field** — residual funds retained after close, which the
  user may withdraw separately. If ignored, Capital G/L under-reports.
- **Accrued interest** means debt at close ≠ debt at open. `initial_debt_a/b` and
  `current_debt_a/b` are distinct API fields for exactly this reason. Interest paid is
  a genuine cost that must land somewhere in P&L, and Rule 4's two-term formula has no
  natural slot for it. **This needs an explicit pricing-invariants decision from Osho —
  it is a rules question, not an implementation detail.**

**The hardest part — three distinct close paths.** `TunaPositionState` is an enum:

```
TunaPositionState = Normal | Liquidated | ClosedByLimitOrder
```

and the IDL exposes four liquidation instructions
(`liquidate_tuna_lp_position_{orca,fusion}[_jupiter]`). A **liquidated** position has
fundamentally different economics — the user can lose their entire collateral, and a
liquidation fee is taken. Treating a liquidation as an ordinary close would silently
report a wrong (likely far too favourable) Capital G/L. This is precisely the class of
silent-wrongness the Protocol Correctness Contract exists to prevent.

`rebalance_tuna_lp_position_{orca,fusion}` adds a further wrinkle: an auto-rebalance
likely closes and reopens the underlying Orca position while the Tuna position persists.
Lifecycle reconstruction must not read a rebalance as a close.

### 1.7 ⚠️ Scope finding: Phase 1 covers ~1 of 6 DefiTuna surfaces

The IDL's account list is `['FusionPool', 'LendingPosition', 'Market', 'Referral',
'TunaConfig', 'TunaLpPosition', 'TunaPriceUpdate', 'TunaSpotPosition', 'Vault',
'Whirlpool']`. Three of those are user-facing position classes:

| Position class | Backends | Phase 1 status |
|---|---|---|
| `TunaLpPosition` | **Orca** ✅ / **Fusion** ❌ | Orca open positions only |
| `TunaSpotPosition` | Orca / Fusion / Jupiter — all ❌ | **entirely invisible** |
| `LendingPosition` | `open_lending_position`, `deposit`, `withdraw` — ❌ | **entirely invisible** |

A full `*_fusion` instruction set exists in parallel to every `*_orca` one. **A user with
DefiTuna positions on Fusion sees nothing today** — the identical bug class Phase 1 was
created to fix, one layer down. Same for leveraged spot and Tuna lending.

By the completeness directive, Fusion LP support is arguably higher-value than closed-Orca
reconstruction: it is a *fully invisible open position* (worse than a missing historical
number), and it should be far cheaper — the same equity semantics and API shape, a
different pool decoder.

### 1.8 Complexity: **LARGE**

Closed-Tuna reconstruction is materially harder than Orca or Raydium closed positions:
new equity-aware Capital G/L semantics, a cross-transaction debt-repayment stream, three
close paths with different economics, rebalance interference, an unresolved
interest-accounting rules question, and a hard dependency on Helius (not Alchemy) for
`getProgramAccounts`. The published IDL and plaintext instruction names pull it back from
"very large," but this is not a one-sitting sprint.

---

## 2. Other wrapper protocols

### 2.1 Kamino — a *different* wrapper shape, and cheaper than DefiTuna

**Kamino Liquidity is real and users hold LP through it.** But it is not the DefiTuna
pattern, and that difference is the whole story.

```
GET api.kamino.finance/strategies   → 200, 5,608 strategies (515 status=LIVE)
    item: {address, shareMint, tokenAMint, tokenBMint, type, status}
GET api.kamino.finance/kvaults/vaults → 200, vault list with full on-chain state
```

Per-user endpoints do **not** exist — four plausible patterns all 404
(`/strategies/user/{w}/shares`, `/v1/users/{w}/strategies`, `/users/{w}/strategies`,
`/strategies/shares/{w}`).

**Why this is good news.** DefiTuna hides an NFT inside a vault, so discovery required a
protocol API plus on-chain authority verification. Kamino issues a **fungible `shareMint`
that sits in the user's own wallet**. So discovery is:

```
user's SPL token balances  ∩  {515 live shareMints}  →  their Kamino LP positions
```

**DefiDesh already reads user token balances** (the Token Holdings page). The discovery
half is nearly free and needs no protocol API at all — it is trustless by construction,
strictly better than the Phase 1 hybrid.

The work is in **valuation**: shares are not the position. Value = `shares ×
sharePrice`, where share price comes from the strategy's on-chain holdings (the vault's
Orca/Raydium position + uninvested balances) ÷ shares outstanding. Kamino's per-strategy
on-chain state carries this; `/kvaults/vaults` already returns a `state` block.

Note the existing `app/api/lending/kamino/route.ts` is **Kamino Lend** (obligations) — a
different product. No code is reusable, but the API-client patterns are.

Also worth knowing: Kamino Lend is currently the **top runtime error** in production
(`Altcoins:reserves` 500s from `api.kamino.finance`, 4 occurrences). Their API has
availability wobbles; any Kamino Liquidity integration needs the same degrade-don't-drop
treatment as Rule 11.

**Complexity: MEDIUM.** Discovery small, valuation medium, closed positions deferred.

### 2.2 Ranked by likely real user impact

Ranked on *probability a DefiDesh user actually holds one*, not on technical interest.

| Rank | Protocol | Chain | Pattern | Why this rank |
|---|---|---|---|---|
| **1** | **DefiTuna — Fusion LP** | Solana | same as Phase 1 | Same users, same protocol, *already proven in this wallet set*. Fully invisible open positions. Cheapest real win. |
| **2** | **Kamino Liquidity** | Solana | share token in wallet | Largest Solana TVL of any wrapper here; wide retail use; discovery nearly free given existing balance reads. |
| **3** | **DefiTuna — closed Orca** | Solana | tx reconstruction | Proven-needed (12 closes in one wallet) but historical, not invisible-position. |
| **4** | **DefiTuna — Spot / Lending** | Solana | new classes | Invisible, but narrower usage than LP. |
| **5** | **Gamma / Beefy / Arrakis** | EVM | ERC-20 vault share | Same share-token shape as Kamino, so cheap *if* a user turns up. No evidence any DefiDesh user holds one. |
| **6** | **Sui vaults (Cetus Vaults, AlphaFi)** | Sui | vault object | AlphaFi already partly integrated on the lending side. Sui wrapper LP usage unverified. |

**Deliberate recommendation: do not survey further.** Ranks 5–6 are speculative — I found
no evidence any DefiDesh user holds them, and building for a hypothetical user contradicts
the "focus on what real users actually use" instruction. The honest ranking says finish
DefiTuna (ranks 1, 3, 4) and add Kamino (rank 2). Revisit EVM/Sui wrappers when a real
user reports a missing position.

A cheap way to make that data-driven: an unrecognised-token census — flag wallet-held
tokens matching known vault-share mints across chains and log them. That converts "who
might use wrappers" from guesswork into evidence, and reuses the token-resolver
infrastructure.

---

## 3. Wrapper position detail page

### 3.1 Current state: rows are correctly NON-clickable

CLAUDE.md is accurate here. Dashboard row navigation is gated by:

```ts
// app/dashboard/page.tsx:1837
const isReconstructed = pos.id.startsWith("sui-closed-")
                     || pos.id.startsWith("solana-closed-")
                     || pos.id.startsWith("tuna-");
...
if (isReconstructed) return;   // lines 1886, 2040 — click handler bails
```

Tuna position IDs are prefixed `tuna-`, so both click paths return early. **Nothing is
broken today** — a user cannot reach a degraded page.

### 3.2 What's missing

The detail page has **zero** DefiTuna handling (`grep -c 'DefiTuna\|defituna'` → `0`).
Protocol dispatch is a ternary chain over `pos?.protocol` with a `null` tail, so a Tuna
position would fall through to `activity = null`, `activityLoading = false` — degraded
but not crashing. Safe, and useless.

Making the page correct for wrapper positions needs:

1. **A data source.** Every branch maps to an `/api/{protocol}/activity` route. DefiTuna
   has none. Open-position history means the same tx-history scan as §1 — so **§3 and §1
   share most of their cost**, and doing §1 first makes §3 much cheaper.
2. **Wrapper-specific UI surfaces** that no existing LP position has:
   `leverage`, `current_debt_a/b` vs `initial_debt_a/b`, `liquidation_price_lower/upper`,
   `entry_price`, `deposited_collateral_a/b`, `yield_a/b`, `compounded_yield_a/b`,
   `leftovers_a/b`, and position `state`.
   All are already fetched by the Phase 1 route and then **discarded** — the route maps
   them down to the generic `AerodromePosition` shape. Surfacing them is largely
   plumbing, not new data acquisition.
3. **Equity-consistent display.** The page's P&L widgets assume value = LP value. For a
   leveraged position they must read equity, or they will contradict the dashboard row —
   the "trust-through-transparency" failure Sprint 4 was built to avoid.
4. **A liquidation-risk surface.** `liquidation_price_lower/upper` is arguably the single
   most valuable number a leveraged-LP user wants, and DefiDesh has it in hand already.

### 3.3 Complexity: **MEDIUM**

Mostly display plumbing over data Phase 1 already fetches. The `AerodromePosition` shape
needs an optional wrapper-metadata field (additive, same approach as `selfReportedPnl`).
The one genuinely new piece is the activity/history source, which §1 delivers.

---

## 4. Corrections to intermediate findings

Recorded because either, left uncorrected, would have misdirected Phase B.

**(a) "TunaPosition accounts survive close" — WRONG.** Mid-investigation I found three
live Tuna-owned accounts (348 / 355 / 331 bytes) among accounts referenced by
`CloseTunaLpPositionOrca` transactions, and inferred Category A (accounts persist, no
reconstruction needed). The authority-filtered `getProgramAccounts` test disproved it:
exactly 7 accounts, all 339 bytes, set-identical to the API's 7 open positions, zero
closed. Those variable-size accounts were **other** account types (`Market`, `Vault`,
`Whirlpool`, tick arrays) that close transactions naturally touch. Category **B** is
correct. Had this stood, Phase B would have been scoped as a simple account read.

**(b) "Tuna rows are clickable" — WRONG.** I saw the click handler gated on
`isReconstructed` rather than on protocol and concluded Tuna rows navigate to a broken
page, contradicting CLAUDE.md. Reading the `isReconstructed` definition showed it
includes `pos.id.startsWith("tuna-")`. CLAUDE.md was right; I was wrong. Had this stood,
Phase B would have opened with a bug fix for a bug that does not exist.

---

## 5. Recommended priority order

**Before any of it — one decision and one email.**

- **Decision (Osho):** how does borrowing-interest paid over a leveraged position's life
  enter P&L? Rule 4's `withdrawal − deposit` has no slot for it. This is a
  pricing-invariants amendment and it blocks correct closed-Tuna numbers.
- **Email (free option):** ask DefiTuna whether a closed/historical positions endpoint
  exists or is planned. Their data model already has `closed_at` and `pnl_usd`. A "yes"
  removes most of §1's cost.

Then, in order:

**1st — Wrapper detail page (§3), Medium.** Highest value per unit of work: the data is
already fetched and thrown away, and `liquidation_price` is the number a leveraged user
most wants. Ships independently, no rules questions, no new scan infrastructure.
*Caveat:* full history needs §1's scan, so scope this as "rich detail from Phase 1 data,
activity deferred."

**2nd — DefiTuna Fusion LP support (§1.7), Small–Medium.** Not in the original brief, but
by the completeness directive it outranks closed positions: Fusion users see **nothing**
today. Same equity semantics, same API, same verification — a different pool decoder.
Cheapest fix for a fully-invisible position class.

**3rd — Closed Tuna reconstruction (§1), Large.** The brief's headline item, ranked third
deliberately: it is historical accuracy rather than an invisible position, it is the most
expensive piece, and it is blocked on the interest-accounting decision. Sequence it as
(a) equity-aware lifecycle from `close`/`decrease`/`repay` instructions via vault-transfer
matching, (b) liquidation and limit-order close paths, (c) event decoding as an optional
precision upgrade.

**4th — Kamino Liquidity (§2.1), Medium.** Highest-TVL non-Tuna wrapper, and its
share-token discovery is nearly free given existing balance reads. Ranked after DefiTuna
only because finishing one protocol beats half-finishing two (architecture Rule 7).

**Not recommended now:** EVM/Sui wrapper survey (ranks 5–6). No evidence of real usage.
Build the unrecognised-vault-share census instead and let data drive it.

---

## Appendix — verification commands

```bash
# API returns OPEN only; state param silently ignored (identical item sets)
curl -s "https://api.defituna.com/api/v1/users/{wallet}/tuna-positions"
curl -s "https://api.defituna.com/api/v1/users/{wallet}/tuna-positions?state=closed"

# Category B proof — requires Helius; free Alchemy 429s on getProgramAccounts
getProgramAccounts(tuna4uSQZncNeeiAMKbstuxA9CUkHH6HmC64wgmnogD,
                   filters=[memcmp{offset:11, bytes:<wallet>}])
# → 7 accounts / 339 bytes each / set-identical to API open set / 0 closed

# On-chain IDL
account EooDyoDKbettJ6dvuuikga95ZLxKa2FifjrCicVm8HmP
# → 15,936 bytes; skip 44-byte header; zlib.decompress → JSON
#   66 instructions, 10 accounts, 18 types

# Kamino Liquidity
curl -s "https://api.kamino.finance/strategies"      # 5,608 (515 LIVE), each w/ shareMint
curl -s "https://api.kamino.finance/kvaults/vaults"  # vault list + on-chain state
```

**Not done in this phase (deliberate):** no implementation code; no live browser
verification of the Tuna dashboard row; no attempt to brute-force the event
discriminator beyond 27 candidates; no contact with DefiTuna or Kamino.
