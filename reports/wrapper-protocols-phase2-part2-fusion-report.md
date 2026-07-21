# Sprint WRAPPER-PROTOCOLS Phase 2 Part 2 — Fusion LP: Phase A Investigation

**Date:** 2026-07-21
**Status:** Investigation only. No implementation code written.
**Method:** DefiTuna public API census + full on-chain `getProgramAccounts` census of all
three position classes (via Helius — free Alchemy 429s on `getProgramAccounts`) + live
execution of the existing Phase 1 route against real third-party Fusion wallets.

---

## Bottom line

**1. Fusion usage is real and substantial — confirmed.** 168 live Fusion-backed LP
positions across **107 distinct wallets**, 30.3% of all live DefiTuna LP positions, and
50.6% of DefiTuna's borrowed capital.

**2. But Part 2 does not need to be built — it already works.** Fusion positions use the
*same* account type, *same* discriminator, *same* layout, and are returned by the *same*
API endpoint as Orca positions. Phase 1's route is provider-agnostic by construction.
Verified live: **19/19 positions on a mixed Orca+Fusion wallet, equity exact to the cent,
range status correct on every one, zero on-chain verification failures.** Part 1's detail
panel also populates fully for Fusion.

**3. The investigation found a much larger invisible class than Fusion.** DefiTuna
**Lending** has **7,602 funded positions across 5,640 distinct wallets — 17.7× more users
than DefiTuna LP** (318 wallets). It is completely invisible to DefiDesh. This, not Fusion,
is where the next unit of work belongs.

**Recommendation: close Part 2 as already-satisfied** (verify + document, no build), and
replace it in the queue with Tuna Lending. Detail in §5.

---

## 1. Is Fusion usage real? — YES, decisively

### Market-level census (`/markets`, 107 markets)

| Backend | Markets | Markets w/ live borrows | Borrowed capital | Disabled |
|---|---:|---:|---:|---:|
| **fusion** | **72** | 4 | **$601,064** | 10 |
| orca | 35 | 19 | $586,777 | 19 |

Fusion is **50.6% of all borrowed capital** on DefiTuna, and the majority of its markets.

### Position-level census (on-chain, all 1,116 `TunaLpPosition` accounts)

Classified by decoding `pool` @ offset 43 and mapping through `/pools` (923 pools:
888 fusion, 35 orca).

| Backend | All accounts | **liquidity > 0** | Distinct wallets |
|---|---:|---:|---:|
| orca | 891 | **386** | 231 |
| **fusion** | **225** | **168** | **107** |

**Fusion = 30.3% of live LP positions.**

> **Methodology note.** The raw account count overstates usage — 1,116 accounts contain only
> 556 with non-zero liquidity. All headline figures above use the **liquidity > 0** basis.
> The same correction matters enormously in §4 (57% of LendingPosition accounts are
> zero-balance leftovers), so it is applied consistently throughout.

### Concrete pure-Fusion wallet
`upgMGFHGxJ58kBxpiEhLzV5AJ9SkZiGx3hxAxc7TZfn` holds **7 positions, all Fusion-backed** —
the exact "user sees nothing" scenario Part 2 was queued to fix.

> **Scope caveat, stated plainly.** These counts are DefiTuna's *entire* user base, not
> DefiDesh's. They establish that the position class is genuinely used by real people at
> meaningful scale; they do **not** prove a current DefiDesh user holds one. That
> distinction matters more for §4's recommendation than for Fusion, since Fusion turns out
> to cost nothing.

---

## 2. Technical differences between Orca- and Fusion-backed positions

**There are none at any layer DefiDesh touches.** This is the finding that changes the
sprint.

| Layer | Orca-backed | Fusion-backed | Differs? |
|---|---|---|---|
| Account type | `TunaLpPosition` | `TunaLpPosition` | **No** |
| Discriminator | `4cc5a133e80f89dc` | `4cc5a133e80f89dc` | **No** |
| Account size | 339 bytes | 339 bytes | **No** |
| `authority` offset | 11 | 11 | **No** |
| Discovery | `getProgramAccounts(memcmp @11)` | identical | **No** |
| API endpoint | `/users/{w}/tuna-positions` | **same endpoint, same response** | **No** |
| On-chain verification | owner == tuna, authority @11 | identical | **No** |
| Distinguisher | `market → pool → provider` = `"orca"` | `= "fusion"` | the only one |
| Underlying pool account | `Whirlpool` | `FusionPool` | yes — **but DefiDesh never reads it** |

