import { NextResponse } from 'next/server';

const SUI_RPC = process.env.SUI_RPC_URL || 'https://fullnode.mainnet.sui.io:443';

// Bluefin spot CLMM position type on Sui mainnet
const BLUEFIN_POSITION_TYPE =
  '0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267::position::Position';

const KNOWN_COINS: Record<string, { symbol: string; name: string; decimals: number; coingeckoId: string }> = {
  '0x2::sui::SUI': { symbol: 'SUI', name: 'Sui', decimals: 9, coingeckoId: 'sui' },
  '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC': { symbol: 'USDC', name: 'USD Coin', decimals: 6, coingeckoId: 'usd-coin' },
  '0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN': { symbol: 'USDT', name: 'Tether USD', decimals: 6, coingeckoId: 'tether' },
  '0xaf8cd5edc19c4512f4259f0bee101a40d41ebed738ade5874359610ef8eeced5::coin::COIN': { symbol: 'WETH', name: 'Wrapped Ether', decimals: 8, coingeckoId: 'ethereum' },
  '0x027792d9fed7f9844eb4839566001bb6f6cb4804f66aa2da6fe1ee242d896881::coin::COIN': { symbol: 'WBTC', name: 'Wrapped Bitcoin', decimals: 8, coingeckoId: 'bitcoin' },
  '0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN': { symbol: 'wUSDC', name: 'Wormhole USDC', decimals: 6, coingeckoId: 'usd-coin' },
  '0x06864a6f921804860930db6ddbe2e16acdf8504495ea7481637a1c8b9a8fe54b::cetus::CETUS': { symbol: 'CETUS', name: 'Cetus Protocol', decimals: 9, coingeckoId: 'cetus-protocol' },
};

