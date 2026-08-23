import { NextResponse } from 'next/server';
import { rpcUrlFromEnv } from '../../../lib/rpcEnv';
import { fetchCachedCoinGeckoPrices } from '../../../lib/priceCache';
import { getEverOwnedTokenIds } from '../../../lib/evmEverOwnedNftIds';
import type { RouteTruncation } from '../../../lib/enumerationTruncation';
import { ethCallMany } from '../../../lib/evmBatchCall';

const ALCHEMY_KEY = process.env.NEXT_PUBLIC_ALCHEMY_KEY;

// Archive RPCs for full-range Transfer-log enumeration (Alchemy free tier caps
// eth_getLogs at 10 blocks). Tenderly has no BSC gateway, so BNB has no entry
// and burned-NFT recovery is gracefully skipped there. Mirrors the activity
// route's TENDERLY_RPCS / DEPLOY_BLOCKS.
const TENDERLY_RPCS: Record<string, string> = {
  ethereum: 'https://mainnet.gateway.tenderly.co',
  arbitrum: 'https://arbitrum.gateway.tenderly.co',
  polygon:  'https://polygon.gateway.tenderly.co',
  optimism: 'https://optimism.gateway.tenderly.co',
};
const DEPLOY_BLOCKS: Record<string, number> = {
  ethereum: 12_369_140,
  arbitrum:    165_216,
  polygon:  22_761_331,
  optimism:   3_000_000,
  bnb:      26_324_000,
};

// NonfungiblePositionManager + Factory: ON BNB CHAIN THESE ARE DIFFERENT
// from every other Uniswap V3 deployment — Uniswap deployed to BSC in 2023
// via Wormhole + governance with its own CREATE2 salt, so the canonical
// 0xC36442… NPM and 0x1F98431… Factory do NOT exist there. Read the per-
// chain `nftManager` / `factory` fields instead of any module-level
// constant. Source: @uniswap/v3-sdk constants.ts (NONFUNGIBLE_POSITION_
// MANAGER_ADDRESSES + V3_CORE_FACTORY_ADDRESSES).
const CHAINS: Record<string, {
  rpc: string;
  chainName: string;
  defillamaChain: string;
  nftManager: string;
  factory: string;
}> = {
  ethereum: {
    rpc: `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
    chainName: 'Ethereum',
    defillamaChain: 'Ethereum',
    nftManager: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
    factory:    '0x1F98431c8aD98523631AE4a59f267346ea31F984',
  },
  arbitrum: {
    rpc: `https://arb-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
    chainName: 'Arbitrum',
    defillamaChain: 'Arbitrum',
    nftManager: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
    factory:    '0x1F98431c8aD98523631AE4a59f267346ea31F984',
  },
  polygon: {
    rpc: `https://polygon-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
    chainName: 'Polygon',
    defillamaChain: 'Polygon',
    nftManager: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
    factory:    '0x1F98431c8aD98523631AE4a59f267346ea31F984',
  },
  optimism: {
    rpc: `https://opt-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
    chainName: 'Optimism',
    defillamaChain: 'Optimism',
    nftManager: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
    factory:    '0x1F98431c8aD98523631AE4a59f267346ea31F984',
  },
  bnb: {
    rpc: 'https://bsc-dataseed.binance.org/',
    chainName: 'BNB Chain',
    defillamaChain: 'BSC',
    // BNB Chain has its own Uniswap V3 contract addresses — see comment above.
    nftManager: '0x7b8A01B39D58278b5DE7e48c8449c9f4F5170613',
    factory:    '0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7',
  },
};

