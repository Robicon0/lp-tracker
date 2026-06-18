// app/lib/clmmTickDecoder.ts
//
// Shared tick-array decoder dispatch for SOLANA CLMM protocols. Solana CLMMs
// (Orca, Raydium, and future forks) store tick state in BINARY account buffers
// identified by an 8-byte Anchor discriminator, and a single program can ship
// MULTIPLE on-chain formats over time (e.g. Orca's legacy fixed `TickArray` and
// the newer variable-length `DynamicTickArray` — Sprint 1.7c/1.7d). A decoder
// that only handles one format silently reads 0 for the others, collapsing
// feeGrowthInside to 0 and tripping the underflow guard while masking real fees.
//
// This registry makes format coverage explicit and additive: each protocol
// registers a decoder per discriminator at module load (register-once). An
// account whose discriminator matches NO registered decoder returns null, so the
// caller logs `unsupported_tick_array_format` and a new format fails LOUDLY in
// production instead of silently zeroing fees.
//
// SCOPE — Solana only. Sui CLMMs (Bluefin, Cetus, Momentum) do NOT use this:
// their tick state is a Move `Table` of JSON dynamic-field objects (no buffers,
// no discriminators, one format per protocol). A buffer/discriminator registry
// would be a leaky abstraction for them. Sui protocols extract JSON values and
// feed them straight into clmmFeeMath (see .claude/skills/add-new-protocol).

import { createHash } from 'crypto';

// Anchor account discriminator = first 8 bytes of sha256("account:<StructName>").
// e.g. anchorDiscriminator('DynamicTickArray') === [17,216,246,142,225,199,218,56].
export function anchorDiscriminator(accountName: string): Buffer {
  return createHash('sha256').update(`account:${accountName}`).digest().subarray(0, 8);
}

// Reads ONE tick's fee growth from a Solana CLMM tick-array account buffer.
// Returns {0,0} for an uninitialized tick (a VALID outcome), or null for a
// malformed / out-of-bounds buffer (the caller treats null as 'unsupported').
export type SolanaTickDecoder = (
  data: Buffer,
  localTickIndex: number,
) => { feeGrowthOutsideA: bigint; feeGrowthOutsideB: bigint } | null;

export interface TickDecodeResult {
  feeGrowthOutsideA: bigint;
  feeGrowthOutsideB: bigint;
  format: string; // the registered format name that answered (e.g. 'variable_length')
}

class SolanaCLMMTickRegistry {
  private decoders: Array<{ disc: Buffer; format: string; decode: SolanaTickDecoder }> = [];

  // Register a decoder for one account format. Idempotent (dev/HMR may re-import
  // a route module), so registering the same discriminator twice is a no-op.
  register(discriminator: Uint8Array, format: string, decode: SolanaTickDecoder): void {
    const disc = Buffer.from(discriminator);
    if (this.decoders.some((d) => d.disc.equals(disc))) return;
    this.decoders.push({ disc, format, decode });
  }

  // Decode one tick. Returns the fee growth + the matched format name, or null
  // when the account's discriminator matches no registered format OR the matched
  // decoder reports a malformed buffer. On null the caller logs
  // `unsupported_tick_array_format` and falls back to its zero/safety path.
  decode(data: Buffer, localTickIndex: number): TickDecodeResult | null {
    if (data.length < 8) return null;
    const disc = data.subarray(0, 8);
    const entry = this.decoders.find((d) => d.disc.equals(disc));
    if (!entry) return null;
    const r = entry.decode(data, localTickIndex);
    if (r === null) return null;
    return { feeGrowthOutsideA: r.feeGrowthOutsideA, feeGrowthOutsideB: r.feeGrowthOutsideB, format: entry.format };
  }

  // Introspection — which formats are currently registered (for diagnostics).
  registeredFormats(): string[] {
    return this.decoders.map((d) => d.format);
  }
}

// Process-wide singleton. Protocols register at module load; the route's tick
// fetcher calls decode().
export const solanaCLMMTickRegistry = new SolanaCLMMTickRegistry();
