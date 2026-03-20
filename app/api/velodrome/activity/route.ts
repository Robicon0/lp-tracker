import { NextResponse } from 'next/server';

const ALCHEMY_KEY = process.env.NEXT_PUBLIC_ALCHEMY_KEY;
// Alchemy Optimism — used only for eth_getBlockByNumber (timestamp lookups)
const ALCHEMY_RPC = `https://opt-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`;
// Blast Optimism public RPC — supports full-history eth_getLogs filtered by tokenId
const BLAST_RPC = 'https://optimism-mainnet.public.blastapi.io';

// Velodrome Slipstream (CL) NonfungiblePositionManager on Optimism
// keccak256 verified to emit the same event signatures as all standard V3 forks
const NFT_MANAGER = '0x416b433906b1B72FA758e166e239c43d68dC6F29';

// Start scanning from block ~3,000,000 — well before Velodrome CL launched on Optimism
const FROM_BLOCK = '0x2DC6C0';

// Standard V3 event topic0 hashes (identical across all V3-fork NFT managers)
const TOPIC_INCREASE = '0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f';
const TOPIC_DECREASE = '0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4';
const TOPIC_COLLECT  = '0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01';

// CoinGecko IDs for known Optimism tokens
const CG_IDS: Record<string, string> = {
  '0x4200000000000000000000000000000000000006': 'ethereum',          // WETH
  '0x0b2c639c533813f4aa9d7837caf62653d097ff85': 'usd-coin',         // USDC
  '0x7f5c764cbc14f9669b88837ca1490cca17c31607': 'usd-coin',         // USDC.e
  '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58': 'tether',           // USDT
  '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1': 'dai',              // DAI
  '0x68f180fcce6836688e9084f035309e29bf0a2095': 'bitcoin',          // WBTC
  '0x4200000000000000000000000000000000000042': 'optimism',         // OP
  '0x3c8b650257cfb5f272f799f5e2b4e65093a11a05': 'velodrome-finance',// VELO (old)
  '0x9560e827af36c94d2ac33a39bce1fe78631088db': 'velodrome-finance',// VELO (new)
  '0x1f32b1c2345538c0c6f582fcb022739c4a194ebb': 'wrapped-steth',   // wstETH
};

export type ActivityEventType = 'deposit' | 'withdrawal' | 'fee_claim';

export interface ActivityEvent {
  type: ActivityEventType;
  txHash: string;
  blockNumber: number;
  timestamp: number;
  amount0: number;
  amount1: number;
  usdAtTime: number | null;
  cumulativeFeeUSD: number;
}

interface ActivityResponse {
  events: ActivityEvent[];
  netInvested0: number;
  netInvested1: number;
  totalFees0: number;
  totalFees1: number;
}

interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
}

async function rpcPost(url: string, body: object): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function fetchLogs(tokenIdHex: string): Promise<RawLog[]> {
  const result = await rpcPost(BLAST_RPC, {
    jsonrpc: '2.0',
    method: 'eth_getLogs',
    params: [{
      address: NFT_MANAGER,
      topics: [
        [TOPIC_INCREASE, TOPIC_DECREASE, TOPIC_COLLECT],
        tokenIdHex,
      ],
      fromBlock: FROM_BLOCK,
      toBlock: 'latest',
    }],
    id: 1,
  }) as { result?: RawLog[]; error?: { message: string } };

  if (result.error) {
    console.error('[velodrome/activity] eth_getLogs error:', result.error);
    return [];
  }
  return result.result ?? [];
}

async function fetchTimestamps(blockNumbers: number[]): Promise<Record<number, number>> {
  const unique = [...new Set(blockNumbers)];
  const results = await Promise.all(
    unique.map(async (bn) => {
      const res = await rpcPost(ALCHEMY_RPC, {
        jsonrpc: '2.0',
        method: 'eth_getBlockByNumber',
        params: [`0x${bn.toString(16)}`, false],
        id: bn,
      }) as { result?: { timestamp: string } };
      const ts = res.result?.timestamp ? parseInt(res.result.timestamp, 16) : 0;
      return [bn, ts] as [number, number];
    })
  );
  return Object.fromEntries(results);
}

