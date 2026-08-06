// Derive historical token USD prices AT THE BLOCK OF A FEE CLAIM for
// Uniswap V3-style pools. Unlike `deriveDepositPrices()` (which back-solves
// the pool price from a deposit's amount0/amount1 + tick range), fee claim
// amounts are arbitrary — they don't lie on the tick-range curve — so we
// have to read the pool's `sqrtPriceX96` directly at the block of the claim.
//
// For each unique (pool, blockNumber) we do one `eth_call(slot0(), block)`.
// That returns `sqrtPriceX96` at that historical block, from which we
// compute the instantaneous token0/token1 price and apply stablecoin
// anchoring to produce USD prices.
//
// If neither token in the pool is a stablecoin, we return null for that
// block — the caller should fall back to whatever current-price
// approximation it was already using.
//
// No archival RPC is required — public full nodes / Alchemy / LlamaRPC
// all support historical `eth_call` at arbitrary blocks for free. The
// only cost is one RPC round-trip per unique block.
//
// Result is cached in-memory per (pool, blockHex) key for the lifetime
// of the process.
//
// Usage:
//   const resolver = createHistoricalFeePriceResolver({ rpc, pool, token0,
//     token1, decimals0, decimals1, stablecoins });
//   const out = await resolver.resolveMany([block1, block2, ...]);
//   const prices = out.get(blockHex); // { price0Usd, price1Usd } | null

import { logPrice } from './priceLogger';

const SLOT0_SELECTOR = "0x3850c7bd"; // slot0()

// ── ITEM 0d: cross-instance Redis tier ────────────────────────────────────
// A pool's sqrtPriceX96 AT A FINALIZED BLOCK never changes, so this price is
// as immutable as `evm_pos_ctx_v1` and cacheable on the same contract.
//
// WHY IT MATTERS (this is the determinism fix, not an optimization): this
// resolver is TIER 1 of the deposit/withdrawal price cascade. When the archive
// RPC doesn't answer, the route silently drops to a tick-boundary estimate or
// to current spot — a DIFFERENT price basis, which is what made the same
// wallet report a different Capital G/L on every load (ITEM 0b measured a
// $690.49 spread across 3 identical loads, one position flipping between its
// historical $9,246.39 and its tick-derived $9,294.71). Marking made that
// honest; keeping tier 1 WARM is what makes it stable.
//
// Contract, identical to evm_pos_ctx_v1 / redisSpotCache:
//   • own client, PRICE_CACHE_KV_*, no-op stub when unset, never throws
//   • fire-and-forget writes
//   • POSITIVE RESULTS ONLY. A null may be a transient archive failure, and
//     persisting it would pin the position to the substitute basis for 90 days
//     — permanently freezing in the exact bug this is meant to remove.
const REDIS_KEY_PREFIX = 'evm_hist_price_v1:';
const REDIS_TTL_SECONDS = 90 * 24 * 60 * 60;

let redis: { get: (k: string) => Promise<unknown>; set: (k: string, v: unknown, o: { ex: number }) => Promise<unknown> } | null = null;
try {
  const url = process.env.PRICE_CACHE_KV_REST_API_URL;
  const token = process.env.PRICE_CACHE_KV_REST_API_TOKEN;
  if (url && token) {
    const { Redis } = require('@upstash/redis') as typeof import('@upstash/redis');
    redis = new Redis({ url, token }) as unknown as typeof redis;
  }
} catch {
  redis = null;
}

// Observability for the ITEM 0d verification (and for spotting a cold-cache
// regression later): process-wide counters, read via histPriceCacheSnapshot().
let hits = 0, misses = 0, writes = 0;
export function histPriceCacheSnapshot() {
  return { hits, misses, writes, enabled: redis != null };
}

export interface HistPriceContext {
  rpc: string;
  pool: string;
  token0: string;
  token1: string;
  decimals0: number;
  decimals1: number;
  stablecoins: Set<string>;
  /**
   * ITEM 0d — chain slug for the Redis key namespace. The same pool ADDRESS can
   * exist on multiple chains, so a chain-less key could serve one chain's price
   * for another's block. OMIT IT and the Redis tier is simply skipped (the
   * in-process cache still applies) — never guessed.
   */
  chain?: string;
}

export interface HistPrices {
  price0Usd: number;
  price1Usd: number;
}

function sqrtPriceX96ToHumanPrice(
  sqrtPriceX96: bigint,
  d0: number,
  d1: number,
): number {
  // amount_ratio = (sqrtPriceX96 / 2^96)^2 = raw_amount1 / raw_amount0
  // human_price_of_token0_in_token1 = amount_ratio * 10^d0 / 10^d1
  // Use BigInt-ish math with Number casts to avoid precision loss on huge sqrt values.
  const sqrt = Number(sqrtPriceX96) / 2 ** 96;
  const ratio = sqrt * sqrt;
  return ratio * 10 ** (d0 - d1);
}

function applyStableAnchor(
  humanPrice: number,
  token0: string,
  token1: string,
  stables: Set<string>,
): HistPrices | null {
  const isStable0 = stables.has(token0.toLowerCase());
  const isStable1 = stables.has(token1.toLowerCase());
  if (!isStable0 && !isStable1) return null;
  if (!Number.isFinite(humanPrice) || humanPrice <= 0) return null;
  if (isStable1) return { price0Usd: humanPrice, price1Usd: 1 };
  return { price0Usd: 1, price1Usd: 1 / humanPrice };
}

