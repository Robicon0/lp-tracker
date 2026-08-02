// EVM per-POSITION pool context — the EVM analogue of `suiPoolContext.ts`
// (Protocol Correctness Contract invariant (i)).
//
// ─────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS
//
// The wallet-scope closed-position scans (`positionId=all` / `tokenId=all`)
// enumerate EVERY tokenId a wallet ever owned and union their logs, then
// decoded every event with ONE representative pool's token decimals — chosen
// as "whichever position happens to be open". Amounts are raw integers, so
// applying the wrong decimals mis-scales by a power of ten:
//
//   • representative USDC/cbBTC (6/8) applied to an 18-dec WETH amount
//     → x10^12 INFLATION. Measured live: deposit events of
//       $342,298,111,238.86 and $167,113,757,805.22.
//   • representative WETH/USDC (18/6) applied to a 6-dec USDC amount
//     → x10^-12 CRUSHING. Measured live on Account 1: 14 fee claims under
//       $0.50 (the Sprint 2.1 "$0.21 vs a true $294" signature).
//
// Both directions are the SAME bug; which one you get depends on which pool
// is open. Crushing is the more dangerous of the two because the result looks
// plausible — no magnitude filter can catch it, and it silently UNDER-reports
// fees. That is why the pre-existing `<= $50M` artifact filter is not a fix:
// it only ever caught inflation.
//
// A wallet is affected only if it holds pools with DIFFERENT decimal pairs,
// which is why this survived so long — the common single-pair wallet cannot
// reproduce it.
//
// THE RULE: never decode an event with a pool context that is not that
// event's own. If a position's context cannot be resolved, EXCLUDE it and say
// so — a missing number is always better than a confidently wrong one
// (architecture Rule 11).
// ─────────────────────────────────────────────────────────────────────────
//
// Derivation (the pattern already proven in `buildClosedPositions`): a
// position's first IncreaseLiquidity log → that tx's receipt → the pool's own
// Mint log, whose `address` IS the pool → the pool's token0/token1 → decimals.
// Works for burned positions too, because logs outlive the NFT.
//
// Decimals come from `resolveToken` (architecture Rule 9), NOT a hardcoded
// map: the old path defaulted unknown tokens to 18, which is itself a
// mis-scaling for any long-tail token.

import { evmRpcPost } from './evmRpc';
import { resolveToken } from './tokenResolver';
import type { Chain } from './tokenConstants';

export interface EvmPositionContext {
  tokenId: string;
  pool: string;
  token0: string;
  token1: string;
  decimals0: number;
  decimals1: number;
  symbol0: string;
  symbol1: string;
}

// A position's pool and token pair are IMMUTABLE once minted, so this is
// cacheable indefinitely. Versioned because it stores a resolved result.
const KEY_PREFIX = 'evm_pos_ctx_v1:';
const TTL_SECONDS = 90 * 24 * 60 * 60;

// token0()/token1() selectors on the pool.
const SEL_TOKEN0 = '0x0dfe1681';
const SEL_TOKEN1 = '0xd21220a7';

let redis: { get: (k: string) => Promise<unknown>; set: (k: string, v: unknown, o: { ex: number }) => Promise<unknown> } | null = null;
try {
  const url = process.env.PRICE_CACHE_KV_REST_API_URL;
  const token = process.env.PRICE_CACHE_KV_REST_API_TOKEN;
  if (url && token) {
    // Lazy require so this module stays importable in environments without the
    // dep configured; same no-op-stub contract as redisSpotCache.
    const { Redis } = require('@upstash/redis') as typeof import('@upstash/redis');
    redis = new Redis({ url, token }) as unknown as typeof redis;
  }
} catch {
  redis = null;
}

const memCache = new Map<string, EvmPositionContext | null>();

async function rpcCall(rpc: string, to: string, data: string): Promise<string | null> {
  const res = await evmRpcPost(rpc, {
    jsonrpc: '2.0', id: 1, method: 'eth_call',
    params: [{ to, data }, 'latest'],
  });
  if (res.error || typeof res.result !== 'string') return null;
  return res.result;
}

const addrFromWord = (hex: string | null): string | null =>
  hex && hex.length >= 66 ? '0x' + hex.slice(-40).toLowerCase() : null;

/**
 * Resolve one position's own pool + token context.
 *
 * Returns null when it cannot be determined. Callers MUST treat null as
 * "exclude and surface", never as "fall back to some other pool's decimals".
 */
