# Wrapper-Protocol Landscape Survey — Phase A Investigation

**Sprint:** WRAPPER-PROTOCOLS (Gap 2) — completeness for LP positions held via
position-manager wrappers/vaults.
**Type:** Investigation only. NO implementation code. Stop-and-report.
**Date:** 2026-07-28.
**Goal:** Identify wrapper/vault-style LP managers whose positions are invisible to
DefiDesh's direct wallet scanning, and rank by (real usage × ease of support).

---

## TL;DR — the one decision that reorganises everything

The single most valuable output of this survey is a **three-class taxonomy**. A
wrapper's *custody architecture*, not its brand, decides whether DefiDesh has a gap
at all — and how expensive closing it is. Two of the three named platforms in the
brief (Krystal, Revert) turn out to have **NO gap** because they never take custody.

| Class | Custody model | Visible to DefiDesh today? | Work to support | Canonical example |
|---|---|---|---|---|
| **1. Operator / approval** | Position NFT stays in the user's **own EOA**; the manager holds only an operator approval | **YES — already visible** | ~0 (verify only) | Krystal auto-rebalance, Revert auto-compounder |
| **2. Per-user smart-contract wallet** | A per-user contract (CREATE2) **holds** the real AMM position NFT; EOA owns nothing | **NO — invisible** | MEDIUM (derive the sub-account address, then re-use existing readers) | **vfat Sickle**, DefiTuna (already built) |
| **3. Pooled vault + fungible receipt** | Funds pooled into a shared position; user's EOA holds an **ERC-20/Move share token** | **PARTIALLY** — token balance seen on Token Holdings, but not valued as an LP position | MEDIUM per protocol (`shares × sharePrice`) | **Kamino Liquidity (queued Part 4)**, Arrakis, Gamma, Beefy CLM, Cetus Vaults |

**Highest-value, easiest win: vfat (Class 2).** ~$30.9M live TVL, and — crucially —
once the per-user Sickle address is derived, the positions inside it are ordinary
Uniswap-V3 / Aerodrome / Velodrome NFTs that **DefiDesh's existing routes already
decode**. It reuses more existing code than any other candidate.

---

## Class 1 — Operator / approval model → ALREADY VISIBLE (no gap)

These platforms were named in the brief as suspected wrappers. They are **not**
wrappers in the custody sense. The AMM position NFT is minted to and **owned by the
user's own EOA**; the manager is granted only an operator role
(`setApprovalForAll` / `NonfungiblePositionManager` approval) to rebalance/compound
on the user's behalf. The NFT never leaves the wallet.

**Consequence:** DefiDesh's existing Uniswap-V3 / Aerodrome / Velodrome routes
`balanceOf`-scan the EOA and **already see these positions**. There is no missing-
position class here. This is the same finding-discipline as the Fusion investigation:
we confirmed the mechanism before assuming a gap.

### Krystal (multi-chain LP management)
- **Custody:** Operator model. Docs: users retain the NFT in the
  `NonfungiblePositionManager`; automation is revoked via
  `setApprovalForAll(V3 Automation Address, false)`. Krystal deposits/withdraws/
  swaps "on the user's behalf," positions stay user-owned.
- **Chains / wraps:** Ethereum, Arbitrum, Base, BNB, Optimism, Polygon — **Uniswap
  V3** (and V3 forks). All chains/AMMs DefiDesh already supports on EVM.
- **API:** Yes — Krystal Cloud DeFi Data API exists (not needed if positions are
  already EOA-visible).
- **Usage:** Real product, active marketing; but its managed positions are counted
  as the *user's* Uniswap TVL, not Krystal's. The `krystal` DefiLlama slug shows only
  **~$192k** — that is the separate custodial **Liquidity Vault** product (see Class 3
  note below), not the operator business.
- **Action:** **None to add support.** Recommend a one-wallet verification eyeball:
  find a wallet with an active Krystal auto-rebalanced Uniswap V3 position and confirm
  DefiDesh already renders it. If it does not, that is a bug in the *existing* Uniswap
  route, not a new wrapper sprint.
