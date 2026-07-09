# Sprint LPPNL-PERF — Phase A (read-only investigation)

**Date:** 2026-07-08 · **Mode:** READ ONLY (no code changes) · **Symptom:** the analytics
"LP Profit & Loss" block shows a full-block "calculating…" skeleton for 5+ minutes on a
first-time wallet, sometimes never showing a complete Capital G/L. Fee Income + portfolio
cards render fine; cached (returning) wallets load fast.

## TL;DR — there are TWO independent bugs, not one

1. **The spinner (the 5-minute "calculating…") is an ALL-OR-NOTHING render gate.** The whole
   LP P&L block skeletons every cell while `lpPnl.isLoading` is true, and
   `isLoading === (inflight > 0)` — true until the **last per-position OPEN activity fetch**
   resolves. These are throttled **2-per-endpoint** and each cold EVM/Sui route is 9–35 s (or
   times out at 150 s), so a heavy fresh wallet takes minutes. **The numbers are already
   computed progressively under the hood** (every landed fetch recomputes the aggregate) — the
   UI just refuses to show partial totals. This is the exact all-or-nothing pattern Sprint
   PERFORMANCE fixed for the positions *table* but **never applied to the LP P&L aggregate**.
2. **The Capital G/L number genuinely never completes for heavy Solana wallets** — a separate,
   deeper bug. The closed-Solana scan (`/api/solana-closed-positions`, Orca+Raydium in one
   walk) is **unbounded** (measured **19 min / 2,544 txs** in Sprint RAYDIUM B7), the route has
   **no `maxDuration` set** (so it dies at Vercel's low default), and it is **fetched TWICE
   concurrently** with no dedup. On Vercel it 504s → contributes nothing → **is never cached →
   re-scans and re-fails on every reload.** This does NOT drive the spinner (see §1), but it's
   why Capital G/L can be permanently wrong/incomplete for an active Solana wallet.

Neither fix touches pricing/correctness.

---

## 1. What the LP P&L block waits on (traced)

**Render gate** (`analytics/page.tsx:1655–1822`): the block header shows a spinner and EVERY
value cell renders a shimmer skeleton + the literal sub-text **"calculating…"** whenever
`lpPnl.isLoading` is true. The in-code comment is explicit: *"every value cell shows a
skeleton bar. No partial totals reveal — the user only sees numbers once all positions across
all chains have completed."*

**`isLoading` source** (`useLpPnl.ts:968`): `isLoading: inflight > 0`, where `inflight` is
`inflightRef.current.size`. `inflightRef` is mutated ONLY by the per-position fetch loop
(add at `:1222`, delete at `:1249`). So the gate tracks **open + EVM-closed per-position
activity fetches only.**

**Crucially, the closed-Sui and closed-Solana reconstructions do NOT gate `isLoading`.** They
run in two SEPARATE effects (`useLpPnl.ts:1048` Sui, `:1090` Solana) that fetch
`/api/{sui,solana}-closed-positions`, write `suiClosedRef`/`solanaClosedRef`, and call
`aggregate()` with the **current** `inflightRef.size` — they never touch `inflightRef`. So:

- The spinner is **all-or-nothing on the per-position OPEN fetches** — genuinely the same
  gate class PERFORMANCE fixed for positions, left unfixed for this aggregate.
- The closed scans stream their contribution in *after* the spinner clears — meaning Capital
  G/L can visibly change (or stay incomplete) *after* the block "finishes loading". A heavy
  Solana scan that 504s means the closed contribution silently never arrives.

So it is NOT literally "waits on all closed scans before showing anything" — it's worse and
subtler: it blocks the whole block on the slowest OPEN fetch, then quietly patches Capital G/L
later (or never).

## 2. Cold first-time cost breakdown (measured, free Alchemy / local prod build)

| Contributor | Cold | Warm (Redis) | Bounded? | Gates spinner? |
|---|---|---:|---|---|
| Per-position OPEN activity fetch (each) | 9–35 s typical, **150 s timeout cap**, ×2 attempts on network/5xx = up to 300 s | n/a (localStorage per-position) | per position | **YES** (this is the spinner) |
| — throttle | **2 concurrent per endpoint pathname** (`MAX_PER_ENDPOINT=2`); N positions on one endpoint = ⌈N/2⌉ serial waves | | | |
| Sui closed scan (`sui-closed-positions`, 3 protocols) | **17.8 s** (Osho A1) | 0.5 s | ~bounded (Sui RPC page cap) | no |
| Solana closed scan (`solana-closed-positions`, Orca+Raydium) — moderate 128-tx wallet | **11.2 s** | 0.5 s | **NO — scales with wallet tx count** | no |
| Solana closed scan — heavy 2,544-tx wallet | **~19 min** (1,143 s, Sprint RAYDIUM B7; 967 throttles) | 0.5 s | | no |

**Which single cost dominates?**
- For the **spinner**: the per-position OPEN fetches, amplified by 2-per-endpoint throttling.
  A fresh wallet with many positions on one provider (e.g. lots of HyperEVM ProjectX on
  `/api/hyperswap/activity`, or many Aerodrome on `/api/aerodrome/activity`) serializes them in
  ⌈N/2⌉ waves × (9–35 s, up to 150 s each) = **minutes**. This is what shows "calculating…".
- For the **Capital G/L number specifically**: the **Solana closed scan**, which is UNBOUNDED.
  A market-making / high-frequency Solana wallet (thousands of txs) takes 5–20 min — and that
  never fits in a Vercel function (§4). Yes, a very active wallet's scan can exceed 5 minutes;
  the 2,544-tx wallet took 19.

**Sequential or parallel?** The Sui and Solana closed effects are **independent `useEffect`s →
parallel** with each other and with the per-position loop. WITHIN the Solana route, Orca and
Raydium are parsed from ONE shared scan (not two). Per-position fetches are parallel across
endpoints, 2-at-a-time within an endpoint. So the chains don't serialize against each other —
the problem is per-endpoint throttling (spinner) and one unbounded route (Capital G/L), not
cross-chain sequencing.

## 3. Is the result cached after the first scan? (yes — that's why Osho is fast)

Confirmed live. `closed_pos_solana_v1:{orca|raydium}:{wallet}` and
`closed_pos_sui_v1:{protocol}:{wallet}`: cold scan writes them, warm reads served in **~0.5 s**.
Verified both sub-keys in Redis after a moderate scan (orca `[]` at 24 h TTL under the refined
empty-complete rule, raydium 38 positions at 30 d TTL). **So Osho's wallets are fast purely
because they were scanned once and cached** — exactly the stated mechanism.

**BUT two caching gaps make the first scan far more expensive than it should be:**
- **(3a) Concurrent double-scan, no dedup.** `/api/solana-closed-positions` is fetched by BOTH
  `useLpPnl` (`:1106`, for Capital G/L) AND `useWalletLevelFees` (`:546`, for Fee Income) on
  the same load, same address, **at the same time**. The route has **no `withActivityRouteCache`
  / in-flight dedup** (unlike the per-position activity routes). Both miss Redis (cold) → **both
  run the full 11 s–19 min scan concurrently**, doubling CU and Alchemy contention. Measured
  the race directly: a second request arriving mid-scan re-scanned (8.4 s) instead of hitting
  the not-yet-written cache; only after the fire-and-forget write landed did it drop to 0.5 s.
- **(3b) Writes are fire-and-forget** (don't block the response), so within the scan window
  every concurrent/retried request re-scans — compounding (3a).

If the scan never completes (§4), **nothing is ever cached**, so the wallet is slow *forever*,
not just on the first load.

## 4. Why it sometimes "never" resolves

Two distinct "never"s:

- **The spinner is not literally infinite** — every per-position fetch has a 150 s
  AbortController cap and always resolves (success, empty, or timeout → recorded as a result,
  removed from `inflight`). So `inflight` drains and the spinner clears in ≤ ⌈N/2⌉ × (150–300 s)
  — worst case ~5–10 min for a many-position single-endpoint wallet, which *feels* like never.
  (A timeout is NOT retried, by PERFORMANCE design, so no infinite retry loop.)
- **The Capital G/L number genuinely never completes for heavy Solana wallets.** The route has
  **no `maxDuration`** (`vercel.json` sets only crons; no `functions` block; no per-route
  `export const maxDuration`). Vercel applies the project default — for an unconfigured Next.js
  App Router function that's a low value (historically 15 s; the platform hard-max is 300 s Pro
  / 800 s with Fluid Active CPU). **A 19-minute scan cannot fit in ANY Vercel function limit,**
  so a heavy wallet's route is *architecturally guaranteed* to be killed (504) before it
  finishes → the client closed effect's plain `fetch` (no timeout) gets `!res.ok` → contributes
  nothing (graceful catch) → Capital G/L is missing the closed-Solana part → **and the scan
  never wrote its cache, so the next reload repeats the doomed scan.** That is the "waited 5+
  min, still nothing" for the Capital G/L figure. (Whether it's 15 s or 300 s only changes
  *which* wallets fail — the unbounded scan guarantees a failure threshold exists.)

