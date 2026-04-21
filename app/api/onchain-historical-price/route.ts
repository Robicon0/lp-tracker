import { NextResponse } from 'next/server';

// Batch endpoint that reads historical sqrtPrice from Uniswap V3-style pool
// oracle observations. No external price APIs — everything comes from the
// pool contract's own observation ring buffer via the standard `observe()`
// selector.
//
// For each (pool, secondsAgo) pair we request a 60-second TWAP tick near
// (now - secondsAgo):
//   observe([secondsAgo + 60, secondsAgo]) returns tickCumulatives at both
//   ends. avgTick = (cum[1] - cum[0]) / 60. That avg tick is effectively
//   the instantaneous price at (now - secondsAgo).
//
// If the pool's oracle ring doesn't reach back that far (low cardinality),
// `observe()` reverts with OLD. We catch the error and return `null` for
// that (pool, secondsAgo). Callers exclude that position from that range.
//
// USD anchoring: if one side of the pair is a known stablecoin, anchor
// its USD price to $1 and derive the other side from the pool tick. If
// neither side is a stablecoin, return `null` — callers exclude the
// position.

const ALCHEMY_KEY = process.env.NEXT_PUBLIC_ALCHEMY_KEY;

const CHAIN_RPC: Record<string, string> = {
  Ethereum: `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  Arbitrum: `https://arb-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  Optimism: `https://opt-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  Polygon: `https://polygon-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  Base: `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
  HyperEVM: 'https://rpc.hyperliquid.xyz/evm',
  BNB: 'https://bsc-dataseed.binance.org',
  'BNB Chain': 'https://bsc-dataseed.binance.org',
};

// Per-chain stablecoin address set (all lowercase). If a pool's token0 OR
// token1 matches one of these, we anchor that side to $1.
const STABLES: Record<string, Set<string>> = {
  Ethereum: new Set([
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
    '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT
    '0x6b175474e89094c44da98b954eedeac495271d0f', // DAI
    '0x4c9edd5852cd905f086c759e8383e09bff1e68b3', // USDe
    '0x853d955acef822db058eb8505911ed77f175b99e', // FRAX
    '0x57e114b691db790c35207b2e685d4a43181e6061', // ENA
    '0xa3931d71877c0e7a3148cb7eb4463524fec27fbd', // sUSDS
  ]),
  Arbitrum: new Set([
    '0xaf88d065e77c8cc2239327c5edb3a432268e5831', // USDC
    '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8', // USDC.e
    '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', // USDT
    '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1', // DAI
  ]),
  Optimism: new Set([
    '0x0b2c639c533813f4aa9d7837caf62653d097ff85', // USDC
    '0x7f5c764cbc14f9669b88837ca1490cca17c31607', // USDC.e
    '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58', // USDT
    '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1', // DAI
  ]),
  Polygon: new Set([
    '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', // USDC
    '0x2791bca1f2de4661ed88a30c99a7a9449aa84174', // USDC.e
    '0xc2132d05d31c914a87c6611c10748aeb04b58e8f', // USDT
    '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063', // DAI
  ]),
  Base: new Set([
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC
    '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca', // USDbC
    '0x50c5725949a6f0c72e6c4a641f24049a917db0cb', // DAI
    '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2', // USDT
  ]),
  HyperEVM: new Set([
    '0xb88339cb7199b77e23db6e890353e22632ba630f', // USDC
    '0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb', // USDT0
    '0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34', // USDe
    '0x1d7ca62f6af49ec66f6680b8606e634e55ef22c1', // sUSDe
    '0x9ab96a4668456896d45c301bc3a15cee76aa7b8d', // USDHL
  ]),
  BNB: new Set([
    '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', // USDC
    '0x55d398326f99059ff775485246999027b3197955', // USDT
    '0xe9e7cea3dedca5984780bafc599bd69add087d56', // BUSD
  ]),
};

function stablesFor(chain: string): Set<string> {
  return STABLES[chain] ?? STABLES[chain === 'BNB Chain' ? 'BNB' : chain] ?? new Set();
}

// observe(uint32[])
const SELECTOR_OBSERVE = '0x883bdbfd';

function padUint32(n: number): string {
  return n.toString(16).padStart(64, '0');
}

function encodeObserveCall(secondsAgos: number[]): string {
  // observe(uint32[] secondsAgos) — dynamic array
  // offset to array = 0x20
  const len = padUint32(secondsAgos.length);
  const entries = secondsAgos.map((s) => padUint32(s)).join('');
  return SELECTOR_OBSERVE + padUint32(32) + len + entries;
}

