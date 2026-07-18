import { NextResponse } from 'next/server';
import { withActivityRouteCache } from '../../../lib/activityRouteCache';
import { deriveDepositPrices } from '../../../lib/v3PriceDerivation';
import { createHistoricalFeePriceResolver } from '../../../lib/v3HistoricalFeePrice';
import { prewarmTokenPrices, getCachedOnlyTokenPrice } from '../../../lib/cgPriceHistory';
import { prewarmDefillamaPrices, getCachedOnlyDefillamaPrice } from '../../../lib/defillamaPriceHistory';
import { redisCacheSnapshot } from '../../../lib/redisPriceCache';
import { fetchCachedCoinGeckoPrices } from '../../../lib/priceCache';
import { logPrice } from '../../../lib/priceLogger';
import { getEverOwnedTokenIds } from '../../../lib/evmEverOwnedNftIds';
import { evmRpcPost, isEvmRpcThrottle } from '../../../lib/evmRpc';
import { rpcUrlFromEnv } from '../../../lib/rpcEnv';

const ALCHEMY_KEY = process.env.NEXT_PUBLIC_ALCHEMY_KEY;
// Alchemy used only for eth_getBlockByNumber / eth_blockNumber — free tier supports this
const ALCHEMY_RPC = `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`;
// Tenderly — primary for eth_getLogs: supports full-history scans with no block-range limit, fast.
// The PUBLIC gateway hard-throttles concurrent getLogs per IP (403 on Vercel's
// shared IP — 2026-07-18 live repro). Set TENDERLY_NODE_RPC (keyed Tenderly Node
// URL, free tier) in env for a private quota; the public gateway stays as the
// zero-config fallback. Read via rpcUrlFromEnv so a malformed value (bare key)
// degrades to the public gateway instead of throwing on URL parse.
const TENDERLY_RPC = rpcUrlFromEnv('TENDERLY_NODE_RPC') || 'https://base.gateway.tenderly.co';
// LlamaRPC — secondary: now enforces 30k block range limit (code -32012)
const LLAMA_RPC = 'https://base.llamarpc.com';
// publicnode — tertiary fallback with chunked scanning; ~8s/request for historical blocks
const PUBLIC_NODE_RPC = 'https://base-rpc.publicnode.com';

// Aerodrome Slipstream (CL) NonfungiblePositionManager on Base
// Verified: factory() returns 0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A (matches CL_FACTORY)
const NFT_MANAGER = '0x827922686190790b37229fd06084350E74485b72';

// Aerodrome CL NFT manager deployed at ~Base block 13,844,000 (April 2024)
const DEPLOY_BLOCK = 13_844_000;

// Known stablecoins on Base (lowercase)
const STABLECOINS = new Set([
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC
  '0x50c5725949a6f0c72e6c4a641f24049a917db0cb', // DAI
  '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca', // USDbC
]);

// CoinGecko historical-daily-price IDs for non-stablecoin tokens on Base.
// Drives fee_claim usdAtTime so claims are valued at market price on the day
// of the claim instead of the pool's internal sqrtPriceX96 ratio. Stablecoins
// anchor at $1; tokens unmapped here fall through to the sqrtPrice resolver.
const CG_IDS: Record<string, string> = {
  '0x4200000000000000000000000000000000000006': 'ethereum',         // WETH on Base
  '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf': 'coinbase-wrapped-btc', // cbBTC
  '0x940181a94a35a4569e4529a3cdfb74e38fd98631': 'aerodrome-finance',    // AERO
};

