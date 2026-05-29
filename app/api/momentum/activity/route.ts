import { NextResponse } from 'next/server';
import { deriveDepositPrices } from '../../../lib/v3PriceDerivation';

// Momentum (MMT) CLMM activity route — modeled on app/api/bluefin/activity.
// Event names + fields are VERIFIED against live on-chain events:
//   liquidity::AddLiquidityEvent     → deposit      (amount_x, amount_y, position_id)
//   liquidity::RemoveLiquidityEvent  → withdrawal   (amount_x, amount_y, position_id)
//   collect::FeeCollectedEvent       → fee_claim    (amount_x, amount_y, position_id)
//   collect::CollectPoolRewardEvent  → reward_claim (amount, reward_coin_type, position_id)
// NOTE the names differ from the Cetus route (Add/Remove vs the docs'
// Increase/Decrease, FeeCollectedEvent vs CollectFeeEvent, amount_x/_y vs
// amount_a/_b, position_id vs position).

const SUI_RPC = process.env.SUI_RPC_URL || 'https://fullnode.mainnet.sui.io:443';

const MOMENTUM_PKG = '0x70285592c97965e811e0c6f98dccc3a9c2b4ad854b3594faab9597ada267b860';

const STABLECOINS = new Set([
  '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::usdc',
  '0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::coin', // USDT
  '0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::coin', // wUSDC
]);

// Reward-token symbols that are USD-pegged stablecoins (matched on symbol).
const STABLE_SYMBOLS = new Set(['USDC', 'USDT', 'DAI', 'USDe', 'sUSDe', 'USDY', 'wUSDC', 'USDHL']);

// Decimals for reward coin types not covered by the pool's tokens — mirrors
// the KNOWN_COINS map in app/api/momentum/route.ts. Only used to scale
// reward_claim amounts; default 9 when unknown.
const REWARD_DECIMALS: Record<string, number> = {
  '0x2::sui::SUI': 9,
  '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::usdc': 6,
  '0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::coin': 6,
  '0x06864a6f921804860930db6ddbe2e16acdf8504495ea7481637a1c8b9a8fe54b::cetus::cetus': 9,
};

export type ActivityEventType = 'deposit' | 'withdrawal' | 'fee_claim' | 'reward_claim';

