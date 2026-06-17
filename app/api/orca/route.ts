import { NextResponse } from 'next/server';
import { PublicKey } from '@solana/web3.js';
import { fetchCachedCoinGeckoPrices } from '../../lib/priceCache';
import { resolveCgIds } from '../../lib/cgSymbolSearch';
import { logPrice } from '../../lib/priceLogger';

const HELIUS_KEY = process.env.HELIUS_API_KEY;
const SOLANA_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;

const WHIRLPOOL_PROGRAM = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_PROGRAM_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

// Known Solana tokens
const KNOWN_TOKENS: Record<string, { symbol: string; decimals: number; coingeckoId: string }> = {
  'So11111111111111111111111111111111111111112': { symbol: 'SOL', decimals: 9, coingeckoId: 'solana' },
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': { symbol: 'USDC', decimals: 6, coingeckoId: 'usd-coin' },
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': { symbol: 'USDT', decimals: 6, coingeckoId: 'tether' },
  '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R': { symbol: 'RAY', decimals: 6, coingeckoId: 'raydium' },
  '9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E': { symbol: 'WBTC', decimals: 6, coingeckoId: 'bitcoin' },
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So': { symbol: 'mSOL', decimals: 9, coingeckoId: 'msol' },
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs': { symbol: 'ETH', decimals: 8, coingeckoId: 'ethereum' },
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': { symbol: 'BONK', decimals: 5, coingeckoId: 'bonk' },
  'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1ABCDE': { symbol: 'ORCA', decimals: 6, coingeckoId: 'orca' },
  // RENDER on Solana — real mint is rndriz…, NOT 7vfCXTUXx5… (that's
  // Wormhole ETH above). CoinGecko ID is 'render-token' ('render' 404s).
  // decimals verified on-chain via Helius getAsset = 8.
  'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof': { symbol: 'RENDER', decimals: 8, coingeckoId: 'render-token' },
  // Fartcoin (pump.fun token) — decimals verified on-chain = 6.
  '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump': { symbol: 'Fartcoin', decimals: 6, coingeckoId: 'fartcoin' },
  // Zcash on Solana (zRwbz…) — decimals 8, CoinGecko ID 'zcash'.
  'zRwbzAUoaJABQdvBwZj3YGxiSWjAL2jNX2PBXEBfkMt': { symbol: 'ZEC', decimals: 8, coingeckoId: 'zcash' },
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

type TokenAccountsResult = {
  value: Array<{
    account: { data: { parsed: { info: { tokenAmount: { amount: string; decimals: number }; mint: string } } } };
  }>;
} | null;

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

function readU128LE(buf: Buffer, offset: number): bigint {
  let val = 0n;
  for (let i = 0; i < 16; i++) {
    val |= BigInt(buf[offset + i]) << BigInt(i * 8);
  }
  return val;
}

function readU64LE(buf: Buffer, offset: number): bigint {
  let val = 0n;
  for (let i = 0; i < 8; i++) {
    val |= BigInt(buf[offset + i]) << BigInt(i * 8);
  }
  return val;
}

function readI32LE(buf: Buffer, offset: number): number {
  return buf.readInt32LE(offset);
}

function readPubkey(buf: Buffer, offset: number): string {
  return new PublicKey(buf.subarray(offset, offset + 32)).toBase58();
}

interface OrcaPosition {
  positionPda: string;
  whirlpool: string;
  liquidity: bigint;
  feeOwedA: bigint;
  feeOwedB: bigint;
  tickLowerIndex: number;
  tickUpperIndex: number;
  feeGrowthInsideCheckpointA: bigint;
  feeGrowthInsideCheckpointB: bigint;
}

interface WhirlpoolData {
  tokenMintA: string;
  tokenMintB: string;
  tickCurrentIndex: number;
  decimalsA: number;
  decimalsB: number;
  tickSpacing: number;
  feeGrowthGlobalA: bigint;
  feeGrowthGlobalB: bigint;
  liquidity: bigint;
}

// Derive Orca Whirlpool position PDA from NFT mint
function derivePositionPda(mintAddress: string): string {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('position'), new PublicKey(mintAddress).toBytes()],
    WHIRLPOOL_PROGRAM
  );
  return pda.toBase58();
}

