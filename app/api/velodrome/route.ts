import { NextResponse } from 'next/server';

const ALCHEMY_KEY = process.env.NEXT_PUBLIC_ALCHEMY_KEY;
const OPTIMISM_RPC = `https://opt-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`;

const SUGAR_ADDRESS = '0xb8a82f0334e43c2eb0ab5d799036965f7bf07ba8';

const FIELDS_PER_POSITION = 15;

// Known token addresses on Optimism
const TOKENS: Record<string, { symbol: string; decimals: number; coingeckoId: string }> = {
  '0x4200000000000000000000000000000000000006': { symbol: 'WETH', decimals: 18, coingeckoId: 'ethereum' },
  '0x0b2c639c533813f4aa9d7837caf62653d097ff85': { symbol: 'USDC', decimals: 6, coingeckoId: 'usd-coin' },
  '0x7f5c764cbc14f9669b88837ca1490cca17c31607': { symbol: 'USDC.e', decimals: 6, coingeckoId: 'usd-coin' },
  '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58': { symbol: 'USDT', decimals: 6, coingeckoId: 'tether' },
  '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1': { symbol: 'DAI', decimals: 18, coingeckoId: 'dai' },
  '0x68f180fcce6836688e9084f035309e29bf0a2095': { symbol: 'WBTC', decimals: 8, coingeckoId: 'bitcoin' },
  '0x4200000000000000000000000000000000000042': { symbol: 'OP', decimals: 18, coingeckoId: 'optimism' },
  '0x3c8b650257cfb5f272f799f5e2b4e65093a11a05': { symbol: 'VELO', decimals: 18, coingeckoId: 'velodrome-finance' },
  '0x1f32b1c2345538c0c6f582fcb022739c4a194ebb': { symbol: 'wstETH', decimals: 18, coingeckoId: 'wrapped-steth' },
  '0x9560e827af36c94d2ac33a39bce1fe78631088db': { symbol: 'VELO', decimals: 18, coingeckoId: 'velodrome-finance' },
};

function padUint256(value: bigint): string {
  return value.toString(16).padStart(64, '0');
}

function padAddress(addr: string): string {
  return addr.toLowerCase().replace('0x', '').padStart(64, '0');
}

// Fetch token0 and token1 addresses from a CL pool contract
async function getPoolTokens(poolAddress: string): Promise<{ token0: string; token1: string } | null> {
  try {
    // token0() selector: 0x0dfe1681
    const res0 = await fetch(OPTIMISM_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_call',
        params: [{ to: poolAddress, data: '0x0dfe1681' }, 'latest'],
        id: 1,
      }),
    });
    const r0 = await res0.json();

    // token1() selector: 0xd21220a7
    const res1 = await fetch(OPTIMISM_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_call',
        params: [{ to: poolAddress, data: '0xd21220a7' }, 'latest'],
        id: 2,
      }),
    });
    const r1 = await res1.json();

    if (r0.result && r1.result) {
      return {
        token0: '0x' + r0.result.slice(26).toLowerCase(),
        token1: '0x' + r1.result.slice(26).toLowerCase(),
      };
    }
  } catch (err) {
    console.error('Error fetching pool tokens:', err);
  }
  return null;
}

