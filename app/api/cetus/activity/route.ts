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
import { withStoreWriteNotice } from '../../../lib/storeWriteNotice';

// Cetus CLMM activity route — follows the EXACT same pattern as
// app/api/bluefin/activity/route.ts. All Cetus specifics below were verified
// on-chain (NOT from docs / SDK / guesses):
//   - position-object id field: `position` (NOT `position_id` — that's Momentum)
//   - amount fields:             `amount_a` / `amount_b`
//   - 3 packages emit Cetus events; the verified V2 deposit/withdrawal pkg
//     is 0xdb5cd62a06c79695… (NOT 0xdb5cd62a4b7c… — that's a wrong reconstruction)
//   - event names use the V2 suffix (AddLiquidityV2Event / RemoveLiquidityV2Event
//     / CollectRewardV2Event; only CollectFeeEvent has no V2 suffix)
//   - OpenPositionEvent / ClosePositionEvent are lifecycle markers with no
//     amounts — ignored
//
// Filtering is by PACKAGE ALLOWLIST (never name-only). Momentum emits
// identically-named AddLiquidityEvent / RemoveLiquidityEvent, so a name-only
// filter would cross-capture Momentum events as Cetus activity.


// Verified Cetus packages (allowlist). Matched with `startsWith`.
const CETUS_PKGS = [
  '0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb', // fees + lifecycle (CollectFeeEvent, Open/ClosePositionEvent)
  '0xdb5cd62a06c79695bfc9982eb08534706d3752fe123b48e0144f480209b3117f', // V2 deposits/withdrawals (Add/RemoveLiquidityV2Event)
  '0xdc67d6de3f00051c505da10d8f6fbab3b3ec21ec65f0dc22a2f36c13fc102110', // V2 rewards (CollectRewardV2Event)
];

// Sui object type of a Cetus Position. Same value used by app/api/cetus/route.ts
// — Move type identity is preserved across Cetus package upgrades, so this
// single string matches every Position the wallet currently owns.
const CETUS_POSITION_TYPE =
  '0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb::position::Position';

// Known Sui stablecoin coin types (lowercase) — used by deriveDepositPrices
// for deposit/withdrawal pricing when ticks + coin types are present. Same
// set as the Bluefin route.
const STABLECOINS = new Set([
  '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::usdc',
  '0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::coin', // USDT
  '0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::coin', // wUSDC
]);

// Reward-token decimals by symbol: used ONLY to show the amount of a reward
// whose coin type the resolver could not read (such a claim stays unpriced).
const REWARD_DECIMALS_BY_SYMBOL: Record<string, number> = {
  SUI: 9, CETUS: 9, NAVX: 9, DEEP: 6, USDC: 6, USDT: 6, DAI: 18, WETH: 8, WBTC: 8,
};

export type ActivityEventType = 'deposit' | 'withdrawal' | 'fee_claim' | 'reward_claim';

export interface ActivityEvent {
  type: ActivityEventType;
  txHash: string;           // Sui transaction digest
  timestamp: number;        // unix seconds
  amount0: number;          // amount_a (or reward amount when type=reward_claim)
  amount1: number;          // amount_b (0 for reward_claim)
  usdAtTime: number | null; // null if price unavailable
  price0AtTime: number | null;
  price1AtTime: number | null;
  // ITEM 0b — set ONLY when this event's claim-date historical price was cold
  // and CURRENT SPOT was substituted. Consumers treat it as not-yet-final.
  priceBasis?: 'current-spot-substituted' | 'tick-derived-estimate';
  // A claim priced from the nearest earlier day (≤ 3 days): the page counts it
  // and marks Fees `≈` (pricing-invariants Rule 1a).
  claimPriceBasis?: 'nearby-day' | 'underlying-asset';
  cumulativeFeeUSD: number; // running total of fee+reward USD; 0 for non-fee events
  rewardSymbol?: string;    // set on reward_claim
  rewardCoinType?: string;  // set on reward_claim: the coin type the event names
}

interface ActivityResponse {
  events: ActivityEvent[];
  netInvested0: number;
  netInvested1: number;
  totalFees0: number;
  totalFees1: number;
}