// Well-known tokens per chain for symbol/decimal resolution
const KNOWN_TOKENS: Record<string, Record<string, { symbol: string; decimals: number; coingeckoId: string }>> = {
  ethereum: {
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': { symbol: 'WETH', decimals: 18, coingeckoId: 'ethereum' },
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { symbol: 'USDC', decimals: 6, coingeckoId: 'usd-coin' },
    '0xdac17f958d2ee523a2206206994597c13d831ec7': { symbol: 'USDT', decimals: 6, coingeckoId: 'tether' },
    '0x6b175474e89094c44da98b954eedeac495271d0f': { symbol: 'DAI', decimals: 18, coingeckoId: 'dai' },
    '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': { symbol: 'WBTC', decimals: 8, coingeckoId: 'bitcoin' },
    '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984': { symbol: 'UNI', decimals: 18, coingeckoId: 'uniswap' },
    '0x514910771af9ca656af840dff83e8264ecf986ca': { symbol: 'LINK', decimals: 18, coingeckoId: 'chainlink' },
  },
  arbitrum: {
    '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': { symbol: 'WETH', decimals: 18, coingeckoId: 'ethereum' },
    '0xaf88d065e77c8cc2239327c5edb3a432268e5831': { symbol: 'USDC', decimals: 6, coingeckoId: 'usd-coin' },
    '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8': { symbol: 'USDC.e', decimals: 6, coingeckoId: 'usd-coin' },
    '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': { symbol: 'USDT', decimals: 6, coingeckoId: 'tether' },
    '0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f': { symbol: 'WBTC', decimals: 8, coingeckoId: 'bitcoin' },
    '0x912ce59144191c1204e64559fe8253a0e49e6548': { symbol: 'ARB', decimals: 18, coingeckoId: 'arbitrum' },
    '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1': { symbol: 'DAI', decimals: 18, coingeckoId: 'dai' },
  },
  polygon: {
    '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619': { symbol: 'WETH', decimals: 18, coingeckoId: 'ethereum' },
    '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359': { symbol: 'USDC', decimals: 6, coingeckoId: 'usd-coin' },
    '0x2791bca1f2de4661ed88a30c99a7a9449aa84174': { symbol: 'USDC.e', decimals: 6, coingeckoId: 'usd-coin' },
    '0xc2132d05d31c914a87c6611c10748aeb04b58e8f': { symbol: 'USDT', decimals: 6, coingeckoId: 'tether' },
    '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270': { symbol: 'WMATIC', decimals: 18, coingeckoId: 'matic-network' },
    '0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6': { symbol: 'WBTC', decimals: 8, coingeckoId: 'bitcoin' },
    '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063': { symbol: 'DAI', decimals: 18, coingeckoId: 'dai' },
  },
  optimism: {
    '0x4200000000000000000000000000000000000006': { symbol: 'WETH', decimals: 18, coingeckoId: 'ethereum' },
    '0x0b2c639c533813f4aa9d7837caf62653d097ff85': { symbol: 'USDC', decimals: 6, coingeckoId: 'usd-coin' },
    '0x7f5c764cbc14f9669b88837ca1490cca17c31607': { symbol: 'USDC.e', decimals: 6, coingeckoId: 'usd-coin' },
    '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58': { symbol: 'USDT', decimals: 6, coingeckoId: 'tether' },
    '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1': { symbol: 'DAI', decimals: 18, coingeckoId: 'dai' },
    '0x68f180fcce6836688e9084f035309e29bf0a2095': { symbol: 'WBTC', decimals: 8, coingeckoId: 'bitcoin' },
    '0x4200000000000000000000000000000000000042': { symbol: 'OP', decimals: 18, coingeckoId: 'optimism' },
  },
  bnb: {
    // NOTE: USDT and USDC on BSC use 18 decimals (NOT 6 like on Ethereum / L2s).
    '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c': { symbol: 'WBNB', decimals: 18, coingeckoId: 'wbnb' },
    '0x55d398326f99059ff775485246999027b3197955': { symbol: 'USDT', decimals: 18, coingeckoId: 'tether' },
    '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': { symbol: 'USDC', decimals: 18, coingeckoId: 'usd-coin' },
    '0xe9e7cea3dedca5984780bafc599bd69add087d56': { symbol: 'BUSD', decimals: 18, coingeckoId: 'binance-usd' },
  },
  robinhood: {
    // Only the two high-stakes identities are pinned. Everything else on this
    // chain (the tokenized-equity long tail: NVDA, AAPL, AMC, DJT…) is left to
    // resolveToken, which reads symbol+decimals from on-chain metadata —
    // architecture Rule 9: do not grow per-route token maps.
    '0x0bd7d308f8e1639fab988df18a8011f41eacad73': { symbol: 'WETH', decimals: 18, coingeckoId: 'ethereum' },
    '0x5fc5360d0400a0fd4f2af552add042d716f1d168': { symbol: 'USDG', decimals: 6, coingeckoId: 'global-dollar' },
  },
};

// Queue item C Phase 2a — the OPEN-position cap is GONE. `balanceOf` returns the
// exact number of position NFTs the wallet holds, so there was never anything
// to discover here, only to iterate; the old `Math.min(balance, 20)` discarded
// a number the route already had in hand. Enumeration is now batched (one
// JSON-RPC request per 100 tokenIds, paced by evmRpc's global semaphore)
// instead of one serial round trip per index, so removing the cap makes the
// route FASTER for every wallet, not slower.
//
// The CLOSED-candidate bound is deliberately KEPT and raised. It is a different
// shape of problem: each candidate costs a positions() call plus an archive
// eth_getLogs plus a transaction receipt against Tenderly, which throttles
// per-IP — an unbounded fan-out there is the documented route to a hung
// positions source (ITEM 0i). It stays disclosed via Phase 1's `truncated`
// whenever it binds, and is now high enough that no ordinary wallet reaches it.
// Only the CHEAP, exactly-countable enumeration is uncapped.
const CLOSED_CANDIDATE_CAP = 200;

