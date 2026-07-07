# Sprint RAYDIUM — Phase B report (B7 gate output)

**Date:** 2026-07-08 · **Infra:** free Alchemy (`ALCHEMY_SOLANA_RPC`), no Helius · **Status:
B7 verified, AWAITING APPROVAL — nothing committed.**

## What shipped (working tree)

| Part | Change |
|---|---|
| 1 — Open-position fix (production-critical) | `app/api/raydium/route.ts`: replaced the per-mint `getProgramAccounts` memcmp at offset 8 (which could NEVER match — Raydium accounts are **bump-first**, nftMint is at [9..41]) with **direct PDA derivation** (`["position", nftMint]` + one batched `getMultipleAccounts` + PersonalPositionState-disc check — the Orca pattern, layout-independent). All PersonalPositionState AND PoolState offsets corrected (+1); every offset documented against the byte-verified layout. |
| 2 — Activity route | `app/api/raydium/activity/route.ts`: added `open_position_v2`, `open_position_with_token22_nft`, `increase_liquidity_v2`, `decrease_liquidity_v2` discriminators (modern positions were invisible); v2 decrease keeps the liquidity==0 → fee_claim rule (same arg layout). |
| 3 — Closed positions | `app/lib/solanaClosedPositions.ts`: `raydium` protocol branch, **ONE shared wallet scan for both protocols** (zero extra RPC for the second program). Discovery via the variant-independent **mint↔PDA trick**; events via **`DecreaseLiquidityEvent` program-data logs** (exact principal/fee/reward separation — Raydium bundles fees into decrease_liquidity) with vault-direction fallback; pools via PoolState-disc filter over instr accounts with **retry-until-complete `getMultipleAccounts`** (Phase A lesson: a silently-dropped batch hid a pool). `rewardAmountsRaw[3]` carried on the position shape (raw u64 sums, stringified) for POSITION-DETAIL-2. Historical-only valuation unchanged (stable $1 → DeFiLlama-by-mint → CG-historical → pending; never spot). |
| 4 — Wiring + cache | Redis sub-key `closed_pos_solana_v1:raydium:{wallet}` (`:orca:` entries byte-compatible, untouched); `useLpPnl` DTO + label map (`raydium` → "Raydium"); `useWalletLevelFees` tags closed-position fees by each position's protocol; analytics label → **"EVM + Sui + Solana (Orca, Raydium)"**; `solana_closed_position_valued` [PRICE_LOG] emits `protocol: raydium`. |

**One deliberate cache-contract refinement (flagging for approval):** the Sprint 1.14
"empty-never-cached" rule is refined for this engine — an EMPTY protocol result IS cached,
but **only when the scan was provably 100% complete** (`stats.complete`) and with a **24 h
TTL** (vs 30 d for non-empty). Rationale: the rule exists so a *transient failure* never
freezes in as "no closed positions" — that still holds (partial/failed scans never cache) —
but without this, a wallet legitimately empty on one protocol (the common case: most wallets
use ONE AMM) would re-pay the full 40–120 s scan on EVERY analytics load. Verified live:
census wallet 1's empty orca result cached as `[]` with ttl 86,397 s.

## B7 results

### A. Build
`tsc --noEmit` clean · `next build` ✓ Compiled successfully.

### B. Open-position fix — proven live (the platform-wide bug fix)
Localhost prod server, real third-party wallets, `/api/raydium?account=…`:

| Wallet (era) | Pre-fix | Post-fix |
|---|---|---|
| `Ge3zoU3D…` (Token-2022 NFT) | `[]` (memcmp never matched) | **SOL/PUMP, In Range, value $5,545.53**, 34.97 SOL + 1,735,620 PUMP, decimals 9/6, PUMP priced $0.00156559 via resolver, real on-chain mints |
| `Beq5dydX…` (legacy Tokenkeg NFT) | `[]` | **SOL/USDT Out-of-Range $0.99** with correct decimals **9/6 (pool decimals no longer read 138)** + a zero-liquidity NFT-alive position correctly shown as "Closed" |

### C. Closed reconstruction — census targets + blind generalization

| Wallet | Scan | Closed | Fees | Capital G/L | Pending / Spot |
|---|---|---|---|---|---|
| Census 1 `Ge3zoU3D…` (target 91 / $1,234.95 / +$311.04) | 824 sigs → **667/667 txs, complete** | **94** | **$1,341.52** | +$272.48 | **0 / 0** |
| Census 2 `Beq5dydX…` (target 34 / $1.77 / −$0.27) | 170 → **128/128, complete** | **38** | **$2.32** | +$0.10 | **0 / 0** |
| **BLIND** `8ZSjKbkF…` (never touched in Phase A) | **2,601 sigs → 2,544/2,544, complete** | **38** | **$6,907.87** | **+$14,039.63** | **0 / 0** |