// Fetch prices from CoinGecko
async function fetchPrices(): Promise<Record<string, number>> {
  try {
    const ids = [...new Set(Object.values(TOKENS).map(t => t.coingeckoId))].join(',');
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`,
      { next: { revalidate: 60 } }
    );
    const data = await res.json();
    const prices: Record<string, number> = {};
    for (const [addr, token] of Object.entries(TOKENS)) {
      prices[addr] = data[token.coingeckoId]?.usd || 0;
    }
    return prices;
  } catch {
    // Fallback prices
    return {
      '0x4200000000000000000000000000000000000006': 2700,
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 1,
      '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf': 96000,
    };
  }
}

// Fetch APY data from DefiLlama yields API
async function fetchPoolAPYs(): Promise<Record<string, number>> {
  try {
    const res = await fetch('https://yields.llama.fi/pools', { next: { revalidate: 300 } });
    const data = await res.json();
    
    // Filter for Velodrome Slipstream (CL) pools on Optimism
    const aeroPools = data.data?.filter(
      (p: any) => (p.project === 'velodrome-slipstream' || p.project === 'velodrome-v1') && p.chain === 'Optimism'
    ) || [];
    
    // Build lookups by pool address AND by token pair (using median APY)
    const apyByPool: Record<string, number> = {};
    const apysByTokenPair: Record<string, number[]> = {};
    
    for (const pool of aeroPools) {
      // Map by pool address if available
      if (pool.pool) {
        const poolAddr = pool.pool.split('-')[0]?.toLowerCase();
        if (poolAddr) {
          apyByPool[poolAddr] = Math.round((pool.apyBase || pool.apy || 0) * 100) / 100;
        }
      }
      
      // Also collect by token pair for fallback matching
      if (pool.underlyingTokens && pool.underlyingTokens.length >= 2) {
        const key = pool.underlyingTokens
          .map((t: string) => t.toLowerCase())
          .sort()
          .join('-');
        if (!apysByTokenPair[key]) apysByTokenPair[key] = [];
        apysByTokenPair[key].push(pool.apyBase || pool.apy || 0);
      }
    }
    
    // For token pair fallback, use the median APY (avoids extreme outliers)
    const apyByTokenPair: Record<string, number> = {};
    for (const [key, apys] of Object.entries(apysByTokenPair)) {
      const sorted = apys.sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
      apyByTokenPair[key] = Math.round(median * 100) / 100;
    }
    
    return { ...apyByTokenPair, ...apyByPool };
  } catch (err) {
    console.error('Failed to fetch DefiLlama APY data:', err);
    return {};
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const account = searchParams.get('account');

  if (!account) {
    return NextResponse.json({ error: 'Account address required' }, { status: 400 });
  }

  if (!ALCHEMY_KEY) {
    return NextResponse.json({ error: 'Alchemy API key not configured' }, { status: 500 });
  }

  try {
    // 1. Fetch raw positions from Sugar contract
    // Velodrome Sugar V3 uses positions(uint256,uint256,address)
    // selector = 0xedbd33bf (no factory parameter unlike Aerodrome's positionsByFactory)
    const calldata = '0xedbd33bf'
      + padUint256(100n)
      + padUint256(0n)
      + padAddress(account);

    const response = await fetch(OPTIMISM_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_call',
        params: [{ to: SUGAR_ADDRESS, data: calldata }, 'latest'],
        id: 1,
      }),
    });

    const rpcResult = await response.json();

    if (rpcResult.error) {
      return NextResponse.json({ error: 'RPC call failed', details: rpcResult.error }, { status: 500 });
    }

    const hex = rpcResult.result;
    if (!hex || hex === '0x' || hex.length <= 130) {
      return NextResponse.json({ positions: [], count: 0, account });
    }

    const rawPositions = decodePositions(hex);

    if (rawPositions.length === 0) {
      return NextResponse.json({ positions: [], count: 0, account });
    }

    // 2. Fetch token info for each unique pool
    const uniquePools = [...new Set(rawPositions.map(p => p.lp))];
    const poolTokens: Record<string, { token0: string; token1: string }> = {};

    await Promise.all(
      uniquePools.map(async (pool) => {
        const tokens = await getPoolTokens(pool);
        if (tokens) poolTokens[pool] = tokens;
      })
    );

    // 3. Fetch live prices and APY data in parallel
    const [prices, apyData] = await Promise.all([
      fetchPrices(),
      fetchPoolAPYs(),
    ]);

    // 4. Transform to LPPosition format
    const positions = rawPositions.map((raw) => {
      const tokens = poolTokens[raw.lp];
      const t0Info = tokens ? TOKENS[tokens.token0] : null;
      const t1Info = tokens ? TOKENS[tokens.token1] : null;

      const t0Symbol = t0Info?.symbol || 'TOKEN0';
      const t1Symbol = t1Info?.symbol || 'TOKEN1';
      const t0Decimals = t0Info?.decimals || 18;
      const t1Decimals = t1Info?.decimals || 18;

      // Calculate token amounts (unstaked + staked)
      const amount0 = Number(BigInt(raw.amount0) + BigInt(raw.staked0)) / (10 ** t0Decimals);
      const amount1 = Number(BigInt(raw.amount1) + BigInt(raw.staked1)) / (10 ** t1Decimals);

      // Calculate fees earned
      const fees0 = Number(raw.unstaked_earned0) / (10 ** t0Decimals);
      const fees1 = Number(raw.unstaked_earned1) / (10 ** t1Decimals);

      // Get prices
      const price0 = tokens ? (prices[tokens.token0] || 0) : 0;
      const price1 = tokens ? (prices[tokens.token1] || 0) : 0;

      // Dollar values
      const value = (amount0 * price0) + (amount1 * price1);
      const feesUsd = (fees0 * price0) + (fees1 * price1);

      // Determine status: closed if all liquidity removed, otherwise check range
      const totalLiquidity = BigInt(raw.liquidity) + BigInt(raw.staked);
      const isClosed = totalLiquidity === 0n;
      const hasToken0 = amount0 > 0;
      const hasToken1 = amount1 > 0;
      const status = isClosed ? 'Closed' : (hasToken0 && hasToken1) ? 'In Range' : 'Out of Range';

      // Look up APY from DefiLlama data — try pool address first, then token pair
      const poolAddr = raw.lp.toLowerCase();
      const apyKey = tokens
        ? [tokens.token0, tokens.token1].map(t => t.toLowerCase()).sort().join('-')
        : '';
      const apy = apyData[poolAddr] || apyData[apyKey] || 0;

      return {
        id: `velo-${raw.id}`,
        pair: `${t0Symbol} / ${t1Symbol}`,
        protocol: 'Velodrome',
        chain: 'Optimism',
        value: Math.round(value * 100) / 100,
        apy,
        fees: Math.round(feesUsd * 100) / 100,
        status: status as 'In Range' | 'Out of Range' | 'Closed',
        // Extra fields for detail view
        depositId: raw.id,
        amount0: Math.round(amount0 * 1000000) / 1000000,
        amount1: Math.round(amount1 * 1000000) / 1000000,
        token0Symbol: t0Symbol,
        token1Symbol: t1Symbol,
        fees0: Math.round(fees0 * 1000000) / 1000000,
        fees1: Math.round(fees1 * 1000000) / 1000000,
        tickLower: raw.tick_lower,
        tickUpper: raw.tick_upper,
        token0Decimals: t0Decimals,
        token1Decimals: t1Decimals,
      };
    });

    return NextResponse.json({
      positions,
      count: positions.length,
      account,
    });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to fetch positions', details: String(error) },
      { status: 500 }
    );
  }
}

function decodePositions(hexData: string): RawPosition[] {
  const positions: RawPosition[] = [];
  const data = hexData.startsWith('0x') ? hexData.slice(2) : hexData;

  if (data.length < 128) return [];

  const arrayOffsetBytes = parseInt(data.slice(0, 64), 16);
  const arrayOffsetHex = arrayOffsetBytes * 2;
  const numElements = parseInt(data.slice(arrayOffsetHex, arrayOffsetHex + 64), 16);

  if (numElements === 0) return [];

  const dataStartHex = arrayOffsetHex + 64;

  for (let i = 0; i < numElements; i++) {
    try {
      const posStartHex = dataStartHex + i * FIELDS_PER_POSITION * 64;

      const readWord = (fieldIndex: number): string => {
        const start = posStartHex + fieldIndex * 64;
        const word = data.slice(start, start + 64);
        return word.length === 64 ? word : '0'.repeat(64);
      };

      const toAddress = (word: string): string => '0x' + word.slice(24);
      const toBigInt = (word: string): bigint => {
        if (!word || word === '0'.repeat(64)) return 0n;
        return BigInt('0x' + word);
      };
      const toSignedInt = (word: string): number => {
        const val = BigInt('0x' + word);
        const MAX = BigInt('0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
        if (val > MAX) return Number(val - BigInt('0x10000000000000000000000000000000000000000000000000000000000000000'));
        return Number(val);
      };

      const w = (i: number) => readWord(i);

      positions.push({
        id: toBigInt(w(0)).toString(),
        lp: toAddress(w(1)),
        liquidity: toBigInt(w(2)).toString(),
        staked: toBigInt(w(3)).toString(),
        amount0: toBigInt(w(4)).toString(),
        amount1: toBigInt(w(5)).toString(),
        staked0: toBigInt(w(6)).toString(),
        staked1: toBigInt(w(7)).toString(),
        unstaked_earned0: toBigInt(w(8)).toString(),
        unstaked_earned1: toBigInt(w(9)).toString(),
        emissions_earned: toBigInt(w(10)).toString(),
        tick_lower: toSignedInt(w(11)),
        tick_upper: toSignedInt(w(12)),
        sqrt_ratio_lower: toBigInt(w(13)).toString(),
        sqrt_ratio_upper: toBigInt(w(14)).toString(),
      });
    } catch (err) {
      console.error(`Error decoding position ${i}:`, err);
    }
  }

  return positions;
}

interface RawPosition {
  id: string;
  lp: string;
  liquidity: string;
  staked: string;
  amount0: string;
  amount1: string;
  staked0: string;
  staked1: string;
  unstaked_earned0: string;
  unstaked_earned1: string;
  emissions_earned: string;
  tick_lower: number;
  tick_upper: number;
  sqrt_ratio_lower: string;
  sqrt_ratio_upper: string;
}