// Per-chain wall-clock budget for the uncapped enumeration. The five chains run
// in parallel inside one request whose Vercel `maxDuration` is 300 s, so a
// single chain must not be able to consume the whole budget. Whatever the
// budget cannot reach is DISCLOSED, never dropped — the bound moved from
// "how many positions" to "how long", which is the honest axis.
const ENUMERATION_BUDGET_MS = 60_000;

const SELECTORS = {
  balanceOf: '0x70a08231',     // balanceOf(address)
  tokenOfOwnerByIndex: '0x2f745c59', // tokenOfOwnerByIndex(address,uint256)
  positions: '0x99fbab88',     // positions(uint256) — keccak256("positions(uint256)")[:4]. Same selector across every Uniswap V3 NPM deployment (Ethereum / Arbitrum / Optimism / Polygon / BNB Chain) and across HyperEVM V3 forks. Was '0x99fd0e82' (wrong — reverts on every chain).
  symbol: '0x95d89b41',
  decimals: '0x313ce567',
  getPool: '0x1698ee82',        // getPool(address,address,uint24) on the V3 factory
};

// ── ITEM 0g (G1): resolve each position's POOL ────────────────────────────
// Why a positions route cares about the pool address: the activity route's
// TIER 1 historical price source reads the pool's `sqrtPriceX96` at the block
// of each deposit/withdrawal, and it is constructed ONLY when the client passes
// a `pool` param — which the client forwards only if the position carries a
// `poolAddress`. This route never returned one, so tier 1 was NEVER ATTEMPTED
// for any Uniswap position and every deposit/withdrawal fell through to a
// substitute price basis (a tick-boundary estimate, or current spot) on EVERY
// load. Measured 2026-08-10 on Account 1: 9 spot-substituted + 6 tick-derived
// events across 3 Uniswap positions, all of them avoidable.
//
// (factory, token0, token1, fee) → pool is IMMUTABLE, and the tuple repeats
// across a wallet's positions in the same pool, so an in-process map is enough;
// nothing here needs to be re-derived within a request.
const poolAddressCache: Record<string, string | null> = {};

async function resolvePoolAddress(
  rpc: string,
  factory: string,
  token0: string,
  token1: string,
  fee: number,
): Promise<string | null> {
  const key = `${factory}-${token0}-${token1}-${fee}`.toLowerCase();
  if (key in poolAddressCache) return poolAddressCache[key];
  try {
    const data = SELECTORS.getPool + padAddress(token0) + padAddress(token1) + padUint256(BigInt(fee));
    const result = await rpcCall(rpc, factory, data);
    const addr = result && result !== '0x' ? '0x' + result.slice(-40) : null;
    // A zero address means "no such pool" — never emit it, or the activity
    // route would build a resolver against address(0) and quietly get nothing.
    const ok = addr && addr !== '0x0000000000000000000000000000000000000000' ? addr : null;
    poolAddressCache[key] = ok;
    return ok;
  } catch {
    // Leave UNCACHED on failure: a transient RPC error must not pin this
    // position to the substitute basis for the life of the process.
    return null;
  }
}

function padAddress(addr: string): string {
  return addr.toLowerCase().replace('0x', '').padStart(64, '0');
}

function padUint256(value: bigint): string {
  return value.toString(16).padStart(64, '0');
}

async function rpcCall(rpc: string, to: string, data: string): Promise<string> {
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'eth_call',
      params: [{ to, data }, 'latest'],
      id: 1,
    }),
  });
  const json = await res.json();
  return json.result || '0x';
}

// Get number of Uniswap V3 NFTs owned by account
async function getBalance(rpc: string, nftManager: string, account: string): Promise<number> {
  const data = SELECTORS.balanceOf + padAddress(account);
  const result = await rpcCall(rpc, nftManager, data);
  if (!result || result === '0x') return 0;
  return parseInt(result, 16);
}

// Decode position data from positions(uint256) call
// Returns: nonce, operator, token0, token1, fee, tickLower, tickUpper, liquidity,
//          feeGrowthInside0LastX128, feeGrowthInside1LastX128, tokensOwed0, tokensOwed1
interface PositionData {
  token0: string;
  token1: string;
  fee: number;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  tokensOwed0: bigint;
  tokensOwed1: bigint;
}

async function getPosition(rpc: string, nftManager: string, tokenId: bigint): Promise<PositionData | null> {
  // positions(uint256) selector. keccak256("positions(uint256)")[:4] = 0x99fbab88.
  // SAME selector across every Uniswap V3 NPM deployment (Ethereum, Arbitrum,
  // Optimism, Polygon, BNB Chain) and across HyperEVM V3 forks. The previous
  // value '0x99fd0e82' was wrong and reverted with "execution reverted: 0x" on
  // every chain — silently caused getPosition to return null so the route
  // emitted zero positions on chains where balanceOf reported any. Returns the
  // standard 12-tuple (nonce, operator, token0, token1, fee, tickLower,
  // tickUpper, liquidity, feeGrowthInside0LastX128, feeGrowthInside1LastX128,
  // tokensOwed0, tokensOwed1).
  const selector = '0x99fbab88';
  const data = selector + padUint256(tokenId);
  const result = await rpcCall(rpc, nftManager, data);
  return decodePositionData(result);
}

