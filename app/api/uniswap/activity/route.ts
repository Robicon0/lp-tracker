import { NextResponse } from 'next/server';

const ALCHEMY_KEY = process.env.NEXT_PUBLIC_ALCHEMY_KEY;

// Tenderly public gateways — primary for eth_getLogs: full-history, no block-range limit, fast
const TENDERLY_RPCS: Record<string, string> = {
  ethereum: 'https://mainnet.gateway.tenderly.co',
  arbitrum: 'https://arbitrum.gateway.tenderly.co',
  polygon:  'https://polygon.gateway.tenderly.co',
  optimism: 'https://optimism.gateway.tenderly.co',
};

// LlamaRPC public RPCs — secondary: now enforces 30k block range limit (code -32012)
const BLAST_RPCS: Record<string, string> = {
  ethereum: 'https://eth.llamarpc.com',
  arbitrum: 'https://arb1.llamarpc.com',
  polygon:  'https://polygon.llamarpc.com',
  optimism: 'https://op.llamarpc.com',
};

// publicnode — tertiary fallback for chunked scanning
const PUBLIC_NODE_RPCS: Record<string, string> = {
  ethereum: 'https://ethereum-rpc.publicnode.com',
  arbitrum: 'https://arbitrum-one-rpc.publicnode.com',
  polygon:  'https://polygon-bor-rpc.publicnode.com',
  optimism: 'https://optimism-rpc.publicnode.com',
};

// Alchemy RPCs — used only for eth_getBlockByNumber (timestamp lookups)
const ALCHEMY_RPCS: Record<string, string> = {
  ethereum: `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  arbitrum: `https://arb-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  polygon:  `https://polygon-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  optimism: `https://opt-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
};

// Uniswap V3 NonfungiblePositionManager — same address on all supported chains
const NFT_MANAGER = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88';

// Approximate deployment block per chain (numeric, used for chunked fallback scanning)
const DEPLOY_BLOCKS: Record<string, number> = {
  ethereum: 12_369_140,  // Uniswap V3 launch May 2021
  arbitrum:    165_216,  // Uniswap V3 on Arbitrum launch
  polygon:  22_761_331,  // Uniswap V3 on Polygon launch
  optimism:   3_000_000, // Uniswap V3 on Optimism launch
};

// Chunk sizes: LlamaRPC just under 30k limit; publicnode supports up to 49k
const LLAMA_CHUNK   = 29_000;
const PUBNODE_CHUNK = 49_000;
// Max parallel getLogs requests per batch
const MAX_CONCURRENCY = 50;

// Standard Uniswap V3 event topic0 hashes — same for all V3 forks
const TOPIC_INCREASE = '0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f';
const TOPIC_DECREASE = '0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4';
const TOPIC_COLLECT  = '0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01';

// CoinGecko IDs for known tokens per chain
const CG_IDS: Record<string, Record<string, string>> = {
  ethereum: {
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': 'ethereum',   // WETH
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'usd-coin',   // USDC
    '0xdac17f958d2ee523a2206206994597c13d831ec7': 'tether',     // USDT
    '0x6b175474e89094c44da98b954eedeac495271d0f': 'dai',        // DAI
    '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': 'bitcoin',    // WBTC
    '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984': 'uniswap',   // UNI
    '0x514910771af9ca656af840dff83e8264ecf986ca': 'chainlink', // LINK
  },
  arbitrum: {
    '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': 'ethereum',
    '0xaf88d065e77c8cc2239327c5edb3a432268e5831': 'usd-coin',
    '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8': 'usd-coin',
    '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': 'tether',
    '0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f': 'bitcoin',
    '0x912ce59144191c1204e64559fe8253a0e49e6548': 'arbitrum',
    '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1': 'dai',
  },
  polygon: {
    '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619': 'ethereum',
    '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359': 'usd-coin',
    '0x2791bca1f2de4661ed88a30c99a7a9449aa84174': 'usd-coin',
    '0xc2132d05d31c914a87c6611c10748aeb04b58e8f': 'tether',
    '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270': 'matic-network',
    '0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6': 'bitcoin',
    '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063': 'dai',
  },
  optimism: {
    '0x4200000000000000000000000000000000000006': 'ethereum',
    '0x0b2c639c533813f4aa9d7837caf62653d097ff85': 'usd-coin',
    '0x7f5c764cbc14f9669b88837ca1490cca17c31607': 'usd-coin',
    '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58': 'tether',
    '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1': 'dai',
    '0x68f180fcce6836688e9084f035309e29bf0a2095': 'bitcoin',
    '0x4200000000000000000000000000000000000042': 'optimism',
  },
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
  console.log(`[uniswap/activity] chunked scan: ${chunks.length} chunks @ ${chunkSize} blocks, rpc=${rpcUrl}`);

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
      throw new Error(`[uniswap/activity] chunked scan: first batch 100% error rate on ${rpcUrl}`);
    }
  }
  return allLogs;
}

