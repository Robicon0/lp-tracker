# Sprint POSITION-DETAIL Phase B — B7 Gate Report

Scope: **B1** (Sui pending rewards — Cetus/Bluefin/Momentum) + **B2** (Estimated APR
fallback, all protocols). B3 (Solana rewards) + B4 (EVM gauge emissions) deferred to
Sprint POSITION-DETAIL-2. Date: 2026-07-03.

## Change set (8 files)

| File | Change |
|---|---|
| `app/lib/suiRewardMeta.ts` | NEW — shared reward-token identity (resolver, invariant (i)) + spot pricing (SPOT-RESILIENCE helper, invariant (j)) for all Sui routes |
| `app/lib/aerodrome.ts` | `AerodromePosition` + optional `pendingRewards[]` / `rewardsUsd` (fees fields untouched) |
| `app/api/cetus/route.ts` | `fetchCetusTick` returns `rewards_growth_outside`; `computeCetusPendingFees` computes per-rewarder pending from `PositionInfo.rewards[]` + `rewarder_manager.rewarders[]`; handler resolves + prices; attached to position JSON |
| `app/api/bluefin/route.ts` | `fetchTick` returns `reward_growths_outside`; reward pre-pass from `pool.reward_infos[]` + `position.reward_infos[]` (`coins_owed_reward`, `reward_growth_inside_last`); attached |
| `app/api/momentum/route.ts` | Same as Bluefin (TypeName coin types via `extractTypeName`+`normalizeCoinType`) |
| `app/lib/priceLogger.ts` | Additive `pending_reward_count?` on `cetus_pending_fee_computed` |
| `app/dashboard/position/[id]/page.tsx` | Uncollected panel: reward rows + Total = fees + rewards; both APR spots: pool APY → derived-from-earnings fallback → "too early to estimate" (<24h or zero earnings); Claim-All gate includes rewards |
| `reports/position-detail-phase-b-report.md` | This report |

All reward field names **verified live on-chain** (never from docs): Cetus
`PositionInfo.rewards[].{growth_inside, amount_owned}` / tick `rewards_growth_outside[]` /
`rewarder_manager.rewarders[].{reward_coin, growth_global}`; Bluefin + Momentum
`position.reward_infos[].{coins_owed_reward, reward_growth_inside_last}` /
`pool.reward_infos[].{reward_coin_type, reward_growth_global}` / tick
`reward_growths_outside[]`. Same Q64 growth math as fees; same underflow guard; **zero extra
Sui RPC** (reward data rides objects the routes already fetch). Conservative guard: rewarder
indexes the position has no checkpoint for are skipped (never overstated).

## A. Build ✅
`tsc --noEmit` clean; `next build` ✓ (53/53 pages).

## B. Exact-match test (Cetus USDC/SUI `0x63301cc4…`, same minute) ✅

| Source | Fees | Rewards | Total |
|---|---|---|---|
| **DefiDesh local route** | $72.77 (40.537737 USDC + 43.636014 SUI) | CETUS 9.731068 + SUI 11.039897 = **$8.33** | **$81.10** |
| **On-chain recompute (= Cetus app's Claimable Yield)** | $72.76 | $8.33 | **$81.09** |
| Match | | | **within $0.01** ✅ |

Reward token amounts **byte-identical** (9.731068 / 11.039897 on both sides). The user's
screenshot ($71.42 vs $64.39, gap $7.03) was ~1 day earlier — the position has since accrued
to ~$81; the same-minute comparison is the valid exact-match test, and the recompute IS the
on-chain claimable the Cetus app renders.

## C. Cross-protocol ✅ (with one honest caveat)
- **Cetus, second real case (A2)**: USDC/SUI shows `rewardsUsd = $17.17` alongside
  fees $149.51 — non-zero rewards on a second wallet, correct.
- **Bluefin**: full route exercised against a real incentivized-pool position (WAL/SUI, owner
  `0xa825…`) → `pendingRewards: []`, no crash — genuinely zero accrual (recently collected);
  absent-section behavior is the design. Field shapes verified on a live position with 4
  reward checkpoints. **Caveat: no live Bluefin position with non-zero pending rewards was
  found in the sample**, so the non-zero Bluefin path is verified structurally (code-identical
  to the proven Cetus path) rather than numerically.
- **Momentum**: A1/A2 have 0 open positions → route returns cleanly (no crash, no error);
  reward fields verified on a live third-party position; non-zero path structural (same code).
- Pools with **zero rewarders**: rewards section simply absent (verified — Orca/A1 responses
  and Bluefin/Momentum empties unchanged in shape).

## D. Estimated APR fallback ✅

| Position | Route apy | Card before | Card after |
|---|---|---|---|
| **Orca ZEC/USDC** (`CQRttAmw…`) | 0 (pool absent from Orca v1 list) | **N/A** | **~213.4% — "derived from position earnings"** ($62.89 claimed + $44.03 uncollected, 4.4 days, $4,151.75 value) |
| Orca SOL/USDC | 97.3 (pool APY exists) | +97.3% | **+97.3% unchanged** (pool-APY path untouched) |
| Momentum (any, apy hardcoded 0) | 0 | N/A | derived (when a position exists) |
| Young/zero-earnings positions | — | N/A | **"—" / "too early to estimate"** (<24h guard) |

## E. No regressions ✅
- `fees` **byte-identical local vs production, same minute**: A2 Cetus `149.51 == 149.51`
  (rewards ride a separate additive field). `fees0/fees1/value/status` shapes unchanged.
- Analytics/Fee Income/Capital G/L read `fees`/activity/closed-position paths — none touched.
- Rule 1a untouched (claims stay historical); pending rewards valued at **current spot**
  via the resilient tiered helper (Rule 2 domain, invariant (j)).

## F. Performance ✅
Reward computation reuses already-fetched objects (position + pool + the same two tick
nodes) — **zero additional Sui RPC per position**. Additions: one `resolveToken` per unique
reward coin type (Redis-cached resolver) + one CoinGecko spot batch (goes through the
SPOT-RESILIENCE tiers). Local route times unchanged (~2–4 s Cetus A1).

## Deferred (Sprint POSITION-DETAIL-2)
- **B3** Solana pending rewards (Orca whirlpool rewardInfos offsets already documented in
  route comments; Raydium equivalent).
- **B4** EVM gauge emissions (Aerodrome/Velodrome staked AERO/VELO via `earned()`) — until
  then, staked EVM positions still under-report vs the protocol UI.
- **B5** PancakeSwap MasterChef CAKE (indefinite).

## Verification targets vs results
- Bug 1 target — Cetus position total matches the app within pennies: **$81.10 vs $81.09 ✅**
- Bug 2 target — ZEC/USDC shows a real APR: **~213.4% derived ✅**
