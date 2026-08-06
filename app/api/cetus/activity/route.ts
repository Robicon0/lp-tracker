import { NextResponse } from 'next/server';
import { suiRpc, suiRpcIndexed, SuiIndexUnavailableError } from '../../../lib/suiRpc';
import { withActivityRouteCache } from '../../../lib/activityRouteCache';
import { deriveDepositPrices } from '../../../lib/v3PriceDerivation';
import { prewarmSuiPricesForTimestamps, getCachedSuiPriceForTimestamp, getHistoricalOnlySuiPrice } from '../../../lib/suiPriceHistory';
import { prewarmDefillamaPrices, getCachedOnlyDefillamaPrice } from '../../../lib/defillamaPriceHistory';
import { resolveSuiPoolContexts, type SuiPoolContext } from '../../../lib/suiPoolContext';
import { logPrice } from '../../../lib/priceLogger';
import { fetchCachedCoinGeckoPrices } from '../../../lib/priceCache';

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

// Reward-token symbols that are USD-pegged stablecoins (matched on symbol).
const STABLE_SYMBOLS = new Set([
  'USDC', 'USDT', 'DAI', 'USDe', 'sUSDe', 'USDY', 'wUSDC', 'USDHL',
]);

// Reward-token decimals lookup by symbol — used to scale CollectRewardV2Event
// `amount` to a human-readable value. Default 9 when unknown (most Sui tokens
// use 9 decimals; the route also gracefully handles unknown symbols).
const REWARD_DECIMALS_BY_SYMBOL: Record<string, number> = {
  SUI: 9, CETUS: 9, NAVX: 9, DEEP: 6, USDC: 6, USDT: 6, DAI: 18, WETH: 8, WBTC: 8,
};

// FIX A: explicit Sui token → CoinGecko ID maps for the two tokens the
// pool-side fallbacks (priceA/priceB) and symbol-matches-pool-side rules
// repeatedly miss — SUI (as a coin type or a bare reward symbol) and CETUS
// (the reward token for almost every Cetus pool, which is rarely one of the
// pool's own sides). When the claim-time historical SUI price is unavailable,
// or the reward token isn't a pool side, these resolve to the CURRENT cg-spot
// price (60s-cached simple/price) so the claim is valued rather than dropped.
// CETUS → cetus-protocol verified via CoinGecko search (rank #885) and matches
// KNOWN_TOKENS in app/api/cetus/route.ts.
const CG_ID_BY_SYMBOL: Record<string, string> = {
  SUI: 'sui',
  CETUS: 'cetus-protocol',
};
const CG_ID_BY_COINTYPE: Record<string, string> = {
  '0x2::sui::sui': 'sui',
  '0x06864a6f921804860930db6ddbe2e16acdf8504495ea7481637a1c8b9a8fe54b::cetus::cetus': 'cetus-protocol',
};

// FIX A robustness: fetchCachedCoinGeckoPrices returns 0 (and caches nothing)
// on a transient CoinGecko 429, which under heavy page load would drop EVERY
// CETUS reward in that request — a rate-limit race identical to the Bluefin
// one we just fixed. To make CETUS resolution deterministic instead of
// race-dependent, persist the last-known-good cg-spot per id at module scope
// (CETUS spot barely moves intraday, so a slightly stale value is correct
// enough for fee valuation and infinitely better than dropping the claim),
// and give a single short retry to any id that comes back 0 with no prior
// good value. Once ANY route call fetches it successfully, every later call in
// the process reuses it.
const spotPriceLkg = new Map<string, number>();

async function fetchSpotPrices(ids: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  if (ids.length === 0) return out;
  let fetched = await fetchCachedCoinGeckoPrices(ids);
  // Patient cold-start retries: ONLY for ids that are still 0 AND have no prior
  // good value in the process-wide LKG. Once an id lands in spotPriceLkg every
  // later call reuses it (no TTL), so this retry cost is paid at most once per
  // token per process even through a transient CoinGecko 429 burst. simple/price
  // is far more budget-efficient than per-day history (1 call prices every CETUS
  // claim), so a few spaced retries reliably win the rate-limit race.
  for (const delay of [1500, 3000, 6000]) {
    const missing = ids.filter((id) => !((fetched[id] ?? 0) > 0) && !((spotPriceLkg.get(id) ?? 0) > 0));
    if (missing.length === 0) break;
    await new Promise((r) => setTimeout(r, delay));
    const retry = await fetchCachedCoinGeckoPrices(missing);
    fetched = { ...fetched, ...retry };
  }
  for (const id of ids) {
    const v = fetched[id] ?? 0;
    if (v > 0) spotPriceLkg.set(id, v);
    out[id] = v > 0 ? v : (spotPriceLkg.get(id) ?? 0);
  }
  return out;
}

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
  cumulativeFeeUSD: number; // running total of fee+reward USD; 0 for non-fee events
  rewardSymbol?: string;    // set on reward_claim
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

