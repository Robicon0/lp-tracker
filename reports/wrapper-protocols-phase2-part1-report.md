# Sprint WRAPPER-PROTOCOLS Phase 2 Part 1 — Detail Page Fix

**Date:** 2026-07-21
**Status:** Implemented, verified, **NOT committed** (awaiting confirmation).
**Test wallets:** `2rr3SFuM…JTpn` (7 live DefiTuna positions) · `GndR…pogC` (RAKA/A1, 22 Orca/Raydium positions — control)
**Verification:** local production build (`npm run build` + `npm run start`), Playwright 1.61.1, ephemeral clean browser profiles, no wallet extension.

---

## Summary

DefiTuna rows are now clickable and land on a detail page with a **Leverage & Liquidation**
panel showing equity, debt, gross LP value, leverage, entry/current price, liquidation
prices, and distance-to-liquidation. Every figure is passed through from data Phase 1
already fetched and discarded. **No calculation logic changed.**

Two bonus fixes were required by the "must not degrade to a broken page" requirement — the
page was reachable for the first time and exposed a nonsense heading and a **$31.7 billion**
price range (details in §3).

One **pre-existing** bug was found and is explicitly *not* fixed here (§5).

---

## 1. Files changed (4)

| File | Change | Risk |
|---|---|---|
| `app/lib/aerodrome.ts` | New optional `wrapperMeta` field on `AerodromePosition` | None — additive optional |
| `app/api/defituna/route.ts` | Parse 3 previously-dropped API fields; emit `wrapperMeta` + token symbols/decimals | DefiTuna route only |
| `app/dashboard/page.tsx` | Remove `tuna-` from `isReconstructed` (1 line) | Click gate only |
| `app/dashboard/position/[id]/page.tsx` | New `wm`/`liqDistancePct`/`liqDanger` consts + one `{wm && …}` panel | Renders only when `wrapperMeta` present |

**Isolation guarantee.** Nothing in the P&L pipeline reads `wrapperMeta`. Valuation still
flows exclusively through `value` / `fees` / `selfReportedPnl`, all unchanged from Phase 1.
The detail-page panel is gated on `{wm && …}`, so for every non-wrapper position the
component tree is identical to before. Verified empirically in §4.

---

## 2. Before / after

### Before
- DefiTuna rows **non-clickable** — `isReconstructed` included `pos.id.startsWith("tuna-")`, so both click handlers returned early. Nothing was broken; there was simply nowhere to go.
- `leverage`, `debtUSD`, `totalUSD` were emitted by the route but **untyped** on `AerodromePosition`, so no component could safely read them.
- `entry_price`, `liquidation_price_lower`, `liquidation_price_upper` were **not in the `TunaItem` interface at all** — dropped at parse, never reaching the client.
- Leverage, debt and liquidation risk were **invisible everywhere in the product**.

### After — captured live (`2rr3SFuM…`, position `tuna-EQCWRT1J…`)

Page heading: **SOL / USDC** · DEFITUNA · OUT OF RANGE · TOTAL VALUE **$198.71**

```
[⚠] LEVERAGE & LIQUIDATION
    Position managed by DefiTuna — you own the equity, not the gross LP value

    YOUR EQUITY      BORROWED (DEBT)   GROSS LP VALUE    LEVERAGE
    $198.71          $596.47           $795.17           4.00×
    what you own     current, incl.    equity + debt     on $239.12
    (total − debt)   accrued interest  — NOT your value  collateral

    ENTRY PRICE      CURRENT PRICE     LIQ. PRICE (LOWER)  LIQ. PRICE (UPPER)
    $73.59           $78.32            n/a                 $91.36

    Price is 16.7% away from the nearest liquidation price

    Uncollected yield: $0.00

    Figures are reported by DefiTuna and verified on-chain (the position account's
    owner and authority). Per-position transaction history is not yet available for
    wrapper-held positions — the LP position lives in DefiTuna's vault rather than
    your wallet.
```