## 5. Ranked fix plan (no pricing/correctness changes)

**Recommended combination: A + B + C — together they guarantee "some numbers in a few seconds,
closed data fills in progressively, never an endless spinner", AND make the heavy scan actually
complete + cache.** Ranked by leverage:

### (A) Kill the all-or-nothing render gate — progressive LP P&L aggregate  ⟵ fixes the spinner
Show the partial aggregate immediately with a subtle "computing N of M positions…" chip instead
of skeletoning every cell. The numbers are **already computed progressively** (every landed
fetch recomputes `aggregate()`), so this is a UI-only change: replace `lpPnl.isLoading ?
skeleton : value` with "render value always once `included > 0`; show a small inflight-count
sub-indicator while `inflight > 0`". Add a separate, softer "still scanning closed positions on
Solana/Sui" indicator driven by a new (non-blocking) closed-scan-in-progress flag.
- **Improvement:** first LP P&L numbers in ~1–4 s (matches PERFORMANCE's positions-table
  baseline) instead of 5 min. **Effort:** small (UI + expose an `inflightCount`/`closedLoading`
  from `useLpPnl`). **Risk:** low (display only). **Pricing:** untouched.

### (B) Make the heavy closed scan actually finish + cache  ⟵ fixes "never resolves"
1. **Set `maxDuration` to the platform max** on the closed routes (`export const maxDuration =
   300` in `app/api/{solana,sui}-closed-positions/route.ts`; consider enabling Fluid for 800 s)
   — necessary but NOT sufficient (19-min wallets still exceed it).