async function fetchLogs(
  chain: string,
  blastRpc: string,
  alchemyRpc: string,
  tokenIdHex: string,
): Promise<RawLog[]> {
  const deployBlock = DEPLOY_BLOCKS[chain] ?? 0;
  const tenderlyRpc = TENDERLY_RPCS[chain];
  const pubNodeRpc  = PUBLIC_NODE_RPCS[chain];

  const logsParams = {
    address: NFT_MANAGER,
    topics: [[TOPIC_INCREASE, TOPIC_DECREASE, TOPIC_COLLECT], tokenIdHex],
    fromBlock: '0x' + deployBlock.toString(16),
    toBlock: 'latest' as const,
  };

  // Tier 1: Tenderly (full-range, no limits, fast)
  if (tenderlyRpc) {
    const tenderlyAttempt = await rpcPost(tenderlyRpc, {
      jsonrpc: '2.0', method: 'eth_getLogs', params: [logsParams], id: 1,
    }) as { result?: RawLog[]; error?: { message: string; code?: number } };
    if (!tenderlyAttempt.error) {
      return tenderlyAttempt.result ?? [];
    }
    console.warn('[uniswap/activity] Tenderly error:', chain, tenderlyAttempt.error.message);
  }

  // Tier 2: LlamaRPC full range
  const llamaAttempt = await rpcPost(blastRpc, {
    jsonrpc: '2.0', method: 'eth_getLogs', params: [logsParams], id: 1,
  }) as { result?: RawLog[]; error?: { message: string; code?: number } };

  if (!llamaAttempt.error) {
    return llamaAttempt.result ?? [];
  }

  const code = (llamaAttempt.error as unknown as { code?: number }).code;
  const msg  = llamaAttempt.error.message;
  console.warn('[uniswap/activity] LlamaRPC full-range error:', chain, code, msg);

  const bnRes = await rpcPost(alchemyRpc, {
    jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1,
  }) as { result?: string };
  const currentBlock = bnRes.result ? parseInt(bnRes.result, 16) : 21_500_000;

  const isRangeErr    = code === -32012 || msg.includes('ExceededMaxAllowed') || msg.includes('range');
  const isUnreachable = code === -32603 || msg.toLowerCase().includes('unreachable');

  // Tier 3: LlamaRPC chunked
  if (isRangeErr) {
    try {
      return await fetchLogsChunked(tokenIdHex, deployBlock, currentBlock, blastRpc, LLAMA_CHUNK);
    } catch (llamaChunkErr) {
      console.warn('[uniswap/activity] LlamaRPC chunks also failing, switching to publicnode:', String(llamaChunkErr));
    }
  }

  // Tier 4: publicnode chunked
  if ((isRangeErr || isUnreachable) && pubNodeRpc) {
    return fetchLogsChunked(tokenIdHex, deployBlock, currentBlock, pubNodeRpc, PUBNODE_CHUNK);
  }

  throw new Error(`[uniswap/activity] eth_getLogs RPC error: ${msg}`);
}

