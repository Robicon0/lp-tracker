import { NextResponse } from 'next/server';
import { fetchCachedCoinGeckoPrices } from '../../lib/priceCache';

const HYPEREVM_RPC = 'https://rpc.hyperliquid.xyz/evm';

// HyperSwap V3 NonfungiblePositionManager on HyperEVM
const HYPERSWAP_NFT_MANAGER = '0x6eda206207c09e5428f281761ddc0d300851fbc8';
// KittenSwap NonfungiblePositionManager on HyperEVM
const KITTENSWAP_NFT_MANAGER = '0xb9201e89f94a01ff13ad4caecf43a2e232513754';

// ProjectX (PRJX) NonfungiblePositionManager on HyperEVM
const PRJX_NFT_MANAGER = '0xead19ae861c29bbb2101e834922b2feee69b9091';

// Known factory addresses — hardcoded to skip the factory() RPC call where possible
const POSITION_MANAGERS = [
  { address: HYPERSWAP_NFT_MANAGER, protocol: 'HyperSwap', factory: '' },
  { address: KITTENSWAP_NFT_MANAGER, protocol: 'KittenSwap', factory: '' },
  { address: PRJX_NFT_MANAGER, protocol: 'ProjectX', factory: '0xff7b3e8c00e57ea31477c32a5b52a58eea47b072' },
];

// Known tokens on HyperEVM
// Note: 0x5555...5555 is how native HYPE is represented in V3 pool token slots
const KNOWN_TOKENS: Record<string, { symbol: string; decimals: number; coingeckoId: string }> = {
  '0x5555555555555555555555555555555555555555': { symbol: 'HYPE', decimals: 18, coingeckoId: 'hyperliquid' },
  '0xadcb2f358eae6492f61a5f87eb8893d09391d160': { symbol: 'WHYPE', decimals: 18, coingeckoId: 'hyperliquid' },
  '0xb88339cb7199b77e23db6e890353e22632ba630f': { symbol: 'USDC', decimals: 6, coingeckoId: 'usd-coin' },
  '0x24ac48bf01fd6cb1c3836d08b3edc70a9c4380ca': { symbol: 'USDC', decimals: 6, coingeckoId: 'usd-coin' },
};

// Function selectors (ERC-721 + Uniswap V3 NonfungiblePositionManager interface)
const SELECTORS = {
  balanceOf: '0x70a08231',          // balanceOf(address)
  tokenOfOwnerByIndex: '0x2f745c59', // tokenOfOwnerByIndex(address,uint256)
  positions: '0x99fbab88',           // positions(uint256) — HyperEVM V3 fork selector
  symbol: '0x95d89b41',
  decimals: '0x313ce567',
  factory: '0xc45a0155',             // factory()
  getPool: '0x1698ee82',             // getPool(address,address,uint24)
  slot0: '0x3850c7bd',               // slot0()
  feeGrowthGlobal0: '0xf3058399',    // feeGrowthGlobal0X128()
  feeGrowthGlobal1: '0x46141319',    // feeGrowthGlobal1X128()
  ticks: '0xf30dba93',               // ticks(int24)
};

function padAddress(addr: string): string {
  return addr.toLowerCase().replace('0x', '').padStart(64, '0');
}

function padUint256(value: bigint): string {
  return value.toString(16).padStart(64, '0');
}

function padInt256(value: number): string {
  if (value >= 0) return value.toString(16).padStart(64, '0');
  // Two's complement 256-bit
  const u = (BigInt(value) + (1n << 256n)) & ((1n << 256n) - 1n);
  return u.toString(16).padStart(64, '0');
}

