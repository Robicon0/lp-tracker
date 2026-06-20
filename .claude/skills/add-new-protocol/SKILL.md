---
name: add-new-protocol
description: Use this skill when integrating a NEW DeFi protocol on ANY chain into DefiDesh — a new AMM/CLMM (Uniswap-V3 fork, new Sui or Solana CLMM, an Aptos/Sei AMM), a lending market, or a vault. Triggers include "add a new protocol", "integrate [protocol]", "new AMM on [chain]", "add [chain] support", "wire up [protocol] positions", or any task that creates a new app/api/{protocol}/ route. This skill encodes the Protocol Correctness Contract: every protocol inherits the shared CLMM fee-math guard, tick-decoder coverage, price caching, and full UI-surface coverage — by import and registration, not by memory. Built from the Sprint 1.7/1.7c/1.7d/1.7e lessons.
allowed-tools: Read, Bash, Grep, Glob, Edit, Write
---

# Add a New Protocol

This skill is the checklist for adding any protocol on any chain to DefiDesh.
Its purpose is structural: **the code enforces correctness, not the developer's
memory.** When you add the next protocol you should not have to *remember* the
underflow guard, the decoder verification, the price caching, or the UI surface
coverage — you **import**, **register**, and the platform protects users
automatically.

> The user is the sole developer today but plans to bring on a team. Every shared
> utility, every registered decoder, every line in this skill is "the code
> teaches the next person how to do this right." This is what "world's best LP
> tracker" means architecturally.

---

## The Protocol Correctness Contract (non-negotiable)

A protocol is **integrated** only when ALL of the following hold. A protocol that
satisfies some of these is *half-integrated*, which is a worse user experience
than no integration because users see inconsistency (architecture-principles
Rule 4).

1. **Fee math goes through the shared guard.** Any CLMM pending-fee calculation
   imports `safeCalcPendingFee` from `app/lib/clmmFeeMath.ts`. Inline underflow
   guards and inline `(feeGrowthInside − checkpoint) & MASK` math are forbidden
   in new code.
2. **Tick/fee-growth decoding is verified for every on-chain format.** A guard
   fire is a *signal*, never assumed to mean "fees are zero" (Sprint 1.7c/1.7d:
   the ZEC/USDC underflow was actually an unsupported Orca tick-array format
   hiding ~$141 of real fees).
3. **USD valuation uses the cached, rule-compliant price path** (`fetchTokenPriceAtDate`
   → Redis → CoinGecko historical; pricing-invariants Rules 1/1a/1b).
4. **All positions show** — In Range, Out of Range, Closed (never filter
   zero-liquidity).
5. **Every UI surface is covered** — dashboard, analytics, LP P&L, position
   detail, docs, about, navigation lists.
6. **Wallet security rules apply** — per-chain disconnected flag + watcher for any
   new chain (wallet-security Rule 1).

---

## Step 0 — Identify the protocol family

- **Uniswap-V3-style CLMM** (concentrated liquidity, tick ranges, fee growth):
  follow the CLMM path below. This is the one with the underflow/decoder hazards.
- **V2-style constant-product / stable pool**: no tick math; skip the tick
  registry and `safeCalcPendingFee` (no fee-growth delta). Still do price caching
  + UI surfaces + wallet security.
- **Lending / vault**: model on the existing lending routes; no CLMM utilities.

If unsure, read a sibling route in `app/api/` for the same family.

---

## Step 1 — Create the route

`app/api/{protocol}/route.ts` (positions) and, if it has historical activity,
`app/api/{protocol}/activity/route.ts`. Use raw RPC/fetch + manual decoding
(no chain SDKs in routes). Return the shared position shape
(`{ positions, count, account }`), and a thin lib wrapper in `app/lib/{protocol}.ts`.

---

## Step 2 — CLMM fee math (the guard) — ALL chains

Import and use the shared math. This is chain-agnostic pure bigint math; it works
identically for Solana and Sui:

