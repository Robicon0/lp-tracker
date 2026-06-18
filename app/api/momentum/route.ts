import { NextResponse } from 'next/server';
import { fetchCachedCoinGeckoPrices } from '../../lib/priceCache';
import { resolveCgIds } from '../../lib/cgSymbolSearch';
import { safeCalcPendingFee, emitFeeUnderflow, type UnderflowLogContext } from '../../lib/clmmFeeMath';

const SUI_RPC = process.env.SUI_RPC_URL || 'https://fullnode.mainnet.sui.io:443';

// Momentum CLMM position type on Sui mainnet
const MOMENTUM_POSITION_TYPE =
  '0x70285592c97965e811e0c6f98dccc3a9c2b4ad854b3594faab9597ada267b860::position::Position';

// I32 key type used in the pool's ticks Table
const I32_TYPE =
  '0x70285592c97965e811e0c6f98dccc3a9c2b4ad854b3594faab9597ada267b860::i32::I32';

const U128_MASK = (1n << 128n) - 1n;

const KNOWN_COINS: Record<string, { symbol: string; name: string; decimals: number; coingeckoId: string }> = {
  '0x2::sui::SUI': { symbol: 'SUI', name: 'Sui', decimals: 9, coingeckoId: 'sui' },
  '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC': { symbol: 'USDC', name: 'USD Coin', decimals: 6, coingeckoId: 'usd-coin' },
  '0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN': { symbol: 'USDT', name: 'Tether USD', decimals: 6, coingeckoId: 'tether' },
  '0xaf8cd5edc19c4512f4259f0bee101a40d41ebed738ade5874359610ef8eeced5::coin::COIN': { symbol: 'WETH', name: 'Wrapped Ether', decimals: 8, coingeckoId: 'ethereum' },
  '0x027792d9fed7f9844eb4839566001bb6f6cb4804f66aa2da6fe1ee242d896881::coin::COIN': { symbol: 'WBTC', name: 'Wrapped Bitcoin', decimals: 8, coingeckoId: 'bitcoin' },
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

function normalizeCoinType(ct: string): string {
  if (!ct) return ct;
  const prefixed = ct.startsWith('0x') ? ct : `0x${ct}`;
  return prefixed.replace(/^0x0+([0-9a-f]+::)/, '0x$1');
}

// Extract I32 bits from various shapes returned by Sui RPC
function extractI32Bits(val: unknown): number {
  if (val == null) return 0;
  const v = val as Record<string, unknown>;
  if (typeof v.bits === 'number') return v.bits;
  const fields = v.fields as Record<string, unknown> | undefined;
  if (fields && typeof fields.bits === 'number') return fields.bits;
  return 0;
}

// Extract coin type string from a 0x1::type_name::TypeName struct
function extractTypeName(val: unknown): string {
  if (!val) return '';
  const v = val as Record<string, unknown>;
  // Flat { name: "..." }
  if (typeof v.name === 'string') return v.name;
  // Nested { fields: { name: "..." } }
  const fields = v.fields as Record<string, unknown> | undefined;
  if (fields && typeof fields.name === 'string') return fields.name;
  return '';
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
  const above = tickCurrent < tickUpper
    ? tickUpperFeeGrowthOutside
    : (feeGrowthGlobal - tickUpperFeeGrowthOutside) & U128_MASK;
  return (feeGrowthGlobal - below - above) & U128_MASK;
}

// Momentum uses Q64 scaling (same as Bluefin/Orca). Sprint 1.7e: the pending
// delta now goes through the shared safeCalcPendingFee, which guards the u128
// underflow and emits fee_underflow_detected on a guard fire. Settled owed_coin
// fees are added separately and untouched.
function calcPendingFees(
  owedFee: bigint,
  feeGrowthInside: bigint,
  feeGrowthCheckpoint: bigint,
  liquidity: bigint,
  ctx: UnderflowLogContext,
): bigint {
  const pending = safeCalcPendingFee(liquidity, feeGrowthInside, feeGrowthCheckpoint);
  emitFeeUnderflow(pending, ctx);
  return owedFee + pending.fee;
}

async function fetchAllMomentumPositions(account: string): Promise<Array<Record<string, unknown>>> {
  const positions: Array<Record<string, unknown>> = [];
  let cursor: string | null = null;

  do {
    const result = await suiRpc('suix_getOwnedObjects', [
      account,
      {
        filter: { StructType: MOMENTUM_POSITION_TYPE },
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
  const coinTypeToId: Record<string, string> = {};
  for (const ct of coinTypes) {
    const known = KNOWN_COINS[ct];
    if (known) coinTypeToId[ct] = known.coingeckoId;
  }
  const ids = [...new Set(Object.values(coinTypeToId))];
  if (ids.length === 0) return {};
  const geckoData = await fetchCachedCoinGeckoPrices(ids);
  const prices: Record<string, number> = {};
  for (const [ct, geckoId] of Object.entries(coinTypeToId)) {
    prices[ct] = geckoData[geckoId] || 0;
  }
  return prices;
}

// The pool's `ticks` field is a 0x2::table::Table — get the table object ID
function getTicksTableId(poolFields: Record<string, unknown>): string | null {
  const ticks = poolFields.ticks as Record<string, unknown> | undefined;
  const ticksFields = (ticks?.fields as Record<string, unknown> | undefined) ?? ticks;
  const id = ticksFields?.id as Record<string, unknown> | undefined;
  return (id?.id as string) || null;
}

async function fetchTick(
  ticksTableId: string,
  tickIndex: number,
): Promise<{ feeGrowthOutsideX: bigint; feeGrowthOutsideY: bigint } | null> {
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
      feeGrowthOutsideX: BigInt((tickFields.fee_growth_outside_x as string) || '0'),
      feeGrowthOutsideY: BigInt((tickFields.fee_growth_outside_y as string) || '0'),
    };
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const account = searchParams.get('account');
  if (!account) return NextResponse.json({ error: 'account required' }, { status: 400 });

  try {
    const rawPositions = await fetchAllMomentumPositions(account);
    if (rawPositions.length === 0) return NextResponse.json({ positions: [], count: 0, account });

    // Extract and normalize coin types from TypeName structs
    const rawWithNormalized: Array<Record<string, unknown>> = rawPositions.map((p) => ({
      ...p,
      coinTypeX: normalizeCoinType(extractTypeName(p.type_x)),
      coinTypeY: normalizeCoinType(extractTypeName(p.type_y)),
    }));

    const poolIds = [...new Set(rawWithNormalized.map((p) => p.pool_id as string).filter(Boolean))];
    const coinTypes = [...new Set(rawWithNormalized.flatMap((p) => [p.coinTypeX as string, p.coinTypeY as string]).filter(Boolean))];

    const [poolMap, priceData] = await Promise.all([
      fetchPools(poolIds),
      fetchPrices(coinTypes),
    ]);

    const coinMetaMap: Record<string, { symbol: string; decimals: number; name: string }> = {};
    await Promise.all(
      coinTypes.map(async (ct) => {
        const meta = await fetchCoinMetadata(ct);
        if (meta) coinMetaMap[ct] = meta;
      }),
    );

    // LAST RESORT: for any coin type not priced via KNOWN_COINS, look up its
    // symbol via the metadata we just fetched, resolve a CoinGecko ID by
    // symbol, and merge a real spot price. Purely additive — KNOWN_COINS
    // fast path is untouched and a null resolution leaves the coin at price
    // 0 (position still renders with value=0).
    {
      const missing = coinTypes.filter((ct) => !(priceData[ct] > 0));
      const symbolByCt: Record<string, string> = {};
      for (const ct of missing) {
        const sym = coinMetaMap[ct]?.symbol;
        if (sym) symbolByCt[ct] = sym;
      }
      const symbolToCgId = await resolveCgIds(Object.values(symbolByCt));
      const cgIds = [...new Set(Object.values(symbolToCgId))];
      if (cgIds.length > 0) {
        const dynamicPrices = await fetchCachedCoinGeckoPrices(cgIds);
        for (const [ct, sym] of Object.entries(symbolByCt)) {
          const cgId = symbolToCgId[sym.toUpperCase()];
          const px = cgId ? dynamicPrices[cgId] : 0;
          if (px > 0) priceData[ct] = px;
        }
      }
    }

    // Build ticks table ID map per pool
    const poolTicksTableIds: Record<string, string> = {};
    for (const [poolId, poolFields] of Object.entries(poolMap)) {
      const tableId = getTicksTableId(poolFields);
      if (tableId) poolTicksTableIds[poolId] = tableId;
    }

    // Collect unique (tableId, tickIndex) pairs
    const ticksToFetch = new Set<string>();
    for (const pos of rawWithNormalized) {
      const tableId = poolTicksTableIds[pos.pool_id as string];
      if (!tableId) continue;
      const tl = bitsToI32(extractI32Bits(pos.tick_lower_index));
      const tu = bitsToI32(extractI32Bits(pos.tick_upper_index));
      ticksToFetch.add(`${tableId}:${tl}`);
      ticksToFetch.add(`${tableId}:${tu}`);
    }

    const tickDataMap: Record<string, { feeGrowthOutsideX: bigint; feeGrowthOutsideY: bigint }> = {};
    await Promise.all(
      [...ticksToFetch].map(async (key) => {
        const colonIdx = key.indexOf(':');
        const tableId = key.slice(0, colonIdx);
        const tickIdx = parseInt(key.slice(colonIdx + 1));
        const data = await fetchTick(tableId, tickIdx);
        if (data) tickDataMap[key] = data;
      }),
    );

    // RULE: Closed positions (liquidity = 0) must ALWAYS be returned and
    // never filtered out. Status is set to 'Closed' in the returned object.
    // Applies to all current and future protocol integrations on any chain.
    // Sui caveat: when a position is fully closed via the protocol UI, the
    // on-chain Position object is destroyed and suix_getOwnedObjects cannot
    // return it. Only zero-liquidity positions whose object still exists
    // surface here.
    const positions = rawWithNormalized.map((pos) => {
      const poolId = pos.pool_id as string;
      const pool = poolMap[poolId];
      const coinTypeX = pos.coinTypeX as string;
      const coinTypeY = pos.coinTypeY as string;
      const metaX = coinMetaMap[coinTypeX];
      const metaY = coinMetaMap[coinTypeY];

      const symbolX = metaX?.symbol || coinTypeX.split('::').pop() || 'TOKEN_X';
      const symbolY = metaY?.symbol || coinTypeY.split('::').pop() || 'TOKEN_Y';
      const decimalsX = metaX?.decimals ?? 9;
      const decimalsY = metaY?.decimals ?? 9;

      const liquidity = BigInt((pos.liquidity as string) || '0');
      const tickLower = bitsToI32(extractI32Bits(pos.tick_lower_index));
      const tickUpper = bitsToI32(extractI32Bits(pos.tick_upper_index));
      const sqrtPriceX64 = BigInt((pool?.sqrt_price as string) || '0');
      const tickCurrent = pool ? bitsToI32(extractI32Bits(pool.tick_index)) : 0;

      const { amount0, amount1 } = pool
        ? calculateAmounts(liquidity, tickLower, tickUpper, sqrtPriceX64, decimalsX, decimalsY)
        : { amount0: 0, amount1: 0 };

      const priceX = priceData[coinTypeX] || 0;
      const priceY = priceData[coinTypeY] || 0;
      const value = amount0 * priceX + amount1 * priceY;

      // Calculate pending fees
      const tableId = poolTicksTableIds[poolId];
      const lowerTickData = tableId ? tickDataMap[`${tableId}:${tickLower}`] : undefined;
      const upperTickData = tableId ? tickDataMap[`${tableId}:${tickUpper}`] : undefined;

      let fees0 = 0, fees1 = 0;
      if (pool && lowerTickData && upperTickData) {
        const feeGrowthGlobalX = BigInt((pool.fee_growth_global_x as string) || '0');
        const feeGrowthGlobalY = BigInt((pool.fee_growth_global_y as string) || '0');
        const feeGrowthCheckpointX = BigInt((pos.fee_growth_inside_x_last as string) || '0');
        const feeGrowthCheckpointY = BigInt((pos.fee_growth_inside_y_last as string) || '0');
        const owedX = BigInt((pos.owed_coin_x as string) || '0');
        const owedY = BigInt((pos.owed_coin_y as string) || '0');

        const feeGrowthInsideX = calcFeeGrowthInside(
          tickCurrent, tickLower, tickUpper,
          feeGrowthGlobalX, lowerTickData.feeGrowthOutsideX, upperTickData.feeGrowthOutsideX,
        );
        const feeGrowthInsideY = calcFeeGrowthInside(
          tickCurrent, tickLower, tickUpper,
          feeGrowthGlobalY, lowerTickData.feeGrowthOutsideY, upperTickData.feeGrowthOutsideY,
        );

        const uctx: Omit<UnderflowLogContext, 'side'> = { protocol: 'momentum', chain: 'sui', positionId: `momentum-${pos.objectId as string}`, pair: `${symbolX} / ${symbolY}` };
        fees0 = Number(calcPendingFees(owedX, feeGrowthInsideX, feeGrowthCheckpointX, liquidity, { ...uctx, side: 'token0' })) / 10 ** decimalsX;
        fees1 = Number(calcPendingFees(owedY, feeGrowthInsideY, feeGrowthCheckpointY, liquidity, { ...uctx, side: 'token1' })) / 10 ** decimalsY;
      } else {
        // Fallback: snapshotted fees only
        fees0 = Number((pos.owed_coin_x as string) || '0') / 10 ** decimalsX;
        fees1 = Number((pos.owed_coin_y as string) || '0') / 10 ** decimalsY;
      }
      const feesUsd = fees0 * priceX + fees1 * priceY;

      const inRange = liquidity > 0n && tickCurrent >= tickLower && tickCurrent < tickUpper;

      return {
        id: `momentum-${pos.objectId as string}`,
        pair: `${symbolX} / ${symbolY}`,
        protocol: 'Momentum',
        chain: 'Sui',
        value: Math.round(value * 100) / 100,
        apy: 0,
        fees: Math.round(feesUsd * 100) / 100,
        status: (liquidity === 0n ? 'Closed' : inRange ? 'In Range' : 'Out of Range') as 'In Range' | 'Out of Range' | 'Closed',
        amount0: Math.round(amount0 * 1_000_000) / 1_000_000,
        amount1: Math.round(amount1 * 1_000_000) / 1_000_000,
        token0Symbol: symbolX,
        token1Symbol: symbolY,
        fees0: Math.round(fees0 * 1_000_000) / 1_000_000,
        fees1: Math.round(fees1 * 1_000_000) / 1_000_000,
        tickLower,
        tickUpper,
        token0Decimals: decimalsX,
        token1Decimals: decimalsY,
        liquidity: liquidity.toString(),
        price0: priceX,
        price1: priceY,
        walletAddress: account,
      };
    });

    return NextResponse.json({ positions, count: positions.length, account });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to fetch Momentum positions', details: String(error) },
      { status: 500 },
    );
  }
}
