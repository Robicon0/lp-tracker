# Pricing Invariants

These rules govern every USD valuation in DefiDesh. They are non-negotiable
unless explicitly amended here. Every fix that touches pricing must conform.

## Core principle

DefiDesh values positions and fees in USD for any wallet on any chain. Every
chain's RPC capabilities differ; pricing rules must work uniformly across
all chains without per-chain branches in client code. Conservative parameters
accommodate the slowest chain.

---

## Display currency

All internal calculations and storage are in USD. USD is the canonical unit
for fee valuation, capital G/L, IL, portfolio value, and any other monetary
quantity computed inside DefiDesh.

Display-currency conversion happens at the UI layer only. Pricing logic is
never re-run in a different base currency.

### Current state
Only USD is displayed.

### Future state
When additional display currencies are added (EUR, GBP, INR, JPY, SAR, AED,
or any other), the conversion will happen at render time via a single FX
rate lookup. Pricing rules below do not change.

### Why this matters
Re-running pricing logic in a non-USD base would multiply the surface area
of every pricing rule by the number of supported currencies. By keeping FX
conversion at the UI layer, adding a new currency is a one-file change.

---

## Rule 1: Fee claim USD valuation

For all fee claims on all protocols on all chains:

- **Non-stablecoin tokens** (HYPE, SUI, SOL, ETH, etc.): use CoinGecko
  historical daily price at the claim timestamp.
- **Stablecoins** (USDC, USDT, DAI, etc.): always = $1.
- **Never** use sqrtPriceX96 or current spot price for fee claim valuation.
- **Never** add hardcoded fallback prices to `/api/prices`. This broke all
  position values to $0.00 in a prior incident.

### Rule 1a: Unresolved fee claims are marked, never spot-valued

If a fee claim's designated historical price is unavailable (cache miss,
rate-limit, fetch timeout, or no token mapping), the claim **must be marked
unresolved** — its USD value stays `null`. Falling back to current spot is
**forbidden for fee-claim valuation under all circumstances on all chains**,
including when every historical tier has failed. An unresolved claim:

- Contributes **$0** to confident lifetime-fee totals (excluded from the sum —
  not coerced to $0, not estimated from spot).
- Is **surfaced to the user** as "N claims pending price resolution" — never
  silently dropped, never shown as a confident value.
- Emits a `fee_claim_resolution` [PRICE_LOG] event with `source: "unknown"`
  and reason `cg-historical-cache-miss-no-spot-fallback`, and sets
  `route_summary.claim_pricing_succeeded` to `false`.

Rationale: a claim collected weeks ago valued at today's spot systematically
mis-reports lifetime fees. Account 2's ProjectX HYPE/USDC over-reported
$2,243.69 vs a manual $1,780.44 (+26%) precisely because ~20 historical claims
fell through to current spot (~$63/HYPE) instead of claim-date price
(~$41.73/HYPE). Reference: Sprint 1.5.

This forbids spot as a **fallback**. It does **not** override an exception
that *designates* spot as a claim's primary method (e.g. the CETUS reward
token below uses spot + LKG by design — that is the designated source, not a
fallback). It also does not touch Rule 2: the spot last-resort for deposits/
withdrawals stays allowed, because those are point-in-time position values,
not historical earnings.

### Rule 1c: Claim-date historical has TWO sources (CoinGecko, then DeFiLlama)

Claim-date historical pricing is resolved from two sources, in order. **Both are
claim-date historical — Rule 1a applies unchanged to each; neither may ever fall
back to current/spot for a claim.**

1. **CoinGecko historical (PRIMARY)** — `app/lib/cgPriceHistory.ts`
   `fetchTokenPriceAtDate(coingeckoId, ts)`, wrapped by the Sprint 1.6 Upstash
   Redis tier. Keyed by CoinGecko id; used wherever a token has a CoinGecko id.

2. **DeFiLlama historical-by-contract (SECONDARY, Sprint 1.12)** —
   `app/lib/defillamaPriceHistory.ts`
   `fetchDefillamaPriceAtDate(chain, contract, ts)` →
   `coins.llama.fi/prices/historical/{ts}/{dlChain}:{contract}`, wrapped by its
   own Redis namespace (`price:historical:defillama:...`). Keyed by on-chain
   CONTRACT / MINT / COIN-TYPE, so it prices the long-tail CoinGecko can't map
   to an id (broad Sui/Solana coverage; **DeFiLlama has NO HyperEVM/`hyperliquid`
   coverage** — verified Sprint 1.12, so HyperEVM claims still rely on CoinGecko).

