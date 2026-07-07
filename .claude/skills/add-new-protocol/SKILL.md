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

**Cross-instance Redis is MANDATORY for EVERY historical price path (all chains).**
A historical daily price is immutable, so it MUST be cached in Upstash Redis (via
the shared `redisPriceCache.ts` helper — `getCachedHistoricalPrice(cgId, ts)` /
`setCachedHistoricalPrice(...)`, or its DeFiLlama analogue), NOT only in an
in-process Map. An in-process-only cache is empty on every cold Vercel instance, so
the route re-fetches each date serially through the 1100 ms-gap `withCgPacing` queue
— which made the Sui wallet-scope routes take ~100 s cold (~57 dates × 1.1 s) and
dropped the closed-only Sui protocols from Fee Income after every deploy. Sprint
SUI-HISTORICAL-REDIS (`776fcaa`) routed the last offender (`suiPriceHistory.ts`)
through `redisPriceCache` with cgId `sui` (key `price:historical:sui:{YYYYMMDD}`),
closing the gap: read order is **in-process Map → Redis → CoinGecko-historical
(paced) → on success populate BOTH**. A new protocol/chain that adds any bespoke
historical fetch MUST wire it through the shared Redis helper the same way — never
ship an in-process-only historical cache.

**Secondary historical source — DeFiLlama-by-contract (Sprint 1.12).** When
CoinGecko can't price a claim token historically (long-tail Sui/Solana tokens not
mapped to a CoinGecko id), value the claim at its claim-date price via
`fetchDefillamaPriceAtDate(chain, contract, ts)` / `prewarmDefillamaPrices(...)` +
`getCachedOnlyDefillamaPrice(chain, contract, ts)` from
`app/lib/defillamaPriceHistory.ts`. It is keyed by on-chain CONTRACT/MINT/COIN-TYPE
(which every protocol already has), wraps its own Redis namespace, and follows the
SAME claim-date-only rule (pricing-invariants Rule 1c) — DeFiLlama *current* price
is NEVER a claim source. Pattern: collect the non-stable claim-token identifiers +
their claim timestamps, `await prewarmDefillamaPrices(...)` once before the
synchronous events loop, then read each side with `getCachedOnlyDefillamaPrice`.
Coverage note: DeFiLlama has NO HyperEVM (`hyperliquid`) coverage — HyperEVM
claims rely on CoinGecko. If both sources miss, leave the claim pending (Rule 1a),
never spot. A new protocol inherits this just by calling the helper with
`{chain, contract, timestamp}`.

### Invariant (i) — resolve token types per event from on-chain state, never a hardcoded representative

**A wallet-scope / closed-position fee scan MUST resolve each fee event's token
identities (coinType/mint/address + decimals) from on-chain pool state per event —
NEVER from a single hardcoded "representative" pair per wallet.** A closed-only
wallet (whose positions are all destroyed/burned) has no open position to read the
real pair from, so a per-wallet fallback context can only ever encode ONE pair; any
fee claim from a DIFFERENT pool (or a typo in the fallback) then mis-prices or — when
the wrong side fails to price — DROPS the entire claim (Rule 1a marks it null and the
analytics layer skips it). This is the Sprint TOKEN-RESOLUTION root cause: the Bluefin
`BLUEFIN_FALLBACK.coinTypeB` typo silently dropped ~$3,847 of Fee Income for closed-only
Sui wallets while Cetus/Momentum survived only by luck (their fallbacks happened to match
the real pools).

The fee event already carries its pool reference (Sui: `pool` / `pool_id`; EVM Collect:
the pool address; Solana: the position/pool account). Resolve it on-chain and price each
side through the SAME historical cascade:
- **Sui:** `app/lib/suiPoolContext.ts` — `resolveSuiPoolContexts(poolIds)` → `Map<poolId,
  {coinTypeA, coinTypeB, decimalsA, decimalsB}>` from the pool's immutable `Pool<A,B>` type
  params (cached in-process, no TTL). Used by bluefin/cetus/momentum activity routes.
- **Solana — DELIVERED (Sprint 3-FREE `d1bf447`):** `app/lib/solanaClosedPositions.ts`
  resolves each closed position's pool → token mints + vaults + decimals from the on-chain
  Whirlpool account per event, and values by the on-chain MINT (DeFiLlama-by-mint →
  CG-historical via resolver cgId). **Closed Solana positions inherit ALL Contract
  invariants from day one** — (i) per-event on-chain resolution, (j) resilient spot for any
  current-value need, Rule 1a historical-only claims, Rule 4 Capital G/L, immutable Redis
  caching, `computePositionPnL` reuse. The same sprint removed the platform-wide
  hardcoded-mint landmine this invariant exists to prevent: the wrong ZEC mint and an
  INVALID placeholder ORCA mint in `orca/route.ts` + `solana/balances/route.ts` (dead
  entries that could never match on-chain state); the verified ZEC mint is pinned in
  `tokenConstants.ts` as a Rule 9 high-stakes identity. Two hard-won Solana parsing rules:
  the position's account INDEX varies by instruction (identify by ever-opened-set match,
  never a fixed index), and instruction discriminators are not exhaustive (Orca ships a
  liquidity-add variant whose discriminator matches no documented name — classify
  unrecognized position-referencing instructions by vault-transfer DIRECTION, never by
  hardcoding opaque hex).
