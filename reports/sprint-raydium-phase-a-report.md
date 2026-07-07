# Sprint RAYDIUM — Phase A (read-only investigation)

**Date:** 2026-07-07 · **Infra:** free Alchemy (`ALCHEMY_SOLANA_RPC`) only · **Mode:** READ
ONLY (no code changes, no commits). Osho has zero Raydium positions — ground truth came from
**two third-party wallets found on-chain** (one per NFT era), 125 closed positions total.

## TL;DR

**Feasibility: 🟢 GREEN — and the investigation found a production-breaking bug in the
EXISTING Raydium open-position route.** The Sprint 3-FREE engine pattern ports directly:
both test wallets reconstructed **125/125 closed positions with 0 pending price sides**, and
Raydium is actually *better* than Orca for fee accounting (exact on-chain fee/principal
separation via event logs). The headline surprise: **`raydium/route.ts` decodes both Raydium
account types one byte off** (missed leading `bump` field), so its `memcmp` position lookup
**can never match — Raydium open positions silently return empty for every user worldwide.**
Phase B must fix that alongside closed positions to reach real parity.

---

## 1. Current Raydium state in the codebase

| Surface | State | Citations |
|---|---|---|
| Open positions | `app/api/raydium/route.ts` — CLMM only (`CAMMCzo5…`, line 9): `getNftMints` (both token programs, lines 43–57) → `getProgramAccounts` memcmp `offset: 8` = nftMint (line 118) → PersonalPositionState/PoolState decode (lines 129–190) | **BROKEN — see §2b** |
| Activity (P&L + Fee Income) | `app/api/raydium/activity/route.ts` — per-position signature scan; Anchor discs `open_position`, `open_position_with_metadata`, `increase_liquidity`, `decrease_liquidity`, `close_position` (lines 25–32); **`decrease_liquidity` with `liquidity==0` → fee_claim** (lines 79–86); DeFiLlama-by-mint claim pricing (Rule 1a, lines 334–394) | wired but **missing every v2 discriminator** (see §2c) and unreachable in practice (no positions ever load) |
| Client wiring | `Raydium` ∈ `ACTIVITY_PROTOCOLS` (useLpPnl.ts:206); `buildActivityUrl` branch (useLpPnl.ts:282–293) | per-position only |
| Closed positions / wallet-scope fees | **None** — `solanaClosedPositions.ts` is Orca-only; no Raydium in `useWalletLevelFees` | this sprint's target |

CLMM is the right (only) target: the route covers the concentrated-liquidity program that is
Raydium's Orca-equivalent. CPMM/legacy AMM pools are not position-NFT-based and out of scope.

### 1b. The production bug (found while decoding live accounts)

Raydium's Anchor accounts are **bump-first**: byte [8] is a `bump: u8`, and every field the
route documents is shifted **+1**. Verified byte-for-byte on live accounts:

- **PersonalPositionState** (live position `HKGZD6bt…`, disc `466f967e…` = sha256
  `account:PersonalPositionState` ✓): nftMint at **[9..41]** (matches the actual NFT mint);
  [8..40] decodes to garbage. ⇒ `raydium/route.ts:118`'s `memcmp {offset: 8, bytes: mint}`
  **never matches → `positions: []` for every Raydium wallet.** The bug was invisible because
  no verification wallet ever held a Raydium position (empty in = empty out looks correct).
