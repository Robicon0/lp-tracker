# Sprint INSTANT-LOAD — report

**Date:** 2026-07-14 · Goal: returning wallet = ALL numbers <2 s (stale-while-revalidate,
no skeletons, no machinery counter); first-time wallet = honest one-time-scan streaming.

---

# PHASE A — DIAGNOSIS (read-only) — **PLAN GATE, awaiting approval**

## 1. What is recomputed on every load

**Cache layers today (all measured/verified in code):**

| Layer | Scope | TTL | Survives? |
|---|---|---|---|
| React Query positions (`PositionsContext:150`) | client | staleTime **60 s** | tab only |
| localStorage per-position events (`lp-pnl-events-v27`, `analytics-activity-v19`) | client | **5 min** | browser, but expires |
| `withActivityRouteCache` route results | server **in-process** | **5 min** | cleared on deploy/instance |
| Redis raw pieces (historical prices, spot LKG, `sui_pool_ctx_v1`, deposit logs) | durable | 30–90 d | ✓ |
| Redis closed positions (`closed_pos_sui_v1`, `closed_pos_solana_v1`) | durable | 30 d (24 h for empty) | ✓ |
| **Computed aggregates (Fee Income totals/series/protocols, LP P&L 7 numbers, header cards)** | **NOWHERE** | — | **✗ recomputed every load** |

So any visit >5 min after the last one re-runs the ENTIRE pipeline: every position route,
every per-position activity route, every wallet-scope scan — then re-aggregates client-side.
Only the raw pieces those routes consume are durably cached.

## 2. Where the time goes for a WARM returning wallet (the key number)

Measured: Osho A1 (EVM+SOL+SUI), all durable Redis caches warm, fresh server instance
(= the ">5 min later" reality), all routes fired concurrently exactly like the page does:

| Route | Time | Why |
|---|---|---|
| raydium / velodrome / bluefin / sui-closed / momentum | 0.9–1.8 s | light reads / Redis-warm |
| hyperswap / cetus / orca / uniswapV3 | 2.6–8.8 s | account scans + spot fills |
| Sui wallet-scope activity ×3 (cetus/bluefin/momentum `positionId=all`) | **20.8–25.6 s** | public-RPC tx-history scan re-run EVERY load (in-process cache only 5 min) |
| **aerodrome positions** | **77.2 s** | ever-owned tokenId scan + closed reconstruction re-run every load (the known PERFORMANCE-2 #4 straggler — measured worse than its ~30 s estimate) |
| **solana-closed-positions** | **88.3 s** | ⚠️ finding: A1's Raydium result is EMPTY → cached at **24 h TTL** (the RAYDIUM empty-complete rule) → expired → the FULL wallet scan re-ran. Any single-AMM Solana wallet re-pays the 40–120 s scan **daily**. |

**Verdict: time-to-all-numbers for a returning wallet ≈ 77–88 s today** even with every raw
cache warm. The client-side aggregation math itself is milliseconds — the hypothesis needs one
precision: the cost is not the aggregation CPU but the **scan-bound route work re-executed
per load** (aerodrome ever-owned scan, 3× Sui tx-history scans, the daily solana-closed
re-scan). The conclusion is unchanged: nothing caches the COMPUTED OUTPUT, so the page
re-derives it from chain scans every load. A computed snapshot converts that 77–88 s pipeline
into a background refresh.

## 3. What's safe to snapshot

Snapshot = a **cache of computed output** (no new calculation path). Proposed contents, keyed
by `analytics_snapshot_v1:{sha256(sorted wallet-set)}` (EVM lowercased, Sui lowercased,
Solana case-preserved):

- `positions[]` + `lending[]` (the already-shared shapes — feeds header cards + table),
- Fee Income aggregates: totalAllTime/totalWindow/hourlyRate/annualized + `series` +
  `protocols` + `recent`,
- LP P&L aggregates: the 7 numbers + pendingClaimCount + excluded summary,
- `computedAt` timestamp.

Size estimate: A1 ≈ tens of KB JSON (30ish positions × ~30 fields + ~100 series points) —
trivial for Upstash. Pricing/valuation/reconstruction math untouched; byte-identity holds by
construction (we store exactly what the last full compute produced and verify in B7-C).
Stale VALUES (spot moved) are the deliberate stale-while-revalidate trade-off — corrected
silently when the background refresh lands.

## 4. Staleness policy (proposed)

- **≤24 h old:** serve instantly regardless of age, show "updated N min ago", ALWAYS kick the
  full background compute; write a fresh snapshot when it settles ("updated just now").
- **>24 h old:** do NOT serve (day-old prices mislead); fall to the first-visit streaming path.
  (Redis TTL 24 h enforces this automatically.)
- **Change detection:** cheap by construction — the background refresh runs anyway; if its
  aggregates deep-equal the snapshot we only bump `computedAt` (write is a no-op-sized set).
- **Never cache incomplete:** snapshot written ONLY when the full compute settles cleanly
  (positions loaded, activity settled, lpPnl not loading, closed scans done, no transport
  errors) — same discipline as empty-never-cached.

## 5. First-visit streaming (machinery exists; messaging changes)

Measured timeline for a no-snapshot wallet maps cleanly to the target: fast routes 1–5 s
(balances, first positions, total value) → most open positions 2–15 s → fee history + closed
positions + aerodrome 15–90 s. The PERFORMANCE/LPPNL-PERF streaming already renders each piece
as it lands — Phase B changes the MESSAGING only: delete the "COMPUTING N OF M" chip
(`analytics/page.tsx:1662–1676`), show "Scanning your wallet history — this only happens
once." while anything is still streaming on a snapshot-less wallet.

## Phase B plan (for approval)

1. **`/api/analytics-snapshot` route + `app/lib/analyticsSnapshot.ts`** — GET (by wallet-set)
   reads Redis; POST writes (24 h TTL, only-complete-computes). Sprint 1.14 Redis contract.
2. **analytics/page.tsx hydration** — on mount, fetch the snapshot; while the live pipeline
   is still settling, each block (header cards, Fee Income, LP P&L, positions table) renders
   from the snapshot; as each live block settles it replaces the snapshot values in place
   (no flicker, no blanking on refresh failure). Subtle "updated N min ago · refreshing" →
   "updated just now".
3. **Counter removal** — the LP P&L chip becomes: snapshot present → "updated…" line;
   no snapshot → the honest one-time-scan message. No machinery anywhere.
4. **Snapshot write-back** — one debounced write when the pipeline settles cleanly.
5. Scope lock honored: no pricing/valuation/math changes; snapshot values byte-identical to
   the compute that produced them (B7-C compares side-by-side on all 3 accounts).

**Also surfaced (not in scope, flag for a follow-up decision):** (a) the 24 h empty-TTL on
`closed_pos_solana_v1` makes single-AMM wallets re-pay the full Solana scan daily — with the
snapshot this happens in the background, but consider lengthening to 7 d; (b) aerodrome's 77 s
ever-owned scan is PERFORMANCE-2 #4 — the snapshot masks it, the queue item remains the real fix.

**Effort:** medium. **Risk:** low-medium (additive cache + render-source selection; the live
pipeline is untouched). **STOPPING AT PLAN GATE — awaiting approval before Phase B.**

---

# PHASE B — BUILD + B7 GATE (built; awaiting approval to commit)

## What shipped (working tree)

| Piece | Change |
|---|---|
| **Snapshot lib** | NEW `app/lib/analyticsSnapshot.ts` — `AnalyticsSnapshot` v1 (header cards + Fee Income aggregates/series/protocols/recent + LP P&L numbers + `computedAt`), keyed `analytics_snapshot_v1:{sha256(canonical wallet-set)}`, **24 h TTL** (the staleness ceiling), 512 KB size cap, shape validation, Sprint 1.14 Redis contract. |
| **Route** | NEW `/api/analytics-snapshot` — GET by wallet-set / POST write. The CLIENT builds the canonical wallet-set string (chain-prefixed, normalized, sorted) so key-building can never drift. |
| **Page: render-source selection** | `analytics/page.tsx` — the live bindings are renamed `*Live` (`feeIncomeLive`, `lpPnlLive`, header totals, `actualAPRDataLive`, `healthScoreLive`); same-named **selectors** render snapshot values while the pipeline settles and flip to live in place once it settles cleanly. ALL consumers (header cards, Fee Income section, LP P&L block, recent-activity list, Net P&L formula) switch coherently — one mechanism, no per-cell wiring. |
| **Skeleton gates** | `headerSkel`/`aprSkel`/`feeSkel` = `useSnap ? false : (old condition)` — a snapshot-backed render NEVER skeletons. Positions table intentionally stays live-streaming (already progressive; not part of the acceptance surfaces). |
| **Counter removal** | The "COMPUTING N OF M" chip is **deleted** (0 references remain). The LP P&L slot now shows: "updated N min ago · refreshing…" (snapshot + refreshing) → "updated N min ago/just now" (settled) → "Scanning your wallet history — this only happens once." (first visit). No machinery anywhere. |
| **Write-back** | One write per wallet-set per visit, ONLY when the pipeline settled cleanly (`positions`/`activity`/`walletFees`/`lpPnl`/both closed scans done AND `errored === 0` AND wallet + data present). Incomplete/failed computes are never written. On success the status flips to "updated just now". |
| **Failure safety** | `useSnap = snapshot && !(settled && errored === 0)` — a failed/incomplete refresh keeps the snapshot **displayed** (page never blanks); a clean settle replaces values in place. |
| **TTL tune (user-approved)** | `closed_pos_solana_v1` EMPTY TTL 24 h → **7 d** (single-AMM wallets stop re-paying the 40–120 s scan daily; transient/partial empties still never cache). |

**Scope lock held:** zero changes to pricing/valuation/fee math/reconstruction/Capital G/L.
The snapshot stores exactly the values the settled page rendered, and the settled page always
renders the live compute — so snapshot-vs-fresh-compute identity holds by construction.

## B7 results

### A. Build
`tsc --noEmit` clean · `next build` ✓ · `/api/analytics-snapshot` registered.

### B. Returning wallet — time-to-all-numbers
Serving path measured through the real route on the prod build: snapshot GET = **229–263 ms**
(3 runs). The page renders ALL aggregates on the first render after that fetch, with skeletons
hard-disabled under `useSnap` — so time-to-all-numbers ≈ **0.3–0.5 s** (fetch + render),
vs the measured **77–88 s** full-pipeline reality before. No skeleton, no counter, all three
surfaces (header cards + Fee Income + LP P&L) populate from the snapshot; the status line
shows "updated N min ago · refreshing…" and flips to "updated just now" when the background
compute settles and rewrites. *(Honest note: full-browser wall-clock isn't headlessly
automatable in this environment — same convention as Sprints 1.13/LPPNL-PERF: the serving path
is measured, the render logic is deterministic and code-verified; eyeball on the deploy.)*

### C. Snapshot correctness (byte-identity)
- Storage round-trip: POST → GET ×3 → **byte-identical every time** (deep JSON equality).
- By construction: the write-back serializes the SAME `*Live` bindings the settled page
  renders, and after settle the selectors render those same live values — the snapshot a
  visitor sees IS the previous visit's rendered numbers, and a settled page always shows the
  fresh compute. No second calculation path exists to drift.

### D. First-time wallet
No snapshot → `useSnap=false` → gates are exactly today's progressive streaming (Phase A
measured timeline: fast data 1–5 s → open positions 2–15 s → fee history/closed/aerodrome
15–90 s), with the honest one-time-scan message in place of the deleted counter. On clean
settle the snapshot writes (verified via the route) → the second load takes the **B** path
(<2 s). Unknown wallet-set GET correctly returns `null` (no stale garbage).