Arithmetic is internally exact: `795.17 − 596.47 = 198.71` = the headline TOTAL VALUE.

Design notes:
- `liquidation_price_lower` is `0.0` on every live position (borrow-side asymmetry). Rendered **"n/a"**, never "$0.00" — a $0 liquidation price would read as "infinitely safe", the exact inverse of the truth.
- The distance line turns red below 10%. At 16.7% it renders neutral.
- Screenshots: `01-rows.png` (dashboard), `04-final.png` (detail), `05-control-nonwrapper.png` (Orca control).

---

## 3. Two bonus fixes (required by requirement 5)

Making the page reachable exposed pre-existing breakage that had never been visible:

**(a) Heading read "Token0 / Token1".** The route never set `token0Symbol`/`token1Symbol`
even though it computes `symA`/`symB` for the row label. Now passed through → **"SOL / USDC"**.

**(b) Price range read $31,700,353,983 → $33,205,832,149.** `tickToUSD` falls back to EVM
defaults (18/6 decimals) when a position carries none; SOL/USDC is 9/6, a 10¹² error. The
DefiTuna API returns `decimals` in the same `mints` block the symbols come from — Phase 1
read the symbol and dropped the decimals. Now passed through → **$31.70 → $33.21**.

**Verified, not assumed.** I was initially suspicious that $31.70–$33.21 was still wrong,
since it does not bracket the $73.59 entry price. Independent check against the pool's own
reported price:

```
tick_current = -25545  →  1.0001^t × 10^(9−6) = 77.7410
pool.price (API)                              = 77.74147
```

Match to 4 decimals, so the conversion is correct and the range is real data — this
position is genuinely far below the current price, consistent with its OUT OF RANGE badge
and −16.6% P&L. (Why `entry_price` sits outside the position's own range is a DefiTuna
semantics question — likely rebalancing, which the IDL exposes as
`rebalance_tuna_lp_position_orca`. Noted for Phase 2 Part 3, not a display bug.)

Both are display-only and scoped to the DefiTuna route. Neither touches `tickToUSD` or any
shared formatter, so no other protocol's rendering changes.

---

## 4. Verification results

### ✅ Click-through shows correct data
7 DefiTuna rows render; clicking navigates to
`/dashboard/position/tuna-EQCWRT1JN9TGqtBETF1TKa4pvHNsMBgQ4AfBo7QbCFBk`. Panel values
cross-checked against the raw DefiTuna API for the same position: leverage, entry price,
liquidation prices, debt, collateral and gross total all match the upstream payload
verbatim.

### ✅ Equity matches between list and detail

| Row | Dashboard row | Detail TOTAL VALUE | Panel "Your Equity" |
|---|---|---|---|
| 0 | $200.07 | **$200.60** | **$200.60** |
| 1 | $219.18 | **$219.25** | **$219.25** |
| 2 | $45.35 | **$45.30** | **$45.30** |

Detail headline and panel equity are **identical in all three cases** — both render
`fmt$(pos.value)` on the same object, so they cannot drift by construction.

The dashboard row differs by cents with **mixed signs** (+0.53, +0.07, −0.05). That is
source-side live-price movement, not a logic discrepancy: navigating to the detail page is
a full page load that refetches, and DefiTuna's API (`cache: 'no-store'`) revalues on every
request. Demonstrated directly — four calls to the same endpoint over 12 seconds, no code
involved:

```
call 1  pos0.value = $200.48   equity == total − debt: True
call 2  pos0.value = $200.54   equity == total − debt: True
call 3  pos0.value = $200.54   equity == total − debt: True
call 4  pos0.value = $200.58   equity == total − debt: True
```

Same magnitude as the table deltas. Exact string equality across two page loads is not
achievable for a live-revalued source, and its absence is not a defect. By contrast the
Orca control (CoinGecko prices, 60 s cache) matched **exactly** — see below.

### ✅ Non-wrapper protocols completely unaffected

Control: RAKA/A1, 22 Orca/Raydium positions, Orca ZEC/USDC detail page.

