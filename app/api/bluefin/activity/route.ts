import { NextResponse } from 'next/server';
import { suiRpc } from '../../../lib/suiRpc';
import { getSuiActivityBlocks } from '../../../lib/suiHistory';
import { scanStatusNotice, type RouteTruncation } from '../../../lib/enumerationTruncation';
import { sidePricesFromEventSqrt } from '../../../lib/suiEventPrice';
import { withActivityRouteCache } from '../../../lib/activityRouteCache';
import { deriveDepositPrices } from '../../../lib/v3PriceDerivation';
import { resolveSuiRewardMetas, prewarmSuiClaimPrices, priceSuiClaimSide, suiCoinTypeFromEvent, SUI_CANONICAL, type ClaimSideInput } from '../../../lib/suiClaimPrice';
import { resolveSuiPoolContexts, type SuiPoolContext } from '../../../lib/suiPoolContext';
import { logPrice } from '../../../lib/priceLogger';


const BLUEFIN_PKG = '0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267';

// Sui object type of a Bluefin Position. Same value used by
// app/api/bluefin/route.ts. Used in wallet-scope mode to filter fee/reward
// events down to positions the user actually owns — necessary because
// routers/aggregators may emit UserFeeCollected / UserRewardCollected
// against OTHER users' position objects from within a tx the user signed.
// TRADE-OFF: this also excludes positions the user has FULLY CLOSED, since
// the on-chain object is destroyed; the original "recover destroyed-object
// fees" intent of wallet-scope is sacrificed for foreign-position correctness.
const BLUEFIN_POSITION_TYPE =
  '0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267::position::Position';

// Known Sui stablecoins (lowercase for comparison)
const STABLECOINS = new Set([
  '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::usdc',
  '0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::coin', // USDT
  '0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::coin', // wUSDC
]);

export type ActivityEventType = 'deposit' | 'withdrawal' | 'fee_claim' | 'reward_claim';

export interface ActivityEvent {
  type: ActivityEventType;
  txHash: string;           // Sui transaction digest
  timestamp: number;        // unix seconds
  amount0: number;          // coin_a_amount (human-readable)
  amount1: number;          // coin_b_amount
  usdAtTime: number | null; // null if historical price fetch failed
  // Per-event historical prices — not yet populated for Sui (always null this phase).
  price0AtTime: number | null;
  price1AtTime: number | null;
  // ITEM 0b — set ONLY when this event's claim-date historical price was cold
  // and CURRENT SPOT was substituted. Consumers treat it as not-yet-final.
  priceBasis?: 'current-spot-substituted' | 'tick-derived-estimate';
  // A claim priced from the nearest earlier day (≤ 3 days): the page counts it
  // and marks Fees `≈` (pricing-invariants Rule 1a).
  claimPriceBasis?: 'nearby-day';
  cumulativeFeeUSD: number; // running total of fee+reward USD; 0 for non-fee events
  rewardSymbol?: string;    // set for reward_claim events
  rewardCoinType?: string;  // set for reward_claim events: the event's `reward_type`
}

interface ActivityResponse {
  events: ActivityEvent[];
  netInvested0: number;
  netInvested1: number;
  totalFees0: number;
  totalFees1: number;
}


// Fetch the set of Bluefin Position object IDs CURRENTLY owned by `account`.
// This is one half of the wallet-scope "ever owned" set; the other half is
// built in-memory from LiquidityProvided entries in the wallet's tx history
// (see the pre-loop in GET below) so closed/destroyed positions still
// contribute. Mirrors the pagination pattern in app/api/bluefin/route.ts.
async function fetchOwnedPositionIds(account: string): Promise<Set<string>> {
  const ids = new Set<string>();
  let cursor: string | null = null;
  do {
    const result = await suiRpc('suix_getOwnedObjects', [
      account,
      { filter: { StructType: BLUEFIN_POSITION_TYPE }, options: { showType: false, showContent: false } },
      cursor,
      50,
    ]) as { data: Array<{ data?: { objectId?: string } }>; nextCursor: string | null; hasNextPage: boolean } | null;
    if (!result?.data) break;
    for (const item of result.data) {
      const id = item?.data?.objectId;
      if (id) ids.add(id);
    }
    cursor = result.hasNextPage ? result.nextCursor : null;
  } while (cursor);
  return ids;
}