- **Census deltas are data movement, not drift:** both bots kept trading between Phase A
  (07-07) and B7 (07-08) — W1 grew 796→824 sigs (+3 closed positions, +$106.57 fees), W2
  137→170 (+4, +$0.55). Every overlapping position matches Phase A **to the cent** (e.g.
  `HeX5KJXi` $148.81, `5ujGv8Jb` $76.00).
- **The blind wallet generalizes hard:** a completely new long-tail pair (**CARD/USDC** —
  priced via DeFiLlama-by-mint, invariant i), 4× the tx volume of any Phase A wallet,
  multi-event lifecycles up to **47 events** on one position (e.g. `5pNyj1Dg` dep $13,588.39 /
  wdl $15,775.87 / fees $2,320.09 / capGL +$2,187.49), all internally consistent.

### D. Data integrity + scan behavior
0 pending price sides, 0 spot valuations across **all 170 reconstructed Raydium positions**
(and A1's 19 Orca). Every scan 100% complete with backoff pacing. Throttle/CU per wallet:
census 1 = 0 throttles / ~27k CU; census 2 = 0 / ~5.4k; A1 = 371 / ~40.2k; blind = **967
throttles absorbed / ~224.8k CU / 19 min wall** (2,544 txs — the heaviest wallet yet, still
100%). CU scales linearly with tx count; a blind-sized wallet costs ~0.75% of the monthly
free budget, once, then Redis.

### E. Single-scan efficiency
Confirmed by construction and by the stats: each wallet produced BOTH protocol outputs from
ONE `getClosedPositionsForWallet` scan (census wallets: orca=0 + raydium=94/38 from the same
`stats`; A1: orca=19 + raydium=0 from one scan). No second scan exists in the code path.

### F. No regressions
- **Orca byte-identical:** fresh A1 scan through the refactored engine → **19 closed /
  fees $1,760.01 / capGL −$1,818.78 — exactly the Sprint 3-FREE baseline**, and the 3
  ground-truth PDAs exact: `FDhkNvkf` $657.84, `79rS8kcm` $467.26, `ELFxNLxJ` $203.70.
  A1 raydium = 0 (correct — no Raydium history).
- **Client folding:** `computePositionPnL` ok **94/94** on W1's raydium positions; client
  aggregate capGL **$272.48 byte-identical** to the engine sum.
- EVM + Sui untouched (this sprint touches no EVM/Sui code path; `aggregate()` and the fee
  memo are unchanged — only the DTO union, protocol tag, and label). Account 2 unchanged by
  construction (no Solana wallet).

### G. Cache
`closed_pos_solana_v1:raydium:{W1}` populated with 94 positions on first scan; warm reads
**838 ms / 817 ms** (both protocols, one round-trip each). Empty-complete policy verified
(§deviation above). **No cache-version bumps needed:** `:orca:` entries are byte-compatible
(proven by the A1 reproduction); `:raydium:` is a new sub-key; `lp-pnl-events` /
`analytics-activity` localStorage caches hold no Raydium entries anywhere (the open-position
route returned `[]` for every user, so no Raydium position was ever cached — the bug that
made the fix necessary also makes it bump-free).

### H. Reward carry
`rewardAmountsRaw[3]` present on **all 170** reconstructed Raydium positions (all zeros on
the test wallets — none of the three pools ran emissions in the scanned windows; the parse
reads `DecreaseLiquidityEvent.reward_amounts` so non-zero emissions flow through with zero
additional work). POSITION-DETAIL-2 can read them without re-scanning.

## Files touched
`app/api/raydium/route.ts` · `app/api/raydium/activity/route.ts` ·
`app/lib/solanaClosedPositions.ts` · `app/api/solana-closed-positions/route.ts` (comment) ·
`app/hooks/useLpPnl.ts` · `app/hooks/useWalletLevelFees.ts` · `app/analytics/page.tsx` ·
`app/lib/priceLogger.ts` (comment) · this report.

## Lesson for the Contract (docs step, after approval)
**Verify against third-party wallets when Osho has no position of that type.** The bump-first
bug shipped and sat silent because every verification wallet was Raydium-empty — empty-in /
empty-out is indistinguishable from correct. The first real foreign data (a random closer
found by scanning program history) exposed it in minutes. Same method found the CARD/USDC
blind wallet that proved generalization.

**STOPPED AT B7 GATE — awaiting approval to commit + push (then CLAUDE.md/docs/memory
updates per the sprint instructions).**