- **Future chains:** same rule — derive the pair from on-chain state per event.

If the pool can't be resolved, mark the claim **pending** (`pending_pool_unresolved`, surfaced)
— NEVER price it with a guessed/hardcoded type, NEVER fall to spot. Every new protocol on every
chain inherits this from day one.

### Invariant (j) — the spot (current-value) path is resilient by construction

**An OPEN position's current-value spot price MUST go through the shared resilient spot helper
`fetchCachedCoinGeckoPrices` (priceCache.ts) — never a raw CoinGecko call.** That helper (Sprint
SPOT-RESILIENCE) is tiered so a transient CoinGecko 429 under the analytics page's concurrent
multi-route load can never zero an open position and fire a bogus "Current price data
unavailable" banner:
- **In-process Map (L1, 60 s)** → **Upstash Redis cross-instance LKG (L2, `redisSpotCache.ts`,
  key `cg_spot_v1:{cgId}`, 24 h retention / 5-min freshness)** → **CoinGecko (paced, standalone
  concurrency-2 queue — NOT the historical `withCgPacing` concurrency-1 chain, to avoid a
  nesting deadlock)**.
- **Tier A** stablecoin cgIds (usd-coin/tether/dai) → always **$1** (pricing-invariants Rule 3).
- **Tier B/C** on a live-fetch miss → return the **last-known-good** price (Map or Redis, any
  age), NEVER 0. So a returned **0 means "genuinely unpriceable"** (no price ever seen), which
  is exactly when `positionPnl.ts`'s `missing_current_prices` guard SHOULD exclude the position.

A new protocol/chain inherits this automatically by pricing current values through
`fetchCachedCoinGeckoPrices` (feed it the resolved cgId from invariant-(i) token resolution).
Do NOT reintroduce a per-route raw spot fetch or a `|| 0` that bypasses the LKG. This is the
SPOT path (Rule 2 current value) — it is SEPARATE from and MUST NOT be confused with the
historical fee-claim path (Rule 1a / `cgPriceHistory` + DeFiLlama), which is untouched by it.

### Invariant (k) — position-detail uncollected value = ALL claimable components

**The position-detail "Uncollected" total MUST include every component a user can claim —
trading fees AND pending reward emissions — so it matches the protocol's own claimable/"yield"
UI to the penny.** A CLMM protocol that runs incentives keeps pending rewards in a SEPARATE
on-chain structure from trading fees (pool rewarder state + a per-position reward checkpoint +
per-tick reward-growth-outside), computed with the SAME growth math + underflow guard as fees.
Reading only trading fees under-reports vs the protocol app (Sprint POSITION-DETAIL: Cetus
USDC/SUI showed $64.39 vs the Cetus app's $71.42 — the gap was pending CETUS+SUI emissions).

Every new protocol MUST either implement pending-reward reads or explicitly document that it
has NO emissions. For Sui CLMMs, the pattern is proven (Cetus/Bluefin/Momentum, `82d4954`):
read `pool.reward_infos[]/rewarder_manager` + `position.reward_infos[]`/`PositionInfo.rewards[]`
+ tick `reward_growths_outside[]` (all ride objects the fee path already fetches — zero extra
RPC), then resolve each reward coin type (invariant (i), never hardcoded) and value it at
CURRENT SPOT via `app/lib/suiRewardMeta.ts` (invariant (j)). Keep rewards on a SEPARATE
position field (`pendingRewards[]` / `rewardsUsd`) from `fees0/fees1` so analytics aggregation
over `fees` stays byte-identical; the detail page folds rewards into the displayed total only.
Pending rewards are a CURRENT-VALUE display (Rule 2 spot), NOT a fee claim (Rule 1a historical)
— do not confuse the two. (Deferred as of `82d4954`: Solana whirlpool rewards + EVM gauge
`earned()` emissions → Sprint POSITION-DETAIL-2; until then staked EVM positions under-report.)

### Verification lesson — third-party wallets are MANDATORY when Osho holds no position of that type

**A protocol integration is NOT verified until it has been run against real on-chain wallets
that actually hold (and have closed) positions on that protocol.** When Osho's accounts hold
none, find 2–3 public wallets by scanning the protocol program's recent history for
lifecycle instructions (e.g. `close_position`) and use them as ground truth — including at
least one BLIND wallet never used during development, as a generalization check.

Why this is a hard rule (Sprint RAYDIUM, `d7c6c81`): the Raydium open-position route shipped
with a one-byte account-layout error — Raydium's Anchor accounts are **bump-first** (`bump:
u8` at byte [8]), so the `memcmp {offset: 8}` position lookup could NEVER match and **every
Raydium user worldwide silently saw zero positions**. The bug was invisible for months
because every verification wallet was Raydium-empty: empty-in/empty-out is indistinguishable
from correct. The first real foreign wallet exposed it in minutes. Structural bugs — byte
offsets, discriminators, PDA seeds, event-log layouts — only surface when real foreign data
hits them. Corollaries:
- Prefer **layout-independent lookups** (derive the `["position", nftMint]` PDA and check the
  account discriminator) over memcmp offset-hunting — a layout change then degrades loudly,
  not silently.
- Byte-verify every documented account layout against a LIVE account before trusting it
  (Anchor programs may prepend fields like `bump` that shift everything).
- Never treat "route returns empty for the test wallet" as a pass when the test wallet is
  legitimately empty — that observation has zero verification power.

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
