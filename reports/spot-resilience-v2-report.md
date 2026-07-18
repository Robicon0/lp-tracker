# Sprint SPOT-RESILIENCE-V2 — Graceful degradation (per-position last-known-good)

**Status:** Phase A complete. Awaiting plan-gate approval before Phase B.

Core thesis (confirmed by the trace): a transient per-position load failure
today **deletes that position's contribution from every LP P&L total** and
raises an alarm banner. The numbers aren't miscalculated — positions are
silently removed from the calculation. This report traces the exact mechanism,
diagnoses the two named bugs from live evidence, and proposes a per-position
last-known-good (LKG) architecture so a transient failure degrades to STALE
(kept in totals) instead of EXCLUDED (dropped).

---

## Phase A §1 — The exclusion mechanism (traced end to end)

### The pipeline

1. **`PositionsContext`** ([app/contexts/PositionsContext.tsx](../app/contexts/PositionsContext.tsx))
   streams positions per `(source, address)` via `useQueries`. Each fetcher
   catches its own error and returns `[]` ([aerodrome.ts:8-12](../app/lib/aerodrome.ts#L8)).
   → A failed **dashboard** fetch means the position simply never appears (no
   banner) — but the DEEP/SUI and WETH/USDC positions DO appear, so their
   dashboard routes succeed. The failure is one layer down.

2. **`useLpPnl`** ([app/hooks/useLpPnl.ts](../app/hooks/useLpPnl.ts)) takes the
   positions array and, per eligible position, fetches its **activity route**
   (`buildActivityUrl` → `/api/{protocol}/activity`) inside `fetchAndCompute`
   ([useLpPnl.ts:656](../app/hooks/useLpPnl.ts#L656)) to reconstruct deposit
   history, then runs `computePositionPnL`.

3. **Failure classification in `aggregate()`**
   ([useLpPnl.ts:940-954](../app/hooks/useLpPnl.ts#L940)):
   - Transport errors (`timeout`, `fetch error`, `HTTP 5xx`, `no activity URL`)
     → `errored++` → **red** banner *"Couldn't load N positions — The RPC
     didn't respond in 30s"* ([analytics/page.tsx:2090](../app/analytics/page.tsx#L2090)).
   - Data failures (`no_deposits`, `missing_deposit_prices`,
     `missing_current_prices`, `value_overflow`) → `excluded++` → **orange**
     banner *"N positions … excluded from totals"*
     ([analytics/page.tsx:2008](../app/analytics/page.tsx#L2008)).
   - **Either way the position contributes `$0`** to Total Deposited, Current
     Value, Fees Unclaimed, IL, and Capital G/L. It is removed from the sums at
     [useLpPnl.ts:874-955](../app/hooks/useLpPnl.ts#L874) simply by never being
     added.

### What data is lost when a position is excluded

| Total | Lost contribution |
|---|---|
| Total Deposited | `d.initialValue` (open) |
| Current Value | `d.currentValue` (open) |
| Fees Unclaimed | `d.feesUnclaimed` (open) |
| Imperm. Loss | `d.ilUSD` (open) |
| Capital G/L | `d.closingValue − d.initialValue` (closed, whitelisted chains) |
| Fees Collected | `d.feesCollected` (all) |
| Net P&L | derived from all of the above |

So one WETH/USDC Aerodrome timeout silently drops that position's deposit
basis, current value, unclaimed fees and IL out of the headline — the totals
are **complete-looking but wrong**.

### Existing caching (what could serve as LKG — and why it doesn't today)

| Layer | Stores | Gap for our purpose |
|---|---|---|
| `lp-pnl-events-v27-{posId}` localStorage ([useLpPnl.ts:474](../app/hooks/useLpPnl.ts#L474)) | **raw on-chain events** (5 min success / 60 s empty) | (a) **transport errors are NEVER cached** (`cacheable:false` at [useLpPnl.ts:652](../app/hooks/useLpPnl.ts#L652)) so a timeout has nothing to fall back to; (b) caches events, not the computed P&L; (c) per-browser only |
| `analyticsSnapshot` Redis ([app/lib/analyticsSnapshot.ts](../app/lib/analyticsSnapshot.ts)) | **aggregate output only** (7 LP P&L numbers + header + fee income) | all-or-nothing at portfolio granularity — no per-position rows, can't do partial degradation |
| `closed_pos_{sui,solana}_v1` Redis | reconstructed **closed** positions | immutable-ledger only; doesn't cover open-position transient failures |

**The INSTANT-LOAD snapshot is already a coarse graceful-degradation layer:**
`useSnap = snapshot && !liveTrustworthy`, where
`liveTrustworthy = pipelineSettled && lpPnlLive.errored === 0`
([analytics/page.tsx:994-998](../app/analytics/page.tsx#L994)). If the live
pipeline settles **with even one errored position**, the entire last-clean
snapshot is shown instead. This is real protection — but:
- it needs a ≤24 h clean snapshot to exist (first visit / >24 h → raw error
  banners + wrong totals);
- it is **all-or-nothing**: one bad position discards the *entire* live
  aggregate and shows the *entire* snapshot — you can't keep 9 live positions
  and 1 stale;
- it stores **no per-position data**, so it can't repopulate individual rows.

**The missing piece is exactly what the prompt names: per-position LKG.**

---

## Phase A §2 — The two specific bugs

### Bug A — WETH/USDC (Aerodrome · Base) "RPC timeout after 3 attempts"

**Root cause: the Aerodrome activity route's `eth_getLogs` fallback ladder has
rotted, and `rpcPost` has no per-call timeout — so when the primary hangs, the
server hangs until the client's 150 s abort fires → `reason:"timeout"` →
errored → excluded.**

Live canary (read-only, run this session) of the exact full-range
`eth_getLogs` the route issues ([aerodrome/activity/route.ts:177-236](../app/api/aerodrome/activity/route.ts#L177)):

| Endpoint (route tier) | Result |
|---|---|
| Tenderly `base.gateway.tenderly.co` (Tier 1) | 1st call **14.0 s** OK, next two **timed out at 20 s** (`http=000`) |
| LlamaRPC `base.llamarpc.com` (Tier 2) | **`error code: 521`** (Cloudflare "web server is down") — dead |
| publicnode `base-rpc.publicnode.com` (Tier 3/4) | **`403 Archive requests require a personal token`** — paywalled |

So under a real analytics load (several Aerodrome positions + the wallet-scope
`positionId=all` ever-owned scan, all firing at Tenderly concurrently from
Vercel's shared datacenter IP), Tier 1 tips past its ~14 s edge into timeouts,
and **both fallback tiers are non-functional**. The route's own `rpcPost`
([aerodrome/activity/route.ts:114](../app/api/aerodrome/activity/route.ts#L114))
has **no `AbortController`/timeout**, so a hung Tenderly call blocks the whole
route — the "RPC timeout after 3 attempts" the user sees is the *client's* 150 s
fetch giving up on a server that's stuck waiting on a dead RPC.

This is the **same class** as Sprint SUI-RPC-RELIABILITY (`8d82287`): a single
flaky endpoint hit concurrently with no robust failover, timeout, or pacing.
The fix is the same pattern — a shared paced+failover EVM `eth_getLogs` client
mirroring [app/lib/suiRpc.ts](../app/lib/suiRpc.ts), with a per-call timeout,
Alchemy (reliable, already the route's block-number provider) added as a real
tier, and healthy fallbacks. **Even after the RPC fix, per-position LKG (Part 1)
guarantees a future EVM flake can't corrupt totals.**

### Bug B — DEEP/SUI (Cetus · Sui) "No deposit events found on-chain"

**Reason is `no_deposits`** (maps to that string at
[useLpPnl.ts:107](../app/hooks/useLpPnl.ts#L107)). This is a **compute** failure,
not a transport one: the Cetus activity route returned HTTP-OK with events, but
`computePositionPnL` found **zero `AddLiquidity` events for this position id**
([positionPnl.ts:119](../app/lib/positionPnl.ts#L119)). Two code-level root-cause
candidates, both in [app/api/cetus/activity/route.ts](../app/api/cetus/activity/route.ts):

1. **Discovery filter is `FromAddress`-only.**
   `fetchAllDigests` queries `suix_queryTransactionBlocks` with
   `filter:{ FromAddress: account }`
   ([cetus/activity/route.ts:172-177](../app/api/cetus/activity/route.ts#L172)).
   That returns **only transactions signed by the account**. A Cetus position
   opened via a router/aggregator, a smart/multisig wallet, or **transferred in**
   has its `AddLiquidity` event under a tx whose `FromAddress` is *not* this
   account → the deposit tx is never fetched → `no_deposits`. Sui's
   `queryTransactionBlocks` supports `FromOrToAddress` / `InputObject` /
   `ChangedObject` filters that would surface it.

2. **Silent partial-scan truncation.**
   `fetchAllDigests` does `if (!result) break;`
   ([cetus/activity/route.ts:179](../app/api/cetus/activity/route.ts#L179)) and
   `fetchTransactionEvents` does `if (txBlocks) results.push(...)`
   ([cetus/activity/route.ts:205](../app/api/cetus/activity/route.ts#L205)). Since
   `suiRpc` returns `undefined` when all endpoints fail a page/batch under load,
   a dropped page **silently truncates** the digest list and a dropped
   multiGet batch **silently drops** those events — if the truncated slice held
   the deposit, the result is a false `no_deposits`. Same "silent partial scan"
   family as the Sui reliability bug.

**Honesty note:** confirming *which* candidate (or both) requires the live
Account 3 Sui address + the DEEP position id, which aren't in the repo's
verification set (CLAUDE.md lists only Account 1 `0xdc…c30d` and Account 2
`0x8ef8…`). The fix below is robust to either. Critically, because the DEEP/SUI
position **does** render on the dashboard (its `/api/cetus` route succeeds with a
live `pos.value`), the position has usable live data even when its deposit
history can't be found — so it should degrade to STALE/estimated, never vanish.

---

## Phase A §3 — Proposed architecture: per-position graceful degradation

### Status model (per position)

| Status | Condition | Totals | UI |
|---|---|---|---|
| **LIVE** | fresh successful load this session | included (fresh) | default, no indicator |
| **STALE** | this load failed (transport **or** data) **and** an LKG computed result exists | **included** (cached values) | subtle grey *"last updated N min ago"* on the row/detail |
| **NEVER-LOADED** | this load failed **and** no LKG exists | excluded **unless** a live `pos.value>0` fallback applies | the ONLY case that shows the excluded notice; should be near-empty |

The red *"Couldn't load N positions"* banner is **deleted** — it was the symptom
of the flaw; with LKG there is no data to lose on a timeout.

### Part 1 — Per-position LKG cache

- **Stores the computed `PositionPnLData`** (exactly what `computePositionPnL`
  returns and what flows into the sums) — NOT raw events. Caching the computed
  result is what makes a failed load serve byte-identical last-good totals.
  Scope-lock honoured: it's a cache of the same values, never a new calculation.
- **Written** on every successful `fetchAndCompute` (open + EVM/Sui/Solana
  closed), keyed by `pos.id` (already unique per chain+protocol: `aero-…`,
  `cetus-…`, `solana-closed-…`).
- **Read** in `aggregate()` before a `{ok:false}` result is bucketed as
  excluded/errored: LKG hit → contribute cached values, tag the position STALE
  (new `stalePositions` list) instead of excluded.
- **Two tiers**, reusing existing contracts:
  - **localStorage** `lp-pnl-lkg-v1-{posId}` (per-browser, instant, no network)
    — the primary path; covers the timeout case the events cache misses.
  - **Redis via the snapshot** (Part 4) — cross-instance/cross-device cold-load
    repopulation.
- **Staleness of the current-value field:** the immutable parts (deposit basis,
  historical IL, claimed fees) never age; only `currentValue` drifts. On STALE we
  can **recompute `currentValue` from the live `pos.value`** (the dashboard
  positions array refreshes independently of the activity route) while keeping the
  cached historical basis — so a history-fetch failure still shows a *fresh*
  current value. **Open design decision below.**

### Part 2 — Bug A fix (shared EVM getLogs client)

New `app/lib/evmRpc.ts` mirroring `suiRpc.ts`: ordered per-chain endpoints
(Alchemy-chunked + Tenderly + additional healthy nodes), per-call
`AbortController` timeout (fixes the no-timeout hang directly), automatic
failover, global pacing semaphore. Wire the Aerodrome activity route through it
first (the reproduced failure); the pattern is then available to
velodrome/uniswap/pancakeswap. **Open decision: fix Aerodrome only now, or the
whole EVM set.**

### Part 3 — Bug B fix (Cetus deposit discovery)

Broaden discovery beyond `FromAddress` (add `FromOrToAddress` / the position
object as `InputObject`/`ChangedObject`) so router-opened / received positions
are found, and make the scan **fail-loud on partial** (detect a dropped
page/batch and retry-or-mark-incomplete rather than silently returning
`no_deposits`). If the deposit still can't be found, degrade to STALE /
value-proxy — never excluded.

### Part 4 — Snapshot carries per-position data

Extend `AnalyticsSnapshot` with `perPosition` (bump `v` → 2 so old snapshots are
ignored, never mis-rendered). The write already fires only on a clean settle;
adding per-position rows lets a cold cross-device load repopulate the LKG map and
individual rows even with zero live RPC success.

### Scope lock

No pricing/valuation/fee/Capital-G-L formula changes. LKG stores the identical
computed values the live path produced; byte-identity with a fresh successful
load holds by construction.

---

## Phase A §4 — Verification plan (for Phase B / B7)

- **B** *(degradation proof)* — simulate an Aerodrome timeout; confirm the
  position shows STALE, stays in totals, totals identical with vs without the
  simulated failure; no red/"couldn't load" banner.
- **C/D** *(bug fixes)* — WETH/USDC Aerodrome loads via the new client; DEEP/SUI
  Cetus finds its deposit (or degrades to STALE with live value).
- **E** *(snapshot)* — cleared snapshot rebuilds with per-position data; restore
  repopulates rows.
- **F** *(no regression)* — all accounts' totals identical to a clean fresh
  compute; Account 2 identical; closed positions / Fee Income / pricing untouched.
- **A/G** — `tsc` + build clean; professional-review architecture writeup.

---

## Plan-gate decisions (approved)

1. **STALE current-value policy** → **Live current value.** On STALE, recompute
   `currentValue` (and `feesUnclaimed`) from the fresh dashboard `pos.value` /
   `pos.fees`, keep the cached historical basis (deposit / IL / claimed fees).
2. **Bug A RPC-fix scope** → **Aerodrome only.** Build the shared paced+timeout
   EVM client and wire the `aerodrome/activity` route (the reproduced failure);
   pattern available for velodrome/uniswap/pancakeswap later.
3. **NEVER-LOADED fallback** → **Extend value-as-deposit proxy to all chains.**
   A never-loaded position with a live `pos.value>0` uses the existing
   `buildFallbackPnL` estimate (kept in totals, flagged "estimated") instead of
   vanishing.

---

## Phase B — implementation (complete; awaiting B7 approval to commit)

| Part | File(s) | What shipped |
|---|---|---|
| **1. Per-position LKG** | [app/hooks/useLpPnl.ts](../app/hooks/useLpPnl.ts) | `lkgGet`/`lkgSet` (`lp-pnl-lkg-v1-{posId}`) store the computed `PositionPnLData` on every genuine success. New `degradeOnFailure()` funnel: every failure return degrades to **STALE** (LKG hit → kept in totals, live current value refreshed) → **ESTIMATED** (value-proxy, all chains) → **EXCLUDED** (never-loaded, no value). New `stalePositions[]` on the result; `PosResult` carries `stale`. |
| **2. Bug A** | [app/lib/evmRpc.ts](../app/lib/evmRpc.ts) (new), [app/api/aerodrome/activity/route.ts](../app/api/aerodrome/activity/route.ts) | `evmRpcPost` = per-call `AbortController` timeout (12 s) + global concurrency semaphore (6), mirroring `suiRpc.ts`. `rpcPost` delegates to it; `fetchLogs` falls a hung/errored full-range Tenderly call into a **paced chunked Tenderly scan** (Tier 1b) before the dead legacy tiers. |
| **3. Bug B** | [app/api/cetus/activity/route.ts](../app/api/cetus/activity/route.ts) | `fetchDigestsByFilter` **fails loud** (one retry, then throw → 500 → client STALE) instead of silently truncating. `fetchScanDigests` unions `FromAddress` with `ChangedObject: positionId` (per-position) so router-opened / received deposits are found. |
| **4. Banners** | [app/analytics/page.tsx](../app/analytics/page.tsx) | Red *"Couldn't load N positions"* banner **deleted**. New subtle grey *"N positions showing last-known values … included in totals"* note. Orange excluded banner now only ever lists NEVER-LOADED positions. |
| **5. Snapshot v2** | [app/lib/analyticsSnapshot.ts](../app/lib/analyticsSnapshot.ts), [app/analytics/page.tsx](../app/analytics/page.tsx) | `v:2` carries `perPosition` (LKG map). Read seeds the client LKG (`seedLkgFromSnapshot`) before the first live compute; write includes it (`collectLkgEntries`) and is gated on a FULLY-LIVE settle (`stalePositions.length === 0`). |

## Phase B §7 — Verification (all headless, prod-mode server + real wallets)

| Check | Result |
|---|---|
| **A** tsc + build | `tsc --noEmit` exit 0; `next build` **✓ Compiled successfully**, exit 0. |
| **B** degradation proof | `scripts/spot-resilience-v2-degrade-canary.ts` against the real `computePositionPnL`: a successful load's LKG, then a simulated failure → STALE, yields **byte-identical** per-position fields AND aggregate totals (initial/current/fees/IL/**netPnl** all `Object.is`-equal). **RESULT: PASS.** |
| **C** Bug A fixed | Live `aero-71749148` (WETH/USDC, $9,244.85). Server log: `Tenderly full-range error: -32000 evm-rpc-timeout` → `chunked scan: 13 chunks … rpc=…tenderly…` → `→ 5 logs`. **The exact Bug A timeout reproduced AND transparently recovered in one request** (27.6 s, well under the 150 s client budget); returned 1 deposit + 4 fee claims ($92.85). Before: that hang blocked 150 s and dropped the position. |
| **D** Bug B path | Live Account 2 Cetus USDC/SUI ($26,969.50) through the new `FromAddress ∪ ChangedObject` fail-loud discovery: **deposit found**, initial $24,909.69, 10 events, no error — regression-clean. (The specific DEEP/SUI *rescue* needs the live Account 3 wallet to confirm which candidate root cause bit; the new path executes, dedups, and doesn't regress the FromAddress-findable case. LKG covers DEEP/SUI once it has loaded once.) |
| **E** snapshot carries positions | `v:2` POST (with `perPosition`) → GET → **byte-identical round-trip**; `perPosition` key preserved. |
| **F** no regression | The STALE / value-proxy / excluded paths are **failure-only** (all reached via `degradeOnFailure`, only from a `{ok:false}` return); a clean compute takes the unchanged `ok:true` path, so a fully-successful fresh compute is byte-identical to pre-sprint. Verified live: Account 2 Cetus deposit $24,909.69 and Aerodrome fee $92.85 computed through the untouched success path. Account 2 (clean) selectors unchanged. Closed positions / Fee Income / pricing formulas untouched. |
| **G** review writeup | Below. |

**Honesty notes.** (1) Bug B's DEEP/SUI-specific rescue is verified *structurally* (the object-scoped + fail-loud path runs and doesn't regress) but not against the live Account 3 wallet, which isn't in the repo's verification set — consistent with prior sprints' "structural-only where live data was unavailable" pattern. (2) The visual STALE indicator / absence of the red banner is verified at the data/logic level (the banner is deleted; `stalePositions` drives the new note); an eyeball on the deploy confirms the pixels. (3) A single throwaway snapshot key (`test:spot-resilience-v2-canary`) was written to the shared Upstash DB for the round-trip test; it carries the standard 24 h TTL and cannot collide with a real wallet hash.

## Phase B §G — Professional-review architecture writeup

A developer reviewing the position-loading pipeline would see:

- **Streaming, independent loads.** `PositionsContext` runs one React Query per
  `(source, wallet)`; each fetcher catches and returns `[]`. `useLpPnl` then loads
  each position's activity/P&L independently and aggregates incrementally
  (progressive render, Rule 10).
- **A single failure funnel with a three-state model.** Every failure path in
  `fetchAndCompute` routes through `degradeOnFailure(pos, reason, events?)`, which
  resolves to exactly one of **LIVE** (success, on the happy path) / **STALE**
  (last-known-good from the per-position LKG cache, kept in totals) / **ESTIMATED**
  (value-proxy when there's a live value but no history) / **EXCLUDED**
  (never-loaded with no value — the only state removed from totals). A transient
  RPC/parse failure can no longer silently delete a position's contribution.
- **The LKG cache is a cache of computed OUTPUT, not a new calculation.** It stores
  the exact `PositionPnLData` the pure `computePositionPnL` produced, written only
  from genuine successes; STALE reuse is therefore byte-identical to the last good
  compute (proven in B7-B), with only the live-sourced `currentValue`/`feesUnclaimed`
  refreshed from the fresh dashboard position. localStorage is the per-browser
  tier; the analytics snapshot (`v:2` `perPosition`) is the cross-instance tier that
  seeds it on a cold device.
- **Transport hardened at the root.** EVM `eth_getLogs` (Bug A) and Sui reads
  (existing `suiRpc`) both go through a shared client with a per-call timeout +
  concurrency semaphore + failover — a hung endpoint fails fast into a fallback
  instead of blocking until the client abort. This is the reliability layer;
  per-position LKG is the safety net for whatever still slips through.
- **Honest, non-alarming surfacing.** No data loss → no red "couldn't load" alarm.
  STALE is a subtle "last-known values" note; EXCLUDED (genuinely never-loaded) is
  the only case that warns, and it's rare by construction.

The property a reviewer would check — *"for a brand-new wallet with significant
history and no warm cache, do the totals ever silently drop a position on a
transient failure?"* — now holds: they degrade to STALE (if ever loaded) or an
estimate (if a live value exists), and only a genuinely-never-loaded, valueless
position is excluded.

---

### Bug A — endpoint reality (refined after live canaries)

Alchemy free tier caps `eth_getLogs` at a **10-block range**; drpc/base.org
reject sub-10k chunks on free tier; Llama is `521`-down; publicnode is
`403`-paywalled. **Tenderly is the only healthy endpoint** — full-range works
but hangs under repeat concurrent load (14 s then 20 s timeouts), while
**chunked Tenderly calls are fast (0.3–0.7 s each)**. Root cause confirmed: the
route's `rpcPost` has **no per-call timeout**, so a hung full-range Tenderly
call blocks the whole route until the client's 150 s abort. Fix: shared
paced+timeout EVM client (`app/lib/evmRpc.ts`, mirroring `suiRpc.ts`); a hung /
errored full-range Tenderly call now fails fast (12 s) and falls into a
**paced, per-call-timed chunked Tenderly scan** (the dead Llama/publicnode tiers
demoted to last-ditch, harmless behind the timeout).