// Fetch multiple accounts in one RPC call
async function getMultipleAccounts(addresses: string[]): Promise<Array<{ data: Buffer } | null>> {
  if (addresses.length === 0) return [];

  const result = await solanaRpc('getMultipleAccounts', [
    addresses,
    { encoding: 'base64' },
  ]) as { value: Array<{ data: [string, string] } | null> } | null;

  if (!result?.value) return addresses.map(() => null);

  return result.value.map((acc) => {
    if (!acc?.data?.[0]) return null;
    return { data: Buffer.from(acc.data[0], 'base64') };
  });
}

// Decode Orca Whirlpool position account
// Layout:
// [0..8]    discriminator
// [8..40]   whirlpool (pubkey)
// [40..72]  positionMint (pubkey)
// [72..88]  liquidity (u128 LE)
// [88..92]  tickLowerIndex (i32 LE)
// [92..96]  tickUpperIndex (i32 LE)
// [96..112] feeGrowthCheckpointA (u128)
// [112..120] feeOwedA (u64 LE)
// [120..136] feeGrowthCheckpointB (u128)
// [136..144] feeOwedB (u64 LE)
// [144..216] rewardInfos (3 × 24 bytes)
function decodeOrcaPosition(data: Buffer, positionPda: string): OrcaPosition | null {
  if (data.length < 144) return null;

  const liquidity = readU128LE(data, 72);

  return {
    positionPda,
    whirlpool: readPubkey(data, 8),
    liquidity,
    feeOwedA: readU64LE(data, 112),
    feeOwedB: readU64LE(data, 136),
    tickLowerIndex: readI32LE(data, 88),
    tickUpperIndex: readI32LE(data, 92),
    feeGrowthInsideCheckpointA: readU128LE(data, 96),
    feeGrowthInsideCheckpointB: readU128LE(data, 120),
  };
}

// Fetch and decode Orca Whirlpool pool account
// Layout:
// [0..8]    discriminator
// [8..40]   whirlpoolsConfig (pubkey)
// [40..41]  whirlpoolBump ([u8; 1])
// [41..43]  tickSpacing (u16 LE)
// [43..45]  tickSpacingConst (u16)
// [45..47]  feeRate (u16 LE)
// [47..49]  protocolFeeRate (u16 LE)
// [49..65]  liquidity (u128 LE)
// [65..81]  sqrtPrice (u128 LE)
// [81..85]  tickCurrentIndex (i32 LE)
// [85..93]  protocolFeeOwedA (u64)
// [93..101] protocolFeeOwedB (u64)
// [101..133] tokenMintA (pubkey)
// [133..165] tokenVaultA (pubkey)
// [165..181] feeGrowthGlobalA (u128)
// [181..213] tokenMintB (pubkey)
// [213..245] tokenVaultB (pubkey)
// [245..261] feeGrowthGlobalB (u128)
async function fetchWhirlpoolData(poolAddress: string): Promise<WhirlpoolData | null> {
  const result = await solanaRpc('getAccountInfo', [
    poolAddress,
    { encoding: 'base64' },
  ]) as { value: { data: [string, string] } | null } | null;

  if (!result?.value?.data) return null;

  const data = Buffer.from(result.value.data[0], 'base64');
  if (data.length < 261) return null;

  const tokenMintA = readPubkey(data, 101);
  const tokenMintB = readPubkey(data, 181);

  return {
    tokenMintA,
    tokenMintB,
    tickCurrentIndex: readI32LE(data, 81),
    decimalsA: KNOWN_TOKENS[tokenMintA]?.decimals ?? 9,
    decimalsB: KNOWN_TOKENS[tokenMintB]?.decimals ?? 9,
    tickSpacing: data.readUInt16LE(41),
    feeGrowthGlobalA: readU128LE(data, 165),
    feeGrowthGlobalB: readU128LE(data, 245),
    liquidity: readU128LE(data, 49),
  };
}