- **PoolState** (live pool `45ssPkUQ…`, disc `f7ede3f5…` = sha256 `account:PoolState` ✓):
  real mint0/mint1 at [73..105]/[105..137], vaults [137..169]/[169..201], decimals at
  **[233],[234]** (the route's [232] read gives `138` — an impossible decimals), tickCurrent
  [269..273]. Every offset in `raydium/route.ts:167–190` is one byte early.

Even with memcmp fixed, the downstream decodes (poolId, ticks, liquidity, feesOwed, pool
mints/decimals) would all be garbage. **Fixing this is a mandatory part of Phase B** (and,
per Rule 1 platform framing: 100% of Raydium CLMM users currently see zero Raydium
positions).

---

## 2. Raydium CLMM on-chain mechanics vs Orca

**Program:** `CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK` (CLMM — the Orca-equivalent).

**Position representation:** NFT-per-position like Orca — **legacy Tokenkeg era AND
Token-2022 era both live in production** (both observed; the census close samples used one of
each). PersonalPositionState PDA = `["position", nftMint]` (verified: mint↔PDA derivation
matched live accounts). On `close_position`: **NFT burned (inner `burn` amount=1) AND the
PersonalPositionState account is CLOSED** (rent refunded) — verified in census samples.
⇒ Category B; the Sprint 3-FREE **ever-opened − currently-owned** rule applies directly, with
a bonus Raydium-only cross-check: a closed position's state account must no longer exist
(`getMultipleAccounts` → null) — measured **0/91 and 0/34 still existing** on the test
wallets, a perfect independent validation of the closed-set rule.

**Instruction set (live census, 1,200 recent program txs):** all position ops matched
**standard Anchor discriminators by name** — `open_position_v2` (22 accts),
`open_position_with_token22_nft` (20), `increase_liquidity_v2` (15), `decrease_liquidity_v2`
(16/19), `close_position` (6) — plus the v1 names in older history. **No Orca-style
`effb097c` surprise found**; two unknown 11-account discriminators appeared
(`8888fcddc2427e59`, `a78a4e95dfc2067e`) but their account counts match no position op
(likely protocol-fee/route variants — non-blocking, worth the Orca direction-inference
fallback anyway). ⚠️ `raydium/activity/route.ts:25–32` **lacks all v2 discriminators** — a
modern position's deposits/withdrawals would be invisible to it even after the §1b fix.

**Account index layout varies per instruction** (Orca lesson repeats): position at index 2 in
`decrease_liquidity_v2`, index 3 in `close_position`, elsewhere in opens (variant-dependent).
The Sprint 3-FREE **ever-opened-set match** (never a fixed index) works unchanged. For
discovery, the **mint↔PDA trick** is fully variant-independent: in any open instruction, the
account X for which `pda("position", X)` is *also* among the instruction's accounts is the
NFT mint, and that PDA is the position — 127/127 discoveries across both wallets, zero layout
knowledge needed.

**Fee/reward collection — Raydium's big difference from Orca:** there is **no separate
`collect_fees` instruction**. Fees (and rewards) are swept inside `decrease_liquidity` —
a `liquidity==0` decrease is a pure fee claim (the existing activity route already knows
this). Principal and fees arrive in the SAME vault→user transfers, so vault-matching alone
cannot split them. **The clean solution is on-chain and verified:** Raydium emits Anchor
event logs (`Program data:`), and **`DecreaseLiquidityEvent`** (disc `3ade563a44325538` =
sha256 `event:DecreaseLiquidityEvent`, observed verbatim in live txs) carries
`position_nft_mint, liquidity, decrease_amount_0/1, fee_amount_0/1, reward_amounts[3]` —
**exact fee/principal/reward separation per event**, better than Orca's wallet-delta
inference. Rewards are therefore separable for free (excluded from Capital G/L per Rule 4;
`collect_remaining_rewards` exists for post-close leftovers).

---

## 3. Reconstruction feasibility test (free Alchemy, live)

Candidate wallets found by scanning recent program history for `close_position` (a[0] =
owner). One wallet per NFT era, both scanned end-to-end with the Sprint 3-FREE paced pattern:

| | Wallet 1 `Ge3zoU3D…` (Token-2022 era) | Wallet 2 `Beq5dydX…` (legacy era) |
|---|---|---|
| History | 796 sigs / 640 valid txs — **100% fetched** | 137 sigs / 102 txs — **100% fetched** |
| Ever-opened / closed | 92 / **91** (LP bot, one SOL/PUMP pool) | 35 / **34** (3 pools: SOL/USDT ×2, SOL/USDC) |
| Closed-account existence cross-check | **0/91 still exist** ✓ | **0/34 still exist** ✓ |
| Reconstructed | **91/91, every event captured** | **34/34**, incl. multi-event lifecycles (up to 7 events) |
| Fee separation | 91 exact via `DecreaseLiquidityEvent`; 92 deposit legs via vault-matching | 50 exact via event log; 35 via vault-matching |
| Valuation (DeFiLlama-by-mint historical, stable $1 — invariant i, real on-chain mints incl. long-tail PUMP) | dep **$423,994.37** / wdl **$424,305.41** / **fees $1,234.95** / capGL **+$311.04** | dep **$1,207.86** / wdl **$1,207.59** / **fees $1.77** / capGL **−$0.27** |
| Pending price sides | **0** | **0** |
| Scan cost | 640 txs ≈ **26k CU**, throttle 0–342 depending on time of day, always completed | 102 txs ≈ **4k CU** |

Internal consistency is exactly what a market-making bot should look like (±$300 capGL on
$424k of churn, per-re-range capGL ≈ $0), and the tiny-position wallet shows correct
zero-fee handling (positions with no accrued fees emit no fee event). **Throttle behavior
identical to Orca:** the census run absorbed 342 throttle events and still fetched 1,200/1,200;
off-peak runs saw zero throttling. CU per wallet scales with tx count exactly as Orca
(~40 CU/tx-fetch +1 sig page per 1000).

Honest caveats: (a) wallets >4,000 sigs weren't tested (same Phase A cap as Orca — the
retry-until-complete pacing is size-agnostic, only wall-clock grows); (b) my first two test
runs failed from **my own script bugs** (silently-dropped throttled `getMultipleAccounts`
batches, then the §1b off-by-one inherited from production code) — both are lessons encoded
below, not open risks.

