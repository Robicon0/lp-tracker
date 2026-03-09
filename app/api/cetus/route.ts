import { NextResponse } from 'next/server';

const SUI_RPC = process.env.SUI_RPC_URL || 'https://fullnode.mainnet.sui.io:443';

// Cetus CLMM position type on Sui mainnet
const CETUS_POSITION_TYPE =
  '0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb::position::Position';

// Known Sui coin types → CoinGecko IDs and decimals
const KNOWN_COINS: Record<string, { symbol: string; name: string; decimals: number; coingeckoId: string }> = {
  '0x2::sui::SUI': { symbol: 'SUI', name: 'Sui', decimals: 9, coingeckoId: 'sui' },
  '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC': { symbol: 'USDC', name: 'USD Coin', decimals: 6, coingeckoId: 'usd-coin' },
  '0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN': { symbol: 'USDT', name: 'Tether USD', decimals: 6, coingeckoId: 'tether' },
  '0xaf8cd5edc19c4512f4259f0bee101a40d41ebed738ade5874359610ef8eeced5::coin::COIN': { symbol: 'WETH', name: 'Wrapped Ether', decimals: 8, coingeckoId: 'ethereum' },
  '0x027792d9fed7f9844eb4839566001bb6f6cb4804f66aa2da6fe1ee242d896881::coin::COIN': { symbol: 'WBTC', name: 'Wrapped Bitcoin', decimals: 8, coingeckoId: 'bitcoin' },
  '0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN': { symbol: 'wUSDC', name: 'Wormhole USDC', decimals: 6, coingeckoId: 'usd-coin' },
  '0xa99b8952d4f7d947ea77fe0ecdcc9e5fc0bcab2841d6e2a5aa00c3044e5544b5::navx::NAVX': { symbol: 'NAVX', name: 'Navi Protocol', decimals: 9, coingeckoId: 'navi-protocol' },
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

// Decode Sui I32 (stored as u32 bits)
function bitsToI32(bits: number): number {
  return bits > 2147483647 ? bits - 4294967296 : bits;
}

// I32 struct comes as { type: "...::i32::I32", fields: { bits: N } } in object content
function extractI32Bits(val: unknown): number {
  if (val == null) return 0;
  const v = val as Record<string, unknown>;
  if (typeof v.bits === 'number') return v.bits;
  const fields = v.fields as Record<string, unknown> | undefined;
  if (fields && typeof fields.bits === 'number') return fields.bits;
  return 0;
}

// Normalize Sui coin type: add 0x prefix and convert padded hex to short form
function normalizeCoinType(ct: string): string {
  if (!ct) return ct;
  const prefixed = ct.startsWith('0x') ? ct : `0x${ct}`;
  return prefixed.replace(/^0x0+([0-9a-f]+::)/, '0x$1');
}

// Extract coin type string from Cetus TypeName struct and normalize it
// TypeName comes as { type: "0x1::type_name::TypeName", fields: { name: "addr::module::TYPE" } }
function extractCoinType(val: unknown): string {
  if (typeof val === 'string') return normalizeCoinType(val);
  const v = val as Record<string, unknown>;
  let raw = '';
  if (v?.fields) raw = (v.fields as Record<string, string>).name || '';
  else if (v?.name) raw = v.name as string;
  return normalizeCoinType(raw);
}

// CLMM amount calculation (Uniswap V3 / Cetus math)
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
  // Convert Q64.64 to float
  const sqrtCurrent = Number(sqrtPriceCurrentX64) / 2 ** 64;

  const liq = Number(liquidity);
  let amount0 = 0;
  let amount1 = 0;

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

// Fetch all Cetus positions owned by address (handles pagination)
async function fetchAllCetusPositions(account: string): Promise<Array<Record<string, unknown>>> {
  const positions: Array<Record<string, unknown>> = [];
  let cursor: string | null = null;

  do {
    const result = await suiRpc('suix_getOwnedObjects', [
      account,
      {
        filter: { StructType: CETUS_POSITION_TYPE },
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

// Fetch multiple pool objects by ID in one batch call
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

// Fetch coin metadata for a Sui coin type
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
  const coingeckoIds: string[] = [];
  const coinTypeToId: Record<string, string> = {};

  for (const ct of coinTypes) {
    const known = KNOWN_COINS[ct];
    if (known) {
      coingeckoIds.push(known.coingeckoId);
      coinTypeToId[ct] = known.coingeckoId;
    }
  }

  if (coingeckoIds.length === 0) return {};

  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${[...new Set(coingeckoIds)].join(',')}&vs_currencies=usd`,
      { next: { revalidate: 60 } },
    );
    const data = await res.json();
    const prices: Record<string, number> = {};
    for (const [ct, geckoId] of Object.entries(coinTypeToId)) {
      prices[ct] = data[geckoId]?.usd || 0;
    }
    return prices;
  } catch {
    return {};
  }
}

async function fetchCetusAPYs(): Promise<Record<string, number>> {
  try {
    const res = await fetch('https://yields.llama.fi/pools', { next: { revalidate: 300 } });
    const data = await res.json();
    const pools = data.data?.filter(
      (p: { project: string; chain: string }) => p.project === 'cetus-clmm' && p.chain === 'Sui',
    ) || [];

    const apysByPair: Record<string, number[]> = {};
    for (const pool of pools) {
      if (pool.underlyingTokens?.length >= 2) {
        // DefiLlama uses padded hex (0x000...0002::sui::SUI); normalize to short form to match our coin types
        const key = pool.underlyingTokens
          .map((t: string) => normalizeCoinType(t).toLowerCase())
          .sort()
          .join('-');
        if (!apysByPair[key]) apysByPair[key] = [];
        apysByPair[key].push(pool.apyBase || pool.apy || 0);
      }
    }

    const result: Record<string, number> = {};
    for (const [key, apys] of Object.entries(apysByPair)) {
      const sorted = apys.sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      result[key] = Math.round(
        (sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2) * 100,
      ) / 100;
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
    // 1. Fetch all Cetus positions
    const rawPositions = await fetchAllCetusPositions(account);
    if (rawPositions.length === 0) return NextResponse.json({ positions: [], count: 0, account });

    // 2. Collect unique pool IDs and coin types
    const poolIds = [...new Set(rawPositions.map((p) => p.pool as string).filter(Boolean))];
    const coinTypes = [...new Set(rawPositions.flatMap((p) => [
      extractCoinType(p.coin_type_a),
      extractCoinType(p.coin_type_b),
    ]).filter(Boolean))];

    // 3. Fetch pool data + coin metadata + prices in parallel
    const [poolMap, apyData, priceData] = await Promise.all([
      fetchPools(poolIds),
      fetchCetusAPYs(),
      fetchPrices(coinTypes),
    ]);

    // Fetch coin metadata for unknown types
    const coinMetaMap: Record<string, { symbol: string; decimals: number; name: string }> = {};
    await Promise.all(
      coinTypes.map(async (ct) => {
        const meta = await fetchCoinMetadata(ct);
        if (meta) coinMetaMap[ct] = meta;
      }),
    );

    // 4. Build positions (filter ghost zero-liquidity objects)
    const positions = rawPositions.map((pos) => {
      const poolId = pos.pool as string;
      const pool = poolMap[poolId];
      const coinTypeA = extractCoinType(pos.coin_type_a);
      const coinTypeB = extractCoinType(pos.coin_type_b);
      const metaA = coinMetaMap[coinTypeA];
      const metaB = coinMetaMap[coinTypeB];

      const symbolA = metaA?.symbol || coinTypeA.split('::').pop() || 'TOKEN_A';
      const symbolB = metaB?.symbol || coinTypeB.split('::').pop() || 'TOKEN_B';
      const decimalsA = metaA?.decimals ?? 9;
      const decimalsB = metaB?.decimals ?? 9;

      const liquidity = BigInt((pos.liquidity as string) || '0');
      // I32 struct: { type: "...::i32::I32", fields: { bits: N } }
      const tickLower = bitsToI32(extractI32Bits(pos.tick_lower_index));
      const tickUpper = bitsToI32(extractI32Bits(pos.tick_upper_index));
      const sqrtPriceX64 = BigInt((pool?.current_sqrt_price as string) || '0');
      const tickCurrent = pool ? bitsToI32(extractI32Bits(pool.current_tick_index)) : 0;

      const { amount0, amount1 } = pool
        ? calculateAmounts(liquidity, tickLower, tickUpper, sqrtPriceX64, decimalsA, decimalsB)
        : { amount0: 0, amount1: 0 };

      const priceA = priceData[coinTypeA] || 0;
      const priceB = priceData[coinTypeB] || 0;
      const value = amount0 * priceA + amount1 * priceB;

      const inRange = tickCurrent >= tickLower && tickCurrent < tickUpper;

      // APY lookup by coin type pair
      const apyKey = [coinTypeA, coinTypeB].map((t) => t.toLowerCase()).sort().join('-');
      const apy = apyData[apyKey] || 0;

      // Skip ghost positions: zero liquidity with no value and no fees
      if (liquidity === 0n && value === 0 && apy === 0) return null;

      return {
        id: `cetus-${pos.objectId as string}`,
        pair: `${symbolA} / ${symbolB}`,
        protocol: 'Cetus',
        chain: 'Sui',
        value: Math.round(value * 100) / 100,
        apy,
        fees: 0,
        status: (inRange ? 'In Range' : 'Out of Range') as 'In Range' | 'Out of Range',
        amount0: Math.round(amount0 * 1_000_000) / 1_000_000,
        amount1: Math.round(amount1 * 1_000_000) / 1_000_000,
        token0Symbol: symbolA,
        token1Symbol: symbolB,
        fees0: 0,
        fees1: 0,
        tickLower,
        tickUpper,
        token0Decimals: decimalsA,
        token1Decimals: decimalsB,
      };
    }).filter(Boolean);

    const validPositions = positions.filter((p): p is NonNullable<typeof p> => p !== null);
    return NextResponse.json({ positions: validPositions, count: validPositions.length, account });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to fetch Cetus positions', details: String(error) },
      { status: 500 },
    );
  }
}