/**
 * Pure decoder for a positions(uint256) return payload. Split out of
 * getPosition (queue item C Phase 2a) so the BATCHED enumeration path decodes
 * with byte-identical logic instead of a second copy — the single-call
 * getPosition above now delegates to it, so the two can never diverge.
 */
function decodePositionData(result: string | null): PositionData | null {
  if (!result || result === '0x' || result.length < 770) return null;
  
  const hex = result.startsWith('0x') ? result.slice(2) : result;
  
  // Decode 12 return values (each 32 bytes = 64 hex chars)
  const readWord = (i: number) => hex.slice(i * 64, (i + 1) * 64);
  const toAddress = (word: string) => '0x' + word.slice(24).toLowerCase();
  // ABI encodes int24 SIGN-EXTENDED to 32 bytes — so tick -887272 comes
  // back as 0xffff…fffff264d8 (high 29 bytes are 0xff to indicate negative).
  // Reading the full 256-bit word and subtracting 0x1000000 gave a value
  // near 2^256 for any negative tick, which then poisoned downstream tick
  // math (deriveDepositPrices produced astronomical prices → value_overflow
  // for the whole position). Fix: take only the LAST 3 bytes (6 hex chars)
  // and sign-extend from int24. Same pattern documented for HyperEVM.
  const toInt24 = (word: string) => {
    const last3 = word.slice(-6);
    const val = parseInt(last3, 16);
    return val >= 0x800000 ? val - 0x1000000 : val;
  };
  
  // word 0: nonce (uint96)
  // word 1: operator (address)
  // word 2: token0 (address)
  // word 3: token1 (address)
  // word 4: fee (uint24)
  // word 5: tickLower (int24)
  // word 6: tickUpper (int24)
  // word 7: liquidity (uint128)
  // word 8: feeGrowthInside0LastX128 (uint256)
  // word 9: feeGrowthInside1LastX128 (uint256)
  // word 10: tokensOwed0 (uint128)
  // word 11: tokensOwed1 (uint128)
  
  const token0 = toAddress(readWord(2));
  const token1 = toAddress(readWord(3));
  const fee = parseInt(readWord(4), 16);
  const tickLower = toInt24(readWord(5));
  const tickUpper = toInt24(readWord(6));
  const liquidity = BigInt('0x' + readWord(7));
  const tokensOwed0 = BigInt('0x' + readWord(10));
  const tokensOwed1 = BigInt('0x' + readWord(11));
  
  return { token0, token1, fee, tickLower, tickUpper, liquidity, tokensOwed0, tokensOwed1 };
}

// Fetch token symbol and decimals from chain if not in known list
async function fetchTokenInfo(rpc: string, tokenAddress: string): Promise<{ symbol: string; decimals: number }> {
  try {
    const symResult = await rpcCall(rpc, tokenAddress, SELECTORS.symbol);
    const decResult = await rpcCall(rpc, tokenAddress, SELECTORS.decimals);
    
    let symbol = 'UNKNOWN';
    if (symResult && symResult.length > 130) {
      // ABI-encoded string: offset(32) + length(32) + data
      const hex = symResult.startsWith('0x') ? symResult.slice(2) : symResult;
      const strLen = parseInt(hex.slice(64, 128), 16);
      const strHex = hex.slice(128, 128 + strLen * 2);
      symbol = '';
      for (let i = 0; i < strHex.length; i += 2) {
        const charCode = parseInt(strHex.slice(i, i + 2), 16);
        if (charCode > 0) symbol += String.fromCharCode(charCode);
      }
    }
    
    const decimals = decResult && decResult !== '0x' ? parseInt(decResult, 16) : 18;
    
    return { symbol, decimals };
  } catch {
    return { symbol: 'UNKNOWN', decimals: 18 };
  }
}

/**
 * symbol()+decimals() for many tokens in ONE batched pass (queue item C Phase
 * 2a). Falls back to the per-token path for anything the batch could not read,
 * and NEVER invents decimals: an unreadable token keeps the same
 * UNKNOWN/18 default the single-call path already used, so behaviour for every
 * previously-working token is unchanged.
 */
async function fetchTokenInfoMany(
  rpc: string,
  addresses: string[],
): Promise<Record<string, { symbol: string; decimals: number }>> {
  const out: Record<string, { symbol: string; decimals: number }> = {};
  if (addresses.length === 0) return out;

  const calls = addresses.flatMap((addr) => [
    { to: addr, data: SELECTORS.symbol },
    { to: addr, data: SELECTORS.decimals },
  ]);
  const res = await ethCallMany(rpc, calls);

  const missing: string[] = [];
  addresses.forEach((addr, i) => {
    const symHex = res[i * 2];
    const decHex = res[i * 2 + 1];
    if (symHex === null && decHex === null) { missing.push(addr); return; }
    out[addr] = {
      symbol: decodeSymbol(symHex),
      decimals: decHex ? parseInt(decHex, 16) : 18,
    };
  });
  // Per-token fallback for the stragglers only.
  await Promise.all(missing.map(async (addr) => { out[addr] = await fetchTokenInfo(rpc, addr); }));
  return out;
}

