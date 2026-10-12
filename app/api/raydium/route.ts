import { NextResponse } from 'next/server';
import { PositionListReadError, logPositionListReadFailure } from '../../lib/positionListRead';
import { createPositionReadGuard } from '../../lib/positionReadGuard';
import { PublicKey } from '@solana/web3.js';
import { fetchCachedCoinGeckoPrices } from '../../lib/priceCache';
import { resolveToken } from '../../lib/tokenResolver';
import { POOL_STATS_UNAVAILABLE, type RouteTruncation } from '../../lib/enumerationTruncation';

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

  // No answer from either token program is a failed read, never "owns nothing" (positionListRead.ts).
  if (!result1?.value || !result2?.value) throw new PositionListReadError('Raydium', 'wallet token accounts');
  const allAccounts = [...result1.value, ...result2.value];

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
  positionPubkey: string;  // position state account address
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

// Fetch and decode Raydium CLMM personal position accounts for the wallet's NFT
// mints — via DIRECT PDA derivation (["position", nftMint] under the CLMM
// program) + one batched getMultipleAccounts, mirroring the Orca route. This
// replaces the previous per-mint getProgramAccounts memcmp at offset 8, which
// could NEVER match: Raydium's Anchor accounts are BUMP-FIRST (a `bump: u8` at
// byte [8]), so nftMint actually lives at [9..41] — the memcmp silently returned
// no positions for EVERY Raydium wallet (Sprint RAYDIUM Phase A finding,
// byte-verified on live accounts). PDA derivation is layout-independent.
const PERSONAL_POSITION_DISC = Buffer.from('466f967ee60f1975', 'hex'); // sha256("account:PersonalPositionState")[..8]

function deriveRaydiumPositionPda(nftMint: string): string | null {
  try {
    return PublicKey.findProgramAddressSync(
      [Buffer.from('position'), new PublicKey(nftMint).toBytes()],
      new PublicKey(RAYDIUM_CLMM_PROGRAM),
    )[0].toBase58();
  } catch { return null; }
}

