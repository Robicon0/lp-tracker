// The price of an Orca Whirlpool at one instruction, read from the program's own
// event logs ("Program data: <base64>"). Pure: no I/O.
//
// WHY THIS EXISTS
// A deposit or withdrawal leg is valued at the POOL price at its own instruction
// (the standing rule; the Sui engine reads it from the event's sqrt price, the
// EVM routes from the pool's sqrtPriceX96 at the block). The Solana engine had
// no such step: a token with no historical USD price left the leg unpriced even
// when the pool's other token was a stablecoin, and the page then dropped the
// whole position without a word.
//
// THREE WAYS TO THE PRICE, in order (each is exact, none is an estimate):
//   1. `liquidity-event` — a two-sided leg. LiquidityIncreased / Decreased carries
//      the tick range, the liquidity and both token amounts, and
//      amountB = L · (√P − √P_lower), so √P = amountB / L + √P_lower.
//   2. `same-tx-swap` — a one-sided leg whose transaction also swaps in the SAME
//      pool. Instructions of one transaction run back to back, so the swap's
//      post-price (swap before the leg) or pre-price (swap after it) IS the pool
//      price at the leg.
//   3. `pool-history` — a one-sided leg with no swap beside it. A pool's price
//      only moves on a swap, so the post-price of the last swap in the pool's
//      history before the leg's transaction is the pool price at the leg. The
//      caller does the chain read; `lastTradedSqrtPrice` reads the answer.
// A one-sided leg also proves on which side of its range the price stood. A
// price that contradicts that is rejected: the leg stays unpriced.

import { createHash } from 'crypto';
import { PublicKey } from '@solana/web3.js';

const eventDisc = (name: string) => createHash('sha256').update(`event:${name}`).digest().subarray(0, 8);
const DISC_TRADED = eventDisc('Traded');
const DISC_LIQ_IN = eventDisc('LiquidityIncreased');
const DISC_LIQ_OUT = eventDisc('LiquidityDecreased');

export interface WhirlTraded {
  kind: 'traded';
  pool: string;
  /** √price (raw token B per raw token A), not Q64.64. */
  preSqrt: number;
  postSqrt: number;
}
export interface WhirlLiquidity {
  kind: 'liquidity';
  dir: 'in' | 'out';
  pool: string;
  position: string;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  amountA: bigint;
  amountB: bigint;
}
export type WhirlEvent = WhirlTraded | WhirlLiquidity;

const u64 = (b: Buffer, o: number) => b.readBigUInt64LE(o);
const u128 = (b: Buffer, o: number) => u64(b, o) + (u64(b, o + 8) << 64n);
const sqrtFromX64 = (q: bigint) => Number(q) / 2 ** 64;
const sqrtAtTick = (tick: number) => Math.pow(1.0001, tick / 2);

/** Every Traded / LiquidityIncreased / LiquidityDecreased event in a transaction's logs, in log order. */
export function parseWhirlpoolEvents(logMessages: ReadonlyArray<string> | undefined | null): WhirlEvent[] {
  const out: WhirlEvent[] = [];
  for (const log of logMessages ?? []) {
    if (!log.startsWith('Program data: ')) continue;
    let b: Buffer;
    try { b = Buffer.from(log.slice('Program data: '.length), 'base64'); } catch { continue; }
    if (b.length < 8) continue;
    const d = b.subarray(0, 8);
    // Traded: whirlpool(32) a_to_b(1) pre_sqrt_price(u128) post_sqrt_price(u128) …
    if (d.equals(DISC_TRADED) && b.length >= 73) {
      out.push({ kind: 'traded', pool: new PublicKey(b.subarray(8, 40)).toBase58(), preSqrt: sqrtFromX64(u128(b, 41)), postSqrt: sqrtFromX64(u128(b, 57)) });
    // Liquidity*: whirlpool(32) position(32) tick_lower(i32) tick_upper(i32)
    // liquidity(u128) token_a_amount(u64) token_b_amount(u64) …
    } else if ((d.equals(DISC_LIQ_IN) || d.equals(DISC_LIQ_OUT)) && b.length >= 112) {
      out.push({
        kind: 'liquidity', dir: d.equals(DISC_LIQ_IN) ? 'in' : 'out',
        pool: new PublicKey(b.subarray(8, 40)).toBase58(),
        position: new PublicKey(b.subarray(40, 72)).toBase58(),
        tickLower: b.readInt32LE(72), tickUpper: b.readInt32LE(76),
        liquidity: u128(b, 80), amountA: u64(b, 96), amountB: u64(b, 104),
      });
    }
  }
  return out;
}

export interface LegRef { pool: string; position: string; dir: 'in' | 'out'; amountARaw: bigint; amountBRaw: bigint }

