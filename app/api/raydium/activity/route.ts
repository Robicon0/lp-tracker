import { NextResponse } from 'next/server';
import { withActivityRouteCache } from '../../../lib/activityRouteCache';
import { createHash } from 'crypto';
import { deriveDepositPrices } from '../../../lib/v3PriceDerivation';
import { prewarmDefillamaPrices, getCachedOnlyDefillamaPrice } from '../../../lib/defillamaPriceHistory';
import { logPrice } from '../../../lib/priceLogger';

const HELIUS_KEY = process.env.HELIUS_API_KEY;
const SOLANA_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
const RAYDIUM_CLMM_PROGRAM = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';

// Known Solana stablecoins (mint addresses, lowercased for comparison via .toLowerCase())
// Base58 is case-sensitive — these MUST be the result of actual_address.toLowerCase()
const STABLECOINS = new Set([
  'epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v', // USDC (EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v)
  'es9vmfrzacermjfrf4h2fyd4kconky11mcce8benwnyb', // USDT (Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB)
]);

// ── Anchor discriminator helpers ──────────────────────────────────────────────

function anchorDisc(name: string): Buffer {
  return createHash('sha256').update(`global:${name}`).digest().slice(0, 8);
}

const DISC = {
  open_position:                anchorDisc('open_position'),
  open_position_with_metadata:  anchorDisc('open_position_with_metadata'),
  // Sprint RAYDIUM: v2 + Token-2022 variants — ALL modern Raydium positions use
  // these (live census: open_position_v2, open_position_with_token22_nft,
  // increase/decrease_liquidity_v2 dominate; the v1 names appear only in older
  // history). Without them a modern position's every event was invisible.
  open_position_v2:             anchorDisc('open_position_v2'),
  open_position_with_token22_nft: anchorDisc('open_position_with_token22_nft'),
  increase_liquidity:           anchorDisc('increase_liquidity'),
  increase_liquidity_v2:        anchorDisc('increase_liquidity_v2'),
  decrease_liquidity:           anchorDisc('decrease_liquidity'),
  decrease_liquidity_v2:        anchorDisc('decrease_liquidity_v2'),
  close_position:               anchorDisc('close_position'),
  collect_remaining_rewards:    anchorDisc('collect_remaining_rewards'),
};

// Minimal base58 → Buffer decoder (no external deps)
function decodeBase58(s: string): Buffer {
  const ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const bytes: number[] = [0];
  for (const c of s) {
    const d = ALPHA.indexOf(c);
    if (d < 0) break;
    let carry = d;
    for (let i = bytes.length - 1; i >= 0; i--) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) { bytes.unshift(carry & 0xff); carry >>= 8; }
  }
  for (let i = 0; i < s.length && s[i] === '1'; i++) bytes.unshift(0);
  return Buffer.from(bytes);
}

function matchDisc(data: Buffer, disc: Buffer): boolean {
  return data.length >= 8 && data.subarray(0, 8).equals(disc);
}

type ActivityEventType = 'deposit' | 'withdrawal' | 'fee_claim';

// For decrease_liquidity, decode the u128 liquidity param (bytes 8..24, LE).
// If liquidity == 0 → pure fee collection (no actual liquidity removed).
function readU128LE(buf: Buffer, offset: number): bigint {
  let val = 0n;
  for (let i = 0; i < 16; i++) val |= BigInt(buf[offset + i]) << BigInt(i * 8);
  return val;
}

