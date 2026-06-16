import { NextResponse } from 'next/server';
import { deriveDepositPrices } from '../../../lib/v3PriceDerivation';
import { createHistoricalFeePriceResolver } from '../../../lib/v3HistoricalFeePrice';
import { prewarmTokenPrices, getCachedOnlyTokenPrice } from '../../../lib/cgPriceHistory';
import { redisCacheSnapshot } from '../../../lib/redisPriceCache';
import { fetchCachedCoinGeckoPrices } from '../../../lib/priceCache';
import { logPrice } from '../../../lib/priceLogger';
import { getEverOwnedTokenIds } from '../../../lib/evmEverOwnedNftIds';

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

// CoinGecko historical-daily-price IDs for non-stablecoin tokens on Optimism.
// Drives fee_claim usdAtTime so claims are valued at market price on the day
// of the claim instead of the pool's internal sqrtPriceX96 ratio. Tokens
// unmapped here fall through to the sqrtPrice resolver.
const CG_IDS: Record<string, string> = {
  '0x4200000000000000000000000000000000000006': 'ethereum',           // WETH on OP
  '0x4200000000000000000000000000000000000042': 'optimism',           // OP token
  '0x9560e827af36c94d2ac33a39bce1fe78631088db': 'velodrome-finance',  // VELO
  '0x68f180fcce6836688e9084f035309e29bf0a2095': 'wrapped-bitcoin',    // WBTC on OP
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
  // Sprint 1.6: baseline for this invocation's Redis hit/miss delta (the
  // counters are process-wide; the route_summary emission below subtracts this).
  const __redisBaseline = redisCacheSnapshot();
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
  const pool       = (searchParams.get('pool') ?? '').toLowerCase();
  // Wallet-scope mode: positionId=all + account scans EVERY tokenId this wallet
  // ever owned (incl. burned/closed positions Sugar can no longer return) and
  // unions their Collect/Increase/Decrease events. Mirrors the Aerodrome
  // positionId=all pattern. Per-tokenId mode (numeric positionId) is unchanged.
  const account    = (searchParams.get('account') ?? '').toLowerCase();
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
        ids.map((idStr) => fetchLogs('0x' + BigInt(idStr).toString(16).padStart(64, '0'))),
      );
      logs = groups.flat();
      console.log(`[velodrome/activity] positionId=all account=${account} → ${ids.length} tokenIds, ${logs.length} logs`);
    } else {
      const tokenIdHex = '0x' + BigInt(positionId).toString(16).padStart(64, '0');
      logs = await fetchLogs(tokenIdHex);
    }

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

    // Resolve pool's historical sqrtPriceX96 at EVERY unique event block
    // (deposits + withdrawals + fee claims) so each event's USD =
    // amount0*price0_at_block + amount1*price1_at_block. Critical for
    // single-sided withdrawals where deriveDepositPrices's tick estimate
    // is wildly wrong. (fee_claim events prefer the CoinGecko market-price
    // path above; this resolver is the fallback when CG has no entry.)
    const allBlocks = cleanRawEvents.map((e) => e.blockNumber);
    const histPrices = pool && allBlocks.length > 0
      ? await (async () => {
          const resolver = createHistoricalFeePriceResolver({
            rpc: TENDERLY_RPC, pool, token0, token1,
            decimals0: t0d, decimals1: t1d, stablecoins: STABLECOINS,
          });
          try { return await resolver.resolveMany(allBlocks); }
          catch (err) { console.error('[velodrome/activity] hist price resolve failed:', err); return null; }
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
    // [PRICE_LOG] instrumentation (additive only) — per-request fee_claim counters
    const __route = 'velodrome';
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
      // Tenderly archive. Synchronously resolved, always runs first, gives
      // accurate per-block pool-internal pricing.
      if (ev.type === 'fee_claim' && histPrices) {
        const hex = '0x' + ev.blockNumber.toString(16);
        const hp = histPrices.get(hex);
        if (hp) {
          price0AtTime = hp.price0Usd;
          price1AtTime = hp.price1Usd;
          usdAtTime = amount0 * hp.price0Usd + amount1 * hp.price1Usd;
        }
      }

      // Fee claims — PRIORITY 2: CoinGecko historical market price (cache
      // hit only — never fetches). Refines sqrtPriceX96 with true market
      // price when available; fire-and-forget prewarm populates the cache.
      if (ev.type === 'fee_claim' && usdAtTime == null) {
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

      if (usdAtTime == null) {
        price0AtTime = currentSpot0 || null;
        price1AtTime = currentSpot1 || null;
        if (currentSpot0 > 0 || currentSpot1 > 0) {
          usdAtTime = amount0 * currentSpot0 + amount1 * currentSpot1;
        }
      }

      // PART 1 FINAL GUARANTEE: fee_claim usdAtTime must never be null —
      // analytics feeIncome push() drops null events and the protocol
      // disappears from "Fee Income By Protocol". Zero-amount artifacts
      // were already filtered (cleanRawEvents), so usdAtTime=0 here
      // means "non-zero amounts but no pricing anywhere".
      if (ev.type === 'fee_claim' && usdAtTime == null) {
        usdAtTime = 0;
      }

      let cumulativeFeeUSD = 0;
      if (ev.type === 'fee_claim') {
        runningFeeUSD += usdAtTime ?? 0;
        cumulativeFeeUSD = runningFeeUSD;
      }

      // [PRICE_LOG] fee_claim resolution — read-only re-derivation of the
      // winning price source, mirrors the ladder above without altering values.
      if (ev.type === 'fee_claim') {
        const __hex = '0x' + ev.blockNumber.toString(16);
        let __src: string;
        if (histPrices && histPrices.get(__hex)) {
          __src = 'sqrtPriceX96';
        } else {
          const __s0 = STABLECOINS.has(token0);
          const __s1 = STABLECOINS.has(token1);
          const __cg0 = !__s0 ? CG_IDS[token0] : undefined;
          const __cg1 = !__s1 ? CG_IDS[token1] : undefined;
          const __p0 = __s0 ? 1 : (__cg0 ? getCachedOnlyTokenPrice(__cg0, ev.timestamp) : null);
          const __p1 = __s1 ? 1 : (__cg1 ? getCachedOnlyTokenPrice(__cg1, ev.timestamp) : null);
          if (__p0 != null && __p1 != null) __src = (__s0 && __s1) ? 'stablecoin-fixed' : 'cg-historical-cache';
          else if (currentSpot0 > 0 || currentSpot1 > 0) __src = 'cg-spot';
          else __src = 'unknown';
        }
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
      return { type: ev.type, txHash: ev.txHash, blockNumber: ev.blockNumber, timestamp: ev.timestamp, amount0, amount1, usdAtTime, price0AtTime, price1AtTime, cumulativeFeeUSD };
    });

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
