# Claude Code prompt — Sprint WRAPPER-PROTOCOLS: vfat/Sickle Phase B

_Generated 2026-07-31 from the APPROVED PHASE B BUILD PLAN in
`reports/wrapper-protocol-landscape-survey-report.md`. Paste everything below
the line into Claude Code._

---

**Context**

LP positions managed through **vfat** are invisible to every DefiDesh user
today. vfat deploys a **Sickle** — a per-user smart-contract wallet, one per
user per chain — and the AMM position NFTs live at the **Sickle address**, not
the user's EOA. DefiDesh's EVM readers scan the EOA, so they return zero. This
is the same wrapper-invisibility class as DefiTuna (Solana), now on EVM, and it
is the completeness-directive failure mode: the user sees *nothing*, not a wrong
number. vfat has ~$30.9M TVL across ~18 chains, concentrated on Base, and wraps
the exact AMMs DefiDesh already decodes (Aerodrome, Velodrome, Uniswap V3).

Phase A is COMPLETE and verified live on Base — read it before doing anything
(`reports/wrapper-protocol-landscape-survey-report.md`, the "vfat.io / Sickle"
section and both verification sections). It proved: the `sickles(owner)` getter
resolves the hidden sub-account; DefiDesh's **unmodified** `/api/aerodrome`
reader pointed at the Sickle returns the positions correctly; and the values
match an independent TickMath recompute **to the last digit** when pinned to the
same block. So this sprint adds **discovery and fan-out only** — no new
fee-math, no new tick decoder, no new pricing path.

This is Sprint WRAPPER-PROTOCOLS, vfat/Sickle **Phase B** (the build).

**Goal**

After this fix, an EVM wallet that holds LP positions through a vfat Sickle sees
those positions on the dashboard, in analytics, and in Capital G/L — with the
Sickle resolved automatically and never shown as a separate wallet — while a
wallet with no Sickle is completely unaffected.

**STRICT RULES:**

- Preserve all `[PRICE_LOG]` instrumentation in `app/lib/priceLogger.ts`
- All changes must be additive unless explicitly replacing broken logic
- No per-chain branches in client code (config maps or helper modules only)
- Build must pass clean before commit
- Commit and push automatically when work is verified — never ask permission
- If verification numbers are off by significant margin (20%+), stop and report
  — do not iterate silently
- **Do not widen scope.** The plan's "Explicitly out of scope" list is binding:
  no offline `predict()` derivation, no precise per-chain fan-out, no chains
  beyond the four configured, no new AMM connectors, no global `Deploy`-event
  enumeration. If you believe one is necessary, stop and report instead.

**INVESTIGATION:**

1. Read `.claude/rules/architecture-principles.md` (Rules 2, 10, 11),
   `.claude/rules/cache-versioning.md`, `.claude/rules/wallet-security.md`
   (Rule 3 connected/watched parity), and `.claude/rules/instrumentation.md`.
2. Read `reports/wrapper-protocol-landscape-survey-report.md` — the vfat/Sickle
   section, both verification sections, and the **APPROVED PHASE B BUILD PLAN**
   at the end. The plan is authoritative; this prompt is its execution.
3. Read `app/contexts/PositionsContext.tsx` in full. Note specifically:
   `evmAddresses` (built ~line 73, including the scan-mode branch), the
   `for (const a of evmAddresses)` fan-out loop (~line 121) that pushes the five
   EVM source queries, and the `/api/wallets/register` effect (~line 97) which
   must keep using the *identity* set, not the expanded fetch set.
4. Read `app/lib/evmRpc.ts` (`evmRpcPost` — the shared, timeout-bounded,
   concurrency-capped EVM transport; Contract invariant (l)). **All new RPC
   calls go through it — never a bare `fetch`.**
5. Read `app/api/aerodrome/route.ts` (lines 1–10) and `app/api/uniswap/v3/route.ts`
   (lines 1–65) for the established per-chain Alchemy RPC URL pattern
   (`NEXT_PUBLIC_ALCHEMY_KEY` interpolated into a per-chain host).
6. Read `app/lib/redisSpotCache.ts` as the reference shape for a small Redis
   cache module (own client, `PRICE_CACHE_KV_*`, no-op stub when unset, never
   throws, fire-and-forget writes).
7. **Resolve the Ethereum factory address.** The Phase A record has Base, OP and
   Arbitrum in full but Ethereum only as the truncated `0x9D70…7F95`. Recover
   the full address from DefiLlama's `projects/vfat/config.js` (the same source
   Phase A used) and **verify it live** with an `eth_call` to `sickles(owner)`
   before wiring it in. If you cannot verify it, **ship the three confirmed
   chains and report the gap** — do not guess an address.
