import { NextResponse } from 'next/server';
import { deriveDepositPrices } from '../../../lib/v3PriceDerivation';

const ALCHEMY_KEY = process.env.NEXT_PUBLIC_ALCHEMY_KEY;
// Alchemy Optimism — used only for eth_getBlockByNumber / eth_blockNumber (timestamp lookups)
const ALCHEMY_RPC = `https://opt-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`;
// Tenderly — primary for eth_getLogs: supports full-history scans with no block-range limit
const TENDERLY_RPC = 'https://optimism.gateway.tenderly.co';
// LlamaRPC Optimism — secondary: now enforces 30k block range limit (code -32012)
const LLAMA_RPC = 'https://op.llamarpc.com';
// publicnode — tertiary fallback for chunked scanning
const PUBLIC_NODE_RPC = 'https://optimism-rpc.publicnode.com';

// Velodrome Slipstream (CL) NonfungiblePositionManager on Optimism
// keccak256 verified to emit the same event signatures as all standard V3 forks
const NFT_MANAGER = '0x416b433906b1B72FA758e166e239c43d68dC6F29';

// Velodrome Slipstream deployed in late 2023 on Optimism.
// Optimism pre-Bedrock (Dec2021-Jun2023) ~12s blocks → ~3.9M; post-Bedrock 2s blocks.
// At Q4 2023 Optimism was at approximately block 12-15M. Use 10M as conservative start.
const DEPLOY_BLOCK = 10_000_000;  // conservative start, before Velodrome CL launch

// Chunk sizes: LlamaRPC just under 30k limit; publicnode supports up to 49k
const LLAMA_CHUNK   = 29_000;
const PUBNODE_CHUNK = 49_000;
// Max parallel getLogs requests per batch
const MAX_CONCURRENCY = 50;

// Standard V3 event topic0 hashes (identical across all V3-fork NFT managers)
const TOPIC_INCREASE = '0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f';
const TOPIC_DECREASE = '0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4';
const TOPIC_COLLECT  = '0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01';

// Known Optimism stablecoins (lowercase)
const STABLECOINS = new Set([
  '0x0b2c639c533813f4aa9d7837caf62653d097ff85', // USDC
  '0x7f5c764cbc14f9669b88837ca1490cca17c31607', // USDC.e
  '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58', // USDT
  '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1', // DAI
]);

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
  console.log(`[velodrome/activity] chunked scan: ${chunks.length} chunks @ ${chunkSize} blocks, rpc=${rpcUrl}`);

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
      throw new Error(`[velodrome/activity] chunked scan: first batch 100% error rate on ${rpcUrl}`);
    }
  }
  return allLogs;
}

async function fetchLogs(tokenIdHex: string): Promise<RawLog[]> {
  const logsParams = {
    address: NFT_MANAGER,
    topics: [[TOPIC_INCREASE, TOPIC_DECREASE, TOPIC_COLLECT], tokenIdHex],
    fromBlock: '0x' + DEPLOY_BLOCK.toString(16),
    toBlock: 'latest' as const,
  };

  // Tier 1: Tenderly (full-range, no limits, fast)
  const tenderlyAttempt = await rpcPost(TENDERLY_RPC, {
    jsonrpc: '2.0', method: 'eth_getLogs', params: [logsParams], id: 1,
  }) as { result?: RawLog[]; error?: { message: string; code?: number } };

  if (!tenderlyAttempt.error) {
    return tenderlyAttempt.result ?? [];
  }
  console.warn('[velodrome/activity] Tenderly error:', tenderlyAttempt.error.message);

  // Tier 2: LlamaRPC full range
  const llamaAttempt = await rpcPost(LLAMA_RPC, {
    jsonrpc: '2.0', method: 'eth_getLogs', params: [logsParams], id: 1,
  }) as { result?: RawLog[]; error?: { message: string; code?: number } };

  if (!llamaAttempt.error) {
    return llamaAttempt.result ?? [];
  }

  const code = (llamaAttempt.error as unknown as { code?: number }).code;
  const msg  = llamaAttempt.error.message;
  console.warn('[velodrome/activity] LlamaRPC full-range error:', code, msg);

  const bnRes = await rpcPost(ALCHEMY_RPC, {
    jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1,
  }) as { result?: string };
  const currentBlock = bnRes.result ? parseInt(bnRes.result, 16) : 150_000_000;

  const isRangeErr    = code === -32012 || msg.includes('ExceededMaxAllowed') || msg.includes('range');
  const isUnreachable = code === -32603 || msg.toLowerCase().includes('unreachable');

  // Tier 3: LlamaRPC chunked
  if (isRangeErr) {
    try {
      return await fetchLogsChunked(tokenIdHex, DEPLOY_BLOCK, currentBlock, LLAMA_RPC, LLAMA_CHUNK);
    } catch (llamaChunkErr) {
      console.warn('[velodrome/activity] LlamaRPC chunks also failing, switching to publicnode:', String(llamaChunkErr));
    }
  }

  // Tier 4: publicnode chunked
  if (isRangeErr || isUnreachable) {
    return fetchLogsChunked(tokenIdHex, DEPLOY_BLOCK, currentBlock, PUBLIC_NODE_RPC, PUBNODE_CHUNK);
  }

  throw new Error(`[velodrome/activity] eth_getLogs RPC error: ${msg}`);
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
  const tickLower  = searchParams.get('tickLower') != null ? parseInt(searchParams.get('tickLower')!, 10) : null;
  const tickUpper  = searchParams.get('tickUpper') != null ? parseInt(searchParams.get('tickUpper')!, 10) : null;

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

    const hasTicks = tickLower != null && tickUpper != null;
    let runningFeeUSD = 0;
    const events: ActivityEvent[] = rawEvents.map((ev) => {
      const amount0 = Number(ev.amount0Raw) / Number(scale0);
      const amount1 = Number(ev.amount1Raw) / Number(scale1);

      let price0AtTime: number | null = null;
      let price1AtTime: number | null = null;
      let usdAtTime: number | null = null;

      if (ev.type === 'deposit' && hasTicks) {
        const derived = deriveDepositPrices(
          amount0, amount1, tickLower!, tickUpper!, t0d, t1d,
          token0, token1, STABLECOINS,
        );
        if (derived) {
          price0AtTime = derived.price0;
          price1AtTime = derived.price1;
          usdAtTime = amount0 * derived.price0 + amount1 * derived.price1;
        }
      }

      if (usdAtTime == null) {
        price0AtTime = fallback0 || null;
        price1AtTime = fallback1 || null;
        if (fallback0 > 0 || fallback1 > 0) {
          usdAtTime = amount0 * fallback0 + amount1 * fallback1;
        }
      }

      let cumulativeFeeUSD = 0;
      if (ev.type === 'fee_claim') {
        runningFeeUSD += usdAtTime ?? 0;
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
    console.error('[velodrome/activity] Unexpected error:', err);
    return NextResponse.json({ error: 'Failed to fetch activity', details: String(err) }, { status: 500 });
  }
}