export interface ActivityEvent {
  type: ActivityEventType;
  txHash: string;
  timestamp: number;
  amount0: number;
  amount1: number;
  usdAtTime: number | null;
  price0AtTime: number | null;
  price1AtTime: number | null;
  cumulativeFeeUSD: number;
  rewardSymbol?: string;
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

async function fetchAllDigests(account: string): Promise<string[]> {
  const digests: string[] = [];
  let cursor: string | null = null;
  do {
    const result = await suiRpc('suix_queryTransactionBlocks', [
      { filter: { FromAddress: account } },
      cursor,
      50,
      true,
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

// Momentum's reward_coin_type comes as { name: "0000…0002::sui::SUI" } (no 0x
// prefix). Normalize to a 0x-prefixed, lowercase type for symbol/decimals.
function normalizeRewardType(v: unknown): string {
  let t = '';
  if (v && typeof v === 'object' && 'name' in (v as Record<string, unknown>)) {
    t = String((v as Record<string, unknown>).name ?? '');
  } else if (typeof v === 'string') {
    t = v;
  }
  if (!t) return '';
  if (!t.startsWith('0x')) t = '0x' + t;
  return t.toLowerCase();
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
  const walletScope = positionId === 'all';

  try {
    const allDigests = await fetchAllDigests(account);
    if (allDigests.length === 0) {
      return NextResponse.json({ events: [], netInvested0: 0, netInvested1: 0, totalFees0: 0, totalFees1: 0 } as ActivityResponse);
    }

    const allTxBlocks = await fetchTransactionEvents(allDigests);
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
        if (!ev.type.startsWith(MOMENTUM_PKG)) continue;
        const pj = ev.parsedJson ?? {};
        const evPosId = (pj.position_id as string) ?? '';
        if (!walletScope && evPosId !== positionId) continue;

        const evName = ev.type.split('::').pop() ?? '';

        // Wallet-scope: only fee + reward events aggregate across positions.
        if (walletScope && evName !== 'FeeCollectedEvent' && evName !== 'CollectPoolRewardEvent') continue;

        if (evName === 'AddLiquidityEvent') {
          const a0 = BigInt((pj.amount_x as string) ?? '0');
          const a1 = BigInt((pj.amount_y as string) ?? '0');
          deposited0 += a0; deposited1 += a1;
          rawEvents.push({ type: 'deposit', txHash: tx.digest, timestamp: ts, amount0Raw: a0, amount1Raw: a1 });
        } else if (evName === 'RemoveLiquidityEvent') {
          const a0 = BigInt((pj.amount_x as string) ?? '0');
          const a1 = BigInt((pj.amount_y as string) ?? '0');
          withdrawn0 += a0; withdrawn1 += a1;
          rawEvents.push({ type: 'withdrawal', txHash: tx.digest, timestamp: ts, amount0Raw: a0, amount1Raw: a1 });
        } else if (evName === 'FeeCollectedEvent') {
          const a0 = BigInt((pj.amount_x as string) ?? '0');
          const a1 = BigInt((pj.amount_y as string) ?? '0');
          fees0 += a0; fees1 += a1;
          rawEvents.push({ type: 'fee_claim', txHash: tx.digest, timestamp: ts, amount0Raw: a0, amount1Raw: a1 });
        } else if (evName === 'CollectPoolRewardEvent') {
          const rewardType = normalizeRewardType(pj.reward_coin_type);
          const rewardSymbol = rewardType.split('::').pop()?.toUpperCase() ?? 'REWARD';
          const rewardDec = REWARD_DECIMALS[rewardType] ?? 9;
          rawEvents.push({
            type: 'reward_claim', txHash: tx.digest, timestamp: ts,
            amount0Raw: BigInt((pj.amount as string) ?? '0'), amount1Raw: 0n,
            rewardSymbol, rewardDecimals: rewardDec,
          });
        }
      }
    }

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

      if ((ev.type === 'deposit' || ev.type === 'withdrawal') && hasTicks && coinTypeA && coinTypeB) {
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

      // Reward pricing (same rules as Bluefin): stablecoin reward → $1;
      // reward symbol matching a pool token → that token's price; else null.
      if (ev.type === 'reward_claim') {
        const symUp = (ev.rewardSymbol ?? '').toUpperCase();
        const symA = coinTypeA.split('::').pop()?.toUpperCase() ?? '';
        const symB = coinTypeB.split('::').pop()?.toUpperCase() ?? '';
        let pxReward: number | null = null;
        if (STABLE_SYMBOLS.has(symUp)) pxReward = 1;
        else if (symUp && symUp === symA && fallbackA > 0) pxReward = fallbackA;
        else if (symUp && symUp === symB && fallbackB > 0) pxReward = fallbackB;
        if (pxReward != null) {
          price0AtTime = pxReward;
          usdAtTime = amount0 * pxReward;
        }
      } else if (usdAtTime == null) {
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
        type: ev.type, txHash: ev.txHash, timestamp: ev.timestamp, amount0, amount1,
        usdAtTime, price0AtTime, price1AtTime, cumulativeFeeUSD,
        ...(ev.rewardSymbol ? { rewardSymbol: ev.rewardSymbol } : {}),
      };
    });

    events.reverse();

    return NextResponse.json({
      events,
      netInvested0: Number(deposited0 - withdrawn0) / Number(scaleA),
      netInvested1: Number(deposited1 - withdrawn1) / Number(scaleB),
      totalFees0: Number(fees0) / Number(scaleA),
      totalFees1: Number(fees1) / Number(scaleB),
    } as ActivityResponse);
  } catch (err) {
    console.error('[momentum/activity] Unexpected error:', err);
    return NextResponse.json({ events: [], netInvested0: 0, netInvested1: 0, totalFees0: 0, totalFees1: 0 } as ActivityResponse);
  }
}