export type LegPoolPrice =
  /** `rawPrice` = raw token B per raw token A at the leg. */
  | { status: 'priced'; rawPrice: number; method: 'liquidity-event' | 'same-tx-swap' }
  /** One-sided, no swap beside it: the caller reads the pool's last swap before this transaction. */
  | { status: 'need-pool-history'; tickLower: number; tickUpper: number; side: 'a-only' | 'b-only' }
  | { status: 'none' };

// A leg that holds only token A proves the price stood at or below the range;
// only token B, at or above it.
const TOLERANCE = 1e-6;
export function consistentWithOneSided(sqrtP: number, side: 'a-only' | 'b-only', tickLower: number, tickUpper: number): boolean {
  if (!(sqrtP > 0) || !Number.isFinite(sqrtP)) return false;
  return side === 'a-only' ? sqrtP <= sqrtAtTick(tickLower) * (1 + TOLERANCE) : sqrtP >= sqrtAtTick(tickUpper) * (1 - TOLERANCE);
}

/** The pool price at one deposit / withdrawal leg, from its own transaction's events. */
export function poolPriceForLeg(events: ReadonlyArray<WhirlEvent>, leg: LegRef): LegPoolPrice {
  const candidates = events
    .map((e, i) => ({ e, i }))
    .filter((x): x is { e: WhirlLiquidity; i: number } => x.e.kind === 'liquidity' && x.e.pool === leg.pool && x.e.position === leg.position && x.e.dir === leg.dir);
  // Several legs of one position in one transaction: take the one with these amounts.
  const hit = candidates.find((x) => x.e.amountA === leg.amountARaw && x.e.amountB === leg.amountBRaw) ?? (candidates.length === 1 ? candidates[0] : undefined);
  // No liquidity event (an older program version): the leg cannot be placed
  // among the transaction's swaps, so nothing is derived.
  if (!hit) return { status: 'none' };
  const { e, i } = hit;
  const sqrtLower = sqrtAtTick(e.tickLower);
  const sqrtUpper = sqrtAtTick(e.tickUpper);

  if (e.amountA > 0n && e.amountB > 0n && e.liquidity > 0n) {
    const L = Number(e.liquidity);
    const sqrtP = Number(e.amountB) / L + sqrtLower;
    // The same price must reproduce the token A amount (rounding aside).
    const checkA = L * (1 / sqrtP - 1 / sqrtUpper);
    const a = Number(e.amountA);
    if (sqrtP > sqrtLower && sqrtP < sqrtUpper && Math.abs(checkA - a) <= Math.max(a * 0.01, 2)) {
      return { status: 'priced', rawPrice: sqrtP * sqrtP, method: 'liquidity-event' };
    }
  }
  if (e.amountA === 0n && e.amountB === 0n) return { status: 'none' };

  const side: 'a-only' | 'b-only' | null = e.amountB === 0n ? 'a-only' : e.amountA === 0n ? 'b-only' : null;
  let before: WhirlTraded | undefined;
  let after: WhirlTraded | undefined;
  events.forEach((x, k) => {
    if (x.kind !== 'traded' || x.pool !== leg.pool) return;
    if (k < i) before = x; else if (k > i && !after) after = x;
  });
  const sqrtP = before ? before.postSqrt : after ? after.preSqrt : null;
  if (sqrtP != null) {
    const inRange = sqrtP >= sqrtLower * (1 - TOLERANCE) && sqrtP <= sqrtUpper * (1 + TOLERANCE);
    if (side ? consistentWithOneSided(sqrtP, side, e.tickLower, e.tickUpper) : inRange) {
      return { status: 'priced', rawPrice: sqrtP * sqrtP, method: 'same-tx-swap' };
    }
    return { status: 'none' };
  }
  if (!side) return { status: 'none' };
  return { status: 'need-pool-history', tickLower: e.tickLower, tickUpper: e.tickUpper, side };
}

/** √price after the last swap of `pool` in one transaction, or null when it has none. */
export function lastTradedSqrtPrice(logMessages: ReadonlyArray<string> | undefined | null, pool: string): number | null {
  let last: number | null = null;
  for (const e of parseWhirlpoolEvents(logMessages)) if (e.kind === 'traded' && e.pool === pool) last = e.postSqrt;
  return last;
}

/**
 * USD per whole token for both sides, given the pool price and ONE side's USD
 * price. The value of the leg does not depend on the unpriced token's decimals.
 */
export function usdPricesFromPool(
  rawPrice: number,
  known: { side: 'a' | 'b'; usd: number },
  decimalsA: number,
  decimalsB: number,
): { p0: number; p1: number } | null {
  if (!(rawPrice > 0) || !Number.isFinite(rawPrice) || !(known.usd > 0)) return null;
  const humanBperA = rawPrice * 10 ** (decimalsA - decimalsB);
  const p0 = known.side === 'b' ? humanBperA * known.usd : known.usd;
  const p1 = known.side === 'b' ? known.usd : known.usd / humanBperA;
  return Number.isFinite(p0) && Number.isFinite(p1) && p0 > 0 && p1 > 0 ? { p0, p1 } : null;
}
