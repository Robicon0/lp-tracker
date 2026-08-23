import { NextResponse } from 'next/server';
import { fetchCachedCoinGeckoPrices } from '../../lib/priceCache';
import { getEverOwnedTokenIds } from '../../lib/evmEverOwnedNftIds';
import { resolveToken } from '../../lib/tokenResolver';
import { resolveHolderVerdict, amountsFromLiquidity } from '../../lib/evmGaugeStaking';
import {
  resolveSugarSpanForRegistry,
  pageSugarPositions,
  sugarCeilingTruncations,
} from '../../lib/sugarPaging';
import type { RouteTruncation } from '../../lib/enumerationTruncation';

const ALCHEMY_KEY = process.env.NEXT_PUBLIC_ALCHEMY_KEY;
const OPTIMISM_RPC = `https://opt-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`;

const SUGAR_ADDRESS = '0xb8a82f0334e43c2eb0ab5d799036965f7bf07ba8';

// Closed/burned-position recovery. Sugar only returns currently-held NFTs;
// Velodrome Slipstream burns the NFT on full close, so closed positions vanish.
// We enumerate ever-owned tokenIds via Transfer→wallet logs and return the ones
// Sugar dropped as Closed records (display-only — fees are recovered via the
// activity route's positionId=all wallet-scope scan).
// Tenderly archive RPC is required for full-range eth_getLogs (Alchemy free
// tier caps at 10 blocks). Mirrors app/api/aerodrome/route.ts.
const TENDERLY_RPC = 'https://optimism.gateway.tenderly.co';
// Velodrome Voter — the protocol's own pool -> gauge registry, used to CONFIRM
// a holder really is that pool's gauge (Sprint GAUGE-STAKING). If this were
// wrong, detection fails CLOSED-SAFE: the position is excluded, never booked
// as a loss.
const VELODROME_VOTER = '0x41C914ee0c7E1A5edCD0295623e6dC557B5aBf3C';
const NFT_MANAGER = '0x416b433906b1B72FA758e166e239c43d68dC6F29';
const NFT_DEPLOY_BLOCK = 10_000_000;
// IncreaseLiquidity (NFT manager) + pool Mint (CL pool) topic0 — used to derive
// a burned position's pool/tokens/ticks from its mint transaction.
const INCREASE_TOPIC = '0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f';
const POOL_MINT_TOPIC = '0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde';

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

// Queue item C Phase 3 — the single `_limit = 100, _offset = 0` call is GONE;
// the iteration space is swept by the shared helper in app/lib/sugarPaging.ts,
// the SAME one Aerodrome uses, so the two cannot drift apart.
//
// Velodrome's Sugar entry point is `positions(limit, offset, account)`, which
// walks EVERY factory `registry.poolFactories()` returns rather than one named
// factory — so the span is the sum across all of them. See sugarPaging.ts for
// why that span deliberately errs HIGH.
//
// CORRECTION to the Phase 1 comment that stood here: `_offset` does not index
// pools. It seeds `to_skip`, and `pools_done` counts iterations of both inner
// loops, so offset paging is exactly right.

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

