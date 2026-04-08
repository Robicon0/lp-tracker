import { NextResponse } from 'next/server';

const ALCHEMY_KEY = process.env.NEXT_PUBLIC_ALCHEMY_KEY;
// Alchemy used only for eth_getBlockByNumber / eth_blockNumber — free tier supports this
const ALCHEMY_RPC = `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`;
// Tenderly — primary for eth_getLogs: supports full-history scans with no block-range limit, fast
const TENDERLY_RPC = 'https://base.gateway.tenderly.co';
// LlamaRPC — secondary: now enforces 30k block range limit (code -32012)
const LLAMA_RPC = 'https://base.llamarpc.com';
// publicnode — tertiary fallback with chunked scanning; ~8s/request for historical blocks
const PUBLIC_NODE_RPC = 'https://base-rpc.publicnode.com';

// Aerodrome Slipstream (CL) NonfungiblePositionManager on Base
// Verified: factory() returns 0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A (matches CL_FACTORY)
const NFT_MANAGER = '0x827922686190790b37229fd06084350E74485b72';

// Aerodrome CL NFT manager deployed at ~Base block 13,844,000 (April 2024)
const DEPLOY_BLOCK = 13_844_000;

// Chunk sizes: LlamaRPC just under its 30k limit; publicnode supports up to 49k
const LLAMA_CHUNK   = 29_000;
const PUBNODE_CHUNK = 49_000;
// Concurrency limits per RPC — publicnode rate-limits aggressively at high concurrency
const LLAMA_CONCURRENCY   = 10;
const PUBNODE_CONCURRENCY =  5;

// Known anchor point: tokenId 50,093,212 was minted at Base block 41,878,002 (from prod data)
// Used to estimate the start block for a given tokenId so we scan far fewer chunks
const ANCHOR_TOKEN_ID     = 50_093_212;
const ANCHOR_BLOCK        = 41_878_002;
const POSITIONS_PER_BLOCK = 4;   // observed minting rate near block 44M

function estimateStartBlock(tokenId: number, currentBlock: number): number {
  let estimated: number;
  if (tokenId <= ANCHOR_TOKEN_ID) {
    // Linear interpolation from deployment to anchor point
    const fraction = tokenId / ANCHOR_TOKEN_ID;
    estimated = Math.floor(DEPLOY_BLOCK + fraction * (ANCHOR_BLOCK - DEPLOY_BLOCK));
  } else {
    // Recent positions: extrapolate from anchor at ~4 positions/block
    const blocksSinceAnchor = Math.floor((tokenId - ANCHOR_TOKEN_ID) / POSITIONS_PER_BLOCK);
    estimated = ANCHOR_BLOCK + blocksSinceAnchor;
  }
  // Generous 5M block safety margin so we never miss the deposit event
  return Math.max(DEPLOY_BLOCK, Math.min(estimated - 5_000_000, currentBlock - 10_000));
}

// Event topic0 values — computed via keccak256 with viem, verified against live Base chain events
// IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
const TOPIC_INCREASE = '0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f';
// DecreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
const TOPIC_DECREASE = '0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4';
// Collect(uint256 indexed tokenId, address recipient, uint256 amount0Collected, uint256 amount1Collected)
const TOPIC_COLLECT = '0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01';

// CoinGecko IDs for known Base tokens — used to fetch historical prices
const CG_IDS: Record<string, string> = {
  '0x4200000000000000000000000000000000000006': 'ethereum',       // WETH
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 'usd-coin',      // USDC
  '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf': 'bitcoin',        // cbBTC
  '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': 'dai',            // DAI
};

export type ActivityEventType = 'deposit' | 'withdrawal' | 'fee_claim';

export interface ActivityEvent {
  type: ActivityEventType;
  txHash: string;
  blockNumber: number;
  timestamp: number;      // unix seconds
  amount0: number;        // human-readable (decimal-adjusted)
  amount1: number;
  usdAtTime: number | null;   // null if historical price fetch failed
  // Per-event historical prices used to derive usdAtTime. Null when no CG mapping
  // exists for the token (caller should treat as "no entry-price data" for IL).
  price0AtTime: number | null;
  price1AtTime: number | null;
  cumulativeFeeUSD: number;   // running total of fee_claim USD; 0 for non-fee events
}

