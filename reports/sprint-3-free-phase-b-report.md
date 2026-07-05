# Sprint 3-FREE — Phase B report (B7 gate output)

**Date:** 2026-07-06 · **Wallet:** Account 1 Solana `GndRty…pogC` · **Infra:** FREE Alchemy
Solana endpoint (`ALCHEMY_SOLANA_RPC`) — paid Helius NOT used. **Status: B7 verified,
AWAITING APPROVAL — nothing committed.**

## What shipped (working tree)

| Part | Change |
|---|---|
| 1 — Engine | NEW `app/lib/solanaClosedPositions.ts` — paced Alchemy wallet-history scan (serial 20-tx batches, 120 ms gap, exponential backoff on 429/−32005, retry-until-complete), Orca Whirlpool Anchor-discriminator parse, **vault-transfer-matched** event extraction, closed = ever-opened − currently-owned (live `getNftMints`), historical-only valuation (stable $1 → DeFiLlama-by-mint → CG-historical-by-resolver-cgId → pending; **never spot**), Capital G/L = withdrawal − deposit (Rule 4), `solana_closed_position_valued` [PRICE_LOG] (new event type in `priceLogger.ts`) |
| 2 — Mint cleanup | Wrong ZEC (`zR…` mint) + invalid ORCA (`…ABCDE`) deleted from `app/api/orca/route.ts` + `app/api/solana/balances/route.ts`; verified ZEC `A7bdiYdS…` (dec 8, cgId `omnibridge-bridged-zcash-solana`) pinned in `tokenConstants.ts` (Rule 9 high-stakes pin) |
| 3 — Redis cache | `closed_pos_solana_v1:orca:{wallet}`, 30-d TTL, versioned, empty-never-cached, fire-and-forget (Sprint 1.14/2.2b contract) |
| 4 — Integration | NEW `app/api/solana-closed-positions/route.ts`; `useLpPnl` — "Solana" in `CAPITAL_GL_CHAINS`, `solanaClosedRef` + fetch effect (mirrors Sui), `solanaWalletAddresses` param; `useWalletLevelFees` — closed-Orca fee claims folded into Fee Income (URL-deduped, txHash+amount deduped vs per-position); `analytics/page.tsx` — `solanaWalletAddresses` (case-preserved — base58) + Capital G/L label → **"closed positions, EVM + Sui + Solana (Orca)"** |

**Scope lock honored:** Orca only. No Raydium, no Sprint-4 UI.

## One engine bug found & fixed during B7 (why B7 exists)

First full-engine run returned 1 giant merged position with $0 fees. Two root causes, both
fixed and re-verified:
1. **Position account index varies by instruction** — `collect_fees` carries the position at
   account index 2, but `increase/decrease_liquidity` carry an extra `positionAuthority` so the
   position sits at index 3. A fixed `a[2]` grabbed the WALLET for liquidity events. Fix:
   identify the position by matching instruction accounts against the discovered ever-opened
   PDA set (variant-proof).
2. **Non-standard deposit discriminator** — 14 of the wallet's deposits use an Orca
   liquidity-add variant whose discriminator (`effb097cd2c6352b`, 15 accounts) is NOT
   `sha256("global:increase_liquidity_v2")`. Fix: classified discriminators are used when known;
   otherwise the event kind is inferred from **vault-transfer direction** (all-into-vault =
   deposit, all-out = withdrawal; mixed/swap-like skipped) — no opaque hex hardcodes, robust to
   future Orca instruction variants.

## B7 results

### A. Build
`tsc --noEmit` exit 0 · `next build` ✓ Compiled successfully · `/api/solana-closed-positions` registered.

### B. Free-tier scan completeness (fixed engine, live run)
- **670 signatures (630 valid), 630/630 transactions fetched — `cleanComplete=true`, 0 dropped**
- throttle events (429/−32005, incl. retries): **376 — all absorbed by backoff**; wall **120.4 s**
- billed calls ≈1,010 → **≈40,400 CU** (incl. retry accounting; clean-run floor ≈25k) → ~**750–1,190 first-time wallets/month** on the 30M free budget; repeat loads ≈0 CU (Redis)

### C. Line-by-line reconciliation table — all 19 closed Orca positions