// ── Tick array fee-growth helpers ─────────────────────────────────────────────
// Orca ships TWO on-chain tick-array account formats. Both store, per initialized
// tick, the SAME 113-byte element: [0] tag/initialized, [1..17] liquidityNet,
// [17..33] liquidityGross, [33..49] feeGrowthOutsideA, [49..65] feeGrowthOutsideB,
// [65..113] rewardGrowthsOutside[3]. They differ only in HEADER size + tick PACKING:
//   • Legacy fixed `TickArray` (disc 69,97,189,190,110,7,66,187; size 9956):
//     header 12 (disc 8 + startTickIndex i32 4); 88 fixed 113-byte ticks at
//     12 + idx*113; whirlpool pubkey trails the ticks.
//   • Variable-length `DynamicTickArray` (disc 17,216,246,142,225,199,218,56;
//     size varies): header 60 (disc 8 + startTickIndex i32 4 + whirlpool pubkey
//     32 + tickBitmap u128 16); then 88 borsh-enum ticks, each 1 byte
//     (Uninitialized=tag 0) or 113 bytes (Initialized=tag 1 + 112-byte data).
//     Account size = 60 + 113*N_init + (88 − N_init). Resizes as ticks init/deinit.
// Discriminators verified via Anchor sha256("account:<Name>")[:8]; the layout is
// from the orca-so/whirlpools program source and validated byte-exactly against
// on-chain account sizes (Account 1 ZEC/USDC: 3956=60+34*113+54, 6980=60+61*113+27).
// Sprint 1.7d — legacy path unchanged; dynamic path is additive.
const TICK_ARRAY_SIZE = 88;
const TICK_BYTES = 113;
const TICK_ARRAY_DATA_START = 12;        // legacy header
const DYN_TICK_ARRAY_DATA_START = 60;    // dynamic header (disc8 + start4 + pubkey32 + bitmap16)
const U128_MASK = (1n << 128n) - 1n;
// feeGrowthOutsideA/B offsets WITHIN a 113-byte initialized tick element — same
// for both formats: tag/init(1) + liquidityNet(16) + liquidityGross(16) = 33.
const TICK_FG_A_OFFSET = 33;
const TICK_FG_B_OFFSET = 49;
const LEGACY_TICK_ARRAY_DISC = Buffer.from([69, 97, 189, 190, 110, 7, 66, 187]);
const DYNAMIC_TICK_ARRAY_DISC = Buffer.from([17, 216, 246, 142, 225, 199, 218, 56]);

function tickArrayStartIndex(tick: number, tickSpacing: number): number {
  return Math.floor(tick / (TICK_ARRAY_SIZE * tickSpacing)) * (TICK_ARRAY_SIZE * tickSpacing);
}

type TickArrayFormat = 'legacy_fixed' | 'variable_length' | 'unsupported' | 'missing';
interface TickFeeOutside {
  feeGrowthOutsideA: bigint;
  feeGrowthOutsideB: bigint;
  format: TickArrayFormat;
  tickArrayAddress: string;
  discriminator?: string;  // present only when format === 'unsupported'
  accountSize?: number;    // present only when format === 'unsupported'
}

// Legacy fixed-format read: tick element at a fixed offset (unchanged behavior).
function readLegacyTick(data: Buffer, idxInArray: number): { A: bigint; B: bigint } {
  const off = TICK_ARRAY_DATA_START + idxInArray * TICK_BYTES;
  if (off + TICK_BYTES > data.length) return { A: 0n, B: 0n };
  if (data[off] === 0) return { A: 0n, B: 0n }; // not initialized
  return { A: readU128LE(data, off + TICK_FG_A_OFFSET), B: readU128LE(data, off + TICK_FG_B_OFFSET) };
}

