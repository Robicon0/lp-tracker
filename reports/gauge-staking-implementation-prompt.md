# Claude Code prompt — Sprint GAUGE-STAKING

_Generated 2026-08-03 from the confirmed investigation. Both stages in one pass._

---

**Context**

An Aerodrome/Velodrome CL position that a user has **staked into a gauge** is
misclassified as **Closed with its entire deposit booked as a realized loss**.
Live example: vfat Sickle `0x06C3F412…e09f` position `73551608` — ~$10,000 still
alive and earning AERO, shown as a **−$9,988.84** Capital G/L.

Root cause, confirmed on-chain: `app/api/aerodrome/route.ts:125` classifies with
`closedIds = everOwned.filter(id => !heldIds.has(id))`, where `heldIds` is
whatever Sugar returned. Sugar's `positionsByFactory` enumerates from
DIRECTLY-HELD NFTs, so a staked position — whose NFT now belongs to the gauge —
is invisible to it. Absence is then read as closure. Perfect correlation
measured on the test wallet: the two Sickle-held positions were returned by
Sugar, the one gauge-held position was omitted.

The classifier never calls `ownerOf`, never checks burn status, and never
consults withdrawal events. **This is NOT vfat-specific** — any address, EOA or
contract, that stakes an Aerodrome/Velodrome CL position is exposed. It surfaced
via vfat only because vfat stakes routinely. (Account 1 is unaffected: 7
genuinely burned, 1 held directly, zero staked.)

DefiDesh currently has NO gauge logic at all (`grep -rin "gauge" app/` → nothing).
Sprint GAUGE-STAKING.

**Goal**

After this fix, position `73551608` on Sickle `0x06C3F412…e09f` is reported as a
LIVE STAKED position with its real current value (~$10k) and contributes NOTHING
to Capital G/L — instead of appearing as Closed with a −$9,988.84 fabricated loss.

**STRICT RULES:**
- Preserve all `[PRICE_LOG]` instrumentation in `app/lib/priceLogger.ts`
- Additive only; do not alter the genuinely-burned Closed path
- No per-chain branches in client code (config maps / helper modules only)
- Build must pass clean before commit
- If verification numbers are off by 20%+, STOP AND REPORT — do not iterate silently

**INVESTIGATION:**
1. Read `.claude/rules/architecture-principles.md` (Rules 2, 5, 11) and
   `pricing-invariants.md` (Rule 4 — Capital G/L is CLOSED positions only).
2. Read `app/api/aerodrome/route.ts` `buildClosedPositions` (~line 110-190) and
   the open-position mapping (~line 352-415) — the staked shape must match the
   open shape, not the `minimal` closed stub.
3. Read `app/api/velodrome/route.ts`'s equivalent (same Slipstream pattern).
4. Confirm live before coding:
   `ownerOf(73551608)` = `0x6399ed67…79a8`; that address's `nft()` =
   `0x8279…5b72` (position manager), `rewardToken()` = AERO, `voter()` =
   `0x1661…80a5`; and `voter.gauges(pool)` returns the same gauge.
5. Report findings before implementing.

**IMPLEMENTATION:**

1. **NEW `app/lib/evmGaugeStaking.ts`** — gauge detection + staked-position
   state. Given `{rpc, nftManager, tokenId}`:
   - `ownerOf(tokenId)`: reverts ⇒ genuinely burned; equals the account ⇒ held;
     otherwise a third party.
   - Identify a gauge by calling `owner.nft()` and requiring it to equal the
     position manager, cross-checked against `voter.gauges(pool)`. Both must
     agree before treating the holder as a gauge — never infer from the address
     alone.
   - For a confirmed gauge, read `positionManager.positions(tokenId)` for
     liquidity / tickLower / tickUpper / token0 / token1, and the pool's
     `slot0.sqrtPriceX96` + `tick` for current price.
   - Return `{ isStaked, gauge, liquidity, tickLower, tickUpper, token0,
     token1, tickCurrent, sqrtPriceX96 }`, or null if not staked.
   - Cache immutable parts (gauge identity per pool) in Redis; NEVER cache a
     null (transient RPC failure must not freeze in as "not staked").

2. **Amount math from REAL pool price** — compute amount0/amount1 from
   liquidity + ticks + `sqrtPriceX96` using standard Uniswap-V3 branches
   (below range ⇒ all token0; above ⇒ all token1; in range ⇒ mixed). Do NOT
   reuse the midpoint approximation in `uniswap/v3/route.ts:286-297`; that is an
   estimate and this must be a real value.

3. **`buildClosedPositions` (aerodrome + velodrome)** — before emitting a
   position as Closed, resolve its holder. If gauge-staked, emit it in the OPEN
   shape instead: real `value`, `amount0/1`, ticks, token metadata, status
   `In Range`/`Out of Range` per the pool's current tick, plus additive
   `isStaked: true` and `gaugeAddress`. Genuinely burned positions keep exactly
   their current behaviour.

4. **Keep staked positions OUT of Capital G/L.** They are open, not realized
   (pricing-invariants Rule 4). Since they now carry non-Closed status they
   leave the closed set naturally — verify this rather than assume it.

5. **UI** — surface a `STAKED` indicator where status is shown, so a staked
   position is distinguishable from an ordinary open one. Additive only.

**VERIFICATION:**
1. `npm run build` clean.
2. `/api/aerodrome?account=0x06c3f4125e7d2d139d0ab6a73c2112b7e949e09f` →
   `73551608` present, status In Range/Out of Range (NOT Closed), `isStaked:true`,
   value ≈ **$10,000** (sanity: 9,210.35 USDC + 0.01195 cbBTC at spot).
3. Analytics Capital G/L for that wallet: the −$9,988.84 entry is GONE and
   `73551608` no longer appears in the closed-position breakdown.
4. **Regression — Account 1** (`0xD99a9e66…4F20`): 7 genuinely-burned positions
   MUST still be Closed, 1 held position unchanged. Zero staked. Any change here
   is a regression.
5. Velodrome: same code path exercised; note honestly if no test wallet holds
   Velodrome positions.
6. If verified: commit and push. Update `CLAUDE.md`.

**EDGE CASES TO HANDLE:**
- `ownerOf` reverts (burned) → Closed, unchanged
- Owner is a non-gauge third party (transferred/sold) → do NOT book as a loss;
  exclude and surface
- `positions(tokenId)` reverts after a burn race → treat as unresolved, exclude
- Staked position with liquidity 0 (staked then fully withdrawn) → genuinely Closed
- Pool with no gauge (`voter.gauges(pool)` = 0x0) → holder is not a gauge
- RPC failure during detection → never silently classify as Closed; exclude and surface

Build, test on localhost, confirm visually that it works, then push to GitHub. Do
not mark it done until the output is verified. Update CLAUDE.md when done. If
anything is unclear or the file paths don't match, stop and report — do not improvise.
