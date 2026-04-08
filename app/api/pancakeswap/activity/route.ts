import { NextResponse } from 'next/server';

// PancakeSwap V3 is a Uniswap V3 fork on BNB Chain. Same event topic0 hashes,
// same ABI layout. Only the NFT manager address and the chain RPCs differ.

const ALCHEMY_KEY = process.env.NEXT_PUBLIC_ALCHEMY_KEY;
// Alchemy used only for eth_getBlockByNumber (timestamp lookups)
const ALCHEMY_RPC = `https://bnb-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`;
// publicnode — works reliably for BSC eth_getLogs (Tenderly has no public BSC gateway
// and LlamaRPC's BSC endpoint is frequently unreachable from both localhost and Vercel)
const PUBLIC_NODE_RPC = 'https://bsc-rpc.publicnode.com';
// LlamaRPC public BNB endpoint — secondary for eth_getLogs
const LLAMA_RPC = 'https://binance.llamarpc.com';

// PancakeSwap V3 NonfungiblePositionManager on BNB Chain (same address used by app/api/pancakeswap/route.ts)
const NFT_MANAGER = '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364';

// BSC free-tier public RPCs (publicnode, Alchemy free, LlamaRPC) all PRUNE
// archive history aggressively — publicnode keeps only ~50,000 blocks (≈42 hours
// at BSC's 3s block time) and returns `-32701 History has been pruned` for
// anything older. Etherscan V2 requires a paid plan for BSC access. With no
// free-tier path to archive logs, this route can only serve positions opened
// within the last ~40 hours; older positions will surface a clean error so the
// UI shows "Deposit data unavailable" and falls back to the existing
// tick-midpoint IL estimate. A future upgrade to a paid BSC archive RPC (or a
// BSCSCAN_API_KEY) can remove this limitation by increasing SCAN_DEPTH_BLOCKS.
const SCAN_DEPTH_BLOCKS = 48_000; // ~40 hours, fits inside publicnode's pruning window
const DEPLOY_BLOCK_FLOOR = 26_950_000;

const PUBNODE_CHUNK = 49_000;
const MAX_CONCURRENCY = 2;

// Standard Uni V3 event topic0 hashes — same for all V3 forks
const TOPIC_INCREASE = '0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f';
const TOPIC_DECREASE = '0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4';
const TOPIC_COLLECT  = '0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01';

