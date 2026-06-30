import { NextResponse } from 'next/server';
import { withActivityRouteCache } from '../../../lib/activityRouteCache';
import { deriveDepositPrices } from '../../../lib/v3PriceDerivation';
import { prewarmSuiPricesForTimestamps, getHistoricalOnlySuiPrice } from '../../../lib/suiPriceHistory';
import { prewarmDefillamaPrices, getCachedOnlyDefillamaPrice } from '../../../lib/defillamaPriceHistory';
import { resolveToken } from '../../../lib/tokenResolver';
import { resolveSuiPoolContexts, type SuiPoolContext } from '../../../lib/suiPoolContext';
import { logPrice } from '../../../lib/priceLogger';

// Sprint MOMENTUM — Momentum (Sui CLMM) activity route, modeled on the Bluefin
// route (app/api/bluefin/activity/route.ts, 17c5101). Built historical-only from
// the START (pricing-invariants Rule 1a): a fee/reward claim is NEVER valued at
// current spot. Per side: stablecoin → $1; SUI → CoinGecko-historical
// (getHistoricalOnlySuiPrice, the PURE historical reader — never the FIX-C
// cg-spot spotFallback) → DeFiLlama historical-by-coin-type → pending; any other
// non-stable side → DeFiLlama historical → pending. Deposits/withdrawals keep the
// on-chain tick derivation + the Rule 2 current-spot LAST RESORT (a point-in-time
// position value, NOT historical earnings) — never reached by fee/reward claims.
//
// Momentum vs Bluefin/Cetus event shapes (Sprint MOMENTUM Phase A, verified
// on-chain): position-id field `position_id`; amounts `amount_x`/`amount_y`;
// deposit `AddLiquidityEvent`, withdrawal `RemoveLiquidityEvent`, fee
// `FeeCollectedEvent`, reward `CollectPoolRewardEvent` (carries the FULL
// `reward_coin_type`, unlike Bluefin's symbol-only reward — so rewards are valued
// historical-only via resolveToken, NOT spot). Momentum liquidity events carry NO
// `current_sqrt_price`, so deposit/withdrawal pricing relies on the tick
// derivation (same as Bluefin when sqrt is unavailable).

const SUI_RPC = process.env.SUI_RPC_URL || 'https://fullnode.mainnet.sui.io:443';

const MOMENTUM_PKG = '0x70285592c97965e811e0c6f98dccc3a9c2b4ad854b3594faab9597ada267b860';

// Sui object type of a Momentum Position. Used in wallet-scope mode to filter
// fee/reward events down to positions the wallet actually owns (rejects events
// a router/aggregator emitted against OTHER users' positions). Same trade-off as
// Bluefin: this also excludes FULLY-CLOSED positions (object destroyed), so the
// ever-owned set is unioned with position ids seen in the wallet's own
// Add/Open events below.
const MOMENTUM_POSITION_TYPE =
  '0x70285592c97965e811e0c6f98dccc3a9c2b4ad854b3594faab9597ada267b860::position::Position';

// Known Sui stablecoins (lowercase for comparison) — pool-side anchor to $1.
const STABLECOINS = new Set([
  '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::usdc',
  '0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::coin', // USDT
  '0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::coin', // wUSDC
]);

// Stablecoin CoinGecko ids — reward-token $1 anchor (reward valuation resolves
// the token's cgId via resolveToken, so we key on the id, not the symbol).
const STABLE_CGIDS = new Set(['usd-coin', 'tether', 'dai']);

const SUI_CANONICAL = '0x2::sui::sui';

export type ActivityEventType = 'deposit' | 'withdrawal' | 'fee_claim' | 'reward_claim';

export interface ActivityEvent {
  type: ActivityEventType;
  txHash: string;           // Sui transaction digest
  timestamp: number;        // unix seconds
  amount0: number;          // amount_x (human-readable)
  amount1: number;          // amount_y
  usdAtTime: number | null; // null if historical price could not be resolved
  price0AtTime: number | null;
  price1AtTime: number | null;
  cumulativeFeeUSD: number; // running total of fee+reward USD; 0 for non-fee events
  rewardSymbol?: string;    // set for reward_claim events
}