function classifyInstruction(b58Data: string): ActivityEventType | null {
  let bytes: Buffer;
  try { bytes = decodeBase58(b58Data); } catch { return null; }
  if (bytes.length < 8) return null;

  if (matchDisc(bytes, DISC.open_position) || matchDisc(bytes, DISC.open_position_with_metadata) ||
      matchDisc(bytes, DISC.open_position_v2) || matchDisc(bytes, DISC.open_position_with_token22_nft) ||
      matchDisc(bytes, DISC.increase_liquidity) || matchDisc(bytes, DISC.increase_liquidity_v2)) {
    return 'deposit';
  }
  if (matchDisc(bytes, DISC.close_position)) {
    return 'withdrawal';
  }
  if (matchDisc(bytes, DISC.decrease_liquidity) || matchDisc(bytes, DISC.decrease_liquidity_v2)) {
    // bytes 8..24 = liquidity u128 LE (same arg layout v1/v2) — if 0, this is a
    // pure fee claim (Raydium bundles fee collection into decrease_liquidity)
    if (bytes.length >= 24) {
      const liquidity = readU128LE(bytes, 8);
      if (liquidity === 0n) return 'fee_claim';
    }
    return 'withdrawal';
  }
  return null;
}

// ── RPC helpers ───────────────────────────────────────────────────────────────

async function solanaRpc(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(SOLANA_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json();
  return json.result;
}

interface SignatureInfo {
  signature: string;
  blockTime: number | null;
  err: unknown;
}

async function fetchAllSignatures(address: string): Promise<SignatureInfo[]> {
  const sigs: SignatureInfo[] = [];
  let before: string | undefined;

  for (let page = 0; page < 10; page++) {
    const params: unknown[] = [address, { limit: 100, ...(before ? { before } : {}) }];
    const result = await solanaRpc('getSignaturesForAddress', params) as SignatureInfo[] | null;
    if (!result || result.length === 0) break;
    sigs.push(...result);
    if (result.length < 100) break;
    before = result[result.length - 1].signature;
  }
  return sigs;
}

interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner: string;
  uiTokenAmount: { uiAmount: number | null; decimals: number; amount: string };
}

interface ParsedInstruction {
  programId: string;
  data?: string;
  accounts?: string[];
  parsed?: unknown;
}

interface SolTransaction {
  transaction: {
    message: {
      instructions: ParsedInstruction[];
      accountKeys: Array<{ pubkey: string } | string>;
    };
  };
  meta: {
    preTokenBalances: TokenBalance[];
    postTokenBalances: TokenBalance[];
    preBalances: number[];
    postBalances: number[];
    err: unknown;
  } | null;
  blockTime: number | null;
}

