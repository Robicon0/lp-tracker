# Sprint LPPNL-PERF — Phase B report (B7 gate output)

**Date:** 2026-07-09 · **Mode:** built + tested locally (free Alchemy, real Upstash) ·
**Status: B7 verified, AWAITING APPROVAL — nothing committed.** No pricing / valuation /
reconstruction-math changes anywhere (verified: A1 Orca byte-identical).

## What shipped (working tree)

| Part | Change | File(s) |
|---|---|---|
| **A** — progressive aggregate | LP P&L block no longer skeletons every cell on `isLoading`. A cell skeletons ONLY while `included === 0 && isLoading` (the first ~2 s); once any position lands, all cells show their live partial value. Header shows a progressive chip: "computing N of M" while OPEN fetches run, then a softer "scanning {Sui/Solana} closed history…" while a closed scan runs. Capital G/L + Net P&L dim slightly + show "scanning closed positions…" until closed scans land, then finalize. Stale "Solana not yet available" tooltip corrected. | `analytics/page.tsx` |
| **A/C** — hook signals | `LpPnlResult` gains `inflightCount`, `suiClosedLoading`, `solanaClosedLoading` (additive; `isLoading` retained). `aggregate()` threads the two closed-loading flags (non-blocking — they do NOT gate `isLoading`). | `useLpPnl.ts` |
| **C** — client budget | The two closed-scan effects now set their loading ref true→false (surfacing the badge) and fetch through `fetchClosedWithBudget` (305 s AbortController — just above server maxDuration). No more silently-pending-forever Capital G/L. | `useLpPnl.ts` |
| **B1** — maxDuration | `export const maxDuration = 300` on both closed routes + a `vercel.json` `functions` glob `app/api/**/*: 300` covering the long activity routes too. | `solana-/sui-closed-positions/route.ts`, `vercel.json` |
| **B2** — lib dedup | Module-level in-flight promise map keyed by wallet (Solana) / (protocol, wallet) (Sui) in `getCachedClosedPositionCapitalGL` — concurrent callers share ONE scan. | `solanaClosedPositions.ts`, `suiClosedPositions.ts` |
| **B3** — route dedup | `/api/solana-closed-positions` wrapped in `withActivityRouteCache` (URL-keyed in-flight dedup + short TTL mirror). Durable cache stays `closed_pos_solana_v1:*`. | `solana-closed-positions/route.ts` |
| **B4** — heavy scan | **No resumable/background refactor needed** — see decision below. | (measurement only) |

## Part B4 decision (documented)

Phase A saw the 2,544-tx wallet take **19 min** — but that run was under B7-canary
contention + the concurrent double-scan. **Isolated single scan, cache flushed: 216.9 s
(complete, 38 positions).** With B2/B3 removing the double-scan and each scan getting the full
300 s window, **even this heavy bot wallet completes under `maxDuration=300` and caches.** So
resumability/background-job is **NOT required** and was deliberately skipped (it's a large,
correctness-risky refactor). **Documented residual:** a wallet heavier than ~3,000–3,500 txs
could still exceed 300 s single-scan; if that ever surfaces in production, the follow-up is a
signature-cursor resumable scan (or Fluid 800 s). For every wallet tested (and the reported
user case), 300 s + dedup is sufficient, and the failure mode is now graceful (partial numbers
+ "scanning" badge + client budget), never a 504-loop.

## B7 results

### A. Build
`tsc --noEmit` clean · `next build` ✓ Compiled successfully · `vercel.json` functions glob
present (`app/api/**/*: maxDuration 300`).

### B. Fresh-wallet spinner test — time-to-first-numbers
- **Per-position OPEN activity route cold = 2.0 s** (measured, `/api/orca/activity` for a live
  position). The LP P&L block now renders numbers as soon as the FIRST such fetch lands →
  **time-to-first-numbers ≈ 2 s** (was: full-block "calculating…" until the LAST fetch, minutes).
  Matches the Sprint PERFORMANCE positions-table baseline (~1–4 s).