async function rpcCall(to: string, data: string): Promise<string> {
  const res = await fetch(HYPEREVM_RPC, {
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

async function getBalance(nftManager: string, account: string): Promise<number> {
  const data = SELECTORS.balanceOf + padAddress(account);
  const result = await rpcCall(nftManager, data);
  if (!result || result === '0x') return 0;
  return parseInt(result, 16);
}

async function getTokenId(nftManager: string, account: string, index: number): Promise<bigint> {
  const data = SELECTORS.tokenOfOwnerByIndex + padAddress(account) + padUint256(BigInt(index));
  const result = await rpcCall(nftManager, data);
  if (!result || result === '0x') return 0n;
  return BigInt(result);
}

interface PositionData {
  token0: string;
  token1: string;
  fee: number;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  tokensOwed0: bigint;
  tokensOwed1: bigint;
  feeGrowthInside0LastX128: bigint;
  feeGrowthInside1LastX128: bigint;
}

async function getPosition(nftManager: string, tokenId: bigint): Promise<PositionData | null> {
  const data = SELECTORS.positions + padUint256(tokenId);
  const result = await rpcCall(nftManager, data);

  if (!result || result === '0x' || result.length < 770) return null;

  const hex = result.startsWith('0x') ? result.slice(2) : result;
  const readWord = (i: number) => hex.slice(i * 64, (i + 1) * 64);
  const toAddress = (word: string) => '0x' + word.slice(24).toLowerCase();
  // int24 is sign-extended to 32 bytes in ABI encoding; decode from last 3 bytes
  const toInt24 = (word: string) => {
    const val = parseInt(word.slice(-6), 16);
    return val >= 0x800000 ? val - 0x1000000 : val;
  };

  // word 0: nonce, 1: operator, 2: token0, 3: token1, 4: fee,
  // 5: tickLower, 6: tickUpper, 7: liquidity, 8: feeGrowthInside0LastX128,
  // 9: feeGrowthInside1LastX128, 10: tokensOwed0, 11: tokensOwed1
  const token0 = toAddress(readWord(2));
  const token1 = toAddress(readWord(3));
  const fee = parseInt(readWord(4), 16);
  const tickLower = toInt24(readWord(5));
  const tickUpper = toInt24(readWord(6));
  const liquidity = BigInt('0x' + readWord(7));
  const feeGrowthInside0LastX128 = BigInt('0x' + readWord(8));
  const feeGrowthInside1LastX128 = BigInt('0x' + readWord(9));
  const tokensOwed0 = BigInt('0x' + readWord(10));
  const tokensOwed1 = BigInt('0x' + readWord(11));

  return { token0, token1, fee, tickLower, tickUpper, liquidity, tokensOwed0, tokensOwed1, feeGrowthInside0LastX128, feeGrowthInside1LastX128 };
}

async function fetchTokenInfo(tokenAddress: string): Promise<{ symbol: string; decimals: number }> {
  const known = KNOWN_TOKENS[tokenAddress.toLowerCase()];
  if (known) return { symbol: known.symbol, decimals: known.decimals };

  try {
    const [symResult, decResult] = await Promise.all([
      rpcCall(tokenAddress, SELECTORS.symbol),
      rpcCall(tokenAddress, SELECTORS.decimals),
    ]);

    let symbol = tokenAddress.slice(0, 8);
    if (symResult && symResult.length > 130) {
      const hex = symResult.startsWith('0x') ? symResult.slice(2) : symResult;
      const strLen = parseInt(hex.slice(64, 128), 16);
      const strHex = hex.slice(128, 128 + strLen * 2);
      let s = '';
      for (let i = 0; i < strHex.length; i += 2) {
        const c = parseInt(strHex.slice(i, i + 2), 16);
        if (c > 0) s += String.fromCharCode(c);
      }
      if (s) symbol = s;
    } else if (symResult && symResult !== '0x' && symResult.length === 66) {
      // bytes32 encoded symbol (short string without length prefix)
      const hex = symResult.startsWith('0x') ? symResult.slice(2) : symResult;
      let s = '';
      for (let i = 0; i < 64; i += 2) {
        const c = parseInt(hex.slice(i, i + 2), 16);
        if (c > 0) s += String.fromCharCode(c);
        else break;
      }
      if (s) symbol = s;
    }

    const decimals = decResult && decResult !== '0x' ? parseInt(decResult, 16) : 18;
    return { symbol, decimals };
  } catch {
    return { symbol: tokenAddress.slice(2, 8).toUpperCase(), decimals: 18 };
  }
}

// Compute pending fees + amounts using actual pool sqrtPrice from slot0
const U256_MASK = (1n << 256n) - 1n;

interface PoolExtras {
  pending0: bigint;
  pending1: bigint;
  sqrtPriceX96: bigint;
  currentTick: number;
}

async function fetchPoolExtras(
  nftManager: string,
  knownFactory: string,
  pos: PositionData,
  factoryCache: Record<string, string>,
): Promise<PoolExtras> {
  const zero: PoolExtras = { pending0: 0n, pending1: 0n, sqrtPriceX96: 0n, currentTick: 0 };
  if (pos.liquidity === 0n) return zero;

  try {
    // Use hardcoded factory if available, otherwise fetch via factory() RPC call
    if (knownFactory) {
      factoryCache[nftManager] = knownFactory;
    } else if (!factoryCache[nftManager]) {
      const result = await rpcCall(nftManager, SELECTORS.factory);
      if (!result || result === '0x') {
        console.error(`[HyperSwap] factory() failed for manager ${nftManager}: ${result}`);
        return zero;
      }
      factoryCache[nftManager] = '0x' + result.slice(-40);
    }
    const factory = factoryCache[nftManager];

    // Get pool address from factory
    const getPoolData = SELECTORS.getPool + padAddress(pos.token0) + padAddress(pos.token1) + padUint256(BigInt(pos.fee));
    const poolResult = await rpcCall(factory, getPoolData);
    if (!poolResult || poolResult === '0x') {
      console.error(`[HyperSwap] getPool() failed for factory ${factory}, pair ${pos.token0}/${pos.token1} fee ${pos.fee}: ${poolResult}`);
      return zero;
    }
    const poolAddress = '0x' + poolResult.slice(-40);
    if (poolAddress === '0x0000000000000000000000000000000000000000') {
      console.error(`[HyperSwap] pool not found for pair ${pos.token0}/${pos.token1} fee ${pos.fee} in factory ${factory}`);
      return zero;
    }

    // Fetch pool state and tick data in parallel
    const [slot0Result, fg0Result, fg1Result, lowerResult, upperResult] = await Promise.all([
      rpcCall(poolAddress, SELECTORS.slot0),
      rpcCall(poolAddress, SELECTORS.feeGrowthGlobal0),
      rpcCall(poolAddress, SELECTORS.feeGrowthGlobal1),
      rpcCall(poolAddress, SELECTORS.ticks + padInt256(pos.tickLower)),
      rpcCall(poolAddress, SELECTORS.ticks + padInt256(pos.tickUpper)),
    ]);

    // Parse slot0: W0 = sqrtPriceX96 (uint160), W1 = tick (int24)
    if (!slot0Result || slot0Result.length < 130) {
      console.error(`[HyperSwap] slot0() bad response from pool ${poolAddress}: len=${slot0Result?.length} val=${slot0Result}`);
      return zero;
    }
    const s0hex = slot0Result.startsWith('0x') ? slot0Result.slice(2) : slot0Result;
    const sqrtPriceX96 = BigInt('0x' + s0hex.slice(0, 64));
    const tickWord = s0hex.slice(64, 128);
    const tickVal = parseInt(tickWord.slice(-6), 16);
    const currentTick = tickVal >= 0x800000 ? tickVal - 0x1000000 : tickVal;

    // Parse feeGrowthGlobal (full uint256 values)
    const fgGlobal0 = fg0Result && fg0Result !== '0x' ? BigInt(fg0Result) : 0n;
    const fgGlobal1 = fg1Result && fg1Result !== '0x' ? BigInt(fg1Result) : 0n;

    // Parse tick data: word[2]=feeGrowthOutside0X128, word[3]=feeGrowthOutside1X128
    const parseTick = (result: string, label: string) => {
      if (!result || result === '0x' || result.length < 258) {
        console.error(`[HyperSwap] ticks(${label}) bad response from pool ${poolAddress}: len=${result?.length} val=${result?.slice(0, 20)}`);
        return null;
      }
      const hex = result.startsWith('0x') ? result.slice(2) : result;
      return {
        feeGrowthOutside0: BigInt('0x' + hex.slice(128, 192)),
        feeGrowthOutside1: BigInt('0x' + hex.slice(192, 256)),
      };
    };

    const lowerData = parseTick(lowerResult, `lower=${pos.tickLower}`);
    const upperData = parseTick(upperResult, `upper=${pos.tickUpper}`);
    if (!lowerData || !upperData) return { ...zero, sqrtPriceX96, currentTick };

    // Uniswap V3 feeGrowthInside calculation
    const fgBelow0 = currentTick >= pos.tickLower
      ? lowerData.feeGrowthOutside0
      : (fgGlobal0 - lowerData.feeGrowthOutside0) & U256_MASK;
    const fgBelow1 = currentTick >= pos.tickLower
      ? lowerData.feeGrowthOutside1
      : (fgGlobal1 - lowerData.feeGrowthOutside1) & U256_MASK;

    const fgAbove0 = currentTick < pos.tickUpper
      ? upperData.feeGrowthOutside0
      : (fgGlobal0 - upperData.feeGrowthOutside0) & U256_MASK;
    const fgAbove1 = currentTick < pos.tickUpper
      ? upperData.feeGrowthOutside1
      : (fgGlobal1 - upperData.feeGrowthOutside1) & U256_MASK;

    const fgInside0 = (fgGlobal0 - fgBelow0 - fgAbove0) & U256_MASK;
    const fgInside1 = (fgGlobal1 - fgBelow1 - fgAbove1) & U256_MASK;

    // pending fees = liquidity * (feeGrowthInside - checkpoint) >> 128
    const pending0 = (pos.liquidity * ((fgInside0 - pos.feeGrowthInside0LastX128) & U256_MASK)) >> 128n;
    const pending1 = (pos.liquidity * ((fgInside1 - pos.feeGrowthInside1LastX128) & U256_MASK)) >> 128n;

    return { pending0, pending1, sqrtPriceX96, currentTick };
  } catch (err) {
    console.error(`[HyperSwap] fetchPoolExtras threw for manager ${nftManager}:`, err);
    return zero;
  }
}

function calculateAmounts(
  liquidity: bigint,
  sqrtPriceX96: bigint,
  tickLower: number,
  tickUpper: number,
  decimals0: number,
  decimals1: number,
): { amount0: number; amount1: number } {
  if (liquidity === 0n) return { amount0: 0, amount1: 0 };

  const sqrtPrice = Number(sqrtPriceX96) / 2 ** 96;
  const sqrtLower = Math.sqrt(1.0001 ** tickLower);
  const sqrtUpper = Math.sqrt(1.0001 ** tickUpper);
  const liq = Number(liquidity);

  let amount0 = 0;
  let amount1 = 0;

  if (sqrtPrice <= sqrtLower) {
    // Price below range — all token0
    amount0 = liq * (1 / sqrtLower - 1 / sqrtUpper);
  } else if (sqrtPrice >= sqrtUpper) {
    // Price above range — all token1
    amount1 = liq * (sqrtUpper - sqrtLower);
  } else {
    // Price in range
    amount0 = liq * (1 / sqrtPrice - 1 / sqrtUpper);
    amount1 = liq * (sqrtPrice - sqrtLower);
  }

  return {
    amount0: Math.max(0, amount0) / 10 ** decimals0,
    amount1: Math.max(0, amount1) / 10 ** decimals1,
  };
}

async function fetchPrices(coingeckoIds: string[]): Promise<Record<string, number>> {
  return fetchCachedCoinGeckoPrices(coingeckoIds);
}

interface PoolStats { apy: number; tvlUsd: number; volumeUsd1d: number }

async function fetchHyperSwapPoolData(): Promise<{
  apys: Record<string, number>;
  stats: Record<string, { tvlUsd: number; volumeUsd1d: number }>;
}> {
  try {
    const res = await fetch('https://yields.llama.fi/pools', { next: { revalidate: 300 } });
    const data = await res.json();
    const pools: Array<{
      project: string; chain: string; apyBase?: number; apy?: number;
      tvlUsd?: number; volumeUsd1d?: number; underlyingTokens?: string[];
    }> = (data.data || []).filter(
      (p: { project: string; chain: string }) =>
        (p.project === 'hyperswap-v3' || p.project === 'kittenswap' || p.project === 'project-x') && p.chain === 'Hyperliquid L1',
    );

    const byKey: Record<string, PoolStats[]> = {};
    for (const pool of pools) {
      if ((pool.underlyingTokens?.length ?? 0) >= 2) {
        const key = (pool.underlyingTokens as string[]).map((t) => t.toLowerCase()).sort().join('-');
        if (!byKey[key]) byKey[key] = [];
        byKey[key].push({
          apy: pool.apyBase || pool.apy || 0,
          tvlUsd: pool.tvlUsd || 0,
          volumeUsd1d: pool.volumeUsd1d || 0,
        });
      }
    }

    const apys: Record<string, number> = {};
    const stats: Record<string, { tvlUsd: number; volumeUsd1d: number }> = {};
    for (const [key, entries] of Object.entries(byKey)) {
      const sorted = entries.slice().sort((a, b) => a.apy - b.apy);
      const mid = Math.floor(sorted.length / 2);
      apys[key] = Math.round((sorted.length % 2 ? sorted[mid].apy : (sorted[mid - 1].apy + sorted[mid].apy) / 2) * 100) / 100;
      // Sum TVL and volume across all fee tiers for same token pair
      stats[key] = {
        tvlUsd: entries.reduce((s, e) => s + e.tvlUsd, 0),
        volumeUsd1d: entries.reduce((s, e) => s + e.volumeUsd1d, 0),
      };
    }
    return { apys, stats };
  } catch {
    return { apys: {}, stats: {} };
  }
}

// Keep backward-compatible wrapper used internally
async function fetchHyperSwapAPYs(): Promise<Record<string, number>> {
  return (await fetchHyperSwapPoolData()).apys;
}

async function fetchPositionsForManager(
  nftManager: string,
  protocol: string,
  knownFactory: string,
  account: string,
): Promise<Array<{
  tokenId: bigint;
  pos: PositionData;
  protocol: string;
  nftManager: string;
  knownFactory: string;
}>> {
  try {
    const balance = await getBalance(nftManager, account);
    console.log(`[HyperSwap] ${protocol} balance for ${account}: ${balance}`);
    if (balance === 0) return [];

    const count = Math.min(balance, 50);
    const tokenIds: bigint[] = [];
    for (let i = 0; i < count; i++) {
      const id = await getTokenId(nftManager, account, i);
      if (id > 0n) tokenIds.push(id);
    }
    console.log(`[HyperSwap] ${protocol} tokenIds:`, tokenIds.map(String));

    const results: Array<{ tokenId: bigint; pos: PositionData; protocol: string; nftManager: string; knownFactory: string }> = [];
    await Promise.all(
      tokenIds.map(async (tokenId) => {
        const pos = await getPosition(nftManager, tokenId);
        if (pos) results.push({ tokenId, pos, protocol, nftManager, knownFactory });
      }),
    );
    return results;
  } catch (err) {
    console.error(`[HyperSwap] fetchPositionsForManager threw for ${protocol}:`, err);
    return [];
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const account = searchParams.get('account');

  if (!account) {
    return NextResponse.json({ error: 'Account address required' }, { status: 400 });
  }

  try {
    // Fetch from all position managers in parallel
    const allRaw = (await Promise.all(
      POSITION_MANAGERS.map(({ address, protocol, factory }) => fetchPositionsForManager(address, protocol, factory, account)),
    )).flat();

    if (allRaw.length === 0) {
      return NextResponse.json({ positions: [], count: 0, account });
    }

    // Collect all unique token addresses for metadata + prices
    const allTokenAddrs = [...new Set(allRaw.flatMap(({ pos }) => [pos.token0, pos.token1]))];
    const tokenInfoMap: Record<string, { symbol: string; decimals: number; coingeckoId: string }> = {};
    await Promise.all(
      allTokenAddrs.map(async (addr) => {
        const known = KNOWN_TOKENS[addr.toLowerCase()];
        if (known) {
          tokenInfoMap[addr] = known;
        } else {
          const info = await fetchTokenInfo(addr);
          tokenInfoMap[addr] = { ...info, coingeckoId: '' };
        }
      }),
    );

    const coingeckoIds = Object.values(tokenInfoMap).map((t) => t.coingeckoId).filter(Boolean);

    // Fetch pool state (sqrtPriceX96, currentTick) + pending fees for all positions
    // Shared factory cache avoids duplicate factory() RPC calls
    const factoryCache: Record<string, string> = {};
    const [prices, poolData, poolExtrasList] = await Promise.all([
      fetchPrices(coingeckoIds),
      fetchHyperSwapPoolData(),
      Promise.all(allRaw.map(({ pos, nftManager, knownFactory }) => fetchPoolExtras(nftManager, knownFactory, pos, factoryCache))),
    ]);
    const apyData = poolData.apys;
    const poolStatsData = poolData.stats;

    const positions = allRaw.map(({ tokenId, pos, protocol }, i) => {
      const t0Info = tokenInfoMap[pos.token0] || { symbol: pos.token0.slice(2, 8), decimals: 18, coingeckoId: '' };
      const t1Info = tokenInfoMap[pos.token1] || { symbol: pos.token1.slice(2, 8), decimals: 18, coingeckoId: '' };

      const { pending0, pending1, sqrtPriceX96, currentTick } = poolExtrasList[i];

      // Use actual sqrtPriceX96 from slot0 for precise amount calculation
      const { amount0, amount1 } = calculateAmounts(
        pos.liquidity, sqrtPriceX96, pos.tickLower, pos.tickUpper, t0Info.decimals, t1Info.decimals,
      );

      const price0 = t0Info.coingeckoId ? (prices[t0Info.coingeckoId] || 0) : 0;
      const price1 = t1Info.coingeckoId ? (prices[t1Info.coingeckoId] || 0) : 0;
      const value = amount0 * price0 + amount1 * price1;

      // Total fees = settled (tokensOwed) + pending (feeGrowthInside math)
      const fees0 = (Number(pos.tokensOwed0 + pending0)) / 10 ** t0Info.decimals;
      const fees1 = (Number(pos.tokensOwed1 + pending1)) / 10 ** t1Info.decimals;
      const feesUsd = fees0 * price0 + fees1 * price1;

      // APY + pool stats lookup: try both position token addresses and WHYPE alias for native HYPE
      const HYPE_NATIVE = '0x5555555555555555555555555555555555555555';
      const WHYPE = '0xadcb2f358eae6492f61a5f87eb8893d09391d160';
      const normalizeForApy = (addr: string) => addr.toLowerCase() === HYPE_NATIVE ? WHYPE : addr.toLowerCase();
      const apyKey = [pos.token0, pos.token1].map(normalizeForApy).sort().join('-');
      const apyKeyRaw = [pos.token0, pos.token1].map((t) => t.toLowerCase()).sort().join('-');
      const apy = apyData[apyKey] || apyData[apyKeyRaw] || 0;
      const poolStats = poolStatsData[apyKey] || poolStatsData[apyKeyRaw] || null;

      // Range status from actual currentTick
      const status = pos.liquidity === 0n
        ? 'Closed'
        : (currentTick >= pos.tickLower && currentTick < pos.tickUpper ? 'In Range' : 'Out of Range');

      return {
        id: `hyperswap-${protocol.toLowerCase()}-${tokenId.toString()}`,
        pair: `${t0Info.symbol} / ${t1Info.symbol}`,
        protocol,
        chain: 'HyperEVM',
        value: Math.round(value * 100) / 100,
        apy,
        fees: Math.round(feesUsd * 100) / 100,
        status: status as 'In Range' | 'Out of Range' | 'Closed',
        tokenId: tokenId.toString(),
        fee: pos.fee / 10000,
        amount0: Math.round(amount0 * 1_000_000) / 1_000_000,
        amount1: Math.round(amount1 * 1_000_000) / 1_000_000,
        token0Symbol: t0Info.symbol,
        token1Symbol: t1Info.symbol,
        fees0: Math.round(fees0 * 1_000_000) / 1_000_000,
        fees1: Math.round(fees1 * 1_000_000) / 1_000_000,
        tickLower: pos.tickLower,
        tickUpper: pos.tickUpper,
        token0Decimals: t0Info.decimals,
        token1Decimals: t1Info.decimals,
        liquidity: pos.liquidity.toString(),
        price0,
        price1,
        walletAddress: account,
        token0Address: pos.token0,
        token1Address: pos.token1,
        ...(poolStats ? { poolTvl: Math.round(poolStats.tvlUsd), pool24hVolume: Math.round(poolStats.volumeUsd1d) } : {}),
      };
    });

    return NextResponse.json({ positions, count: positions.length, account });
  } catch (error) {
    console.error('[HyperSwap] route error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch HyperSwap positions', details: String(error) },
      { status: 500 },
    );
  }
}