| PDA | Pair | Open → Close | Deposit USD | Withdrawal USD | Fees USD | Capital G/L | Pending | Valuation source |
|---|---|---|---:|---:|---:|---:|---:|---|
| `FDhkNvkf` | ZEC/USDC | 06-05 → 06-17 | 4,826.59 | 5,177.52 | **657.84** | +350.93 | 0 | defillama-hist + stable |
| `79rS8kcm` | SOL/USDC | 02-08 → 06-04 | 3,379.42 | 2,838.72 | **467.26** | −540.70 | 0 | defillama-hist + stable |
| `ELFxNLxJ` | SOL/USDC | 2025-11-29 → 01-31 | 2,359.82 | 1,860.24 | **203.70** | −499.57 | 0 | defillama-hist + stable |
| `3qsDxnB7` | SOL/USDC | 06-19 → 07-04 | 2,802.93 | 3,004.47 | 125.28 | +201.55 | 0 | defillama-hist + stable |
| `h8voon1y` | ZEC/USDC | 06-17 → 06-23 | 4,974.03 | 4,178.22 | 118.78 | −795.82 | 0 | defillama-hist + stable |
| `CQRttAmw` | ZEC/USDC | 06-28 → 07-04 | 3,832.47 | 4,174.23 | 114.43 | +341.75 | 0 | defillama-hist + stable |
| `G5srg2kc` | ZEC/USDC | 06-23 → 06-27 | 4,178.22 | 4,052.62 | 40.49 | −125.59 | 0 | defillama-hist + stable |
| `D5i43epu` | SOL/USDC | 06-05 → 06-05 | 2,717.17 | 2,717.17 | 12.30 | −0.00 | 0 | defillama-hist + stable |
| `4NFpNjGd` | ZEC/USDC | 06-28 → 06-28 | 3,832.47 | 3,832.47 | 6.94 | −0.00 | 0 | defillama-hist + stable |
| `Ciw1zpGL` | SOL/USDC | 06-05 → 06-06 | 2,714.68 | 2,525.69 | 6.30 | −188.99 | 0 | defillama-hist + stable |
| `7TCvgaDH` | SOL/USDC | 06-04 → 06-05 | 2,838.83 | 2,714.68 | 2.36 | −124.15 | 0 | defillama-hist + stable |
| `BQobV1xi` | SOL/USDC | 06-17 → 06-17 | 3,020.74 | 3,020.74 | 1.80 | −0.00 | 0 | defillama-hist + stable |
| `8JeHBFEe` | SOL/USDC | 06-17 → 06-18 | 3,024.83 | 2,858.94 | 1.15 | −165.89 | 0 | defillama-hist + stable |
| `EXCUAitK` | SOL/USDC | 06-18 → 06-19 | 2,855.08 | 2,802.93 | 0.50 | −52.15 | 0 | defillama-hist + stable |
| `Dy5W2wrw` | ZEC/USDC | 06-23 → 06-23 | 4,178.22 | 4,178.22 | 0.39 | −0.00 | 0 | defillama-hist + stable |
| `AKmFjvZo` | ZEC/USDC | 06-28 → 06-28 | 3,832.47 | 3,832.47 | 0.28 | −0.00 | 0 | defillama-hist + stable |
| `CJ4CCCV4` | ZEC/USDC | 06-27 → 06-28 | 4,052.62 | 3,832.47 | 0.20 | −220.15 | 0 | defillama-hist + stable |
| `7fqzwGJW` | SOL/USDC | 02-08 → 02-08 | 14.27 | 14.27 | 0.00 | 0.00 | 0 | defillama-hist + stable |
| `GMifcbdg` | ZEC/USDC | 06-23 → 06-23 | 4,178.22 | 4,178.22 | 0.00 | −0.00 | 0 | defillama-hist + stable |
| **TOTALS** | **19 closed** | | | | **$1,760.01** | **−$1,818.78** | **0** | |

(Dates 2026 unless noted. Deposit/withdrawal USD telescope across re-range chains — each
re-range withdraws at ~the same price it re-deposits, so per-position G/L sums to the true
realized total without double-counting.)

**3 ground-truth positions vs sheet-matched Phase A values:**

| PDA | Pair | DefiDesh (DeFiLlama daily-close) | Sheet/ground truth | Δ |
|---|---|---:|---:|---:|
| `FDhkNvkf` | ZEC/USDC | $657.84 | $657.84 | **$0.00** |
| `79rS8kcm` | SOL/USDC | $467.26 | $467.18 | **+$0.08** |
| `ELFxNLxJ` | SOL/USDC (Nov-2025) | $203.70 | $203.79 | **−$0.09** |

Per Osho's decision, the chain is authoritative; this table is the artifact for the line-by-line
eyeball against the Google Sheet (any residual per-claim difference is DeFiLlama daily-close vs
sheet-recorded price on volatile ZEC days).

### D. Data integrity
Fees **$1,760.01** (target ~$1,760; Phase A independent reconstruction $1,760.52 — Δ$0.51,
sub-0.03% cache-date variance). **0 pending, 0 spot** — every one of the 84 valued events used
`defillama-historical + stablecoin-fixed`. Grep guarantee:
`solana_closed_position_valued | grep -i spot` → nothing.