- ⚠️ **Caveat:** Krystal *also* ships a custodial **Liquidity Vault** ("smart contract
  that holds and actively manages multiple LP assets"). That product IS Class 2/3-shaped
  and invisible — but at ~$192k TVL it is negligible. Not worth building.

### Revert Finance (Uniswap V3 position management)
- **Custody:** Operator model. The auto-compounder is set as **operator** on the
  position; "you can manage your position as normal, add/remove liquidity, collect
  fees" — the NFT stays in the user's wallet.
- **Chains / wraps:** Uniswap V3 (+ forks) on mainnet/L2s. Already DefiDesh-supported.
- **API:** Has a public analytics API, but irrelevant — positions are EOA-visible.
- **Usage:** Well-known in the Uni-V3 power-user niche; long-standing.
- **Separate product — Revert Lend:** an actual lending vault (borrow against a
  Uni-V3 position). That is a *lending* integration (AAVE-shaped), NOT an LP wrapper,
  and out of scope for this sprint. Only relevant if a DefiDesh user reports one.
- **Action:** **None to add support.** Same verification eyeball as Krystal.

> **Net for Class 1:** the two headline platforms in the brief require **zero build**.
> The correct deliverable is a verification test, not a sprint. This is the survey's
> most important cost-avoidance finding.

---

## Class 2 — Per-user smart-contract wallet → INVISIBLE (the real gap)

This is the DefiTuna shape, now found on EVM.

### vfat.io / Sickle  ★ TOP CANDIDATE ★
- **Custody:** **Sickle is a per-user smart-contract wallet** deployed by
  `SickleFactory` the first time a user opens a position on a chain (one Sickle per
  user per chain). The LP positions live under the **Sickle address**, not the EOA —
  so DefiDesh's EOA `balanceOf` scan sees **nothing**, exactly the wrapper-invisibility
  problem this sprint exists to solve. ("Self-custody" in vfat's marketing means the
  user controls the Sickle, NOT that the position sits in the EOA — do not conflate the
  two, same lesson as the Fusion "self-custody" wording.)
- **Chains / wraps:** ~18 chains (Base, Optimism, Arbitrum, Ethereum, Polygon, Linea,
  Mode, Mantle, BNB, Sonic, Avalanche, Unichain, Fraxtal, Katana, …). Wraps positions
  on the **exact AMMs DefiDesh already decodes** — Aerodrome (Base), Velodrome (OP),
  Uniswap V3, and other V3 forks — via "Liquidity Connectors." **Base is the heartland.**
- **API:** No first-class per-user position API found. Discovery is **on-chain**, which
  is fine and actually clean:
  - `SickleFactory` deploys via **CREATE2** (deterministic). The user→Sickle mapping is
    resolvable either by a factory view (e.g. a `sickles(owner)` / `getSickle(owner)`
    getter) **or** by re-deriving the CREATE2 address from
    `(factory, salt, initCodeHash)`. `SickleStorage` holds an `owner` field.
  - ⚠️ **Must confirm on-chain before building:** the exact salt input (owner address
    vs. an internal nonce) and whether a public factory getter exists. This is a small
    verification, and a **free option worth taking first** — a factory getter collapses
    discovery to one `eth_call`.
- **Usage — REAL, and the strongest of any new candidate:** DefiLlama current TVL
  **≈ $30.86M** (verified via `api.llama.fi/tvl/vfat.io`). Live across 18 chains,
  concentrated on Base. This is genuine, large-scale adoption on-chain, not marketing.
  (Note: an early WebFetch mis-summarised vfat as a dead ~$419 Fantom protocol — that
  was the small model reading only the Fantom sub-series; the authoritative single-value
  TVL endpoint returns ~$30.9M. Flagging so the wrong number does not propagate.)
- **Complexity: MEDIUM.** The elegance: **once the Sickle address is resolved, the
  positions inside are ordinary Aerodrome/Velodrome/Uniswap-V3 NFTs that DefiDesh's
  existing routes already read.** The new work is (a) derive/lookup the per-user Sickle
  address per chain, (b) point the existing EVM position readers at that address instead
  of (in addition to) the EOA, (c) attribute the positions back to the user. No new
  fee-math, no new tick decoder, no new pricing path — it rides the existing EVM CLMM
  pipeline. Reuses more existing code than Kamino Part 4. Rule 2 clean (no per-chain
  branch: "scan the user's Sickle sub-account" is a uniform helper, like DefiTuna's
  authority-offset discovery).
- **Closed-position category:** Class B on EVM (NFT persists after close, held by the
  Sickle) — closed positions are reachable via the existing `evmEverOwnedNftIds` helper
  pointed at the Sickle address. Consistent with architecture Rule 5.

#### vfat / Sickle — on-chain deep-dive (VERIFIED live on Base, 2026-07-28)

All facts below were confirmed against verified source (`vfat-io/sickle-public`
`contracts/SickleFactory.sol`) AND live Base RPC (Alchemy). Discovery needs **no log
enumeration** — that is only DefiLlama's global-TVL path and is blocked on the free tier
anyway (Alchemy caps `eth_getLogs` at 10 blocks; Etherscan V2 account/log modules need a
paid plan on Base). Per-user discovery is pure-compute + one `eth_call`, fully free-tier-safe.

- **Base SickleFactory:** `0x71D234A3e1dfC161cc1d081E6496e76627baAc31`
  (source of truth: DefiLlama's production `projects/vfat/config.js`, which computes the
  ~$30.9M TVL from it). **Factory address is NOT uniform across chains** — OP
  `0xB4C31b0f0B76b351395D4aCC94A54dD4e6fbA1E8`, Arbitrum
  `0x53d9780DbD3831E3A797Fd215be4131636cD5FDf`, Ethereum `0x9D70…7F95`, etc. → a per-chain
  config map is required (Rule 2 compliant: config parameter, not client-code branch).
- **Sickle implementation (Base, EIP-1167 master):** `0xFfF75D099baeE29F447866bC5299Cd67C04761C8`
  (read live from `factory.implementation()`, a `public immutable`).
- **Public per-user getters (both confirmed live on Base):**
  - `sickles(address owner) → address` — the DEPLOYED Sickle, or `0x0` if the user has
    never opened a vfat position on that chain. **Verified: returns `0x0` for non-users**
    (negative control ✅).
  - `predict(address owner) → address` — the deterministic address whether or not deployed.
- **Salt / derivation (confirmed from source, line 81-82 / 117-118):**
  `Clones.cloneDeterministic(implementation, keccak256(abi.encode(owner)))` — salt is the
  **owner EOA only** (not approved, not referral). Source comment (line 185): *"owner is
  used as a salt, so all the Sickle addresses can be pre-computed."*
- **Offline reproduction — 3/3 MATCH ✅:** re-deriving the address off-chain via viem
  `getCreate2Address({ from: factory, salt: keccak256(abiEncode(owner)), bytecodeHash:
  keccak256(EIP1167_initcode(implementation)) })` produced byte-identical results to the
  on-chain `predict(owner)` for three arbitrary owners. **DefiDesh can compute a user's
  Sickle address with zero RPC**, then a single `sickles(owner)` call (or `getCode` at the
  predicted address) tells whether it is live.
- **Wrapped protocols (from the repo's connector registries):** Aerodrome, Velodrome,
  Uniswap V3, Curve, Ichi, Ramses, Nuri, Thena, Kodiak, Fenix, Shadow, Swapx (gauges + CL).
  **Aerodrome / Velodrome / Uniswap V3 are already fully decoded by DefiDesh.** Base config
  also pins the V3 `NonfungiblePositionManager` (`0x827922686190790b37229fd06084350E74485b72`)
  and a `masterchefV3` — the NFTs the Sickle holds/stakes.
- **Deploy event** (enumerate-all, NOT needed by DefiDesh): `Deploy(address indexed owner,
  address sickle)`, topic0 `0xb1a29087760d8e8f9b263f598962f752e7bd23badd44897e2966d376d1a59dca`.

#### vfat / Sickle — LIVE regression verification through DefiDesh's OWN readers (2026-07-28)

Proved end-to-end that a hidden Sickle position surfaces **through DefiDesh's existing,
unmodified `/api/aerodrome` reader** with numbers exact to the digit. This is the DefiTuna
third-party-wallet discipline applied to vfat.

**Regression wallet (primary — use for the build):**
`owner 0xD4bE1ae0f492CC58d6353BBb43CDb1D718eedb87`
→ `Sickle 0x06C3F4125E7d2d139D0Ab6a73c2112b7E949e09f`
(WETH/USDC ~$4.9k open + USDC/cbBTC closed).

Four-step live proof:
1. **Discovery:** `factory.sickles(0xD4bE…)` returned `0x06C3…e09f` exactly — the getter
   resolves the real user's hidden sub-account. ✅
2. **The gap (what users see today):** DefiDesh's readers pointed at the OWNER EOA directly
   → `/api/aerodrome` count 0, `/api/uniswap/v3` count 0. The positions are invisible. ✅
3. **Surfaced:** the SAME unmodified `/api/aerodrome` reader pointed at the Sickle →
   2 positions (WETH/USDC In Range, USDC/cbBTC Closed). ✅
4. **Accuracy (exact):** independent Uniswap-V3 TickMath recompute from the pool's live
   `slot0` + the NFT's on-chain liquidity/range, **pinned to the same block (49202079)**,
   matched DefiDesh to the last digit: WETH `0.480116` vs `0.480116` (0.00%), USDC
   `3998.4744` vs `3998.474372` (0.00%), total `$4904.64` vs `$4904.64` (0.00%). (A first
   pass showed ~4% gaps that were purely live-price drift between non-simultaneous reads —
   the pool ticked -200870→-200895 across calls; DefiDesh re-reads live state each request.
   Same-block pinning removed it entirely.) ✅

**Secondary regression wallets found** (12 funded Sickles across ~400k recent Base blocks):
- `0xfF4cC6E0…` → `Sickle 0x763D86d5…` — msUSD/USDC ~$1.07k open (+ others). "msUSD"
  resolves cleanly.
- `0xF5cF8C1F…` → `Sickle 0x3a9b64b1…` — ~$188 single open.
- `0xA663d663…` → `Sickle 0xFB8E0c97…` — dust ($0.01), but **exposed a token-resolution
  gap**: two CLOSED positions render `TOKEN0` placeholder symbols (unresolved mints on
  pools `0x948e80fb…` and `0xcf88b8bf…`). Low impact (closed, $0) but a build-phase item —
  likely an obscure/delisted token the resolver can't map.

**Two residual checks for the BUILD phase (not blockers):**
1. **Gauge-staked-through-a-Sickle:** every funded Sickle sampled held its Slipstream CL
   NFT DIRECTLY (`NPM.ownerOf == Sickle` / `balanceOf ≥ 1`) rather than staked into a
   gauge, so the gauge-staked path was not specifically eyeballed via a Sickle. DefiDesh's
   Aerodrome (Sugar) reader already surfaces gauge-staked positions for normal wallets and
   is address-agnostic, so risk is low — but confirm once with a Sickle that has a staked
   position.
2. **Token-resolution placeholder** (`TOKEN0`) on long-tail closed positions — verify the
   resolver covers them or degrades cleanly (Option A "price unavailable"), same as any
   direct-wallet long-tail token.

**Complexity re-confirmed: MEDIUM overall; the DISCOVERY sub-part is SMALL.** Discovery =
compute `predict(owner)` per configured EVM chain (pure math) + one `sickles(owner)`/`getCode`
call. The remaining work is pointing DefiDesh's EXISTING Aerodrome/Velodrome/Uniswap-V3
position readers (they already accept an arbitrary `?account=` address) at the Sickle
address in addition to the EOA, attributing positions back to the user, and deduping.
Staked-in-gauge positions ride the Aerodrome route's existing gauge handling. No new
fee-math, tick decoder, or pricing path. Closed positions via `evmEverOwnedNftIds` pointed
at the Sickle. **One open verification remains for the build phase, not now:** confirm a
*real* deployed Base Sickle actually surfaces its inner positions through the existing
readers (all three arbitrary test owners were non-users → `0x0`; a real vfat Base user or
a Sickle pulled from a Deploy log would be the regression wallet, mirroring the DefiTuna
third-party-wallet approach).

---

## Class 3 — Pooled vault + fungible receipt token → PARTIALLY VISIBLE (Kamino-shaped)

These pool many users' funds into one shared AMM position and issue the depositor a
**fungible share token** (ERC-20 on EVM, Move coin on Sui/Solana) that **sits in the
user's own wallet**. DefiDesh's Token Holdings page therefore **already sees the token
balance**, but shows it as an unpriced/opaque token rather than a valued LP position.
This is **exactly the Kamino Liquidity shape already queued as Part 4** — the work is
valuation (`user shares × share price`, share price from the vault's on-chain holdings ÷
supply), not discovery. Each protocol is an independent MEDIUM the same size as Part 4.

Ranked by verified TVL (broad-protocol slugs; a fraction is on DefiDesh-supported AMMs):

| Protocol | Chains | Wraps | TVL (verified) | Receipt | Notes |
|---|---|---|---|---:|---|
| **Arrakis Finance** | EVM (many) | Uniswap V3 (+ forks) | **≈ $60.3M** | ERC-20 vault token | Largest EVM ALM found. Much is on non-DefiDesh AMMs; only the Uni-V3-fork slice is in scope |
| **Gamma** | EVM (many) | Uniswap V3 + forks | **≈ $2.85M** (this slug) | ERC-20 (hypervisor) | Historically larger; multi-DEX |
| **Beefy CLM** | EVM (many) | Uni-V3-style CL pools | (broad Beefy TVL; CLM subset) | ERC-20 "Cow/Moo" token | Pooled, 6h range resets |
| **ICHI** | EVM | Uniswap V3 | (moderate) | ERC-20 | Single-sided deposit vaults |
| **Steer** | EVM | Uni-V3-style | (moderate) | ERC-20 | Programmatic strategies |
| **Cetus Vaults** (native) | **Sui** | **Cetus** ✅ | (subset of Cetus TVL) | Move share coin | DefiDesh already supports Cetus — vault shares are the missing valuation layer |
| **Kriya / NODO AI** | Sui | Cetus, Momentum ✅ | small/new | Move share coin | Third-party Sui vaults over already-supported AMMs |
| **Meteora vaults / Loopscale Earn** | Solana | Orca/Meteora | (varies) | SPL share / obligation | Loopscale vaults are lending/looping-shaped, not pure LP |

**Why Class 3 ranks below vfat despite higher aggregate TVL:** (1) each protocol is a
*separate* MEDIUM valuation build (no shared discovery win like Sickle), (2) only the
fraction of each vault's TVL sitting on a **DefiDesh-supported AMM** is addressable —
Arrakis/Gamma spread across many DEXes DefiDesh doesn't track, so the effective
in-scope TVL is much smaller than the headline, and (3) the position is already
*partially* visible (token shows on Token Holdings), so the user-facing gap is
"unvalued token" not "invisible position" — less severe than Class 2's total invisibility.
**Kamino Liquidity (Part 4) is the right first Class-3 build**; the others are
"build the second one only when a real DefiDesh user holds one," proven-demand-gated
exactly like DefiTuna Lending.

---

## Ranking — (real usage × ease of support), best first

1. **vfat / Sickle (Class 2).** ~$30.9M live TVL on DefiDesh's home turf (Base/OP/Arb),
   MEDIUM effort that **re-uses the existing EVM position readers** once the Sickle
   address is derived. Highest usage × lowest marginal effort of any *new* build. **★
   Recommended next wrapper target after the queued DefiTuna/Kamino work.**
2. **Kamino Liquidity (Class 3) — already queued as Part 4.** Confirmed the correct
   shape; no change to its queue position. Establishes the reusable
   `shares × sharePrice` Class-3 valuation path that Arrakis/Gamma/Cetus-Vaults inherit.
3. **Verification-only: Krystal + Revert (Class 1).** Not a build. A single-wallet
   eyeball to confirm DefiDesh already renders operator-managed Uni-V3 positions.
   Near-zero cost, closes the brief's two named platforms definitively.
4. **Arrakis (Class 3).** Largest EVM receipt-token ALM (~$60M) but effort ≈ Part 4
   *per protocol* and only the Uni-V3-fork slice is addressable. Build after Part 4
   proves the Class-3 path, and only with evidence of a real DefiDesh user holding one.
5. **Cetus Vaults / Kriya / NODO (Class 3, Sui).** DefiDesh already supports the
   underlying AMMs (Cetus, Momentum); the gap is share-token valuation. Reasonable once
   the Class-3 path exists and a Sui user is seen holding vault shares.
6. **Gamma / Beefy CLM / ICHI / Steer / Meteora / Loopscale.** Real but smaller
   in-scope TVL and/or lending-shaped. **Proven-demand-gated** — do not speculatively
   build.

---

## Low-priority speculation flags (same discipline as the Fusion investigation)

- **Krystal & Revert as "wrappers": FALSE PREMISE.** They do not custody positions.
  Building "support" would duplicate positions already rendered by the Uniswap route and
  risk double-counting (wallet-security Rule 3 duplicate hazard). Do **not** build; verify.
- **vfat "dead protocol" mis-read: CORRECTED.** One tool summary suggested ~$419 TVL
  (Fantom-only sub-series). Authoritative TVL is **~$30.9M** — do not let the wrong
  figure kill a strong candidate.
- **Arrakis/Gamma headline TVL is NOT addressable TVL.** Most sits on AMMs DefiDesh
  doesn't track. Rank on the in-scope (Uni-V3-fork) slice, which is far smaller.
- **Loopscale / Revert Lend are lending-shaped, not LP wrappers.** If they surface,
  they belong in the lending pipeline (AAVE/Suilend-shaped), not this sprint.

---

## Recommended next steps (no code without confirmation)

1. **vfat Phase A deep-dive (small, on-chain):** confirm the `SickleFactory` address on
   Base, whether a public `owner → Sickle` getter exists, and the CREATE2 salt input.
   That single check turns discovery into one `eth_call` and firms the MEDIUM estimate.
   A DefiDesh user with a Sickle would be the ideal regression wallet — otherwise use a
   known active Sickle from BaseScan as a third-party regression wallet (DefiTuna precedent).
2. **Class-1 verification test:** one Krystal/Revert-managed Uni-V3 wallet through
   DefiDesh to prove already-visible (or surface an existing-route bug).
3. **Hold Class 3** behind Kamino Part 4 shipping + proven per-protocol user demand.

**Stop-and-report. Awaiting confirmation before any implementation.**

---

### Sources
- vfat Sickle docs — https://docs.vfat.io/sickle/ ; vfat.io — https://vfat.io/
- vfat TVL — https://api.llama.fi/tvl/vfat.io (≈ $30.86M) ; DefiLlama protocol page — https://defillama.com/protocol/vfat.io
- vfat Sickle audit (CREATE2 / connectors / SickleStorage owner) — https://omniscia.io/reports/vfat-sickle-contracts-678fbcce38f52b001894a175/
- Krystal auto-rebalance (operator model) — https://docs.krystal.app/products/liquidity-management/lp-management/lp-transactions/auto-rebalance ; security/revoke — https://docs.krystal.app/liquidity-farming/security ; Krystal Vault — https://docs.krystal.app/products/vaults/what-is-liquidity-vault ; Krystal TVL — https://api.llama.fi/tvl/krystal (≈ $192k)
- Revert auto-compounder (operator model) — https://docs.revert.finance/revert/technical-docs/auto-compounder ; user guide — https://docs.revert.finance/revert/auto-compounder/user-guide ; Revert Lend — https://docs.revert.finance/revert/technical-docs/revert-lend
- Arrakis TVL — https://api.llama.fi/tvl/arrakis-finance (≈ $60.3M) ; Gamma TVL — https://api.llama.fi/tvl/gamma (≈ $2.85M)
- Beefy CLM (receipt token) — https://docs.beefy.finance/beefy-products/clm ; ICHI — https://defillama.com/protocol/ichi
- Cetus Vaults (Sui) — https://github.com/CetusProtocol/cetus-sdk-v2/blob/main/packages/vaults/README.md ; Kriya vaults — https://docs.kriya.finance/kriya-strategy-vaults/clmm-lp-optimizer-vaults/vault-strategy-auto-rebalancing-and-compounding
- Solana context (Kamino/Meteora/Loopscale vaults) — https://solana.com/news/solana-ecosystem-roundup-june-2026 ; https://solanacompass.com/projects/loopscale

---

# APPROVED PHASE B BUILD PLAN — vfat / Sickle

**Status:** APPROVED, not yet built. Recorded 2026-07-31.
**Scope:** implements the vfat/Sickle candidate investigated above (see
"vfat.io / Sickle ★ TOP CANDIDATE ★" and the two verification sections). This
section is the authoritative build spec; the sections above are the evidence
it rests on.

**Origin note:** the Phase A investigation above was produced in this repo and
is on disk. The plan below was agreed in a separate Claude conversation that
was never written to a file — it is transcribed here verbatim in substance so
the decision record survives. Nothing in this section was inferred or invented;
where the plan is silent, it says so.

## 1. Discovery method

Use the on-chain `sickles(owner)` getter as **primary**. The offline CREATE2
`predict()` derivation — proven 3/3 against on-chain in Phase A — is a
**documented future optimization, NOT MVP**. Rationale: `sickles()` returns
`0x0` for non-users, so one call answers both "what is the address" and "does
it exist"; the offline path is an RPC-count optimization we can adopt later
without changing any consumer.

## 2. Chain scope

**All four chains with confirmed factories at once — Base, Optimism, Arbitrum,
Ethereum.** Not phased by chain. Factory addresses are already confirmed in the
Phase A deep-dive above:

| Chain | SickleFactory |
|---|---|
| Base | `0x71D234A3e1dfC161cc1d081E6496e76627baAc31` |
| Optimism | `0xB4C31b0f0B76b351395D4aCC94A54dD4e6fbA1E8` |
| Arbitrum | `0x53d9780DbD3831E3A797Fd215be4131636cD5FDf` |
| Ethereum | `0x9D70…7F95` (**truncated in the Phase A record — must be resolved to the full address during the build's investigation phase**) |

The factory address is **not uniform across chains**, so a per-chain config map
is required. That is a config parameter, not a client-code branch — architecture
Rule 2 compliant.

## 3. New files

- **`app/lib/vfatConfig.ts`** — per-chain factory address config. A plain map
  (config-not-branch, Rule 2).
- **`app/api/vfat/sickles/route.ts`** — `GET ?owner=0x..` →
  `{ sickles: [{ chain, address }] }`, **deployed Sickles only**. One `eth_call`
  per configured chain to `factory.sickles(owner)`, issued in parallel;
  non-zero results only.
- **`app/lib/vfatSickle.ts`** — client-side wrapper that calls the route above.

## 4. Pipeline integration

In `app/contexts/PositionsContext.tsx`, resolve Sickle addresses for the
effective EVM owner set — connected + watched EOAs, **and the scanned EVM
address in scan mode too**. Build:

```
evmFetchAddresses = dedup(evmAddresses ∪ resolvedSickles)
```

and use that expanded set for the EVM fetcher fan-out (the existing
`for (const a of evmAddresses)` loop that pushes Aerodrome / Uniswap V3 /
Velodrome / HyperEVM / PancakeSwap source queries).

**Approved decision — use the SIMPLE version:** scan each resolved Sickle
address against **ALL** EVM fetchers/chains, exactly how watched wallets already
work today. A precise per-chain-only fan-out (only querying the chain a given
Sickle was found on) is noted as a **future optimization, not required for MVP**.

## 5. Non-blocking resolution

Sickle resolution must be **async and non-blocking**. EOA positions render
immediately at the existing ~1–4 s baseline; Sickle positions stream in
progressively behind them. This is architecture Rule 10 — the expanded address
set must never gate the first paint of the positions array.

## 6. Attribution and dedup

- Dedup via a **lowercased Set union**, so a user who has already added their
  own Sickle address as a watched wallet is not queried twice.
- Position-level collisions are impossible: a Sickle address ≠ its owner EOA,
  and NFT ids are unique per position.
- **CRITICAL:** a Sickle address must **NOT** appear as its own wallet chip in
  the UI. It is a derived sub-account, not something the user added. Keep
  `evmFetchAddresses` (used ONLY for the fetch fan-out) completely separate from
  `evmAddresses` (used for identity, wallet chips, and `/api/wallets/register`),
  so the existing wallet-chip and registration rules are untouched.

## 7. Closed positions

**IN SCOPE for Phase B, not deferred.** Sickle-held closed positions surface via
the existing `evmEverOwnedNftIds` mechanism pointed at the Sickle address — this
was already verified in the Phase A regression test, where Capital G/L correctly
picked up the closed USDC/cbBTC leg on the primary regression wallet. No
separate phase needed.

## 8. Cache versioning

- **NO bump** to `lp-pnl-events` or `analytics-activity`. Sickle positions are
  simply new per-position entries keyed by their own id/URL; no existing cached
  entry changes shape. Same reasoning as DefiTuna Phase 1's "no cache bumps".
- **NEW key `vfat_sickles_v1`** for the Sickle-resolution results themselves:
  cache a **deployed** Sickle address long/permanently (immutable once created);
  cache a **"no Sickle found"** result **short (~5 min)**, so a newly-created
  Sickle appears on a later load without a long wait.

## 9. Degrade behaviour (Rule 11)

If the RPC call for a given chain fails, that chain simply contributes **no
Sickle result for this load**. Never throw, never block the rest of the page.

## 10. Residual verification checks — SHIPPING GATES, not follow-ups

Both were raised in Phase A and are **gates for shipping Phase B**:

- **(a) Gauge-staked-through-a-Sickle.** Confirm a gauge-staked position held
  through a Sickle surfaces correctly via the existing Aerodrome/Velodrome
  reader (which already handles staked positions for normal wallets and is
  address-agnostic). Expected to be a **confirmation, not new code** — but must
  be verified against a real staked-through-Sickle position before shipping.
- **(b) Long-tail token resolution.** Confirm long-tail/unusual tokens on
  Sickle-held positions either resolve correctly or degrade cleanly to "price
  unavailable" with correct symbol/decimals — **never wrong data**. Re-check the
  specific dust-Sickle case found in Phase A (pools `0x948e80fb…` /
  `0xcf88b8bf…`, which rendered `TOKEN0` placeholders).

## 11. Verification / commit gate

- **Primary regression wallet:** owner
  `0xD4bE1ae0f492CC58d6353BBb43CDb1D718eedb87` →
  Sickle `0x06C3F4125E7d2d139D0Ab6a73c2112b7E949e09f`
  (WETH/USDC ~$4.9k open + USDC/cbBTC closed). Confirm the position appears
  through the dashboard, the value matches the exact-block figure already
  verified in Phase A (WETH `0.480116`, USDC `3998.474372`, total `$4904.64`),
  and Capital G/L correctly picks up the closed USDC/cbBTC leg.
- **Negative control:** an EVM wallet with no Sickle shows no change and no
  errors.
- **Build clean** (`npm run build`), **performance baseline intact** — EOA
  positions still render at ~1–4 s, Sickle positions stream in behind without
  blocking.
- **Both residual checks (10a, 10b) confirmed before shipping.**

## Explicitly out of scope for Phase B

Recorded so it is not re-litigated or quietly widened during the build:

- Offline `predict()` CREATE2 derivation as the discovery path (§1 — future
  optimization).
- Precise per-chain-only fetcher fan-out (§4 — future optimization).
- Chains beyond the four with confirmed factories (vfat runs on ~18).
- The non-Aerodrome/Velodrome/Uniswap-V3 connectors vfat supports (Curve, Ichi,
  Ramses, Nuri, Thena, Kodiak, Fenix, Shadow, Swapx) — DefiDesh does not decode
  those AMMs today, and adding them is a separate protocol-integration effort.
- Enumerating all Sickles globally via the `Deploy` event (needed only for
  protocol-wide TVL, never for per-user discovery, and blocked on the free tier).
