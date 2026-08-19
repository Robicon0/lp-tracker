import { NextResponse } from 'next/server';
import { fetchCachedCoinGeckoPrices } from '../../lib/priceCache';
import { getEverOwnedTokenIds } from '../../lib/evmEverOwnedNftIds';
import { resolveToken } from '../../lib/tokenResolver';
import { resolveHolderVerdict, amountsFromLiquidity } from '../../lib/evmGaugeStaking';
import type { RouteTruncation } from '../../lib/enumerationTruncation';

const ALCHEMY_KEY = process.env.NEXT_PUBLIC_ALCHEMY_KEY;
const BASE_RPC = `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`;

const SUGAR_ADDRESS = '0x68c19e13618c41158fe4baba1b8fb3a9c74bdb0a';
// Aerodrome Voter — the protocol's own registry of pool -> gauge. Used to
// CONFIRM that an NFT's holder really is that pool's gauge before treating a
// position as staked rather than closed (Sprint GAUGE-STAKING).
const AERODROME_VOTER = '0x16613524e02ad97edfef371bc883f2f5d6c480a5';
const CL_FACTORY = '0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A';

// Closed/burned-position recovery. Sugar only returns currently-held NFTs;
// Aerodrome Slipstream burns the NFT on full close, so closed positions vanish.
// We enumerate ever-owned tokenIds via Transfer→wallet logs and return the ones
// Sugar dropped as Closed records (display-only — fees are recovered via the
// activity route's positionId=all wallet-scope scan).
// Tenderly archive RPC is required for full-range eth_getLogs (Alchemy free
// tier caps at 10 blocks).
const TENDERLY_RPC = 'https://base.gateway.tenderly.co';
const NFT_MANAGER = '0x827922686190790b37229fd06084350E74485b72';
const NFT_DEPLOY_BLOCK = 13_844_000;
// IncreaseLiquidity (NFT manager) + pool Mint (CL pool) topic0 — used to derive
// a burned position's pool/tokens/ticks from its mint transaction.
const INCREASE_TOPIC = '0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f';
const POOL_MINT_TOPIC = '0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde';

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