// History comes from the shared Sui history client (app/lib/suiHistory.ts).
interface SuiTxBlock {
  digest: string;
  timestampMs: string;
  events: Array<{ type: string; parsedJson: Record<string, unknown> }>;
}


export const GET = withActivityRouteCache(GET_impl);

async function GET_impl(request: Request) {
  const { searchParams } = new URL(request.url);
  const positionId = searchParams.get('positionId'); // raw Sui object ID
  const account = searchParams.get('account') ?? '';
  const decimalsA = parseInt(searchParams.get('decimalsA') ?? '9', 10);
  const decimalsB = parseInt(searchParams.get('decimalsB') ?? '6', 10);
  const coinTypeA = searchParams.get('coinTypeA') ?? '';
  const coinTypeB = searchParams.get('coinTypeB') ?? '';
  const fallbackA = parseFloat(searchParams.get('priceA') ?? '0');
  const fallbackB = parseFloat(searchParams.get('priceB') ?? '0');
  const tickLower = searchParams.get('tickLower') != null ? parseInt(searchParams.get('tickLower')!, 10) : null;
  const tickUpper = searchParams.get('tickUpper') != null ? parseInt(searchParams.get('tickUpper')!, 10) : null;

  if (!positionId || !account) {
    return NextResponse.json({ error: 'positionId and account required' }, { status: 400 });
  }
  // Wallet-scope mode: positionId="all" returns fee/reward events from every
  // Bluefin position this wallet ever interacted with — including positions
  // that were fully closed on-chain and thus no longer exist as objects. This
  // is how we recover fee history from destroyed positions (per-position
  // scans can't see them because the object is gone). Deposits/withdrawals
  // are omitted in this mode since they'd be ambiguous across pools.
  const walletScope = positionId === 'all';

  try {
    const history = await getSuiActivityBlocks(account, walletScope ? null : positionId);

    // Wallet scope only: a history scan that could not be shown to be whole is
    // reported with the result (rule (a)); the notice also keeps this response
    // out of the activity-route cache.
    // `in-progress` (the resumable scan has more to read; the client asks again)
    // and `capped` (history too long, most recent part only) say so by name.
    const historyNotice = scanStatusNotice('wallet history', history.status);
    const historyNotices: RouteTruncation[] = historyNotice ? [historyNotice] : [];

    if (history.blocks.length === 0) {
      return NextResponse.json({
        events: [], netInvested0: 0, netInvested1: 0, totalFees0: 0, totalFees1: 0,
        ...(historyNotices.length > 0 ? { truncated: historyNotices } : {}),
      } as ActivityResponse);
    }

    // Wallet-scope only: build the set of Bluefin Position object IDs the
    // wallet has EVER owned, used below to filter fee/reward events down to
    // positions the wallet actually opened (rejects router/aggregator-emitted
    // events against OTHER users' positions) while still keeping fees from
    // positions the wallet opened and later fully closed.
    //
    // Source 1: suix_getOwnedObjects → currently-owned (open) positions.
    // Source 2 (added below after allTxBlocks loads): LiquidityProvided
    // events in the wallet's tx history → catches closed/destroyed positions.
    //
    // Per-position mode already filters by parsedJson.position_id === positionId,
    // so neither source is consulted there.
    const everOwnedPositionIds = walletScope ? await fetchOwnedPositionIds(account) : new Set<string>();

    const allTxBlocks: SuiTxBlock[] = history.blocks;

    // Source 2: single in-memory pass over the already-fetched tx blocks to
    // collect every position the wallet has ever opened (LiquidityProvided
    // fires on every add-liquidity, including the initial open). No extra RPC.
    // Must complete BEFORE the main event loop so fee/reward filtering sees
    // the full union.
    if (walletScope) {
      for (const tx of allTxBlocks) {
        if (!tx?.events) continue;
        for (const ev of tx.events) {
          if (!ev.type.startsWith(BLUEFIN_PKG)) continue;
          if (!ev.type.endsWith('::LiquidityProvided')) continue;
          const id = (ev.parsedJson?.position_id as string) ?? '';
          if (id) everOwnedPositionIds.add(id);
        }
      }
    }

    const scaleA = BigInt(10) ** BigInt(decimalsA);
    const scaleB = BigInt(10) ** BigInt(decimalsB);

    interface RawEvent {
      type: ActivityEventType;
      txHash: string;
      timestamp: number;
      amount0Raw: bigint;
      amount1Raw: bigint;
      rewardSymbol?: string;
      rewardDecimals?: number;
      rewardCoinType?: string;
      poolId?: string;        // fee_claim only — for per-event pool-context resolution
      sqrtPrice?: unknown;    // deposit / withdrawal — the pool's price in that transaction (absent on V1 events)
    }

    const rawEvents: RawEvent[] = [];
    let deposited0 = 0n, deposited1 = 0n;
    let withdrawn0 = 0n, withdrawn1 = 0n;
    let fees0 = 0n, fees1 = 0n;

    for (const tx of allTxBlocks) {
      if (!tx?.events) continue;
      const ts = tx.timestampMs ? Math.floor(parseInt(tx.timestampMs, 10) / 1000) : 0;

      for (const ev of tx.events) {
        if (!ev.type.startsWith(BLUEFIN_PKG)) continue;
        const pj = ev.parsedJson ?? {};
        const evPosId = (pj.position_id as string) ?? '';
        if (!walletScope && evPosId !== positionId) continue;

        const evName = ev.type.split('::').pop() ?? '';

        // In wallet-scope mode only emit fee + reward events — deposits /
        // withdrawals are pool-specific and not useful when aggregating
        // across multiple destroyed positions.
        if (walletScope) {
          if (evName !== 'UserFeeCollected' && evName !== 'UserRewardCollected') continue;
          // Reject events whose `position_id` is not in the wallet's
          // ever-owned set (currently-owned ∪ ever-opened-via-tx-history).
          // Filters out fee/reward events emitted by routers / aggregators
          // acting on positions the user does NOT own, while keeping fees
          // from positions the user opened and later closed.
          if (!everOwnedPositionIds.has(evPosId)) continue;
        }

        if (evName === 'LiquidityProvided') {
          const a0 = BigInt((pj.coin_a_amount as string) ?? '0');
          const a1 = BigInt((pj.coin_b_amount as string) ?? '0');
          deposited0 += a0;
          deposited1 += a1;
          rawEvents.push({ type: 'deposit', txHash: tx.digest, timestamp: ts, amount0Raw: a0, amount1Raw: a1, sqrtPrice: pj.current_sqrt_price });

        } else if (evName === 'LiquidityRemoved') {
          const a0 = BigInt((pj.coin_a_amount as string) ?? '0');
          const a1 = BigInt((pj.coin_b_amount as string) ?? '0');
          withdrawn0 += a0;
          withdrawn1 += a1;
          rawEvents.push({ type: 'withdrawal', txHash: tx.digest, timestamp: ts, amount0Raw: a0, amount1Raw: a1, sqrtPrice: pj.current_sqrt_price });

        } else if (evName === 'UserFeeCollected') {
          const a0 = BigInt((pj.coin_a_amount as string) ?? '0');
          const a1 = BigInt((pj.coin_b_amount as string) ?? '0');
          fees0 += a0;
          fees1 += a1;
          rawEvents.push({ type: 'fee_claim', txHash: tx.digest, timestamp: ts, amount0Raw: a0, amount1Raw: a1, poolId: (pj.pool_id as string) ?? undefined });

        } else if (evName === 'UserRewardCollected') {
          const rewardAmt = BigInt((pj.reward_amount as string) ?? '0');
          const rewardDec = typeof pj.reward_decimals === 'number' ? pj.reward_decimals : 9;
          const rewardSymbol = (pj.reward_symbol as string) ?? 'REWARD';
          const rewardCoinType = suiCoinTypeFromEvent(pj.reward_type) || undefined;
          rawEvents.push({
            type: 'reward_claim',
            txHash: tx.digest,
            timestamp: ts,
            amount0Raw: rewardAmt,
            amount1Raw: 0n,
            rewardSymbol,
            rewardDecimals: rewardDec,
            rewardCoinType,
          });
        }
      }
    }

    // Sort chronologically (oldest first) to compute cumulative fees correctly
    rawEvents.sort((a, b) => a.timestamp - b.timestamp);

    // Sprint TOKEN-RESOLUTION: resolve each fee claim's REAL pool context from its
    // on-chain pool object (Bluefin fee events carry pool_id), so the historical
    // cascade prices the correct token on each side — instead of a single
    // representative/hardcoded (coinTypeA, coinTypeB) that mis-prices or DROPS
    // claims when the wallet's closed pools differ from it (the BLUEFIN_FALLBACK
    // typo bug: a corrupted USDC coin type nulled every fee claim's USDC side, so
    // closed-only wallets lost ~92% of Bluefin Fee Income). Wallet-scope only;
    // per-position mode already gets the right coin types from the open position.
    // Pool `Pool<A,B>` type params are immutable → cached in-process.
    const resolvedPools: Map<string, SuiPoolContext> = walletScope
      ? await resolveSuiPoolContexts(
          rawEvents.filter((e) => e.type === 'fee_claim' && e.poolId).map((e) => e.poolId!),
        )
      : new Map();
    // Effective per-fee-claim pool context: the resolved REAL pool in wallet-scope,
    // else the passed (open-position) context. null → pool unresolved → the claim
    // stays PENDING (Rule 1a), never priced with a guessed/hardcoded token type.
    const feeCtxFor = (ev: RawEvent): SuiPoolContext | null =>
      walletScope
        ? (ev.poolId ? (resolvedPools.get(ev.poolId) ?? null) : null)
        : { coinTypeA, coinTypeB, decimalsA, decimalsB };

    // Claim pricing (pricing-invariants Rule 1 / 1a): every fee and reward
    // claim side is valued by COIN TYPE at its claim day, never spot. The
    // reward's identity is the event's `reward_type`; its decimals are the
    // event's own `reward_decimals`.
    const suiCanonical = SUI_CANONICAL;
    const rewardHints = new Map<string, number>();
    for (const e of rawEvents) {
      if (e.type === 'reward_claim' && e.rewardCoinType && e.rewardDecimals != null) rewardHints.set(e.rewardCoinType, e.rewardDecimals);
    }
    const rewardMeta = await resolveSuiRewardMetas([...rewardHints.keys()], rewardHints);
    {
      const sides: ClaimSideInput[] = [];
      for (const e of rawEvents) {
        if (e.type === 'fee_claim') {
          const c = feeCtxFor(e);
          if (!c) continue;
          sides.push({ coinType: c.coinTypeA, isStable: STABLECOINS.has(c.coinTypeA.toLowerCase()), isSui: c.coinTypeA.toLowerCase() === suiCanonical, ts: e.timestamp });
          sides.push({ coinType: c.coinTypeB, isStable: STABLECOINS.has(c.coinTypeB.toLowerCase()), isSui: c.coinTypeB.toLowerCase() === suiCanonical, ts: e.timestamp });
        } else if (e.type === 'reward_claim' && e.rewardCoinType && e.amount0Raw > 0n) {
          const m = rewardMeta.get(e.rewardCoinType);
          if (m?.decimalsKnown) sides.push({ coinType: m.coinType, isStable: m.isStable, isSui: m.isSui, ts: e.timestamp });
        }
      }
      await prewarmSuiClaimPrices(sides);
    }

    const hasTicks = tickLower != null && tickUpper != null;
    let runningFeeUSD = 0;
    // [PRICE_LOG] instrumentation (additive only) — per-request fee/reward counters
    const __route = 'bluefin';
    const __posId = positionId ?? '';
    const __wallet = account;
    const __srcBreakdown: Record<string, number> = {};
    const __failures: Array<{ token: string; blockTimestamp: number; reason: string }> = [];
    let __totalClaims = 0, __resolvedClaims = 0, __failedClaims = 0, __totalLookups = 0;
    const events: ActivityEvent[] = rawEvents.map((ev) => {
      let amount0: number;
      let amount1: number;

      // Effective pool context for a fee claim (resolved REAL pool in wallet-scope,
      // else the passed open-position context). Drives BOTH amount scaling and
      // pricing, so a closed position in a pool with different decimals is correct.
      const fctx = ev.type === 'fee_claim' ? feeCtxFor(ev) : null;

      if (ev.type === 'reward_claim') {
        const scale = BigInt(10) ** BigInt(ev.rewardDecimals ?? 9);
        amount0 = Number(ev.amount0Raw) / Number(scale);
        amount1 = 0;
      } else if (ev.type === 'fee_claim') {
        const dA = fctx ? fctx.decimalsA : decimalsA;
        const dB = fctx ? fctx.decimalsB : decimalsB;
        amount0 = Number(ev.amount0Raw) / 10 ** dA;
        amount1 = Number(ev.amount1Raw) / 10 ** dB;
      } else {
        amount0 = Number(ev.amount0Raw) / Number(scaleA);
        amount1 = Number(ev.amount1Raw) / Number(scaleB);
      }

      let price0AtTime: number | null = null;
      let price1AtTime: number | null = null;
      let usdAtTime: number | null = null;
      let priceBasis: 'current-spot-substituted' | 'tick-derived-estimate' | undefined;
      let claimPriceBasis: 'nearby-day' | undefined;
      // Sprint NEW: which historical source priced a fee claim (for the read-only
      // [PRICE_LOG] re-derivation below). NEVER 'cg-spot' — Bluefin fee claims are
      // historical-only (Rule 1a), mirroring the Cetus 1.15 cascade.
      let __feeClaimSrc = 'unknown';

      if (ev.type === 'deposit' || ev.type === 'withdrawal') {
        // The pool's own price in this transaction (historical by construction).
        // Exact basis, so no priceBasis marker. Falls through when the event
        // carries no sqrt price or the pool has no stablecoin side.
        const px = sidePricesFromEventSqrt(
          ev.sqrtPrice, decimalsA, decimalsB,
          STABLECOINS.has(coinTypeA.toLowerCase()), STABLECOINS.has(coinTypeB.toLowerCase()),
        );
        if (px) {
          price0AtTime = px.price0;
          price1AtTime = px.price1;
          usdAtTime = amount0 * px.price0 + amount1 * px.price1;
        }
      }

      if ((ev.type === 'deposit' || ev.type === 'withdrawal') && usdAtTime == null && hasTicks) {
        const derived = deriveDepositPrices(
          amount0, amount1, tickLower!, tickUpper!, decimalsA, decimalsB,
          coinTypeA, coinTypeB, STABLECOINS,
        );
        if (derived) {
            price0AtTime = derived.price0;
          price1AtTime = derived.price1;
          usdAtTime = amount0 * derived.price0 + amount1 * derived.price1;
          // ITEM 0b: this is a TICK-BOUNDARY ESTIMATE from the position's own
          // range, not the price at THIS event's block — so every event of the
          // position gets the SAME price, which makes a closed position's
          // deposit and withdrawal converge and its Capital G/L collapse
          // toward $0. Marked so the total declares itself not-yet-final.
          priceBasis = 'tick-derived-estimate';
        }
      }

      // Reward claim: the coin type the event names, at its claim day
      // (stablecoin $1 / SUI CoinGecko then DeFiLlama / any other DeFiLlama).
      // A zero-amount reward is $0 and resolved; an unknown coin type or price
      // leaves the claim unpriced (counted), never spot.
      if (ev.type === 'reward_claim') {
        const m = ev.rewardCoinType ? rewardMeta.get(ev.rewardCoinType) : undefined;
        if (ev.amount0Raw === 0n) {
          usdAtTime = 0;
          __feeClaimSrc = 'zero_amount';
        } else {
          const side = m?.decimalsKnown ? priceSuiClaimSide(m.coinType, m.isStable, m.isSui, ev.timestamp) : null;
          if (side?.price != null) {
            price0AtTime = side.price;
            usdAtTime = amount0 * side.price;
            __feeClaimSrc = side.src;
            if (side.nearby) claimPriceBasis = 'nearby-day';
          }
        }
      } else if (ev.type === 'fee_claim') {
        // Sprint TOKEN-RESOLUTION: price each side using the REAL pool's coin
        // types (resolved per event via `fctx`), NOT a single representative —
        // so a closed position in any pool prices correctly. Bluefin fee claims
        // are valued at CLAIM-DATE historical ONLY (pricing-invariants Rule 1a) —
        // NEVER current spot. Per side: a stablecoin is $1; the SUI side uses
        // CoinGecko historical (prewarmed) then DeFiLlama historical-by-coin-type;
        // any other non-stable side uses DeFiLlama historical. If a side cannot be
        // priced historically — OR the pool itself could not be resolved — the
        // claim stays UNRESOLVED (null) and surfaces as "pending price
        // resolution"; it is NEVER priced with a guessed/hardcoded token type and
        // NEVER spot-valued. (The reward path above is untouched.)
        if (fctx) {
          const __cA = fctx.coinTypeA, __cB = fctx.coinTypeB;
          const __sA = STABLECOINS.has(__cA.toLowerCase());
          const __sB = STABLECOINS.has(__cB.toLowerCase());
          const __suiA = __cA.toLowerCase() === suiCanonical;
          const __suiB = __cB.toLowerCase() === suiCanonical;
          const sA = priceSuiClaimSide(__cA, __sA, __suiA, ev.timestamp);
          const sB = priceSuiClaimSide(__cB, __sB, __suiB, ev.timestamp);
          if (sA.price != null && sB.price != null) {
            price0AtTime = sA.price;
            price1AtTime = sB.price;
            usdAtTime = amount0 * sA.price + amount1 * sB.price;
            __feeClaimSrc = [sA.src, sB.src].includes('defillama-historical') ? 'defillama-historical' : [sA.src, sB.src].includes('sui-historical') ? 'sui-historical' : 'stablecoin-fixed';
            if (sA.nearby || sB.nearby) claimPriceBasis = 'nearby-day';
          }
          // else: usdAtTime stays null → pending (Rule 1a — no spot fallback).
        } else {
          // Pool could not be resolved (wallet-scope, sui_getObject failed) →
          // pending, surfaced. NEVER fall back to a guessed/hardcoded token type.
          __feeClaimSrc = 'pending_pool_unresolved';
        }
      } else if (usdAtTime == null) {
        // Withdrawal / deposit where on-chain derivation (deriveDepositPrices)
        // was unavailable: current-spot last resort. Allowed by pricing-invariants
        // Rule 2 (a point-in-time position value, NOT historical earnings).
        // UNCHANGED — never applies to fee claims (handled above) or rewards.
        // ITEM 0b: allowed but MARKED — never silently substituted.
        const pxA = fallbackA;
        const pxB = fallbackB;
        price0AtTime = pxA || null;
        price1AtTime = pxB || null;
        if (pxA > 0 || pxB > 0) {
          usdAtTime = amount0 * pxA + amount1 * pxB;
          priceBasis = 'current-spot-substituted';
        }
      }

      let cumulativeFeeUSD = 0;
      if (ev.type === 'fee_claim' || ev.type === 'reward_claim') {
        runningFeeUSD += usdAtTime ?? 0;
        cumulativeFeeUSD = runningFeeUSD;
      }

      // [PRICE_LOG] fee/reward resolution — read-only source re-derivation,
      // mirrors the Sui pricing rules above without altering any value.
      if (ev.type === 'fee_claim' || ev.type === 'reward_claim') {
        // Whatever source the cascade above recorded (claim-day historical
        // per side; never cg-spot).
        const __src: string = __feeClaimSrc;
        __totalClaims++; __totalLookups++;
        __srcBreakdown[__src] = (__srcBreakdown[__src] ?? 0) + 1;
        const __ok = usdAtTime != null && (usdAtTime > 0 || __src === 'zero_amount');
        const __tokLabel = ev.type === 'reward_claim' ? (ev.rewardSymbol ?? 'REWARD') : `${coinTypeA}/${coinTypeB}`;
        if (__ok) __resolvedClaims++;
        else { __failedClaims++; __failures.push({ token: __tokLabel, blockTimestamp: ev.timestamp, reason: __src === 'unknown' ? 'no_price_any_source' : 'zero_usd' }); }
        logPrice({
          event: 'fee_claim_resolution',
          route: __route,
          positionId: __posId,
          blockTimestamp: ev.timestamp,
          token0: { symbol: ev.type === 'reward_claim' ? (ev.rewardSymbol ?? 'REWARD') : coinTypeA, address: ev.type === 'reward_claim' ? undefined : coinTypeA, amount: String(amount0) },
          token1: { symbol: ev.type === 'reward_claim' ? '' : coinTypeB, address: ev.type === 'reward_claim' ? undefined : coinTypeB, amount: String(amount1) },
          token0Usd: price0AtTime,
          token1Usd: price1AtTime,
          usdAtTime,
          status: (usdAtTime == null || usdAtTime === 0) ? 'failed_null_usdAtTime' : ((price0AtTime != null && (ev.type === 'reward_claim' || price1AtTime != null)) ? 'ok' : 'partial'),
          notes: `source=${__src} type=${ev.type}`,
        });
      }
      return {
        type: ev.type,
        txHash: ev.txHash,
        timestamp: ev.timestamp,
        amount0,
        amount1,
        usdAtTime,
        price0AtTime,
        price1AtTime,
        ...(priceBasis ? { priceBasis } : {}),
        // A zero-amount claim is $0 whatever the day: it is never marked nearby-day.
        ...(claimPriceBasis && (usdAtTime ?? 0) > 0 ? { claimPriceBasis } : {}),
        cumulativeFeeUSD,
        ...(ev.rewardSymbol ? { rewardSymbol: ev.rewardSymbol } : {}),
        ...(ev.rewardCoinType ? { rewardCoinType: ev.rewardCoinType } : {}),
      };
    });

    // Reverse to newest-first for display
    events.reverse();

    // [PRICE_LOG] route_summary — aggregate of this request's fee/reward pricing
    logPrice({
      event: 'route_summary',
      route: __route,
      wallet: __wallet,
      totalClaims: __totalClaims,
      resolvedClaims: __resolvedClaims,
      failedClaims: __failedClaims,
      totalLookups: __totalLookups,
      sourceBreakdown: __srcBreakdown,
      failures: __failures,
    });

    return NextResponse.json({
      events,
      netInvested0: Number(deposited0 - withdrawn0) / Number(scaleA),
      netInvested1: Number(deposited1 - withdrawn1) / Number(scaleB),
      totalFees0: Number(fees0) / Number(scaleA),
      totalFees1: Number(fees1) / Number(scaleB),
      ...(historyNotices.length > 0 ? { truncated: historyNotices } : {}),
    } as ActivityResponse);
  } catch (err) {
    console.error('[bluefin/activity] Unexpected error:', err);
    return NextResponse.json(
      { error: 'Failed to fetch Bluefin activity', details: String(err) },
      { status: 500 },
    );
  }
}
