import { NextResponse } from 'next/server';
import { deriveDepositPrices } from '../../../lib/v3PriceDerivation';
import { prewarmSuiPricesForTimestamps, getCachedSuiPriceForTimestamp } from '../../../lib/suiPriceHistory';
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

const SUI_RPC = process.env.SUI_RPC_URL || 'https://fullnode.mainnet.sui.io:443';

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

async function suiRpc(method: string, params: unknown[]) {
  const res = await fetch(SUI_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json();
  return json.result;
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

// CollectRewardV2Event carries rewarder_type as {name: "…::module::SYMBOL"}
// (NOT 0x-prefixed). Extract the trailing symbol for pricing + decimals lookup.
function extractRewardSymbol(rewarderType: unknown): string {
  if (!rewarderType || typeof rewarderType !== 'object') return '';
  const name = (rewarderType as Record<string, unknown>).name;
  if (typeof name !== 'string') return '';
  const parts = name.split('::');
  return parts[parts.length - 1] ?? '';
}

export async function GET(request: Request) {
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
    const allDigests = await fetchAllDigests(account);

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

        if (evName === 'AddLiquidityV2Event') {
          const a0 = BigInt((pj.amount_a as string) ?? '0');
          const a1 = BigInt((pj.amount_b as string) ?? '0');
          deposited0 += a0; deposited1 += a1;
          rawEvents.push({ type: 'deposit', txHash: tx.digest, timestamp: ts, amount0Raw: a0, amount1Raw: a1 });

        } else if (evName === 'RemoveLiquidityV2Event') {
          const a0 = BigInt((pj.amount_a as string) ?? '0');
          const a1 = BigInt((pj.amount_b as string) ?? '0');
          withdrawn0 += a0; withdrawn1 += a1;
          rawEvents.push({ type: 'withdrawal', txHash: tx.digest, timestamp: ts, amount0Raw: a0, amount1Raw: a1 });

        } else if (evName === 'CollectFeeEvent') {
          const a0 = BigInt((pj.amount_a as string) ?? '0');
          const a1 = BigInt((pj.amount_b as string) ?? '0');
          fees0 += a0; fees1 += a1;
          rawEvents.push({ type: 'fee_claim', txHash: tx.digest, timestamp: ts, amount0Raw: a0, amount1Raw: a1 });

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

    // Historical SUI pricing for fee_claim / reward_claim — see Bluefin
    // activity route for full rationale. Detects which side of the pool is
    // SUI (`0x2::sui::SUI`, case-insensitive) and prewarms the shared
    // per-date cache in parallel for every claim timestamp.
    const suiCanonical = '0x2::sui::sui';
    const suiSideIsA = coinTypeA.toLowerCase() === suiCanonical;
    const suiSideIsB = coinTypeB.toLowerCase() === suiCanonical;
    if (suiSideIsA || suiSideIsB) {
      const histTimestamps: number[] = [];
      for (const e of rawEvents) {
        if (e.type === 'fee_claim') {
          histTimestamps.push(e.timestamp);
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

      if (ev.type === 'reward_claim') {
        const scale = BigInt(10) ** BigInt(ev.rewardDecimals ?? 9);
        amount0 = Number(ev.amount0Raw) / Number(scale);
        amount1 = 0;
      } else {
        amount0 = Number(ev.amount0Raw) / Number(scaleA);
        amount1 = Number(ev.amount1Raw) / Number(scaleB);
      }

      let price0AtTime: number | null = null;
      let price1AtTime: number | null = null;
      let usdAtTime: number | null = null;

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
      } else if (usdAtTime == null) {
        // fee_claim / withdrawal / deposit where deriveDepositPrices was
        // unavailable. For fee_claim: substitute historical SUI price on
        // the SUI side when the cache has it (prewarmed above); the other
        // side stays at current fallback (USDC is $1; other non-SUI tokens
        // get their current price as a last-resort approximation).
        let pxA = fallbackA;
        let pxB = fallbackB;
        if (ev.type === 'fee_claim') {
          if (suiSideIsA) {
            const hist = getCachedSuiPriceForTimestamp(ev.timestamp);
            if (hist != null) pxA = hist;
          } else if (suiSideIsB) {
            const hist = getCachedSuiPriceForTimestamp(ev.timestamp);
            if (hist != null) pxB = hist;
          }
          // FIX A: a SUI / CETUS fee side still unpriced (e.g. CETUS/USDC pool,
          // or SUI when both historical and its spot fallback returned null) →
          // current cg-spot via the CG-id map.
          if (pxA === 0) { const cg = CG_ID_BY_COINTYPE[coinTypeA.toLowerCase()]; if (cg && (spotByCgId[cg] ?? 0) > 0) pxA = spotByCgId[cg]; }
          if (pxB === 0) { const cg = CG_ID_BY_COINTYPE[coinTypeB.toLowerCase()]; if (cg && (spotByCgId[cg] ?? 0) > 0) pxB = spotByCgId[cg]; }
        }
        price0AtTime = pxA || null;
        price1AtTime = pxB || null;
        if (pxA > 0 || pxB > 0) {
          usdAtTime = amount0 * pxA + amount1 * pxB;
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
          const __histSui = getCachedSuiPriceForTimestamp(ev.timestamp);
          let __src: string;
          if (ev.type === 'reward_claim') {
            const __sym = (ev.rewardSymbol ?? '').trim();
            const __symUp = __sym.toUpperCase();
            if (STABLE_SYMBOLS.has(__sym) || STABLE_SYMBOLS.has(__symUp)) __src = 'stablecoin-fixed';
            else if (__symUp === 'SUI' && __histSui != null) __src = 'sui-historical';
            else if (usdAtTime != null && usdAtTime > 0) __src = 'cg-spot';
            else __src = 'unknown';
          } else {
            if ((suiSideIsA || suiSideIsB) && __histSui != null && usdAtTime != null && usdAtTime > 0) __src = 'sui-historical';
            else if (usdAtTime != null && usdAtTime > 0) __src = 'cg-spot';
            else __src = 'unknown';
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