async function suiRpc(method: string, params: unknown[]) {
  const res = await fetch(SUI_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json();
  return json.result;
}

function bitsToI32(bits: number): number {
  return bits > 2147483647 ? bits - 4294967296 : bits;
}

// Bluefin returns coin types without 0x prefix (e.g. "2::sui::SUI")
// Normalize to the standard 0x-prefixed short form used in KNOWN_COINS
function normalizeCoinType(ct: string): string {
  if (!ct) return ct;
  const prefixed = ct.startsWith('0x') ? ct : `0x${ct}`;
  // Convert padded hex address to short form: 0x000...002 -> 0x2
  return prefixed.replace(/^0x0+([0-9a-f]+::)/, '0x$1');
}

// I32 struct from Bluefin/Sui comes as { type: "...::i32::I32", fields: { bits: N } }
function extractI32Bits(val: unknown): number {
  if (val == null) return 0;
  const v = val as Record<string, unknown>;
  if (typeof v.bits === 'number') return v.bits;             // flat { bits: N }
  const fields = v.fields as Record<string, unknown> | undefined;
  if (fields && typeof fields.bits === 'number') return fields.bits; // nested { fields: { bits: N } }
  return 0;
}

function calculateAmounts(
  liquidity: bigint,
  tickLower: number,
  tickUpper: number,
  sqrtPriceCurrentX64: bigint,
  decimals0: number,
  decimals1: number,
): { amount0: number; amount1: number } {
  if (liquidity === 0n) return { amount0: 0, amount1: 0 };

  const sqrtLower = Math.sqrt(Math.pow(1.0001, tickLower));
  const sqrtUpper = Math.sqrt(Math.pow(1.0001, tickUpper));
  const sqrtCurrent = Number(sqrtPriceCurrentX64) / 2 ** 64;
  const liq = Number(liquidity);

  let amount0 = 0, amount1 = 0;
  if (sqrtCurrent <= sqrtLower) {
    amount0 = liq * (1 / sqrtLower - 1 / sqrtUpper);
  } else if (sqrtCurrent >= sqrtUpper) {
    amount1 = liq * (sqrtUpper - sqrtLower);
  } else {
    amount0 = liq * (1 / sqrtCurrent - 1 / sqrtUpper);
    amount1 = liq * (sqrtCurrent - sqrtLower);
  }

  return {
    amount0: Math.max(0, amount0) / 10 ** decimals0,
    amount1: Math.max(0, amount1) / 10 ** decimals1,
  };
}

async function fetchAllBluefinPositions(account: string): Promise<Array<Record<string, unknown>>> {
  const positions: Array<Record<string, unknown>> = [];
  let cursor: string | null = null;

  do {
    const result = await suiRpc('suix_getOwnedObjects', [
      account,
      {
        filter: { StructType: BLUEFIN_POSITION_TYPE },
        options: { showContent: true, showType: true },
      },
      cursor,
      50,
    ]) as { data: Array<{ data: { objectId: string; content: { fields: Record<string, unknown> } } }>; nextCursor: string | null; hasNextPage: boolean } | null;

    if (!result?.data) break;
    for (const item of result.data) {
      if (item?.data?.content?.fields) {
        positions.push({ objectId: item.data.objectId, ...item.data.content.fields });
      }
    }
    cursor = result.hasNextPage ? result.nextCursor : null;
  } while (cursor);

  return positions;
}

async function fetchPools(poolIds: string[]): Promise<Record<string, Record<string, unknown>>> {
  if (poolIds.length === 0) return {};
  const result = await suiRpc('sui_multiGetObjects', [
    poolIds,
    { showContent: true },
  ]) as Array<{ data: { objectId: string; content: { fields: Record<string, unknown> } } } | null> | null;

  const map: Record<string, Record<string, unknown>> = {};
  if (!result) return map;
  for (const item of result) {
    if (item?.data?.content?.fields) {
      map[item.data.objectId] = item.data.content.fields;
    }
  }
  return map;
}

async function fetchCoinMetadata(coinType: string): Promise<{ symbol: string; decimals: number; name: string } | null> {
  if (KNOWN_COINS[coinType]) {
    const k = KNOWN_COINS[coinType];
    return { symbol: k.symbol, decimals: k.decimals, name: k.name };
  }
  try {
    const result = await suiRpc('suix_getCoinMetadata', [coinType]) as
      { decimals: number; symbol: string; name: string } | null;
    if (result) return { decimals: result.decimals, symbol: result.symbol, name: result.name };
  } catch { /* ignore */ }
  return null;
}

async function fetchPrices(coinTypes: string[]): Promise<Record<string, number>> {
  const ids: string[] = [];
  const coinTypeToId: Record<string, string> = {};
  for (const ct of coinTypes) {
    const known = KNOWN_COINS[ct];
    if (known) { ids.push(known.coingeckoId); coinTypeToId[ct] = known.coingeckoId; }
  }
  if (ids.length === 0) return {};
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${[...new Set(ids)].join(',')}&vs_currencies=usd`,
      { next: { revalidate: 60 } },
    );
    const data = await res.json();
    const prices: Record<string, number> = {};
    for (const [ct, geckoId] of Object.entries(coinTypeToId)) {
      prices[ct] = data[geckoId]?.usd || 0;
    }
    return prices;
  } catch { return {}; }
}

// I32 package used for tick keys in the ticks Table
const I32_TYPE = '0x714a63a0dba6da4f017b42d5d0fb78867f18bcde904868e51d951a5a6f5b7f57::i32::I32';
const U128_MASK = (1n << 128n) - 1n;

function calcFeeGrowthInside(
  tickCurrent: number,
  tickLower: number,
  tickUpper: number,
  feeGrowthGlobal: bigint,
  tickLowerFeeGrowthOutside: bigint,
  tickUpperFeeGrowthOutside: bigint,
): bigint {
  const below = tickCurrent >= tickLower
    ? tickLowerFeeGrowthOutside
    : (feeGrowthGlobal - tickLowerFeeGrowthOutside) & U128_MASK;
  // Uniswap V3 / Orca style: outside when current < upper, else global - outside
  const above = tickCurrent < tickUpper
    ? tickUpperFeeGrowthOutside
    : (feeGrowthGlobal - tickUpperFeeGrowthOutside) & U128_MASK;
  return (feeGrowthGlobal - below - above) & U128_MASK;
}

// Bluefin uses Q64 scaling (same as Orca): fees = tokenFee + (delta * liquidity) >> 64
function calcPendingFees(
  tokenFee: bigint,
  feeGrowthInside: bigint,
  feeGrowthCheckpoint: bigint,
  liquidity: bigint,
): bigint {
  const delta = (feeGrowthInside - feeGrowthCheckpoint) & U128_MASK;
  return tokenFee + ((delta * liquidity) >> 64n);
}

// Extract the ticks Table object ID from pool fields
function getTicksTableId(poolFields: Record<string, unknown>): string | null {
  const tm = poolFields.ticks_manager as Record<string, unknown> | undefined;
  const tmFields = (tm?.fields as Record<string, unknown> | undefined) ?? tm;
  const ticks = tmFields?.ticks as Record<string, unknown> | undefined;
  const ticksFields = (ticks?.fields as Record<string, unknown> | undefined) ?? ticks;
  const id = ticksFields?.id as Record<string, unknown> | undefined;
  return (id?.id as string) || null;
}

// Fetch a single tick's fee_growth_outside values via dynamic field lookup
async function fetchTick(
  ticksTableId: string,
  tickIndex: number,
): Promise<{ feeGrowthOutsideA: bigint; feeGrowthOutsideB: bigint } | null> {
  try {
    const bits = tickIndex < 0 ? tickIndex + 4294967296 : tickIndex;
    const result = await suiRpc('suix_getDynamicFieldObject', [
      ticksTableId,
      { type: I32_TYPE, value: { bits } },
    ]) as { data: { content: { fields: Record<string, unknown> } } } | null;

    const contentFields = result?.data?.content?.fields;
    if (!contentFields) return null;
    const valueItem = contentFields.value as Record<string, unknown> | undefined;
    const tickFields = (valueItem?.fields as Record<string, unknown> | undefined) ?? valueItem;
    if (!tickFields) return null;

    return {
      feeGrowthOutsideA: BigInt((tickFields.fee_growth_outside_a as string) || '0'),
      feeGrowthOutsideB: BigInt((tickFields.fee_growth_outside_b as string) || '0'),
    };
  } catch {
    return null;
  }
}

interface BluefinPoolStats {
  apyBase: number; // annual fee APY % (e.g. 21.36)
  tvlUsd: number;  // USD
}

async function fetchBluefinAPYs(): Promise<Record<string, BluefinPoolStats>> {
  try {
    const res = await fetch('https://yields.llama.fi/pools', { next: { revalidate: 300 } });
    const data = await res.json();
    const pools = data.data?.filter(
      (p: { project: string; chain: string }) => p.project === 'bluefin-spot' && p.chain === 'Sui',
    ) || [];

    const statsByPair: Record<string, { apys: number[]; tvls: number[] }> = {};
    for (const pool of pools) {
      if (pool.underlyingTokens?.length >= 2) {
        const key = pool.underlyingTokens
          .map((t: string) => normalizeCoinType(t).toLowerCase())
          .sort()
          .join('-');
        if (!statsByPair[key]) statsByPair[key] = { apys: [], tvls: [] };
        statsByPair[key].apys.push(pool.apyBase || pool.apy || 0);
        statsByPair[key].tvls.push(pool.tvlUsd || 0);
      }
    }

    const result: Record<string, BluefinPoolStats> = {};
    for (const [key, { apys, tvls }] of Object.entries(statsByPair)) {
      const sorted = apys.sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      const medianApy = Math.round(
        (sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2) * 100,
      ) / 100;
      const totalTvl = tvls.reduce((s, v) => s + v, 0);
      result[key] = { apyBase: medianApy, tvlUsd: totalTvl };
    }
    return result;
  } catch {
    return {};
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const account = searchParams.get('account');
  if (!account) return NextResponse.json({ error: 'account required' }, { status: 400 });

  try {
    const rawPositions = await fetchAllBluefinPositions(account);
    if (rawPositions.length === 0) return NextResponse.json({ positions: [], count: 0, account });

    // Bluefin coin types come without 0x prefix — normalize them first
    const rawWithNormalized: Array<Record<string, unknown>> = rawPositions.map((p) => ({
      ...p,
      coin_type_a: normalizeCoinType(p.coin_type_a as string),
      coin_type_b: normalizeCoinType(p.coin_type_b as string),
    }));

    const poolIds = [...new Set(rawWithNormalized.map((p) => p.pool_id as string).filter(Boolean))];
    const coinTypes = [...new Set(rawWithNormalized.flatMap((p) => [
      p.coin_type_a as string,
      p.coin_type_b as string,
    ]).filter(Boolean))];

    const [poolMap, apyData, priceData] = await Promise.all([
      fetchPools(poolIds),
      fetchBluefinAPYs(),
      fetchPrices(coinTypes),
    ]);

    const coinMetaMap: Record<string, { symbol: string; decimals: number; name: string }> = {};
    await Promise.all(
      coinTypes.map(async (ct) => {
        const meta = await fetchCoinMetadata(ct);
        if (meta) coinMetaMap[ct] = meta;
      }),
    );

    // Build ticks table ID map per pool
    const poolTicksTableIds: Record<string, string> = {};
    for (const [poolId, poolFields] of Object.entries(poolMap)) {
      const tableId = getTicksTableId(poolFields);
      if (tableId) poolTicksTableIds[poolId] = tableId;
    }

    // Collect unique (tableId, tickIndex) pairs needed across all positions
    const ticksToFetch = new Set<string>();
    for (const pos of rawWithNormalized) {
      const tableId = poolTicksTableIds[pos.pool_id as string];
      if (!tableId) continue;
      const tl = bitsToI32(extractI32Bits(pos.lower_tick));
      const tu = bitsToI32(extractI32Bits(pos.upper_tick));
      ticksToFetch.add(`${tableId}:${tl}`);
      ticksToFetch.add(`${tableId}:${tu}`);
    }

    // Fetch all needed ticks in parallel
    const tickDataMap: Record<string, { feeGrowthOutsideA: bigint; feeGrowthOutsideB: bigint }> = {};
    await Promise.all(
      [...ticksToFetch].map(async (key) => {
        const colonIdx = key.indexOf(':');
        const tableId = key.slice(0, colonIdx);
        const tickIdx = parseInt(key.slice(colonIdx + 1));
        const data = await fetchTick(tableId, tickIdx);
        if (data) tickDataMap[key] = data;
      }),
    );

    const positions = rawWithNormalized.map((pos) => {
      const poolId = pos.pool_id as string;
      const pool = poolMap[poolId];
      const coinTypeA = pos.coin_type_a as string;
      const coinTypeB = pos.coin_type_b as string;
      const metaA = coinMetaMap[coinTypeA];
      const metaB = coinMetaMap[coinTypeB];

      const symbolA = metaA?.symbol || coinTypeA.split('::').pop() || 'TOKEN_A';
      const symbolB = metaB?.symbol || coinTypeB.split('::').pop() || 'TOKEN_B';
      const decimalsA = metaA?.decimals ?? 9;
      const decimalsB = metaB?.decimals ?? 9;

      const liquidity = BigInt((pos.liquidity as string) || '0');
      const tickLower = bitsToI32(extractI32Bits(pos.lower_tick));
      const tickUpper = bitsToI32(extractI32Bits(pos.upper_tick));
      const sqrtPriceX64 = BigInt((pool?.current_sqrt_price as string) || '0');
      const tickCurrent = pool ? bitsToI32(extractI32Bits(pool.current_tick_index)) : 0;

      const { amount0, amount1 } = pool
        ? calculateAmounts(liquidity, tickLower, tickUpper, sqrtPriceX64, decimalsA, decimalsB)
        : { amount0: 0, amount1: 0 };

      const priceA = priceData[coinTypeA] || 0;
      const priceB = priceData[coinTypeB] || 0;
      const value = amount0 * priceA + amount1 * priceB;

      // Calculate pending fees using fee growth inside (Uniswap V3 style)
      const tableId = poolTicksTableIds[poolId];
      const lowerTickData = tableId ? tickDataMap[`${tableId}:${tickLower}`] : undefined;
      const upperTickData = tableId ? tickDataMap[`${tableId}:${tickUpper}`] : undefined;

      let fees0 = 0, fees1 = 0;
      if (pool && lowerTickData && upperTickData) {
        const feeGrowthGlobalA = BigInt((pool.fee_growth_global_coin_a as string) || '0');
        const feeGrowthGlobalB = BigInt((pool.fee_growth_global_coin_b as string) || '0');
        const feeGrowthCheckpointA = BigInt((pos.fee_growth_coin_a as string) || '0');
        const feeGrowthCheckpointB = BigInt((pos.fee_growth_coin_b as string) || '0');
        const tokenAFee = BigInt((pos.token_a_fee as string) || '0');
        const tokenBFee = BigInt((pos.token_b_fee as string) || '0');

        const feeGrowthInsideA = calcFeeGrowthInside(
          tickCurrent, tickLower, tickUpper,
          feeGrowthGlobalA, lowerTickData.feeGrowthOutsideA, upperTickData.feeGrowthOutsideA,
        );
        const feeGrowthInsideB = calcFeeGrowthInside(
          tickCurrent, tickLower, tickUpper,
          feeGrowthGlobalB, lowerTickData.feeGrowthOutsideB, upperTickData.feeGrowthOutsideB,
        );

        fees0 = Number(calcPendingFees(tokenAFee, feeGrowthInsideA, feeGrowthCheckpointA, liquidity)) / 10 ** decimalsA;
        fees1 = Number(calcPendingFees(tokenBFee, feeGrowthInsideB, feeGrowthCheckpointB, liquidity)) / 10 ** decimalsB;
      } else {
        // Fallback: use snapshotted fees only
        fees0 = Number((pos.token_a_fee as string) || '0') / 10 ** decimalsA;
        fees1 = Number((pos.token_b_fee as string) || '0') / 10 ** decimalsB;
      }
      const feesUsd = fees0 * priceA + fees1 * priceB;

      const inRange = liquidity > 0n && tickCurrent >= tickLower && tickCurrent < tickUpper;

      // Position-specific APY: pool_feeApr × (pool_tvl / position_value) × (pos_liq / pool_liq)
      const apyKey = [coinTypeA, coinTypeB].map((t) => t.toLowerCase()).sort().join('-');
      const apyInfo = apyData[apyKey];
      const poolLiquidity = pool ? BigInt((pool.liquidity as string) || '0') : 0n;
      let apy = 0;
      if (apyInfo && value > 0 && poolLiquidity > 0n && liquidity > 0n) {
        const posLiqShare = Number(liquidity) / Number(poolLiquidity);
        apy = Math.round(apyInfo.apyBase * (apyInfo.tvlUsd / value) * posLiqShare * 100) / 100;
      } else if (apyInfo) {
        apy = apyInfo.apyBase;
      }

      return {
        id: `bluefin-${pos.objectId as string}`,
        pair: `${symbolA} / ${symbolB}`,
        protocol: 'Bluefin',
        chain: 'Sui',
        value: Math.round(value * 100) / 100,
        apy,
        fees: Math.round(feesUsd * 100) / 100,
        status: (liquidity === 0n ? 'Closed' : inRange ? 'In Range' : 'Out of Range') as 'In Range' | 'Out of Range' | 'Closed',
        amount0: Math.round(amount0 * 1_000_000) / 1_000_000,
        amount1: Math.round(amount1 * 1_000_000) / 1_000_000,
        token0Symbol: symbolA,
        token1Symbol: symbolB,
        fees0: Math.round(fees0 * 1_000_000) / 1_000_000,
        fees1: Math.round(fees1 * 1_000_000) / 1_000_000,
        tickLower,
        tickUpper,
        token0Decimals: decimalsA,
        token1Decimals: decimalsB,
        liquidity: liquidity.toString(),
        price0: priceA,
        price1: priceB,
        walletAddress: account,
      };
    });

    return NextResponse.json({ positions, count: positions.length, account });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to fetch Bluefin positions', details: String(error) },
      { status: 500 },
    );
  }
}