// Variable-length (DynamicTickArray) read: walk the borsh enum array from the
// 60-byte header, advancing 1 byte per Uninitialized tick (tag 0) and 113 bytes
// per Initialized tick (tag 1), to the requested local index. Returns {0,0} for
// an uninitialized target (same semantics as legacy). Returns null on a
// malformed tag / out-of-bounds (caller treats as 'unsupported').
function readDynamicTick(data: Buffer, idxInArray: number): { A: bigint; B: bigint } | null {
  let off = DYN_TICK_ARRAY_DATA_START;
  for (let j = 0; j < idxInArray; j++) {
    if (off >= data.length) return null;
    const tag = data[off];
    if (tag === 0) off += 1;
    else if (tag === 1) off += TICK_BYTES;
    else return null; // malformed enum tag
  }
  if (off >= data.length) return null;
  const tag = data[off];
  if (tag === 0) return { A: 0n, B: 0n };   // target tick uninitialized
  if (tag !== 1) return null;               // malformed
  if (off + TICK_BYTES > data.length) return null;
  return { A: readU128LE(data, off + TICK_FG_A_OFFSET), B: readU128LE(data, off + TICK_FG_B_OFFSET) };
}

async function fetchTickFeeGrowthOutside(
  whirlpool: string,
  tick: number,
  tickSpacing: number,
): Promise<TickFeeOutside> {
  const startIdx = tickArrayStartIndex(tick, tickSpacing);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('tick_array'), new PublicKey(whirlpool).toBytes(), Buffer.from(startIdx.toString())],
    WHIRLPOOL_PROGRAM,
  );
  const addr = pda.toBase58();
  const base = { feeGrowthOutsideA: 0n, feeGrowthOutsideB: 0n, tickArrayAddress: addr };
  try {
    const result = await solanaRpc('getAccountInfo', [addr, { encoding: 'base64' }]) as
      { value: { data: [string, string] } | null } | null;
    if (!result?.value?.data) return { ...base, format: 'missing' };

    const data = Buffer.from(result.value.data[0], 'base64');
    const disc = data.subarray(0, 8);
    const idxInArray = (tick - startIdx) / tickSpacing;

    if (disc.equals(LEGACY_TICK_ARRAY_DISC)) {
      const t = readLegacyTick(data, idxInArray);
      return { ...base, feeGrowthOutsideA: t.A, feeGrowthOutsideB: t.B, format: 'legacy_fixed' };
    }
    if (disc.equals(DYNAMIC_TICK_ARRAY_DISC)) {
      const t = readDynamicTick(data, idxInArray);
      if (t === null) {
        return { ...base, format: 'unsupported', discriminator: Array.from(disc).join(','), accountSize: data.length };
      }
      return { ...base, feeGrowthOutsideA: t.A, feeGrowthOutsideB: t.B, format: 'variable_length' };
    }
    // Neither known format — surface the unknown account for a follow-up sprint,
    // fall back to 0 (same as the original missing/uninitialized behavior).
    return { ...base, format: 'unsupported', discriminator: Array.from(disc).join(','), accountSize: data.length };
  } catch {
    return { ...base, format: 'missing' };
  }
}

function calcFeeGrowthInside(
  tickLower: number,
  tickUpper: number,
  tickCurrent: number,
  feeGrowthGlobal: bigint,
  feeGrowthOutsideLower: bigint,
  feeGrowthOutsideUpper: bigint,
): bigint {
  const below = tickCurrent >= tickLower
    ? feeGrowthOutsideLower
    : (feeGrowthGlobal - feeGrowthOutsideLower) & U128_MASK;
  const above = tickCurrent < tickUpper
    ? feeGrowthOutsideUpper
    : (feeGrowthGlobal - feeGrowthOutsideUpper) & U128_MASK;
  return (feeGrowthGlobal - below - above) & U128_MASK;
}

// High bit of a u128. A wrapped (feeGrowthInside − checkpoint) value at or above
// this is an underflow (the unmasked subtraction would have been negative).
const U128_HIGH_BIT = 1n << 127n;