async function fetchTransactions(signatures: string[]): Promise<(SolTransaction | null)[]> {
  const BATCH = 20;
  const results: (SolTransaction | null)[] = [];

  for (let i = 0; i < signatures.length; i += BATCH) {
    const batch = signatures.slice(i, i + BATCH);
    const batchResults = await Promise.all(
      batch.map((sig) =>
        solanaRpc('getTransaction', [
          sig,
          { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
        ]) as Promise<SolTransaction | null>
      )
    );
    results.push(...batchResults);
  }
  return results;
}

// Wrapped SOL mint — when this is one of the pool tokens, native SOL lamport
// changes must be checked as fallback (WSOL ATAs are often created+closed in
// the same transaction, making pre/postTokenBalances show delta = 0).
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

function getTokenDeltaRaw(pre: TokenBalance[], post: TokenBalance[], owner: string, mint: string): bigint {
  const sum = (arr: TokenBalance[]) =>
    arr.filter(b => b.owner === owner && b.mint === mint)
       .reduce((s, b) => s + BigInt(b.uiTokenAmount.amount), 0n);
  return sum(post) - sum(pre);
}

function getNativeSolDelta(tx: SolTransaction, owner: string): bigint {
  const keys = tx.transaction.message.accountKeys;
  const idx = keys.findIndex(k => (typeof k === 'string' ? k : k.pubkey) === owner);
  if (idx < 0 || !tx.meta) return 0n;
  const pre = BigInt(tx.meta.preBalances[idx] ?? 0);
  const post = BigInt(tx.meta.postBalances[idx] ?? 0);
  return post - pre;
}


// ── Types ─────────────────────────────────────────────────────────────────────

export interface ActivityEvent {
  type: ActivityEventType;
  txHash: string;
  timestamp: number;
  amount0: number;
  amount1: number;
  usdAtTime: number | null;
  // Per-event historical prices — not yet populated for Solana (always null this phase).
  price0AtTime: number | null;
  price1AtTime: number | null;
  // ITEM 0b — set ONLY when this event's claim-date historical price was cold
  // and CURRENT SPOT was substituted. Consumers treat it as not-yet-final.
  priceBasis?: 'current-spot-substituted' | 'tick-derived-estimate';
  cumulativeFeeUSD: number;
}

interface ActivityResponse {
  events: ActivityEvent[];
  netInvested0: number;
  netInvested1: number;
  totalFees0: number;
  totalFees1: number;
}

// ── Route handler ─────────────────────────────────────────────────────────────

export const GET = withActivityRouteCache(GET_impl);

async function GET_impl(request: Request) {
  const { searchParams } = new URL(request.url);
  const positionId = searchParams.get('positionId'); // Raydium position state account pubkey
  const account    = searchParams.get('account') ?? '';
  const decimalsA  = parseInt(searchParams.get('t0d') ?? '9', 10);
  const decimalsB  = parseInt(searchParams.get('t1d') ?? '6', 10);
  const mintA      = searchParams.get('mintA') ?? '';
  const mintB      = searchParams.get('mintB') ?? '';
  const fallbackA  = parseFloat(searchParams.get('priceA') ?? '0');
  const fallbackB  = parseFloat(searchParams.get('priceB') ?? '0');
  const tickLower  = searchParams.get('tickLower') != null ? parseInt(searchParams.get('tickLower')!, 10) : null;
  const tickUpper  = searchParams.get('tickUpper') != null ? parseInt(searchParams.get('tickUpper')!, 10) : null;

  if (!positionId || !account) {
    return NextResponse.json({ error: 'positionId and account required' }, { status: 400 });
  }
  if (!HELIUS_KEY) {
    return NextResponse.json({ error: 'Helius API key not configured' }, { status: 500 });
  }

  try {
    const allSigs = await fetchAllSignatures(positionId);

    if (allSigs.length === 0) {
      return NextResponse.json({
        events: [], netInvested0: 0, netInvested1: 0, totalFees0: 0, totalFees1: 0,
      } as ActivityResponse);
    }

    const validSigs = allSigs.filter(s => !s.err);
    const txs = await fetchTransactions(validSigs.map(s => s.signature));

    const scaleA = BigInt(10) ** BigInt(decimalsA);
    const scaleB = BigInt(10) ** BigInt(decimalsB);

    interface RawEvent {
      type: ActivityEventType;
      txHash: string;
      timestamp: number;
      rawA: bigint;
      rawB: bigint;
    }

    const rawEvents: RawEvent[] = [];
    let deposited0 = 0n, deposited1 = 0n;
    let withdrawn0 = 0n, withdrawn1 = 0n;
    let fees0 = 0n, fees1 = 0n;

    for (let i = 0; i < validSigs.length; i++) {
      const sig = validSigs[i];
      const tx = txs[i];
      if (!tx?.meta || tx.meta.err) continue;

      const ts = tx.blockTime ?? 0;
      const pre  = tx.meta.preTokenBalances ?? [];
      const post = tx.meta.postTokenBalances ?? [];

      // Scan ALL Raydium CLMM instructions to determine event type.
      // If a tx has both decrease_liquidity AND collect_fees (common when
      // closing a position), classify as withdrawal — the token delta includes
      // both and we must not double-count the withdrawal as fees.
      const instructions = tx.transaction?.message?.instructions ?? [];
      let hasWithdrawal = false;
      let hasFeeClaim = false;
      let evType: ActivityEventType | null = null;
      for (const instr of instructions) {
        if (instr.programId !== RAYDIUM_CLMM_PROGRAM) continue;
        if (!instr.data) continue;
        const t = classifyInstruction(instr.data);
        if (t === 'withdrawal') hasWithdrawal = true;
        if (t === 'fee_claim') hasFeeClaim = true;
        if (t && !evType) evType = t;
      }
      if (!evType) continue;
      if (hasWithdrawal && hasFeeClaim) evType = 'withdrawal';

      let deltaA = getTokenDeltaRaw(pre, post, account, mintA);
      if (deltaA === 0n && mintA === WSOL_MINT) {
        deltaA = getNativeSolDelta(tx, account);
      }
      let deltaB = getTokenDeltaRaw(pre, post, account, mintB);
      if (deltaB === 0n && mintB === WSOL_MINT) {
        deltaB = getNativeSolDelta(tx, account);
      }

      const rawA = evType === 'deposit' ? -deltaA : deltaA;
      const rawB = evType === 'deposit' ? -deltaB : deltaB;

      if (rawA === 0n && rawB === 0n) continue;

      rawEvents.push({ type: evType, txHash: sig.signature, timestamp: ts, rawA, rawB });

      if (evType === 'deposit') {
        deposited0 += rawA > 0n ? rawA : 0n;
        deposited1 += rawB > 0n ? rawB : 0n;
      } else if (evType === 'withdrawal') {
        withdrawn0 += rawA > 0n ? rawA : 0n;
        withdrawn1 += rawB > 0n ? rawB : 0n;
      } else if (evType === 'fee_claim') {
        fees0 += rawA > 0n ? rawA : 0n;
        fees1 += rawB > 0n ? rawB : 0n;
      }
    }

    rawEvents.sort((a, b) => a.timestamp - b.timestamp);

    // Claim-date historical pricing (Sprint 1.12): value each fee claim at the
    // token's market price ON THE DAY of the claim via DeFiLlama historical-by-
    // mint, instead of the current-spot fallback below (a latent pricing-
    // invariants Rule 1a issue, and $0 whenever spot was unavailable). DeFiLlama
    // prices Solana mints by contract; prewarm every non-stable claim-token mint
    // so the synchronous map can read it. Rule 1a: claim-date only, NEVER spot.
    const __claimTimestamps = rawEvents.filter((e) => e.type === 'fee_claim').map((e) => e.timestamp);
    if (__claimTimestamps.length > 0) {
      const __dl: Array<{ chain: 'solana'; contract: string; timestamps: number[] }> = [];
      if (mintA && !STABLECOINS.has(mintA.toLowerCase())) __dl.push({ chain: 'solana', contract: mintA, timestamps: __claimTimestamps });
      if (mintB && !STABLECOINS.has(mintB.toLowerCase())) __dl.push({ chain: 'solana', contract: mintB, timestamps: __claimTimestamps });
      if (__dl.length > 0) await prewarmDefillamaPrices(__dl);
    }

    const hasTicks = tickLower != null && tickUpper != null;
    let runningFeeUSD = 0;
    const events: ActivityEvent[] = rawEvents.map((ev) => {
      const amount0 = Number(ev.rawA > 0n ? ev.rawA : 0n) / Number(scaleA);
      const amount1 = Number(ev.rawB > 0n ? ev.rawB : 0n) / Number(scaleB);

      let price0AtTime: number | null = null;
      let price1AtTime: number | null = null;
      let usdAtTime: number | null = null;
      let priceBasis: 'current-spot-substituted' | 'tick-derived-estimate' | undefined;

      if ((ev.type === 'deposit' || ev.type === 'withdrawal') && hasTicks) {
        const derived = deriveDepositPrices(
          amount0, amount1, tickLower!, tickUpper!, decimalsA, decimalsB,
          mintA, mintB, STABLECOINS,
        );
        if (derived) {
            price0AtTime = derived.price0;
          price1AtTime = derived.price1;
          usdAtTime = amount0 * derived.price0 + amount1 * derived.price1;
          // ITEM 0b: this is a TICK-BOUNDARY ESTIMATE from the position's own
          // range, not the price at THIS event's block — so every event of the
          // position gets the SAME price, which makes a closed position's
          // deposit and withdrawal converge and its Capital G/L collapse
          // toward $0. Marked so the total declares itself not-yet-final.
          priceBasis = 'tick-derived-estimate';
        }
      }

      if (ev.type === 'fee_claim') {
        // Claim-date historical via DeFiLlama (Sprint 1.12). Stablecoin side $1;
        // every other side its DeFiLlama market price on the claim date. NEVER
        // current spot (pricing-invariants Rule 1a). If a side can't be priced
        // historically, the claim stays UNRESOLVED (null) → "pending price
        // resolution" — not coerced, not spot-valued.
        const isStableA = STABLECOINS.has(mintA.toLowerCase());
        const isStableB = STABLECOINS.has(mintB.toLowerCase());
        const pxA = isStableA ? 1 : getCachedOnlyDefillamaPrice('solana', mintA, ev.timestamp);
        const pxB = isStableB ? 1 : getCachedOnlyDefillamaPrice('solana', mintB, ev.timestamp);
        if (pxA != null && pxB != null) {
          price0AtTime = pxA;
          price1AtTime = pxB;
          usdAtTime = amount0 * pxA + amount1 * pxB;
        }
        const __src = (pxA != null && pxB != null)
          ? ((isStableA && isStableB) ? 'stablecoin-fixed' : 'defillama-historical')
          : 'unknown';
        logPrice({
          event: 'fee_claim_resolution',
          route: 'raydium',
          positionId: positionId ?? '',
          blockTimestamp: ev.timestamp,
          token0: { symbol: mintA, address: mintA, amount: String(amount0) },
          token1: { symbol: mintB, address: mintB, amount: String(amount1) },
          token0Usd: price0AtTime,
          token1Usd: price1AtTime,
          usdAtTime,
          status: usdAtTime == null ? 'failed_null_usdAtTime' : ((price0AtTime != null && price1AtTime != null) ? 'ok' : 'partial'),
          notes: `source=${__src}`,
        });
      } else if (usdAtTime == null) {
        // Deposits / withdrawals where on-chain derivation was unavailable:
        // current-spot last resort (pricing-invariants Rule 2 — point-in-time
        // position value, not historical earnings).
        // ITEM 0b: allowed but MARKED — never silently substituted.
        price0AtTime = fallbackA || null;
        price1AtTime = fallbackB || null;
        if (fallbackA > 0 || fallbackB > 0) {
          usdAtTime = amount0 * fallbackA + amount1 * fallbackB;
          priceBasis = 'current-spot-substituted';
        }
      }

      let cumulativeFeeUSD = 0;
      if (ev.type === 'fee_claim') {
        runningFeeUSD += usdAtTime ?? 0;
        cumulativeFeeUSD = runningFeeUSD;
      }

      return { type: ev.type, txHash: ev.txHash, timestamp: ev.timestamp, amount0, amount1, usdAtTime, price0AtTime, price1AtTime, ...(priceBasis ? { priceBasis } : {}), cumulativeFeeUSD };
    });

    events.reverse();

    return NextResponse.json({
      events,
      netInvested0: Number(deposited0 - (withdrawn0 > deposited0 ? deposited0 : withdrawn0)) / Number(scaleA),
      netInvested1: Number(deposited1 - (withdrawn1 > deposited1 ? deposited1 : withdrawn1)) / Number(scaleB),
      totalFees0: Number(fees0) / Number(scaleA),
      totalFees1: Number(fees1) / Number(scaleB),
    } as ActivityResponse);

  } catch (err) {
    console.error('[raydium/activity] Unexpected error:', err);
    return NextResponse.json(
      { error: 'Failed to fetch Raydium activity', details: String(err) },
      { status: 500 },
    );
  }
}
