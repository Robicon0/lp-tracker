import { NextResponse } from 'next/server';
import { fetchCachedCoinGeckoPrices } from '../../lib/priceCache';
import { resolveToken } from '../../lib/tokenResolver';
import { safeCalcPendingFee, calcFeeGrowthInside, emitFeeUnderflow } from '../../lib/clmmFeeMath';
import { resolveSuiRewardTokens, buildPendingRewards } from '../../lib/suiRewardMeta';
import { logPrice } from '../../lib/priceLogger';

// Cetus tick range is [-443636, 443636]; the tick_manager.ticks move_stl SkipList
// is keyed by a u64 score = tickIndex + 443636 (shifts the signed range to
// [0, 887272]). Verified empirically against live pools (Sprint 1.8); a defensive
// returned-index check in fetchCetusTick ensures a future module change fails loudly.
const CETUS_TICK_SCORE_OFFSET = 443636;

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

// Descend one struct level: returns a Sui object's `.fields` (or the object
// itself if it has none). Sui JSON-RPC nests struct fields under `.fields`.
function suiFields(v: unknown): Record<string, unknown> | null {
  if (v == null || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  return ((o.fields && typeof o.fields === 'object') ? o.fields : o) as Record<string, unknown>;
}

// Extract the object id of an inner Table/SkipList held by a manager struct,
// e.g. cetusTableId(pool.position_manager, 'positions') or (pool.tick_manager, 'ticks').
function cetusTableId(manager: unknown, key: string): string | null {
  const mf = suiFields(manager);
  const inner = suiFields(mf?.[key]);
  const idStr = (inner?.id as Record<string, unknown> | undefined)?.id;
  return typeof idStr === 'string' ? idStr : null;
}

// Fetch one tick's fee_growth_outside from the pool's tick_manager.ticks move_stl
// SkipList. Key = u64 score (tickIndex + offset). DEFENSIVE GUARD: the returned
// tick's own index must equal the requested index, else the read is treated as a
// failure (returns null) — so a future Cetus score-formula change fails loudly
// rather than silently mis-reading a neighbouring tick.
async function fetchCetusTick(skipListId: string, tickIndex: number): Promise<{ a: bigint; b: bigint; rewards: bigint[] } | null> {
  const score = (tickIndex + CETUS_TICK_SCORE_OFFSET).toString();
  const res = await suiRpc('suix_getDynamicFieldObject', [skipListId, { type: 'u64', value: score }]) as
    { data?: { content?: { fields?: Record<string, unknown> } } } | null;
  // content.fields = { id, name, value: Node }; Node.fields = { nexts, prev, score, value: Tick }
  const node = suiFields(res?.data?.content?.fields?.value);
  const tick = suiFields(node?.value);
  if (!tick) return null;
  if (bitsToI32(extractI32Bits(tick.index)) !== tickIndex) return null; // defensive guard
  return {
    a: BigInt((tick.fee_growth_outside_a as string) || '0'),
    b: BigInt((tick.fee_growth_outside_b as string) || '0'),
    // Per-rewarder growth outside (Sprint POSITION-DETAIL) — same tick node,
    // zero extra RPC. Verified on-chain: `rewards_growth_outside` is a vector
    // of u128 strings, one per pool rewarder, index-aligned with
    // rewarder_manager.rewarders.
    rewards: Array.isArray(tick.rewards_growth_outside)
      ? (tick.rewards_growth_outside as string[]).map((x) => BigInt(x || '0'))
      : [],
  };
}

// Compute one Cetus position's pending (uncollected) fees. Cetus keeps per-position
// fee state in the pool's position_manager LinkedTable (PositionInfo: fee_growth_inside
// checkpoints + fee_owned) and tick fee_growth_outside in the tick_manager SkipList —
// NOT on the position object — so this needs extra dynamic-field reads. The math is
// the shared chain-agnostic CLMM math (Sprint 1.7e). Returns token amounts already
// divided by decimals + a USD total, or null on any read failure (caller falls back
// to 0). NOTE: PositionInfo.rewards[] (the CETUS reward-token growth) is a SEPARATE
// path and is intentionally NOT touched here.
async function computeCetusPendingFees(
  pos: Record<string, unknown>,
  pool: Record<string, unknown>,
  decimalsA: number,
  decimalsB: number,
  priceA: number,
  priceB: number,
  pair: string,
): Promise<{ fees0: number; fees1: number; feesUsd: number; pendingRewardsRaw: Array<{ coinType: string; raw: bigint }> } | null> {
  const positionId = pos.objectId as string;
  const poolId = pos.pool as string;
  const fail = (reason: 'position_info_missing' | 'tick_lower_mismatch' | 'tick_upper_mismatch' | 'rpc_error') => {
    logPrice({ event: 'cetus_pending_fee_read_failed', positionId: `cetus-${positionId}`, poolId, reason });
    return null;
  };
  try {
    const liquidity = BigInt((pos.liquidity as string) || '0');
    const tickLower = bitsToI32(extractI32Bits(pos.tick_lower_index));
    const tickUpper = bitsToI32(extractI32Bits(pos.tick_upper_index));
    const tickCurrent = bitsToI32(extractI32Bits(pool.current_tick_index));
    const globalA = BigInt((pool.fee_growth_global_a as string) || '0');
    const globalB = BigInt((pool.fee_growth_global_b as string) || '0');
    const positionsTableId = cetusTableId(pool.position_manager, 'positions');
    const ticksSkipListId = cetusTableId(pool.tick_manager, 'ticks');
    if (!positionsTableId || !ticksSkipListId) return fail('rpc_error');

    // (a) PositionInfo from the pool's position_manager.positions LinkedTable
    const piRes = await suiRpc('suix_getDynamicFieldObject', [
      positionsTableId, { type: '0x2::object::ID', value: positionId },
    ]) as { data?: { content?: { fields?: Record<string, unknown> } } } | null;
    // LinkedTable node: content.fields = { id, name, value: Node }; Node.fields = { next, prev, value: PositionInfo }
    const piNode = suiFields(piRes?.data?.content?.fields?.value);
    const pi = suiFields(piNode?.value);
    if (!pi) return fail('position_info_missing');
    const checkpointA = BigInt((pi.fee_growth_inside_a as string) || '0');
    const checkpointB = BigInt((pi.fee_growth_inside_b as string) || '0');
    const feeOwnedA = BigInt((pi.fee_owned_a as string) || '0');
    const feeOwnedB = BigInt((pi.fee_owned_b as string) || '0');

    // (b)(c) lower + upper ticks (defensive index guard inside fetchCetusTick)
    const lower = await fetchCetusTick(ticksSkipListId, tickLower);
    if (!lower) return fail('tick_lower_mismatch');
    const upper = await fetchCetusTick(ticksSkipListId, tickUpper);
    if (!upper) return fail('tick_upper_mismatch');

    // (d) current feeGrowthInside (shared util; correct for in- and out-of-range)
    const insideA = calcFeeGrowthInside(tickLower, tickUpper, tickCurrent, globalA, lower.a, upper.a);
    const insideB = calcFeeGrowthInside(tickLower, tickUpper, tickCurrent, globalB, lower.b, upper.b);

    // (e) pending delta with the shared u128 underflow guard
    const uctx = { protocol: 'cetus', chain: 'sui', positionId: `cetus-${positionId}`, pair } as const;
    const pendA = safeCalcPendingFee(liquidity, insideA, checkpointA);
    const pendB = safeCalcPendingFee(liquidity, insideB, checkpointB);
    emitFeeUnderflow(pendA, { ...uctx, side: 'token0' });
    emitFeeUnderflow(pendB, { ...uctx, side: 'token1' });

    // (f) total = settled fee_owned + guarded pending delta
    const raw0 = feeOwnedA + pendA.fee;
    const raw1 = feeOwnedB + pendB.fee;
    const fees0 = Number(raw0) / 10 ** decimalsA;
    const fees1 = Number(raw1) / 10 ** decimalsB;
    const feesUsd = fees0 * priceA + fees1 * priceB;

    // (g) Pending REWARD EMISSIONS (Sprint POSITION-DETAIL, Contract invariant
    // (k)) — same growth math per rewarder, from data ALREADY fetched above:
    // pool rewarder_manager.rewarders[i].growth_global, the PositionInfo's
    // rewards[i] checkpoint (growth_inside + amount_owned), and the tick nodes'
    // rewards_growth_outside[i] (returned by fetchCetusTick). Verified on-chain
    // (Phase A): fees + these rewards ≈ the Cetus app's "Claimable Yield".
    // Conservative: indexes the position has NO checkpoint for are SKIPPED
    // (Cetus extends the vector lazily on touch; assuming a 0 checkpoint for a
    // rewarder added later would overstate). Raw amounts only — the handler
    // resolves each reward coin type (invariant (i)) and prices it at spot.
    const pendingRewardsRaw: Array<{ coinType: string; raw: bigint }> = [];
    const rewarders = ((suiFields(pool.rewarder_manager)?.rewarders as unknown[]) ?? []).map((r) => suiFields(r));
    const posRewards = ((pi.rewards as unknown[]) ?? []).map((r) => suiFields(r));
    for (let i = 0; i < Math.min(rewarders.length, posRewards.length); i++) {
      const rw = rewarders[i];
      const pr = posRewards[i];
      if (!rw || !pr) continue;
      const coinType = extractCoinType(rw.reward_coin);
      if (!coinType) continue;
      const growthGlobal = BigInt((rw.growth_global as string) || '0');
      const checkpoint = BigInt((pr.growth_inside as string) || '0');
      const owed = BigInt(((pr.amount_owned ?? pr.amount_owed) as string) || '0');
      const insideR = calcFeeGrowthInside(
        tickLower, tickUpper, tickCurrent, growthGlobal,
        lower.rewards[i] ?? 0n, upper.rewards[i] ?? 0n,
      );
      const pendR = safeCalcPendingFee(liquidity, insideR, checkpoint);
      emitFeeUnderflow(pendR, { ...uctx, side: `reward${i}` as 'token0' });
      const rawR = owed + pendR.fee;
      if (rawR > 0n) pendingRewardsRaw.push({ coinType, raw: rawR });
    }

    logPrice({
      event: 'cetus_pending_fee_computed', positionId: `cetus-${positionId}`, poolId,
      pending_token0_raw: raw0.toString(), pending_token1_raw: raw1.toString(), pending_usd_total: feesUsd,
      pending_reward_count: pendingRewardsRaw.length,
    });
    return { fees0, fees1, feesUsd, pendingRewardsRaw };
  } catch {
    return fail('rpc_error');
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

    // LAST RESORT (Sprint 1.10): for any coin type still unpriced after
    // KNOWN_COINS, resolve its CoinGecko id via the shared platform-wide
    // tokenResolver (CoinGecko contract lookup -> on-chain metadata ->
    // CoinGecko symbol search -> DeFiLlama coverage), then merge a real spot
    // price. Strictly more capable than the prior symbol-search-only fallback.
    // Purely additive: KNOWN_COINS fast path is untouched, so any previously-
    // mapped coin type is byte-identical (it never enters `missing`). A null
    // resolution leaves the coin at price 0 (position still renders).
    {
      const missing = coinTypes.filter((ct) => !(priceData[ct] > 0));
      const resolved = await Promise.all(
        missing.map(async (ct) => ({
          ct,
          token: await resolveToken({
            chain: 'sui',
            suiType: ct,
            symbolHint: coinMetaMap[ct]?.symbol,
            decimalsHint: coinMetaMap[ct]?.decimals,
          }),
        })),
      );
      const cgIds = [...new Set(resolved.map(({ token }) => token.cgId).filter((x): x is string => !!x))];
      if (cgIds.length > 0) {
        const dynamicPrices = await fetchCachedCoinGeckoPrices(cgIds);
        for (const { ct, token } of resolved) {
          const px = token.cgId ? dynamicPrices[token.cgId] : 0;
          if (px > 0) priceData[ct] = px;
        }
      }
    }

    // 3b. Compute pending (uncollected) fees per position. Cetus stores
    // per-position fee state in the pool's position_manager LinkedTable +
    // tick_manager SkipList (NOT on the position object), so this needs extra
    // dynamic-field reads — run as a parallel pass so the build map stays sync.
    // On any read failure a position falls back to 0 (the pre-fix display) and a
    // cetus_pending_fee_read_failed event is emitted. Shared math (Sprint 1.7e).
    const cetusFeeMap: Record<string, { fees0: number; fees1: number; feesUsd: number; pendingRewardsRaw: Array<{ coinType: string; raw: bigint }> }> = {};
    await Promise.all(rawPositions.map(async (pos) => {
      const pool = poolMap[pos.pool as string];
      if (!pool) return; // no pool data → leave fees at 0
      const coinTypeA = extractCoinType(pos.coin_type_a);
      const coinTypeB = extractCoinType(pos.coin_type_b);
      const metaA = coinMetaMap[coinTypeA];
      const metaB = coinMetaMap[coinTypeB];
      const symbolA = metaA?.symbol || coinTypeA.split('::').pop() || 'TOKEN_A';
      const symbolB = metaB?.symbol || coinTypeB.split('::').pop() || 'TOKEN_B';
      const result = await computeCetusPendingFees(
        pos, pool, metaA?.decimals ?? 9, metaB?.decimals ?? 9,
        priceData[coinTypeA] || 0, priceData[coinTypeB] || 0, `${symbolA} / ${symbolB}`,
      );
      if (result) cetusFeeMap[pos.objectId as string] = result;
    }));

    // 3c. Resolve + price pending REWARD tokens (Sprint POSITION-DETAIL). Reward
    // coin types come from on-chain rewarder state per position (invariant (i) —
    // never a hardcoded map); identity via the shared resolver, USD at CURRENT
    // SPOT through the resilient tiered helper (SPOT-RESILIENCE invariant (j)).
    const rewardMeta = await resolveSuiRewardTokens(
      Object.values(cetusFeeMap).flatMap((f) => f.pendingRewardsRaw.map((r) => r.coinType)),
    );

    // 4. Build positions.
    // RULE: Closed positions (liquidity = 0) must ALWAYS be returned and
    // never filtered out. Status is set to 'Closed' below. Applies to all
    // current and future protocol integrations on any chain.
    // Sui caveat: when a position is fully closed via the protocol UI, the
    // on-chain Position object is destroyed and suix_getOwnedObjects cannot
    // return it. Only zero-liquidity positions whose object still exists
    // surface here.
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

      const fee = cetusFeeMap[pos.objectId as string]; // pending fees (Sprint 1.8); undefined → 0 fallback
      // Sprint POSITION-DETAIL: pending reward emissions (separate from fees so
      // analytics aggregation over `fees` is byte-identical).
      const pendingRewards = fee ? buildPendingRewards(fee.pendingRewardsRaw, rewardMeta) : [];
      const rewardsUsd = Math.round(pendingRewards.reduce((s, r) => s + r.usd, 0) * 100) / 100;
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

      const inRange = liquidity > 0n && tickCurrent >= tickLower && tickCurrent < tickUpper;

      // APY lookup by coin type pair
      const apyKey = [coinTypeA, coinTypeB].map((t) => t.toLowerCase()).sort().join('-');
      const apy = apyData[apyKey] || 0;

      return {
        id: `cetus-${pos.objectId as string}`,
        pair: `${symbolA} / ${symbolB}`,
        protocol: 'Cetus',
        chain: 'Sui',
        value: Math.round(value * 100) / 100,
        apy,
        fees: fee ? Math.round(fee.feesUsd * 100) / 100 : 0,
        status: (liquidity === 0n ? 'Closed' : inRange ? 'In Range' : 'Out of Range') as 'In Range' | 'Out of Range' | 'Closed',
        amount0: Math.round(amount0 * 1_000_000) / 1_000_000,
        amount1: Math.round(amount1 * 1_000_000) / 1_000_000,
        token0Symbol: symbolA,
        token1Symbol: symbolB,
        fees0: fee ? Math.round(fee.fees0 * 1_000_000) / 1_000_000 : 0,
        fees1: fee ? Math.round(fee.fees1 * 1_000_000) / 1_000_000 : 0,
        ...(pendingRewards.length > 0 ? { pendingRewards, rewardsUsd } : {}),
        tickLower,
        tickUpper,
        token0Decimals: decimalsA,
        token1Decimals: decimalsB,
        liquidity: liquidity.toString(),
        price0: priceA,
        price1: priceB,
        walletAddress: account,
        coinTypeA,
        coinTypeB,
      };
    });

    return NextResponse.json({ positions, count: positions.length, account });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to fetch Cetus positions', details: String(error) },
      { status: 500 },
    );
  }
}