/** ABI-encoded string -> JS string. Extracted from fetchTokenInfo verbatim. */
function decodeSymbol(symResult: string | null): string {
  if (!symResult || symResult.length <= 130) return 'UNKNOWN';
  const hex = symResult.startsWith('0x') ? symResult.slice(2) : symResult;
  const strLen = parseInt(hex.slice(64, 128), 16);
  const strHex = hex.slice(128, 128 + strLen * 2);
  let symbol = '';
  for (let i = 0; i < strHex.length; i += 2) {
    const charCode = parseInt(strHex.slice(i, i + 2), 16);
    if (charCode > 0) symbol += String.fromCharCode(charCode);
  }
  return symbol || 'UNKNOWN';
}

/**
 * Resolve every distinct (token0, token1, fee) tuple to its pool in ONE batched
 * pass, filling the SAME module cache `resolvePoolAddress` reads, so the
 * per-position loop below hits memory instead of the network (ITEM 0g / G1).
 *
 * Keeps 0g's rule intact: a FAILED lookup is left UNCACHED, so a transient RPC
 * error cannot pin a position to a substitute price basis for the life of the
 * process; only a definitive answer (a real pool, or address(0) = "no such
 * pool") is stored.
 */
async function prewarmPoolAddresses(
  rpc: string,
  factory: string,
  positions: PositionData[],
): Promise<void> {
  const tuples = new Map<string, PositionData>();
  for (const p of positions) {
    const key = `${factory}-${p.token0}-${p.token1}-${p.fee}`.toLowerCase();
    if (!(key in poolAddressCache)) tuples.set(key, p);
  }
  if (tuples.size === 0) return;
  const entries = [...tuples.entries()];
  const res = await ethCallMany(
    rpc,
    entries.map(([, p]) => ({
      to: factory,
      data: SELECTORS.getPool + padAddress(p.token0) + padAddress(p.token1) + padUint256(BigInt(p.fee)),
    })),
  );
  entries.forEach(([key], i) => {
    const result = res[i];
    if (result === null) return; // transient — leave uncached (ITEM 0g rule)
    const addr = '0x' + result.slice(-40);
    poolAddressCache[key] = addr !== '0x0000000000000000000000000000000000000000' ? addr : null;
  });
}

// Calculate token amounts from liquidity and tick range
// Using the Uniswap V3 math: 
// amount0 = liquidity * (sqrt(upper) - sqrt(current)) / (sqrt(current) * sqrt(upper))
// amount1 = liquidity * (sqrt(current) - sqrt(lower))
// For simplicity, we'll estimate using the geometric mean of the range
function estimateAmounts(
  liquidity: bigint,
  tickLower: number,
  tickUpper: number,
  decimals0: number,
  decimals1: number
): { amount0: number; amount1: number } {
  if (liquidity === 0n) return { amount0: 0, amount1: 0 };
  
  // sqrt(1.0001^tick) 
  const sqrtLower = Math.sqrt(1.0001 ** tickLower);
  const sqrtUpper = Math.sqrt(1.0001 ** tickUpper);
  // Use midpoint as current price estimate
  const sqrtCurrent = (sqrtLower + sqrtUpper) / 2;
  
  const liq = Number(liquidity);
  
  // amount0 = L * (1/sqrtCurrent - 1/sqrtUpper)
  const amount0 = liq * (1 / sqrtCurrent - 1 / sqrtUpper) / (10 ** decimals0);
  // amount1 = L * (sqrtCurrent - sqrtLower)
  const amount1 = liq * (sqrtCurrent - sqrtLower) / (10 ** decimals1);
  
  return {
    amount0: Math.max(0, amount0),
    amount1: Math.max(0, amount1),
  };
}

// Fetch prices from CoinGecko
async function fetchPrices(coingeckoIds: string[]): Promise<Record<string, number>> {
  return fetchCachedCoinGeckoPrices(coingeckoIds);
}