function decodeSlot0SqrtPriceX96(resultHex: string): bigint | null {
  // slot0() returns (uint160 sqrtPriceX96, int24 tick, ...). First 32 bytes
  // are sqrtPriceX96 right-padded. Upper 96 bits are zero.
  if (!resultHex || resultHex === "0x" || resultHex.length < 66) return null;
  const word0 = resultHex.slice(2, 66);
  const value = BigInt("0x" + word0);
  if (value === 0n) return null;
  return value;
}

async function ethCallAt(
  rpc: string,
  to: string,
  data: string,
  blockHex: string,
): Promise<string | null> {
  try {
    const res = await fetch(rpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to, data }, blockHex],
      }),
    });
    const j = await res.json();
    if (j.error) return null;
    return j.result as string;
  } catch {
    return null;
  }
}

export function createHistoricalFeePriceResolver(ctx: HistPriceContext) {
  const cache = new Map<string, HistPrices | null>();

  // Redis key is (chain, pool, block) — decimals/stablecoin anchoring are
  // derived from the pool's own immutable token pair, so they cannot vary for a
  // given pool and need not enter the key.
  const redisKey = (blockHex: string) =>
    `${REDIS_KEY_PREFIX}${ctx.chain}:${ctx.pool.toLowerCase()}:${blockHex}`;

  async function resolveOne(blockHex: string): Promise<HistPrices | null> {
    if (cache.has(blockHex)) return cache.get(blockHex)!;

    // ITEM 0d — cross-instance tier, ahead of the RPC. A hit here is what stops
    // the cascade falling through to a substitute price basis on a cold
    // instance, which is the whole point.
    if (redis && ctx.chain) {
      try {
        const hit = (await redis.get(redisKey(blockHex))) as HistPrices | null;
        if (hit && typeof hit.price0Usd === 'number' && typeof hit.price1Usd === 'number') {
          hits += 1;
          cache.set(blockHex, hit);
          return hit;
        }
        misses += 1;
      } catch {
        // Treat a Redis failure as a miss — never let the cache break pricing.
        misses += 1;
      }
    }

    const result = await ethCallAt(ctx.rpc, ctx.pool, SLOT0_SELECTOR, blockHex);
    if (!result) {
      cache.set(blockHex, null);
      logPrice({
        event: 'price_lookup',
        caller: 'v3HistoricalFeePrice',
        token: ctx.pool,
        tokenAddress: ctx.pool,
        attempts: [{ source: 'sqrtPriceX96', token: ctx.pool, result: null, reason: `rpc_error_or_revert block=${blockHex}` }],
        finalPrice: null,
        finalSource: null,
        status: 'failed',
      });
      return null;
    }
    const sqrt = decodeSlot0SqrtPriceX96(result);
    if (sqrt == null) {
      cache.set(blockHex, null);
      logPrice({
        event: 'price_lookup',
        caller: 'v3HistoricalFeePrice',
        token: ctx.pool,
        tokenAddress: ctx.pool,
        attempts: [{ source: 'sqrtPriceX96', token: ctx.pool, result: null, reason: `slot0_empty_or_zero block=${blockHex}` }],
        finalPrice: null,
        finalSource: null,
        status: 'failed',
      });
      return null;
    }
    const human = sqrtPriceX96ToHumanPrice(sqrt, ctx.decimals0, ctx.decimals1);
    const prices = applyStableAnchor(human, ctx.token0, ctx.token1, ctx.stablecoins);
    cache.set(blockHex, prices);
    // POSITIVE ONLY — see the contract note at the top of this file. A null here
    // can be a transient archive failure; persisting it for 90 days would pin
    // the position to a substitute basis forever.
    if (prices && redis && ctx.chain) {
      writes += 1;
      redis.set(redisKey(blockHex), prices, { ex: REDIS_TTL_SECONDS }).catch(() => {});
    }
    logPrice({
      event: 'price_lookup',
      caller: 'v3HistoricalFeePrice',
      token: ctx.pool,
      tokenAddress: ctx.pool,
      attempts: [{
        source: 'sqrtPriceX96',
        token: ctx.pool,
        result: prices ? prices.price0Usd : null,
        reason: prices
          ? `block=${blockHex} price0=${prices.price0Usd} price1=${prices.price1Usd}`
          : `no_stablecoin_anchor block=${blockHex}`,
      }],
      finalPrice: prices ? prices.price0Usd : null,
      finalSource: prices ? 'sqrtPriceX96' : null,
      status: prices ? 'ok' : 'failed',
    });
    return prices;
  }

  async function resolveMany(
    blocks: number[],
    concurrency = 6,
  ): Promise<Map<string, HistPrices | null>> {
    const unique = Array.from(new Set(blocks.map((b) => "0x" + b.toString(16))));
    const out = new Map<string, HistPrices | null>();
    let i = 0;
    const workers = new Array(Math.min(concurrency, unique.length))
      .fill(0)
      .map(async () => {
        while (true) {
          const idx = i++;
          if (idx >= unique.length) return;
          const hex = unique[idx];
          out.set(hex, await resolveOne(hex));
        }
      });
    await Promise.all(workers);
    return out;
  }

  return { resolveOne, resolveMany };
}
