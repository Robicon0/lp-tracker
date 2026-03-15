import { NextResponse } from 'next/server';
import { PublicKey } from '@solana/web3.js';

const HELIUS_KEY = process.env.HELIUS_API_KEY;
const SOLANA_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;

const RAYDIUM_CLMM_PROGRAM = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

// Known Solana tokens
const TOKENS: Record<string, { symbol: string; decimals: number; coingeckoId: string }> = {
  'So11111111111111111111111111111111111111112': { symbol: 'SOL', decimals: 9, coingeckoId: 'solana' },
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': { symbol: 'USDC', decimals: 6, coingeckoId: 'usd-coin' },
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': { symbol: 'USDT', decimals: 6, coingeckoId: 'tether' },
  '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R': { symbol: 'RAY', decimals: 6, coingeckoId: 'raydium' },
  '9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E': { symbol: 'WBTC', decimals: 6, coingeckoId: 'bitcoin' },
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So': { symbol: 'mSOL', decimals: 9, coingeckoId: 'msol' },
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs': { symbol: 'ETH', decimals: 8, coingeckoId: 'ethereum' },
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': { symbol: 'BONK', decimals: 5, coingeckoId: 'bonk' },
};

async function solanaRpc(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(SOLANA_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json();
  return json.result;
}

const TOKEN_PROGRAM_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

type TokenAccountsResult = {
  value: Array<{
    account: { data: { parsed: { info: { tokenAmount: { amount: string; decimals: number }; mint: string } } } };
  }>;
} | null;

// Get all NFT mints owned by account (amount=1, decimals=0) — checks both TOKEN_PROGRAM and TOKEN_PROGRAM_2022
async function getNftMints(account: string): Promise<string[]> {
  const [result1, result2] = await Promise.all([
    solanaRpc('getTokenAccountsByOwner', [account, { programId: TOKEN_PROGRAM }, { encoding: 'jsonParsed' }]) as Promise<TokenAccountsResult>,
    solanaRpc('getTokenAccountsByOwner', [account, { programId: TOKEN_PROGRAM_2022 }, { encoding: 'jsonParsed' }]) as Promise<TokenAccountsResult>,
  ]);

  const allAccounts = [...(result1?.value ?? []), ...(result2?.value ?? [])];

  return allAccounts
    .filter((ta) => {
      const info = ta.account.data.parsed.info;
      return info.tokenAmount.amount === '1' && info.tokenAmount.decimals === 0;
    })
    .map((ta) => ta.account.data.parsed.info.mint);
}

// Read u128 little-endian from buffer at offset
function readU128LE(buf: Buffer, offset: number): bigint {
  let val = 0n;
  for (let i = 0; i < 16; i++) {
    val |= BigInt(buf[offset + i]) << BigInt(i * 8);
  }
  return val;
}

// Read u64 little-endian from buffer at offset
function readU64LE(buf: Buffer, offset: number): bigint {
  let val = 0n;
  for (let i = 0; i < 8; i++) {
    val |= BigInt(buf[offset + i]) << BigInt(i * 8);
  }
  return val;
}

// Read i32 little-endian from buffer at offset
function readI32LE(buf: Buffer, offset: number): number {
  const val = buf.readInt32LE(offset);
  return val;
}

// Read Solana public key (32 bytes) as base58 string
function readPubkey(buf: Buffer, offset: number): string {
  return new PublicKey(buf.subarray(offset, offset + 32)).toBase58();
}

interface RawRaydiumPosition {
  nftMint: string;
  poolId: string;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  tokenFeesOwed0: bigint;
  tokenFeesOwed1: bigint;
}

interface RaydiumPoolData {
  tokenMint0: string;
  tokenMint1: string;
  mintDecimals0: number;
  mintDecimals1: number;
  tickCurrent: number;
  liquidity: bigint;
}

// Fetch and decode Raydium CLMM personal position account for a given NFT mint
async function fetchRaydiumPosition(nftMint: string): Promise<RawRaydiumPosition | null> {
  const mintPubkey = new PublicKey(nftMint);
  const mintBase58 = mintPubkey.toBase58();

  const result = await solanaRpc('getProgramAccounts', [
    RAYDIUM_CLMM_PROGRAM,
    {
      encoding: 'base64',
      filters: [
        { memcmp: { offset: 8, bytes: mintBase58 } },
      ],
    },
  ]) as Array<{ pubkey: string; account: { data: [string, string] } }> | null;

  if (!result || result.length === 0) return null;

  const data = Buffer.from(result[0].account.data[0], 'base64');
  if (data.length < 144) return null;

  // Raydium CLMM PersonalPositionState layout:
  // [0..8]   discriminator
  // [8..40]  nftMint (pubkey)
  // [40..72] poolId (pubkey)
  // [72..76] tickLower (i32 LE)
  // [76..80] tickUpper (i32 LE)
  // [80..96] liquidity (u128 LE)
  // [96..112]  feeGrowthInside0LastX64 (u128)
  // [112..128] feeGrowthInside1LastX64 (u128)
  // [128..136] tokenFeesOwed0 (u64 LE)
  // [136..144] tokenFeesOwed1 (u64 LE)

  const liquidity = readU128LE(data, 80);

  return {
    nftMint,
    poolId: readPubkey(data, 40),
    tickLower: readI32LE(data, 72),
    tickUpper: readI32LE(data, 76),
    liquidity,
    tokenFeesOwed0: readU64LE(data, 128),
    tokenFeesOwed1: readU64LE(data, 136),
  };
}

// Fetch and decode Raydium CLMM pool account
async function fetchRaydiumPool(poolId: string): Promise<RaydiumPoolData | null> {
  const result = await solanaRpc('getAccountInfo', [
    poolId,
    { encoding: 'base64' },
  ]) as { value: { data: [string, string] } | null } | null;

  if (!result?.value?.data) return null;

  const data = Buffer.from(result.value.data[0], 'base64');
  if (data.length < 280) return null;

  // Raydium CLMM PoolState layout:
  // [0..8]    discriminator
  // [8..40]   ammConfig (pubkey)
  // [40..72]  owner (pubkey)
  // [72..104] tokenMint0 (pubkey)
  // [104..136] tokenMint1 (pubkey)
  // [136..168] tokenVault0 (pubkey)
  // [168..200] tokenVault1 (pubkey)
  // [200..232] observationId (pubkey)
  // [232]     mintDecimals0 (u8)
  // [233]     mintDecimals1 (u8)
  // [234..236] tickSpacing (u16 LE)
  // [236..252] liquidity (u128 LE)
  // [252..268] sqrtPriceX64 (u128 LE)
  // [268..272] tickCurrent (i32 LE)

  return {
    tokenMint0: readPubkey(data, 72),
    tokenMint1: readPubkey(data, 104),
    mintDecimals0: data[232],
    mintDecimals1: data[233],
    tickCurrent: readI32LE(data, 268),
    liquidity: readU128LE(data, 236),
  };
}

// Calculate token amounts from liquidity and ticks (Uniswap V3 / CLMM math)
function calculateAmounts(
  liquidity: bigint,
  tickLower: number,
  tickUpper: number,
  tickCurrent: number,
  decimals0: number,
  decimals1: number
): { amount0: number; amount1: number } {
  if (liquidity === 0n) return { amount0: 0, amount1: 0 };

  const sqrtLower = Math.sqrt(1.0001 ** tickLower);
  const sqrtUpper = Math.sqrt(1.0001 ** tickUpper);
  const sqrtCurrent = Math.sqrt(1.0001 ** tickCurrent);

  const liq = Number(liquidity);
  let amount0 = 0;
  let amount1 = 0;

  if (tickCurrent < tickLower) {
    // Entirely token0
    amount0 = liq * (1 / sqrtLower - 1 / sqrtUpper);
  } else if (tickCurrent >= tickUpper) {
    // Entirely token1
    amount1 = liq * (sqrtUpper - sqrtLower);
  } else {
    // In range — both tokens
    amount0 = liq * (1 / sqrtCurrent - 1 / sqrtUpper);
    amount1 = liq * (sqrtCurrent - sqrtLower);
  }

  return {
    amount0: Math.max(0, amount0) / 10 ** decimals0,
    amount1: Math.max(0, amount1) / 10 ** decimals1,
  };
}

async function fetchPrices(): Promise<Record<string, number>> {
  try {
    const ids = [...new Set(Object.values(TOKENS).map((t) => t.coingeckoId))].join(',');
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`,
      { next: { revalidate: 60 } }
    );
    const data = await res.json();
    const prices: Record<string, number> = {};
    for (const [mint, token] of Object.entries(TOKENS)) {
      prices[mint] = data[token.coingeckoId]?.usd || 0;
    }
    return prices;
  } catch {
    return {};
  }
}

interface DasTokenInfo {
  symbol: string;
  decimals: number;
  price: number;
}

async function fetchDasTokenInfo(mints: string[]): Promise<Record<string, DasTokenInfo>> {
  if (mints.length === 0) return {};
  try {
    const res = await fetch(SOLANA_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAssetBatch', params: { ids: mints } }),
    });
    const json = await res.json();
    const result: Record<string, DasTokenInfo> = {};
    for (const asset of json.result || []) {
      if (!asset?.id) continue;
      const symbol = asset.content?.metadata?.symbol || asset.id.slice(0, 6);
      const decimals = asset.token_info?.decimals ?? 9;
      const price = asset.token_info?.price_per_token ?? 0;
      result[asset.id] = { symbol, decimals, price };
    }
    return result;
  } catch {
    return {};
  }
}

interface RaydiumPoolStats {
  feeAprWeek: number; // percentage (e.g. 12.34 = 12.34%)
  tvl: number;        // USD
}

// Fetch per-pool APY + TVL from Raydium's own API (keyed by pool id)
async function fetchRaydiumPoolStats(): Promise<Record<string, RaydiumPoolStats>> {
  try {
    const res = await fetch('https://api.raydium.io/v2/ammV3/ammPools', { next: { revalidate: 300 } });
    const data = await res.json();
    const stats: Record<string, RaydiumPoolStats> = {};
    for (const pool of data.data || []) {
      if (pool.id && pool.week?.feeApr != null && pool.tvl != null) {
        stats[pool.id] = { feeAprWeek: pool.week.feeApr, tvl: pool.tvl };
      }
    }
    return stats;
  } catch {
    return {};
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const account = searchParams.get('account');

  if (!account) {
    return NextResponse.json({ error: 'Account address required' }, { status: 400 });
  }

  if (!HELIUS_KEY) {
    return NextResponse.json({ error: 'Helius API key not configured' }, { status: 500 });
  }

  try {
    // 1. Find all NFT mints owned by the wallet
    const nftMints = await getNftMints(account);
    if (nftMints.length === 0) {
      return NextResponse.json({ positions: [], count: 0, account });
    }

    // 2. Fetch Raydium position accounts for each NFT (in parallel)
    const rawPositions = (
      await Promise.all(nftMints.map((mint) => fetchRaydiumPosition(mint)))
    ).filter((p): p is RawRaydiumPosition => p !== null);

    if (rawPositions.length === 0) {
      return NextResponse.json({ positions: [], count: 0, account });
    }

    // 3. Fetch unique pool data
    const uniquePools = [...new Set(rawPositions.map((p) => p.poolId))];
    const poolDataMap: Record<string, RaydiumPoolData> = {};
    await Promise.all(
      uniquePools.map(async (poolId) => {
        const pool = await fetchRaydiumPool(poolId);
        if (pool) poolDataMap[poolId] = pool;
      })
    );

    // Collect unknown mints for DAS lookup
    const allMints = new Set<string>();
    for (const pool of Object.values(poolDataMap)) {
      allMints.add(pool.tokenMint0);
      allMints.add(pool.tokenMint1);
    }
    const unknownMints = [...allMints].filter((m) => !TOKENS[m]);

    // 4. Fetch prices + Raydium pool stats + DAS token info in parallel
    const [prices, raydiumPoolStats, dasTokens] = await Promise.all([
      fetchPrices(),
      fetchRaydiumPoolStats(),
      fetchDasTokenInfo(unknownMints),
    ]);

    // Merge DAS prices for tokens not in TOKENS
    const allPrices: Record<string, number> = { ...prices };
    for (const [mint, info] of Object.entries(dasTokens)) {
      if (!allPrices[mint] && info.price > 0) allPrices[mint] = info.price;
    }

    // 5. Transform to shared position shape
    const positions = rawPositions.map((pos) => {
      const pool = poolDataMap[pos.poolId];
      const t0Known = pool ? TOKENS[pool.tokenMint0] : null;
      const t1Known = pool ? TOKENS[pool.tokenMint1] : null;
      const t0Das = pool ? dasTokens[pool.tokenMint0] : null;
      const t1Das = pool ? dasTokens[pool.tokenMint1] : null;

      const t0Symbol = t0Known?.symbol || t0Das?.symbol || 'TOKEN0';
      const t1Symbol = t1Known?.symbol || t1Das?.symbol || 'TOKEN1';
      const t0Decimals = pool?.mintDecimals0 ?? t0Known?.decimals ?? t0Das?.decimals ?? 9;
      const t1Decimals = pool?.mintDecimals1 ?? t1Known?.decimals ?? t1Das?.decimals ?? 9;

      const { amount0, amount1 } = pool
        ? calculateAmounts(pos.liquidity, pos.tickLower, pos.tickUpper, pool.tickCurrent, t0Decimals, t1Decimals)
        : { amount0: 0, amount1: 0 };

      const price0 = pool ? (allPrices[pool.tokenMint0] || 0) : 0;
      const price1 = pool ? (allPrices[pool.tokenMint1] || 0) : 0;

      const value = amount0 * price0 + amount1 * price1;

      const fees0 = Number(pos.tokenFeesOwed0) / 10 ** t0Decimals;
      const fees1 = Number(pos.tokenFeesOwed1) / 10 ** t1Decimals;
      const feesUsd = fees0 * price0 + fees1 * price1;

      const tickCurrent = pool?.tickCurrent ?? 0;
      const inRange = pos.liquidity > 0n && tickCurrent >= pos.tickLower && tickCurrent < pos.tickUpper;
      const status = pos.liquidity === 0n ? 'Closed' : inRange ? 'In Range' : 'Out of Range';

      // Position-specific APY: pool_feeApr × (pool_tvl / position_value) × (pos_liq / pool_liq)
      // Raydium API returns feeAprWeek as percentage (e.g. 12.34 = 12.34%)
      const poolStats = raydiumPoolStats[pos.poolId];
      let apy = 0;
      if (poolStats && value > 0 && pool && pool.liquidity > 0n) {
        const posLiqShare = Number(pos.liquidity) / Number(pool.liquidity);
        apy = Math.round(poolStats.feeAprWeek * (poolStats.tvl / value) * posLiqShare * 100) / 100;
      }

      return {
        id: `ray-${pos.nftMint}`,
        pair: `${t0Symbol} / ${t1Symbol}`,
        protocol: 'Raydium',
        chain: 'Solana',
        value: Math.round(value * 100) / 100,
        apy,
        fees: Math.round(feesUsd * 100) / 100,
        status: status as 'In Range' | 'Out of Range' | 'Closed',
        // Extra detail fields
        amount0: Math.round(amount0 * 1_000_000) / 1_000_000,
        amount1: Math.round(amount1 * 1_000_000) / 1_000_000,
        token0Symbol: t0Symbol,
        token1Symbol: t1Symbol,
        fees0: Math.round(fees0 * 1_000_000) / 1_000_000,
        fees1: Math.round(fees1 * 1_000_000) / 1_000_000,
        tickLower: pos.tickLower,
        tickUpper: pos.tickUpper,
        token0Decimals: t0Decimals,
        token1Decimals: t1Decimals,
        liquidity: pos.liquidity.toString(),
        price0,
        price1,
      };
    });

    return NextResponse.json({ positions, count: positions.length, account });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to fetch Raydium positions', details: String(error) },
      { status: 500 }
    );
  }
}