// Fetch every transaction digest matching a queryTransactionBlocks filter,
// paginating through all pages.
//
// Sprint SPOT-RESILIENCE-V2 (Bug B): FAIL-LOUD on a partial scan. suiRpc returns
// `undefined` when every endpoint fails a page under load; the old code did
// `if (!result) break`, which SILENTLY TRUNCATED the digest list — and if the
// truncated slice held a position's deposit tx, `computePositionPnL` reported a
// false `no_deposits` that LOOKS authoritative. Now a failed page is retried
// once; if it still fails we THROW, so the route returns 500 → the client
// degrades the position to STALE (last-known-good) instead of asserting the
// position has no deposits. An incomplete scan must never masquerade as "no
// on-chain history".
async function fetchDigestsByFilter(filter: Record<string, unknown>, indexed = false): Promise<string[]> {
  const digests: string[] = [];
  let cursor: string | null = null;

  // indexed=true routes through suiRpcIndexed (PRIMARY endpoint only): object
  // filters like ChangedObject aren't served by the public fallback — it
  // answers a silent `{ data: [] }` for them (verified live 2026-07-18), which
  // an ordinary failover would present as an authoritative "no results".
  // suiRpcIndexed THROWS SuiIndexUnavailableError instead, so the caller can
  // say "I don't know" rather than "nothing found". FromAddress (indexed=false)
  // is a standard index served correctly by both endpoints — failover stays.
  const call = indexed
    ? (c: string | null) => suiRpcIndexed('suix_queryTransactionBlocks', [{ filter }, c, 50, true])
    : (c: string | null) => suiRpc('suix_queryTransactionBlocks', [{ filter }, c, 50, true]);

  do {
    let result = await call(cursor) as { data: Array<{ digest: string }>; nextCursor?: string; hasNextPage?: boolean } | null;

    if (!result) {
      // One retry before failing loud — a single transient page failure
      // shouldn't tank the whole scan, but a genuinely-unavailable page must
      // NOT silently truncate.
      result = await call(cursor) as typeof result;
    }
    if (!result) {
      throw new Error(`cetus/activity: queryTransactionBlocks page failed (filter=${JSON.stringify(filter)}) — refusing to return a partial scan`);
    }
    digests.push(...result.data.map((t) => t.digest));
    cursor = result.hasNextPage ? (result.nextCursor ?? null) : null;
  } while (cursor);

  return digests;
}