If BOTH miss, the claim stays **pending** (Rule 1a) — never spot-valued.

**DeFiLlama *current* price is NEVER a claim source.** `defillamaPriceHistory.ts`
calls only the `/prices/historical/{ts}/...` endpoint with the claim's OWN
timestamp, and accepts a returned point only within the same UTC day (±24h) of
the claim (else treats it as missing). DeFiLlama's *current* endpoint
(`/prices/current/...`) is used elsewhere ONLY as a tokenResolver coverage check
(Sprint 1.10) and must not value a claim. Production signals:
`defillama_historical_used` / `_missing` / `_error` (instrumentation.md).

Per-route shape: Solana routes (orca/raydium, Sprint 1.12) use DeFiLlama-by-mint
as the PRIMARY claim-date source — no CoinGecko-historical path is wired into them
— replacing the prior current-spot/zero fee-side fallback (a Rule 1a improvement).
**Cetus (Sprint 1.15)** values fee claims historical-ONLY, per side: stablecoin →
$1; SUI side → CoinGecko historical then DeFiLlama historical; any other non-stable
side → DeFiLlama historical; if a side can't be priced historically the claim
stays pending. The prior current-spot / "FIX-A" cg-spot fee-claim fallback is
REMOVED — there is NO spot path for Cetus fee claims. **Bluefin (Sprint NEW)** now
follows the identical historical-ONLY cascade as Cetus: stablecoin → $1; SUI side →
CoinGecko historical then DeFiLlama historical-by-coin-type; any other non-stable
side → DeFiLlama historical; else pending. The current-spot `fallbackA`/`fallbackB`
last resort is REMOVED for Bluefin fee claims — there is NO spot path for them
either. **Momentum** is dashboard-only (no activity/fee-claim valuation route
exists yet — it is an unsupported protocol in the P&L pipeline); the same
historical-only cascade will be built into its activity route when that route is
created (sprint queue). With Bluefin fixed, **no protocol on any chain values a fee
claim at spot** — Rule 1a is fully enforced platform-wide. Reward claims on every
Sui route are NOT routed through DeFiLlama: the CETUS reward token's spot+LKG path
(below) is a separate, designated exception and is preserved; Bluefin reward events
carry no coin type and keep their separate symbol-matched path (untouched this
sprint — empirical historical migration deferred, same caution as the CETUS
exception).

### Exceptions to Rule 1

**CETUS reward token (Sui)**
- Use CoinGecko **spot** price + sticky process-wide last-known-good (LKG) cache.
- Reason: paced-historical path saturates CoinGecko's shared per-IP budget
  (16+ retry calls), starves SUI/CETUS spot fallbacks, drops resolution to
  46/78 at 200s latency.
- With spot + LKG: 81/81 stable under 4× concurrent burst.
- Reference: commit 26fd213.
- Revisit if paid CoinGecko key is added.
- **Excluded from the Upstash Redis persistent price cache (Sprint 1.6).** That
  cache (`app/lib/redisPriceCache.ts`) wraps only the CoinGecko *historical*
  path in `cgPriceHistory.ts`. CETUS reward valuation runs through the separate
  spot + process-local LKG path and never calls that function, so it is excluded
  by construction — no per-chain branch needed. This is intentional: caching a
  CETUS price in Redis would defeat the process-local LKG mechanism, which
  exists precisely because historical is unreliable for this token.

**HyperEVM closed positions (HyperSwap, KittenSwap, ProjectX)**
- Use CoinGecko historical **awaited** (not fire-and-forget).
- Reason: HyperEVM has no archival eth_call. Chainstack returns -32002
  "Archive Debug Trace not available on plan." Public RPC is non-archival
  for state. sqrtPriceX96 resolver cannot run.
- Open positions on HyperEVM may use fire-and-forget for performance.
- Reference: commit be94edf, dae0599.

---

## Rule 1b: CLMM pending-fee underflow guard

For **all** Uniswap-V3-style concentrated-liquidity (CLMM) protocols on all
chains (Orca, Raydium, Bluefin, Cetus, Momentum, HyperSwap/KittenSwap/ProjectX,
Uniswap V3, Aerodrome, Velodrome, PancakeSwap), the pending-fee calculation
`(feeGrowthInside − checkpoint)` is an unsigned u128 (or u256) masked
subtraction and **must guard against underflow**.