async function fetchTimestamps(alchemyRpc: string, blockNumbers: number[]): Promise<Record<number, number>> {
  const unique = [...new Set(blockNumbers)];
  const results = await Promise.all(
    unique.map(async (bn) => {
      const res = await rpcPost(alchemyRpc, {
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
      console.error(`[uniswap/activity] CoinGecko history ${cgId} ${dateStr} HTTP ${res.status}`);
      return null;
    }
    const json = await res.json();
    return json?.market_data?.current_price?.usd ?? null;
  } catch (err) {
    console.error(`[uniswap/activity] CoinGecko history ${cgId} ${dateStr} error:`, err);
    return null;
  }
}

async function fetchHistoricalPrices(
  chain: string,
  token0: string,
  token1: string,
  dates: string[],
  fallback0: number,
  fallback1: number,
): Promise<Record<string, { p0: number; p1: number }>> {
  const chainIds = CG_IDS[chain] ?? {};
  const cgId0 = chainIds[token0.toLowerCase()] ?? null;
  const cgId1 = chainIds[token1.toLowerCase()] ?? null;

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
  const chain     = searchParams.get('chain') ?? '';       // ethereum | arbitrum | polygon | optimism
  const tokenId   = searchParams.get('tokenId') ?? '';     // numeric NFT tokenId string
  const t0d       = parseInt(searchParams.get('t0d') ?? '18', 10);
  const t1d       = parseInt(searchParams.get('t1d') ?? '18', 10);
  const token0    = (searchParams.get('token0') ?? '').toLowerCase();
  const token1    = (searchParams.get('token1') ?? '').toLowerCase();
  const fallback0 = parseFloat(searchParams.get('p0') ?? '0');
  const fallback1 = parseFloat(searchParams.get('p1') ?? '0');

  if (!chain || !tokenId) {
    return NextResponse.json({ error: 'chain and tokenId required' }, { status: 400 });
  }
  if (!BLAST_RPCS[chain]) {
    return NextResponse.json({ error: `Unsupported chain: ${chain}` }, { status: 400 });
  }
  if (!ALCHEMY_KEY) {
    return NextResponse.json({ error: 'Alchemy key not configured' }, { status: 500 });
  }

  try {
    const blastRpc   = BLAST_RPCS[chain];
    const alchemyRpc = ALCHEMY_RPCS[chain];

    const tokenIdHex = '0x' + BigInt(tokenId).toString(16).padStart(64, '0');
    const logs = await fetchLogs(chain, blastRpc, alchemyRpc, tokenIdHex);

    if (logs.length === 0) {
      const empty: ActivityResponse = { events: [], netInvested0: 0, netInvested1: 0, totalFees0: 0, totalFees1: 0 };
      return NextResponse.json(empty);
    }

    const blockNumbers = logs.map(l => parseInt(l.blockNumber, 16));
    const timestamps = await fetchTimestamps(alchemyRpc, blockNumbers);

    const scale0 = BigInt(10) ** BigInt(t0d);
    const scale1 = BigInt(10) ** BigInt(t1d);

    const uniqueDatesSet = new Set<string>();
    for (const log of logs) {
      const ts = timestamps[parseInt(log.blockNumber, 16)] ?? 0;
      if (ts > 0) uniqueDatesSet.add(tsToDateStr(ts));
    }
    const uniqueDates = [...uniqueDatesSet].sort();

    const pricesByDate = (token0 && token1)
      ? await fetchHistoricalPrices(chain, token0, token1, uniqueDates, fallback0, fallback1)
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
        console.error('[uniswap/activity] Unknown topic0 (skipping):', topic0);
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

    // Sort chronologically for cumulative fee calculation
    rawEvents.sort((a, b) => a.blockNumber - b.blockNumber);

    const chainIds = CG_IDS[chain] ?? {};
    const cgMapped0 = !!chainIds[token0];
    const cgMapped1 = !!chainIds[token1];

    let runningFeeUSD = 0;
    const events: ActivityEvent[] = rawEvents.map((ev) => {
      const amount0 = Number(ev.amount0Raw) / Number(scale0);
      const amount1 = Number(ev.amount1Raw) / Number(scale1);
      const dateStr = ev.timestamp > 0 ? tsToDateStr(ev.timestamp) : null;
      const histEntry = dateStr ? pricesByDate[dateStr] : undefined;
      const price0AtTime = cgMapped0 && histEntry ? histEntry.p0 : null;
      const price1AtTime = cgMapped1 && histEntry ? histEntry.p1 : null;
      const prices  = dateStr ? (histEntry ?? { p0: fallback0, p1: fallback1 }) : null;
      const usdAtTime = prices ? amount0 * prices.p0 + amount1 * prices.p1 : null;

      let cumulativeFeeUSD = 0;
      if (ev.type === 'fee_claim') {
        const feeUSD = usdAtTime ?? (amount0 * fallback0 + amount1 * fallback1);
        runningFeeUSD += feeUSD;
        cumulativeFeeUSD = runningFeeUSD;
      }

      return { type: ev.type, txHash: ev.txHash, blockNumber: ev.blockNumber, timestamp: ev.timestamp, amount0, amount1, usdAtTime, price0AtTime, price1AtTime, cumulativeFeeUSD };
    });

    // Reverse to newest-first for display
    events.reverse();

    return NextResponse.json({
      events,
      netInvested0: Number(deposited0 - withdrawn0) / Number(scale0),
      netInvested1: Number(deposited1 - withdrawn1) / Number(scale1),
      totalFees0:   Number(fees0) / Number(scale0),
      totalFees1:   Number(fees1) / Number(scale1),
    } satisfies ActivityResponse);
  } catch (err) {
    console.error('[uniswap/activity] Unexpected error:', err);
    return NextResponse.json({ error: 'Failed to fetch activity', details: String(err) }, { status: 500 });
  }
}