// CoinGecko IDs for known BNB Chain tokens (kept in sync with app/api/pancakeswap/route.ts)
const CG_IDS: Record<string, string> = {
  '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c': 'binancecoin',       // WBNB
  '0x55d398326f99059ff775485246999027b3197955': 'tether',            // USDT
  '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': 'usd-coin',          // USDC
  '0xe9e7cea3dedca5984780bafc599bd69add087d56': 'binance-usd',       // BUSD
  '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82': 'pancakeswap-token', // CAKE
  '0x2170ed0880ac9a755fd29b2688956bd959f933f8': 'ethereum',          // ETH (Binance-Peg)
  '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c': 'bitcoin',           // BTCB
  '0x1af3f329e8be154074d8769d1ffa4ee058b1dbc3': 'dai',               // DAI
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

async function rpcPost(url: string, body: object): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function fetchLogsChunked(
  tokenIdHex: string,
  fromBlock: number,
  toBlock: number,
  rpcUrl: string,
  chunkSize: number,
): Promise<RawLog[]> {
  const chunks: Array<[number, number]> = [];
  for (let b = fromBlock; b <= toBlock; b += chunkSize) {
    chunks.push([b, Math.min(b + chunkSize - 1, toBlock)]);
  }
  console.log(`[pancakeswap/activity] chunked scan: ${chunks.length} chunks @ ${chunkSize} blocks, rpc=${rpcUrl}`);

  const allLogs: RawLog[] = [];
  for (let i = 0; i < chunks.length; i += MAX_CONCURRENCY) {
    const batch = chunks.slice(i, i + MAX_CONCURRENCY);
    let batchErrors = 0;
    const results = await Promise.all(
      batch.map(async ([from, to]) => {
        const res = await rpcPost(rpcUrl, {
          jsonrpc: '2.0',
          method: 'eth_getLogs',
          params: [{
            address: NFT_MANAGER,
            topics: [[TOPIC_INCREASE, TOPIC_DECREASE, TOPIC_COLLECT], tokenIdHex],
            fromBlock: '0x' + from.toString(16),
            toBlock:   '0x' + to.toString(16),
          }],
          id: from,
        }) as { result?: RawLog[]; error?: { message: string } };
        if (res.error) {
          batchErrors++;
          return [] as RawLog[];
        }
        return res.result ?? [];
      })
    );
    allLogs.push(...results.flat());
    if (i === 0 && batchErrors === batch.length) {
      throw new Error(`[pancakeswap/activity] chunked scan: first batch 100% error rate on ${rpcUrl}`);
    }
  }
  return allLogs;
}

async function fetchLogs(tokenIdHex: string): Promise<RawLog[]> {
  // Get current block to bound the scan window
  const bnRes = await rpcPost(ALCHEMY_RPC, {
    jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1,
  }) as { result?: string };
  const currentBlock = bnRes.result ? parseInt(bnRes.result, 16) : 50_000_000;
  const fromBlock = Math.max(DEPLOY_BLOCK_FLOOR, currentBlock - SCAN_DEPTH_BLOCKS);

  // publicnode chunked (49k chunks, below its 50k limit). BSC archive history is
  // pruned on all free RPCs, and this is the only reachable archive window.
  try {
    return await fetchLogsChunked(tokenIdHex, fromBlock, currentBlock, PUBLIC_NODE_RPC, PUBNODE_CHUNK);
  } catch (pubChunkErr) {
    console.warn('[pancakeswap/activity] publicnode chunks failing, returning empty:', String(pubChunkErr));
    return [];
  }
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
      console.error(`[pancakeswap/activity] CoinGecko history ${cgId} ${dateStr} HTTP ${res.status}`);
      return null;
    }
    const json = await res.json();
    return json?.market_data?.current_price?.usd ?? null;
  } catch (err) {
    console.error(`[pancakeswap/activity] CoinGecko history ${cgId} ${dateStr} error:`, err);
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
  const cgId0 = CG_IDS[token0] ?? null;
  const cgId1 = CG_IDS[token1] ?? null;

  const MAX_DATES = 30;
  const recentDates = dates.slice(-MAX_DATES);
  const olderDates = dates.slice(0, dates.length - MAX_DATES);

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
  const word = data.slice(start, start + 64);
  if (!word || word.length < 64) return 0n;
  return BigInt('0x' + word);
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const positionId = searchParams.get('positionId');     // numeric NFT tokenId string
  const t0d = parseInt(searchParams.get('t0d') ?? '18', 10);
  const t1d = parseInt(searchParams.get('t1d') ?? '18', 10);
  const token0 = (searchParams.get('token0') ?? '').toLowerCase();
  const token1 = (searchParams.get('token1') ?? '').toLowerCase();
  const fallback0 = parseFloat(searchParams.get('p0') ?? '0');
  const fallback1 = parseFloat(searchParams.get('p1') ?? '0');

  if (!positionId) {
    return NextResponse.json({ error: 'positionId required' }, { status: 400 });
  }
  if (!ALCHEMY_KEY) {
    return NextResponse.json({ error: 'Alchemy key not configured' }, { status: 500 });
  }

  try {
    const tokenIdHex = '0x' + BigInt(positionId).toString(16).padStart(64, '0');
    const logs = await fetchLogs(tokenIdHex);
    console.log(`[pancakeswap/activity] tokenId=${positionId} → ${logs.length} logs`);

    if (logs.length === 0) {
      const empty: ActivityResponse = { events: [], netInvested0: 0, netInvested1: 0, totalFees0: 0, totalFees1: 0 };
      return NextResponse.json(empty);
    }

    const blockNumbers = logs.map(l => parseInt(l.blockNumber, 16));
    const timestamps = await fetchTimestamps(blockNumbers);

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
        console.error('[pancakeswap/activity] Unknown topic0 (skipping):', topic0);
        return [];
      }

      const blockNum = parseInt(log.blockNumber, 16);
      const timestamp = timestamps[blockNum] ?? 0;
      const data = log.data.startsWith('0x') ? log.data.slice(2) : log.data;

      // IncreaseLiquidity/DecreaseLiquidity: word0=liquidity, word1=amount0, word2=amount1
      // Collect: word0=recipient(address), word1=amount0Collected, word2=amount1Collected
      const amount0Raw = decodeWord(data, 1);
      const amount1Raw = decodeWord(data, 2);

      if (type === 'deposit')    { deposited0 += amount0Raw; deposited1 += amount1Raw; }
      if (type === 'withdrawal') { withdrawn0 += amount0Raw; withdrawn1 += amount1Raw; }
      if (type === 'fee_claim')  { fees0 += amount0Raw;      fees1 += amount1Raw;      }

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

      return { type: ev.type, txHash: ev.txHash, blockNumber: ev.blockNumber, timestamp: ev.timestamp, amount0, amount1, usdAtTime, price0AtTime, price1AtTime, cumulativeFeeUSD };
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
    console.error('[pancakeswap/activity] Unexpected error:', err);
    return NextResponse.json({ error: 'Failed to fetch activity', details: String(err) }, { status: 500 });
  }
}