The `FusionPool` vs `Whirlpool` difference is real in the IDL, but it is invisible to
DefiDesh because Phase 1 consumes the **embedded `market.pool` object from the API**
(`mint_a`, `mint_b`, `tick_current_index`, `price`, per-mint `decimals`) rather than
decoding the AMM's pool account itself. The API normalises both backends into one shape.

That design decision — made in Phase 1 for a different reason — is what makes Fusion free.

---

## 3. Verification that it already works

Run against the **existing, unmodified** Phase 1 route (`app/api/defituna/route.ts`) on a
local production build.

### Mixed wallet `6NcbT9g7xDTa…` — 19 positions (12 fusion, 7 orca)

Every position, both backends, compared against the upstream API's own `total − debt`:

```
provider  pair            API equity   route value        Δ    range
fusion    SOL/USDC            399.45        399.45     0.00       OK
fusion    SOL/USDC            436.85        436.85     0.00       OK
   …  (12 fusion rows, all Δ 0.00, all range OK)
orca      cbBTC/USDC        1,524.42      1,524.42     0.00       OK
   …  (7 orca rows, all Δ 0.00, all range OK)

mismatches: 0        on-chain verification failures: 0
```

Equity matches **to the cent on all 19**. Range status (tick comparison against
`tick_current_index`) correct on all 19. No `[defituna]` verification errors in the server
log — Fusion positions pass the owner+authority on-chain check unchanged, because they are
the same account type.

### Pure-Fusion wallet `upgMGFHGx…` — 7 positions, all rendered

```
WhiteWhale / USDC   $7.20     1.00×   In Range
SOL / Fartcoin    $223.31     1.00×   In Range
SOL / TUNA          $5.63     1.00×   In Range
SOL / USDC         $97.93     1.00×   In Range
```

### Part 1 detail-page fields also work for Fusion

All of `leverage`, `entryPrice`, `currentPrice`, `liquidationUpper`, `debtUSD`,
`collateralUSD`, `totalUSD`, `pendingYieldUSD`, `token0/1Symbol`, `token0/1Decimals`
populate — **zero missing fields** on both wallets. Decimals resolve correctly per pair
(SOL/USDC → 9/6, WhiteWhale/USDC → 6/6), so the Part 1 decimals fix carries over.

**Liquidation bounds — a hypothesis I raised and then disproved.** An early sample showed a
2.54× leveraged Fusion position with `liquidation_price_upper = 0`, which looked like Fusion
under-reporting risk. It was my own error: that position had `liquidation_price_lower =
52.88` and I had only printed the upper bound. Across all sampled positions:

```
LEVERAGED (>1.05×) orca  :  8 positions, 0 report NO liquidation price (0%)
LEVERAGED (>1.05×) fusion: 12 positions, 0 report NO liquidation price (0%)
```

Every leveraged position on **both** backends reports exactly one non-zero bound. Both-zero
occurs **only** on 1.00× unleveraged positions (debt $0.00), where "no liquidation price" is
correct — and Part 1 already renders that as "n/a" plus an explanatory note.

One genuine behavioural difference worth recording: the Fusion leveraged positions sampled
liquidate on the **lower** bound (borrow quote → long base), whereas the Orca test wallet
liquidated on the **upper** bound. Part 1's panel selects the nearest non-zero bound, so it
handles both directions without change — but this is the first live confirmation of that
path, which had only ever been exercised upper-side.

---

## 4. The larger finding: Tuna **Lending** dwarfs Tuna LP

Full on-chain census of all three position classes. Layouts and sizes verified against the
on-chain IDL (`authority @ 11` confirmed for all three; IDL field widths sum to exactly the
observed account sizes).

| Class | Accounts | **Funded / live** | **Distinct wallets** | Size | Status in DefiDesh |
|---|---:|---:|---:|---:|---|
| `LendingPosition` | 17,512 | **7,602** | **5,640** | 155 B ✓ | **invisible** |
| `TunaLpPosition` | 1,116 | 556 | 318 | 339 B ✓ | ✅ visible (Orca **and** Fusion) |
| `TunaSpotPosition` | 11 | — | 9 | 346 B ✓ | invisible |

**DefiTuna Lending has 17.7× more active wallets than DefiTuna LP** (5,640 vs 318), across
35 distinct deposit mints. It is the protocol's dominant product by user count, and DefiDesh
shows none of it.

`TunaSpotPosition` is negligible — **11 accounts, 9 wallets** protocol-wide. Recommend
deprioritising it indefinitely rather than keeping it in the queue as a peer of the others.

Two caveats before this drives a decision:

- **These are DefiTuna-wide numbers, not DefiDesh users.** 5,640 is a strong prior that the
  class matters, not evidence that a current DefiDesh user holds one.
- **Tuna Lending is a lending product, not an LP one.** It belongs in DefiDesh's existing
  lending pipeline (alongside AAVE / Kamino / Suilend), **not** in the LP positions array or
  the `selfReportedPnl` wrapper mechanism. It is therefore *not* a natural continuation of
  the WRAPPER-PROTOCOLS sprint, and should be scoped as its own item. The layout is simple
  (`authority`, `mint`, `deposited_funds`, `deposited_shares`, `vault` — 155 bytes) and
  discovery is the same `getProgramAccounts(memcmp @11)` pattern already proven here.

---

## 5. Recommendation

**Close Part 2 without building it.** Fusion support already ships — it arrived free with
Phase 1 and was simply never verified. Remaining work is hours, not a sprint:

1. Browser-eyeball a Fusion position end-to-end on the deployed site (dashboard row →
   detail page), using `upgMGFHGx…` as a watched wallet.
2. Update CLAUDE.md: DefiTuna is Orca **and** Fusion, verified, with the numbers above.
   Correct the Phase A scope table, which currently states Fusion is unsupported.
3. Delete the "~1 of 6 surfaces" framing — the real figure is 2 of 3 *position classes* on
   the LP side, with LP itself fully covered across both backends.

**Do not build `TunaSpotPosition`** — 9 wallets protocol-wide does not justify a decoder,
and the completeness directive is about position classes real users hold.

**Suggested queue after this investigation:**

| # | Item | Why here |
|---|---|---|
| 1 | **Close Part 2** (verify + docs, no build) | Hours of work; removes a false gap from the queue |
| 2 | **Part 3 — closed Tuna Capital G/L** | Unchanged. Still LARGE, still blocked on the accrued-interest pricing-invariants decision, still worth emailing DefiTuna first |
| 3 | **NEW — Tuna Lending** (5,640 wallets) | Biggest invisible DefiTuna class by 17.7×; but scope into the *lending* pipeline, and confirm DefiDesh-user demand first |
| 4 | **Part 4 — Kamino Liquidity** | Unchanged |
| — | ~~TunaSpotPosition~~ | Drop — 9 wallets protocol-wide |

On the original question of whether to demote Part 2 below Part 3 or below the
wrapper-platform survey: **neither applies.** Part 2 was queued ahead of Part 3 on the
premise that Fusion positions are fully invisible while closed positions are merely
historically incomplete. That premise is now false — Fusion positions are visible and
correct — so the ordering question dissolves rather than resolving either way.

---

## Appendix — verification commands

```bash
# Market census (provider + borrowed capital)
curl -s -H 'User-Agent: Mozilla/5.0' https://api.defituna.com/api/v1/markets
#   → data.items[].pool.provider ∈ {orca, fusion}; 72 fusion / 35 orca

# Position census — Helius required (free Alchemy 429s on getProgramAccounts)
getProgramAccounts(tuna4uSQZncNeeiAMKbstuxA9CUkHH6HmC64wgmnogD,
                   filters=[memcmp{offset:0, bytes:<account discriminator>}])
#   TunaLpPosition    disc 4cc5a133e80f89dc → 1,116 accts (556 liquidity>0, 318 wallets)
#   TunaSpotPosition  disc 76387c68b2cdae4d →    11 accts (9 wallets)
#   LendingPosition   disc 2ffffc2314f59df3 → 17,512 accts (7,602 funded, 5,640 wallets)
# Decode: authority @11, pool @43 (LP) / mint @43 (Lending), liquidity @171 u128,
#         deposited_funds @75 u64

# Existing route already serves Fusion — no code change
curl -s "localhost:3000/api/defituna?account=upgMGFHGxJ58kBxpiEhLzV5AJ9SkZiGx3hxAxc7TZfn"
#   → 7 positions, all Fusion-backed
```

**Test wallets for future verification:** `upgMGFHGxJ58kBxpiEhLzV5AJ9SkZiGx3hxAxc7TZfn`
(7 positions, 100% Fusion) · `6NcbT9g7xDTaBpAVJGjfQK4jW81KxBA5zH3nPdQVu9od` (19 positions,
mixed 12 fusion / 7 orca — the best single regression wallet for this protocol).

**Not done (deliberate):** no implementation code; no browser verification of a Fusion
position on the deployed site (recommended as step 1 above); no contact with DefiTuna; no
investigation of the Krystal/Vfat/Revert wrapper-platform survey mentioned in the brief —
that was an either/or branch that the Fusion result made moot.