```ts
import { safeCalcPendingFee, emitFeeUnderflow, calcFeeGrowthInside,
         type UnderflowLogContext } from '../../lib/clmmFeeMath';

const inside = calcFeeGrowthInside(tickLower, tickUpper, tickCurrent,
                                   feeGrowthGlobal, outsideLower, outsideUpper);
const pending = safeCalcPendingFee(liquidity, inside, checkpoint);
emitFeeUnderflow(pending, { protocol, chain, positionId, pair, side: 'token0' });
const totalFee = settledOwedFee + pending.fee;   // settled fees added separately
```

`safeCalcPendingFee` returns `{ fee, guarded, wrappedDelta }`. `emitFeeUnderflow`
emits the `fee_underflow_detected` [PRICE_LOG] event when `guarded` is true — so
you can't forget the instrumentation. **Settled/already-owed fees are added by the
caller and are never touched by the guard.**

---

## Step 3 — Tick decoding (chain-family specific)

The fee math is universal; the **tick decoder is not** — because tick STORAGE
differs by chain family. This is deliberate, not a leaky abstraction.

### Solana CLMMs (binary account buffers) → register into the registry

Solana programs store tick state in binary accounts identified by an 8-byte
Anchor discriminator, and a single program can ship MULTIPLE formats over time
(Orca shipped legacy `TickArray` AND `DynamicTickArray`). Register a decoder per
discriminator at module load:

```ts
import { solanaCLMMTickRegistry, anchorDiscriminator } from '../../lib/clmmTickDecoder';

solanaCLMMTickRegistry.register(
  anchorDiscriminator('TickArray'), 'legacy_fixed',
  (data, localTickIndex) => ({ feeGrowthOutsideA, feeGrowthOutsideB }), // or null if malformed
);
// ...register EVERY known format. Then dispatch:
const decoded = solanaCLMMTickRegistry.decode(data, localTickIndex);
if (decoded === null) { /* log unsupported_tick_array_format, fall back to 0 */ }
```

**Register every known format explicitly** so a NEW on-chain format fails LOUDLY
(`unsupported_tick_array_format` event) instead of silently zeroing fees.

### Sui CLMMs (Move `Table` of JSON dynamic fields) → NO registry

Sui CLMMs (Bluefin, Cetus, Momentum) store ticks in a Move `Table`; you fetch each
tick with `suix_getDynamicFieldObject` and read `fee_growth_outside_a/b` as JSON
string fields. There are **no buffers and no discriminators**, and each Sui protocol
has exactly **one** tick format — so the buffer/discriminator registry does NOT
apply (forcing it would be a leaky abstraction). The Sui pattern is simply:
**extract the JSON fields, then feed them into `calcFeeGrowthInside` +
`safeCalcPendingFee`.** Verify the dynamic-field shape against the protocol's Move
struct before trusting it.

**Where per-position fee state lives varies by protocol — check it.** Bluefin and
Momentum store fee state (`fee_growth_inside` checkpoints + `fee_owned`) directly on
the position object, so you read it off the position. **Cetus does NOT** — its
per-position fee state lives in a separate pool-owned `position_manager` LinkedTable
(`PositionInfo`, keyed by position object ID), and its ticks live in a `move_stl`
SkipList (keyed by a `u64` score = `tickIndex + 443636`). Such protocols need extra
`getDynamicFieldObject` reads but use the **same** shared `safeCalcPendingFee` +
`calcFeeGrowthInside` utilities. See `app/api/cetus/route.ts` (`computeCetusPendingFees`,
`fetchCetusTick`) for the canonical pattern, including the defensive returned-index
guard on SkipList reads. Never assume `fees: 0` — confirm whether the protocol even
computes pending fees (an unimplemented stub silently shows $0 for every user).

### Future chains (Aptos, Sei, …)

If a new chain family uses binary tick accounts, add a new `{Chain}CLMMTickRegistry`
in `clmmTickDecoder.ts` mirroring the Solana one. If it uses object/JSON storage
like Sui, follow the Sui pattern (no registry). **Do not force one registry across
chain families.**

---

## Step 4 — Price the fees (cached, rule-compliant)