// Pending fee for one token side, with a u128 underflow guard (Sprint 1.7).
//
// In correct operation the per-position fee-growth delta is a small POSITIVE
// number: feeGrowthInside only grows while in range, so it is ≥ the stored
// checkpoint. But for an OUT-OF-RANGE position the recomputed feeGrowthInside
// can land marginally BELOW the checkpoint, and the unsigned masked subtraction
// `(feeGrowthInside − checkpoint) & U128_MASK` then wraps to the upper half of
// u128 (~2^128) instead of producing a small negative. Multiplied by liquidity
// and scaled by decimals/price, that wrap yields implausible (sextillion-scale)
// USD fees — the platform-wide bug this guards. A LEGITIMATE accrual can never
// reach 2^127 (that would imply ~2^63 fee-units per unit of liquidity), so a
// high-bit-set delta is unambiguously an underflow → 0 fees for that side. This
// is the standard Uniswap-V3 fee-growth-delta semantics. Settled, already-owed
// fees are tracked separately in feeOwedA/B and are unaffected by this guard.
//
// Applies to EVERY Orca position for EVERY user/wallet — not a per-position fix.
function calcPendingFee(
  liquidity: bigint,
  feeGrowthInside: bigint,
  checkpoint: bigint,
): { fee: bigint; guarded: boolean; wrappedDelta: bigint } {
  const wrappedDelta = (feeGrowthInside - checkpoint) & U128_MASK;
  if (wrappedDelta >= U128_HIGH_BIT) {
    return { fee: 0n, guarded: true, wrappedDelta };
  }
  return { fee: (liquidity * wrappedDelta) >> 64n, guarded: false, wrappedDelta };
}
// ──────────────────────────────────────────────────────────────────────────────

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
    amount0 = liq * (1 / sqrtLower - 1 / sqrtUpper);
  } else if (tickCurrent >= tickUpper) {
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

async function fetchPrices(): Promise<Record<string, number>> {
  const ids = [...new Set(Object.values(KNOWN_TOKENS).map((t) => t.coingeckoId))];
  const geckoData = await fetchCachedCoinGeckoPrices(ids);
  const prices: Record<string, number> = {};
  for (const [mint, token] of Object.entries(KNOWN_TOKENS)) {
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

interface OrcaPoolStats {
  feeAprWeek: number; // annualized decimal (e.g. 0.458 = 45.8%)
  tvl: number;        // USD
}

// Fetch per-pool APY + TVL from Orca's own API (keyed by pool address)
async function fetchOrcaPoolStats(): Promise<Record<string, OrcaPoolStats>> {
  try {
    const res = await fetch('https://api.mainnet.orca.so/v1/whirlpool/list', { next: { revalidate: 300 } });
    const data = await res.json();
    const stats: Record<string, OrcaPoolStats> = {};
    for (const pool of data.whirlpools || []) {
      if (pool.address && pool.feeApr?.week != null && pool.tvl != null) {
        stats[pool.address] = { feeAprWeek: pool.feeApr.week, tvl: pool.tvl };
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

    // 2. Derive Whirlpool position PDAs (skip invalid pubkeys)
    const pdaEntries: Array<{ mint: string; pda: string }> = [];
    for (const mint of nftMints) {
      try {
        pdaEntries.push({ mint, pda: derivePositionPda(mint) });
      } catch {
        // skip
      }
    }

    if (pdaEntries.length === 0) {
      return NextResponse.json({ positions: [], count: 0, account });
    }

    // 3. Fetch all position PDAs in batch
    const BATCH_SIZE = 100;
    const allAccountData: Array<{ data: Buffer } | null> = [];
    const pdaAddresses = pdaEntries.map((e) => e.pda);

    for (let i = 0; i < pdaAddresses.length; i += BATCH_SIZE) {
      const batch = pdaAddresses.slice(i, i + BATCH_SIZE);
      const results = await getMultipleAccounts(batch);
      allAccountData.push(...results);
    }

    // 4. Decode valid Orca positions
    const rawPositions: OrcaPosition[] = [];
    for (let i = 0; i < pdaAddresses.length; i++) {
      const accData = allAccountData[i];
      if (!accData) continue;
      const decoded = decodeOrcaPosition(accData.data, pdaAddresses[i]);
      if (decoded) rawPositions.push(decoded);
    }

    if (rawPositions.length === 0) {
      return NextResponse.json({ positions: [], count: 0, account });
    }

    // 5. Fetch unique whirlpool pool data
    const uniquePools = [...new Set(rawPositions.map((p) => p.whirlpool))];
    const poolDataMap: Record<string, WhirlpoolData> = {};
    await Promise.all(
      uniquePools.map(async (poolAddr) => {
        const pool = await fetchWhirlpoolData(poolAddr);
        if (pool) poolDataMap[poolAddr] = pool;
      })
    );

    // 6. Fetch tick array fee-growth data for each position (lower + upper tick)
    type TickFeeData = { lowerA: bigint; lowerB: bigint; upperA: bigint; upperB: bigint };
    const tickFeeMap: Record<string, TickFeeData> = {};
    await Promise.all(
      rawPositions.map(async (pos) => {
        const pool = poolDataMap[pos.whirlpool];
        if (!pool) return;
        const [lower, upper] = await Promise.all([
          fetchTickFeeGrowthOutside(pos.whirlpool, pos.tickLowerIndex, pool.tickSpacing),
          fetchTickFeeGrowthOutside(pos.whirlpool, pos.tickUpperIndex, pool.tickSpacing),
        ]);
        // [PRICE_LOG] record which decoder format answered for each tick array
        // (Sprint 1.7d). 'missing' (uninitialized/non-existent account) is the
        // pre-existing zero-fallback and not logged.
        for (const r of [lower, upper]) {
          if (r.format === 'legacy_fixed' || r.format === 'variable_length') {
            logPrice({
              event: 'tick_decoder_used', protocol: 'orca', chain: 'solana',
              positionId: `orca-${pos.positionPda}`, tickArrayAddress: r.tickArrayAddress, format: r.format,
            });
          } else if (r.format === 'unsupported') {
            logPrice({
              event: 'unsupported_tick_array_format', protocol: 'orca', chain: 'solana',
              positionId: `orca-${pos.positionPda}`, tickArrayAddress: r.tickArrayAddress,
              discriminator: r.discriminator ?? '', account_size: r.accountSize ?? 0,
            });
          }
        }
        tickFeeMap[pos.positionPda] = {
          lowerA: lower.feeGrowthOutsideA, lowerB: lower.feeGrowthOutsideB,
          upperA: upper.feeGrowthOutsideA, upperB: upper.feeGrowthOutsideB,
        };
      })
    );

    // 7. Collect unknown mints, then fetch prices + pool stats + DAS token info in parallel
    const allMints = new Set<string>();
    for (const pool of Object.values(poolDataMap)) {
      allMints.add(pool.tokenMintA);
      allMints.add(pool.tokenMintB);
    }
    const unknownMints = [...allMints].filter((m) => !KNOWN_TOKENS[m]);

    const [prices, orcaPoolStats, dasTokens] = await Promise.all([
      fetchPrices(),
      fetchOrcaPoolStats(),
      fetchDasTokenInfo(unknownMints),
    ]);

    // Merge DAS prices for tokens not in KNOWN_TOKENS
    const allPrices: Record<string, number> = { ...prices };
    for (const [mint, info] of Object.entries(dasTokens)) {
      if (!allPrices[mint] && info.price > 0) allPrices[mint] = info.price;
    }

    // LAST RESORT: for any unknown mint where DAS returned a symbol but no
    // usable price (DAS missed it OR price_per_token was 0), resolve the
    // CoinGecko ID by symbol and fetch a real spot price. This catches
    // long-tail tokens (e.g. ZEC on Solana before it was added to
    // KNOWN_TOKENS) so positions render with a real value instead of $0.
    // Purely additive — KNOWN_TOKENS and DAS paths above are untouched, and
    // a null resolution leaves the mint at price 0 (position still renders).
    const stillMissing = unknownMints.filter((m) => !(allPrices[m] > 0));
    if (stillMissing.length > 0) {
      const symbolByMint: Record<string, string> = {};
      for (const m of stillMissing) {
        const sym = dasTokens[m]?.symbol;
        if (sym) symbolByMint[m] = sym;
      }
      const symbolToCgId = await resolveCgIds(Object.values(symbolByMint));
      const cgIds = [...new Set(Object.values(symbolToCgId))];
      if (cgIds.length > 0) {
        const dynamicPrices = await fetchCachedCoinGeckoPrices(cgIds);
        for (const [mint, sym] of Object.entries(symbolByMint)) {
          const cgId = symbolToCgId[sym.toUpperCase()];
          const px = cgId ? dynamicPrices[cgId] : 0;
          if (px > 0) allPrices[mint] = px;
        }
      }
    }

    // 8. Transform to shared position shape
    const positions = rawPositions.map((pos) => {
      const pool = poolDataMap[pos.whirlpool];
      const tAKnown = pool ? KNOWN_TOKENS[pool.tokenMintA] : null;
      const tBKnown = pool ? KNOWN_TOKENS[pool.tokenMintB] : null;
      const tADas = pool ? dasTokens[pool.tokenMintA] : null;
      const tBDas = pool ? dasTokens[pool.tokenMintB] : null;

      const tASymbol = tAKnown?.symbol || tADas?.symbol || 'TOKEN_A';
      const tBSymbol = tBKnown?.symbol || tBDas?.symbol || 'TOKEN_B';
      const tADecimals = tAKnown?.decimals ?? tADas?.decimals ?? pool?.decimalsA ?? 9;
      const tBDecimals = tBKnown?.decimals ?? tBDas?.decimals ?? pool?.decimalsB ?? 9;

      const { amount0, amount1 } = pool
        ? calculateAmounts(pos.liquidity, pos.tickLowerIndex, pos.tickUpperIndex, pool.tickCurrentIndex, tADecimals, tBDecimals)
        : { amount0: 0, amount1: 0 };

      const priceA = pool ? (allPrices[pool.tokenMintA] || 0) : 0;
      const priceB = pool ? (allPrices[pool.tokenMintB] || 0) : 0;
      const value = amount0 * priceA + amount1 * priceB;

      // Settled fees (ready to claim) + pending fees (accrued since last checkpoint)
      let feesA = Number(pos.feeOwedA) / 10 ** tADecimals;
      let feesB = Number(pos.feeOwedB) / 10 ** tBDecimals;
      const tf = tickFeeMap[pos.positionPda];
      if (pool && tf) {
        const growthInsideA = calcFeeGrowthInside(
          pos.tickLowerIndex, pos.tickUpperIndex, pool.tickCurrentIndex,
          pool.feeGrowthGlobalA, tf.lowerA, tf.upperA,
        );
        const growthInsideB = calcFeeGrowthInside(
          pos.tickLowerIndex, pos.tickUpperIndex, pool.tickCurrentIndex,
          pool.feeGrowthGlobalB, tf.lowerB, tf.upperB,
        );
        const pendA = calcPendingFee(pos.liquidity, growthInsideA, pos.feeGrowthInsideCheckpointA);
        const pendB = calcPendingFee(pos.liquidity, growthInsideB, pos.feeGrowthInsideCheckpointB);
        if (pendA.guarded) {
          logPrice({
            event: 'fee_underflow_detected', protocol: 'orca', chain: 'solana',
            positionId: `orca-${pos.positionPda}`, pair: `${tASymbol} / ${tBSymbol}`,
            side: 'token0', raw_wrapped_value: pendA.wrappedDelta.toString(), status: 'guarded_to_zero',
          });
        }
        if (pendB.guarded) {
          logPrice({
            event: 'fee_underflow_detected', protocol: 'orca', chain: 'solana',
            positionId: `orca-${pos.positionPda}`, pair: `${tASymbol} / ${tBSymbol}`,
            side: 'token1', raw_wrapped_value: pendB.wrappedDelta.toString(), status: 'guarded_to_zero',
          });
        }
        feesA += Number(pendA.fee) / 10 ** tADecimals;
        feesB += Number(pendB.fee) / 10 ** tBDecimals;
      }
      let feesUsd = feesA * priceA + feesB * priceB;

      // Belt-and-suspenders route-boundary guard (Sprint 1.7). The underflow
      // guard above fixes the known class; this defends every Orca position for
      // every user against any FUTURE overflow class we haven't anticipated. No
      // real LP position approaches $1e12 in fees, so a value above that is
      // definitionally a bug — zero the position's fees rather than poison the
      // dashboard/analytics totals, and surface it for analysis.
      const FEE_USD_PLAUSIBILITY_CEILING = 1e12;
      if (feesUsd > FEE_USD_PLAUSIBILITY_CEILING) {
        logPrice({
          event: 'fee_plausibility_exceeded', protocol: 'orca', chain: 'solana',
          positionId: `orca-${pos.positionPda}`, pair: `${tASymbol} / ${tBSymbol}`,
          fees_usd: feesUsd, status: 'zeroed',
        });
        feesA = 0;
        feesB = 0;
        feesUsd = 0;
      }

      // RULE: Closed positions (liquidity = 0) must ALWAYS be returned and
      // never filtered out. Status is set to 'Closed' in the returned object.
      // Applies to all current and future protocol integrations on any chain.
      // Solana caveat: when a position is fully closed via the protocol UI,
      // the position NFT is BURNED and cannot be recovered. Only zero-liquidity
      // positions whose NFT still exists surface here.
      const tickCurrent = pool?.tickCurrentIndex ?? 0;
      const inRange = pos.liquidity > 0n && tickCurrent >= pos.tickLowerIndex && tickCurrent < pos.tickUpperIndex;

      // Position-specific APY: pool_feeApr × (pool_tvl / position_value) × (pos_liq / pool_liq)
      const poolStats = orcaPoolStats[pos.whirlpool];
      let apy = 0;
      if (poolStats && value > 0 && pool && pool.liquidity > 0n) {
        const posLiqShare = Number(pos.liquidity) / Number(pool.liquidity);
        apy = Math.round(poolStats.feeAprWeek * 100 * (poolStats.tvl / value) * posLiqShare * 100) / 100;
      }

      return {
        id: `orca-${pos.positionPda}`,
        pair: `${tASymbol} / ${tBSymbol}`,
        protocol: 'Orca',
        chain: 'Solana',
        value: Math.round(value * 100) / 100,
        apy,
        fees: Math.round(feesUsd * 100) / 100,
        status: (pos.liquidity === 0n ? 'Closed' : inRange ? 'In Range' : 'Out of Range') as 'In Range' | 'Out of Range' | 'Closed',
        amount0: Math.round(amount0 * 1_000_000) / 1_000_000,
        amount1: Math.round(amount1 * 1_000_000) / 1_000_000,
        token0Symbol: tASymbol,
        token1Symbol: tBSymbol,
        fees0: Math.round(feesA * 1_000_000) / 1_000_000,
        fees1: Math.round(feesB * 1_000_000) / 1_000_000,
        tickLower: pos.tickLowerIndex,
        tickUpper: pos.tickUpperIndex,
        token0Decimals: tADecimals,
        token1Decimals: tBDecimals,
        liquidity: pos.liquidity.toString(),
        price0: priceA,
        price1: priceB,
        token0Address: pool?.tokenMintA,
        token1Address: pool?.tokenMintB,
        walletAddress: account,
      };
    });

    return NextResponse.json({ positions, count: positions.length, account });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to fetch Orca positions', details: String(error) },
      { status: 500 }
    );
  }
}