interface ActivityResponse {
  events: ActivityEvent[];
  netInvested0: number;
  netInvested1: number;
  totalFees0: number;
  totalFees1: number;
}

async function suiRpc(method: string, params: unknown[]) {
  const res = await fetch(SUI_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json();
  return json.result;
}

// Normalize a Sui coin type to short form (`0x2::sui::SUI`), stripping the
// leading zero-padding the RPC returns for reward_coin_type TypeName structs.
function normalizeCoinType(ct: string): string {
  if (!ct) return ct;
  const prefixed = ct.startsWith('0x') ? ct : `0x${ct}`;
  return prefixed.replace(/^0x0+([0-9a-f]+::)/, '0x$1');
}

// Extract a coin type string from a 0x1::type_name::TypeName struct (flat
// `{ name }` or nested `{ fields: { name } }`).
function extractTypeName(val: unknown): string {
  if (!val) return '';
  if (typeof val === 'string') return val;
  const v = val as Record<string, unknown>;
  if (typeof v.name === 'string') return v.name;
  const fields = v.fields as Record<string, unknown> | undefined;
  if (fields && typeof fields.name === 'string') return fields.name;
  return '';
}

// Fetch the set of Momentum Position object IDs CURRENTLY owned by `account`
// (one half of the wallet-scope "ever owned" set; the other half is built from
// AddLiquidity/OpenPosition events in the wallet's tx history below).
async function fetchOwnedPositionIds(account: string): Promise<Set<string>> {
  const ids = new Set<string>();
  let cursor: string | null = null;
  do {
    const result = await suiRpc('suix_getOwnedObjects', [
      account,
      { filter: { StructType: MOMENTUM_POSITION_TYPE }, options: { showType: false, showContent: false } },
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

// Fetch all wallet transaction digests, paginating through all pages.
async function fetchAllDigests(account: string): Promise<string[]> {
  const digests: string[] = [];
  let cursor: string | null = null;
  do {
    const result = await suiRpc('suix_queryTransactionBlocks', [
      { filter: { FromAddress: account } },
      cursor,
      50,
      true, // descending (newest first)
    ]) as { data: Array<{ digest: string }>; nextCursor?: string; hasNextPage?: boolean } | null;
    if (!result) break;
    digests.push(...result.data.map((t) => t.digest));
    cursor = result.hasNextPage ? (result.nextCursor ?? null) : null;
  } while (cursor);
  return digests;
}

interface SuiTxBlock {
  digest: string;
  timestampMs: string;
  events: Array<{ type: string; parsedJson: Record<string, unknown> }>;
}

// Batch-fetch transaction blocks with events (25 at a time).
async function fetchTransactionEvents(digests: string[]): Promise<SuiTxBlock[]> {
  const results: SuiTxBlock[] = [];
  const BATCH = 25;
  for (let i = 0; i < digests.length; i += BATCH) {
    const batch = digests.slice(i, i + BATCH);
    const txBlocks = await suiRpc('sui_multiGetTransactionBlocks', [
      batch,
      { showEvents: true, showInput: false, showEffects: false, showObjectChanges: false, showBalanceChanges: false },
    ]) as SuiTxBlock[] | null;
    if (txBlocks) results.push(...txBlocks);
  }
  return results;
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
  // Momentum position this wallet ever interacted with — including positions
  // fully closed on-chain (object destroyed). This recovers fee/reward history
  // from destroyed positions (per-position scans can't see them). Deposits /
  // withdrawals are omitted in this mode (pool-ambiguous across positions).
  const walletScope = positionId === 'all';

  try {
    const allDigests = await fetchAllDigests(account);
    if (allDigests.length === 0) {
      return NextResponse.json({
        events: [], netInvested0: 0, netInvested1: 0, totalFees0: 0, totalFees1: 0,
      } as ActivityResponse);
    }

    // Wallet-scope only: build the set of Momentum Position object IDs the
    // wallet has EVER owned. Source 1 = currently-owned (suix_getOwnedObjects);
    // Source 2 (below) = AddLiquidityEvent + OpenPositionEvent in tx history,
    // which catches closed/destroyed positions. Per-position mode filters by
    // parsedJson.position_id === positionId, so neither source is consulted.
    const everOwnedPositionIds = walletScope ? await fetchOwnedPositionIds(account) : new Set<string>();

    const allTxBlocks = await fetchTransactionEvents(allDigests);

    if (walletScope) {
      for (const tx of allTxBlocks) {
        if (!tx?.events) continue;
        for (const ev of tx.events) {
          if (!ev.type.startsWith(MOMENTUM_PKG)) continue;
          const name = ev.type.split('::').pop() ?? '';
          if (name !== 'AddLiquidityEvent' && name !== 'OpenPositionEvent') continue;
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
      rewardCoinType?: string;  // momentum reward: full (normalized) coin type
      rewardSymbol?: string;    // display only
      rewardDecimals?: number;  // resolved decimals (set after resolveToken)
      poolId?: string;          // fee_claim only — for per-event pool-context resolution
    }

    const rawEvents: RawEvent[] = [];
    let deposited0 = 0n, deposited1 = 0n;
    let withdrawn0 = 0n, withdrawn1 = 0n;
    let fees0 = 0n, fees1 = 0n;

    for (const tx of allTxBlocks) {
      if (!tx?.events) continue;
      const ts = tx.timestampMs ? Math.floor(parseInt(tx.timestampMs, 10) / 1000) : 0;

      for (const ev of tx.events) {
        if (!ev.type.startsWith(MOMENTUM_PKG)) continue;
        const pj = ev.parsedJson ?? {};
        const evPosId = (pj.position_id as string) ?? '';
        if (!walletScope && evPosId !== positionId) continue;

        const evName = ev.type.split('::').pop() ?? '';

        // In wallet-scope mode only emit fee + reward events — deposits /
        // withdrawals are pool-specific and not useful aggregated across
        // multiple destroyed positions.
        if (walletScope) {
          if (evName !== 'FeeCollectedEvent' && evName !== 'CollectPoolRewardEvent') continue;
          // Reject fee/reward events whose position_id is not in the wallet's
          // ever-owned set (currently-owned ∪ ever-opened-via-tx-history) —
          // filters router/aggregator events against positions the user does
          // NOT own, while keeping fees from positions opened then closed.
          if (!everOwnedPositionIds.has(evPosId)) continue;
        }

        if (evName === 'AddLiquidityEvent') {
          const a0 = BigInt((pj.amount_x as string) ?? '0');
          const a1 = BigInt((pj.amount_y as string) ?? '0');
          deposited0 += a0;
          deposited1 += a1;
          rawEvents.push({ type: 'deposit', txHash: tx.digest, timestamp: ts, amount0Raw: a0, amount1Raw: a1 });

        } else if (evName === 'RemoveLiquidityEvent') {
          const a0 = BigInt((pj.amount_x as string) ?? '0');
          const a1 = BigInt((pj.amount_y as string) ?? '0');
          withdrawn0 += a0;
          withdrawn1 += a1;
          rawEvents.push({ type: 'withdrawal', txHash: tx.digest, timestamp: ts, amount0Raw: a0, amount1Raw: a1 });

        } else if (evName === 'FeeCollectedEvent') {
          const a0 = BigInt((pj.amount_x as string) ?? '0');
          const a1 = BigInt((pj.amount_y as string) ?? '0');
          fees0 += a0;
          fees1 += a1;
          rawEvents.push({ type: 'fee_claim', txHash: tx.digest, timestamp: ts, amount0Raw: a0, amount1Raw: a1, poolId: (pj.pool_id as string) ?? undefined });

        } else if (evName === 'CollectPoolRewardEvent') {
          const rewardAmt = BigInt((pj.amount as string) ?? '0');
          const rewardType = normalizeCoinType(extractTypeName(pj.reward_coin_type));
          rawEvents.push({
            type: 'reward_claim',
            txHash: tx.digest,
            timestamp: ts,
            amount0Raw: rewardAmt,
            amount1Raw: 0n,
            rewardCoinType: rewardType || undefined,
            rewardSymbol: rewardType ? (rewardType.split('::').pop() ?? 'REWARD') : 'REWARD',
          });
        }
      }
    }

    // Sort chronologically (oldest first) for cumulative fee computation.
    rawEvents.sort((a, b) => a.timestamp - b.timestamp);

    // Sprint TOKEN-RESOLUTION: resolve each fee claim's REAL pool context from its
    // on-chain pool object (Momentum fee events carry pool_id), so the historical
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

    // Resolve reward-token identity (decimals + cgId + stable/SUI flags) via the
    // shared platform-wide tokenResolver (architecture Rule 9) for every unique
    // reward coin type. Used for the human amount AND the historical-only
    // valuation below. Reward tokens are NEVER spot-valued (Rule 1a).
    interface RewardMeta { decimals: number; isStable: boolean; isSui: boolean }
    const rewardMeta = new Map<string, RewardMeta>();
    const rewardTypes = [...new Set(
      rawEvents.filter((e) => e.type === 'reward_claim' && e.rewardCoinType).map((e) => e.rewardCoinType!),
    )];
    await Promise.all(rewardTypes.map(async (ct) => {
      let decimals = 9;
      let cgId: string | null = null;
      try {
        const tok = await resolveToken({ chain: 'sui', suiType: ct });
        decimals = tok.decimals;
        cgId = tok.cgId;
      } catch { /* graceful — leaves decimals=9, cgId=null → pending unless SUI */ }
      const isSui = ct.toLowerCase() === SUI_CANONICAL;
      const isStable = (cgId != null && STABLE_CGIDS.has(cgId)) || STABLECOINS.has(ct.toLowerCase());
      rewardMeta.set(ct, { decimals, isStable, isSui });
    }));
    for (const e of rawEvents) {
      if (e.type === 'reward_claim' && e.rewardCoinType) {
        e.rewardDecimals = rewardMeta.get(e.rewardCoinType)?.decimals ?? 9;
      }
    }

    // Historical pricing prewarm. Detect which pool side is SUI (canonical short
    // form, case-insensitive). Prewarm the per-date CoinGecko-SUI cache for every
    // fee-claim date, every SUI-side reward date — then the synchronous cascade
    // below reads it via getHistoricalOnlySuiPrice. Rule 1a: claim-date only.
    {
      const suiTs: number[] = [];
      for (const e of rawEvents) {
        if (e.type === 'fee_claim') {
          const c = feeCtxFor(e);
          if (c && (c.coinTypeA.toLowerCase() === SUI_CANONICAL || c.coinTypeB.toLowerCase() === SUI_CANONICAL)) {
            suiTs.push(e.timestamp);
          }
        } else if (e.type === 'reward_claim' && e.rewardCoinType) {
          const m = rewardMeta.get(e.rewardCoinType);
          if (m?.isSui) suiTs.push(e.timestamp);
        }
      }
      if (suiTs.length > 0) await prewarmSuiPricesForTimestamps(suiTs);
    }

    // Prewarm DeFiLlama claim-date historical-by-coin-type for every non-stable
    // pool side (fee claims, incl. the SUI side so a cold/missed CoinGecko-SUI
    // lookup falls to DeFiLlama instead of spot) and every non-stable reward
    // coin type. Stablecoins anchor at $1 (no fetch). Mirrors Bluefin/Cetus.
    {
      const dlByCoin = new Map<string, Set<number>>();
      const addDl = (contract: string, ts: number) => {
        if (!contract) return;
        const set = dlByCoin.get(contract) ?? dlByCoin.set(contract, new Set()).get(contract)!;
        set.add(ts);
      };
      const feeEligible = (ct: string) => !!ct && !STABLECOINS.has(ct.toLowerCase());
      for (const e of rawEvents) {
        if (e.type === 'fee_claim') {
          const c = feeCtxFor(e);
          if (!c) continue;
          if (feeEligible(c.coinTypeA)) addDl(c.coinTypeA, e.timestamp);
          if (feeEligible(c.coinTypeB)) addDl(c.coinTypeB, e.timestamp);
        } else if (e.type === 'reward_claim' && e.rewardCoinType) {
          const m = rewardMeta.get(e.rewardCoinType);
          if (m && !m.isStable) addDl(e.rewardCoinType, e.timestamp); // SUI fallback + non-SUI primary
        }
      }
      if (dlByCoin.size > 0) {
        await prewarmDefillamaPrices(
          [...dlByCoin].map(([contract, ts]) => ({ chain: 'sui' as const, contract, timestamps: [...ts] })),
        );
      }
    }

    const hasTicks = tickLower != null && tickUpper != null;
    let runningFeeUSD = 0;
    // [PRICE_LOG] instrumentation (additive only) — per-request fee/reward counters.
    const __route = 'momentum';
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
        const dec = ev.rewardDecimals ?? 9;
        amount0 = Number(ev.amount0Raw) / 10 ** dec;
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
      // Which historical source priced this claim (for the [PRICE_LOG] block).
      // NEVER 'cg-spot' for fee OR reward claims — Momentum claims are
      // historical-only from day one (Rule 1a).
      let __claimSrc = 'unknown';

      if ((ev.type === 'deposit' || ev.type === 'withdrawal') && hasTicks) {
        const derived = deriveDepositPrices(
          amount0, amount1, tickLower!, tickUpper!, decimalsA, decimalsB,
          coinTypeA, coinTypeB, STABLECOINS,
        );
        if (derived) {
          price0AtTime = derived.price0;
          price1AtTime = derived.price1;
          usdAtTime = amount0 * derived.price0 + amount1 * derived.price1;
        }
      }

      if (ev.type === 'reward_claim') {
        // Reward valuation — historical-ONLY via the resolved coin type
        // (Rule 1a, NEVER spot): stablecoin → $1; SUI → CoinGecko-historical
        // (getHistoricalOnlySuiPrice) then DeFiLlama historical-by-coin-type;
        // any other non-stable → DeFiLlama historical; else pending. Momentum
        // carries the full reward_coin_type, so no spot+LKG exception is needed.
        const ct = ev.rewardCoinType;
        const m = ct ? rewardMeta.get(ct) : undefined;
        let px: number | null = null;
        if (m?.isStable) { px = 1; __claimSrc = 'stablecoin-fixed'; }
        else if (m?.isSui) {
          const hist = getHistoricalOnlySuiPrice(ev.timestamp);
          if (hist != null) { px = hist; __claimSrc = 'sui-historical'; }
          else if (ct) {
            const dl = getCachedOnlyDefillamaPrice('sui', ct, ev.timestamp);
            if (dl != null) { px = dl; __claimSrc = 'defillama-historical'; }
          }
        } else if (ct) {
          const dl = getCachedOnlyDefillamaPrice('sui', ct, ev.timestamp);
          if (dl != null) { px = dl; __claimSrc = 'defillama-historical'; }
        }
        if (px != null) {
          price0AtTime = px;
          price1AtTime = null;
          usdAtTime = amount0 * px;
        }
        // else: usdAtTime stays null → pending (Rule 1a — no spot fallback).
      } else if (ev.type === 'fee_claim') {
        // Sprint TOKEN-RESOLUTION: price each side using the REAL pool's coin types
        // (resolved per event via `fctx`), NOT a single representative. Fee claims
        // valued at CLAIM-DATE historical ONLY (Rule 1a) — NEVER current spot. Per
        // side: stablecoin → $1; SUI side → CoinGecko historical (prewarmed) then
        // DeFiLlama historical-by-coin-type; any other non-stable side → DeFiLlama
        // historical. If a side can't be priced historically — OR the pool could
        // not be resolved — the claim stays UNRESOLVED (null) and surfaces as
        // pending; NEVER priced with a guessed/hardcoded token type, NEVER spot.
        if (fctx) {
          const __cA = fctx.coinTypeA, __cB = fctx.coinTypeB;
          const __sA = STABLECOINS.has(__cA.toLowerCase());
          const __sB = STABLECOINS.has(__cB.toLowerCase());
          const __suiA = __cA.toLowerCase() === SUI_CANONICAL;
          const __suiB = __cB.toLowerCase() === SUI_CANONICAL;
          const __histSui = getHistoricalOnlySuiPrice(ev.timestamp);
          let __usedDl = false;
          let __usedSuiHist = false;
          const priceSide = (coinType: string, isStable: boolean, isSui: boolean): number | null => {
            if (isStable) return 1;
            if (isSui) {
              if (__histSui != null) { __usedSuiHist = true; return __histSui; }
              const dl = getCachedOnlyDefillamaPrice('sui', coinType, ev.timestamp);
              if (dl != null) __usedDl = true;
              return dl;
            }
            const dl = getCachedOnlyDefillamaPrice('sui', coinType, ev.timestamp);
            if (dl != null) __usedDl = true;
            return dl;
          };
          const pxA = priceSide(__cA, __sA, __suiA);
          const pxB = priceSide(__cB, __sB, __suiB);
          if (pxA != null && pxB != null) {
            price0AtTime = pxA;
            price1AtTime = pxB;
            usdAtTime = amount0 * pxA + amount1 * pxB;
            __claimSrc = __usedDl ? 'defillama-historical' : __usedSuiHist ? 'sui-historical' : 'stablecoin-fixed';
          }
          // else: usdAtTime stays null → pending (Rule 1a — no spot fallback).
        } else {
          __claimSrc = 'pending_pool_unresolved';
        }
      } else if (usdAtTime == null) {
        // Withdrawal / deposit where the on-chain tick derivation was
        // unavailable: current-spot LAST RESORT. Allowed by pricing-invariants
        // Rule 2 (a point-in-time position value, NOT historical earnings).
        // NEVER applies to fee claims or rewards (handled above).
        const pxA = fallbackA;
        const pxB = fallbackB;
        price0AtTime = pxA || null;
        price1AtTime = pxB || null;
        if (pxA > 0 || pxB > 0) {
          usdAtTime = amount0 * pxA + amount1 * pxB;
        }
      }

      let cumulativeFeeUSD = 0;
      if (ev.type === 'fee_claim' || ev.type === 'reward_claim') {
        runningFeeUSD += usdAtTime ?? 0;
        cumulativeFeeUSD = runningFeeUSD;
      }

      // [PRICE_LOG] fee/reward resolution — read-only, uses the source recorded
      // above. NEVER 'cg-spot' (Rule 1a: Momentum claims are historical-only).
      if (ev.type === 'fee_claim' || ev.type === 'reward_claim') {
        const __src = __claimSrc;
        __totalClaims++; __totalLookups++;
        __srcBreakdown[__src] = (__srcBreakdown[__src] ?? 0) + 1;
        const __ok = usdAtTime != null && usdAtTime > 0;
        const __tokLabel = ev.type === 'reward_claim' ? (ev.rewardSymbol ?? 'REWARD') : `${coinTypeA}/${coinTypeB}`;
        if (__ok) __resolvedClaims++;
        else { __failedClaims++; __failures.push({ token: __tokLabel, blockTimestamp: ev.timestamp, reason: __src === 'unknown' ? 'no_price_any_source' : 'zero_usd' }); }
        logPrice({
          event: 'fee_claim_resolution',
          route: __route,
          positionId: __posId,
          blockTimestamp: ev.timestamp,
          token0: { symbol: ev.type === 'reward_claim' ? (ev.rewardSymbol ?? 'REWARD') : coinTypeA, address: ev.type === 'reward_claim' ? ev.rewardCoinType : coinTypeA, amount: String(amount0) },
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
        cumulativeFeeUSD,
        ...(ev.rewardSymbol ? { rewardSymbol: ev.rewardSymbol } : {}),
      };
    });

    // Reverse to newest-first for display.
    events.reverse();

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
    } as ActivityResponse);
  } catch (err) {
    console.error('[momentum/activity] Unexpected error:', err);
    return NextResponse.json(
      { error: 'Failed to fetch Momentum activity', details: String(err) },
      { status: 500 },
    );
  }
}