Use `fetchTokenPriceAtDate` (from `app/lib/cgPriceHistory.ts`) for historical
fee/claim valuation — it checks the persistent Upstash Redis cache first, then
CoinGecko historical (Sprint 1.6). Stablecoins anchor at $1. Follow
pricing-invariants Rule 1/1a (never spot-value a historical fee claim) and any
designated exceptions (e.g. CETUS reward token uses spot + LKG by design — that
path is NOT routed through Redis or historical).

### Token identity resolution (symbol / decimals / CoinGecko id)

**Do NOT create a per-protocol `KNOWN_COINS` / `KNOWN_TOKENS` / `TOKENS` map.**
Token identity is resolved platform-wide by `app/lib/tokenResolver.ts` (Sprint
1.10, architecture-principles Rule 9). Pass the on-chain identifier to
`resolveToken()`:

```ts
import { resolveToken } from '../../lib/tokenResolver';
const t = await resolveToken({ chain: 'sui', suiType: coinType });
// or { chain: 'solana', mint } / { chain: 'base', contractAddress }
// t.symbol + t.decimals are on-chain truth (decimals is NEVER a blind 18);
// feed t.cgId into the existing CoinGecko pricing pipeline
// (fetchCachedCoinGeckoPrices) for spot. If !t.priceable, render the amount
// with correct decimals and show "price unavailable" (Option A) — never hide
// the token, never break the page.
```

The resolver cascade (Redis → hardcoded constants → CoinGecko contract → on-chain
metadata → CoinGecko symbol search → DeFiLlama coverage) means every user
worldwide holding any token gets correct identity automatically, with no manual
list maintenance. Only native chain tokens and canonical stablecoins are pinned
(in `app/lib/tokenConstants.ts`); add a new chain's native/stable pins there, not
a per-route map. Resolver coverage is verified via the `token_resolver_used` /
`token_resolution_failed` `[PRICE_LOG]` events.

---

## Step 5 — UI + security surfaces (every one)

- **Show all positions**: In Range → Out of Range → Closed (dimmed). Never filter
  zero-liquidity.
- **Wire into**: dashboard, analytics (Fee Income by Protocol + totals), LP P&L,
  position detail page, docs, about page, and the chain/protocol navigation lists.
- **New chain?** Add its `defidesh_{chain}_disconnected` localStorage flag + a
  connection watcher in `providers.tsx` (wallet-security Rule 1), and its own
  per-chain watched-address list (Rule 6).

---

## Step 6 — Verification checklist (before commit)

- `npm run build` + `npx tsc --noEmit` clean.
- Test wallet WITH positions on the new protocol: dashboard shows plausible fees
  and values; analytics aggregates correctly.
- `grep '"event":"fee_underflow_detected"'` — fires **only** for genuine
  underflows, never spuriously on healthy positions.
- `grep '"event":"unsupported_tick_array_format"'` — **zero**. Any occurrence is a
  decoder gap → STOP and add the missing format (do not ship the guard masking it).
- `grep '"event":"tick_decoder_used"'` (Solana) — shows the expected format.
- Sprint invariants preserved: Account 2 ProjectX ≈ $1,776.29 (1.6), redis-cache-hit
  present (1.6), 0 `cg-spot` for fee claims (1.5).
- Capital G/L includes closed positions if the chain supports closed-position
  retrieval.

If any decoder format is unknown or a guard fires on a position you can't explain,
**STOP AND REPORT** — never ship a guard that masks a decoder gap.

---

## Reference

- `app/lib/clmmFeeMath.ts` — `safeCalcPendingFee`, `calcFeeGrowthInside`,
  `emitFeeUnderflow`.
- `app/lib/clmmTickDecoder.ts` — `solanaCLMMTickRegistry`, `anchorDiscriminator`.
- `.claude/rules/architecture-principles.md` — "Shared CLMM utilities are the
  canonical pattern."
- `.claude/rules/pricing-invariants.md` — Rule 1/1a/1b (fee valuation, underflow
  guard). `.claude/rules/instrumentation.md` — event schemas.
- Proven on: Orca (1.7d/1.7e), Bluefin + Momentum (1.7e). Raydium/Cetus do not
  compute pending fees today (settled-only / zero) — when that changes, they adopt
  this same pattern.
