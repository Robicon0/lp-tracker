// Gauge-staked CL position detection (Aerodrome / Velodrome Slipstream).
//
// ─────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS
//
// Staking a Slipstream CL position transfers its NFT to the pool's GAUGE. The
// position is still alive and earning — the user has not closed anything — but
// Sugar's `positionsByFactory` enumerates from DIRECTLY-HELD NFTs, so a staked
// position is invisible to it. The closed-position reconstruction
// (`everOwned − heldIds`) then read that absence as closure and booked the
// entire deposit as a realized loss.
//
// Measured on vfat Sickle 0x06C3F412…e09f: position 73551608 (~$10,000, still
// staked and earning AERO) was reported Closed with a Capital G/L of
// −$9,988.84. Perfect correlation on that wallet — the two Sickle-HELD
// positions were returned by Sugar, the one GAUGE-HELD position was omitted.
//
// This is NOT vfat-specific. Any address, EOA or contract, that stakes a
// Slipstream position is exposed; vfat merely stakes routinely.
//
// THE RULE: absence from the expected holder is NOT evidence of closure.
// Resolve what actually happened to the NFT before declaring a loss.
// ─────────────────────────────────────────────────────────────────────────
//
// Gauge identification is deliberately DOUBLE-CHECKED: the holder must both
// report `nft() == positionManager` AND be the address `voter.gauges(pool)`
// returns for that pool. Either alone could be spoofed by an arbitrary
// contract; together they are the protocol's own answer. If the two disagree we
// return null and the caller excludes the position rather than guessing.

import { evmRpcPost } from './evmRpc';

export interface StakedPositionState {
  isStaked: true;
  gauge: string;
  liquidity: bigint;
  tickLower: number;
  tickUpper: number;
  token0: string;
  token1: string;
  tickCurrent: number;
  sqrtPriceX96: bigint;
}

/** What happened to an ever-owned tokenId that Sugar did not return. */
export type HolderVerdict =
  | { kind: 'burned' }                          // genuinely closed
  | { kind: 'staked'; state: StakedPositionState }
  | { kind: 'third-party'; owner: string }      // transferred/sold — NOT a loss
  | { kind: 'unresolved' };                     // RPC failure — never assume closed

const SEL_OWNER_OF   = '0x6352211e'; // ownerOf(uint256)
const SEL_NFT        = '0x47ccca02'; // nft()
const SEL_GAUGES     = '0xb9a09fd5'; // gauges(address) on the Voter
const SEL_POSITIONS  = '0x99fbab88'; // positions(uint256)
const SEL_SLOT0      = '0x3850c7bd'; // slot0()
const SEL_TOKEN0     = '0x0dfe1681';
const SEL_TOKEN1     = '0xd21220a7';

// Gauge identity per pool is stable; cached in-process only (cheap, and a
// process-local map avoids taking a Redis dependency for a single eth_call).
const gaugeByPool = new Map<string, string | null>();

async function call(rpc: string, to: string, data: string): Promise<string | null> {
  const res = await evmRpcPost(rpc, {
    jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'],
  });
  if (res.error || typeof res.result !== 'string') return null;
  return res.result;
}

const word = (hex: string, i: number): bigint =>
  BigInt('0x' + hex.replace(/^0x/, '').slice(i * 64, (i + 1) * 64));
const addrAt = (hex: string, i: number): string =>
  '0x' + hex.replace(/^0x/, '').slice(i * 64 + 24, (i + 1) * 64).toLowerCase();
/** int24 stored in a 32-byte word, two's complement. */
const toInt24 = (v: bigint): number => {
  const n = Number(BigInt.asUintN(24, v));
  return n >= 0x800000 ? n - 0x1000000 : n;
};
const isZeroAddr = (a: string) => /^0x0{40}$/i.test(a);

/**
 * Determine what actually happened to a tokenId the position source did not
 * return. Callers MUST honour `unresolved` and `third-party` by excluding the
 * position, never by booking it as a closed loss.
 */
