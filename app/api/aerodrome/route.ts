import { NextResponse } from 'next/server';

const ALCHEMY_KEY = process.env.NEXT_PUBLIC_ALCHEMY_KEY;
const BASE_RPC = `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`;

const SUGAR_ADDRESS = '0x68c19e13618c41158fe4baba1b8fb3a9c74bdb0a';
const CL_FACTORY = '0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A';

const FIELDS_PER_POSITION = 15;

// Known token addresses on Base
const TOKENS: Record<string, { symbol: string; decimals: number; coingeckoId: string }> = {
  '0x4200000000000000000000000000000000000006': { symbol: 'WETH', decimals: 18, coingeckoId: 'ethereum' },
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { symbol: 'USDC', decimals: 6, coingeckoId: 'usd-coin' },
  '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf': { symbol: 'cbBTC', decimals: 8, coingeckoId: 'bitcoin' },
  '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': { symbol: 'DAI', decimals: 18, coingeckoId: 'dai' },
  '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': { symbol: 'USDbC', decimals: 6, coingeckoId: 'usd-coin' },
  '0x940181a94a35a4569e4529a3cdfb74e38fd98631': { symbol: 'AERO', decimals: 18, coingeckoId: 'aerodrome-finance' },
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
    const res0 = await fetch(BASE_RPC, {
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
    const res1 = await fetch(BASE_RPC, {
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
    
    // Filter for Aerodrome Slipstream (CL) pools on Base
    const aeroPools = data.data?.filter(
      (p: any) => (p.project === 'aerodrome-slipstream' || p.project === 'aerodrome-v1') && p.chain === 'Base'
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
    const calldata = '0x0d0154a9'
      + padUint256(100n)
      + padUint256(0n)
      + padAddress(account)
      + padAddress(CL_FACTORY);

    const response = await fetch(BASE_RPC, {
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

      // Determine if in range (tick_lower <= current_tick <= tick_upper)
      // If liquidity > 0, the position exists. We check if amounts on both sides > 0
      const hasToken0 = amount0 > 0;
      const hasToken1 = amount1 > 0;
      const status = (hasToken0 && hasToken1) ? 'In Range' : 'Out of Range';

      // Look up APY from DefiLlama data — try pool address first, then token pair
      const poolAddr = raw.lp.toLowerCase();
      const apyKey = tokens 
        ? [tokens.token0, tokens.token1].map(t => t.toLowerCase()).sort().join('-')
        : '';
      const apy = apyData[poolAddr] || apyData[apyKey] || 0;

      return {
        id: `aero-${raw.id}`,
        pair: `${t0Symbol} / ${t1Symbol}`,
        protocol: 'Aerodrome',
        chain: 'Base',
        value: Math.round(value * 100) / 100,
        apy,
        fees: Math.round(feesUsd * 100) / 100,
        status: status as 'In Range' | 'Out of Range',
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