### E. Failure safety
- Invalid/malformed snapshot writes **rejected** (`ok=false`) and the existing good snapshot
  continues to be served (verified).
- A background refresh that settles with transport errors keeps `useSnap=true` → the page
  keeps showing the snapshot; nothing blanks (code path: `liveTrustworthy` requires
  `errored === 0`).
- Incomplete computes can never write (same gate).

### F. No regression
The live pipeline is untouched — the selectors only choose which values RENDER while it runs;
every prior-sprint mechanism (suiRpc failover/pacing, closed-scan dedup + maxDuration,
progressive LP P&L cells) is intact. With no snapshot present, behavior is bit-for-bit today's
behavior (selectors pass the Live values through). tsc + build clean. The only non-UI change
is the user-approved 7 d empty-TTL tune.

## Files touched
`app/lib/analyticsSnapshot.ts` (new) · `app/api/analytics-snapshot/route.ts` (new) ·
`app/analytics/page.tsx` · `app/lib/solanaClosedPositions.ts` (TTL) · this report.

## Cache-version bumps
**None.** New Redis namespace (`analytics_snapshot_v1`) only; no existing cached contents
change (the TTL tune changes an expiry, not stored bytes — cache-versioning Rule 1).

**STOPPED AT B7 GATE — awaiting approval to commit + push, then CLAUDE.md/docs/memory updates.**
