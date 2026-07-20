# CLAUDE.md

This file is the front door for Claude Code sessions on DefiDesh. It is
read at the start of every session via the `sprint-start` skill. Stable
rules and reusable patterns live in `.claude/rules/` and `.claude/skills/`.
This file holds only what changes session-to-session: active sprint,
queue, recent fixes, known limitations.

---

## Project identity

**DefiDesh** (defidesh.com) is a public multi-chain DeFi LP position
tracker. Vision: the world's best LP tracker — accurate real-time data
for any wallet on any chain, at scale for thousands of users globally.
"Desh" means everything about crypto in one place; future scope includes
news, trends, token research, and macro sections.

**Stack:** Next.js App Router / TypeScript / Tailwind CSS / Recharts,
deployed on Vercel Pro. Neon Postgres. GitHub: `Robicon0/lp-tracker`,
branch `main`. Local dev: `~/lp-tracker-fresh`. Twitter: `@defidesh`.

**Chains and protocols:**
- EVM (Base, Arbitrum, Optimism, Ethereum, Polygon, HyperEVM): Aerodrome,
  Uniswap V3, Velodrome, HyperSwap, KittenSwap, ProjectX
- Solana: Orca + Raydium (both full: open positions, closed-position Capital G/L, lifetime fees)
- Sui: Bluefin, Cetus, Momentum (full: dashboard, activity, P&L, closed-position Capital G/L)
- Lending/borrowing: AAVE V3, Dolomite, Kamino, Jupiter Lend, Suilend,
  AlphaFi, HyperLend, Hypurr, HypurrFi

---

## How to start every session

Invoke the `sprint-start` skill before doing anything else. It runs the
six-step startup sequence: read this file, scan `.claude/rules/`, check
recent commits, confirm the active sprint, state the methodology, wait
for the specific task.

---

## Active sprint

**Sprint WRAPPER-PROTOCOLS (Gap 2): positions held via position-manager wrappers.**