// Fetch the set of Cetus Position object IDs CURRENTLY owned by `account`.
// This is one half of the wallet-scope "ever owned" set; the other half is
// built in-memory from OpenPositionEvent entries in the wallet's tx history
// (see the pre-loop in GET below) so closed/destroyed positions still
// contribute. Mirrors the pagination pattern in app/api/cetus/route.ts.
async function fetchOwnedPositionIds(account: string): Promise<Set<string>> {
  const ids = new Set<string>();
  let cursor: string | null = null;
  do {
    const result = await suiRpc('suix_getOwnedObjects', [
      account,
      { filter: { StructType: CETUS_POSITION_TYPE }, options: { showType: false, showContent: false } },
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

// History comes from the shared Sui history client (app/lib/suiHistory.ts):
// per position it reads the position OBJECT's history, so a position opened
// through a router or received by transfer still has its deposit; a read that
// cannot be completed throws, and is never passed off as "no on-chain history".
interface SuiTxBlock {
  digest: string;
  timestampMs: string;
  events: Array<{ type: string; parsedJson: Record<string, unknown> }>;
}


// CollectRewardV2Event carries rewarder_type as {name: "…::module::SYMBOL"}
// (NOT 0x-prefixed). Extract the trailing symbol for pricing + decimals lookup.
function extractRewardSymbol(rewarderType: unknown): string {
  if (!rewarderType || typeof rewarderType !== 'object') return '';
  const name = (rewarderType as Record<string, unknown>).name;
  if (typeof name !== 'string') return '';
  const parts = name.split('::');
  return parts[parts.length - 1] ?? '';
}

export const GET = withActivityRouteCache(GET_impl);

async function GET_impl(request: Request) {
  const __storeT0 = Date.now(); // batch C 1d: store writes that fail during this request
  const { searchParams } = new URL(request.url);
  const positionId = searchParams.get('positionId'); // raw Sui object ID, or "all"
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
  // Wallet-scope mode (positionId="all"): emit fee_claim + reward_claim events
  // across every Cetus position this wallet ever interacted with — including
  // fully-closed ones whose object is destroyed. Deposits/withdrawals are
  // omitted (ambiguous across pools). Same pattern as Bluefin.
  const walletScope = positionId === 'all';

  try {
    // Sprint SPOT-RESILIENCE-V2 (Bug B): per-position mode also unions txs that
    // changed the position object (router-opened / received positions), and the
    // scan fails loud on a partial page rather than truncating to a false
    // no_deposits. Wallet-scope is unchanged (FromAddress only).
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
        ...(withStoreWriteNotice(historyNotices, __storeT0, 'Cetus history').length > 0 ? { truncated: withStoreWriteNotice(historyNotices, __storeT0, 'Cetus history') } : {}),
      } as ActivityResponse);
    }

    // Wallet-scope only: build the set of Cetus Position object IDs the
    // wallet has EVER owned, used below to filter out fee/reward events
    // emitted against OTHER users' positions (router/aggregator scenarios)
    // while still keeping fees from positions the user opened and later
    // fully closed (object destroyed).
    //
    // The set unions two sources:
    //   (1) suix_getOwnedObjects → currently-owned (open) positions
    //   (2) OpenPositionEvent entries in the tx history we're about to
    //       fetch anyway → catches closed/destroyed positions too
    //
    // Per-position mode already filters by parsedJson.position === positionId,
    // so neither source is consulted there.
    const everOwnedPositionIds = walletScope ? await fetchOwnedPositionIds(account) : new Set<string>();

    const allTxBlocks: SuiTxBlock[] = history.blocks;

    // Source 2: collect position IDs from OpenPositionEvent in tx history.
    // Single in-memory pass — no extra RPCs (allTxBlocks is already loaded).
    // Must complete BEFORE the main event loop below so fee/reward filtering
    // sees the full union.
    if (walletScope) {
      for (const tx of allTxBlocks) {
        if (!tx?.events) continue;
        for (const ev of tx.events) {
          if (!CETUS_PKGS.some((pkg) => ev.type.startsWith(pkg))) continue;
          if (!ev.type.endsWith('::OpenPositionEvent')) continue;
          const id = (ev.parsedJson?.position as string) ?? '';
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
        if (!CETUS_PKGS.some((pkg) => ev.type.startsWith(pkg))) continue;
        const pj = ev.parsedJson ?? {};
        // Cetus position-object id is in `position` (NOT position_id).
        const evPosId = (pj.position as string) ?? '';
        if (!walletScope && evPosId !== positionId) continue;

        const evName = ev.type.split('::').pop() ?? '';

        // Wallet-scope only aggregates fee + reward events — deposits /
        // withdrawals are pool-specific and not useful across positions.
        if (walletScope) {
          if (evName !== 'CollectFeeEvent' && evName !== 'CollectRewardV2Event') continue;
          // Reject events whose `position` is not in the wallet's
          // ever-owned set (currently-owned ∪ ever-opened-via-tx-history).
          // Filters out fee/reward events emitted by routers / aggregators
          // acting on positions the user does NOT own, while keeping fees
          // from positions the user opened and later closed.
          if (!everOwnedPositionIds.has(evPosId)) continue;
        }

        // V1 note (Krishna DEEP/SUI investigation, 2026-07-18): liquidity added or
        // removed via the ORIGINAL Cetus CLMM entry points emits
        // 0x1eabed72…::pool::AddLiquidityEvent / RemoveLiquidityEvent (no V2
        // suffix) with the SAME amount_a/amount_b/position fields. A V2 tx emits
        // ONLY the V2 event (verified live: 2rpXfLgv…), so matching both names
        // cannot double count; the CETUS_PKGS gate above keeps Momentum's
        // identically-named events out. Without the V1 names, a pre-V2 deposit is
        // invisible → false "No deposit events found on-chain" → position
        // excluded from Capital G/L.
        if (evName === 'AddLiquidityV2Event' || evName === 'AddLiquidityEvent') {
          const a0 = BigInt((pj.amount_a as string) ?? '0');
          const a1 = BigInt((pj.amount_b as string) ?? '0');
          deposited0 += a0; deposited1 += a1;
          rawEvents.push({ type: 'deposit', txHash: tx.digest, timestamp: ts, amount0Raw: a0, amount1Raw: a1, sqrtPrice: pj.current_sqrt_price });

        } else if (evName === 'RemoveLiquidityV2Event' || evName === 'RemoveLiquidityEvent') {
          const a0 = BigInt((pj.amount_a as string) ?? '0');
          const a1 = BigInt((pj.amount_b as string) ?? '0');
          withdrawn0 += a0; withdrawn1 += a1;
          rawEvents.push({ type: 'withdrawal', txHash: tx.digest, timestamp: ts, amount0Raw: a0, amount1Raw: a1, sqrtPrice: pj.current_sqrt_price });

        } else if (evName === 'CollectFeeEvent') {
          const a0 = BigInt((pj.amount_a as string) ?? '0');
          const a1 = BigInt((pj.amount_b as string) ?? '0');
          fees0 += a0; fees1 += a1;
          rawEvents.push({ type: 'fee_claim', txHash: tx.digest, timestamp: ts, amount0Raw: a0, amount1Raw: a1, poolId: (pj.pool as string) ?? undefined });

        } else if (evName === 'CollectRewardV2Event') {
          const rewardAmt = BigInt((pj.amount as string) ?? '0');
          const rewardSymbol = extractRewardSymbol(pj.rewarder_type) || 'REWARD';
          const rewardDecimals = REWARD_DECIMALS_BY_SYMBOL[rewardSymbol.toUpperCase()] ?? 9;
          const rewardCoinType = suiCoinTypeFromEvent(pj.rewarder_type) || undefined;
          rawEvents.push({
            type: 'reward_claim',
            txHash: tx.digest,
            timestamp: ts,
            amount0Raw: rewardAmt,
            amount1Raw: 0n,
            rewardSymbol,
            rewardDecimals,
            rewardCoinType,
          });
        }
        // OpenPositionEvent / ClosePositionEvent (no amounts) — ignored.
      }
    }

    // Sort chronologically (oldest first) so the cumulative fee total is correct.
    rawEvents.sort((a, b) => a.timestamp - b.timestamp);

    // Sprint TOKEN-RESOLUTION: resolve each fee claim's REAL pool context from its
    // on-chain pool object (Cetus fee events carry `pool`), so the historical
    // cascade prices the correct token on each side instead of a single
    // representative/hardcoded (coinTypeA, coinTypeB). Wallet-scope only;
    // per-position mode already gets the right coin types from the open position.
    // Immutable `Pool<A,B>` type params → cached in-process.
    const resolvedPools: Map<string, SuiPoolContext> = walletScope
      ? await resolveSuiPoolContexts(
          rawEvents.filter((e) => e.type === 'fee_claim' && e.poolId).map((e) => e.poolId!),
        )
      : new Map();
    // Effective per-fee-claim pool context: resolved REAL pool in wallet-scope,
    // else the passed (open-position) context. null → pending (Rule 1a), never
    // priced with a guessed/hardcoded token type.
    const feeCtxFor = (ev: RawEvent): SuiPoolContext | null =>
      walletScope
        ? (ev.poolId ? (resolvedPools.get(ev.poolId) ?? null) : null)
        : { coinTypeA, coinTypeB, decimalsA, decimalsB };

    // Claim pricing (pricing-invariants Rule 1 / 1a): every fee and reward
    // claim side is valued by COIN TYPE at its claim day, never spot. Reward
    // identity comes from the coin type the event names (`rewarder_type`).
    const suiCanonical = SUI_CANONICAL;
    const rewardMeta = await resolveSuiRewardMetas(
      rawEvents.filter((e) => e.type === 'reward_claim' && e.rewardCoinType).map((e) => e.rewardCoinType!),
    );
    for (const e of rawEvents) {
      const m = e.type === 'reward_claim' && e.rewardCoinType ? rewardMeta.get(e.rewardCoinType) : undefined;
      if (m?.decimalsKnown) { e.rewardDecimals = m.decimals; e.rewardSymbol = m.symbol || e.rewardSymbol; }
    }
    {
      const sides: ClaimSideInput[] = [];
      for (const e of rawEvents) {
        if (e.type === 'fee_claim') {
          const c = feeCtxFor(e);
          if (!c) continue;
          sides.push({ coinType: c.coinTypeA, isStable: STABLECOINS.has(c.coinTypeA.toLowerCase()), isSui: c.coinTypeA.toLowerCase() === suiCanonical, ts: e.timestamp });
          sides.push({ coinType: c.coinTypeB, isStable: STABLECOINS.has(c.coinTypeB.toLowerCase()), isSui: c.coinTypeB.toLowerCase() === suiCanonical, ts: e.timestamp });
        } else if (e.type === 'reward_claim' && e.rewardCoinType) {
          const m = rewardMeta.get(e.rewardCoinType);
          if (m?.decimalsKnown && e.amount0Raw > 0n) sides.push({ coinType: m.coinType, isStable: m.isStable, isSui: m.isSui, ts: e.timestamp });
        }
      }
      await prewarmSuiClaimPrices(sides);
    }

    const hasTicks = tickLower != null && tickUpper != null;
    let runningFeeUSD = 0;
    // [PRICE_LOG] instrumentation (additive only) — per-request fee/reward counters
    const __route = 'cetus';
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
      let claimPriceBasis: 'nearby-day' | 'underlying-asset' | undefined;
      // Sprint 1.15: which historical source priced a fee claim (for the
      // read-only [PRICE_LOG] re-derivation below). NEVER 'cg-spot' — fee claims
      // are historical-only (Rule 1a).
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
      // Unknown coin type or decimals → unpriced (counted), never spot.
      if (ev.type === 'reward_claim') {
        const m = ev.rewardCoinType ? rewardMeta.get(ev.rewardCoinType) : undefined;
        const side = m?.decimalsKnown ? priceSuiClaimSide(m.coinType, m.isStable, m.isSui, ev.timestamp) : null;
        if (side?.price != null) {
          price0AtTime = side.price;
          price1AtTime = null;
          usdAtTime = amount0 * side.price;
          __feeClaimSrc = side.src;
          if (side.nearby) claimPriceBasis = side.underlying ? 'underlying-asset' : 'nearby-day';
        } else {
          price0AtTime = null;
          price1AtTime = null;
          usdAtTime = null;
        }
      } else if (ev.type === 'fee_claim') {
        // Sprint TOKEN-RESOLUTION: price each side using the REAL pool's coin types
        // (resolved per event via `fctx`), NOT a single representative. Cetus fee
        // claims are valued at CLAIM-DATE historical ONLY (pricing-invariants Rule
        // 1a) — NEVER current spot. Per side: a stablecoin is $1; the SUI side uses
        // CoinGecko historical (prewarmed) then DeFiLlama historical-by-coin-type;
        // any other non-stable side uses DeFiLlama historical. If a side cannot be
        // priced historically — OR the pool could not be resolved — the claim stays
        // UNRESOLVED (null) and surfaces as "pending price resolution"; it is NEVER
        // priced with a guessed/hardcoded token type. (The CETUS reward token's
        // spot+LKG path above is a separate, designated Rule 1 exception, untouched.)
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
            if (sA.nearby || sB.nearby) claimPriceBasis = (sA.underlying || sB.underlying) ? 'underlying-asset' : 'nearby-day';
          }
          // else: usdAtTime stays null → pending (Rule 1a — no spot fallback).
        } else {
          __feeClaimSrc = 'pending_pool_unresolved';
        }
      } else if (usdAtTime == null) {
        // Withdrawal / deposit where on-chain derivation (deriveDepositPrices)
        // was unavailable: current-spot last resort. Allowed by pricing-invariants
        // Rule 2 (a point-in-time position value, NOT historical earnings).
        // Never applies to fee claims (handled above).
        // ITEM 0b: allowed but MARKED — never silently substituted.
        price0AtTime = fallbackA || null;
        price1AtTime = fallbackB || null;
        if (fallbackA > 0 || fallbackB > 0) {
          usdAtTime = amount0 * fallbackA + amount1 * fallbackB;
          priceBasis = 'current-spot-substituted';
        }
      }

      // FIX B: a claim whose only token amount is zero is a real on-chain
      // artifact (protocol-side rebalance / dust sweep), NOT a pricing failure.
      // Value it at $0, treat it as resolved, and keep it OUT of the failures
      // list. Applies to both reward_claim (single token = amount0) and
      // fee_claim (both sides zero).
      const __isZeroAmount =
        (ev.type === 'reward_claim' && amount0 === 0) ||
        (ev.type === 'fee_claim' && amount0 === 0 && amount1 === 0);
      if (__isZeroAmount) usdAtTime = 0;

      // (Sprint 1.15: the Sprint 1.12 additive DeFiLlama fallback that lived here
      // is now folded into the fee_claim historical cascade above — DeFiLlama is
      // a first-class historical tier for both the SUI side and non-SUI sides,
      // not an after-the-fact null-only patch.)

      let cumulativeFeeUSD = 0;
      if (ev.type === 'fee_claim' || ev.type === 'reward_claim') {
        runningFeeUSD += usdAtTime ?? 0;
        cumulativeFeeUSD = runningFeeUSD;
      }

      // [PRICE_LOG] fee/reward resolution — read-only source re-derivation,
      // mirrors the Sui pricing rules above without altering any value.
      if (ev.type === 'fee_claim' || ev.type === 'reward_claim') {
        __totalClaims++; __totalLookups++;
        const __tokLabel = ev.type === 'reward_claim' ? (ev.rewardSymbol ?? 'REWARD') : `${coinTypeA}/${coinTypeB}`;
        if (__isZeroAmount) {
          // FIX B: resolved-at-zero, never counted as a failure.
          __srcBreakdown['zero_amount'] = (__srcBreakdown['zero_amount'] ?? 0) + 1;
          __resolvedClaims++;
          logPrice({
            event: 'fee_claim_resolution',
            route: __route,
            positionId: __posId,
            blockTimestamp: ev.timestamp,
            token0: { symbol: ev.type === 'reward_claim' ? (ev.rewardSymbol ?? 'REWARD') : coinTypeA, address: ev.type === 'reward_claim' ? undefined : coinTypeA, amount: String(amount0) },
            token1: { symbol: ev.type === 'reward_claim' ? '' : coinTypeB, address: ev.type === 'reward_claim' ? undefined : coinTypeB, amount: String(amount1) },
            token0Usd: price0AtTime,
            token1Usd: price1AtTime,
            usdAtTime: 0,
            status: 'ok',
            notes: 'zero_amount',
          });
        } else {
          // Whatever source the cascade above recorded (claim-day historical
          // per side; never cg-spot).
          const __src: string = __feeClaimSrc;
          __srcBreakdown[__src] = (__srcBreakdown[__src] ?? 0) + 1;
          const __ok = usdAtTime != null && usdAtTime > 0;
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

    // Newest-first for display.
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
      ...(withStoreWriteNotice(historyNotices, __storeT0, 'Cetus history').length > 0 ? { truncated: withStoreWriteNotice(historyNotices, __storeT0, 'Cetus history') } : {}),
    } as ActivityResponse);
  } catch (err) {
    console.error('[cetus/activity] Unexpected error:', err);
    return NextResponse.json(
      { error: 'Failed to fetch Cetus activity', details: String(err) },
      { status: 500 },
    );
  }
}