// Chunk sizes: LlamaRPC just under its 30k limit; publicnode supports up to 49k
const LLAMA_CHUNK   = 29_000;
const PUBNODE_CHUNK = 49_000;
// Concurrency limits per RPC — publicnode rate-limits aggressively at high concurrency
const LLAMA_CONCURRENCY   = 10;
const PUBNODE_CONCURRENCY =  5;
// Sprint SPOT-RESILIENCE-V2: Tenderly has no documented block-range limit and
// serves single-tokenId chunks in 0.3–0.7 s, so a hung full-range call falls
// into a LARGE-chunk paced Tenderly scan (each call is small + independently
// timed via evmRpcPost, so one slow chunk can't block the whole scan). This is
// the reliable path now that Llama (521) and publicnode (403) have rotted.
const TENDERLY_CHUNK       = 500_000;
// 2 (was 8): the public Tenderly gateway tolerates only ~1-2 concurrent getLogs
// per IP before 403/429-throttling (2026-07-18 live measurement: serial calls
// 0.3-0.7 s each, 15-concurrent burst = 1×429 + 14 dropped). evmRpcPost now
// backoff-retries throttle responses, so 2 keeps chunks fast AND under the
// limit. Rule 6: conservative parameters accommodate the most-constrained
// endpoint. (Still additionally capped by evmRpc's global semaphore of 6.)
const TENDERLY_CONCURRENCY = 2;

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
  // On-chain log index of the source event. The analytics Fee Income dedup
  // keys on (protocol, txHash, logIndex) so the SAME Collect seen by BOTH the
  // per-position scan (accurate per-pair pricing) and the wallet-scope
  // positionId=all safety-net scan (single representative context) collapses
  // to ONE entry — and the per-position value wins (it's pushed first).
  logIndex: number;
}

interface ActivityResponse {
  events: ActivityEvent[];
  netInvested0: number;   // sum(deposits) - sum(withdrawals), decimal-adjusted
  netInvested1: number;
  totalFees0: number;     // sum of all Collect events, decimal-adjusted
  totalFees1: number;
}