### E. Capital G/L
- **Account 1 gains −$1,818.78** of Solana realized Capital G/L (19 positions). Client-side
  parity proven: `computePositionPnL` **ok 19/19**; aggregate (closingValue − initialValue) =
  **−$1,818.78, byte-identical** to the engine's per-position sum. New A1 total = prior EVM+Sui
  figure + (−$1,818.78), rendered under the updated "EVM + Sui + Solana (Orca)" label.
- **Account 2 unchanged by construction** — it has no Solana wallet, so `solanaWalletAddresses`
  is empty and the effect never fires (also verifies the empty-set cleanup path).

### F. No regressions
- EVM + Sui paths untouched: `aggregate()` extended with **optional** trailing params (all 5
  existing call sites updated mechanically; Sui refs and dedupe logic byte-identical); the
  dashboard's `useLpPnl(allPositions)` single-arg call unchanged.
- Open Orca positions correct: the 2 current open positions (`2VZwVyEJ`, `F7uAysqx` — Osho
  re-ranged 07-04→07-05) are correctly EXCLUDED from the closed set. Cross-validation of the
  re-range: old open position `CQRttAmw`'s closed-fees $114.43 ≈ its previously-verified $62.89
  claimed + $51.42 uncollected (collected at close) — the fee dollars moved buckets, none lost.
- Fee Income dedupe: closed-Orca events dedupe by (Orca, txHash, amount0, amount1) against any
  per-position view of the same claim; per-position pushed first, wins.

### G. Mint cleanup verified
`grep -rn 'zRwbz|orcaEKTdK7…ABCDE' app/` → **0 hits**. ZEC resolves by on-chain mint
(`A7bdiYdS…` → cgId `omnibridge-bridged-zcash-solana`, priceable — proven live in ORCA-FREE-FIX
Phase A at $459 spot); **ZEC decimals now deterministic (8)** via the `tokenConstants.ts` pin
(consulted by `resolveToken`'s hardcoded-constant tier even if DAS misses). ORCA resolves by
whatever real mint appears on-chain (DAS + resolver); no invalid placeholder remains anywhere.

### H. Cache
- `closed_pos_solana_v1` populates on first scan; warm reads: **lib 795 ms / route HTTP 200 in
  0.23 s** (localhost prod server, real Upstash). Note: an immediate same-process re-read can
  race the fire-and-forget write (observed once in the canary) — irrelevant in production where
  requests are seconds apart; empty results are never cached either way.
- **NO `lp-pnl-events` / `analytics-activity` bumps** (Sprint 2.2b reasoning, re-validated):
  those localStorage caches hold per-position activity for positions in the dashboard array;
  closed (burned-NFT) Solana positions were never in that array, and the orca/balances route
  outputs are byte-identical (the removed map entries were invalid/wrong keys that could never
  match an on-chain mint — the only behavior change is CoinGecko no longer being asked for the
  unused `orca`/`zcash` ids). The new Redis namespace needs no bump (new key).
- Alchemy CU economics restated: ~25–40k CU per first wallet scan → **~750–1,190 fresh Solana
  wallets/month free**; repeat loads ≈0 CU. Upgrade only at sustained hundreds of new Solana
  wallets/day.

### I. Performance
The Solana closed fetch is a separate non-blocking effect (mirrors Sui) — first meaningful
render (~1–4 s baseline) is untouched; rows stream as before and Capital G/L updates when the
closed data lands (instant when Redis-warm; the one-time ~40–120 s first scan runs server-side
in the background of the first load). `useWalletLevelFees` gained one URL-deduped fetch inside
the existing progressive/atomic-swap machinery; in-flight dedup preserved (shared
`urlCacheRef`).

## Milestone (pending approval)
**Cross-chain Capital G/L is COMPLETE across EVM + Sui + Solana** — every supported chain's
closed positions now reconstruct and fold into Capital G/L, on free infrastructure (the Memory
#23 north-star). The **Alchemy free-tier paced-scan pattern** (serial small batches + backoff +
retry-until-complete + immutable Redis cache) is now the documented template for any future
chain needing tx-history reconstruction.

## Files touched
`app/lib/solanaClosedPositions.ts` (new) · `app/api/solana-closed-positions/route.ts` (new) ·
`app/lib/priceLogger.ts` · `app/lib/tokenConstants.ts` · `app/api/orca/route.ts` ·
`app/api/solana/balances/route.ts` · `app/hooks/useLpPnl.ts` · `app/hooks/useWalletLevelFees.ts`
· `app/analytics/page.tsx` · this report.

**STOPPED AT B7 GATE — awaiting approval to commit + push (then CLAUDE.md/docs updates per the
sprint instructions).**