// Fetch APY from DefiLlama
async function fetchUniswapAPYs(): Promise<Record<string, number>> {
  try {
    const res = await fetch('https://yields.llama.fi/pools', { next: { revalidate: 300 } });
    const data = await res.json();
    
    const uniPools = data.data?.filter(
      (p: any) => p.project === 'uniswap-v3'
    ) || [];
    
    // Build lookup by "chain-token0-token1" using median APY
    const apysByKey: Record<string, number[]> = {};
    for (const pool of uniPools) {
      if (pool.underlyingTokens && pool.underlyingTokens.length >= 2) {
        const tokens = pool.underlyingTokens.map((t: string) => t.toLowerCase()).sort();
        const key = `${pool.chain}-${tokens.join('-')}`;
        if (!apysByKey[key]) apysByKey[key] = [];
        apysByKey[key].push(pool.apyBase || pool.apy || 0);
      }
    }
    
    const result: Record<string, number> = {};
    for (const [key, apys] of Object.entries(apysByKey)) {
      const sorted = apys.sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      result[key] = Math.round((sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2) * 100) / 100;
    }
    return result;
  } catch {
    return {};
  }
}

// Build a minimal Closed record for a BURNED tokenId (positions() reverts).
// Returns null if the tokenId still exists (transferred to another owner — not
// this wallet's closed position). Metadata is intentionally left generic: this
// is display-only (the dashboard Closed tab) and per-position mint-tx derivation
// is far too slow to run on every load for active LPs (measured 74s for a wallet
// with 20 churned positions). Fees from these are recovered via the wallet-scope
// /api/uniswap/activity?tokenId=all, so value/fees stay 0 here.
async function buildBurnedPosition(
  chainKey: string,
  tokenId: string,
  account: string,
): Promise<Record<string, unknown> | null> {
  const chain = CHAINS[chainKey];
  // positions() still returns → NFT exists (transferred away), not burned → skip.
  const stillExists = await getPosition(chain.rpc, chain.nftManager, BigInt(tokenId));
  if (stillExists) return null;
  return {
    id: `uni3-${chainKey}-${tokenId}`,
    pair: 'Uniswap V3 Position',
    protocol: 'Uniswap V3',
    chain: chain.chainName,
    value: 0, apy: 0, fees: 0,
    status: 'Closed',
    burned: true,
    tokenId,
    fee: 0,
    amount0: 0, amount1: 0,
    token0Symbol: 'TOKEN0', token1Symbol: 'TOKEN1',
    tickLower: 0, tickUpper: 0,
    token0Decimals: 18, token1Decimals: 18,
    liquidity: '0',
    price0: 0, price1: 0,
    walletAddress: account,
  };
}