## 4. Token/mint audit

`raydium/route.ts` `TOKENS` (lines 13–22): **all 8 mints verified live on-chain — valid
pubkeys, decimals match exactly** (SOL 9, USDC 6, USDT 6, RAY 6, soBTC-"WBTC" 6, mSOL 9,
Wormhole-"ETH" 8, BONK 5). **No ZEC/ORCA-class landmine** (re-verifies ORCA-FREE-FIX). The
soBTC/Wormhole-ETH entries remain legacy-but-valid (Rule 9 cleanup candidates, non-blocking).

## 5. Phase B scope (recommendation)

**Extend `solanaClosedPositions.ts` with a `raydium` protocol branch — same lib, ONE wallet
scan for both protocols.** Rationale: the expensive artifact is the wallet tx-history scan,
which is per-WALLET not per-protocol; a separate lib (or the Sui model of re-scanning per
protocol) would double the CU + latency for every Solana wallet. Parse both programs' instrs
from the same scanned txs; per-protocol config carries `{programId, discriminators,
event-log parsers, discovery}`.

Design points (all Contract invariants from day one):
- **Discovery:** mint↔PDA trick (variant-independent) + ever-opened-set match for event
  attribution (never a fixed account index) — both proven here. Optional belt-and-suspenders:
  the closed-account-existence check.
- **Amounts:** `DecreaseLiquidityEvent` event-log parse for exact
  principal/fee/reward separation (fees → Fee Income; rewards excluded from Cap G/L per
  Rule 4 but carried on the position shape as `rewardAmounts` so POSITION-DETAIL-2's
  pending-reward work (invariant k) and any future reward valuation slot in without rework);
  vault-direction matching as the fallback (deposits/opens + any log-less tx).
- **Valuation:** identical historical-only cascade (stable $1 → DeFiLlama-by-mint →
  CG-historical via resolver cgId → pending; never spot — invariant i, real on-chain mints
  from the +1-corrected PoolState).
- **Cache:** `closed_pos_solana_v1:raydium:{wallet}` (new protocol sub-key — existing
  `:orca:` entries byte-identical, NO version bump; but note the shared-scan refactor should
  keep the orca output byte-identical or bump to v2 — verify at implementation).
- **MANDATORY bundled fix — the §1b production bug:** `raydium/route.ts` memcmp offset 8→9
  (or better: drop `getProgramAccounts` for the direct `["position", nftMint]` PDA derive +
  `getMultipleAccounts`, as orca/route.ts does) + all PersonalPositionState/PoolState offsets
  +1. Also add the v2 discriminators to `raydium/activity/route.ts` (and ideally its own
  event-log fee separation). Without this, "Raydium parity" is fiction — open positions are
  broken for every user today.
- **Wiring:** `solana-closed-positions` route returns both protocols;
  `useWalletLevelFees`'s closed-Solana fetch tags events by `sp.protocol` (currently
  hardcodes "Orca"); analytics label → "EVM + Sui + Solana (Orca, Raydium)"; docs/about
  (Rule 4 everywhere-or-not-integrated).
- **Cache bumps:** none expected for localStorage (no Raydium positions ever loaded → no
  cached entries; dashboard route isn't localStorage-cached) — confirm at implementation per
  cache-versioning Rule 1.
- **Effort: medium-small.** The engine branch is prototyped in this Phase A (both eras, both
  fee paths, multi-pool, multi-event); the open-position fix is surgical; verification reuses
  the two test wallets ($1,234.95 / $1.77 fee targets, 125-position census, existence checks)
  plus a fresh third wallet as a blind target.

**Verification targets for B7:** wallet 1 fees $1,234.95 / capGL +$311.04 (91 closed);
wallet 2 fees $1.77 (34 closed); 0 pending, 0 spot; open-position route returns real
positions for a live Raydium wallet (currently impossible); tsc + build clean.

---

## Appendix — method

Scratchpad-only scripts (not committed): `ray-census.ts` (1,200-tx program census),
`ray-mint-audit.ts`, `ray-recon.ts` (full two-wallet reconstruction), `ray-debug*.ts`
(layout verification). RPC: `ALCHEMY_SOLANA_RPC` exclusively, paced batches + backoff +
retry-until-complete throughout; DeFiLlama `/prices/historical` read-only. Total Phase A
CU spend ≈ 100k (~0.3% of the monthly free budget).