function tsToDateStr(ts: number): string {
  const d = new Date(ts * 1000);
  const day   = d.getUTCDate().toString().padStart(2, '0');
  const month = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const year  = d.getUTCFullYear();
  return `${day}-${month}-${year}`;
}

async function fetchCGHistoricalPrice(cgId: string, dateStr: string): Promise<number | null> {
  try {
    const url = `https://api.coingecko.com/api/v3/coins/${cgId}/history?date=${dateStr}&localization=false`;
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) {
      console.error(`[velodrome/activity] CoinGecko history ${cgId} ${dateStr} HTTP ${res.status}`);
      return null;
    }
    const json = await res.json();
    return json?.market_data?.current_price?.usd ?? null;
  } catch (err) {
    console.error(`[velodrome/activity] CoinGecko history ${cgId} ${dateStr} error:`, err);
    return null;
  }
}

async function fetchHistoricalPrices(
  token0: string,
  token1: string,
  dates: string[],
  fallback0: number,
  fallback1: number,
): Promise<Record<string, { p0: number; p1: number }>> {
  const cgId0 = CG_IDS[token0.toLowerCase()] ?? null;
  const cgId1 = CG_IDS[token1.toLowerCase()] ?? null;

  const MAX_DATES = 30;
  const recentDates = dates.slice(-MAX_DATES);
  const olderDates  = dates.slice(0, dates.length - MAX_DATES);

  const result: Record<string, { p0: number; p1: number }> = {};
  for (const d of olderDates) result[d] = { p0: fallback0, p1: fallback1 };

  await Promise.all(
    recentDates.map(async (dateStr) => {
      const [p0, p1] = await Promise.all([
        cgId0 ? fetchCGHistoricalPrice(cgId0, dateStr) : Promise.resolve(null),
        cgId1 ? fetchCGHistoricalPrice(cgId1, dateStr) : Promise.resolve(null),
      ]);
      result[dateStr] = { p0: p0 ?? fallback0, p1: p1 ?? fallback1 };
    })
  );
  return result;
}