async function fetchPositionsForChain(
  chainKey: string,
  account: string,
  prices: Record<string, number>,
  apyData: Record<string, number>
): Promise<{ positions: unknown[]; truncated: RouteTruncation[] }> {
  const chain = CHAINS[chainKey];
  const knownTokens = KNOWN_TOKENS[chainKey] || {};
  const positions: any[] = [];
  // Anything that stops this route from returning the wallet's FULL position
  // set is reported here, never applied silently (queue item C). Phase 2a
  // removed the open-position cap, so what remains are transport failures and
  // the deliberate closed-candidate bound.
  const truncated: RouteTruncation[] = [];
  // One budget for the whole chain: the enumeration below and the burned-NFT
  // recovery further down share it, so a wallet whose open-position scan is
  // expensive cannot also spend the recovery's time and blow `maxDuration`.
  const recoveryDeadline = Date.now() + ENUMERATION_BUDGET_MS;
  
  try {
    const balance = await getBalance(chain.rpc, chain.nftManager, account);
    if (balance === 0) return { positions, truncated };

    const deadline = recoveryDeadline;

    // EVERY tokenId — `balance` is exact, and the reads go out batched.
    const idResults = await ethCallMany(
      chain.rpc,
      Array.from({ length: balance }, (_, i) => ({
        to: chain.nftManager,
        data: SELECTORS.tokenOfOwnerByIndex + padAddress(account) + padUint256(BigInt(i)),
      })),
      { deadline },
    );
    const tokenIds: bigint[] = [];
    let unreadableIds = 0;
    idResults.forEach((r) => {
      if (r === null) { unreadableIds += 1; return; }
      const id = BigInt(r);
      if (id > 0n) tokenIds.push(id);
    });
    // An index the RPC could not read is NOT an absent position. Rather than
    // drop it silently — the exact defect Phase 1 exists to end — it is
    // disclosed through the same channel a cap would have used.
    if (unreadableIds > 0) {
      truncated.push({
        scope: chain.chainName,
        cap: balance,
        returned: tokenIds.length,
        knownTotal: balance,
        reason: 'tokenid-enumeration-incomplete',
      });
      console.warn(`[uniswap] ${chain.chainName}: ${unreadableIds} of ${balance} tokenId reads unavailable (RPC failure or time budget)`);
    }

    // positions() for every tokenId, batched.
    const posResults = await ethCallMany(
      chain.rpc,
      tokenIds.map((id) => ({ to: chain.nftManager, data: SELECTORS.positions + padUint256(id) })),
      { deadline },
    );
    const posById = new Map<string, PositionData>();
    tokenIds.forEach((id, i) => {
      const raw = posResults[i];
      const parsed = raw ? decodePositionData(raw) : null;
      if (parsed) posById.set(id.toString(), parsed);
    });
    if (posById.size < tokenIds.length) {
      // A HELD tokenId whose positions() cannot be read is surfaced, never
      // dropped. (A revert would mean the NFT is burned — but an id returned by
      // tokenOfOwnerByIndex is by definition still held, so this is transport.)
      truncated.push({
        scope: chain.chainName,
        cap: balance,
        returned: posById.size,
        knownTotal: tokenIds.length,
        reason: 'position-read-incomplete',
      });
      console.warn(`[uniswap] ${chain.chainName}: ${tokenIds.length - posById.size} positions() reads failed`);
    }

    // Token metadata for each unknown token ONCE per address, batched. The old
    // per-position loop re-fetched the same token's symbol+decimals for every
    // position that used it — invisible under a cap of 20, quadratic without one.
    const unknownTokens = [...new Set(
      [...posById.values()].flatMap((p) => [p.token0, p.token1]).filter((a) => !knownTokens[a]),
    )];
    const fetchedTokenInfo = await fetchTokenInfoMany(chain.rpc, unknownTokens);

    // Pool address for each distinct (token0, token1, fee) tuple, batched into
    // the same module cache resolvePoolAddress reads (ITEM 0g / G1).
    await prewarmPoolAddresses(chain.rpc, chain.factory, [...posById.values()]);

    // Fetch position data for each token
    for (const tokenId of tokenIds) {
      try {
        const pos = posById.get(tokenId.toString());
        if (!pos) continue;

        // Get token info
        let t0Info = knownTokens[pos.token0];
        let t1Info = knownTokens[pos.token1];

        // Unknown tokens resolved above, in one batch
        if (!t0Info) {
          t0Info = { ...fetchedTokenInfo[pos.token0], coingeckoId: '' };
        }
        if (!t1Info) {
          t1Info = { ...fetchedTokenInfo[pos.token1], coingeckoId: '' };
        }
        
        // Calculate amounts
        const { amount0, amount1 } = estimateAmounts(
          pos.liquidity, pos.tickLower, pos.tickUpper, t0Info.decimals, t1Info.decimals
        );
        
        // Get prices
        const price0 = t0Info.coingeckoId ? (prices[t0Info.coingeckoId] || 0) : 0;
        const price1 = t1Info.coingeckoId ? (prices[t1Info.coingeckoId] || 0) : 0;
        
        const value = (amount0 * price0) + (amount1 * price1);
        
        // Calculate fees value
        const fees0 = Number(pos.tokensOwed0) / (10 ** t0Info.decimals);
        const fees1 = Number(pos.tokensOwed1) / (10 ** t1Info.decimals);
        const feesUsd = (fees0 * price0) + (fees1 * price1);
        
        // ITEM 0g (G1) — the position's own pool, for the activity route's
        // tier-1 historical price reads. Null (RPC failure / no such pool) is
        // omitted rather than guessed; the route then behaves exactly as before.
        const poolAddress = await resolvePoolAddress(
          chain.rpc, chain.factory, pos.token0, pos.token1, pos.fee,
        );

        // Look up APY
        const apyKey = `${chain.defillamaChain}-${[pos.token0, pos.token1].sort().join('-')}`;
        const apy = apyData[apyKey] || 0;
        
        // RULE: Closed positions (liquidity = 0) must ALWAYS be returned and
        // never filtered out. Status is set to 'Closed' below. Applies to all
        // current and future protocol integrations on any chain.
        const hasToken0 = amount0 > 0.0001;
        const hasToken1 = amount1 > 0.0001;
        const status = pos.liquidity === 0n ? 'Closed' : (hasToken0 && hasToken1) ? 'In Range' : 'Out of Range';
        
        positions.push({
          id: `uni3-${chainKey}-${tokenId.toString()}`,
          pair: `${t0Info.symbol} / ${t1Info.symbol}`,
          protocol: 'Uniswap V3',
          chain: chain.chainName,
          value: Math.round(value * 100) / 100,
          apy,
          fees: Math.round(feesUsd * 100) / 100,
          status,
          tokenId: tokenId.toString(),
          fee: pos.fee / 10000, // Convert to percentage (e.g., 3000 -> 0.3%)
          amount0: Math.round(amount0 * 1000000) / 1000000,
          amount1: Math.round(amount1 * 1000000) / 1000000,
          token0Symbol: t0Info.symbol,
          token1Symbol: t1Info.symbol,
          tickLower: pos.tickLower,
          tickUpper: pos.tickUpper,
          token0Decimals: t0Info.decimals,
          token1Decimals: t1Info.decimals,
          liquidity: pos.liquidity.toString(),
          price0,
          price1,
          token0Address: pos.token0,
          token1Address: pos.token1,
          // ITEM 0g (G1) — carries the activity route's tier-1 historical price
          // source. Resolved for CLOSED positions too: those are precisely the
          // ones whose Capital G/L depends on historical pricing.
          ...(poolAddress ? { poolAddress } : {}),
          walletAddress: account,
        });
      } catch (err) {
        console.error(`Error processing token ${tokenId} on ${chainKey}:`, err);
      }
    }
  } catch (err) {
    console.error(`Error fetching positions on ${chainKey}:`, err);
  }

  // ── Burned-NFT recovery (defensive, additive) ────────────────────────────
  // Enumerate every tokenId this wallet ever owned on this chain; any NOT
  // currently held whose positions() reverts is a BURNED position (NFT
  // destroyed on close). Surface it as Closed (burned:true). Requires an
  // archive RPC (Tenderly); BNB has none and is skipped gracefully. The
  // balanceOf/tokenOfOwnerByIndex path above is untouched (incl. closed-but-not-
  // burned liquidity=0 positions, which still exist and are already returned).
  const archiveRpc = TENDERLY_RPCS[chainKey];
  if (archiveRpc && Date.now() < recoveryDeadline) {
    try {
      const heldIds = new Set(positions.map((p) => String(p.tokenId)));
      const everOwned = await getEverOwnedTokenIds(chain.nftManager, account, archiveRpc, DEPLOY_BLOCKS[chainKey] ?? 0);
      // Cap candidates so an active LP / market-maker wallet (hundreds of
      // ever-owned NFTs) can't fan out into hundreds of positions()+receipt
      // calls and time the route out. Normal users (the defensive target) have
      // a handful, so the cap never triggers for them.
      const allCandidates = everOwned.filter((id) => !heldIds.has(id));
      const candidates = allCandidates.slice(0, CLOSED_CANDIDATE_CAP);
      if (allCandidates.length > candidates.length) {
        truncated.push({
          scope: `${chain.chainName} closed-position recovery`,
          cap: CLOSED_CANDIDATE_CAP,
          returned: candidates.length,
          knownTotal: allCandidates.length,
          reason: 'closed-candidate-scan-cap',
        });
        console.warn(`[uniswap] ${chain.chainName}: ${allCandidates.length} closed candidates, cap is ${CLOSED_CANDIDATE_CAP}`);
      }
      const burned = await Promise.all(
        candidates.map((tokenId) => buildBurnedPosition(chainKey, tokenId, account)),
      );
      for (const r of burned) if (r) positions.push(r);
    } catch (err) {
      console.error(`[uniswap] burned-recovery failed on ${chainKey}:`, err);
    }
  } else if (archiveRpc) {
    // The open-position enumeration consumed the chain's budget. Skipping
    // recovery keeps the route inside `maxDuration`; saying so keeps it honest —
    // a wallet is told its closed positions were not reached, rather than being
    // shown a set that looks complete.
    truncated.push({
      scope: `${chain.chainName} closed-position recovery`,
      cap: 0,
      returned: 0,
      knownTotal: null,
      reason: 'closed-recovery-time-budget-exhausted',
    });
    console.warn(`[uniswap] ${chain.chainName}: skipped closed-position recovery — time budget exhausted`);
  }

  return { positions, truncated };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const account = searchParams.get('account');
  const chain = searchParams.get('chain'); // Optional: filter to specific chain
  
  if (!account) {
    return NextResponse.json({ error: 'Account address required' }, { status: 400 });
  }
  
  if (!ALCHEMY_KEY) {
    return NextResponse.json({ error: 'Alchemy API key not configured' }, { status: 500 });
  }
  
  try {
    // Collect all coingecko IDs for price fetch
    const allCoingeckoIds: string[] = [];
    for (const tokens of Object.values(KNOWN_TOKENS)) {
      for (const t of Object.values(tokens)) {
        if (t.coingeckoId) allCoingeckoIds.push(t.coingeckoId);
      }
    }
    
    // Fetch prices and APY data in parallel
    const [prices, apyData] = await Promise.all([
      fetchPrices(allCoingeckoIds),
      fetchUniswapAPYs(),
    ]);
    
    // Determine which chains to query
    const chainsToQuery = chain && CHAINS[chain] ? [chain] : Object.keys(CHAINS);
    
    // Fetch positions from all chains in parallel
    const results = await Promise.all(
      chainsToQuery.map(c => fetchPositionsForChain(c, account, prices, apyData))
    );
    
    const allPositions = results.flatMap((r) => r.positions);
    const truncated = results.flatMap((r) => r.truncated);
    
    return NextResponse.json({
      positions: allPositions,
      count: allPositions.length,
      account,
      chains: chainsToQuery,
      // Additive (queue item C Phase 1). Present ONLY when a cap actually bound
      // this request; absent means the enumeration was complete.
      ...(truncated.length > 0 ? { truncated } : {}),
    });
  } catch (err) {
    console.error('Uniswap V3 API error:', err);
    return NextResponse.json({ error: 'Failed to fetch positions' }, { status: 500 });
  }
}