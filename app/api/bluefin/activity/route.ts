import { NextResponse } from 'next/server';

const SUI_RPC = process.env.SUI_RPC_URL || 'https://fullnode.mainnet.sui.io:443';

const BLUEFIN_PKG = '0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267';

// CoinGecko IDs keyed by normalized Sui coin type
const CG_IDS: Record<string, string> = {
  '0x2::sui::SUI': 'sui',
  '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC': 'usd-coin',
  '0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN': 'tether',
  '0xaf8cd5edc19c4512f4259f0bee101a40d41ebed738ade5874359610ef8eeced5::coin::COIN': 'ethereum',
  '0x027792d9fed7f9844eb4839566001bb6f6cb4804f66aa2da6fe1ee242d896881::coin::COIN': 'bitcoin',
  '0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN': 'usd-coin',
};

export type ActivityEventType = 'deposit' | 'withdrawal' | 'fee_claim' | 'reward_claim';

export interface ActivityEvent {
  type: ActivityEventType;
  txHash: string;           // Sui transaction digest
  timestamp: number;        // unix seconds
  amount0: number;          // coin_a_amount (human-readable)
  amount1: number;          // coin_b_amount
  usdAtTime: number | null; // null if historical price fetch failed
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

function tsToDateStr(ts: number): string {
  const d = new Date(ts * 1000);
  const day = d.getUTCDate().toString().padStart(2, '0');
  const month = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const year = d.getUTCFullYear();
  return `${day}-${month}-${year}`;
}

async function fetchCGHistoricalPrice(cgId: string, dateStr: string): Promise<number | null> {
  try {
    const url = `https://api.coingecko.com/api/v3/coins/${cgId}/history?date=${dateStr}&localization=false`;
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) {
      console.error(`[bluefin/activity] CoinGecko history ${cgId} ${dateStr} HTTP ${res.status}`);
      return null;
    }
    const json = await res.json();
    return json?.market_data?.current_price?.usd ?? null;
  } catch (err) {
    console.error(`[bluefin/activity] CoinGecko history ${cgId} ${dateStr} error:`, err);
    return null;
  }
}

async function fetchHistoricalPrices(
  coinTypeA: string,
  coinTypeB: string,
  dates: string[],
  fallbackA: number,
  fallbackB: number,
): Promise<Record<string, { p0: number; p1: number }>> {
  const cgIdA = CG_IDS[coinTypeA] ?? null;
  const cgIdB = CG_IDS[coinTypeB] ?? null;

  const MAX_DATES = 30;
  const recentDates = dates.slice(-MAX_DATES);
  const olderDates = dates.slice(0, dates.length - MAX_DATES);

  const result: Record<string, { p0: number; p1: number }> = {};

  for (const d of olderDates) {
    result[d] = { p0: fallbackA, p1: fallbackB };
  }

  await Promise.all(
    recentDates.map(async (dateStr) => {
      const [p0, p1] = await Promise.all([
        cgIdA ? fetchCGHistoricalPrice(cgIdA, dateStr) : Promise.resolve(null),
        cgIdB ? fetchCGHistoricalPrice(cgIdB, dateStr) : Promise.resolve(null),
      ]);
      result[dateStr] = { p0: p0 ?? fallbackA, p1: p1 ?? fallbackB };
    }),
  );

  return result;
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

  if (!positionId || !account) {
    return NextResponse.json({ error: 'positionId and account required' }, { status: 400 });
  }

  try {
    const allDigests = await fetchAllDigests(account);

    if (allDigests.length === 0) {
      return NextResponse.json({
        events: [], netInvested0: 0, netInvested1: 0, totalFees0: 0, totalFees1: 0,
      } as ActivityResponse);
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
        if (!ev.type.startsWith(BLUEFIN_PKG)) continue;
        const pj = ev.parsedJson ?? {};
        const evPosId = (pj.position_id as string) ?? '';
        if (evPosId !== positionId) continue;

        const evName = ev.type.split('::').pop() ?? '';

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

    // Collect unique dates for historical price lookups
    const uniqueDatesSet = new Set<string>();
    for (const ev of rawEvents) {
      if (ev.timestamp > 0) uniqueDatesSet.add(tsToDateStr(ev.timestamp));
    }
    const uniqueDates = [...uniqueDatesSet].sort();

    const pricesByDate = coinTypeA && coinTypeB
      ? await fetchHistoricalPrices(coinTypeA, coinTypeB, uniqueDates, fallbackA, fallbackB)
      : {};

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

      const dateStr = ev.timestamp > 0 ? tsToDateStr(ev.timestamp) : null;
      const prices = dateStr ? (pricesByDate[dateStr] ?? { p0: fallbackA, p1: fallbackB }) : null;
      const usdAtTime = prices ? amount0 * prices.p0 + amount1 * prices.p1 : null;

      let cumulativeFeeUSD = 0;
      if (ev.type === 'fee_claim' || ev.type === 'reward_claim') {
        const feeUSD = usdAtTime != null ? usdAtTime : amount0 * fallbackA + amount1 * fallbackB;
        runningFeeUSD += feeUSD;
        cumulativeFeeUSD = runningFeeUSD;
      }

      return {
        type: ev.type,
        txHash: ev.txHash,
        timestamp: ev.timestamp,
        amount0,
        amount1,
        usdAtTime,
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