export async function resolveHolderVerdict(opts: {
  rpc: string;
  nftManager: string;
  voter: string;
  tokenId: string;
}): Promise<HolderVerdict> {
  const { rpc, nftManager, voter, tokenId } = opts;
  const idHex = BigInt(tokenId).toString(16).padStart(64, '0');

  // 1. ownerOf — a revert means the NFT was burned, i.e. genuinely closed.
  const ownerRes = await evmRpcPost(rpc, {
    jsonrpc: '2.0', id: 1, method: 'eth_call',
    params: [{ to: nftManager, data: SEL_OWNER_OF + idHex }, 'latest'],
  });
  if (ownerRes.error) {
    const msg = ownerRes.error.message ?? '';
    // A genuine burn reverts. A transport failure must NOT be read as a burn.
    if (/revert/i.test(msg)) return { kind: 'burned' };
    return { kind: 'unresolved' };
  }
  if (typeof ownerRes.result !== 'string' || ownerRes.result.length < 66) return { kind: 'unresolved' };
  const owner = addrAt(ownerRes.result, 0);

  // 2. The position's own pool + range, needed both to identify the gauge and
  //    to value the position.
  const posHex = await call(rpc, nftManager, SEL_POSITIONS + idHex);
  if (!posHex || posHex.length < 2 + 64 * 12) return { kind: 'unresolved' };
  // Slipstream positions(): nonce, operator, token0, token1, tickSpacing,
  // tickLower, tickUpper, liquidity, ...
  const token0 = addrAt(posHex, 2);
  const token1 = addrAt(posHex, 3);
  const tickLower = toInt24(word(posHex, 5));
  const tickUpper = toInt24(word(posHex, 6));
  const liquidity = word(posHex, 7);

  // A staked-then-fully-withdrawn position has no liquidity — genuinely closed.
  if (liquidity === 0n) return { kind: 'burned' };

  // 3. Identify the pool by matching the holder's claimed pool, then confirm
  //    the Voter agrees this holder is that pool's gauge.
  const claimedPool = await call(rpc, owner, '0x16f0115b'); // pool()
  if (!claimedPool || claimedPool.length < 66) return { kind: 'third-party', owner };
  const pool = addrAt(claimedPool, 0);
  if (isZeroAddr(pool)) return { kind: 'third-party', owner };

  // Check A: the holder manages THIS position manager's NFTs.
  const holderNft = await call(rpc, owner, SEL_NFT);
  const nftOk = !!holderNft && addrAt(holderNft, 0) === nftManager.toLowerCase();

  // Check B: the protocol's Voter names this exact address as the pool's gauge.
  let gaugeOk = false;
  const cached = gaugeByPool.get(pool);
  if (cached !== undefined) {
    gaugeOk = cached === owner;
  } else {
    const g = await call(rpc, voter, SEL_GAUGES + '0'.repeat(24) + pool.slice(2));
    const gaugeAddr = g && g.length >= 66 ? addrAt(g, 0) : null;
    gaugeByPool.set(pool, gaugeAddr);
    gaugeOk = gaugeAddr === owner;
  }

  // BOTH must agree. Either alone could be an arbitrary contract impersonating
  // the shape; together they are the protocol's own answer.
  if (!nftOk || !gaugeOk) return { kind: 'third-party', owner };

  // 4. Current pool price, for real (not midpoint-estimated) amounts.
  const slot0 = await call(rpc, pool, SEL_SLOT0);
  if (!slot0 || slot0.length < 2 + 64 * 2) return { kind: 'unresolved' };
  const sqrtPriceX96 = word(slot0, 0);
  const tickCurrent = toInt24(word(slot0, 1));

  // Sanity: the pool must actually hold this pair.
  const [p0, p1] = await Promise.all([call(rpc, pool, SEL_TOKEN0), call(rpc, pool, SEL_TOKEN1)]);
  if (!p0 || !p1 || addrAt(p0, 0) !== token0 || addrAt(p1, 0) !== token1) {
    return { kind: 'third-party', owner };
  }

  return {
    kind: 'staked',
    state: { isStaked: true, gauge: owner, liquidity, tickLower, tickUpper, token0, token1, tickCurrent, sqrtPriceX96 },
  };
}

const Q96 = 2n ** 96n;
const sqrtRatioAtTick = (tick: number): number => Math.pow(1.0001, tick / 2);

/**
 * Token amounts for a CL position from the pool's REAL current price.
 *
 * Deliberately NOT the midpoint approximation used in uniswap/v3/route.ts —
 * that is an estimate, and this feeds a displayed dollar value. Standard
 * Uniswap-V3 branches: below range ⇒ all token0, above ⇒ all token1.
 */
export function amountsFromLiquidity(
  liquidity: bigint,
  tickLower: number,
  tickUpper: number,
  sqrtPriceX96: bigint,
  decimals0: number,
  decimals1: number,
): { amount0: number; amount1: number } {
  if (liquidity === 0n) return { amount0: 0, amount1: 0 };
  const L = Number(liquidity);
  const sqrtP = Number(sqrtPriceX96) / Number(Q96);
  const sqrtA = sqrtRatioAtTick(tickLower);
  const sqrtB = sqrtRatioAtTick(tickUpper);
  if (!isFinite(sqrtP) || !isFinite(sqrtA) || !isFinite(sqrtB) || sqrtA <= 0 || sqrtB <= sqrtA) {
    return { amount0: 0, amount1: 0 };
  }

  let raw0 = 0, raw1 = 0;
  if (sqrtP <= sqrtA) {
    raw0 = L * (1 / sqrtA - 1 / sqrtB);
  } else if (sqrtP >= sqrtB) {
    raw1 = L * (sqrtB - sqrtA);
  } else {
    raw0 = L * (1 / sqrtP - 1 / sqrtB);
    raw1 = L * (sqrtP - sqrtA);
  }
  return {
    amount0: Math.max(0, raw0) / 10 ** decimals0,
    amount1: Math.max(0, raw1) / 10 ** decimals1,
  };
}
