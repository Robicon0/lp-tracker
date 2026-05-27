import { NextResponse } from 'next/server';
import { deriveDepositPrices } from '../../../lib/v3PriceDerivation';
import { createHistoricalFeePriceResolver } from '../../../lib/v3HistoricalFeePrice';

// ── HyperEVM log source — 3-tier fallback chain ─────────────────────────────
// TIER 1 (PRIMARY): Etherscan V2 with chainid=999 — archive-backed full history.
//   Requires ETHERSCAN_API_KEY env var. Free tier: 5 req/sec, 100K/day.
//   Endpoint: https://api.etherscan.io/v2/api?chainid=999&module=logs&action=getLogs
// TIER 2 (FALLBACK): Chainstack nanoreth archive endpoint via
//   HYPEREVM_ARCHIVE_RPC — full history from block 0 (replaces the prior
//   DRPC endpoint, which only retained ~40h of history and silently dropped
//   deposits for older closed positions). Used when Etherscan is
//   unavailable, rate-limited, errors, or the key is not configured.
// TIER 3 (LAST RESORT): `buildFallbackPnL` in app/hooks/useLpPnl.ts —
//   synthesizes a PnL using current value as deposit estimate when both
//   tiers above return zero events. Lives at the consumer layer (not in
//   this route) because it needs `pos.value`, which the route doesn't see.

const ETHERSCAN_V2_URL = 'https://api.etherscan.io/v2/api';
const ETHERSCAN_CHAIN_ID = '999'; // HyperEVM Mainnet
const ETHERSCAN_TIMEOUT_MS = 10_000;

// Public HyperEVM RPC: used only for eth_getBlockByNumber (timestamps) — limits to 1000 blocks for eth_getLogs
const HYPEREVM_RPC = 'https://rpc.hyperliquid.xyz/evm';
// How many blocks to scan back from current block for activity history (~2.5 months at ~1.1s/block).
// Chainstack nanoreth archive handles full history; this cap bounds chunk fan-out.
const SCAN_DEPTH = 5_000_000;
// Archive RPC max block range per eth_getLogs request
const LOG_CHUNK = 10_000;
// Max concurrent eth_getLogs requests (avoid rate-limiting)
const LOG_CONCURRENCY = 20;

// Standard Uni V3 event topic0 hashes — same for all V3 forks
const TOPIC_INCREASE = '0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f';
const TOPIC_DECREASE = '0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4';
const TOPIC_COLLECT = '0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01';