In correct operation the per-position fee-growth delta is a small **positive**
number — `feeGrowthInside` only grows while in range, so it is ≥ the stored
checkpoint. But for an **out-of-range position** the recomputed
`feeGrowthInside` can land marginally **below** the checkpoint; the masked
subtraction then wraps into the upper half of the word (~2^128) instead of
producing a small negative. Multiplied by liquidity and scaled by
decimals × price, that wrap yields **implausible (sextillion-scale) USD fees**.

### The invariant
- If the wrapped `(feeGrowthInside − checkpoint)` has its **high bit set**
  (≥ 2^127 for u128), it is an underflow → that side's pending fee is **0**,
  not the wrapped value. A legitimate accrual can never reach 2^127 (that would
  imply ~2^63 fee-units per unit of liquidity).
- Settled, already-owed fees (e.g. Orca `feeOwedA/B`) are tracked **separately**
  and are **not** affected by this guard — only the recomputed pending delta is.
- In-range positions satisfy `feeGrowthInside ≥ checkpoint` by construction, so
  the guard never fires for them (no regression).

This is the standard Uniswap-V3 fee-growth-delta semantics. It is a **platform
bug** affecting any user worldwide with any out-of-range CLMM position — never
framed per-wallet. Reference: Sprint 1.7 (Orca first; Raydium/Bluefin/Cetus/
Momentum follow in Sprint 1.7b). A defensive route-boundary plausibility cap
(zero a position's fees and emit `fee_plausibility_exceeded` if total fees
exceed ~$1e12) is the belt-and-suspenders complement to the per-side guard.

---

## Rule 2: Historical P&L, IL, and Initial Value

For deposits, withdrawals, impermanent loss, and initial position value
calculations on **EVM chains**:

- Use on-chain V3 sqrtPrice + tick derivation via `app/lib/v3PriceDerivation.ts`.
- **Never** use CoinGecko historical API for these calculations.
- Reason: sqrtPrice + tick gives deterministic, archival, exact values.
  CoinGecko historical has rate limits, daily granularity, and cannot
  reconstruct exact pool state.

### Exceptions to Rule 2

**HyperEVM**: sqrtPriceX96 resolver cannot run (no archival eth_call).
Fall back to CoinGecko historical awaited for closed positions.

**Sui and Solana**: position objects are destroyed on close. Historical
P&L for closed positions requires event-log reconstruction (see Sprint 3
in the sprint queue).

---

## Rule 3: Stablecoin treatment

Stablecoins always equal $1 USD. This applies everywhere — fee valuation,
deposit/withdrawal valuation, IL calculations, capital G/L.

Tokens currently treated as stablecoins:
- USDC, USDT, DAI, USDC.e, USDbC, USDe, USD0, USDS, FRAX, LUSD, GUSD, PYUSD

Do not add a non-stablecoin to this list without explicit user approval.

---

## Rule 4: Capital G/L formula

For each closed position:

```
Capital G/L = Value Withdrawn (USD at withdrawal time)
            − Value Deposited (USD at deposit time)
```

Total Capital G/L = sum across all closed positions on all chains.

Capital G/L is separate from Fees Collected.

```
Net P&L = Fees Collected + Capital G/L − Impermanent Loss
```

Currently the UI shows "Capital G/L EVM only." Sui and Solana are pending
(Sprint 6 in the sprint queue).

---

## Rule 5: Position display

- Show **all** positions: In Range → Out of Range → Closed (grey/dimmed).
- Closed = liquidity 0.
- **Never** filter zero-liquidity positions.
- Show any position type on any platform: LP, lending, vault, strategy,
  borrowed. Never filter by position type.

---

## Decision tree: "How do I value this?"

**Is it a fee claim?**
- Stablecoin → $1
- CETUS reward token → CoinGecko spot + LKG
- HyperEVM closed position fee → CoinGecko historical, awaited
- Anything else → CoinGecko historical at claim timestamp

**Is it a deposit, withdrawal, or IL calculation?**
- EVM (not HyperEVM) → v3PriceDerivation sqrtPrice + tick
- HyperEVM → CoinGecko historical, awaited
- Sui / Solana closed position → event-log reconstruction (Sprint 3/5)

**Is it a current portfolio value?**
- CoinGecko spot price for all non-stablecoin tokens
- Stablecoins → $1

---

## When to amend this file

Amend pricing-invariants.md when:
- A new exception is discovered and verified (e.g., a new reward token that
  saturates CoinGecko like CETUS does)
- A new chain is added and its RPC capabilities require a new rule
- A pricing rule is proven wrong by production evidence (e.g., 1000+ position
  scan shows systematic error)

Do **not** amend this file to fix a one-off wallet bug. If a single wallet
shows wrong values, the bug is in implementation, not in the rules.