// Sprint SPOT-RESILIENCE-V2: every EVM RPC call now goes through the shared
// paced + per-call-timed transport (app/lib/evmRpc.ts). A hung endpoint (the
// reproduced Tenderly failure) aborts at 12 s and surfaces as an `{ error }`
// envelope — identical shape to a normal RPC error — so the tier ladder in
// fetchLogs fails over instead of blocking until the client's 150 s abort.
async function rpcPost(url: string, body: object): Promise<unknown> {
  return evmRpcPost(url, body);
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

  // Tier 1: Tenderly (full-range, no limits, fast) — now 12 s-timed via
  // evmRpcPost so a hang aborts fast into the chunked fallback below.
  const tenderlyAttempt = await rpcPost(TENDERLY_RPC, {
    jsonrpc: '2.0', method: 'eth_getLogs', params: [logsParams], id: 1,
  }) as { result?: RawLog[]; error?: { message: string; code?: number } };

  if (!tenderlyAttempt.error) {
    return tenderlyAttempt.result ?? [];
  }
  console.warn('[aerodrome/activity] Tenderly full-range error:', (tenderlyAttempt.error as unknown as {code?:number}).code, tenderlyAttempt.error.message);

  // Tier 1b (Sprint SPOT-RESILIENCE-V2): Tenderly CHUNKED. The full-range call
  // above hangs under concurrent load, but Tenderly serves small chunks in
  // 0.3–0.7 s and each chunk is independently 12 s-timed + paced (evmRpcPost),
  // so one slow chunk can't block the scan. This is the reliable primary path
  // now that Llama (521) and publicnode (403) are dead; those remain below as a
  // last-ditch and simply fail fast behind the timeout if still down.
  try {
    const chunked = await fetchLogsChunked(tokenIdHex, startBlock, currentBlock, TENDERLY_RPC, TENDERLY_CHUNK, TENDERLY_CONCURRENCY);
    return chunked;
  } catch (tenderlyChunkErr) {
    console.warn('[aerodrome/activity] Tenderly chunked also failing, trying legacy fallbacks:', String(tenderlyChunkErr));
  }

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
  // Per-IP throttles (403/429) and HTTP-level failures are transient transport
  // states, not authoritative "no data" — fall through to the remaining tiers
  // instead of the terminal throw (which surfaced as a route 500 → position
  // degraded client-side even though publicnode was never tried).
  const isUnreachable = llamaCode === -32603 || llamaMsg.toLowerCase().includes('unreachable')
    || isEvmRpcThrottle(llamaMsg) || llamaMsg.startsWith('evm-rpc-http-') || llamaMsg === 'evm-rpc-timeout' || llamaMsg === 'evm-rpc-network-error';

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


function decodeWord(data: string, wordIndex: number): bigint {
  const start = wordIndex * 64;
  const word = data.slice(start, start + 64);
  if (!word || word.length < 64) return 0n;
  return BigInt('0x' + word);
}

export const GET = withActivityRouteCache(GET_impl);

async function GET_impl(request: Request) {
  // Sprint 1.6: baseline for this invocation's Redis hit/miss delta (the
  // counters are process-wide; the route_summary emission below subtracts this).
  const __redisBaseline = redisCacheSnapshot();
  const { searchParams } = new URL(request.url);
  const positionId = searchParams.get('positionId');   // numeric NFT tokenId string
  const t0d = parseInt(searchParams.get('t0d') ?? '18', 10);
  const t1d = parseInt(searchParams.get('t1d') ?? '18', 10);
  const token0 = (searchParams.get('token0') ?? '').toLowerCase();
  const token1 = (searchParams.get('token1') ?? '').toLowerCase();
  const fallback0 = parseFloat(searchParams.get('p0') ?? '0');
  const fallback1 = parseFloat(searchParams.get('p1') ?? '0');
  const tickLower = searchParams.get('tickLower') != null ? parseInt(searchParams.get('tickLower')!, 10) : null;
  const tickUpper = searchParams.get('tickUpper') != null ? parseInt(searchParams.get('tickUpper')!, 10) : null;
  const pool = (searchParams.get('pool') ?? '').toLowerCase();
  // Wallet-scope mode: positionId=all + account scans EVERY tokenId this wallet
  // ever owned (incl. burned/closed positions Sugar can no longer return) and
  // unions their Collect/Increase/Decrease events. Mirrors the Cetus/Bluefin
  // positionId=all pattern. Per-tokenId mode (numeric positionId) is unchanged.
  const account = (searchParams.get('account') ?? '').toLowerCase();
  const walletScope = positionId === 'all';

  if (!positionId) {
    return NextResponse.json({ error: 'positionId required' }, { status: 400 });
  }
  if (walletScope && !account) {
    return NextResponse.json({ error: 'account required for positionId=all' }, { status: 400 });
  }
  if (!ALCHEMY_KEY) {
    return NextResponse.json({ error: 'Alchemy key not configured' }, { status: 500 });
  }

  try {
    let logs: RawLog[];
    if (walletScope) {
      // Enumerate every tokenId this wallet ever owned (Transfer→wallet logs),
      // then union each one's NFT-manager logs. Burned positions' Collect logs
      // persist on-chain indexed by tokenId, so this recovers fee claims Sugar
      // can no longer surface. Reuses the same per-tokenId fetchLogs (4-tier
      // RPC fallback) so no new RPC pattern is introduced.
      const ids = await getEverOwnedTokenIds(NFT_MANAGER, account, TENDERLY_RPC, DEPLOY_BLOCK);
      const groups = await Promise.all(
        ids.map((idStr) => {
          const big = BigInt(idStr);
          return fetchLogs('0x' + big.toString(16).padStart(64, '0'), Number(big));
        }),
      );
      logs = groups.flat();
      console.log(`[aerodrome/activity] positionId=all account=${account} → ${ids.length} tokenIds, ${logs.length} logs`);
    } else {
      // Pad tokenId to 32-byte hex topic
      const tokenIdBig = BigInt(positionId);
      const tokenIdNum = Number(tokenIdBig);
      const tokenIdHex = '0x' + tokenIdBig.toString(16).padStart(64, '0');
      logs = await fetchLogs(tokenIdHex, tokenIdNum);
      console.log(`[aerodrome/activity] tokenId=${positionId} tokenIdHex=${tokenIdHex} → ${logs.length} logs`);
    }

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

    let deposited0 = 0n, deposited1 = 0n;
    let withdrawn0 = 0n, withdrawn1 = 0n;
    let fees0 = 0n, fees1 = 0n;

    // Build events in log order (chronological) first to compute cumulative fees correctly
    interface RawEvent {
      type: ActivityEventType;
      txHash: string;
      logIndex: number;
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
      // On-chain log index — stable identifier for the analytics Fee Income
      // (protocol, txHash, logIndex) dedup so per-position + wallet-scope scans
      // of the same Collect collapse to one entry.
      const logIndex = log.logIndex ? parseInt(log.logIndex, 16) : 0;

      let type: ActivityEventType;
      let amount0Raw = 0n, amount1Raw = 0n;

      if (topic0 === TOPIC_INCREASE) {
        type = 'deposit';
        amount0Raw = decodeWord(data, 1);
        amount1Raw = decodeWord(data, 2);
      } else if (topic0 === TOPIC_DECREASE) {
        type = 'withdrawal';
        amount0Raw = decodeWord(data, 1);
        amount1Raw = decodeWord(data, 2);
      } else {
        type = 'fee_claim';
        amount0Raw = decodeWord(data, 1);
        amount1Raw = decodeWord(data, 2);
      }

      return { type, txHash: log.transactionHash, logIndex, blockNumber: blockNum, timestamp, amount0Raw, amount1Raw };
    });

    // When a Collect (fee_claim) and DecreaseLiquidity (withdrawal) share the
    // same transaction, the Collect amounts include the withdrawn liquidity.
    // Subtract the withdrawal amounts so only actual fees remain.
    const decreaseByTx = new Map<string, { a0: bigint; a1: bigint }>();
    for (const ev of rawEvents) {
      if (ev.type === 'withdrawal') {
        const prev = decreaseByTx.get(ev.txHash);
        const a0 = (prev?.a0 ?? 0n) + ev.amount0Raw;
        const a1 = (prev?.a1 ?? 0n) + ev.amount1Raw;
        decreaseByTx.set(ev.txHash, { a0, a1 });
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

    // Sort chronologically to compute cumulative fees (oldest first)
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
        // Fire-and-forget: never block the route response on CoinGecko. The
        // global CG queue serializes calls at 1.1s each, which on cold cache
        // for a position with 12 unique fee dates means ~13s of queueing —
        // and that's per ROUTE. Multiple routes loading in parallel can push
        // total wait past Vercel's 30s function timeout. Routes now respond
        // immediately with whatever CG dates are ALREADY cached; the warming
        // work continues in the background so the next request hits a
        // warmer cache. Cold-cache events fall through to histPrices
        // (sqrtPriceX96 archive) which is also accurate historical pricing.
        if (pairs.length > 0) void prewarmTokenPrices(pairs).catch(() => {});
      }
    }

    // Resolve the pool's historical sqrtPriceX96 for EVERY unique event
    // block (deposits + withdrawals + fee claims) — that gives the EXACT
    // token0/token1 prices at the moment each event was confirmed on-chain.
    // No CoinGecko, no averaging. Critical for single-sided withdrawals
    // (one amount is 0): deriveDepositPrices's tick-boundary estimate is
    // wildly wrong there; the historical sqrtPrice is correct.
    // (fee_claim events prefer the CoinGecko market-price path above; this
    // resolver is the fallback when CG has no entry for that day.)
    const allBlocks = cleanRawEvents.map((e) => e.blockNumber);
    const histPrices = pool && allBlocks.length > 0
      ? await (async () => {
          const resolver = createHistoricalFeePriceResolver({
            rpc: TENDERLY_RPC, pool, token0, token1,
            decimals0: t0d, decimals1: t1d, stablecoins: STABLECOINS,
          });
          try { return await resolver.resolveMany(allBlocks); }
          catch (err) { console.error('[aerodrome/activity] hist price resolve failed:', err); return null; }
        })()
      : null;

    // PART 1: guarantee a usable current-spot price for the fee_claim
    // fallback, even when the caller passed p0=0 or p1=0 (e.g. a token the
    // position route couldn't resolve). For any zero side that has a
    // CG_IDS entry, fetch current spot from CoinGecko's simple/price
    // endpoint. Stablecoins anchor at $1 unconditionally. If everything
    // fails, currentSpot stays at 0 and the final null→0 guard below
    // ensures the event surfaces in analytics with $0 contribution.
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

    // Sprint 2.1b: DeFiLlama claim-date historical is the SECONDARY fee-claim
    // source (after sqrtPriceX96 archive + CoinGecko historical) so a sqrtPrice
    // archive miss no longer falls to current spot (Rule 1a — the cg-spot
    // last resort below is REMOVED for fee claims). Prewarm ONLY the
    // (token, date) pairs that sqrtPriceX96 could NOT price, so the common
    // sqrtPrice-priced claim incurs zero DeFiLlama traffic. Non-stable sides
    // only (stablecoins anchor at $1). Awaited so getCachedOnlyDefillamaPrice()
    // reads synchronously in the events.map below. Mirrors the Sprint 1.15
    // Cetus historical-only cascade.
    {
      const dlNeed = new Map<string, Set<number>>();
      for (const ev of cleanRawEvents) {
        if (ev.type !== 'fee_claim' || ev.timestamp <= 0) continue;
        if (histPrices?.get('0x' + ev.blockNumber.toString(16))) continue; // sqrtPriceX96 prices it
        for (const tok of [token0, token1]) {
          if (tok && !STABLECOINS.has(tok)) {
            if (!dlNeed.has(tok)) dlNeed.set(tok, new Set());
            dlNeed.get(tok)!.add(ev.timestamp);
          }
        }
      }
      if (dlNeed.size > 0) {
        await prewarmDefillamaPrices(
          [...dlNeed.entries()].map(([contract, tss]) => ({ chain: 'base' as const, contract, timestamps: [...tss] })),
        );
      }
    }

    let runningFeeUSD = 0;
    const hasTicks = tickLower != null && tickUpper != null;
    // [PRICE_LOG] instrumentation (additive only) — per-request fee_claim counters
    const __route = 'aerodrome';
    const __posId = positionId ?? '';
    const __srcBreakdown: Record<string, number> = {};
    const __failures: Array<{ token: string; blockTimestamp: number; reason: string }> = [];
    let __totalClaims = 0, __resolvedClaims = 0, __failedClaims = 0, __totalLookups = 0;
    const events: ActivityEvent[] = cleanRawEvents.map((ev) => {
      const amount0 = Number(ev.amount0Raw) / Number(scale0);
      const amount1 = Number(ev.amount1Raw) / Number(scale1);

      let price0AtTime: number | null = null;
      let price1AtTime: number | null = null;
      let usdAtTime: number | null = null;
      // Sprint 2.1b: which historical source priced a fee claim (read by the
      // [PRICE_LOG] re-derivation below). NEVER cg-spot — fee claims are
      // historical-only (Rule 1a).
      let __feeUsedCg = false;
      let __feeUsedDl = false;

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

      // Fee claims — PRIORITY 1: pool sqrtPriceX96 at the claim block via
      // Tenderly archive. This is the ORIGINAL working path (pre-commit
      // 0a8b12e) and is synchronously resolved above before the events.map
      // begins. It gives accurate per-block pool-internal pricing that's
      // within a few % of market price for high-TVL pools. Always runs
      // first because it never depends on a cache being warm.
      if (ev.type === 'fee_claim' && histPrices) {
        const hex = '0x' + ev.blockNumber.toString(16);
        const hp = histPrices.get(hex);
        if (hp) {
          price0AtTime = hp.price0Usd;
          price1AtTime = hp.price1Usd;
          usdAtTime = amount0 * hp.price0Usd + amount1 * hp.price1Usd;
        }
      }

      // Fee claims — PRIORITY 2: claim-date historical, PER SIDE (Rule 1a —
      // NEVER current spot). Skipped when PRIORITY 1 (sqrtPriceX96 archive)
      // already priced this claim. Per side: stablecoin → $1; else CoinGecko
      // historical (cache-only — the fire-and-forget prewarm above populates
      // it) THEN DeFiLlama historical-by-contract (Sprint 1.12 helper,
      // awaited-prewarmed above for sqrtPrice-missed claims). If a side cannot
      // be priced historically the claim stays UNRESOLVED (null) and surfaces
      // as "pending price resolution" — the prior cg-spot last resort is
      // REMOVED (Sprint 2.1b). Mirrors the Sprint 1.15 Cetus cascade.
      if (ev.type === 'fee_claim' && usdAtTime == null) {
        const isStable0 = STABLECOINS.has(token0);
        const isStable1 = STABLECOINS.has(token1);
        const cg0 = !isStable0 ? CG_IDS[token0] : undefined;
        const cg1 = !isStable1 ? CG_IDS[token1] : undefined;
        const priceSide = (tok: string, isStable: boolean, cgId: string | undefined): number | null => {
          if (isStable) return 1;
          const cg = cgId ? getCachedOnlyTokenPrice(cgId, ev.timestamp) : null;
          if (cg != null) { __feeUsedCg = true; return cg; }
          const dl = tok ? getCachedOnlyDefillamaPrice('base', tok, ev.timestamp) : null;
          if (dl != null) { __feeUsedDl = true; return dl; }
          return null;
        };
        const p0 = priceSide(token0, isStable0, cg0);
        const p1 = priceSide(token1, isStable1, cg1);
        if (p0 != null && p1 != null) {
          price0AtTime = p0;
          price1AtTime = p1;
          usdAtTime = amount0 * p0 + amount1 * p1;
        }
        // else: usdAtTime stays null → pending (Rule 1a — no spot fallback).
      }

      // Deposits / withdrawals ONLY: current-spot last resort when on-chain
      // historical derivation (sqrtPriceX96 / deriveDepositPrices) was
      // unavailable. Allowed by pricing-invariants Rule 2 (a point-in-time
      // position value, NOT historical earnings). Fee claims are handled above
      // and NEVER fall to spot (Rule 1a). currentSpot0/1 was promoted above
      // from caller fallback / a fresh CG simple-price lookup / stablecoin $1.
      if (usdAtTime == null && ev.type !== 'fee_claim') {
        price0AtTime = currentSpot0 || null;
        price1AtTime = currentSpot1 || null;
        if (currentSpot0 > 0 || currentSpot1 > 0) {
          usdAtTime = amount0 * currentSpot0 + amount1 * currentSpot1;
        }
      }

      let cumulativeFeeUSD = 0;
      if (ev.type === 'fee_claim') {
        runningFeeUSD += usdAtTime ?? 0;
        cumulativeFeeUSD = runningFeeUSD;
      }

      // [PRICE_LOG] fee_claim resolution — source reflects the historical-only
      // cascade flags set during pricing above. NEVER cg-spot (Rule 1a: fee
      // claims are historical-only; the spot last resort was removed Sprint 2.1b).
      if (ev.type === 'fee_claim') {
        const __hex = '0x' + ev.blockNumber.toString(16);
        let __src: string;
        if (histPrices && histPrices.get(__hex)) __src = 'sqrtPriceX96';
        else if (__feeUsedDl) __src = 'defillama-historical';
        else if (__feeUsedCg) __src = 'cg-historical-cache';
        else if (usdAtTime != null && usdAtTime > 0) __src = 'stablecoin-fixed'; // both sides stable → $1
        else __src = 'unknown'; // pending — no historical price on any source
        __totalClaims++; __totalLookups++;
        __srcBreakdown[__src] = (__srcBreakdown[__src] ?? 0) + 1;
        const __ok = usdAtTime != null && usdAtTime > 0;
        if (__ok) __resolvedClaims++;
        else { __failedClaims++; __failures.push({ token: `${token0}/${token1}`, blockTimestamp: ev.timestamp, reason: __src === 'unknown' ? 'no_price_any_source' : 'zero_usd' }); }
        logPrice({
          event: 'fee_claim_resolution',
          route: __route,
          positionId: __posId,
          blockTimestamp: ev.timestamp,
          token0: { symbol: token0, address: token0, amount: String(amount0) },
          token1: { symbol: token1, address: token1, amount: String(amount1) },
          token0Usd: price0AtTime,
          token1Usd: price1AtTime,
          usdAtTime,
          status: (usdAtTime == null || usdAtTime === 0) ? 'failed_null_usdAtTime' : ((price0AtTime != null && price1AtTime != null) ? 'ok' : 'partial'),
          notes: `source=${__src}`,
        });
      }
      return {
        type: ev.type,
        txHash: ev.txHash,
        logIndex: ev.logIndex,
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

    // [PRICE_LOG] route_summary — aggregate of this request's fee_claim pricing
    const __redisNow = redisCacheSnapshot();
    logPrice({
      event: 'route_summary',
      route: __route,
      wallet: '',
      totalClaims: __totalClaims,
      resolvedClaims: __resolvedClaims,
      failedClaims: __failedClaims,
      totalLookups: __totalLookups,
      sourceBreakdown: __srcBreakdown,
      failures: __failures,
      // Sprint 1.6 persistent-cache hit/miss for this invocation (snapshot
      // delta vs handler-entry baseline; approximate under concurrent load).
      redis_cache_hits: __redisNow.hits - __redisBaseline.hits,
      redis_cache_misses: __redisNow.misses - __redisBaseline.misses,
    });

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