// Known HyperEVM stablecoins (lowercase)
const STABLECOINS = new Set([
  '0xb88339cb7199b77e23db6e890353e22632ba630f', // USDC
  '0x24ac48bf01fd6cb1c3836d08b3edc70a9c4380ca', // USDC (alternate)
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

async function rpcCallHyperEVM(body: object): Promise<{ result?: unknown; error?: { message: string } }> {
  const res = await fetch(HYPEREVM_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function rpcCallArchive(body: object): Promise<{ result?: unknown; error?: { message: string } }> {
  const url = process.env.HYPEREVM_ARCHIVE_RPC;
  if (!url) {
    return { error: { message: 'HYPEREVM_ARCHIVE_RPC not configured' } };
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'lp-tracker/1.0',
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

// Fetch one 10k-block chunk of logs via the archive RPC.
// topic[0]=null (any V3 event), topic[1]=tokenIdHex (indexed)
async function fetchLogsChunk(nftManager: string, tokenIdHex: string, from: number, to: number): Promise<RawLog[]> {
  const result = await rpcCallArchive({
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
    console.error(`[hyperswap/activity] archive getLogs error ${from}-${to}:`, result.error.message);
    return [];
  }
  return (result.result as RawLog[]) ?? [];
}

// One Etherscan topic call — separated from the parent so each topic can be
// retried INDEPENDENTLY and a transient rate-limit on one topic doesn't tank
// the other two. Returns one of:
//   { ok: true, logs }        — got logs (possibly empty if "No records found")
//   { ok: false, reason }     — retryable failure (rate limit, timeout, etc.)
//   { ok: false, reason, invalidKey: true } — fatal (no point retrying)
async function fetchOneEtherscanTopic(
  nftManager: string,
  tokenIdHex: string,
  topic0: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<{ ok: true; logs: RawLog[] } | { ok: false; reason: string; invalidKey?: boolean }> {
  const u = new URL(ETHERSCAN_V2_URL);
  u.searchParams.set('chainid', ETHERSCAN_CHAIN_ID);
  u.searchParams.set('module', 'logs');
  u.searchParams.set('action', 'getLogs');
  u.searchParams.set('address', nftManager);
  u.searchParams.set('topic0', topic0);
  u.searchParams.set('topic1', tokenIdHex);
  u.searchParams.set('topic0_1_opr', 'and');
  u.searchParams.set('fromBlock', '0');
  u.searchParams.set('toBlock', 'latest');
  u.searchParams.set('apikey', apiKey);

  try {
    const res = await fetch(u.toString(), { signal });
    const json: { status?: string; message?: string; result?: unknown } = await res.json();
    if (json.status === '1') {
      return { ok: true, logs: Array.isArray(json.result) ? (json.result as RawLog[]) : [] };
    }
    // status === '0'
    const msg = String(json.message ?? '');
    if (msg.includes('No records')) return { ok: true, logs: [] }; // legitimate empty
    const resultStr = typeof json.result === 'string' ? json.result : '';
    const invalidKey = msg === 'NOTOK' && resultStr.toLowerCase().includes('invalid api key');
    return { ok: false, reason: resultStr || msg || 'unknown', invalidKey };
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    return { ok: false, reason: isAbort ? 'timeout' : 'fetch error' };
  }
}

// TIER 1: Etherscan V2 getLogs. One call per topic0 (Etherscan requires topic0
// in the query — there's no "any topic" wildcard). Each topic is fetched
// independently, retried ONCE after a 1s backoff on transient failure.
//
// **Per-topic criticality** — partial success is only safe for topics whose
// absence causes MISSING data (not WRONG data):
//   - IncreaseLiquidity (optional): if dropped, deposit history is missing.
//     computePositionPnL excludes the position but no fees are mis-valued.
//   - DecreaseLiquidity (REQUIRED): if dropped, the Collect-vs-Decrease tx
//     pairing in the parent route can't subtract withdrawal amounts from
//     Collect events, so Collect amounts in close txs leak into fee totals
//     (e.g. position 388173 fees inflated from $68 → $8,196 in testing).
//     Decrease failure forces full fallback to the archive RPC.
//   - Collect (optional): if dropped, fee_claim events are missing but no
//     other event is mis-valued.
//
// Returns null when:
//   - ETHERSCAN_API_KEY is unset (caller skips to archive RPC)
//   - Any topic returned the "Invalid API Key" signature (key is wrong —
//     retrying won't help, full archive RPC fallback is correct)
//   - DecreaseLiquidity topic still failed after retry (correctness gate)
//   - ALL THREE topics still failed after retry
// "No records found" comes back as status:"0" with that exact message — NOT
// treated as an error; just means this topic yielded no logs for this position.
async function fetchLogsViaEtherscan(
  nftManager: string,
  tokenIdHex: string,
): Promise<RawLog[] | null> {
  const apiKey = process.env.ETHERSCAN_API_KEY;
  if (!apiKey) {
    console.log('[hyperswap/activity] source=etherscan SKIP — ETHERSCAN_API_KEY not set, will use archive RPC');
    return null;
  }

  const topics = [TOPIC_INCREASE, TOPIC_DECREASE, TOPIC_COLLECT];
  const topicNames = ['IncreaseLiquidity', 'DecreaseLiquidity', 'Collect'];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ETHERSCAN_TIMEOUT_MS);

  try {
    // First pass — fire all 3 topic calls in parallel.
    const firstPass = await Promise.all(
      topics.map((topic) => fetchOneEtherscanTopic(nftManager, tokenIdHex, topic, apiKey, controller.signal)),
    );

    // If ANY first-pass call hit "Invalid API Key", abort the whole tier.
    // Retrying won't help — operator needs to fix .env.local / Vercel env.
    const invalidKey = firstPass.find((r) => !r.ok && r.invalidKey);
    if (invalidKey) {
      clearTimeout(timer);
      console.error(
        '[hyperswap/activity] source=etherscan INVALID_API_KEY — ETHERSCAN_API_KEY ' +
        'is rejected by Etherscan V2. Check for duplicate keys in .env.local (dotenv ' +
        'keeps the LAST definition) and on Vercel. Tier 2 archive RPC will run if ' +
        'HYPEREVM_ARCHIVE_RPC is configured.',
      );
      return null;
    }

    // Retry each failed topic ONCE after a 1s backoff. Etherscan's 5 req/sec
    // free-tier limit gets hit when analytics fetches multiple closed positions
    // in parallel (each position = 3 Etherscan calls). Without per-topic retry
    // a single rate-limited Collect call would discard the successful Increase
    // + Decrease results and waste the work.
    const final = await Promise.all(
      firstPass.map(async (r, i) => {
        if (r.ok) return r;
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return fetchOneEtherscanTopic(nftManager, tokenIdHex, topics[i], apiKey, controller.signal);
      }),
    );
    clearTimeout(timer);

    // Aggregate successful topics; log (but don't fail) the OPTIONAL topics
    // that still failed after retry. DecreaseLiquidity is REQUIRED because
    // the parent route relies on it to subtract withdrawal amounts from
    // Collect events in close txs — without it, Collect amounts in close
    // txs leak into fee totals (verified live: position 388173 fees went
    // from $68 → $8,196 when Decrease topic was rate-limited and dropped).
    // If Decrease failed, fall back to the archive RPC for the whole
    // position rather than emitting wrong fee numbers.
    const all: RawLog[] = [];
    let failed = 0;
    const DECREASE_IDX = 1; // topics array order: [INCREASE, DECREASE, COLLECT]
    let decreaseOk = false;
    for (let i = 0; i < final.length; i++) {
      const r = final[i];
      if (r.ok) {
        all.push(...r.logs);
        if (i === DECREASE_IDX) decreaseOk = true;
      } else {
        failed += 1;
        const note = i === DECREASE_IDX ? ' (REQUIRED — falling back to archive RPC for correctness)' : '';
        console.warn(
          `[hyperswap/activity] source=etherscan ${topicNames[i]} FAILED after retry: ${r.reason} — ` +
          `events from this topic missing for tokenId ${tokenIdHex}${note}`,
        );
      }
    }

    if (failed === 3) {
      console.warn('[hyperswap/activity] source=etherscan ALL_TOPICS_FAILED — falling back to archive RPC');
      return null;
    }
    if (!decreaseOk) {
      // Decrease is load-bearing for fee separation. Don't return partial logs
      // here — archive scan is more reliable for THIS position than wrong fees.
      return null;
    }

    console.log(
      `[hyperswap/activity] source=etherscan OK — ${all.length} logs for tokenId ${tokenIdHex} ` +
      `(${3 - failed}/3 topics succeeded)`,
    );
    return all;
  } catch (err) {
    clearTimeout(timer);
    const isAbort = err instanceof Error && err.name === 'AbortError';
    console.warn(`[hyperswap/activity] source=etherscan ${isAbort ? 'TIMEOUT' : 'THREW'} — falling back to archive RPC:`, err);
    return null;
  }
}

// TIER 2: Chainstack nanoreth archive eth_getLogs (via HYPEREVM_ARCHIVE_RPC),
// over the last SCAN_DEPTH blocks, chunked LOG_CHUNK at a time. HyperEVM
// public RPC caps at 1000 blocks per call; the archive endpoint allows 10k
// and has full history back to block 0 (unlike the prior DRPC endpoint,
// which only retained ~40h and silently dropped older closed positions).
async function fetchLogsViaArchive(nftManager: string, tokenIdHex: string): Promise<RawLog[]> {
  if (!process.env.HYPEREVM_ARCHIVE_RPC) {
    console.error('[hyperswap/activity] source=archive SKIP — HYPEREVM_ARCHIVE_RPC env var not set');
    return [];
  }

  // Get current block from the reliable public RPC
  const blockRes = await rpcCallHyperEVM({ jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 });
  const latestBlock = parseInt((blockRes.result as string) ?? '0x0', 16);
  if (!latestBlock) {
    console.error('[hyperswap/activity] source=archive Failed to get latest block number');
    return [];
  }

  const fromBlock = Math.max(0, latestBlock - SCAN_DEPTH);
  const ranges: [number, number][] = [];
  for (let b = fromBlock; b <= latestBlock; b += LOG_CHUNK) {
    ranges.push([b, Math.min(b + LOG_CHUNK - 1, latestBlock)]);
  }
  console.log(`[hyperswap/activity] source=archive scanning ${ranges.length} chunks (blocks ${fromBlock}–${latestBlock})`);

  // Fetch in parallel batches
  const allLogs: RawLog[] = [];
  for (let i = 0; i < ranges.length; i += LOG_CONCURRENCY) {
    const batch = ranges.slice(i, i + LOG_CONCURRENCY);
    const results = await Promise.all(
      batch.map(([f, t]) => fetchLogsChunk(nftManager, tokenIdHex, f, t))
    );
    allLogs.push(...results.flat());
  }

  console.log(`[hyperswap/activity] source=archive OK — ${allLogs.length} logs for tokenId ${tokenIdHex}`);
  return allLogs;
}

// Try Etherscan V2 first (archive-backed full history); fall back to the
// Chainstack archive RPC if Etherscan is rate-limited, times out, errors,
// or the API key isn't set.
async function fetchLogs(nftManager: string, tokenIdHex: string): Promise<RawLog[]> {
  const etherscanLogs = await fetchLogsViaEtherscan(nftManager, tokenIdHex);
  if (etherscanLogs !== null) return etherscanLogs;
  return fetchLogsViaArchive(nftManager, tokenIdHex);
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
  const tickLower = searchParams.get('tickLower') != null ? parseInt(searchParams.get('tickLower')!, 10) : null;
  const tickUpper = searchParams.get('tickUpper') != null ? parseInt(searchParams.get('tickUpper')!, 10) : null;
  const pool      = (searchParams.get('pool') ?? '').toLowerCase();

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

      // All three event types: word1=amount0, word2=amount1
      amount0Raw = decodeWord(data, 1);
      amount1Raw = decodeWord(data, 2);

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

    for (const ev of rawEvents) {
      if (ev.type === 'deposit')    { deposited0 += ev.amount0Raw; deposited1 += ev.amount1Raw; }
      if (ev.type === 'withdrawal') { withdrawn0 += ev.amount0Raw; withdrawn1 += ev.amount1Raw; }
      if (ev.type === 'fee_claim')  { fees0 += ev.amount0Raw;      fees1 += ev.amount1Raw;      }
    }

    rawEvents.sort((a, b) => a.blockNumber - b.blockNumber);

    // Resolve the pool's historical sqrtPriceX96 at each unique fee_claim
    // block so each claim's USD = amount0*price0_at_block + amount1*price1_at_block.
    const feeBlocks = rawEvents.filter((e) => e.type === 'fee_claim').map((e) => e.blockNumber);
    const histPrices = pool && feeBlocks.length > 0
      ? await (async () => {
          const resolver = createHistoricalFeePriceResolver({
            rpc: HYPEREVM_RPC, pool, token0, token1,
            decimals0: t0d, decimals1: t1d, stablecoins: STABLECOINS,
          });
          try { return await resolver.resolveMany(feeBlocks); }
          catch (err) { console.error('[hyperswap/activity] hist price resolve failed:', err); return null; }
        })()
      : null;

    const hasTicks = tickLower != null && tickUpper != null;
    let runningFeeUSD = 0;
    const events: ActivityEvent[] = rawEvents.map((ev) => {
      const amount0 = Number(ev.amount0Raw) / Number(scale0);
      const amount1 = Number(ev.amount1Raw) / Number(scale1);

      let price0AtTime: number | null = null;
      let price1AtTime: number | null = null;
      let usdAtTime: number | null = null;

      if ((ev.type === 'deposit' || ev.type === 'withdrawal') && hasTicks) {
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

      if (ev.type === 'fee_claim' && histPrices) {
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