export async function resolveEvmPositionContext(opts: {
  chain: Chain;
  rpc: string;
  nftManager: string;
  tokenId: string;
  increaseTopic: string;
  poolMintTopic: string;
  deployBlock: number;
}): Promise<EvmPositionContext | null> {
  const { chain, rpc, nftManager, tokenId, increaseTopic, poolMintTopic, deployBlock } = opts;
  const cacheKey = `${KEY_PREFIX}${chain}:${nftManager.toLowerCase()}:${tokenId}`;

  if (memCache.has(cacheKey)) return memCache.get(cacheKey) ?? null;
  if (redis) {
    try {
      const hit = await redis.get(cacheKey);
      if (hit) {
        const parsed = (typeof hit === 'string' ? JSON.parse(hit) : hit) as EvmPositionContext;
        if (parsed?.pool && parsed?.token0) { memCache.set(cacheKey, parsed); return parsed; }
      }
    } catch { /* degrade to a live resolve */ }
  }

  try {
    const tokenIdHex = '0x' + BigInt(tokenId).toString(16).padStart(64, '0');

    // 1. The position's FIRST IncreaseLiquidity log (survives a burned NFT).
    const logsRes = await evmRpcPost(rpc, {
      jsonrpc: '2.0', id: 1, method: 'eth_getLogs',
      params: [{
        address: nftManager,
        topics: [increaseTopic, tokenIdHex],
        fromBlock: '0x' + deployBlock.toString(16),
        toBlock: 'latest',
      }],
    });
    const logs = (logsRes.result as Array<{ transactionHash: string; blockNumber: string }> | undefined) ?? [];
    if (logsRes.error || logs.length === 0) return cacheAndReturn(cacheKey, null);
    logs.sort((a, b) => parseInt(a.blockNumber, 16) - parseInt(b.blockNumber, 16));

    // 2. That tx's receipt → the POOL's own Mint log; its `address` is the pool.
    const rcptRes = await evmRpcPost(rpc, {
      jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt',
      params: [logs[0].transactionHash],
    });
    const rcpt = rcptRes.result as { logs?: Array<{ address: string; topics: string[] }> } | undefined;
    const mintLog = rcpt?.logs?.find(
      (l) => l.topics?.[0]?.toLowerCase() === poolMintTopic.toLowerCase()
        && l.address.toLowerCase() !== nftManager.toLowerCase(),
    );
    if (!mintLog) return cacheAndReturn(cacheKey, null);
    const pool = mintLog.address.toLowerCase();

    // 3. The pool's own token pair.
    const [t0Hex, t1Hex] = await Promise.all([
      rpcCall(rpc, pool, SEL_TOKEN0),
      rpcCall(rpc, pool, SEL_TOKEN1),
    ]);
    const token0 = addrFromWord(t0Hex);
    const token1 = addrFromWord(t1Hex);
    if (!token0 || !token1) return cacheAndReturn(cacheKey, null);

    // 4. Decimals from on-chain truth via the shared resolver — never a
    //    blind 18, which would reintroduce the very bug this module fixes.
    const [r0, r1] = await Promise.all([
      resolveToken({ chain, contractAddress: token0 }),
      resolveToken({ chain, contractAddress: token1 }),
    ]);
    if (!Number.isFinite(r0.decimals) || !Number.isFinite(r1.decimals)) {
      return cacheAndReturn(cacheKey, null);
    }

    const ctx: EvmPositionContext = {
      tokenId, pool, token0, token1,
      decimals0: r0.decimals, decimals1: r1.decimals,
      symbol0: r0.symbol, symbol1: r1.symbol,
    };
    return cacheAndReturn(cacheKey, ctx);
  } catch {
    return cacheAndReturn(cacheKey, null);
  }
}

function cacheAndReturn(key: string, ctx: EvmPositionContext | null): EvmPositionContext | null {
  memCache.set(key, ctx);
  // Only a POSITIVE result is persisted. A null may be a transient RPC failure,
  // and freezing that in would permanently exclude a real position.
  if (ctx && redis) {
    redis.set(key, ctx, { ex: TTL_SECONDS }).catch(() => {});
  }
  return ctx;
}

/** Batch helper — resolves many positions with bounded concurrency. */
export async function resolveEvmPositionContexts(
  ids: string[],
  base: Omit<Parameters<typeof resolveEvmPositionContext>[0], 'tokenId'>,
  concurrency = 4,
): Promise<Map<string, EvmPositionContext | null>> {
  const out = new Map<string, EvmPositionContext | null>();
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, ids.length) }, async () => {
    while (i < ids.length) {
      const id = ids[i++];
      out.set(id, await resolveEvmPositionContext({ ...base, tokenId: id }));
    }
  });
  await Promise.all(workers);
  return out;
}
