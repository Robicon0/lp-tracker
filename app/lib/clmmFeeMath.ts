// app/lib/clmmFeeMath.ts
//
// Shared concentrated-liquidity (CLMM) fee math for EVERY CLMM protocol on
// EVERY chain — Solana (Orca/Raydium) and Sui (Bluefin/Cetus/Momentum) today,
// and any future CLMM on any future chain. This is the canonical home for the
// fee-growth-delta math + the u128 underflow guard. Inline copies in route
// files are forbidden in new code (see .claude/rules/architecture-principles.md).
//
// Why shared (the Sprint 1.7/1.7c/1.7d lesson): the underflow guard and the
// fee-growth-inside recomputation are IDENTICAL across Orca, Bluefin, and
// Momentum — only the INPUTS differ (Solana decodes a binary account buffer;
// Sui extracts JSON dynamic-field values). Extracting the math once means every
// protocol — current and future — inherits the underflow protection by importing
// it, not by a developer remembering to copy-paste a guard. The tick DECODER is
// NOT shared here: that problem (multiple binary account formats) is
// Solana-specific and lives in clmmTickDecoder.ts; Sui protocols feed JSON-
// extracted values straight into these pure functions.

import { logPrice } from './priceLogger';

export const U128_MASK = (1n << 128n) - 1n;
// High bit of a u128. A wrapped (feeGrowthInside − checkpoint) value at or above
// this is an underflow (the unmasked subtraction would have been negative).
export const U128_HIGH_BIT = 1n << 127n;

export interface PendingFeeResult {
  fee: bigint;          // pending fee for one token side (settled fees added by caller)
  guarded: boolean;     // true iff an underflow was detected and fee forced to 0
  wrappedDelta: bigint; // the wrapped (inside − checkpoint) value, for diagnostics
}

// Pending fee for ONE token side, with the u128 underflow guard. The per-position
// fee-growth delta is a small POSITIVE number in correct operation: feeGrowthInside
// only grows while in range, so it is ≥ the stored checkpoint. For an out-of-range
// position the recomputed feeGrowthInside can land marginally BELOW the checkpoint,
// and the unsigned masked subtraction then wraps into the upper half of u128 (~2^128)
// instead of producing a small negative — which, ×liquidity, ÷decimals, ×price,
// yields implausible (sextillion-scale) USD fees. A LEGITIMATE accrual can never
// reach 2^127 (that would imply ~2^63 fee-units per unit of liquidity), so a
// high-bit-set delta is unambiguously an underflow → 0 for that side. Standard
// Uniswap-V3 fee-growth-delta semantics. Settled/already-owed fees are tracked
// separately by each caller and are unaffected by this guard.
//
// IMPORTANT: a guard fire is a SIGNAL, not a benign zero. It can indicate an
// upstream decoder gap (as it did for Orca's DynamicTickArray — Sprint 1.7c/1.7d).
// Always pair this with a verified tick/fee-growth decoder; never assume a guard
// fire means "fees are genuinely zero".
export function safeCalcPendingFee(
  liquidity: bigint,
  feeGrowthInside: bigint,
  checkpoint: bigint,
): PendingFeeResult {
  const wrappedDelta = (feeGrowthInside - checkpoint) & U128_MASK;
  if (wrappedDelta >= U128_HIGH_BIT) {
    return { fee: 0n, guarded: true, wrappedDelta };
  }
  return { fee: (liquidity * wrappedDelta) >> 64n, guarded: false, wrappedDelta };
}

// Standard Uniswap-V3 fee-growth-inside recomputation (identical across Orca,
// Bluefin, Momentum). Pure u128 math; callers supply values decoded from their
// own chain's storage (Solana buffer / Sui JSON). All inputs are u128 bigints.
export function calcFeeGrowthInside(
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

export interface UnderflowLogContext {
  protocol: string;                 // e.g. "orca", "bluefin", "momentum"
  chain: string;                    // e.g. "solana", "sui"
  positionId: string;
  pair: string;                     // e.g. "ZEC / USDC"
  side: 'token0' | 'token1';
}

// Emit the `fee_underflow_detected` [PRICE_LOG] event when a guard fired — so
// callers get the instrumentation for free and can't forget it. No-op when the
// result was not guarded.
export function emitFeeUnderflow(result: PendingFeeResult, ctx: UnderflowLogContext): void {
  if (!result.guarded) return;
  logPrice({
    event: 'fee_underflow_detected',
    protocol: ctx.protocol,
    chain: ctx.chain,
    positionId: ctx.positionId,
    pair: ctx.pair,
    side: ctx.side,
    raw_wrapped_value: result.wrappedDelta.toString(),
    status: 'guarded_to_zero',
  });
}