function decodeWord(data: string, wordIndex: number): bigint {
  const start = wordIndex * 64;
  const word  = data.slice(start, start + 64);
  if (!word || word.length < 64) return 0n;
  return BigInt('0x' + word);
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const positionId = searchParams.get('positionId');   // numeric NFT tokenId string
  const t0d        = parseInt(searchParams.get('t0d') ?? '18', 10);
  const t1d        = parseInt(searchParams.get('t1d') ?? '18', 10);
  const token0     = (searchParams.get('token0') ?? '').toLowerCase();
  const token1     = (searchParams.get('token1') ?? '').toLowerCase();
  const fallback0  = parseFloat(searchParams.get('p0') ?? '0');
  const fallback1  = parseFloat(searchParams.get('p1') ?? '0');

  if (!positionId) {
    return NextResponse.json({ error: 'positionId required' }, { status: 400 });
  }
  if (!ALCHEMY_KEY) {
    return NextResponse.json({ error: 'Alchemy key not configured' }, { status: 500 });
  }

  try {
    const tokenIdHex = '0x' + BigInt(positionId).toString(16).padStart(64, '0');
    const logs = await fetchLogs(tokenIdHex);

    if (logs.length === 0) {
      const empty: ActivityResponse = { events: [], netInvested0: 0, netInvested1: 0, totalFees0: 0, totalFees1: 0 };
      return NextResponse.json(empty);
    }

    const blockNumbers = logs.map(l => parseInt(l.blockNumber, 16));
    const timestamps   = await fetchTimestamps(blockNumbers);

    const scale0 = BigInt(10) ** BigInt(t0d);
    const scale1 = BigInt(10) ** BigInt(t1d);

    const uniqueDatesSet = new Set<string>();
    for (const log of logs) {
      const ts = timestamps[parseInt(log.blockNumber, 16)] ?? 0;
      if (ts > 0) uniqueDatesSet.add(tsToDateStr(ts));
    }
    const uniqueDates = [...uniqueDatesSet].sort();

    const pricesByDate = (token0 && token1)
      ? await fetchHistoricalPrices(token0, token1, uniqueDates, fallback0, fallback1)
      : {};

    let deposited0 = 0n, deposited1 = 0n;
    let withdrawn0 = 0n, withdrawn1 = 0n;
    let fees0 = 0n, fees1 = 0n;

    const TOPIC_MAP: Record<string, ActivityEventType> = {
      [TOPIC_INCREASE]: 'deposit',
      [TOPIC_DECREASE]: 'withdrawal',
      [TOPIC_COLLECT]:  'fee_claim',
    };

    interface RawEvent {
      type: ActivityEventType;
      txHash: string;
      blockNumber: number;
      timestamp: number;
      amount0Raw: bigint;
      amount1Raw: bigint;
    }

    const rawEvents: RawEvent[] = logs.flatMap((log) => {
      const topic0 = log.topics[0].toLowerCase();
      const type = TOPIC_MAP[topic0];
      if (!type) {
        console.error('[velodrome/activity] Unknown topic0 (skipping):', topic0);
        return [];
      }

      const blockNum  = parseInt(log.blockNumber, 16);
      const timestamp = timestamps[blockNum] ?? 0;
      const data      = log.data.startsWith('0x') ? log.data.slice(2) : log.data;

      const amount0Raw = decodeWord(data, 1);
      const amount1Raw = decodeWord(data, 2);

      if (type === 'deposit')    { deposited0 += amount0Raw; deposited1 += amount1Raw; }
      if (type === 'withdrawal') { withdrawn0 += amount0Raw; withdrawn1 += amount1Raw; }
      if (type === 'fee_claim')  { fees0 += amount0Raw;      fees1 += amount1Raw;      }

      return [{ type, txHash: log.transactionHash, blockNumber: blockNum, timestamp, amount0Raw, amount1Raw }];
    });

    rawEvents.sort((a, b) => a.blockNumber - b.blockNumber);

    let runningFeeUSD = 0;
    const events: ActivityEvent[] = rawEvents.map((ev) => {
      const amount0   = Number(ev.amount0Raw) / Number(scale0);
      const amount1   = Number(ev.amount1Raw) / Number(scale1);
      const dateStr   = ev.timestamp > 0 ? tsToDateStr(ev.timestamp) : null;
      const prices    = dateStr ? (pricesByDate[dateStr] ?? { p0: fallback0, p1: fallback1 }) : null;
      const usdAtTime = prices ? amount0 * prices.p0 + amount1 * prices.p1 : null;

      let cumulativeFeeUSD = 0;
      if (ev.type === 'fee_claim') {
        const feeUSD = usdAtTime ?? (amount0 * fallback0 + amount1 * fallback1);
        runningFeeUSD += feeUSD;
        cumulativeFeeUSD = runningFeeUSD;
      }

      return { type: ev.type, txHash: ev.txHash, blockNumber: ev.blockNumber, timestamp: ev.timestamp, amount0, amount1, usdAtTime, cumulativeFeeUSD };
    });

    events.reverse();

    return NextResponse.json({
      events,
      netInvested0: Number(deposited0 - withdrawn0) / Number(scale0),
      netInvested1: Number(deposited1 - withdrawn1) / Number(scale1),
      totalFees0:   Number(fees0) / Number(scale0),
      totalFees1:   Number(fees1) / Number(scale1),
    } satisfies ActivityResponse);
  } catch (err) {
    console.error('[velodrome/activity] Unexpected error:', err);
    return NextResponse.json({ error: 'Failed to fetch activity', details: String(err) }, { status: 500 });
  }
}