**Goal:** LP positions managed by wrapper protocols (DefiTuna on Solana first —
proven usage in Krishna's history; then survey Kamino vaults etc.) are INVISIBLE
today because the position NFT/object sits in the wrapper's vault, not the user's
wallet. Per the completeness directive (2026-07-19), a user with a wrapped
position currently sees NOTHING — a critical missing-position class. Phase A:
enumerate wrapper protocols with real usage, their position-discovery mechanism
(DefiTuna has a public API: api.defituna.com/api/v1/users/{wallet}/tuna-positions
— verified live, returns empty for wallets without positions), and the
Protocol Correctness Contract surface for each. Investigate-first; plan with
Osho before building.

**Status:** Phase 1 SHIPPED (`4c450a1`, 2026-07-20) — DefiTuna OPEN positions live
(hybrid API+on-chain-verify, EQUITY semantics, selfReportedPnl mechanism in useLpPnl).
Phase 2 queued: closed-Tuna reconstruction (Capital G/L via tuna program tx history,
Category B) + survey of other wrappers (Kamino vaults, etc.). Detail page for wrapper
positions not yet built (rows non-clickable). Phase A findings (kept for Phase 2):
- Program: `tuna4uSQZncNeeiAMKbstuxA9CUkHH6HmC64wgmnogD` (Anchor). TunaPosition account =
  339 bytes, owner = tuna program, **authority (user wallet) at byte offset 11**
  (bump-first-style layout — Raydium lesson applies) → trustless discovery via
  `getProgramAccounts(memcmp offset 11 = wallet, dataSize 339)` is viable.
- Public API (no key): `api.defituna.com/api/v1/users/{wallet}/tuna-positions` returns
  COMPLETE open-position data: total_a/b (LP totals), current_debt_a/b,
  deposited_collateral_a/b, yield_a/b (uncollected), compounded_yield, leverage,
  liquidation prices, ticks, entry_price, pnl_usd, opened_at, market → pool (underlying
  Orca pool), plus /markets /pools /vaults /mints /oracle-prices. Live verified on user
  `2rr3SFuM…` (6 open leveraged positions; example: total $795.13, debt $615.77 →
  EQUITY $179.36 on $199.96 collateral). Krishna + 2 other candidates return empty
  (no current positions).
- The endpoint returns OPEN positions only (state params ignored) — closed-Tuna
  Capital G/L needs Category-B tx-history reconstruction (follow-up phase).
- KEY VALUE SEMANTICS: Tuna positions are LEVERAGED — user's real value = EQUITY
  (total − debt), NEVER the raw LP total (would overstate by the borrowed funds).

_(Sprint 4 — clickable Capital G/L breakdown + closed rows — SHIPPED `00cd1bc`
2026-07-20; see Recent fixes.)_

**Carry-overs (not blockers):**
- **⚠️ PRODUCTION: `ALCHEMY_SOLANA_RPC` in Vercel is set to the BARE API KEY, not the full
  URL** (found live 2026-07-18 via browser verification: `/api/solana-closed-positions`
  500'd with `Failed to parse URL from 7SWf…`, so Solana closed Capital G/L was missing
  from production totals, e.g. A1 showed −$10,369.40 without Orca's −$1,818.78). **Osho
  must edit the value to `https://solana-mainnet.g.alchemy.com/v2/<key>`** (Settings →
  Environment Variables). Since `7784ed2` a malformed value degrades gracefully (empty,
  uncached, loud `[rpcEnv]` server log) instead of 500ing — but the feature stays OFF
  until the value is fixed.
- **Closed positions are counted everywhere but not yet shown as Closed rows** — Sui
  (Cetus/Bluefin/Momentum) AND Solana (Orca, Raydium) closed positions fold into Capital G/L +
  Fee Income but have no dashboard/Closed-tab rows (queue item "UI for closed rows").
- **Sheet reconciliation gap (~$610) is valuation basis, NOT a scan miss:** Osho's Business
  P&L records ~$2,370 Orca fees vs $1,760.01 on-chain (`collect_fees` complete, 0 dropped
  legs, rewards $0) — the delta is DeFiLlama daily-close vs sheet-recorded prices on
  volatile-ZEC days. Chain is authoritative; the 19-row table in
  `reports/sprint-3-free-phase-b-report.md` is the line-by-line reconciliation artifact.
- **First-ever scan latency per Solana wallet is ~40–120 s** (background, non-blocking,
  paced free-tier scan) — paid once per wallet, then Redis-warm (~0.2–0.8 s) for every
  instance/user thereafter. Do not "optimize" this by burst-parallelizing: the free tier
  drops ~37% of txs under burst (Phase A proven); backoff-to-100% is the requirement.
- **CG-historical vs DeFiLlama-historical per-position daily-price tolerance (Sprint
  MOMENTUM finding):** the Sui closed-position SUI side prefers CoinGecko-historical
  (`getHistoricalOnlySuiPrice`) and falls to DeFiLlama-historical-by-coin-type only when
  CoinGecko 429s — BOTH are Rule 1c valid claim-date historical sources, never spot. So a
  position's per-event SUI price (and thus its Capital G/L) can vary by the daily-price
  delta between the two sources depending on which answered (e.g. Momentum A1 verified at
  −$306.59 combined vs a −$311.85 DeFiLlama-only scratch estimate, −1.7%). This is
  expected daily-granularity tolerance, NOT a leak; the wallet-scope combined figure is
  stable within a few percent.
- **HyperEVM Tier 2 archive is a non-functional fallback for positions >~57 days
  old** (Sprint 1.14) — mitigated for CLOSED positions by the Redis deposit cache;
  OPEN HyperEVM positions >57 days rely on Tier 1 (but have the value>0 client
  fallback, so no banner). Paid Chainstack archive would be the only real Tier-2
  fix; deferred (budget).
- **Sprint 1.13 cold-load full-page browser timing not headlessly measured** —
  verified structurally + warm baseline (~8s); eyeball on the deploy.
- **Token-resolver coverage** — Tier 2 routes (uniswap/v3, pancakeswap) + activity
  routes still use hardcoded maps; future sprint migrates + removes them (Rule 9).
- **Sprint POSITION-DETAIL numeric-eyeball follow-up (`82d4954`)** — the Sui pending-reward
  reads were proven numerically on Cetus ($81.10 vs on-chain $81.09) but only STRUCTURALLY on
  Bluefin/Momentum (no live non-zero pending-reward position existed in the test sample; code
  is identical to the proven Cetus path). **The first time a live Bluefin or Momentum position
  has non-zero pending rewards, eyeball DefiDesh's Uncollected total against the protocol app**
  to confirm the numeric match. Contract invariant (k).

---

## Sprint queue

In order. One active at a time. Each sprint must ship before the next begins.
_(Sprint WRAPPER-PROTOCOLS — DefiTuna wrapper positions — is the ACTIVE sprint above;
Phase 1 shipped `4c450a1`, Phase 2 queued below.)_

1. **Sprint WRAPPER-PROTOCOLS Phase 2** — the deferred wrapper work: (a) closed-Tuna Capital G/L
   via tx-history reconstruction against the tuna program (Category B, same pattern as
   Orca/Raydium closed positions — Tuna's API returns OPEN positions only); (b) survey other
   wrapper protocols with real usage (Kamino vaults, etc.) and integrate via the same
   `selfReportedPnl` mechanism; (c) a position-detail page for wrapper positions (Tuna rows are
   currently non-clickable — no live position object). Reuses `app/api/defituna/route.ts`'s
   hybrid API+on-chain-verify pattern.
1. **Sprint POSITION-DETAIL-2** — the deferred pending-reward paths from Sprint POSITION-DETAIL
   (`82d4954`): **B3** Solana pending rewards (Orca whirlpool `rewardInfos` offsets already
   documented in orca/route.ts comments; Raydium equivalent) so Orca/Raydium detail pages show
   reward emissions like the Sui ones now do; **B4** EVM gauge emissions (Aerodrome/Velodrome
   staked AERO/VELO via the gauge `earned()`) — **staked EVM positions (e.g. Osho's Aerodrome
   WETH/USDC) UNDER-REPORT uncollected value vs the protocol UI until B4 ships**. Same Contract
   invariant (k): value pending rewards at current spot (Rule 2), never a fee-claim (Rule 1a).
   **B3 head start (Sprint RAYDIUM):** every reconstructed closed Raydium position already
   carries `rewardAmountsRaw[3]` (exact per-slot emission totals from
   `DecreaseLiquidityEvent`) — read it, don't re-scan; reward MINTS come from
   PoolState.reward_infos.
2. **Sprint PERFORMANCE-2 (hardening candidates)** — the deferred Phase A items:
   **#4** Redis-cache the Aerodrome positions route's ever-owned tokenId scan +
   closed-position reconstruction (~30 s, the remaining first-load straggler — non-blocking
   behind the "still scanning" chip); **#5** Redis-cache CLOSED positions' activity route
   outputs (immutable — extend the Sprint 1.14 deposit-cache pattern beyond HyperEVM);
   **#6** move `withActivityRouteCache` success results to Redis (5-min TTL, errors never
   cached) so route outputs are shared across instances/users.
3. **Orca APR-fallback + reward-eyeball verification** — the deferred numeric eyeballs:
   (a) the Sprint POSITION-DETAIL derived-APR fallback on the new open Orca positions
   (ZEC/USDC showed ~213.4% at ship; re-ranged since) vs the Orca app; (b) Contract
   invariant (k) — the first live non-zero Bluefin/Momentum pending reward vs the protocol
   app (code-identical to the proven Cetus path, verified structurally only).
4. _(DONE in Sprint 4 `00cd1bc` — closed Sui/Solana positions now render as Closed-tab
   rows with close dates.)_
5. **tokenResolver coverage + cleanup** — migrate Tier 2 (uniswap/v3,
   pancakeswap) and the activity routes to `resolveToken`, then remove the
   per-route `KNOWN_COINS`/`KNOWN_TOKENS`/`TOKENS` maps once resolver coverage is
   proven in production (architecture-principles Rule 9).
6. **EVM per-event token resolution (hardening, not blocking)** — apply the Sprint
   TOKEN-RESOLUTION per-event pool-context pattern to the EVM wallet-scope fee scans
   (aerodrome/velodrome/uniswap). EVM is NOT currently broken — its fallback addresses are
   correct and Sprint 2.1b (`5b8f6b7`) routes closed positions through per-position scans
   with correct context, so the single-representative-pool risk is mitigated — but resolving
   each Collect event's token0/token1 from its pool on-chain would remove the last residual
   of the same bug class. Verify-and-document only until a real EVM user impact surfaces.
7. **Sui wallet-scope tx-history scan latency (optional, non-blocking)** — after Sprint
   SUI-HISTORICAL-REDIS `776fcaa` the Sui wallet-scope routes drop from ~111 s to ~18–20 s; the
   residual floor is the **~17 s public-Sui-RPC `queryTransactionBlocks` + `multiGet` scan** (240
   digests / wallet). A future sprint could cache the wallet's parsed tx-history / event set
   cross-instance (immutable ledger) or use a faster RPC. **Address only if <10 s becomes a UX
   need** — the Fee-Income regression is already resolved at ~18–20 s.
8. **Resumable/background closed-Solana scan (optional, build ONLY if it surfaces)** — Sprint
   LPPNL-PERF `535453e` proved a 2,544-tx heavy wallet's isolated single scan completes in
   ~217 s, under the `maxDuration=300` budget, so no resumability was needed. A wallet heavier
   than **~3,000–3,500 txs** could still exceed 300 s single-scan on the free Alchemy tier.
   **Build the fix ONLY if such a wallet is reported in production:** a signature-cursor
   resumable scan (persist distilled per-position accumulator + cursor across requests,
   process oldest→newest so discovery precedes events, finalize+cache when the cursor drains)
   OR Vercel Fluid (800 s). Until then the degradation is graceful — partial LP P&L numbers +
   a "scanning Solana closed history…" badge + the 305 s client budget, never a 504-loop.

## Recent fixes

Most recent first. Commit hashes are authoritative; descriptions are
shorthand.

- **`4c450a1`** — **Sprint WRAPPER-PROTOCOLS Phase 1: DefiTuna (Solana).** Wrapper-held
  leveraged Orca LP positions (NFT in Tuna's vault — invisible to the wallet census) now
  visible platform-wide. Hybrid source: DefiTuna public API primary + per-position
  ON-CHAIN verification (owner=tuna program, authority @ byte 11). EQUITY semantics
  (value = total − debt; fees = pending yield; tick-based range). NEW generic mechanism:
  `AerodromePosition.selfReportedPnl` → `useLpPnl.buildSelfReportedPnL` (netPnl = equity
  + yield − collateral, no activity route, no excluded-banner noise) — next wrapper
  protocol reuses it untouched. Verified on third-party wallet `2rr3SFuM…` (6 live
  positions, equity−collateral matches Tuna's own pnl; browser: allocation DefiTuna
  96%/$515, analytics Deposited $561.20/Net −$23.87, zero exclusions). No cache bumps.

- **`00cd1bc`** — **Sprint 4 SHIPPED: clickable Capital G/L breakdown + closed-rows UI**
  (queue item 4 folded in). Analytics Capital G/L cell click-expands to a per-closed-
  position table (pair/protocol/chain, opened/closed dates, deposited, withdrawn,
  lifetime fees, per-position G/L) built in aggregate() from EXACTLY the per-position
  values the total sums — footer === cell BY CONSTRUCTION (verified programmatically:
  −$12,779.66 exact, Withdrawn−Deposited === footer to the cent). New additive
  `LpPnlResult.closedRows`; `PositionMeta` carries openedTs/closedTs. Dashboard:
  reconstructed CLOSED Sui/Solana positions render as greyed Closed-tab rows with close
  dates (RAKA Closed 11 → 61), synthesized display-only (never in the source positions
  array), P&L from the same perPosition entries; dashboard now passes Sui/Solana wallet
  sets to useLpPnl (it previously never fetched closed reconstructions). Rows
  non-clickable (no live object for a detail page — follow-up candidate). Display-only,
  no valuation changes, no cache bumps.

- **`f64da31` + `f9c9f84`** — (1) **EVM session persistence** (owner-requested, wallet-security
  Rule 1 AMENDED): WalletAuthContext gains `evmAddress` — live wagmi address when unlocked,
  else the persisted last-confirmed address (`defidesh-evm-addr`) restored on load unless
  the `defidesh_evm_disconnected` flag is set; all 13 `useAccount` consumers now read the
  context identity (wagmi = mechanics only, same architecture Sol/Sui used). Verified: no
  extension → chip + all 5 EVM routes fire; flag set → "no wallet". (2) **Dashboard APY
  derived-APR fallback** (`f9c9f84`): pools absent from DefiLlama (Orca ZEC/USDC) show
  "~X% est." from own earnings instead of N/A — same formula as detail page/analytics.
  Also verified this session: RKHA Net P&L arithmetic EXACT (Net = Current − Deposited +
  Fees + Unclaimed + CapG/L = −$3,713.40; the pricing-invariants Rule 4 formula text
  differs from the implemented — flagged to Osho, code unchanged); RKHA closed-Sui
  CapG/L −$14,355.36 (26 pos) + EVM ≈ −$1,861 = −$16,216.88 shown.

- **`c96d7fa`** — Navbar wallet chips show WATCHED + SCANNED wallets, not only connected
  (the bar said "no wallet" while the pages below were full of watched-wallet positions).
  Chips mirror exactly what the pages compute over: scan mode → single `·SCAN` chip;
  otherwise connected + watched deduped, capped at 4 + "+N" overflow (hover lists rest).
  Verified LIVE: Krishna watched set shows all three chips; scan URL shows SUI·SCAN.

- **`e85f794`** — Analytics honors paste-a-wallet SCAN mode (wallet-security Rule 3
  parity): the paste flow showed positions on the dashboard but an EMPTY analytics page
  (the page built its wallet lists from connected+watched only and never read
  `scanAddress`, so zero /api calls fired). Fixed by mirroring PositionsContext's exact
  scan-override semantics in `app/analytics/page.tsx` (scan set ⇒ effective identity =
  ONLY the scanned address on its chain) + a Suspense-wrapped `AnalyticsScanModeListener`
  so `/analytics?address=&chain=` survives hard refresh (absent params do NOT clear an
  active scan — in-app nav keeps it). Verified LIVE on defidesh.com with a clean profile
  and ZERO watched wallets: `/analytics?address=0x15ace…2eff&chain=sui` renders full
  analytics (Cetus USDC/SUI $948.28, Sui closed Cap G/L −$2,147.75, lending, Earning
  Flows); pre-fix the same URL rendered the $0 empty state. Scan scope stays ONE
  address on ONE chain by design. No cache bumps.

- **`75d7619`** — DeFiLlama historical `searchWidth=24h`: the "1 claim pending" that never
  resolved (Krishna DEEP/SUI fee claim 2025-07-03) was a DeFiLlama SPARSE-SERIES gap —
  its default nearest-point search is narrower than our documented ±24h acceptance
  window, so `{coins:{}}` came back even though a same-day point existed 6.1 h later.
  `?searchWidth=24h` lets DeFiLlama return that point; the existing `MAX_TS_DRIFT_SEC`
  ±24h validation still gates it (Rule 1c unchanged, never spot). Platform-level: any
  sparse-coverage token. No cache bumps (in-process negative cache clears on deploy;
  misses were never Redis-persisted; client nulls are 5-min TTL). Verified LIVE: Krishna's
  pending-claims note GONE post-deploy; DEEP@2025-07-03 = $0.153162
  (`defillama_historical_used`). **NEW KNOWN LIMITATION discovered en route: CoinGecko
  free tier now rejects `/history` >365 days old (error 10012)** — DeFiLlama is the ONLY
  claim-date source for >1-year-old claims, so its coverage gaps become permanent
  pendings as positions age (see Known limitations).

- **`87db23d`** — Cetus V1 events + Tenderly throttle + honest Sui index fallback (Krishna
  DEEP/SUI investigation). (1) **Cetus V1 `AddLiquidityEvent`/`RemoveLiquidityEvent`**
  (original pkg `0x1eabed72…`, no V2 suffix, same fields, no `current_sqrt_price`) now
  parsed by cetus/activity AND suiClosedPositions — pre-V2 deposits/withdrawals were
  invisible → false "No deposit events found" → positions EXCLUDED from Capital G/L
  (or WRONG Cap G/L on a missed V1 withdrawal). V2 txs emit only V2 events (verified
  live) so no double count; package allowlist keeps Momentum's identical names out.
  **Cache bumps: lp-pnl-events v28, analytics-activity v20, cetus-activity v5,
  closed_pos_sui v2.** (2) **Tenderly 403**: the public Base gateway hard-throttles
  concurrent getLogs per IP (403 on Vercel's shared IP; serial calls instant) —
  `evmRpcPost` backoff-retries 403/429 (serial inside the semaphore slot),
  TENDERLY_CONCURRENCY 8→2, optional keyed `TENDERLY_NODE_RPC` env (rpcUrlFromEnv),
  throttle errors fall through to publicnode instead of the terminal throw→500.
  (3) **`suiRpcIndexed()`**: object-filter queries (ChangedObject/InputObject) pinned to
  the PRIMARY endpoint; the public fullnode answers a silent `{data:[]}` for indexes it
  doesn't serve, so unavailability now THROWS `SuiIndexUnavailableError` ("I don't
  know") instead of masquerading as "no results". Verified LIVE on defidesh.com
  (browser): Krishna settled excluded=0 (was 4), Cap G/L −$6,110.45 (was −$4,317.77
  with DEEP/SUI + 3 Aerodrome missing), fees +$3,166.33 (was $2,398.40); RAKA
  regression-clean (deposited byte-identical $27,575.35; Cap G/L −$12,125.39 vs
  −$12,432.75 = 2.5% closed-Sui rescan daily-price tolerance). NOTE: Alchemy's Sui
  object-filter indexes are ~1-yr shallow (returned 3 of 5 txs for the DEEP/SUI
  position) — ChangedObject is a weak net; FromAddress reached 2025-02 complete.

- **`7784ed2`** — RPC env-var URL guard: NEW `app/lib/rpcEnv.ts` `rpcUrlFromEnv(name)` —
  a URL-typed RPC env var that is MALFORMED (e.g. a bare API key pasted where the full
  https URL belongs) now behaves exactly like UNSET, so the existing graceful-degrade
  paths cover it instead of a fetch URL-parse throw → hard 500 that silently corrupts
  Capital G/L totals. Wired at all three URL-typed sites: `ALCHEMY_SOLANA_RPC`
  (solanaClosedPositions — the live incident), `SUI_RPC_URL` (suiRpc → public-fullnode
  fallback carries the load), `HYPEREVM_ARCHIVE_RPC` (hyperswap/activity ×3 →
  archive-unconfigured). One-time loud `[rpcEnv]` console.error, never leaks the raw
  value. Key-typed vars (HELIUS_API_KEY) interpolated into hardcoded URLs can't URL-throw
  and are unchanged. Verified: 9/9 guard cases incl. the exact incident string; live
  engine repro returns empty + `complete=false` (uncacheable) without throwing; suiRpc
  with malformed primary answers from the public fullnode; tsc + build clean. No cache
  bumps. General pattern: ANY future URL-typed RPC env var must be read via
  `rpcUrlFromEnv`, never `process.env.X` directly into `fetch`.

- _(Sprint SPOT-RESILIENCE-V2 `c6e31ee` — per-position last-known-good (LKG) + degrade funnel
  (STALE→ESTIMATED→EXCLUDED) so a transient per-position failure never deletes a position from
  LP P&L totals; NEW `app/lib/evmRpc.ts`; architecture Rule 11 — rolled off this list; see git
  history + memory.)_
- _(Sprint SUI-RPC-RELIABILITY `8d82287` — shared paced+failover Sui RPC client
  (`app/lib/suiRpc.ts`, 12 s timeout + semaphore 8) fixes the "N Sui positions failed — RPC
  timeout" dropped-position bug; Contract invariant (l) — rolled off this list; see git
  history + memory.)_
- _(Sprint LPPNL-PERF `535453e` — killed the 5-min analytics "calculating…" spinner
  (progressive aggregate render, architecture Rule 10) + closed-Solana Cap G/L always
  complete (`maxDuration=300` + in-flight dedup) — rolled off this list; see git history +
  memory.)_
- _(Sprint RAYDIUM `d7c6c81` — Raydium closed-position Cap G/L + fix for a SILENT
  platform-wide open-position failure (bump-first layout broke the memcmp lookup); Solana now
  Orca+Raydium full parity — rolled off this list; see git history + memory.)_
- _(Sprint 3-FREE `d1bf447` — MILESTONE: cross-chain Capital G/L COMPLETE (EVM+Sui+Solana) on
  FREE Alchemy; Solana (Orca) closed-position reconstruction via paced-scan pattern — rolled
  off this list; see git history + memory.)_
- _(Sprint POSITION-DETAIL `82d4954` — Sui pending REWARD emissions on the detail page +
  derived-APR fallback for long-tail pools; B3 Solana rewards / B4 EVM gauge → POSITION-DETAIL-2
  — rolled off this list; see git history + memory.)_
- _(Sprint PERFORMANCE `f4b58ac` — market_chart batch-fill (`fetchDailyClosesRange`) +
  patient fetch + progressive rendering; >2-min load → first meaningful render ~1–4 s, Sui
  routes 9–24 s; baselines now a platform requirement (see Methodology); #4–#6 →
  Sprint PERFORMANCE-2 — rolled off this list; see git history.)_
- _(Sprint SUI-HISTORICAL-REDIS `776fcaa` — cross-instance Redis tier for SUI historical
  prices; fixes the post-deploy regression where the 3 Sui protocols vanished from the
  analytics Fee Income breakdown (cold-instance ~63s serial SUI-price crawl); Sui
  wallet-scope routes ~111s → ~18–20s — rolled off this list; see git history.)_
- _(Sprint SPOT-RESILIENCE `92e779a` — tiered Redis LKG for the CoinGecko SPOT path
  (`redisSpotCache.ts`, `cg_spot_v1`); fixed the persistent "Current price data unavailable"
  banner on OPEN positions; Rule 1a untouched (SPOT/Rule 2 path only); Contract invariant (j)
  — rolled off this list; see git history.)_
- _(Sprint TOKEN-RESOLUTION `a866576` — per-event Sui pool resolution for wallet-scope fee
  claims; fixed ~$3,847 missing Fee Income for closed-only Sui wallets (hardcoded
  single-pair fallback was the architectural root cause); `suiPoolContext.ts`; Contract
  invariant (i) — rolled off this list; see git history.)_
- _(Sprint MOMENTUM `750f566` — Momentum (Sui) activity route + closed-position Capital G/L;
  completed Sui Capital G/L across all three Sui CLMM protocols (Cetus, Bluefin, Momentum);
  A1 −$306.59 / A2 $0, 0 spot, 0 pending; cache bumps lp-pnl-events v27 /
  analytics-activity v19 — rolled off this list; see git history.)_
- _(Sprint EMAIL `5b583f7` — homepage ship-notification email capture: `POST /api/subscribe`
  + `subscribers` table (email-only list, NOT accounts), server-side validation, idempotent,
  no existence leak, 5/IP/hr rate limit; `ShipNotifications` client component — rolled off this
  list; see git history.)_
- _(Sprint 2.2c `bfabf3f` — open-position SUI fee-claim cg-spot leak closed: the 2 fee-claim
  + 2 `[PRICE_LOG]` sites in cetus/bluefin now call `getHistoricalOnlySuiPrice` (never the
  FIX-C spotFallback); reward sites untouched (Memory #28 exception). Cache bumps v26/v18/v4/v5
  — rolled off this list; see git history.)_
- _(Sprint 2.2b `bb7fc0d` — Sui closed-position Capital G/L for Cetus + Bluefin:
  `app/lib/suiClosedPositions.ts` reconstructs destroyed-object positions from wallet tx
  history, values them historical-only, reuses `computePositionPnL`; Redis `closed_pos_sui_v1`;
  `getHistoricalOnlySuiPrice` added — rolled off this list; see git history.)_
- _(Sprint NEW `17c5101` — Bluefin fee claims historical-only (the last cg-spot fee-claim
  leak); DeFiLlama folded in as a first-class historical tier — rolled off this list; see git
  history.)_
- _(Sprint 2.1b `5b8f6b7` — Aerodrome/Velodrome closed positions route through per-position
  scans with correct context (cbBTC $0.21→~$296); cg-spot removed from both routes' fee claims;
  dedup keys on (protocol, txHash, logIndex) — rolled off this list; see git history.)_
- _(Sprint 1.15 `4752416` — Cetus fee claims route through DeFiLlama historical
  before any spot, removing the latent FIX-A cg-spot fee-claim fallback;
  historical-ONLY per side (stable $1 / SUI CG→DeFiLlama / other non-stable
  DeFiLlama / else pending). Memory #28 CETUS reward spot+LKG preserved — rolled off
  this list; see git history.)_
- _(Sprint 1.14 `65d6328` — persist a CLOSED HyperEVM position's immutable deposit
  logs in Upstash Redis (`depositHistoryCache.ts`, keyed `(nftManager, tokenId)`,
  30d TTL) so a throttled free-tier Etherscan can't drop them; Tier 2 archive only
  covers ~57 days and true `fromBlock=0` is plan-blocked — rolled off this list; see
  git history.)_
- _(Sprint 1.13 `2dcd3cb` — server-side activity-route cache + in-flight dedup
  (`app/lib/activityRouteCache.ts` `withActivityRouteCache` wraps all 9
  `/api/{protocol}/activity` GETs): collapses the 2-3× redundant multi-hook fetch
  per position into ONE computation (the HyperEVM cold-load fix), in-process,
  byte-identical, no version bump — rolled off this list; see git history.)_
- _(Sprint 1.12 `5bad502` — DeFiLlama historical-by-contract wired as a SECONDARY
  claim-date price source (`app/lib/defillamaPriceHistory.ts`), keyed by on-chain
  contract/mint/coin-type for the Sui/Solana long-tail; PRIMARY for Solana
  orca/raydium, additive null-only fallback for Sui cetus/bluefin; Rule 1a preserved
  (historical endpoint only, never current/spot) — rolled off this list; see git
  history.)_
- _(Sprint 1.11 `d57f051` — gate `price0/price1 > 0` for OPEN positions only in
  `computePositionPnL` so a cold-instance spot-429 (`price0=0`) no longer spuriously
  excludes closed HyperEVM positions from Capital G/L; closed positions compute from
  historical events — rolled off this list; see git history.)_
- _(Sprint 1.10 `140d908` — platform-wide automatic token resolution
  (`app/lib/tokenResolver.ts` + `tokenConstants.ts`); Tier-3 (aerodrome/velodrome)
  unmapped pool tokens resolve decimals from on-chain truth, not blind `=18` —
  rolled off this list; see git history.)_
- _(Sprint 1.8b `0b9e3a0` — Performance Metrics + Yield/APR Projections fall back
  to an uncollected-fees estimate for new positions with no claim history — rolled
  off this list; see git history.)_
- _(Sprint 1.8 `a6a6e75` — Cetus pending-fee computation (pool-owned fee table:
  position_manager LinkedTable + tick SkipList) — rolled off this list; see git
  history.)_
- _(Sprint 1.7e `f7842c8` — shared CLMM utilities (clmmFeeMath / clmmTickDecoder)
  applied across Orca/Bluefin/Momentum — rolled off this list; see git history.)_
- _(Sprint 1.7d `d2ff9d6` — Orca variable-length `DynamicTickArray` tick decoder
  — rolled off this list; see git history.)_
- _(Sprint 1.7 `1dd862c` — Orca CLMM fee-growth underflow guard — rolled off
  this list; see git history.)_
- _(Sprint 1.6 `5af4d33` — Upstash Redis persistent historical-price cache —
  rolled off this list; see git history.)_
---

## Where things live

**Stable rules** (always loaded, small):
- `.claude/rules/pricing-invariants.md` — fee valuation, exceptions,
  display currency, capital G/L formula
- `.claude/rules/architecture-principles.md` — platform-level fixes,
  no per-chain branches, additive-only, sprint discipline
- `.claude/rules/cache-versioning.md` — version bump protocol, current
  versions, TTL by result type
- `.claude/rules/wallet-security.md` — auto-connect prohibition,
  connected/watched parity, duplicate rejection, persistence rules
- `.claude/rules/commit-protocol.md` — build clean before commit,
  verification before "done", stop-and-report threshold
- `.claude/rules/instrumentation.md` — `[PRICE_LOG]` event schemas,
  source enum, analysis patterns

**Skills** (loaded on demand when invoked):
- `.claude/skills/sprint-start/SKILL.md` — session startup sequence
- `.claude/skills/investigate-first/SKILL.md` — 8-step debugging
  methodology
- `.claude/skills/fix-prompt-template/SKILL.md` — Claude Code prompt
  structure (Investigation / Implementation / Verification)
- `.claude/skills/burned-nft-recovery/SKILL.md` — EVM closed-position
  recovery pattern
- `.claude/skills/add-new-protocol/SKILL.md` — Protocol Correctness
  Contract for integrating any new protocol on any chain (shared CLMM
  utilities, decoder coverage, UI surfaces, wallet security)

**Shared CLMM utilities** (canonical — see architecture-principles Rule 8):
- `app/lib/clmmFeeMath.ts` — `safeCalcPendingFee` (u128 underflow guard),
  `calcFeeGrowthInside`, `emitFeeUnderflow`. Used by Orca, Bluefin, Momentum.
- `app/lib/clmmTickDecoder.ts` — `solanaCLMMTickRegistry` (binary tick-array
  dispatch) + `anchorDiscriminator`. Solana only; Sui uses JSON extraction.

**Shared chain RPC transport** (canonical — Contract invariant (l), Sprint
SUI-RPC-RELIABILITY `8d82287`):
- `app/lib/suiRpc.ts` — `suiRpc(method, params)`: EVERY Sui read routes through
  it. Ordered endpoints (`SUI_RPC_URL`/Alchemy primary → public fullnode
  fallback) with automatic failover on timeout/429/5xx; 12 s per-call timeout;
  global concurrency semaphore 8. Never add a bare `fetch(SUI_RPC)` to a route.
  A new chain builds its shared client FIRST (Solana's paced-scan client in
  `solanaClosedPositions.ts` is the same principle for backfill scans).
- `app/lib/suiPoolContext.ts` also L2-caches immutable pool coinType/decimals in
  Redis (`sui_pool_ctx_v1:{poolId}`, 90 d) and batches via `sui_multiGetObjects`.

**Shared token resolution** (canonical — see architecture-principles Rule 9):
- `app/lib/tokenResolver.ts` — `resolveToken({chain, contractAddress|mint|suiType})`
  → `{symbol, decimals, cgId, priceable, source}`. Cascade: Redis → constants →
  CoinGecko contract → on-chain metadata → CoinGecko symbol search → DeFiLlama
  coverage → unresolvable. Used (long-tail fallback) by cetus, bluefin, momentum,
  orca, raydium, hyperswap, aerodrome, velodrome.
- `app/lib/tokenConstants.ts` — pinned native tokens + canonical stables per
  chain (the only identities that never auto-resolve), `CG_PLATFORM` /
  `DEFILLAMA_CHAIN` slugs, and identifier normalization.
- `app/lib/suiPoolContext.ts` (Sprint TOKEN-RESOLUTION `a866576`) —
  `resolveSuiPoolContext(poolId)` / `resolveSuiPoolContexts(poolIds)` →
  `{coinTypeA, coinTypeB, decimalsA, decimalsB}` from a Sui CLMM pool's on-chain
  `Pool<A,B>` type params (immutable → in-process Map cache, no TTL). The
  bluefin/cetus/momentum activity routes call it to resolve each wallet-scope fee
  claim's REAL pool per event instead of a single hardcoded representative pair
  (Protocol Correctness Contract invariant (i)).

**Claim-date historical pricing** (two sources — see pricing-invariants Rule 1c):
- `app/lib/cgPriceHistory.ts` — `fetchTokenPriceAtDate(cgId, ts)`, CoinGecko
  historical (PRIMARY), wrapped by the Sprint 1.6 Redis tier (`redisPriceCache.ts`).
  Also `fetchDailyClosesRange(cgId, from, to)` (Sprint PERFORMANCE `f4b58ac`) — ONE
  `market_chart/range` call returning every daily close in the span (byte-identical
  to `/history`; span padded ≥92 d for daily granularity). The standard pattern for
  any historical-price backfill: N missing dates = 1 CG call, written to the same
  `price:historical:{cgId}:{YYYYMMDD}` Redis keys. Used by `suiPriceHistory.ts`'s
  tiered prewarm (in-process → Redis → batch → per-date fallback).
- `app/lib/defillamaPriceHistory.ts` (Sprint 1.12) — `fetchDefillamaPriceAtDate` /
  `prewarmDefillamaPrices` / `getCachedOnlyDefillamaPrice`, DeFiLlama
  historical-by-contract (SECONDARY), keyed by on-chain contract/mint/coin-type,
  own Redis namespace `price:historical:defillama:*`. Used by orca/raydium
  (PRIMARY there) + cetus/bluefin (additive null-only). Claim-date only, never
  spot (Rule 1a). No HyperEVM coverage.

---

## Methodology

Investigate-first, always. Before any fix:

1. Instrument and capture logs
2. Diagnose root cause from evidence
3. Plan with Osho in plain language, get explicit confirmation
4. Write thorough Claude Code prompt using `fix-prompt-template`
5. Verify post-fix `route_summary` matches expected numbers
6. Commit and push automatically when verified — never ask permission
7. Stop and report if verification gap is significant (20%+)

All changes are additive unless explicitly replacing broken logic.
Every fix is a platform fix that benefits all current and future users
with similar position shapes. Never wallet-specific framing.

**Performance is a platform requirement (Sprint PERFORMANCE `f4b58ac` +
LPPNL-PERF `535453e` baselines).**
New sprints must not regress: **first meaningful render ~1–4 s** (positions stream
per source — never reintroduce an all-or-nothing `Promise.all` gate on the
positions array); **the analytics LP P&L aggregate block shows first numbers ~2 s
and NEVER an endless "calculating…" spinner for ANY wallet** (Sprint LPPNL-PERF —
cells render partial values once `included>0`, closed-scan progress shows as a
non-blocking badge, never a full-block skeleton); and **Sui activity routes
~10–24 s** (scan-bound; the SUI historical prewarm is batch-filled via
`fetchDailyClosesRange` + Redis). Any hook consuming the streaming positions array
MUST carry in-flight dedup (by position id or URL) so per-wave effect re-runs never
re-fire an in-flight fetch; the closed-scan routes are in-flight-deduped
(`withActivityRouteCache` + a module-level per-wallet promise map) so the concurrent
useLpPnl + useWalletLevelFees double-fetch collapses to ONE scan. **Any aggregate
block MUST render progressively — the "no partial totals reveal" all-or-nothing
gate is a removed anti-pattern (architecture-principles Rule 10).** Client fetch
policy is one patient attempt, retry only on network/5xx, never on timeout; the
closed-scan client fetch carries a 305 s budget so Capital G/L is never silently
pending forever. Long server scans set `maxDuration=300` (vercel.json glob
`app/api/**/*`). Verify these numbers as part of B7 for any sprint touching the
load path.

---

## Known limitations

**CoinGecko free-tier historical horizon is a ROLLING 365 days (found 2026-07-19).**
`/coins/{id}/history` returns error 10012 for dates >365 days old on the public plan.
Consequences: (1) any claim older than 1 year that isn't already warm in the Upstash
Redis historical cache can NEVER be CG-priced — DeFiLlama historical-by-contract is
the only remaining claim-date source, so DeFiLlama coverage gaps become permanent
pending claims as positions age (mitigated for sparse series by `75d7619`
searchWidth=24h; a token DeFiLlama doesn't cover at all stays pending per Rule 1a);
(2) the Redis historical cache's value grows over time — a warmed >1-year-old price
is irreplaceable on free infra; treat broad flushes of `price:historical:*` as
DATA LOSS, not just a slow rebuild. A paid CG key (~$129/mo) lifts the horizon;
deferred (budget) — revisit if >1-year-old pending claims accumulate in production.

**HyperEVM has no archival `eth_call`.** Chainstack returns -32002
"Archive Debug Trace not available on plan." Public RPC at
`rpc.hyperliquid.xyz/evm` is non-archival for state. The sqrtPriceX96
resolver cannot run on HyperEVM. Claim-time pricing for HyperSwap,
KittenSwap, ProjectX must use CG-historical awaited for closed
positions, fire-and-forget for open.

**HyperEVM Tier 2 archive is a non-functional fallback for positions older than
~57 days (Sprint 1.14 finding).** It scans only the last `SCAN_DEPTH` 5M blocks,
which at HyperEVM's ~1s (~984ms) block time is **~57 days** — and a true
`fromBlock=0` archive query is plan-blocked (`-32002`, see above). So a position
whose deposit predates the window can't be served by Tier 2 at all; Tier 1
(Etherscan V2, `fromBlock=0`) is the only live tier for it. When Etherscan
throttles Tier 1 under production load, the deposit is dropped → exclusion banner.
**Mitigated for CLOSED positions in Sprint 1.14 (`65d6328`):**
`app/lib/depositHistoryCache.ts` persists a closed position's immutable deposit
logs in Redis (keyed by `(nftManager, tokenId)`, 30d TTL), so after the first
successful retrieval it's served from cache forever (`tier_used: redis-cache`),
never re-hitting Etherscan. OPEN HyperEVM positions older than 57 days still rely
on Tier 1 (they're not cached, since they can gain deposits) — but they have the
client-side value>0 fallback, so no banner. A paid Chainstack archive tier (or
narrowing the scan by a known deposit block) remains the only way to make Tier 2
a real fallback for open old positions; deferred (budget decision).

**Server-side cross-user price cache — RESOLVED in Sprint 1.6 (`5af4d33`).**
The persistent cross-request price cache ("Option C") is now built:
`app/lib/redisPriceCache.ts` wraps the CoinGecko historical path in
`cgPriceHistory.ts` with Upstash Redis (Tier 1, 30d TTL), so a warmed
claim-date price survives across cold starts, requests, positions, and users.
This addresses the Sprint 1.5 failure mode where the awaited CG-historical
prewarm could time out under concurrent CG pressure (even at the 60s cap),
leaving HYPE fee claims UNRESOLVED. Prewarm cap left at 60s for now; consider
lowering to 25s once production cache-hit rate is observed >80% over several
days (track `route_summary.redis_cache_hits/misses` and
`claim_pricing_succeeded`). Note: the Upstash DB (`defidesh-price-cache`, free
tier) is shared across Production/Preview/Development — avoid broad key
flushes. A genuinely-unpriceable claim date still stays UNRESOLVED by design
(never spot-valued); Redis only eliminates pending-claims caused by transient
CG rate-limit/timeout.

**Empty-Sugar edge case (Aerodrome, Velodrome).** For wallets with zero
open positions, the Sugar contract's enumeration returns empty, causing
`buildClosedPositions` to be skipped. Fees are recovered but closed-record
display is gated. Pending fix.

**Sui closed positions — Capital G/L COMPLETE for ALL THREE Sui CLMM protocols
(Cetus + Bluefin Sprint 2.2b `bb7fc0d`; Momentum Sprint MOMENTUM `750f566`).** The
position object is destroyed on close, but `app/lib/suiClosedPositions.ts`
reconstructs each lifecycle from wallet tx history and folds Capital G/L into
`useLpPnl` (Redis-cached `closed_pos_sui_v1`, now `:cetus:` / `:bluefin:` / `:momentum:`
key namespaces). Momentum rides the historical-sides fallback (its liquidity events
carry no `current_sqrt_price`, so the sqrtprice-historical PRIMARY never fires —
stable $1 + SUI CG/DeFiLlama historical, which is exact for SUI/USDC pools). Remaining
gaps: closed Sui positions are not yet shown as **Closed rows** in the dashboard/Closed
tab (only counted in Capital G/L — Sprint 3 queue item, NOT the Solana sprint); and
**reward claims** are not valued in the closed-position Capital G/L path (Cap G/L
excludes them by Rule 4; the displayed Fees Collected already recovers closed-Sui
fees+rewards via the wallet-scope pipeline — Momentum's wallet-scope route now values
rewards historical-only via `reward_coin_type`, no spot+LKG exception). **Solana (Orca)
closed-position Capital G/L shipped in Sprint 3-FREE (`d1bf447`) — cross-chain Capital
G/L is now COMPLETE across EVM + Sui + Solana** (Raydium queued; no user impact yet).

**Sui open-position fee-claim cg-spot leak — RESOLVED (Sprint 2.2c `bfabf3f`).** The
Cetus (1.15) and Bluefin (Sprint NEW) *open*-position fee cascades called
`getCachedSuiPriceForTimestamp` for the SUI side, which returns the FIX-C `spotFallback`
(current cg-spot) when CoinGecko historical misses — and, being non-null, PRE-EMPTED the
DeFiLlama-historical tier — so an open-position SUI fee claim could be spot-valued (Rule
1a leak). Fixed: the 2 fee-claim sites + 2 `[PRICE_LOG]` re-derivation sites now call
`getHistoricalOnlySuiPrice` (pure historical → DeFiLlama → pending; no spot). The 2
reward-claim sites are untouched (CETUS reward spot+LKG is the designated Memory #28
exception; Bluefin reward historical migration remains deferred). Platform-wide, **every
fee claim on every protocol on every chain is now historical-only** — the sole exception
is the CETUS reward token's designated spot+LKG path.

**Solana closed positions — RESOLVED for BOTH protocols (Orca Sprint 3-FREE
`d1bf447`; Raydium Sprint RAYDIUM `d7c6c81`).** The position NFT is burned on
close, but `app/lib/solanaClosedPositions.ts` reconstructs each lifecycle from
wallet tx history via the FREE Alchemy endpoint (`ALCHEMY_SOLANA_RPC` — the paid
Helius upgrade was never needed), with ONE shared scan serving both protocols,
and folds Capital G/L + fees into `useLpPnl`/`useWalletLevelFees` (Redis-cached
`closed_pos_solana_v1:{orca|raydium}:{wallet}`). Sprint RAYDIUM also fixed a
SILENT PLATFORM-WIDE bug: Raydium OPEN positions returned `[]` for every user
(bump-first account layout broke the memcmp lookup — now direct PDA derivation).
Remaining gap: Closed-row UI (queue item 4, shared with Sui). ⚠️ Production
requires `ALCHEMY_SOLANA_RPC` in Vercel env vars — without it the engine degrades
gracefully to "no Solana closed positions" (no errors, silently incomplete).

**Suilend APY not showing.** Reserve interest rate fields need parsing.
AlphaFi and Dolomite APY now working from on-chain data.

**Pool Statistics N/A for some pools.** Low priority backlog item.

---

## Wallet addresses for verification

Osho's two accounts. Never mix in analysis.

**Account 1:**
- EVM: `0xD99a9e66d000d4024dC77f00f784Cc45F8804F20`
- Solana: `GndR...pogC`
- Sui: `0xdc...c30d`

**Account 2:**
- EVM: `0xEf93B7f19dcEf8E5f9c5F41CBBCe9e78B16B8d0C`
- Sui: `0x8ef8c104d43e55b11fc6afcd58088274fabff2d30480dd4c4283ff834ac2297d`

Manual claim records (Google Sheets ground truth) are kept per-account.
Always state which account the affected wallet belongs to before
investigating.

---

## Tools and resources

**Development:**
- IDE: VS Code with Claude Code extension
- Strategy/prompting: Claude.ai (this conversation)
- Repo: `Robicon0/lp-tracker`, branch `main`

**Hosting and database:**
- Vercel Pro ($20/month) — auto-deploys from `main`
- Neon Postgres (`@vercel/postgres`, env `POSTGRES_URL`; helper `app/lib/db.ts` →
  `sql`, `isDbConfigured()`). Tables: `position_manual_entries` (manual closed-position
  deposit/withdrawal entries), `portfolio_snapshots` / `position_snapshots` (snapshots),
  `wallets` (registered wallets), and **`subscribers`** (Sprint EMAIL `5b583f7` —
  homepage ship-notification email capture; columns `id SERIAL PK`, `email TEXT UNIQUE`
  stored lowercased, `created_at TIMESTAMPTZ`, `ip_address TEXT` nullable, index
  `subscribers_email_idx`). The `subscribers` table is a **simple email-only list, NOT
  user accounts** — no login/password/wallet coupling; created idempotently by
  `app/api/subscribe/route.ts` on first POST. Export via manual SQL
  (`SELECT email FROM subscribers ORDER BY created_at`) when an announcement ships.
- Upstash Redis (`defidesh-price-cache`, free tier, us-east-1) — persistent
  historical-price cache (Sprint 1.6, `price:historical:{cgId}:{YYYYMMDD}` — now
  incl. `price:historical:sui:*` from Sprint SUI-HISTORICAL-REDIS `776fcaa`, which
  routed `suiPriceHistory.ts` through the same shared `redisPriceCache` helper) +
  DeFiLlama claim prices (Sprint 1.12, `price:historical:defillama:*`) +
  closed-position deposit history (Sprint 1.14,
  `deposit:logs:hyperevm:{nftManager}:{tokenId}`, 30d TTL) + closed-Sui-position
  Capital G/L (Sprint 2.2b, `closed_pos_sui_v1:*`) + closed-Solana-position
  Capital G/L (Sprints 3-FREE/RAYDIUM, `closed_pos_solana_v1:{orca|raydium}:*`) +
  **SPOT-price LKG (Sprint SPOT-RESILIENCE `92e779a`, `cg_spot_v1:{cgId}` →
  `{usd, at}`, 24h retention / 5-min freshness; `app/lib/redisSpotCache.ts`)** +
  immutable Sui pool metadata (Sprint SUI-RPC-RELIABILITY `8d82287`,
  `sui_pool_ctx_v1:{poolId}`, 90d). Env:
  `PRICE_CACHE_KV_REST_API_URL` + `PRICE_CACHE_KV_REST_API_TOKEN` (pass explicitly
  to the `@upstash/redis` client — it auto-reads only `UPSTASH_*`/`KV_*`, not
  `PRICE_CACHE_KV_*`). Connected to Production/Preview/Development; shared, so
  avoid broad flushes.

**RPC providers:**
- Chainstack `nanoreth` — HyperEVM (`HYPEREVM_ARCHIVE_RPC`)
- Alchemy — EVM chains; **Solana archival tx-history (`ALCHEMY_SOLANA_RPC`, free tier,
  Sprint 3-FREE)** — powers the closed-position wallet scan (~25–40k CU once per wallet,
  ~750–1,190 fresh Solana wallets/month on the free 30M CU/mo; paced scan REQUIRED — the
  free tier drops txs under burst but completes 100% with backoff). ⚠️ Must be set in
  Vercel env vars (currently `.env.local` only).
- Helius — Solana dashboard/positions routes (`HELIUS_API_KEY`). The $49/mo paid upgrade
  once planned for closed-position tx history is NO LONGER NEEDED (Alchemy free covers it).
- Alchemy Sui (`SUI_RPC_URL`, confirmed set in Vercel) — PRIMARY for ALL Sui reads via the
  shared `app/lib/suiRpc.ts` client (Sprint SUI-RPC-RELIABILITY `8d82287`: automatic
  failover to the public fullnode + 12 s timeout + concurrency semaphore 8 — never a bare
  fetch against a single endpoint; Contract invariant (l)).

**Price and pool data:**
- CoinGecko API — spot + historical (rate limit management active)
- On-chain sqrtPrice derivation — `app/lib/v3PriceDerivation.ts`
- DefiLlama — pool metadata
- Etherscan V2 API (chainid=999 for HyperEVM deposits) — `DefiDesh`
  API key in env

**Analytics:**
- Vercel Analytics (`@vercel/analytics`, added to `app/layout.tsx`
  outside Providers wrapper)

**Feedback:**
- Formspree floating feedback button

**Protocol-specific addresses:**
- Cetus packages: `0x1eabed72...` (fees/lifecycle),
  `0xdb5cd62a06c79695...` (V2 deposits/withdrawals),
  `0xdc67d6de3f00051c...` (V2 rewards)
- Cetus position field: `position`. Amounts: `amount_a` / `amount_b`
- Bluefin position field: `position_id`
- Velodrome fallback pool: `0x9763...7c8b` (USDC/WETH, reversed
  ordering)

**Cache versions (verify against code before bumping):**
- `lp-pnl-events-v28` / `analytics-activity-v20` / `cetus-activity-v5` /
  `closed_pos_sui_v2` (all `87db23d` — Cetus V1 Add/RemoveLiquidityEvent now parsed;
  pre-V2 deposits/withdrawals enter cached LP-P&L / Fee Income / closed-Sui
  reconstructions, so all four flush. closed_pos_sui v2 also rebuilds bluefin/momentum
  entries once — parsing unchanged there, shared version prefix, immutable re-scan.)
- `lp-pnl-events-v27` (Sprint MOMENTUM — Momentum is now an ACTIVITY_PROTOCOL (open
  positions route to `/api/momentum/activity` instead of being surfaced as unsupported
  rejections) AND its closed positions fold into Capital G/L; both change cached LP-P&L
  output. Parity with analytics-activity v19. v26 was Sprint 2.2c: Cetus + Bluefin
  fee-claim SUI side → `getHistoricalOnlySuiPrice`)
- `analytics-activity-v19` (Sprint MOMENTUM — Momentum fee + historical-only reward
  claims now enter analytics Fee Income; re-resolve in lockstep with LP-P&L. v18 was
  Sprint 2.2c)
- `cetus-activity-v4` (Sprint 2.2c — Cetus fee-claim SUI side historical-only via
  `getHistoricalOnlySuiPrice`; FIX-C spotFallback no longer reachable for fee claims)
- `bluefin-activity-v5` (Sprint 2.2c — Bluefin fee-claim SUI side historical-only via
  `getHistoricalOnlySuiPrice`; FIX-C spotFallback no longer reachable for fee claims.
  v4 had: stable → $1; SUI → CG-historical → DeFiLlama; else pending)
- `momentum-activity` (Sprint MOMENTUM — NEW `/api/momentum/activity`, wrapped in the
  in-process `withActivityRouteCache` (URL-keyed, NO `-vN` suffix — clears on every
  deploy by construction, cache-versioning Rule 4). Fee/reward claims historical-only,
  Rule 1a; reward valued via `reward_coin_type` → resolveToken, never spot)
- `closed_pos_sui_v1` (Sprint 2.2b — Upstash Redis cache of reconstructed CLOSED Sui
  positions' Capital G/L, keyed `closed_pos_sui_v1:{protocol}:{wallet}`, now `:cetus:`
  / `:bluefin:` / `:momentum:` namespaces, 30d TTL, Sprint 1.14 immutable contract.
  NOT bumped for Sprint MOMENTUM — Momentum is a NEW protocol key, so cetus/bluefin
  entries are byte-identical. Bump to invalidate on a closed-position valuation-logic
  change. Env: `PRICE_CACHE_KV_*`, shared Upstash DB — avoid flushes)
- `closed_pos_solana_v1` (Sprint 3-FREE `d1bf447` + Sprint RAYDIUM `d7c6c81` — Upstash
  Redis cache of reconstructed CLOSED Solana positions' Capital G/L + fees, per-protocol
  sub-keys `closed_pos_solana_v1:orca:{wallet}` and `:raydium:{wallet}` (ONE shared scan
  writes both). Non-empty: 30d TTL. **Refined empty rule (Sprint RAYDIUM, user-approved):
  an EMPTY result is cached ONLY when the scan was provably 100% complete
  (`stats.complete`), with a 24h TTL** — transient/partial-scan empties still never cache
  (Sprint 1.14 intent preserved); this stops single-AMM wallets re-paying the 40–120s scan
  every load. Caches a COMPUTED valued result → versioned key; bump on a valuation-logic
  change. `lp-pnl-events`/`analytics-activity` NOT bumped for either sprint — closed
  Solana positions were never in the dashboard positions array, and no Raydium
  localStorage entries could exist (the open-position route returned [] for everyone).
  Env: `PRICE_CACHE_KV_*`)

---

## Business context

DefiDesh is in trust-building phase. No subscription revenue yet. Only
paid infrastructure is Vercel Pro ($20/month). Paid services deferred
until traffic justifies: CoinGecko paid (~$129/mo at 100+ daily users),
Chainstack archival (~$49/mo, would drop HyperEVM CG workaround). The
Helius $49/mo upgrade once planned for closed-Solana history is OFF the
list — Sprint 3-FREE delivered it on Alchemy's free tier (~750–1,190
fresh Solana wallets/month; a paid Alchemy tier only becomes relevant at
sustained hundreds of NEW Solana wallets/day, since closed-position scans
are once-per-wallet then Redis-cached).

Multi-currency display (EUR, GBP, INR, JPY, SAR, AED, etc.) planned for
future. All internal pricing stays USD; FX conversion at UI layer only.

Subscription-based feature gating planned for future. Must remain
architecturally separate from wallet logic. Server-side only.

Osho is currently sole developer due to cost constraints. Plans to hire
team once platform generates income. Architecture must stay team-friendly.

---

## When to amend this file

Amend `CLAUDE.md` at the end of every session where work was committed.
Specifically:

- Move the just-completed sprint out of "Active sprint" and into recent
  fixes (with commit hash)
- Promote the next sprint in the queue to "Active sprint"
- Add the most recent commit to "Recent fixes" (keep the list to ~6
  entries — older ones drop off)
- Update "Known limitations" if a limitation was resolved or a new one
  discovered
- Update "Cache versions" if any version was bumped
- Update Osho's wallet address if changed (rare)

Do not amend stable rules here. If a stable rule needs to change, amend
the relevant file in `.claude/rules/`. This file stays focused on what
changes session-to-session.
