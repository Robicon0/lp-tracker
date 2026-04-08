import { NextResponse } from 'next/server';

// Public HyperEVM RPC: used only for eth_getBlockByNumber (timestamps) — limits to 1000 blocks for eth_getLogs
const HYPEREVM_RPC = 'https://rpc.hyperliquid.xyz/evm';
// DRPC: used for eth_getLogs — supports 10k-block ranges on free tier
const DRPC_URL = 'https://hyperliquid.drpc.org';
// How many blocks to scan back from current block for activity history (~2.5 months at ~1.1s/block)
const SCAN_DEPTH = 5_000_000;
// DRPC's max block range per eth_getLogs request
const LOG_CHUNK = 10_000;
// Max concurrent eth_getLogs requests (avoid rate-limiting)
const LOG_CONCURRENCY = 20;

// Standard Uni V3 event topic0 hashes — same for all V3 forks
// IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
const TOPIC_INCREASE = '0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f';
// DecreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
const TOPIC_DECREASE = '0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4';
// Collect(uint256 indexed tokenId, address recipient, uint256 amount0Collected, uint256 amount1Collected)
const TOPIC_COLLECT = '0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01';

// CoinGecko IDs for known HyperEVM tokens
const CG_IDS: Record<string, string> = {
  '0x5555555555555555555555555555555555555555': 'hyperliquid', // native HYPE
  '0xadcb2f358eae6492f61a5f87eb8893d09391d160': 'hyperliquid', // WHYPE
  '0xb88339cb7199b77e23db6e890353e22632ba630f': 'usd-coin',    // USDC
  '0x24ac48bf01fd6cb1c3836d08b3edc70a9c4380ca': 'usd-coin',    // USDC (alternate)
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
  // Per-event historical prices (null when no CoinGecko mapping for the token).
  price0AtTime: number | null;
  price1AtTime: number | null;
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

async function rpcCallHyperEVM(body: object): Promise<{ result?: unknown; error?: { message: string } }> {
  const res = await fetch(HYPEREVM_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function rpcCallDRPC(body: object): Promise<{ result?: unknown; error?: { message: string } }> {
  const res = await fetch(DRPC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'lp-tracker/1.0',
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

// Fetch one 10k-block chunk of logs via DRPC.
// topic[0]=null (any V3 event), topic[1]=tokenIdHex (indexed)
async function fetchLogsChunk(nftManager: string, tokenIdHex: string, from: number, to: number): Promise<RawLog[]> {
  const result = await rpcCallDRPC({
    jsonrpc: '2.0',
    method: 'eth_getLogs',
    params: [{
      address: nftManager,
      topics: [null, tokenIdHex],
      fromBlock: '0x' + from.toString(16),
      toBlock: '0x' + to.toString(16),
    }],
    id: 1,
  });
  if (result.error) {
    console.error(`[hyperswap/activity] DRPC getLogs error ${from}-${to}:`, result.error.message);
    return [];
  }
  return (result.result as RawLog[]) ?? [];
}

// Scan the last SCAN_DEPTH blocks in parallel LOG_CONCURRENCY chunks at a time.
// HyperEVM public RPC caps at 1000 blocks for eth_getLogs; DRPC allows 10k per request.
async function fetchLogs(nftManager: string, tokenIdHex: string): Promise<RawLog[]> {
  // Get current block from the reliable public RPC
  const blockRes = await rpcCallHyperEVM({ jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 });
  const latestBlock = parseInt((blockRes.result as string) ?? '0x0', 16);
  if (!latestBlock) {
    console.error('[hyperswap/activity] Failed to get latest block number');
    return [];
  }

  const fromBlock = Math.max(0, latestBlock - SCAN_DEPTH);
  const ranges: [number, number][] = [];
  for (let b = fromBlock; b <= latestBlock; b += LOG_CHUNK) {
    ranges.push([b, Math.min(b + LOG_CHUNK - 1, latestBlock)]);
  }
  console.log(`[hyperswap/activity] Scanning ${ranges.length} chunks (blocks ${fromBlock}–${latestBlock})`);

  // Fetch in parallel batches
  const allLogs: RawLog[] = [];
  for (let i = 0; i < ranges.length; i += LOG_CONCURRENCY) {
    const batch = ranges.slice(i, i + LOG_CONCURRENCY);
    const results = await Promise.all(
      batch.map(([f, t]) => fetchLogsChunk(nftManager, tokenIdHex, f, t))
    );
    allLogs.push(...results.flat());
  }

  console.log(`[hyperswap/activity] Found ${allLogs.length} logs for tokenId ${tokenIdHex}`);
  return allLogs;
}

async function fetchTimestamps(blockNumbers: number[]): Promise<Record<number, number>> {
  const unique = [...new Set(blockNumbers)];
  const results = await Promise.all(
    unique.map(async (bn) => {
      const res = await rpcCallHyperEVM({
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
      console.error(`[hyperswap/activity] CoinGecko history ${cgId} ${dateStr} HTTP ${res.status}`);
      return null;
    }
    const json = await res.json();
    return json?.market_data?.current_price?.usd ?? null;
  } catch (err) {
    console.error(`[hyperswap/activity] CoinGecko history ${cgId} ${dateStr} error:`, err);
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
  const olderDates = dates.slice(0, dates.length - MAX_DATES);

  const result: Record<string, { p0: number; p1: number }> = {};

  for (const d of olderDates) {
    result[d] = { p0: fallback0, p1: fallback1 };
  }

  await Promise.all(
    recentDates.map(async (dateStr) => {
      const [p0, p1] = await Promise.all([
        cgId0 ? fetchCGHistoricalPrice(cgId0, dateStr) : Promise.resolve(null),
        cgId1 ? fetchCGHistoricalPrice(cgId1, dateStr) : Promise.resolve(null),
      ]);
      result[dateStr] = {
        p0: p0 ?? fallback0,
        p1: p1 ?? fallback1,
      };
    })
  );

  return result;
}

function decodeWord(data: string, wordIndex: number): bigint {
  const start = wordIndex * 64;
  const word = data.slice(start, start + 64);
  if (!word || word.length < 64) return 0n;
  return BigInt('0x' + word);
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const positionId = searchParams.get('positionId');   // numeric NFT tokenId
  const nftManager = searchParams.get('nftManager');   // NFT manager contract address
  const t0d = parseInt(searchParams.get('t0d') ?? '18', 10);
  const t1d = parseInt(searchParams.get('t1d') ?? '18', 10);
  const token0 = (searchParams.get('token0') ?? '').toLowerCase();
  const token1 = (searchParams.get('token1') ?? '').toLowerCase();
  const fallback0 = parseFloat(searchParams.get('p0') ?? '0');
  const fallback1 = parseFloat(searchParams.get('p1') ?? '0');

  if (!positionId || !nftManager) {
    return NextResponse.json({ error: 'positionId and nftManager required' }, { status: 400 });
  }

  try {
    const tokenIdBig = BigInt(positionId);
    const tokenIdHex = '0x' + tokenIdBig.toString(16).padStart(64, '0');

    const logs = await fetchLogs(nftManager, tokenIdHex);

    if (logs.length === 0) {
      const empty: ActivityResponse = {
        events: [],
        netInvested0: 0,
        netInvested1: 0,
        totalFees0: 0,
        totalFees1: 0,
      };
      return NextResponse.json(empty);
    }

    const blockNumbers = logs.map(l => parseInt(l.blockNumber, 16));
    const timestamps = await fetchTimestamps(blockNumbers);

    const scale0 = BigInt(10) ** BigInt(t0d);
    const scale1 = BigInt(10) ** BigInt(t1d);

    const uniqueDatesSet = new Set<string>();
    for (const log of logs) {
      const bn = parseInt(log.blockNumber, 16);
      const ts = timestamps[bn] ?? 0;
      if (ts > 0) uniqueDatesSet.add(tsToDateStr(ts));
    }
    const uniqueDates = [...uniqueDatesSet].sort();

    const pricesByDate = token0 && token1
      ? await fetchHistoricalPrices(token0, token1, uniqueDates, fallback0, fallback1)
      : {};

    let deposited0 = 0n, deposited1 = 0n;
    let withdrawn0 = 0n, withdrawn1 = 0n;
    let fees0 = 0n, fees1 = 0n;

    interface RawEvent {
      type: ActivityEventType;
      txHash: string;
      blockNumber: number;
      timestamp: number;
      amount0Raw: bigint;
      amount1Raw: bigint;
    }

    // Map known topic0 hashes to event types
    const TOPIC_TYPE_MAP: Record<string, ActivityEventType> = {
      [TOPIC_INCREASE]: 'deposit',
      [TOPIC_DECREASE]: 'withdrawal',
      [TOPIC_COLLECT]: 'fee_claim',
    };

    const rawEvents: RawEvent[] = logs.flatMap((log) => {
      const topic0 = log.topics[0].toLowerCase();
      const blockNum = parseInt(log.blockNumber, 16);
      const timestamp = timestamps[blockNum] ?? 0;
      const data = log.data.startsWith('0x') ? log.data.slice(2) : log.data;

      const type = TOPIC_TYPE_MAP[topic0];
      if (!type) {
        console.error('[hyperswap/activity] Unknown topic0 (skipping):', topic0, 'at block', log.blockNumber);
        return [];
      }

      let amount0Raw = 0n, amount1Raw = 0n;

      if (type === 'deposit') {
        // IncreaseLiquidity data: word0=liquidity, word1=amount0, word2=amount1
        amount0Raw = decodeWord(data, 1);
        amount1Raw = decodeWord(data, 2);
        deposited0 += amount0Raw;
        deposited1 += amount1Raw;
      } else if (type === 'withdrawal') {
        // DecreaseLiquidity data: word0=liquidity, word1=amount0, word2=amount1
        amount0Raw = decodeWord(data, 1);
        amount1Raw = decodeWord(data, 2);
        withdrawn0 += amount0Raw;
        withdrawn1 += amount1Raw;
      } else {
        // Collect data: word0=recipient(address), word1=amount0Collected, word2=amount1Collected
        amount0Raw = decodeWord(data, 1);
        amount1Raw = decodeWord(data, 2);
        fees0 += amount0Raw;
        fees1 += amount1Raw;
      }

      return [{ type, txHash: log.transactionHash, blockNumber: blockNum, timestamp, amount0Raw, amount1Raw }];
    });

    rawEvents.sort((a, b) => a.blockNumber - b.blockNumber);

    const cgMapped0 = !!CG_IDS[token0];
    const cgMapped1 = !!CG_IDS[token1];

    let runningFeeUSD = 0;
    const events: ActivityEvent[] = rawEvents.map((ev) => {
      const amount0 = Number(ev.amount0Raw) / Number(scale0);
      const amount1 = Number(ev.amount1Raw) / Number(scale1);
      const dateStr = ev.timestamp > 0 ? tsToDateStr(ev.timestamp) : null;
      const histEntry = dateStr ? pricesByDate[dateStr] : undefined;
      const price0AtTime = cgMapped0 && histEntry ? histEntry.p0 : null;
      const price1AtTime = cgMapped1 && histEntry ? histEntry.p1 : null;
      const prices = dateStr ? (histEntry ?? { p0: fallback0, p1: fallback1 }) : null;
      const usdAtTime = prices ? amount0 * prices.p0 + amount1 * prices.p1 : null;

      let cumulativeFeeUSD = 0;
      if (ev.type === 'fee_claim') {
        const feeUSD = usdAtTime ?? (amount0 * fallback0 + amount1 * fallback1);
        runningFeeUSD += feeUSD;
        cumulativeFeeUSD = runningFeeUSD;
      }

      return {
        type: ev.type,
        txHash: ev.txHash,
        blockNumber: ev.blockNumber,
        timestamp: ev.timestamp,
        amount0,
        amount1,
        usdAtTime,
        price0AtTime,
        price1AtTime,
        cumulativeFeeUSD,
      };
    });

    events.reverse();

    const response: ActivityResponse = {
      events,
      netInvested0: Number(deposited0 - withdrawn0) / Number(scale0),
      netInvested1: Number(deposited1 - withdrawn1) / Number(scale1),
      totalFees0: Number(fees0) / Number(scale0),
      totalFees1: Number(fees1) / Number(scale1),
    };

    return NextResponse.json(response);
  } catch (err) {
    console.error('[hyperswap/activity] Unexpected error:', err);
    return NextResponse.json(
      { error: 'Failed to fetch activity', details: String(err) },
      { status: 500 }
    );
  }
}