2. **Bound the scan + persist partial-then-continue.** Give the scan a wall-clock budget under
   `maxDuration`; if it can't finish, cache what it has as a partial with a "complete: false"
   marker (do NOT cache-as-final), and let a follow-up request resume. OR move the heavy scan to
   a background job (Vercel Cron / queue / `waitUntil`) that scans once and writes the cache, so
   the request path only ever reads Redis. **This is the real "never resolves" fix.**
3. **Add in-flight dedup + a short in-process cache to the closed routes** (mirror
   `withActivityRouteCache`) so the concurrent `useLpPnl` + `useWalletLevelFees` double-fetch
   collapses to ONE scan (fixes 3a/3b) — and make the client hooks share one fetch (dedup by
   URL like `useWalletLevelFees` already does internally).
- **Improvement:** Capital G/L completes + caches even for heavy wallets; first-scan CU halved
  (no double-scan). **Effort:** medium. **Risk:** medium (background-scan plumbing); the
  dedup + maxDuration parts are low-risk and high-value on their own. **Pricing:** untouched
  (same scan, same valuation).

### (C) Give the closed effects a client-side budget + non-blocking status  ⟵ UX guarantee
The `useLpPnl` closed-effect `fetch` has NO client timeout — a hung/slow route leaves Capital
G/L silently pending forever with no signal. Add a client budget (e.g. one patient attempt) and
surface a "closed-position data still loading for Solana" badge (never a blank spinner), so the
user always sees status. Pairs with (A)'s closed-scan indicator.
- **Improvement:** no silent infinite pending; clear UX. **Effort:** small. **Risk:** low.

### (D) Parallelize the scans — **not needed / already parallel.**
Investigated: the Sui and Solana closed effects are independent `useEffect`s (parallel), and
Orca+Raydium share ONE Solana scan. There is no cross-chain serialization to fix. Skip (D)
except as encompassed by (B3)'s dedup.

**Guarantee delivered by A+B+C:** a first-time wallet sees open-position Total Deposited /
Current Value / Fees within ~1–4 s (A), Capital G/L fills in as each chain's closed scan lands
with a visible per-chain status (A+C), the heavy Solana scan runs once in the background and
completes+caches (B), and the block NEVER shows an endless "calculating…" — worst case it shows
real partial numbers plus "still scanning Solana closed history…".

---

## Appendix — evidence

- Render gate: `analytics/page.tsx:1655–1822` (skeleton + "calculating…" on `lpPnl.isLoading`).
- `isLoading = inflight > 0`: `useLpPnl.ts:968`; `inflightRef` mutated only at `:1222`/`:1249`.
- Closed effects (don't touch `inflightRef`): `useLpPnl.ts:1048` (Sui), `:1090` (Solana).
- Double-fetch of closed route: `useLpPnl.ts:1106` + `useWalletLevelFees.ts:546`; route has no
  `withActivityRouteCache`/dedup.
- Per-position throttle: `MAX_PER_ENDPOINT = 2`, `paceByEndpoint` keyed by endpoint pathname.
- Fetch policy: `ATTEMPT_TIMEOUTS_MS = [150000, 150000]`, retry only on network/5xx (never
  timeout) — `useLpPnl.ts:520, isRetryableFailure`.
- No `maxDuration`: `vercel.json` (crons only), no `functions` block, no per-route export.
- Measured (local prod build, free Alchemy, real Upstash): solana-closed cold 11.2 s (128-tx)
  / warm 0.5 s / **19 min for 2,544-tx (Sprint RAYDIUM B7)**; sui-closed cold 17.8 s; write-race
  re-scan observed (8.4 s) before fire-and-forget write landed. Caching verified (both Redis
  sub-keys present post-scan). No routes modified; server stopped after measurement.