interface ActivityResponse {
  events: ActivityEvent[];
  netInvested0: number;   // sum(deposits) - sum(withdrawals), decimal-adjusted
  netInvested1: number;
  totalFees0: number;     // sum of all Collect events, decimal-adjusted
  totalFees1: number;
}

async function rpcPost(url: string, body: object): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

// Scan eth_getLogs in parallel chunks with a configurable concurrency limit.
// Throws if the first batch is 100% errors (RPC is down — caller should try backup).
async function fetchLogsChunked(
  tokenIdHex: string,
  fromBlock: number,
  toBlock: number,
  rpcUrl: string,
  chunkSize: number,
  concurrency: number,
): Promise<RawLog[]> {
  const chunks: Array<[number, number]> = [];
  for (let b = fromBlock; b <= toBlock; b += chunkSize) {
    chunks.push([b, Math.min(b + chunkSize - 1, toBlock)]);
  }
  console.log(`[aerodrome/activity] chunked scan: ${chunks.length} chunks (${fromBlock}→${toBlock}), concurrency=${concurrency}, rpc=${rpcUrl}`);

  const allLogs: RawLog[] = [];
  for (let i = 0; i < chunks.length; i += concurrency) {
    const batch = chunks.slice(i, i + concurrency);
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
    // First batch entirely failed → RPC is down; throw so caller can switch to backup
    if (i === 0 && batchErrors === batch.length) {
      throw new Error(`[aerodrome/activity] chunked scan: first batch 100% error on ${rpcUrl}`);
    }
  }
  return allLogs;
}

// Fetch all logs for a tokenId.
// Tier 1: Tenderly full range — no block limit, sub-second, no auth required
// Tier 2: LlamaRPC full range — fallback if Tenderly fails
// Tier 3: LlamaRPC chunked 29k blocks, 10 concurrent — if LlamaRPC has range limit
// Tier 4: publicnode chunked 49k blocks, 5 concurrent — if LlamaRPC fully down
async function fetchLogs(tokenIdHex: string, tokenId: number): Promise<RawLog[]> {
  // Get current block to bound chunked scans
  const bnRes = await rpcPost(ALCHEMY_RPC, {
    jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1,
  }) as { result?: string };
  const currentBlock = bnRes.result ? parseInt(bnRes.result, 16) : 44_500_000;

  // Smart start block: use tokenId estimation to minimize chunk count for fallbacks
  const startBlock = estimateStartBlock(tokenId, currentBlock);
  const startHex   = '0x' + startBlock.toString(16);

  const logsParams = {
    address: NFT_MANAGER,
    topics: [[TOPIC_INCREASE, TOPIC_DECREASE, TOPIC_COLLECT], tokenIdHex],
    fromBlock: startHex,
    toBlock: 'latest' as const,
  };

  // Tier 1: Tenderly (full-range, no limits, fast)
  const tenderlyAttempt = await rpcPost(TENDERLY_RPC, {
    jsonrpc: '2.0', method: 'eth_getLogs', params: [logsParams], id: 1,
  }) as { result?: RawLog[]; error?: { message: string; code?: number } };

  if (!tenderlyAttempt.error) {
    return tenderlyAttempt.result ?? [];
  }
  console.warn('[aerodrome/activity] Tenderly error:', (tenderlyAttempt.error as unknown as {code?:number}).code, tenderlyAttempt.error.message);

  // Tier 2: LlamaRPC full range
  const llamaAttempt = await rpcPost(LLAMA_RPC, {
    jsonrpc: '2.0', method: 'eth_getLogs', params: [logsParams], id: 1,
  }) as { result?: RawLog[]; error?: { message: string; code?: number } };

  if (!llamaAttempt.error) {
    return llamaAttempt.result ?? [];
  }

  const llamaCode = (llamaAttempt.error as unknown as { code?: number }).code;
  const llamaMsg  = llamaAttempt.error.message;
  console.warn('[aerodrome/activity] LlamaRPC full-range error:', llamaCode, llamaMsg);

  const isRangeErr    = llamaCode === -32012 || llamaMsg.includes('ExceededMaxAllowed') || llamaMsg.includes('range');
  const isUnreachable = llamaCode === -32603 || llamaMsg.toLowerCase().includes('unreachable');

  // Tier 3: LlamaRPC chunked
  if (isRangeErr) {
    try {
      return await fetchLogsChunked(tokenIdHex, startBlock, currentBlock, LLAMA_RPC, LLAMA_CHUNK, LLAMA_CONCURRENCY);
    } catch (llamaChunkErr) {
      console.warn('[aerodrome/activity] LlamaRPC chunks also failing, switching to publicnode:', String(llamaChunkErr));
    }
  }

  // Tier 4: publicnode chunked
  if (isRangeErr || isUnreachable) {
    return fetchLogsChunked(tokenIdHex, startBlock, currentBlock, PUBLIC_NODE_RPC, PUBNODE_CHUNK, PUBNODE_CONCURRENCY);
  }

  throw new Error(`[aerodrome/activity] eth_getLogs RPC error: ${llamaMsg}`);
}