async function ethCall(rpc: string, to: string, data: string): Promise<{ result?: string; error?: unknown }> {
  try {
    const res = await fetch(rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_call', params: [{ to, data }, 'latest'], id: 1 }),
    });
    const j = await res.json();
    if (j.error) return { error: j.error };
    return { result: j.result };
  } catch (err) {
    return { error: err };
  }
}

// Decode observe() return: (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)
// We only need tickCumulatives. int56 is sign-extended to 32 bytes.
function decodeTickCumulatives(hex: string, n: number): bigint[] | null {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  // offset to first array
  if (h.length < 64) return null;
  const arrOffset = parseInt(h.slice(0, 64), 16) * 2; // to chars
  if (!Number.isFinite(arrOffset) || arrOffset + 64 > h.length) return null;
  const len = parseInt(h.slice(arrOffset, arrOffset + 64), 16);
  if (len !== n) return null;
  const out: bigint[] = [];
  for (let i = 0; i < n; i++) {
    const start = arrOffset + 64 + i * 64;
    const word = h.slice(start, start + 64);
    if (word.length !== 64) return null;
    // int56 sign extension: values encoded as 32 bytes, MSB set means negative
    const unsigned = BigInt('0x' + word);
    const MAX = 1n << 255n;
    out.push(unsigned >= MAX ? unsigned - (1n << 256n) : unsigned);
  }
  return out;
}

interface HistQuery {
  chain: string;
  poolAddress: string;
  secondsAgo: number[];
  tickLower: number;
  tickUpper: number;
  token0: string;
  token1: string;
  token0Decimals: number;
  token1Decimals: number;
}

interface HistResult {
  bySecondsAgo: Record<number, { tick: number; price0Usd: number | null; price1Usd: number | null } | null>;
}

// Convert a tick to human-readable price of token0 denominated in token1.
// price = 1.0001^tick * 10^(d0 - d1)
function tickToPrice(tick: number, d0: number, d1: number): number {
  return Math.pow(1.0001, tick) * Math.pow(10, d0 - d1);
}

async function queryOne(q: HistQuery): Promise<HistResult> {
  const rpc = CHAIN_RPC[q.chain];
  const bySecondsAgo: HistResult['bySecondsAgo'] = {};
  if (!rpc) {
    for (const s of q.secondsAgo) bySecondsAgo[s] = null;
    return { bySecondsAgo };
  }

  const stables = stablesFor(q.chain);
  const t0Lower = q.token0.toLowerCase();
  const t1Lower = q.token1.toLowerCase();
  const isStable0 = stables.has(t0Lower);
  const isStable1 = stables.has(t1Lower);

  // Fire one observe() per secondsAgo, each with [secondsAgo+60, secondsAgo]
  // so we get a 60-second TWAP centered near that historical timestamp.
  const tasks = q.secondsAgo.map(async (s): Promise<[number, { tick: number; price0Usd: number | null; price1Usd: number | null } | null]> => {
    if (!isStable0 && !isStable1) return [s, null]; // can't anchor USD
    const calldata = encodeObserveCall([s + 60, s]);
    const { result, error } = await ethCall(rpc, q.poolAddress, calldata);
    if (error || !result || result === '0x' || result.length < 130) return [s, null];
    const cums = decodeTickCumulatives(result, 2);
    if (!cums) return [s, null];
    const avgTick = Number((cums[1] - cums[0]) / 60n);
    if (!Number.isFinite(avgTick)) return [s, null];
    const poolPrice = tickToPrice(avgTick, q.token0Decimals, q.token1Decimals); // token0 in token1
    if (!isFinite(poolPrice) || poolPrice <= 0) return [s, null];
    let price0: number | null = null;
    let price1: number | null = null;
    if (isStable1) {
      price1 = 1;
      price0 = poolPrice;
    } else if (isStable0) {
      price0 = 1;
      price1 = 1 / poolPrice;
    }
    return [s, { tick: avgTick, price0Usd: price0, price1Usd: price1 }];
  });

  const results = await Promise.all(tasks);
  for (const [s, val] of results) bySecondsAgo[s] = val;
  return { bySecondsAgo };
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { queries?: HistQuery[] };
    const queries = Array.isArray(body.queries) ? body.queries : [];
    if (queries.length === 0) return NextResponse.json({ results: [] });

    const results = await Promise.all(queries.map(queryOne));
    return NextResponse.json({ results });
  } catch (err) {
    return NextResponse.json({ error: 'Failed', details: String(err) }, { status: 500 });
  }
}