async function fetchRaydiumPositions(nftMints: string[]): Promise<RawRaydiumPosition[]> {
  const entries = nftMints
    .map((mint) => ({ mint, pda: deriveRaydiumPositionPda(mint) }))
    .filter((e): e is { mint: string; pda: string } => !!e.pda);
  const out: RawRaydiumPosition[] = [];
  for (let i = 0; i < entries.length; i += 100) {
    const batch = entries.slice(i, i + 100);
    const result = await solanaRpc('getMultipleAccounts', [
      batch.map((e) => e.pda), { encoding: 'base64' },
    ]) as { value: Array<{ data: [string, string]; owner: string } | null> } | null;
    if (!result?.value) throw new PositionListReadError('Raydium', 'position accounts');
    const values = result.value;
    batch.forEach((e, k) => {
      const acc = values[k];
      if (!acc?.data?.[0] || acc.owner !== RAYDIUM_CLMM_PROGRAM) return;
      const data = Buffer.from(acc.data[0], 'base64');
      // Raydium CLMM PersonalPositionState layout (BUMP-FIRST — every field is
      // one byte later than the pre-Sprint-RAYDIUM comments assumed; verified
      // byte-for-byte on-chain, Phase A):
      // [0..8]    discriminator (466f967ee60f1975)
      // [8]       bump (u8)
      // [9..41]   nftMint (pubkey)
      // [41..73]  poolId (pubkey)
      // [73..77]  tickLower (i32 LE)
      // [77..81]  tickUpper (i32 LE)
      // [81..97]  liquidity (u128 LE)
      // [97..113]  feeGrowthInside0LastX64 (u128)
      // [113..129] feeGrowthInside1LastX64 (u128)
      // [129..137] tokenFeesOwed0 (u64 LE)
      // [137..145] tokenFeesOwed1 (u64 LE)
      if (data.length < 145 || !data.subarray(0, 8).equals(PERSONAL_POSITION_DISC)) return;
      out.push({
        nftMint: e.mint,
        positionPubkey: e.pda,
        poolId: readPubkey(data, 41),
        tickLower: readI32LE(data, 73),
        tickUpper: readI32LE(data, 77),
        liquidity: readU128LE(data, 81),
        tokenFeesOwed0: readU64LE(data, 129),
        tokenFeesOwed1: readU64LE(data, 137),
      });
    });
  }
  return out;
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

  // Raydium CLMM PoolState layout (BUMP-FIRST — Sprint RAYDIUM Phase A verified
  // on-chain; the pre-fix offsets were one byte early, e.g. decimals read 138):
  // [0..8]    discriminator (f7ede3f5d7c3de46 = sha256("account:PoolState")[..8])
  // [8]       bump (u8)
  // [9..41]   ammConfig (pubkey)
  // [41..73]  owner (pubkey)
  // [73..105] tokenMint0 (pubkey)
  // [105..137] tokenMint1 (pubkey)
  // [137..169] tokenVault0 (pubkey)
  // [169..201] tokenVault1 (pubkey)
  // [201..233] observationKey (pubkey)
  // [233]     mintDecimals0 (u8)
  // [234]     mintDecimals1 (u8)
  // [235..237] tickSpacing (u16 LE)
  // [237..253] liquidity (u128 LE)
  // [253..269] sqrtPriceX64 (u128 LE)
  // [269..273] tickCurrent (i32 LE)

  return {
    tokenMint0: readPubkey(data, 73),
    tokenMint1: readPubkey(data, 105),
    mintDecimals0: data[233],
    mintDecimals1: data[234],
    tickCurrent: readI32LE(data, 269),
    liquidity: readU128LE(data, 237),
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
  const ids = [...new Set(Object.values(TOKENS).map((t) => t.coingeckoId))];
  const geckoData = await fetchCachedCoinGeckoPrices(ids);
  const prices: Record<string, number> = {};
  for (const [mint, token] of Object.entries(TOKENS)) {
    prices[mint] = geckoData[token.coingeckoId] || 0;
  }
  return prices;
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

// Fee APR + TVL for the wallet's OWN pools, asked for by pool id.
//
// This used to download Raydium's whole pool list (`/v2/ammV3/ammPools`):
// 234.7 MB of JSON, 194,980 pools, for two numbers per pool. One parse peaks
// near 1.2 GB; the function instance was killed for running out of memory, and
// every wallet with a Raydium position got HTTP 500 instead of its positions
// (measured 2026-10-12; first logged 2026-08-29). The by-id endpoint answers
// about 2.4 KB per pool with the same two fields in the same units.
//
// Pool statistics are decoration: a failed lookup NEVER fails the route. The
// positions are returned without a fee APR and the response says so (`failed`).
const RAYDIUM_POOL_INFO_URL = 'https://api-v3.raydium.io/pools/info/ids';
const POOL_IDS_PER_REQUEST = 50;          // ids per request (URL length, bounded reply)
const POOL_STATS_TIMEOUT_MS = 8_000;
const POOL_STATS_TTL_MS = 5 * 60_000;     // same freshness the old list had (revalidate: 300)
const POOL_STATS_MAX_REPLY_CHARS = 2_000_000; // 50 pools is about 120 KB; anything far larger is not this reply
const POOL_STATS_CACHE_MAX = 2_000;

const poolStatsCache = new Map<string, { stats: RaydiumPoolStats | null; expiresAt: number }>();
const poolStatsInFlight = new Map<string, Promise<boolean>>();

// One request for up to POOL_IDS_PER_REQUEST ids. Resolves true when the reply
// was read (every asked id is then cached, with null for a pool the API does not
// list), false when it could not be read (nothing cached, asked again next time).
async function requestPoolStats(ids: string[]): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POOL_STATS_TIMEOUT_MS);
  try {
    const res = await fetch(`${RAYDIUM_POOL_INFO_URL}?ids=${ids.join(',')}`, { cache: 'no-store', signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > POOL_STATS_MAX_REPLY_CHARS) throw new Error(`reply too large (${text.length} chars)`);
    const json = JSON.parse(text) as { success?: boolean; data?: Array<{ id?: string; tvl?: number; week?: { feeApr?: number } } | null> };
    if (!json.success || !Array.isArray(json.data)) throw new Error('unexpected reply');
    const found = new Map<string, RaydiumPoolStats>();
    for (const pool of json.data) {
      if (pool?.id && typeof pool.tvl === 'number' && typeof pool.week?.feeApr === 'number') {
        found.set(pool.id, { feeAprWeek: pool.week.feeApr, tvl: pool.tvl });
      }
    }
    const expiresAt = Date.now() + POOL_STATS_TTL_MS;
    for (const id of ids) poolStatsCache.set(id, { stats: found.get(id) ?? null, expiresAt });
    while (poolStatsCache.size > POOL_STATS_CACHE_MAX) {
      const oldest = poolStatsCache.keys().next().value;
      if (oldest === undefined) break;
      poolStatsCache.delete(oldest);
    }
    return true;
  } catch (error) {
    console.error(`[Raydium] pool statistics could not be read for ${ids.length} pool(s):`, String(error));
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchRaydiumPoolStats(poolIds: string[]): Promise<{ stats: Record<string, RaydiumPoolStats>; failed: boolean }> {
  const now = Date.now();
  const need = poolIds.filter((id) => { const hit = poolStatsCache.get(id); return !hit || hit.expiresAt <= now; });
  // A pool already being asked for by another request is awaited, not asked for again.
  const waits = new Set<Promise<boolean>>();
  const ask: string[] = [];
  for (const id of need) {
    const pending = poolStatsInFlight.get(id);
    if (pending) waits.add(pending); else ask.push(id);
  }
  for (let i = 0; i < ask.length; i += POOL_IDS_PER_REQUEST) {
    const batch = ask.slice(i, i + POOL_IDS_PER_REQUEST);
    const p = requestPoolStats(batch).finally(() => { for (const id of batch) poolStatsInFlight.delete(id); });
    for (const id of batch) poolStatsInFlight.set(id, p);
    waits.add(p);
  }
  const answers = await Promise.all(waits);
  const stats: Record<string, RaydiumPoolStats> = {};
  for (const id of poolIds) {
    const hit = poolStatsCache.get(id);
    if (hit?.stats) stats[id] = hit.stats;
  }
  return { stats, failed: answers.some((ok) => !ok) };
}

// The page asks for this route from more than one place at once and retries a
// failure. Identical requests that overlap share ONE run; nothing is kept after
// it answers, so position values are never served stale.
const inFlightRequests = new Map<string, Promise<{ status: number; body: unknown }>>();

export async function GET(request: Request) {
  const account = new URL(request.url).searchParams.get('account') ?? '';
  const pending = inFlightRequests.get(account);
  if (pending) {
    const shared = await pending;
    return NextResponse.json(shared.body, { status: shared.status });
  }
  const run = (async () => {
    const res = await handleGet(request);
    return { status: res.status, body: await res.clone().json().catch(() => null) };
  })();
  inFlightRequests.set(account, run);
  try {
    const result = await run;
    return NextResponse.json(result.body, { status: result.status });
  } finally {
    inFlightRequests.delete(account);
  }
}

async function handleGet(request: Request): Promise<Response> {
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

    // 2. Fetch Raydium position accounts for all NFT mints in ONE batched call
    // (direct PDA derivation — see fetchRaydiumPositions for why memcmp is gone)
    const rawPositions = await fetchRaydiumPositions(nftMints);

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
    const [prices, poolStatsResult, dasTokens] = await Promise.all([
      fetchPrices(),
      fetchRaydiumPoolStats(uniquePools),
      fetchDasTokenInfo(unknownMints),
    ]);
    const raydiumPoolStats = poolStatsResult.stats;

    // Merge DAS prices for tokens not in TOKENS
    const allPrices: Record<string, number> = { ...prices };
    for (const [mint, info] of Object.entries(dasTokens)) {
      if (!allPrices[mint] && info.price > 0) allPrices[mint] = info.price;
    }

    // LAST RESORT: for any unknown mint where DAS returned a symbol but no
    // usable price, resolve the CoinGecko ID by symbol and fetch a real
    // spot price. Purely additive — TOKENS and DAS paths above are
    // untouched, and a null resolution leaves the mint at price 0
    // (position still renders).
    const stillMissing = unknownMints.filter((m) => !(allPrices[m] > 0));
    if (stillMissing.length > 0) {
      // Sprint 1.10: resolve still-unpriced mints (DAS missed them) via the
      // shared platform-wide tokenResolver — strictly more capable than the
      // prior symbol-search-only fallback. TOKENS + DAS paths above are
      // untouched, so previously-priced mints are byte-identical.
      const resolved = await Promise.all(
        stillMissing.map(async (m) => ({
          mint: m,
          token: await resolveToken({
            chain: 'solana',
            mint: m,
            symbolHint: dasTokens[m]?.symbol,
            decimalsHint: dasTokens[m]?.decimals,
          }),
        })),
      );
      const cgIds = [...new Set(resolved.map(({ token }) => token.cgId).filter((x): x is string => !!x))];
      if (cgIds.length > 0) {
        const dynamicPrices = await fetchCachedCoinGeckoPrices(cgIds);
        for (const { mint, token } of resolved) {
          const px = token.cgId ? dynamicPrices[token.cgId] : 0;
          if (px > 0) allPrices[mint] = px;
        }
      }
    }

    // 5. Transform to shared position shape
    // A zero value from a failed read is never returned (positionReadGuard.ts).
    const readGuard = createPositionReadGuard('Raydium', 'solana');
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
      readGuard.check({ id: `ray-${pos.positionPubkey}`, live: BigInt(pos.liquidity) > 0n, poolRead: !!pool, sides: pool ? [{ token: pool.tokenMint0, amount: amount0, price: price0 }, { token: pool.tokenMint1, amount: amount1, price: price1 }] : [] });

      const fees0 = Number(pos.tokenFeesOwed0) / 10 ** t0Decimals;
      const fees1 = Number(pos.tokenFeesOwed1) / 10 ** t1Decimals;
      const feesUsd = fees0 * price0 + fees1 * price1;

      // RULE: Closed positions (liquidity = 0) must ALWAYS be returned and
      // never filtered out. Status is set to 'Closed' below. Applies to all
      // current and future protocol integrations on any chain.
      // Solana caveat: when a position is fully closed via the protocol UI,
      // the position NFT is BURNED and cannot be recovered. Only zero-liquidity
      // positions whose NFT still exists surface here.
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
        id: `ray-${pos.positionPubkey}`,
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
        token0Address: pool?.tokenMint0,
        token1Address: pool?.tokenMint1,
        walletAddress: account,
      };
    });

    const unreadable = readGuard.response();
    if (unreadable) return unreadable;
    // Pool statistics that could not be read are reported, never silently shown
    // as "no APR". Not a `lookup-*` reason: no position, value or fee is missing.
    const truncated: RouteTruncation[] = poolStatsResult.failed
      ? [{ scope: 'pool statistics', cap: 0, returned: 0, knownTotal: null, reason: POOL_STATS_UNAVAILABLE }]
      : [];
    return NextResponse.json({ positions, count: positions.length, account, ...(truncated.length > 0 ? { truncated } : {}) });
  } catch (error) {
    if (error instanceof PositionListReadError) {
      logPositionListReadFailure('Raydium', account, error);
      return NextResponse.json({ error: 'position-list-read-failed', protocol: 'Raydium' }, { status: 503 });
    }
    console.error('[Raydium] positions route failed:', error);
    return NextResponse.json(
      { error: 'Failed to fetch Raydium positions', details: String(error) },
      { status: 500 },
    );
  }
}