```
renders detail (not "not found") : true
has Leverage & Liquidation panel : false   ← required
has Current Liquidity section    : true
has Fee Claims History           : true
has Concentrated Liquidity Range : true
TOTAL VALUE                      : $4,271.16   (dashboard row: $4,271.16 — exact)
```

All pre-existing sections intact, no wrapper panel, and list/detail agree to the cent.

### ✅ No silent degradation
`isActivityProtocol` excludes DefiTuna, so activity-dependent sections are hidden rather
than rendered broken, and `activityPending` stays `false` (no perpetual spinner). The Fee
Claims History section shows the pre-existing honest message — *"Activity data not
available for DefiTuna — on-chain fee history scanning is not yet supported"* — and the
panel footnote explains why. No blank page, no zero-value fabrication, no console errors
(`pageerror` listener silent throughout).

### ✅ Build
`npx tsc --noEmit` clean · `npm run build` clean (56/56 static pages).

---

## 5. Pre-existing bug found — NOT fixed here

**In scan mode (`?address=…&chain=…`), clicking any position row yields "Position not
found".** Row clicks use `window.location.href` (a full page navigation), which discards
in-memory scan state; the detail page loads with no wallet.

**This is not caused by this change, and it is not DefiTuna-specific.** Control test in the
same session:

```
Raydium row → /dashboard/position/ray-GrmuCD8F…  →  "Position not found": true
```

Every protocol behaves identically. It is the same class of gap `e85f794` fixed for the
analytics page (which needed its own `ScanModeListener` to survive a hard load).

I did not fix it because it is out of the stated scope, affects all protocols equally, and
the correct fix — making the detail page scan-aware, mirroring `e85f794` — deserves its own
change with its own verification. **All verification above therefore used the watched-wallet
path**, which persists in localStorage and survives full navigation (the normal user
journey). Recommend queuing as a separate small item.

---

## 6. Requirements traceability

| # | Requirement | Status |
|---|---|---|
| 1 | Rows clickable → detail view | ✅ verified live |
| 2 | Surface leverage, entry, liq upper/lower, debt, yield | ✅ all six + collateral, gross total, state |
| 3 | Make equity / debt / liquidation proximity clear | ✅ equity vs "NOT your value" labelling; 16.7% distance line with <10% red |
| 4 | No calculation logic changed | ✅ pass-through only; `wrapperMeta` read by nothing in the P&L pipeline |
| 5 | No silent degradation | ✅ sections hidden not broken; honest messaging; two latent display bugs fixed |
| V1 | Click through real position, correct values | ✅ §4, cross-checked against upstream API |
| V2 | Equity matches dashboard row | ✅ identical within page; cross-load delta proven to be source-side drift |
| V3 | Other protocols unaffected | ✅ Orca control, exact match, no panel |

---

## 7. Not done / open items

- **Not committed** — awaiting confirmation, as instructed.
- **Scan-mode detail navigation** (§5) — pre-existing, all protocols, needs its own change.
- **`fmtPrice` renders `$78.3`** rather than `$78.30` (`toLocaleString` drops the trailing zero). Cosmetic; `fmtPrice` is shared with every other protocol so changing it is out of scope here.
- **No per-position history** for wrapper positions — needs the Phase 2 §1 tx-history scan.
- **`entry_price` outside the position's own tick range** — noted in §3, a DefiTuna semantics question for Part 3, not a display defect.
- **Cache versions:** none bumped. No cached artifact's shape or contents changed — `wrapperMeta` is additive and the DefiTuna route is uncached (`cache: 'no-store'`, no `withActivityRouteCache`).

### Tooling note
The `nextjs` validation hook fired on every edit to `app/api/defituna/route.ts` insisting
`searchParams` must be `await`ed. That applies to **page/layout props**, not Route Handlers,
where `new URL(request.url).searchParams` is the synchronous Web API. All nine sibling
routes use the identical pattern on Next 16.1.6. Applying it would have broken the route.
Recommendation ignored deliberately.
