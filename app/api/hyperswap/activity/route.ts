import { NextResponse } from 'next/server';
import { deriveDepositPrices } from '../../../lib/v3PriceDerivation';
import { createHistoricalFeePriceResolver } from '../../../lib/v3HistoricalFeePrice';
import { prewarmTokenPrices, getCachedOnlyTokenPrice } from '../../../lib/cgPriceHistory';
import { fetchCachedCoinGeckoPrices } from '../../../lib/priceCache';

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
// Max concurrent eth_getLogs requests. Kept low (3) because the Chainstack
// free plan caps at 25 RPS — when several HyperEVM positions load at once
// each fires its own fetchLogsViaArchive, so a high per-position concurrency
// multiplied across positions blew past the limit ("exceeded the RPS limit").
const LOG_CONCURRENCY = 3;
// Delay between concurrent batches so simultaneous position fetches don't all
// hammer Chainstack at once and trip the shared RPS limit.
const ARCHIVE_BATCH_DELAY_MS = 200;

// Standard Uni V3 event topic0 hashes — same for all V3 forks
const TOPIC_INCREASE = '0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f';
const TOPIC_DECREASE = '0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4';
const TOPIC_COLLECT = '0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01';

// Known HyperEVM stablecoins (lowercase)
const STABLECOINS = new Set([
  '0xb88339cb7199b77e23db6e890353e22632ba630f', // USDC
  '0x24ac48bf01fd6cb1c3836d08b3edc70a9c4380ca', // USDC (alternate)
  '0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb', // USD₮0 (Tether USD on HyperEVM)
  '0x3061caa1ce7c018ce68eae5795b2086cfdb4e148', // USDC (third Circle-native contract)
]);

// CoinGecko historical-daily-price IDs for non-stablecoin tokens on HyperEVM.
// Drives fee_claim usdAtTime so claims are valued at market price on the day
// of the claim instead of the pool's internal sqrtPriceX96 ratio (which can
// drift from spot). Add new tokens here as they surface in user pairs.
const CG_IDS: Record<string, string> = {
  '0x5555555555555555555555555555555555555555': 'hyperliquid', // native HYPE
  '0xadcb2f358eae6492f61a5f87eb8893d09391d160': 'hyperliquid', // WHYPE
  '0xfd739d4e423301ce9385c1fb8850539d657c296d': 'hyperliquid', // kHYPE
  '0xbe6727b535545c67d5caa73dea54865b92cf7907': 'hyperliquid', // beHYPE (best-effort)
  '0x94e8396e0869c9f2200760af0621afd240e1cf38': 'hyperliquid', // wstHYPE
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

  // Fetch in parallel batches, with a small delay BETWEEN batches so that
  // simultaneous per-position fetches don't collectively exceed Chainstack's
  // shared RPS limit.
  const allLogs: RawLog[] = [];
  for (let i = 0; i < ranges.length; i += LOG_CONCURRENCY) {
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, ARCHIVE_BATCH_DELAY_MS));
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

    // Drop zero-amount fee_claim artifacts (both amounts clamped to 0 by the
    // Decrease-subtraction pass when a close tx had the position withdrawing
    // everything and Collect emitted the same amounts). They contribute $0
    // to totals but inflate the claim count — UI shows "23 claims" when only
    // 20 had real fees.
    const cleanRawEvents = rawEvents.filter(
      (ev) => !(ev.type === 'fee_claim' && ev.amount0Raw === 0n && ev.amount1Raw === 0n),
    );

    for (const ev of cleanRawEvents) {
      if (ev.type === 'deposit')    { deposited0 += ev.amount0Raw; deposited1 += ev.amount1Raw; }
      if (ev.type === 'withdrawal') { withdrawn0 += ev.amount0Raw; withdrawn1 += ev.amount1Raw; }
      if (ev.type === 'fee_claim')  { fees0 += ev.amount0Raw;      fees1 += ev.amount1Raw;      }
    }

    cleanRawEvents.sort((a, b) => a.blockNumber - b.blockNumber);

    // Pre-warm CoinGecko historical daily prices for every fee_claim's day,
    // for any non-stablecoin token mapped in CG_IDS. Fee claims must always
    // be valued at the market price on the day of the claim, not the pool's
    // internal sqrtPriceX96 ratio — those can differ meaningfully when the
    // pool's price diverges from spot. Stablecoins anchor at $1 (no fetch).
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

    // Resolve the pool's historical sqrtPriceX96 at EVERY unique event block
    // (deposits + withdrawals + fee claims) so each event's USD =
    // amount0*price0_at_block + amount1*price1_at_block — accurate for all
    // three event types. Especially important for single-sided withdrawals
    // (one amount is 0), where deriveDepositPrices's tick-boundary estimate
    // produces wildly wrong USD (e.g. a "0 HYPE + 8,129 USDC" withdrawal
    // can balloon to $8,129+ using tick estimates). The historical-block
    // sqrtPrice gives the exact pool price at the moment the event occurred.
    // (fee_claim events prefer the CoinGecko market-price path above; this
    // resolver is the fallback when CG has no entry for that day.)
    const allBlocks = cleanRawEvents.map((e) => e.blockNumber);
    // Public HyperEVM RPC cannot answer eth_call at old blocks — only current
    // state. Use the Chainstack archive RPC when configured so historical
    // sqrtPriceX96 lookups actually resolve; fall back to public RPC only when
    // the archive env var is unset (the resolver will return null for old
    // blocks in that case and callers fall through to current-price math).
    const archiveRpc = process.env.HYPEREVM_ARCHIVE_RPC || HYPEREVM_RPC;
    const histPrices = pool && allBlocks.length > 0
      ? await (async () => {
          const resolver = createHistoricalFeePriceResolver({
            rpc: archiveRpc, pool, token0, token1,
            decimals0: t0d, decimals1: t1d, stablecoins: STABLECOINS,
          });
          try { return await resolver.resolveMany(allBlocks); }
          catch (err) { console.error('[hyperswap/activity] hist price resolve failed:', err); return null; }
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
      // the resolver has no entry for this block (e.g. pool slot0() didn't
      // exist at that block or the call reverted).
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
      // the Chainstack archive resolver. Synchronously resolved, always runs
      // first, gives accurate per-block pool-internal pricing.
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
      // disappears from "Fee Income By Protocol".
      if (ev.type === 'fee_claim' && usdAtTime == null) {
        usdAtTime = 0;
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