// Queue item C Phase 1 — Sugar's `_limit` argument, named so the cap and the
// saturation check below cannot drift apart.
//
// ⚠️ Sugar's `_limit` counts POSITIONS but its `_offset` indexes POOLS, so the
// two are NOT the same cursor and `offset += limit` would skip or duplicate.
// That is why Phase 1 only DISCLOSES saturation and Phase 3 does the paging
// properly (pool-cursor paging, after verifying the deployed contract's
// semantics). Returning exactly `_limit` rows means the cap bound and there may
// be more — Sugar reports no total, so `knownTotal` is honestly null.
const SUGAR_LIMIT = 100;

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
// /api/aerodrome/activity?positionId=all (wallet-scope), so value/fees are 0.
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
  // "Not returned by Sugar" is NOT the same as "closed". Staking a Slipstream
  // position transfers its NFT to the pool's GAUGE, and Sugar enumerates only
  // DIRECTLY-HELD NFTs — so a live, earning, staked position looked closed and
  // had its entire deposit booked as a realized loss (measured: −$9,988.84 on a
  // ~$10k position). Resolve what actually happened to each NFT first.
  //
  // Verdicts other than `burned` are NEVER emitted as Closed:
  //   staked      → emitted below in the OPEN shape with its real current value
  //   third-party → transferred/sold; excluded (not our position, not our loss)
  //   unresolved  → RPC failure; excluded rather than guessed (Rule 11)
  const verdicts = await Promise.all(
    closedIds.map(async (id) => {
      try {
        return { id, v: await resolveHolderVerdict({ rpc: TENDERLY_RPC, nftManager: NFT_MANAGER, voter: AERODROME_VOTER, tokenId: id }) };
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
    const r0 = t0 ?? (await resolveToken({ chain: 'base', contractAddress: s.token0 }).catch(() => null));
    const r1 = t1 ?? (await resolveToken({ chain: 'base', contractAddress: s.token1 }).catch(() => null));
    const d0 = r0?.decimals ?? 18;
    const d1 = r1?.decimals ?? 18;
    const { amount0, amount1 } = amountsFromLiquidity(s.liquidity, s.tickLower, s.tickUpper, s.sqrtPriceX96, d0, d1);
    const p0 = prices[s.token0] ?? 0;
    const p1 = prices[s.token1] ?? 0;
    const value = amount0 * p0 + amount1 * p1;
    const inRange = s.tickCurrent >= s.tickLower && s.tickCurrent < s.tickUpper;
    stakedOut.push({
      id: `aero-${id}`,
      pair: `${r0?.symbol ?? 'TOKEN0'} / ${r1?.symbol ?? 'TOKEN1'}`,
      protocol: 'Aerodrome',
      chain: 'Base',
      value: Math.round(value * 100) / 100,
      apy: 0,
      fees: 0,
      // A staked position is OPEN. Emitting it with a non-Closed status is also
      // what keeps it out of Capital G/L, which is closed-positions-only
      // (pricing-invariants Rule 4).
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
      // Additive display metadata — nothing in the P&L pipeline reads these.
      isStaked: true,
      gaugeAddress: s.gauge,
    });
  }

  const trulyClosedIds = verdicts.filter(({ v }) => v.kind === 'burned').map(({ id }) => id);
  const excludedCount = verdicts.length - trulyClosedIds.length - stakedOut.length;
  if (stakedOut.length || excludedCount) {
    console.log(`[aerodrome] closed-scan: ${trulyClosedIds.length} burned, ${stakedOut.length} gauge-staked (kept OPEN), ${excludedCount} excluded (third-party/unresolved)`);
  }

  const closedBuilt = await Promise.all(trulyClosedIds.map(async (tokenId): Promise<Record<string, unknown>> => {
    const minimal: Record<string, unknown> = {
      id: `aero-${tokenId}`,
      pair: 'Aerodrome Position',
      protocol: 'Aerodrome',
      chain: 'Base',
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

      const receipt = await rpcResult(BASE_RPC, 'eth_getTransactionReceipt', [incLogs[0].transactionHash]) as
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
      + padUint256(BigInt(SUGAR_LIMIT))
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

    const truncated: RouteTruncation[] = [];
    if (rawPositions.length >= SUGAR_LIMIT) {
      truncated.push({
        scope: 'Base',
        cap: SUGAR_LIMIT,
        returned: rawPositions.length,
        knownTotal: null,
        reason: 'sugar-enumeration-cap',
      });
      console.warn(`[aerodrome] Sugar positionsByFactory returned exactly ${SUGAR_LIMIT} positions — the cap bound; more may exist`);
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
    // default, which silently corrupted amounts for non-18-decimal tokens
    // (the likely Account-1 "$57 vs hundreds" root cause). A CoinGecko id is
    // discovered where possible and merged into `prices`. Mapped tokens are
    // untouched (byte-identical).
    const resolvedMeta: Record<string, { symbol: string; decimals: number; priceable: boolean }> = {};
    {
      const unmapped = [...new Set(
        Object.values(poolTokens).flatMap((t) => [t.token0, t.token1]),
      )].filter((addr) => addr && !TOKENS[addr]);
      if (unmapped.length > 0) {
        const resolved = await Promise.all(
          unmapped.map(async (addr) => ({
            addr,
            token: await resolveToken({ chain: 'base', contractAddress: addr }),
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
        id: `aero-${raw.id}`,
        pair: `${t0Symbol} / ${t1Symbol}`,
        protocol: 'Aerodrome',
        chain: 'Base',
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
    // because the NFT was burned on close (Aerodrome Slipstream burns on full
    // exit). Returned as Closed records so they appear in the dashboard Closed
    // tab; their fees are recovered via /api/aerodrome/activity?positionId=all.
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