8. Verify the primary regression wallet still resolves before you build:
   `eth_call` Base factory `0x71D234A3e1dfC161cc1d081E6496e76627baAc31`
   → `sickles(0xD4bE1ae0f492CC58d6353BBb43CDb1D718eedb87)` should return
   `0x06C3F4125E7d2d139D0Ab6a73c2112b7E949e09f`.
9. Report findings in plain language before writing any code.

**IMPLEMENTATION:**

1. **`app/lib/vfatConfig.ts` (new).** A plain per-chain config map of vfat
   SickleFactory addresses for Base, Optimism, Arbitrum, and Ethereum, each
   alongside whatever the chain needs to build its RPC URL (follow the existing
   uniswap/v3 route's per-chain shape). This is a config map, not branching
   logic — architecture Rule 2. Include a comment recording that the factory
   address is deliberately **not** uniform across chains.

2. **`app/api/vfat/sickles/route.ts` (new).** `GET ?owner=0x..` returns
   `{ sickles: [{ chain, address }] }` containing **deployed Sickles only**.
   For each configured chain, issue one `eth_call` to `factory.sickles(owner)`
   via `evmRpcPost`; run the chains **in parallel**; include a chain in the
   result only when the returned address is non-zero.
   - A chain whose call fails or times out contributes **no result** for that
     load. Never throw, never fail the whole route because one chain is down
     (Rule 11).
   - Validate `owner` is a well-formed EVM address; return an empty list rather
     than an error for a malformed or missing one.
   - Wrap the result in the `vfat_sickles_v1` cache described in step 3.

3. **Sickle-resolution cache (`vfat_sickles_v1`).** A **deployed** Sickle
   address is immutable once created — cache it long/permanently. A **"no
   Sickle found"** result must be cached **short (~5 minutes)** so a user who
   creates their first vfat position sees it on a later load rather than waiting
   out a long TTL. Follow the `redisSpotCache.ts` contract (own client,
   `PRICE_CACHE_KV_*`, no-op stub if unset, never throws, fire-and-forget
   writes). **Do NOT bump `lp-pnl-events` or `analytics-activity`** — Sickle
   positions are new per-position entries keyed by their own id/URL and no
   existing cached entry changes shape (same reasoning as DefiTuna Phase 1).

4. **`app/lib/vfatSickle.ts` (new).** A thin client-side wrapper that calls the
   route above and returns the resolved list. Mirror the shape of the existing
   `app/lib/*.ts` fetch wrappers.

5. **`app/contexts/PositionsContext.tsx` — the integration.** Resolve Sickle
   addresses for the effective EVM owner set: connected + watched EOAs, **and
   the scanned EVM address when in scan mode** (wallet-security Rule 3 parity —
   a pasted wallet must behave identically to a connected one). Then build:

   ```
   evmFetchAddresses = dedup(evmAddresses ∪ resolvedSickles)   // lowercased Set union
   ```

   and drive the existing EVM fan-out loop from `evmFetchAddresses` instead of
   `evmAddresses`.

   **Approved decision — implement the SIMPLE version:** each resolved Sickle is
   scanned against **ALL** EVM fetchers/chains, exactly as watched wallets work
   today. Do **not** build a per-chain-restricted fan-out; note it in a comment
   as a future optimization.

   Three constraints on this step:
   - **`evmAddresses` must keep its current meaning and current consumers.** It
     is the *identity* set — wallet chips and `/api/wallets/register`.
     `evmFetchAddresses` is used **only** for the fetch fan-out. A Sickle must
     never appear as its own wallet chip and must never be registered as a
     user wallet; it is a derived sub-account the user did not add.
   - **Resolution must be async and non-blocking (Rule 10).** EOA positions
     render at the existing ~1–4 s baseline and Sickle positions stream in
     behind them. The expanded set must never gate the first paint of the
     positions array.
   - Preserve the existing stable ordering and independent per-(source, address)
     keying so one slow source still never gates the others.

6. **Closed positions — verify, don't build.** Sickle-held closed positions
   should already surface through the existing `evmEverOwnedNftIds` mechanism
   once the readers are pointed at the Sickle address (proven in Phase A: the
   closed USDC/cbBTC leg was picked up correctly). Confirm this works; write new
   code **only** if it demonstrably does not, and report first if so.

**VERIFICATION:**

1. Build with `npm run build` — must complete clean.
2. Start dev server with log capture:
   `npm run dev 2>&1 | tee /tmp/devserver.log`
3. **Primary regression wallet (third-party, not Osho's):** load
   `0xD4bE1ae0f492CC58d6353BBb43CDb1D718eedb87` as a watched/scanned EVM
   address. Expected:
   - `/api/vfat/sickles?owner=0xD4bE…` returns Base →
     `0x06C3F4125E7d2d139D0Ab6a73c2112b7E949e09f`
   - Dashboard shows the **WETH/USDC ~$4.9k open** position and the
     **USDC/cbBTC closed** position
   - Value matches the exact-block figure verified in Phase A: WETH `0.480116`,
     USDC `3998.474372`, total **`$4904.64`**. Small drift from live price
     movement between reads is expected and acceptable — Phase A showed ~4%
     apparent gaps that were purely non-simultaneous reads, and vanished under
     same-block pinning. A gap that does **not** track price movement is a real
     failure.
   - Analytics Capital G/L picks up the closed USDC/cbBTC leg.
   - **No Sickle address appears as a wallet chip**, and no Sickle address is
     POSTed to `/api/wallets/register`.
4. **Negative control:** an EVM wallet with no Sickle (any address that returns
   `0x0` from the factory) shows **no change and no errors** — same positions,
   same timings, no new console noise.
5. **Performance baseline (Rule 10):** EOA positions still reach first
   meaningful render at ~1–4 s; Sickle positions stream in behind without
   blocking. Confirm the aggregate blocks never regress into an all-or-nothing
   spinner.
6. **Residual check (a) — gauge-staked-through-a-Sickle. SHIPPING GATE.**
   Find a Sickle holding a gauge-staked Aerodrome/Velodrome position and confirm
   it surfaces correctly. The existing reader handles staked positions for
   normal wallets and is address-agnostic, so this is expected to be a
   confirmation rather than new code — but it must be confirmed against a real
   staked-through-Sickle position before shipping. If none can be found, **stop
   and report** rather than shipping the gate unverified.
7. **Residual check (b) — long-tail token resolution. SHIPPING GATE.**
   Confirm long-tail tokens on Sickle-held positions either resolve correctly or
   degrade cleanly to "price unavailable" with correct symbol and decimals —
   **never wrong data**. Re-check the specific dust-Sickle case from Phase A
   (pools `0x948e80fb…` and `0xcf88b8bf…`, which rendered `TOKEN0`
   placeholders).
8. If verification passes: commit with a message in the established format
   (what shipped, why it was invisible before, the mechanism, the verified
   numbers, and "no cache bumps to lp-pnl-events/analytics-activity; new
   `vfat_sickles_v1` key") and push to main.
9. If verification fails by significant margin (20%+) or either shipping gate
   cannot be confirmed: **stop and report**. Do not iterate silently.
10. Update `CLAUDE.md`: move vfat/Sickle into Recent fixes with the commit hash,
    record the new `vfat_sickles_v1` cache key in the Cache-versions list and in
    `.claude/rules/cache-versioning.md` Rule 2, add vfat to the protocol list in
    "Project identity", and note the two future optimizations (offline
    `predict()`, precise per-chain fan-out) plus the remaining ~14 unconfigured
    chains as backlog.

**EDGE CASES TO HANDLE:**

- Owner with **no Sickle on any chain** — empty list, no errors, no extra
  fetches, and the "empty" result cached only briefly (~5 min).
- Owner with a Sickle on **some** chains but not others — only deployed ones
  returned.
- **One chain's RPC down or throttled** — that chain contributes nothing; the
  other chains and the whole rest of the page are unaffected (Rule 11).
- **User has already added their own Sickle as a watched wallet** — the
  lowercased Set union must not query it twice or double-count its positions.
- **Scan mode** — a pasted EVM address resolves its Sickle just like a connected
  wallet (Rule 3 parity).
- **Multiple EOAs** (connected + several watched) each with their own Sickle —
  all resolve, all attribute correctly.
- **`NEXT_PUBLIC_ALCHEMY_KEY` unset** — degrade to no Sickle results, exactly as
  the existing EVM routes already degrade; never throw.
- **Checksum-case address input** — resolution and dedup must be
  case-insensitive throughout.

Build, test on localhost, confirm visually that it works, then push to GitHub.
Do not mark it done until the output is verified. Update CLAUDE.md when done. If
anything is unclear or the file paths don't match what's expected, stop and
report — do not improvise.