// Discover the transaction digests relevant to a scan.
//
//  - Wallet scope: every tx SENT BY the account (fee/reward events across all
//    the wallet's positions).
//  - Per-position: additionally UNION every tx that CHANGED the position object
//    itself (`ChangedObject: positionId`). Sprint SPOT-RESILIENCE-V2 (Bug B):
//    the `FromAddress`-only scan misses a position opened via a router/aggregator
//    or received by transfer (its AddLiquidity tx isn't signed by the account) →
//    a false `no_deposits`. The object-scoped query finds that deposit tx
//    regardless of who signed it. De-duplicated across both sources.
async function fetchScanDigests(account: string, positionId: string | null): Promise<string[]> {
  const fromDigests = await fetchDigestsByFilter({ FromAddress: account });
  if (!positionId || positionId === 'all') return fromDigests;

  // Per-position: also pull txs that touched this exact position object. If the
  // object query fails transiently we DON'T fail the whole request — the
  // FromAddress scan is still the primary source; the object query is an
  // additive safety net for router-opened / received positions.
  let objDigests: string[] = [];
  try {
    objDigests = await fetchDigestsByFilter({ ChangedObject: positionId }, true);
  } catch (err) {
    // SuiIndexUnavailableError = the indexed primary couldn't answer — the
    // safety net is OFF for this request ("I don't know"), never "no results".
    const tag = err instanceof SuiIndexUnavailableError ? 'index-unavailable' : 'failed';
    console.warn(`[cetus/activity] ChangedObject discovery ${tag} (non-fatal, FromAddress scan still authoritative for self-signed txs):`, String(err));
  }
  return [...new Set([...fromDigests, ...objDigests])];
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
    const allDigests = await fetchScanDigests(account, positionId);

    if (allDigests.length === 0) {
      return NextResponse.json({
        events: [], netInvested0: 0, netInvested1: 0, totalFees0: 0, totalFees1: 0,
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

    const allTxBlocks = await fetchTransactionEvents(allDigests);

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
      poolId?: string;        // fee_claim only — for per-event pool-context resolution
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
          rawEvents.push({ type: 'deposit', txHash: tx.digest, timestamp: ts, amount0Raw: a0, amount1Raw: a1 });

        } else if (evName === 'RemoveLiquidityV2Event' || evName === 'RemoveLiquidityEvent') {
          const a0 = BigInt((pj.amount_a as string) ?? '0');
          const a1 = BigInt((pj.amount_b as string) ?? '0');
          withdrawn0 += a0; withdrawn1 += a1;
          rawEvents.push({ type: 'withdrawal', txHash: tx.digest, timestamp: ts, amount0Raw: a0, amount1Raw: a1 });

        } else if (evName === 'CollectFeeEvent') {
          const a0 = BigInt((pj.amount_a as string) ?? '0');
          const a1 = BigInt((pj.amount_b as string) ?? '0');
          fees0 += a0; fees1 += a1;
          rawEvents.push({ type: 'fee_claim', txHash: tx.digest, timestamp: ts, amount0Raw: a0, amount1Raw: a1, poolId: (pj.pool as string) ?? undefined });

        } else if (evName === 'CollectRewardV2Event') {
          const rewardAmt = BigInt((pj.amount as string) ?? '0');
          const rewardSymbol = extractRewardSymbol(pj.rewarder_type) || 'REWARD';
          const rewardDecimals = REWARD_DECIMALS_BY_SYMBOL[rewardSymbol.toUpperCase()] ?? 9;
          rawEvents.push({
            type: 'reward_claim',
            txHash: tx.digest,
            timestamp: ts,
            amount0Raw: rewardAmt,
            amount1Raw: 0n,
            rewardSymbol,
            rewardDecimals,
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

    // Historical SUI pricing for fee_claim / reward_claim — see Bluefin
    // activity route for full rationale. Prewarms the per-date cache for every
    // claim whose (per-event) pool has a SUI side, plus every SUI reward.
    const suiCanonical = '0x2::sui::sui';
    {
      const histTimestamps: number[] = [];
      for (const e of rawEvents) {
        if (e.type === 'fee_claim') {
          const c = feeCtxFor(e);
          if (c && (c.coinTypeA.toLowerCase() === suiCanonical || c.coinTypeB.toLowerCase() === suiCanonical)) {
            histTimestamps.push(e.timestamp);
          }
        } else if (e.type === 'reward_claim') {
          const sym = (e.rewardSymbol ?? '').trim().toUpperCase();
          if (sym === 'SUI') histTimestamps.push(e.timestamp);
        }
      }
      if (histTimestamps.length > 0) {
        await prewarmSuiPricesForTimestamps(histTimestamps);
      }
    }

    // FIX A: prewarm CURRENT cg-spot for any SUI / CETUS token that appears as
    // a reward symbol or as a pool side, so the synchronous per-event loop can
    // resolve them. Uses the 60s-cached simple/price helper (NOT the historical
    // CG queue), so it adds at most one cheap request per page load.
    const __cgIdsNeeded = new Set<string>();
    for (const e of rawEvents) {
      if (e.type === 'reward_claim') {
        const cg = CG_ID_BY_SYMBOL[(e.rewardSymbol ?? '').trim().toUpperCase()];
        if (cg) __cgIdsNeeded.add(cg);
      }
    }
    {
      const cgA = CG_ID_BY_COINTYPE[coinTypeA.toLowerCase()];
      const cgB = CG_ID_BY_COINTYPE[coinTypeB.toLowerCase()];
      if (cgA) __cgIdsNeeded.add(cgA);
      if (cgB) __cgIdsNeeded.add(cgB);
    }
    const spotByCgId: Record<string, number> = __cgIdsNeeded.size > 0
      ? await fetchSpotPrices([...__cgIdsNeeded])
      : {};

    // Sprint 1.15: prewarm DeFiLlama claim-date historical for EVERY non-stable
    // fee-claim pool side — INCLUDING canonical SUI. Cetus fee claims are now
    // valued historical-only (Rule 1a): the SUI side uses CoinGecko historical
    // first and DeFiLlama as its historical fallback (so a cold/missed CG-history
    // no longer drops the SUI side to current spot), and any non-SUI side uses
    // DeFiLlama. Stablecoin sides anchor at $1 and need no fetch. (Sprint 1.12
    // excluded SUI here because the spot fallback covered it; that fallback is
    // now removed.) The CETUS reward token's spot+LKG path is a separate,
    // designated Rule 1 exception and is untouched — rewards are not prewarmed
    // or priced via DeFiLlama.
    {
      const __eligible = (ct: string) => !!ct && !STABLECOINS.has(ct.toLowerCase());
      const __dlByCoin = new Map<string, Set<number>>();
      const __addDl = (ct: string, ts: number) => {
        if (!__eligible(ct)) return;
        const set = __dlByCoin.get(ct) ?? __dlByCoin.set(ct, new Set()).get(ct)!;
        set.add(ts);
      };
      for (const e of rawEvents) {
        if (e.type !== 'fee_claim') continue;
        const c = feeCtxFor(e);
        if (!c) continue;
        __addDl(c.coinTypeA, e.timestamp);
        __addDl(c.coinTypeB, e.timestamp);
      }
      if (__dlByCoin.size > 0) {
        await prewarmDefillamaPrices(
          [...__dlByCoin].map(([contract, ts]) => ({ chain: 'sui' as const, contract, timestamps: [...ts] })),
        );
      }
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
      // Sprint 1.15: which historical source priced a fee claim (for the
      // read-only [PRICE_LOG] re-derivation below). NEVER 'cg-spot' — fee claims
      // are historical-only (Rule 1a).
      let __feeClaimSrc = 'unknown';

      if ((ev.type === 'deposit' || ev.type === 'withdrawal') && hasTicks) {
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

      // Reward claim pricing — same rules as Bluefin's UserRewardCollected:
      //   (1) reward symbol is a known stablecoin → $1
      //   (2) reward symbol is SUI → historical SUI price at claim date
      //       (falls back to current side-price if the historical fetch
      //       failed)
      //   (3) reward symbol matches the trailing segment of coinTypeA → priceA
      //   (4) reward symbol matches the trailing segment of coinTypeB → priceB
      //   (5) otherwise null (uncounted — better than wrong)
      if (ev.type === 'reward_claim') {
        const sym = (ev.rewardSymbol ?? '').trim();
        const symUp = sym.toUpperCase();
        const symA = coinTypeA.split('::').pop()?.toUpperCase() ?? '';
        const symB = coinTypeB.split('::').pop()?.toUpperCase() ?? '';
        let pxReward: number | null = null;
        if (STABLE_SYMBOLS.has(sym) || STABLE_SYMBOLS.has(symUp)) {
          pxReward = 1;
        } else if (symUp === 'SUI') {
          const hist = getCachedSuiPriceForTimestamp(ev.timestamp);
          if (hist != null) pxReward = hist;
          else if (symUp === symA && fallbackA > 0) pxReward = fallbackA;
          else if (symUp === symB && fallbackB > 0) pxReward = fallbackB;
        } else if (symUp && symUp === symA && fallbackA > 0) {
          pxReward = fallbackA;
        } else if (symUp && symUp === symB && fallbackB > 0) {
          pxReward = fallbackB;
        }
        // FIX A: a non-stable / non-pool-side reward (CETUS, plus SUI as a net)
        // → current cg-spot via the CG-id map. cg-spot is used (not claim-time
        // historical) because on CoinGecko's free tier the per-IP budget is
        // shared across simple/price AND coins/history; one cheap simple/price
        // call prices EVERY CETUS claim, whereas per-day history (16+ calls +
        // 429 retries) saturates the shared budget and starves the spot path
        // for both CETUS and SUI. The process-wide last-known-good cache
        // (fetchSpotPrices) makes the value deterministic once fetched.
        if (pxReward == null) {
          const cg = CG_ID_BY_SYMBOL[symUp];
          if (cg && (spotByCgId[cg] ?? 0) > 0) pxReward = spotByCgId[cg];
        }
        if (pxReward != null) {
          price0AtTime = pxReward;
          price1AtTime = null;
          usdAtTime = amount0 * pxReward;
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
            __feeClaimSrc = __usedDl ? 'defillama-historical' : __usedSuiHist ? 'sui-historical' : 'stablecoin-fixed';
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
          const __histSui = getHistoricalOnlySuiPrice(ev.timestamp);
          let __src: string;
          if (ev.type === 'reward_claim') {
            const __sym = (ev.rewardSymbol ?? '').trim();
            const __symUp = __sym.toUpperCase();
            if (STABLE_SYMBOLS.has(__sym) || STABLE_SYMBOLS.has(__symUp)) __src = 'stablecoin-fixed';
            else if (__symUp === 'SUI' && __histSui != null) __src = 'sui-historical';
            else if (usdAtTime != null && usdAtTime > 0) __src = 'cg-spot';
            else __src = 'unknown';
          } else {
            // Sprint 1.15: fee-claim source is whatever the historical cascade
            // recorded — sui-historical / defillama-historical / stablecoin-fixed
            // / unknown. NEVER cg-spot (Rule 1a: fee claims are historical-only).
            __src = __feeClaimSrc;
          }
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
        cumulativeFeeUSD,
        ...(ev.rewardSymbol ? { rewardSymbol: ev.rewardSymbol } : {}),
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
    } as ActivityResponse);
  } catch (err) {
    console.error('[cetus/activity] Unexpected error:', err);
    return NextResponse.json(
      { error: 'Failed to fetch Cetus activity', details: String(err) },
      { status: 500 },
    );
  }
}
