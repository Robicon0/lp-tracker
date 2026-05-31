import { NextResponse } from 'next/server';
import { deriveDepositPrices } from '../../../lib/v3PriceDerivation';

const SUI_RPC = process.env.SUI_RPC_URL || 'https://fullnode.mainnet.sui.io:443';

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

// Reward-token symbols that are USD-pegged stablecoins. Bluefin reward
// events carry only the token's symbol string, not a coin type, so we
// match on the symbol. Everything here is treated as $1/unit.
const STABLE_SYMBOLS = new Set([
  'USDC', 'USDT', 'DAI', 'USDe', 'sUSDe', 'USDY', 'wUSDC', 'USDHL',
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


// Fetch all wallet transaction digests, paginating through all pages
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

// Batch-fetch transaction blocks with events (25 at a time)
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

export async function GET(request: Request) {
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
    const allDigests = await fetchAllDigests(account);

    if (allDigests.length === 0) {
      return NextResponse.json({
        events: [], netInvested0: 0, netInvested1: 0, totalFees0: 0, totalFees1: 0,
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

    const allTxBlocks = await fetchTransactionEvents(allDigests);

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
          rawEvents.push({ type: 'deposit', txHash: tx.digest, timestamp: ts, amount0Raw: a0, amount1Raw: a1 });

        } else if (evName === 'LiquidityRemoved') {
          const a0 = BigInt((pj.coin_a_amount as string) ?? '0');
          const a1 = BigInt((pj.coin_b_amount as string) ?? '0');
          withdrawn0 += a0;
          withdrawn1 += a1;
          rawEvents.push({ type: 'withdrawal', txHash: tx.digest, timestamp: ts, amount0Raw: a0, amount1Raw: a1 });

        } else if (evName === 'UserFeeCollected') {
          const a0 = BigInt((pj.coin_a_amount as string) ?? '0');
          const a1 = BigInt((pj.coin_b_amount as string) ?? '0');
          fees0 += a0;
          fees1 += a1;
          rawEvents.push({ type: 'fee_claim', txHash: tx.digest, timestamp: ts, amount0Raw: a0, amount1Raw: a1 });

        } else if (evName === 'UserRewardCollected') {
          const rewardAmt = BigInt((pj.reward_amount as string) ?? '0');
          const rewardDec = typeof pj.reward_decimals === 'number' ? pj.reward_decimals : 9;
          const rewardSymbol = (pj.reward_symbol as string) ?? 'REWARD';
          rawEvents.push({
            type: 'reward_claim',
            txHash: tx.digest,
            timestamp: ts,
            amount0Raw: rewardAmt,
            amount1Raw: 0n,
            rewardSymbol,
            rewardDecimals: rewardDec,
          });
        }
      }
    }

    // Sort chronologically (oldest first) to compute cumulative fees correctly
    rawEvents.sort((a, b) => a.timestamp - b.timestamp);

    const hasTicks = tickLower != null && tickUpper != null;
    let runningFeeUSD = 0;
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

      // Reward claims need their own pricing path — the reward token is
      // often NOT the pool's token A, so applying fallbackA would give a
      // wildly wrong USD value. Rules:
      //   (1) known stablecoin reward symbol → $1
      //   (2) reward symbol matches the last path segment of coinTypeA
      //       or coinTypeB → use the matching fallback
      //   (3) otherwise leave usdAtTime null (uncounted, better than wrong)
      if (ev.type === 'reward_claim') {
        const sym = (ev.rewardSymbol ?? '').trim();
        const symUp = sym.toUpperCase();
        const symA = coinTypeA.split('::').pop()?.toUpperCase() ?? '';
        const symB = coinTypeB.split('::').pop()?.toUpperCase() ?? '';
        let pxReward: number | null = null;
        if (STABLE_SYMBOLS.has(sym) || STABLE_SYMBOLS.has(symUp)) pxReward = 1;
        else if (symUp && symUp === symA && fallbackA > 0) pxReward = fallbackA;
        else if (symUp && symUp === symB && fallbackB > 0) pxReward = fallbackB;
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
        // fee_claim / withdrawal / deposit where derivation was unavailable:
        // value at current pool-token prices.
        price0AtTime = fallbackA || null;
        price1AtTime = fallbackB || null;
        if (fallbackA > 0 || fallbackB > 0) {
          usdAtTime = amount0 * fallbackA + amount1 * fallbackB;
        }
      }

      let cumulativeFeeUSD = 0;
      if (ev.type === 'fee_claim' || ev.type === 'reward_claim') {
        runningFeeUSD += usdAtTime ?? 0;
        cumulativeFeeUSD = runningFeeUSD;
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

    // Reverse to newest-first for display
    events.reverse();

    return NextResponse.json({
      events,
      netInvested0: Number(deposited0 - withdrawn0) / Number(scaleA),
      netInvested1: Number(deposited1 - withdrawn1) / Number(scaleB),
      totalFees0: Number(fees0) / Number(scaleA),
      totalFees1: Number(fees1) / Number(scaleB),
    } as ActivityResponse);
  } catch (err) {
    console.error('[bluefin/activity] Unexpected error:', err);
    return NextResponse.json(
      { error: 'Failed to fetch Bluefin activity', details: String(err) },
      { status: 500 },
    );
  }
}