// Minimal JSON-RPC helper (returns result or null on any failure).
async function rpcResult(rpc: string, method: string, params: unknown[]): Promise<unknown> {
  try {
    const res = await fetch(rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    return (await res.json()).result ?? null;
  } catch {
    return null;
  }
}

function toInt24Topic(topicHex: string): number {
  const v = parseInt(topicHex.slice(-6), 16);
  return v >= 0x800000 ? v - 0x1000000 : v;
}

// Build Closed-position records for tokenIds the wallet once owned but Sugar no
// longer returns (NFT burned on full close). Pool / tokens / ticks are derived
// best-effort from the position's MINT transaction (NFT-manager IncreaseLiquidity
// → tx receipt → pool Mint log → pool address + ticks → token0()/token1()); on
// any failure a minimal Closed record is still returned so the position appears
// in the dashboard Closed tab. Display-only: fees are recovered separately via
// /api/velodrome/activity?positionId=all (wallet-scope), so value/fees are 0.
async function buildClosedPositions(
  account: string,
  heldIds: Set<string>,
  prices: Record<string, number>,
): Promise<Record<string, unknown>[]> {
  let everOwned: string[] = [];
  try {
    everOwned = await getEverOwnedTokenIds(NFT_MANAGER, account, TENDERLY_RPC, NFT_DEPLOY_BLOCK);
  } catch {
    return [];
  }
  const closedIds = everOwned.filter((id) => !heldIds.has(id));
  if (closedIds.length === 0) return [];

  // ── Sprint GAUGE-STAKING ─────────────────────────────────────────────
  // Identical treatment to the Aerodrome route — Velodrome is the original
  // Slipstream architecture, so "not returned by Sugar" was equally wrong as a
  // proxy for "closed". Staking moves the NFT to the pool's gauge; Sugar
  // enumerates only directly-held NFTs, so a live staked position looked closed
  // and had its whole deposit booked as a realized loss.
  //
  // Verdicts other than `burned` are NEVER emitted as Closed:
  //   staked      → emitted below in the OPEN shape with its real current value
  //   third-party → transferred/sold; excluded (not our position, not our loss)
  //   unresolved  → RPC failure; excluded rather than guessed (Rule 11)
  //
  // NOTE: gauge detection requires BOTH `holder.nft() == positionManager` AND
  // `voter.gauges(pool) == holder`. If VELODROME_VOTER were ever wrong, a staked
  // position degrades to `third-party` and is EXCLUDED — it can never be turned
  // back into a fabricated loss. Safe by construction.
  const verdicts = await Promise.all(
    closedIds.map(async (id) => {
      try {
        return { id, v: await resolveHolderVerdict({ rpc: TENDERLY_RPC, nftManager: NFT_MANAGER, voter: VELODROME_VOTER, tokenId: id }) };
      } catch {
        return { id, v: { kind: 'unresolved' as const } };
      }
    }),
  );

  const stakedOut: Record<string, unknown>[] = [];
  for (const { id, v } of verdicts) {
    if (v.kind !== 'staked') continue;
    const s = v.state;
    const t0 = TOKENS[s.token0];
    const t1 = TOKENS[s.token1];
    const r0 = t0 ?? (await resolveToken({ chain: 'optimism', contractAddress: s.token0 }).catch(() => null));
    const r1 = t1 ?? (await resolveToken({ chain: 'optimism', contractAddress: s.token1 }).catch(() => null));
    const d0 = r0?.decimals ?? 18;
    const d1 = r1?.decimals ?? 18;
    const { amount0, amount1 } = amountsFromLiquidity(s.liquidity, s.tickLower, s.tickUpper, s.sqrtPriceX96, d0, d1);
    const p0 = prices[s.token0] ?? 0;
    const p1 = prices[s.token1] ?? 0;
    const value = amount0 * p0 + amount1 * p1;
    const inRange = s.tickCurrent >= s.tickLower && s.tickCurrent < s.tickUpper;
    stakedOut.push({
      id: `velo-${id}`,
      pair: `${r0?.symbol ?? 'TOKEN0'} / ${r1?.symbol ?? 'TOKEN1'}`,
      protocol: 'Velodrome',
      chain: 'Optimism',
      value: Math.round(value * 100) / 100,
      apy: 0,
      fees: 0,
      status: inRange ? 'In Range' : 'Out of Range',
      depositId: id,
      amount0: Math.round(amount0 * 1e6) / 1e6,
      amount1: Math.round(amount1 * 1e6) / 1e6,
      token0Symbol: r0?.symbol ?? 'TOKEN0',
      token1Symbol: r1?.symbol ?? 'TOKEN1',
      fees0: 0, fees1: 0,
      tickLower: s.tickLower, tickUpper: s.tickUpper,
      token0Decimals: d0, token1Decimals: d1,
      liquidity: s.liquidity.toString(),
      price0: p0, price1: p1,
      token0Address: s.token0, token1Address: s.token1,
      walletAddress: account,
      isStaked: true,
      gaugeAddress: s.gauge,
    });
  }

  const trulyClosedIds = verdicts.filter(({ v }) => v.kind === 'burned').map(({ id }) => id);
  const excludedCount = verdicts.length - trulyClosedIds.length - stakedOut.length;
  if (stakedOut.length || excludedCount) {
    console.log(`[velodrome] closed-scan: ${trulyClosedIds.length} burned, ${stakedOut.length} gauge-staked (kept OPEN), ${excludedCount} excluded (third-party/unresolved)`);
  }

  const closedBuilt = await Promise.all(trulyClosedIds.map(async (tokenId): Promise<Record<string, unknown>> => {
    const minimal: Record<string, unknown> = {
      id: `velo-${tokenId}`,
      pair: 'Velodrome Position',
      protocol: 'Velodrome',
      chain: 'Optimism',
      value: 0, apy: 0, fees: 0,
      status: 'Closed',
      depositId: tokenId,
      amount0: 0, amount1: 0,
      token0Symbol: 'TOKEN0', token1Symbol: 'TOKEN1',
      fees0: 0, fees1: 0,
      tickLower: 0, tickUpper: 0,
      token0Decimals: 18, token1Decimals: 18,
      liquidity: '0',
      price0: 0, price1: 0,
      walletAddress: account,
    };
    try {
      const tokenIdHex = '0x' + BigInt(tokenId).toString(16).padStart(64, '0');
      const incLogs = await rpcResult(TENDERLY_RPC, 'eth_getLogs', [{
        address: NFT_MANAGER,
        topics: [INCREASE_TOPIC, tokenIdHex],
        fromBlock: '0x' + NFT_DEPLOY_BLOCK.toString(16),
        toBlock: 'latest',
      }]) as Array<{ transactionHash: string; blockNumber: string }> | null;
      if (!incLogs || incLogs.length === 0) return minimal;
      incLogs.sort((a, b) => parseInt(a.blockNumber, 16) - parseInt(b.blockNumber, 16));

      const receipt = await rpcResult(OPTIMISM_RPC, 'eth_getTransactionReceipt', [incLogs[0].transactionHash]) as
        { logs?: Array<{ address: string; topics: string[] }> } | null;
      const mintLog = receipt?.logs?.find((l) =>
        l.topics?.[0]?.toLowerCase() === POOL_MINT_TOPIC &&
        l.address.toLowerCase() !== NFT_MANAGER.toLowerCase());
      if (!mintLog) return minimal;

      const pool = mintLog.address.toLowerCase();
      const tickLower = toInt24Topic(mintLog.topics[2]);
      const tickUpper = toInt24Topic(mintLog.topics[3]);
      const tokens = await getPoolTokens(pool);
      if (!tokens) return { ...minimal, poolAddress: pool, tickLower, tickUpper };

      const t0 = TOKENS[tokens.token0];
      const t1 = TOKENS[tokens.token1];
      return {
        ...minimal,
        pair: `${t0?.symbol ?? 'TOKEN0'} / ${t1?.symbol ?? 'TOKEN1'}`,
        token0Symbol: t0?.symbol ?? 'TOKEN0',
        token1Symbol: t1?.symbol ?? 'TOKEN1',
        token0Decimals: t0?.decimals ?? 18,
        token1Decimals: t1?.decimals ?? 18,
        tickLower, tickUpper,
        price0: prices[tokens.token0] ?? 0,
        price1: prices[tokens.token1] ?? 0,
        token0Address: tokens.token0,
        token1Address: tokens.token1,
        poolAddress: pool,
      };
    } catch {
      return minimal;
    }
  }));

  // Genuinely-burned positions keep their existing Closed behaviour; staked
  // ones ride along in the OPEN shape.
  return [...closedBuilt, ...stakedOut];
}

// Fetch prices from CoinGecko
async function fetchPrices(): Promise<Record<string, number>> {
  const ids = [...new Set(Object.values(TOKENS).map(t => t.coingeckoId))];
  const geckoData = await fetchCachedCoinGeckoPrices(ids);
  const prices: Record<string, number> = {};
  for (const [addr, token] of Object.entries(TOKENS)) {
    prices[addr] = geckoData[token.coingeckoId] || 0;
  }
  return prices;
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
    // 1. Fetch raw positions from Sugar — the whole iteration space, paged.
    // Velodrome Sugar V3 uses positions(uint256,uint256,address), selector
    // 0xedbd33bf (no factory parameter, unlike Aerodrome's positionsByFactory).
    const span = await resolveSugarSpanForRegistry({
      rpc: OPTIMISM_RPC,
      account,
      sugar: SUGAR_ADDRESS,
      nftManager: NFT_MANAGER,
    });

    const sweep = await pageSugarPositions<RawPosition>({
      rpc: OPTIMISM_RPC,
      sugar: SUGAR_ADDRESS,
      span: span.span,
      buildCalldata: (limit, offset) =>
        '0xedbd33bf'
        + padUint256(BigInt(limit))
        + padUint256(BigInt(offset))
        + padAddress(account),
      decode: decodePositions,
    });

    // Windows are disjoint iteration ranges, so a duplicate id is not expected;
    // dedupe anyway rather than let one ever reach the dashboard twice.
    const seen = new Set<string>();
    const rawPositions = sweep.rows.filter((p) => !seen.has(p.id) && seen.add(p.id));

    // Truncation is derived from ITERATION COVERAGE against the contract's own
    // ceilings, never from the row count — see sugarCeilingTruncations.
    const truncated: RouteTruncation[] = sugarCeilingTruncations('Optimism', span, {
      ...sweep,
      rows: rawPositions,
    });

    if (truncated.length > 0 || sweep.failedWindows.length > 0) {
      console.warn(
        `[velodrome] paged Sugar span=${span.span} calls=${sweep.calls} ms=${sweep.ms} `
        + `rows=${rawPositions.length} truncated=${truncated.map((t) => t.reason).join(',') || 'none'} `
        + `failedWindows=${sweep.failedWindows.length}`,
      );
    }

    if (rawPositions.length === 0) {
      // Still disclose: a swept-but-truncated empty is NOT the same answer as a
      // wallet that genuinely holds nothing (queue item B).
      return NextResponse.json({
        positions: [],
        count: 0,
        account,
        ...(truncated.length > 0 ? { truncated } : {}),
      });
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

    // 3b. (Sprint 1.10 Tier-3 fix) Resolve any pool token NOT in the hardcoded
    // TOKENS map via the shared platform-wide tokenResolver, so symbol AND
    // decimals come from on-chain truth — NEVER the old blind decimals=18
    // default, which silently corrupted amounts for non-18-decimal tokens. A
    // CoinGecko id is discovered where possible and merged into `prices`.
    // Mapped tokens are untouched (byte-identical).
    const resolvedMeta: Record<string, { symbol: string; decimals: number; priceable: boolean }> = {};
    {
      const unmapped = [...new Set(
        Object.values(poolTokens).flatMap((t) => [t.token0, t.token1]),
      )].filter((addr) => addr && !TOKENS[addr]);
      if (unmapped.length > 0) {
        const resolved = await Promise.all(
          unmapped.map(async (addr) => ({
            addr,
            token: await resolveToken({ chain: 'optimism', contractAddress: addr }),
          })),
        );
        const cgIds = [...new Set(resolved.map(({ token }) => token.cgId).filter((x): x is string => !!x))];
        const cgPrices = cgIds.length > 0 ? await fetchCachedCoinGeckoPrices(cgIds) : {};
        for (const { addr, token } of resolved) {
          resolvedMeta[addr] = { symbol: token.symbol, decimals: token.decimals, priceable: token.priceable };
          if (token.cgId && cgPrices[token.cgId] > 0) prices[addr] = cgPrices[token.cgId];
        }
      }
    }

    // 4. Transform to LPPosition format
    const positions = rawPositions.map((raw) => {
      const tokens = poolTokens[raw.lp];
      const t0Info = tokens ? TOKENS[tokens.token0] : null;
      const t1Info = tokens ? TOKENS[tokens.token1] : null;
      const r0 = tokens ? resolvedMeta[tokens.token0] : undefined;
      const r1 = tokens ? resolvedMeta[tokens.token1] : undefined;

      const t0Symbol = t0Info?.symbol ?? r0?.symbol ?? 'TOKEN0';
      const t1Symbol = t1Info?.symbol ?? r1?.symbol ?? 'TOKEN1';
      const t0Decimals = t0Info?.decimals ?? r0?.decimals ?? 18;
      const t1Decimals = t1Info?.decimals ?? r1?.decimals ?? 18;

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

      // RULE: Closed positions (liquidity = 0) must ALWAYS be returned and
      // never filtered out. Status is set to 'Closed' below. Applies to all
      // current and future protocol integrations on any chain.
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
        liquidity: totalLiquidity.toString(),
        price0,
        price1,
        token0Address: tokens?.token0,
        token1Address: tokens?.token1,
        poolAddress: raw.lp,
        walletAddress: account,
      };
    });

    // Recover positions the wallet once owned but Sugar no longer returns
    // because the NFT was burned on close (Velodrome Slipstream burns on full
    // exit). Returned as Closed records so they appear in the dashboard Closed
    // tab; their fees are recovered via /api/velodrome/activity?positionId=all.
    const heldIds = new Set(rawPositions.map((p) => p.id));
    const closedPositions = await buildClosedPositions(account, heldIds, prices);

    return NextResponse.json({
      positions: [...positions, ...closedPositions],
      count: positions.length + closedPositions.length,
      account,
      // Additive (queue item C Phase 1) — present ONLY when Sugar's cap bound.
      ...(truncated.length > 0 ? { truncated } : {}),
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