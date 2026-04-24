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

const SLOT0_SELECTOR = "0x3850c7bd"; // slot0()

export interface HistPriceContext {
  rpc: string;
  pool: string;
  token0: string;
  token1: string;
  decimals0: number;
  decimals1: number;
  stablecoins: Set<string>;
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

  async function resolveOne(blockHex: string): Promise<HistPrices | null> {
    if (cache.has(blockHex)) return cache.get(blockHex)!;
    const result = await ethCallAt(ctx.rpc, ctx.pool, SLOT0_SELECTOR, blockHex);
    if (!result) {
      cache.set(blockHex, null);
      return null;
    }
    const sqrt = decodeSlot0SqrtPriceX96(result);
    if (sqrt == null) {
      cache.set(blockHex, null);
      return null;
    }
    const human = sqrtPriceX96ToHumanPrice(sqrt, ctx.decimals0, ctx.decimals1);
    const prices = applyStableAnchor(human, ctx.token0, ctx.token1, ctx.stablecoins);
    cache.set(blockHex, prices);
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