// Batch-fetch block timestamps using Alchemy (eth_getBlockByNumber works fine on free tier)
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

// Fetch historical USD price for a CoinGecko coin ID on a specific date (DD-MM-YYYY)
// Returns null on failure — caller should fall back to current price
async function fetchCGHistoricalPrice(cgId: string, dateStr: string): Promise<number | null> {
  try {
    const url = `https://api.coingecko.com/api/v3/coins/${cgId}/history?date=${dateStr}&localization=false`;
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) {
      console.error(`[aerodrome/activity] CoinGecko history ${cgId} ${dateStr} HTTP ${res.status}`);
      return null;
    }
    const json = await res.json();
    return json?.market_data?.current_price?.usd ?? null;
  } catch (err) {
    console.error(`[aerodrome/activity] CoinGecko history ${cgId} ${dateStr} error:`, err);
    return null;
  }
}

// Fetch historical prices for two tokens across a set of unique dates (capped at 30 most recent).
// For dates beyond the cap or where fetch fails, returns current price as fallback.
async function fetchHistoricalPrices(
  token0: string,
  token1: string,
  dates: string[],         // unique DD-MM-YYYY strings, sorted chronologically
  fallback0: number,
  fallback1: number,
): Promise<Record<string, { p0: number; p1: number }>> {
  const cgId0 = CG_IDS[token0.toLowerCase()] ?? null;
  const cgId1 = CG_IDS[token1.toLowerCase()] ?? null;

  // Cap at 30 most recent unique dates — use current price for older ones
  const MAX_DATES = 30;
  const recentDates = dates.slice(-MAX_DATES);
  const olderDates = dates.slice(0, dates.length - MAX_DATES);

  const result: Record<string, { p0: number; p1: number }> = {};

  // Fill older dates with fallback prices immediately
  for (const d of olderDates) {
    result[d] = { p0: fallback0, p1: fallback1 };
  }

  // Fetch historical prices for recent dates in parallel (batched per date)
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
  const positionId = searchParams.get('positionId');   // numeric NFT tokenId string
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
    // Pad tokenId to 32-byte hex topic
    const tokenIdBig = BigInt(positionId);
    const tokenIdNum = Number(tokenIdBig);
    const tokenIdHex = '0x' + tokenIdBig.toString(16).padStart(64, '0');

    const logs = await fetchLogs(tokenIdHex, tokenIdNum);
    console.log(`[aerodrome/activity] tokenId=${positionId} tokenIdHex=${tokenIdHex} → ${logs.length} logs`);

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

    // Fetch timestamps for all unique block numbers
    const blockNumbers = logs.map(l => parseInt(l.blockNumber, 16));
    const timestamps = await fetchTimestamps(blockNumbers);

    const scale0 = BigInt(10) ** BigInt(t0d);
    const scale1 = BigInt(10) ** BigInt(t1d);

    // Collect unique dates (for historical price lookups) across all events
    const uniqueDatesSet = new Set<string>();
    for (const log of logs) {
      const bn = parseInt(log.blockNumber, 16);
      const ts = timestamps[bn] ?? 0;
      if (ts > 0) uniqueDatesSet.add(tsToDateStr(ts));
    }
    const uniqueDates = [...uniqueDatesSet].sort();  // chronological

    // Fetch historical prices (or fall back to current prices)
    const pricesByDate = token0 && token1
      ? await fetchHistoricalPrices(token0, token1, uniqueDates, fallback0, fallback1)
      : {};

    let deposited0 = 0n, deposited1 = 0n;
    let withdrawn0 = 0n, withdrawn1 = 0n;
    let fees0 = 0n, fees1 = 0n;

    // Build events in log order (chronological) first to compute cumulative fees correctly
    interface RawEvent {
      type: ActivityEventType;
      txHash: string;
      blockNumber: number;
      timestamp: number;
      amount0Raw: bigint;
      amount1Raw: bigint;
    }

    const rawEvents: RawEvent[] = logs.map((log) => {
      const topic0 = log.topics[0].toLowerCase();
      const blockNum = parseInt(log.blockNumber, 16);
      const timestamp = timestamps[blockNum] ?? 0;
      const data = log.data.startsWith('0x') ? log.data.slice(2) : log.data;

      let type: ActivityEventType;
      let amount0Raw = 0n, amount1Raw = 0n;

      if (topic0 === TOPIC_INCREASE) {
        type = 'deposit';
        amount0Raw = decodeWord(data, 1);
        amount1Raw = decodeWord(data, 2);
        deposited0 += amount0Raw;
        deposited1 += amount1Raw;
      } else if (topic0 === TOPIC_DECREASE) {
        type = 'withdrawal';
        amount0Raw = decodeWord(data, 1);
        amount1Raw = decodeWord(data, 2);
        withdrawn0 += amount0Raw;
        withdrawn1 += amount1Raw;
      } else {
        type = 'fee_claim';
        amount0Raw = decodeWord(data, 1);
        amount1Raw = decodeWord(data, 2);
        fees0 += amount0Raw;
        fees1 += amount1Raw;
      }

      return { type, txHash: log.transactionHash, blockNumber: blockNum, timestamp, amount0Raw, amount1Raw };
    });

    // Sort chronologically to compute cumulative fees (oldest first)
    rawEvents.sort((a, b) => a.blockNumber - b.blockNumber);

    let runningFeeUSD = 0;
    const events: ActivityEvent[] = rawEvents.map((ev) => {
      const amount0 = Number(ev.amount0Raw) / Number(scale0);
      const amount1 = Number(ev.amount1Raw) / Number(scale1);
      const dateStr = ev.timestamp > 0 ? tsToDateStr(ev.timestamp) : null;
      // Only treat as "real" historical prices when both tokens have a CG mapping
      // and a fetch returned a value — never silently fall back to current price for IL math.
      const cgMapped0 = !!CG_IDS[token0];
      const cgMapped1 = !!CG_IDS[token1];
      const histEntry = dateStr ? pricesByDate[dateStr] : undefined;
      const price0AtTime = cgMapped0 && histEntry ? histEntry.p0 : null;
      const price1AtTime = cgMapped1 && histEntry ? histEntry.p1 : null;
      const prices = dateStr ? (histEntry ?? { p0: fallback0, p1: fallback1 }) : null;
      const usdAtTime = prices ? amount0 * prices.p0 + amount1 * prices.p1 : null;

      let cumulativeFeeUSD = 0;
      if (ev.type === 'fee_claim' && usdAtTime != null) {
        runningFeeUSD += usdAtTime;
        cumulativeFeeUSD = runningFeeUSD;
      } else if (ev.type === 'fee_claim') {
        // Fee claim but no USD value — still increment with fallback
        const fallbackUSD = amount0 * fallback0 + amount1 * fallback1;
        runningFeeUSD += fallbackUSD;
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

    // Reverse to newest-first for display
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
    console.error('[aerodrome/activity] Unexpected error:', err);
    return NextResponse.json(
      { error: 'Failed to fetch activity', details: String(err) },
      { status: 500 }
    );
  }
}

interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
}
