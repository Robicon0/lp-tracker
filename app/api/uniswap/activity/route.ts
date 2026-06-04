import { NextResponse } from 'next/server';
import { deriveDepositPrices } from '../../../lib/v3PriceDerivation';
import { createHistoricalFeePriceResolver } from '../../../lib/v3HistoricalFeePrice';
import { prewarmTokenPrices, getCachedTokenPriceForTimestamp } from '../../../lib/cgPriceHistory';

const ALCHEMY_KEY = process.env.NEXT_PUBLIC_ALCHEMY_KEY;

// Tenderly public gateways — primary for eth_getLogs: full-history, no block-range limit, fast.
// NOTE: no BNB Chain entry — Tenderly has no public BSC gateway. BNB skips
// straight to publicnode chunked via ROLLING_SCAN_DEPTH below.
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
  bnb:      'https://binance.llamarpc.com',
};

// publicnode — tertiary fallback for chunked scanning
const PUBLIC_NODE_RPCS: Record<string, string> = {
  ethereum: 'https://ethereum-rpc.publicnode.com',
  arbitrum: 'https://arbitrum-one-rpc.publicnode.com',
  polygon:  'https://polygon-bor-rpc.publicnode.com',
  optimism: 'https://optimism-rpc.publicnode.com',
  bnb:      'https://bsc-rpc.publicnode.com',
};

// Alchemy RPCs — used only for eth_getBlockByNumber (timestamp lookups)
const ALCHEMY_RPCS: Record<string, string> = {
  ethereum: `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  arbitrum: `https://arb-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  polygon:  `https://polygon-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  optimism: `https://opt-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  bnb:      `https://bnb-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
};

// Uniswap V3 NonfungiblePositionManager per chain. Standard 0xC36442… deploys
// to Ethereum / Arbitrum / Optimism / Polygon, but BNB Chain has a DIFFERENT
// canonical address (Uniswap deployed to BSC in 2023 via governance with its
// own CREATE2 salt). Source: @uniswap/v3-sdk constants.ts.
const NFT_MANAGERS: Record<string, string> = {
  ethereum: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
  arbitrum: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
  polygon:  '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
  optimism: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
  bnb:      '0x7b8A01B39D58278b5DE7e48c8449c9f4F5170613',
};

// Approximate deployment block per chain (numeric, used for chunked fallback scanning)
const DEPLOY_BLOCKS: Record<string, number> = {
  ethereum: 12_369_140,  // Uniswap V3 launch May 2021
  arbitrum:    165_216,  // Uniswap V3 on Arbitrum launch
  polygon:  22_761_331,  // Uniswap V3 on Polygon launch
  optimism:   3_000_000, // Uniswap V3 on Optimism launch
  bnb:      26_324_000,  // Uniswap V3 on BNB Chain launch (March 2023, ~block 26.3M)
};

