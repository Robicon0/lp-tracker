import { NextResponse } from 'next/server';
import { deriveDepositPrices } from '../../../lib/v3PriceDerivation';
import { createHistoricalFeePriceResolver } from '../../../lib/v3HistoricalFeePrice';
import { prewarmTokenPrices, getCachedOnlyTokenPrice } from '../../../lib/cgPriceHistory';
import { fetchCachedCoinGeckoPrices } from '../../../lib/priceCache';

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

// Known BNB Chain stablecoins (lowercase)
const STABLECOINS = new Set([
  '0x55d398326f99059ff775485246999027b3197955', // USDT
  '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', // USDC
  '0xe9e7cea3dedca5984780bafc599bd69add087d56', // BUSD
  '0x1af3f329e8be154074d8769d1ffa4ee058b1dbc3', // DAI
]);

// CoinGecko historical-daily-price IDs for non-stablecoin tokens on BNB Chain.
// Drives fee_claim usdAtTime so claims are valued at market price on the day
// of the claim instead of the pool's internal sqrtPriceX96 ratio. Tokens
// unmapped here fall through to the sqrtPrice resolver.
const CG_IDS: Record<string, string> = {
  '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c': 'binancecoin',  // WBNB
  '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c': 'bitcoin',      // BTCB (1:1 BTC)
  '0x2170ed0880ac9a755fd29b2688956bd959f933f8': 'ethereum',     // ETH on BSC
  '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82': 'pancakeswap-token', // CAKE
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
  const tickLower = searchParams.get('tickLower') != null ? parseInt(searchParams.get('tickLower')!, 10) : null;
  const tickUpper = searchParams.get('tickUpper') != null ? parseInt(searchParams.get('tickUpper')!, 10) : null;
  const pool      = (searchParams.get('pool') ?? '').toLowerCase();

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

    cleanRawEvents.sort((a, b) => a.blockNumber - b.blockNumber);

    // Pre-warm CoinGecko historical daily prices for every fee_claim day, for
    // any non-stablecoin token mapped in CG_IDS. Fee claims must be valued at
    // the market price on the day of the claim, not the pool's internal
    // sqrtPriceX96 ratio. Stablecoins anchor at $1 (no fetch).
    {
      const feeTimestamps = cleanRawEvents
        .filter((e) => e.type === 'fee_claim' && e.timestamp > 0)
        .map((e) => e.timestamp);
      if (feeTimestamps.length > 0) {
        const cg0 = !STABLECOINS.has(token0) ? CG_IDS[token0] : undefined;
        const cg1 = !STABLECOINS.has(token1) ? CG_IDS[token1] : undefined;
        const pairs: Array<{ coingeckoId: string; timestamps: number[] }> = [];
        if (cg0) pairs.push({ coingeckoId: cg0, timestamps: feeTimestamps });
        if (cg1) pairs.push({ coingeckoId: cg1, timestamps: feeTimestamps });
        // Fire-and-forget — never block the route on CoinGecko. See the
        // detailed rationale in app/api/aerodrome/activity/route.ts.
        if (pairs.length > 0) void prewarmTokenPrices(pairs).catch(() => {});
      }
    }

    // Resolve the pool's historical sqrtPriceX96 at EVERY unique event
    // block (deposits + withdrawals + fee claims) so each event's USD =
    // amount0*price0_at_block + amount1*price1_at_block. Critical for
    // single-sided withdrawals where deriveDepositPrices's tick estimate
    // is wildly wrong. (fee_claim events prefer the CoinGecko market-price
    // path above; this resolver is the fallback when CG has no entry.)
    const allBlocks = cleanRawEvents.map((e) => e.blockNumber);
    const histPrices = pool && allBlocks.length > 0
      ? await (async () => {
          const resolver = createHistoricalFeePriceResolver({
            rpc: PUBLIC_NODE_RPC, pool, token0, token1,
            decimals0: t0d, decimals1: t1d, stablecoins: STABLECOINS,
          });
          try { return await resolver.resolveMany(allBlocks); }
          catch (err) { console.error('[pancakeswap/activity] hist price resolve failed:', err); return null; }
        })()
      : null;

    // PART 1: guarantee a usable current-spot price for the fee_claim
    // fallback, even when the caller passed p0=0 or p1=0. For any zero
    // side that has a CG_IDS entry, fetch current spot from CoinGecko's
    // simple/price endpoint. Stablecoins anchor at $1 unconditionally.
    let currentSpot0 = fallback0;
    let currentSpot1 = fallback1;
    {
      if (currentSpot0 === 0 && STABLECOINS.has(token0)) currentSpot0 = 1;
      if (currentSpot1 === 0 && STABLECOINS.has(token1)) currentSpot1 = 1;
      const cg0Spot = !STABLECOINS.has(token0) && currentSpot0 === 0 ? CG_IDS[token0] : undefined;
      const cg1Spot = !STABLECOINS.has(token1) && currentSpot1 === 0 ? CG_IDS[token1] : undefined;
      const idsNeeded: string[] = [];
      if (cg0Spot) idsNeeded.push(cg0Spot);
      if (cg1Spot) idsNeeded.push(cg1Spot);
      if (idsNeeded.length > 0) {
        try {
          const spots = await fetchCachedCoinGeckoPrices([...new Set(idsNeeded)]);
          if (cg0Spot && spots[cg0Spot] > 0) currentSpot0 = spots[cg0Spot];
          if (cg1Spot && spots[cg1Spot] > 0) currentSpot1 = spots[cg1Spot];
        } catch { /* coerced to 0 by final guard below */ }
      }
    }

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
            token0, token1, STABLECOINS,
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
        const isStable0 = STABLECOINS.has(token0);
        const isStable1 = STABLECOINS.has(token1);
        const cg0 = !isStable0 ? CG_IDS[token0] : undefined;
        const cg1 = !isStable1 ? CG_IDS[token1] : undefined;
        const p0 = isStable0 ? 1 : (cg0 ? getCachedOnlyTokenPrice(cg0, ev.timestamp) : null);
        const p1 = isStable1 ? 1 : (cg1 ? getCachedOnlyTokenPrice(cg1, ev.timestamp) : null);
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
        price0AtTime = currentSpot0 || null;
        price1AtTime = currentSpot1 || null;
        if (currentSpot0 > 0 || currentSpot1 > 0) {
          usdAtTime = amount0 * currentSpot0 + amount1 * currentSpot1;
        }
      }

      // PART 1 FINAL GUARANTEE: fee_claim usdAtTime must never be null —
      // analytics feeIncome push() drops null events and the protocol
      // disappears from "Fee Income By Protocol".
      if (ev.type === 'fee_claim' && usdAtTime == null) {
        usdAtTime = 0;
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
    console.error('[pancakeswap/activity] Unexpected error:', err);
    return NextResponse.json({ error: 'Failed to fetch activity', details: String(err) }, { status: 500 });
  }
}