- **Time-to-Capital-G/L:** the closed contribution fills in when each chain's scan lands —
  moderate wallet ~11–27 s, heavy ~215 s — during which Capital G/L / Net P&L show the current
  partial value + a "scanning closed positions…" sub-note and the header shows "scanning Solana
  closed history…". Never a blank spinner.
- Mechanism verified by reading the render: skeleton condition is `included === 0 && isLoading`
  only; every other state shows live values. (Headless React-timing of the full page isn't
  automatable here; the gate change is deterministic and the underlying latencies are measured.)

### C. Heavy Solana wallet completion (`8ZSjKbkF…`, 2,544 txs)
Through the real cached entry point (`getCachedClosedPositionCapitalGL`, cache flushed):
- **cold scan + cache write: 215.0 s** — **under the 300 s maxDuration budget ✓**, 38 positions.
- **WARM second read: 707 ms** — **served from Redis ✓** (cache write confirmed).
- **No 504-loop:** the scan completes within budget → writes `closed_pos_solana_v1:raydium:*` →
  every subsequent load is warm. (Isolated single-scan reproduced twice: 216.9 s and 215.0 s.)

### D. Dedup — route runs ONCE per wallet load
Two concurrent requests to `/api/solana-closed-positions?account=…` (cache flushed) → server
`[PRICE_LOG] activity_cache` shows exactly:
```
{"route":"/api/solana-closed-positions","status":"miss","ms":25974}   ← the ONE scan
{"route":"/api/solana-closed-positions","status":"dedup","ms":25867}  ← 2nd collapsed onto it
```
Both returned HTTP 200 at ~27 s (one scan time, not 2×). Lib-level dedup independently
confirmed: two concurrent `getCachedClosedPositionCapitalGL(A1)` returned the SAME promise
result in one scan window (106.9 s, identical). **CU saved: ~50% per fresh load** — the
double-scan is gone (heavy wallet ~187k CU → one scan instead of two; A1 ~25k → one).

### E. No regression (byte-identical)
Osho Account 1, fresh scan through the modified engine + `computePositionPnL`:
- **Orca closed = 19, `computePnL` ok 19/19, fees $1,760.01, Capital G/L −$1,818.78 —
  BYTE-IDENTICAL to the Sprint 3-FREE baseline.** 3 ground-truth PDAs exact: `FDhkNvkf` $657.84,
  `79rS8kcm` $467.26, `ELFxNL` $203.70.
- Warm read 575 ms. Raydium reconstruction math untouched (heavy wallet still 38 positions).
- Account 2 unchanged by construction (no Solana wallet). EVM + Sui code paths untouched — the
  only edits are render-gating (page.tsx), additive result fields, closed-effect status/budget,
  dedup wrappers, and maxDuration config. `aggregate()`'s valuation loop is unchanged.

### F. Capital G/L never shows an endless spinner
Guaranteed by construction: (1) the block skeletons only while `included === 0 && isLoading`,
and `isLoading` always drains (every per-position fetch resolves within its 150 s cap); (2) the
closed-scan badge clears when the effect resolves OR at the 305 s client budget; (3) if a scan
can't complete, the user sees partial numbers + a "scanning" badge, and a reload serves the now-
cached result. No code path leaves Capital G/L in a blank/spinning state indefinitely.

## Files touched
`app/analytics/page.tsx` · `app/hooks/useLpPnl.ts` · `app/api/solana-closed-positions/route.ts`
· `app/api/sui-closed-positions/route.ts` · `app/lib/solanaClosedPositions.ts` ·
`app/lib/suiClosedPositions.ts` · `vercel.json` · this report.

## Cache-version bumps
**None.** No cached CONTENTS change: `closed_pos_*` payloads are byte-identical (proven by A1),
`lp-pnl-events`/`analytics-activity` localStorage untouched. The changes are render-gating,
in-flight dedup (in-process/module), timeouts, and route config — none alter what's stored
(cache-versioning Rule 1).

**STOPPED AT B7 GATE — awaiting approval to commit + push, then CLAUDE.md/docs/memory updates.**