// BSC free-tier public RPCs (publicnode, Alchemy free, LlamaRPC) all PRUNE
// archive history aggressively — publicnode keeps only ~50,000 blocks
// (≈42 hours at 3s block time) and returns "History has been pruned" for
// anything older. With no free-tier archive path the route falls back to a
// rolling window for any chain listed here: scan latestBlock-N → latestBlock
// instead of deploy-block → latestBlock, and gracefully return events:[] when
// chunks fail. Mirrors the pattern in app/api/pancakeswap/activity/route.ts.
// A future upgrade to a paid BSC archive RPC (or BSCSCAN_API_KEY) lifts this.
const ROLLING_SCAN_DEPTH: Record<string, number | undefined> = {
  bnb: 48_000, // ~40 hours, fits inside publicnode's pruning window
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

// Known stablecoins per chain (lowercase addresses)
const STABLECOINS_BY_CHAIN: Record<string, Set<string>> = {
  ethereum: new Set([
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
    '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT
    '0x6b175474e89094c44da98b954eedeac495271d0f', // DAI
  ]),
  arbitrum: new Set([
    '0xaf88d065e77c8cc2239327c5edb3a432268e5831', // USDC
    '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8', // USDC.e
    '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', // USDT
    '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1', // DAI
  ]),
  polygon: new Set([
    '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', // USDC
    '0x2791bca1f2de4661ed88a30c99a7a9449aa84174', // USDC.e
    '0xc2132d05d31c914a87c6611c10748aeb04b58e8f', // USDT
    '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063', // DAI
  ]),
  optimism: new Set([
    '0x0b2c639c533813f4aa9d7837caf62653d097ff85', // USDC
    '0x7f5c764cbc14f9669b88837ca1490cca17c31607', // USDC.e
    '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58', // USDT
    '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1', // DAI
  ]),
  bnb: new Set([
    '0x55d398326f99059ff775485246999027b3197955', // USDT (18 decimals on BSC)
    '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', // USDC (18 decimals on BSC)
    '0xe9e7cea3dedca5984780bafc599bd69add087d56', // BUSD
  ]),
};

// CoinGecko historical-daily-price IDs for non-stablecoin tokens per chain.
// Drives fee_claim usdAtTime so claims are valued at market price on the day
// of the claim instead of the pool's internal sqrtPriceX96 ratio. Tokens
// unmapped here fall through to the sqrtPrice resolver. Add new tokens here
// as they surface in user pairs.
const CG_IDS_BY_CHAIN: Record<string, Record<string, string>> = {
  ethereum: {
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': 'ethereum',       // WETH
    '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': 'wrapped-bitcoin', // WBTC
    '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984': 'uniswap',        // UNI
    '0xb50721bcf8d664c30412cfbc6cf7a15145234ad1': 'arbitrum',       // ARB (on eth)
    '0xae78736cd615f374d3085123a210448e74fc6393': 'rocket-pool-eth', // rETH
    '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0': 'wrapped-steth',  // wstETH
  },
  arbitrum: {
    '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': 'ethereum',       // WETH
    '0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f': 'wrapped-bitcoin', // WBTC
    '0x912ce59144191c1204e64559fe8253a0e49e6548': 'arbitrum',       // ARB
  },
  polygon: {
    '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619': 'ethereum',       // WETH
    '0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6': 'wrapped-bitcoin', // WBTC
    '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270': 'matic-network',  // WMATIC
    '0x0000000000000000000000000000000000001010': 'matic-network',  // MATIC (system)
  },
  optimism: {
    '0x4200000000000000000000000000000000000006': 'ethereum',       // WETH
    '0x4200000000000000000000000000000000000042': 'optimism',       // OP
    '0x68f180fcce6836688e9084f035309e29bf0a2095': 'wrapped-bitcoin', // WBTC
  },
  bnb: {
    '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c': 'binancecoin',    // WBNB
    '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c': 'bitcoin',        // BTCB (1:1 BTC)
    '0x2170ed0880ac9a755fd29b2688956bd959f933f8': 'ethereum',       // ETH on BSC
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
  nftManager: string,
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
            address: nftManager,
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
  const nftManager = NFT_MANAGERS[chain];
  if (!nftManager) {
    console.warn('[uniswap/activity] no NFT manager configured for chain:', chain);
    return [];
  }
  const deployBlock   = DEPLOY_BLOCKS[chain] ?? 0;
  const tenderlyRpc   = TENDERLY_RPCS[chain];
  const pubNodeRpc    = PUBLIC_NODE_RPCS[chain];
  const rollingDepth  = ROLLING_SCAN_DEPTH[chain];

  // ── BNB Chain rolling-window path ────────────────────────────────────
  // BSC free RPCs prune archive history (~50k block window on publicnode).
  // Skip full-range Tenderly/LlamaRPC attempts (they'll fail with a
  // "history pruned" error) and chunk-scan only the recent window.
  // Older deposits surface as missing — the consumer (computePositionPnL)
  // returns {ok:false, reason:'no_deposits'} and the UI shows
  // "Entry data unavailable" gracefully. Same pattern as
  // app/api/pancakeswap/activity/route.ts.
  if (rollingDepth) {
    if (!pubNodeRpc) return [];
    const bnRes = await rpcPost(alchemyRpc, {
      jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1,
    }) as { result?: string; error?: unknown };
    const currentBlock = bnRes.result ? parseInt(bnRes.result, 16) : deployBlock + rollingDepth;
    const fromBlock = Math.max(deployBlock, currentBlock - rollingDepth);
    try {
      return await fetchLogsChunked(nftManager, tokenIdHex, fromBlock, currentBlock, pubNodeRpc, PUBNODE_CHUNK);
    } catch (err) {
      console.warn(`[uniswap/activity] ${chain} rolling-window scan failed — returning empty:`, String(err));
      return [];
    }
  }

  const logsParams = {
    address: nftManager,
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
      return await fetchLogsChunked(nftManager, tokenIdHex, deployBlock, currentBlock, blastRpc, LLAMA_CHUNK);
    } catch (llamaChunkErr) {
      console.warn('[uniswap/activity] LlamaRPC chunks also failing, switching to publicnode:', String(llamaChunkErr));
    }
  }

  // Tier 4: publicnode chunked
  if ((isRangeErr || isUnreachable) && pubNodeRpc) {
    return fetchLogsChunked(nftManager, tokenIdHex, deployBlock, currentBlock, pubNodeRpc, PUBNODE_CHUNK);
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
  const tickLower = searchParams.get('tickLower') != null ? parseInt(searchParams.get('tickLower')!, 10) : null;
  const tickUpper = searchParams.get('tickUpper') != null ? parseInt(searchParams.get('tickUpper')!, 10) : null;
  const pool      = (searchParams.get('pool') ?? '').toLowerCase();

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

      return [{ type, txHash: log.transactionHash, blockNumber: blockNum, timestamp, amount0Raw, amount1Raw }];
    });

    // When Collect and DecreaseLiquidity share a tx, Collect includes the
    // withdrawn amounts. Subtract so only actual fees remain.
    const decreaseByTx = new Map<string, { a0: bigint; a1: bigint }>();
    for (const ev of rawEvents) {
      if (ev.type === 'withdrawal') {
        const prev = decreaseByTx.get(ev.txHash);
        decreaseByTx.set(ev.txHash, { a0: (prev?.a0 ?? 0n) + ev.amount0Raw, a1: (prev?.a1 ?? 0n) + ev.amount1Raw });
      }
    }
    for (const ev of rawEvents) {
      if (ev.type === 'fee_claim') {
        const dec = decreaseByTx.get(ev.txHash);
        if (dec) {
          ev.amount0Raw = ev.amount0Raw > dec.a0 ? ev.amount0Raw - dec.a0 : 0n;
          ev.amount1Raw = ev.amount1Raw > dec.a1 ? ev.amount1Raw - dec.a1 : 0n;
        }
      }
    }

    // Drop zero-amount fee_claim artifacts (both amounts clamped to 0 by the
    // Decrease-subtraction pass when a close tx had Collect emitting the same
    // amounts the user withdrew). Contributes $0 but inflates the claim count.
    const cleanRawEvents = rawEvents.filter(
      (ev) => !(ev.type === 'fee_claim' && ev.amount0Raw === 0n && ev.amount1Raw === 0n),
    );

    for (const ev of cleanRawEvents) {
      if (ev.type === 'deposit')    { deposited0 += ev.amount0Raw; deposited1 += ev.amount1Raw; }
      if (ev.type === 'withdrawal') { withdrawn0 += ev.amount0Raw; withdrawn1 += ev.amount1Raw; }
      if (ev.type === 'fee_claim')  { fees0 += ev.amount0Raw;      fees1 += ev.amount1Raw;      }
    }

    // Sort chronologically for cumulative fee calculation
    cleanRawEvents.sort((a, b) => a.blockNumber - b.blockNumber);

    const stablecoins = STABLECOINS_BY_CHAIN[chain] ?? new Set<string>();
    const cgIds = CG_IDS_BY_CHAIN[chain] ?? {};
    const tenderlyRpc = TENDERLY_RPCS[chain];

    // Pre-warm CoinGecko historical daily prices for every fee_claim day, for
    // any non-stablecoin token mapped in cgIds. Fee claims must be valued at
    // the market price on the day of the claim, not the pool's internal
    // sqrtPriceX96 ratio. Stablecoins anchor at $1 (no fetch).
    {
      const feeTimestamps = cleanRawEvents
        .filter((e) => e.type === 'fee_claim' && e.timestamp > 0)
        .map((e) => e.timestamp);
      if (feeTimestamps.length > 0) {
        const cg0 = !stablecoins.has(token0) ? cgIds[token0] : undefined;
        const cg1 = !stablecoins.has(token1) ? cgIds[token1] : undefined;
        const pairs: Array<{ coingeckoId: string; timestamps: number[] }> = [];
        if (cg0) pairs.push({ coingeckoId: cg0, timestamps: feeTimestamps });
        if (cg1) pairs.push({ coingeckoId: cg1, timestamps: feeTimestamps });
        if (pairs.length > 0) await prewarmTokenPrices(pairs);
      }
    }

    // Resolve pool's sqrtPriceX96 at EVERY unique event block (deposits +
    // withdrawals + fee claims) — that gives the exact token0/token1
    // prices at the moment of each event. Especially important for
    // single-sided withdrawals where deriveDepositPrices's tick-boundary
    // estimate is wildly wrong (e.g. "0 token0 + N token1" balloons to
    // amount1 × tick-estimated-price-of-0 instead of amount1 × $1).
    const allBlocks = cleanRawEvents.map((e) => e.blockNumber);
    const histPrices = pool && allBlocks.length > 0 && tenderlyRpc
      ? await (async () => {
          const resolver = createHistoricalFeePriceResolver({
            rpc: tenderlyRpc, pool, token0, token1,
            decimals0: t0d, decimals1: t1d, stablecoins,
          });
          try { return await resolver.resolveMany(allBlocks); }
          catch (err) { console.error('[uniswap/activity] hist price resolve failed:', err); return null; }
        })()
      : null;

    const hasTicks = tickLower != null && tickUpper != null;
    let runningFeeUSD = 0;
    const events: ActivityEvent[] = cleanRawEvents.map((ev) => {
      const amount0 = Number(ev.amount0Raw) / Number(scale0);
      const amount1 = Number(ev.amount1Raw) / Number(scale1);

      let price0AtTime: number | null = null;
      let price1AtTime: number | null = null;
      let usdAtTime: number | null = null;

      // For deposits/withdrawals, try historical sqrtPrice at the block
      // FIRST. Only fall back to deriveDepositPrices's tick estimate when
      // the resolver has no entry for this block.
      if (ev.type === 'deposit' || ev.type === 'withdrawal') {
        if (histPrices) {
          const hex = '0x' + ev.blockNumber.toString(16);
          const hp = histPrices.get(hex);
          if (hp) {
            price0AtTime = hp.price0Usd;
            price1AtTime = hp.price1Usd;
            usdAtTime = amount0 * hp.price0Usd + amount1 * hp.price1Usd;
          }
        }
        if (usdAtTime == null && hasTicks) {
          const derived = deriveDepositPrices(
            amount0, amount1, tickLower!, tickUpper!, t0d, t1d,
            token0, token1, stablecoins,
          );
          if (derived) {
            price0AtTime = derived.price0;
            price1AtTime = derived.price1;
            usdAtTime = amount0 * derived.price0 + amount1 * derived.price1;
          }
        }
      }

      // Fee claims: prefer CoinGecko historical daily market price (actual
      // value at conversion time). A side counts as priced when it's a
      // stablecoin ($1) OR a CG id resolved.
      if (ev.type === 'fee_claim') {
        const isStable0 = stablecoins.has(token0);
        const isStable1 = stablecoins.has(token1);
        const cg0 = !isStable0 ? cgIds[token0] : undefined;
        const cg1 = !isStable1 ? cgIds[token1] : undefined;
        const p0 = isStable0 ? 1 : (cg0 ? getCachedTokenPriceForTimestamp(cg0, ev.timestamp) : null);
        const p1 = isStable1 ? 1 : (cg1 ? getCachedTokenPriceForTimestamp(cg1, ev.timestamp) : null);
        if (p0 != null && p1 != null) {
          price0AtTime = p0;
          price1AtTime = p1;
          usdAtTime = amount0 * p0 + amount1 * p1;
        }
      }

      // Fallback: pool sqrtPriceX96 at the claim block (used when CG had no
      // entry for that day, e.g. token unmapped or date predates CG listing).
      if (ev.type === 'fee_claim' && usdAtTime == null && histPrices) {
        const hex = '0x' + ev.blockNumber.toString(16);
        const hp = histPrices.get(hex);
        if (hp) {
          price0AtTime = hp.price0Usd;
          price1AtTime = hp.price1Usd;
          usdAtTime = amount0 * hp.price0Usd + amount1 * hp.price1Usd;
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
