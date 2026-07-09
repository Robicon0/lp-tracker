// Solana (Orca) closed-position retrieval + Capital G/L reconstruction (Sprint 3-FREE).
//
// WHY THIS EXISTS
// When an Orca Whirlpool position is fully closed, the position NFT is BURNED
// (transferred to no-one / supply→0) — so `getNftMints` (amount===1 filter) can
// no longer see it, and the open-position path in app/api/orca/route.ts has
// nothing to read. The ONLY retrieval path is to scan the WALLET's transaction
// history for the position's lifecycle instructions and reconstruct deposits /
// withdrawals / fee claims from the on-chain instruction data. The Whirlpool
// POOL account is never destroyed, so its token mints / vaults / decimals remain
// resolvable after the position is gone. (Sprint 3-FREE Phase A.)
//
// FREE-TIER INFRASTRUCTURE (Phase A verdict: GREEN)
// The scan runs on the FREE Alchemy Solana endpoint (ALCHEMY_SOLANA_RPC), NOT
// paid Helius. Phase A proved Alchemy free tier completes the full N+1 history
// scan (getSignaturesForAddress → getTransaction) that Helius free tier could
// not — it throttles under batched load (a compute-units-per-second cap) but
// RECOVERS via backoff and completes 100%. So the scan here is PACED: gentle
// serial batches + exponential backoff, retry-until-complete. It is a one-time
// per-wallet cost (~25k CU) then served from Redis forever (closed positions are
// immutable). Target is 100% completeness, not speed — it's a background scan.
//
// HOW IT PLUGS INTO Capital G/L (mirrors app/lib/suiClosedPositions.ts exactly)
// Each closed position is reconstructed as an ActivityEventForPnL[] with every
// event's `usdAtTime` resolved historical-only, then valued via the SAME pure
// engine EVM + Sui use — computePositionPnL() in app/lib/positionPnl.ts — so
// Capital G/L is byte-for-byte the same formula:
//   capitalGL = closingValue (Σ withdrawals) − initialValue (Σ deposits)
// Fees are NOT folded into Capital G/L (pricing-invariants Rule 4); they flow
// into Fee Income separately (useWalletLevelFees), exactly like Sui closed fees.
//
// VALUATION CASCADE (per side of every event; pricing-invariants Rule 1a)
//   1. Stablecoin side (USDC / USDT)     → $1.
//   2. Non-stable side                   → DeFiLlama historical-by-MINT at the
//      event timestamp (Sprint 1.12) → CoinGecko historical (by the resolver's
//      cgId) at the event timestamp (Sprint 1.6) → pending.
//   3. If every source fails → the event stays PENDING (usdAtTime null); it is
//      surfaced, never spot-valued (Rule 1a).
// There is NO current-spot fallback anywhere in this module. All mints are read
// from ON-CHAIN pool state, never a hardcoded map (invariant i — this is why the
// wrong ZEC / placeholder ORCA KNOWN_TOKENS entries are irrelevant here).

import { Redis } from '@upstash/redis';
import { PublicKey } from '@solana/web3.js';
import { createHash } from 'crypto';
import type { ActivityEventForPnL } from './positionPnl';
import { prewarmDefillamaPrices, getCachedOnlyDefillamaPrice } from './defillamaPriceHistory';
import { prewarmTokenPrices, getCachedOnlyTokenPrice } from './cgPriceHistory';
import { resolveToken } from './tokenResolver';
import { logPrice } from './priceLogger';

const ALCHEMY_RPC = process.env.ALCHEMY_SOLANA_RPC || '';
const WHIRLPOOL_PROGRAM = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const WHIRLPOOL_PROGRAM_PK = new PublicKey(WHIRLPOOL_PROGRAM);
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_PROGRAM_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

// Solana stablecoin mints — compared LOWERCASED (mirrors app/api/orca/activity).
const STABLE_MINTS = new Set([
  'epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v', // USDC
  'es9vmfrzacermjfrf4h2fyd4kconky11mcce8benwnyb', // USDT
]);

// Sprint RAYDIUM: Raydium CLMM joins Orca. ONE wallet-history scan serves BOTH
// protocols (the scan is per-WALLET, not per-protocol — parsing both programs
// from the same transactions costs zero extra RPC).
export type SolanaClmmProtocol = 'orca' | 'raydium';

// ── Raydium CLMM constants (Sprint RAYDIUM Phase A, all byte-verified live) ───
const RAYDIUM_PROGRAM = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';
const RAYDIUM_PROGRAM_PK = new PublicKey(RAYDIUM_PROGRAM);
// Anchor account discs. Raydium accounts are BUMP-FIRST (bump u8 at [8]) — every
// field sits one byte later than the naive layout (the Phase A production bug).
const RAY_POOL_DISC = createHash('sha256').update('account:PoolState').digest().slice(0, 8);
// Anchor EVENT discs ("Program data:" logs). DecreaseLiquidityEvent carries
// EXACT decrease amounts + fee amounts + reward amounts per event — Raydium
// bundles fee collection into decrease_liquidity (no separate collect_fees), so
// this log is the only precise fee/principal separation. Verified live:
// 3ade563a44325538.
const RAY_EVENT_DECREASE = createHash('sha256').update('event:DecreaseLiquidityEvent').digest().slice(0, 8);
const RAY_EVENT_INCREASE = createHash('sha256').update('event:IncreaseLiquidityEvent').digest().slice(0, 8);
const RAY_DISC: Record<string, Buffer> = {};
for (const n of [
  'open_position', 'open_position_v2', 'open_position_with_metadata', 'open_position_with_token22_nft',
  'increase_liquidity', 'increase_liquidity_v2',
  'decrease_liquidity', 'decrease_liquidity_v2',
  'close_position',
]) RAY_DISC[n] = anchorDisc(n);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Anchor discriminator dispatch (same approach as orca/activity, Phase A) ────
function anchorDisc(name: string): Buffer {
  return createHash('sha256').update(`global:${name}`).digest().slice(0, 8);
}
const DISC: Record<string, Buffer> = {};
for (const n of [
  'open_position', 'open_position_with_metadata', 'open_position_with_token_extensions',
  'increase_liquidity', 'increase_liquidity_v2',
  'decrease_liquidity', 'decrease_liquidity_v2',
  'collect_fees', 'collect_fees_v2',
  'collect_reward', 'collect_reward_v2',
  'close_position', 'close_position_with_token_extensions',
]) DISC[n] = anchorDisc(n);

// Minimal base58 → Buffer (no external deps; identical to orca/activity route).
function decodeBase58(s: string): Buffer {
  const ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const bytes: number[] = [0];
  for (const c of s) {
    const d = ALPHA.indexOf(c);
    if (d < 0) break;
    let carry = d;
    for (let i = bytes.length - 1; i >= 0; i--) { carry += bytes[i] * 58; bytes[i] = carry & 0xff; carry >>= 8; }
    while (carry > 0) { bytes.unshift(carry & 0xff); carry >>= 8; }
  }
  for (let i = 0; i < s.length && s[i] === '1'; i++) bytes.unshift(0);
  return Buffer.from(bytes);
}

type OrcaInstrKind = 'open' | 'deposit' | 'withdrawal' | 'fee' | 'reward' | 'close';
function classifyInstruction(data58: string): OrcaInstrKind | null {
  let b: Buffer;
  try { b = decodeBase58(data58); } catch { return null; }
  if (b.length < 8) return null;
  const d = b.subarray(0, 8);
  if (d.equals(DISC.open_position) || d.equals(DISC.open_position_with_metadata) || d.equals(DISC.open_position_with_token_extensions)) return 'open';
  if (d.equals(DISC.increase_liquidity) || d.equals(DISC.increase_liquidity_v2)) return 'deposit';
  if (d.equals(DISC.decrease_liquidity) || d.equals(DISC.decrease_liquidity_v2)) return 'withdrawal';
  if (d.equals(DISC.collect_fees) || d.equals(DISC.collect_fees_v2)) return 'fee';
  if (d.equals(DISC.collect_reward) || d.equals(DISC.collect_reward_v2)) return 'reward';
  if (d.equals(DISC.close_position) || d.equals(DISC.close_position_with_token_extensions)) return 'close';
  return null;
}

// Raydium instruction classifier. `decrease_liquidity(_v2)` with liquidity==0
// (u128 LE at arg bytes [8..24], same layout v1/v2) is a PURE fee claim —
// Raydium has no separate collect_fees instruction.
type RayInstrKind = 'open' | 'deposit' | 'withdrawal' | 'close';
function classifyRaydiumInstruction(data58: string): { kind: RayInstrKind | null; liq?: bigint } {
  let b: Buffer;
  try { b = decodeBase58(data58); } catch { return { kind: null }; }
  if (b.length < 8) return { kind: null };
  const d = b.subarray(0, 8);
  if (d.equals(RAY_DISC.open_position) || d.equals(RAY_DISC.open_position_v2) ||
      d.equals(RAY_DISC.open_position_with_metadata) || d.equals(RAY_DISC.open_position_with_token22_nft)) return { kind: 'open' };
  if (d.equals(RAY_DISC.increase_liquidity) || d.equals(RAY_DISC.increase_liquidity_v2)) return { kind: 'deposit' };
  if (d.equals(RAY_DISC.decrease_liquidity) || d.equals(RAY_DISC.decrease_liquidity_v2)) {
    let liq = 0n;
    if (b.length >= 24) for (let i = 0; i < 16; i++) liq |= BigInt(b[8 + i]) << BigInt(i * 8);
    return { kind: 'withdrawal', liq };
  }
  if (d.equals(RAY_DISC.close_position)) return { kind: 'close' };
  return { kind: null };
}

// Parse Raydium's Anchor event logs ("Program data: <base64>").
// DecreaseLiquidityEvent (IDL field order, verified live): position_nft_mint(32),
// liquidity(u128), decrease_amount_0(u64), decrease_amount_1(u64),
// fee_amount_0(u64), fee_amount_1(u64), reward_amounts(u64×3)[, transfer fees].
// IncreaseLiquidityEvent: position_nft_mint(32), liquidity(u128),
// amount_0(u64), amount_1(u64).
interface RayLogEvent { type: 'dec' | 'inc'; nftMint: string; a0: bigint; a1: bigint; fee0: bigint; fee1: bigint; rewards: [bigint, bigint, bigint]; used?: boolean }
function parseRaydiumEventLogs(tx: SolTx): RayLogEvent[] {
  const out: RayLogEvent[] = [];
  for (const log of tx.meta?.logMessages ?? []) {
    if (!log.startsWith('Program data: ')) continue;
    let buf: Buffer;
    try { buf = Buffer.from(log.slice('Program data: '.length), 'base64'); } catch { continue; }
    if (buf.length < 8) continue;
    const d = buf.subarray(0, 8);
    const u64 = (o: number) => { let v = 0n; for (let i = 0; i < 8; i++) v |= BigInt(buf[o + i]) << BigInt(i * 8); return v; };
    if (d.equals(RAY_EVENT_DECREASE) && buf.length >= 8 + 32 + 16 + 8 * 7) {
      out.push({ type: 'dec', nftMint: new PublicKey(buf.subarray(8, 40)).toBase58(), a0: u64(56), a1: u64(64), fee0: u64(72), fee1: u64(80), rewards: [u64(88), u64(96), u64(104)] });
    } else if (d.equals(RAY_EVENT_INCREASE) && buf.length >= 8 + 32 + 16 + 8 * 2) {
      out.push({ type: 'inc', nftMint: new PublicKey(buf.subarray(8, 40)).toBase58(), a0: u64(56), a1: u64(64), fee0: 0n, fee1: 0n, rewards: [0n, 0n, 0n] });
    }
  }
  return out;
}

// ── Alchemy JSON-RPC with throttle backoff (Phase A pacing) ───────────────────
export interface ScanStats { signatures: number; validSignatures: number; txFetched: number; throttleEvents: number; wallMs: number; billedCalls: number; complete: boolean; }

async function alchemyRpc(method: string, params: unknown[], stats: ScanStats): Promise<unknown> {
  for (let attempt = 0; attempt < 8; attempt++) {
    stats.billedCalls += 1;
    const res = await fetch(ALCHEMY_RPC, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (res.status === 429) { stats.throttleEvents += 1; await sleep(500 * (attempt + 1)); continue; }
    const j = await res.json();
    if (j?.error && (j.error.code === 429 || j.error.code === -32005)) { stats.throttleEvents += 1; await sleep(500 * (attempt + 1)); continue; }
    return j.result;
  }
  return null;
}

interface SigInfo { signature: string; err: unknown; }
async function fetchAllSignatures(wallet: string, stats: ScanStats): Promise<string[]> {
  const sigs: SigInfo[] = [];
  let before: string | undefined;
  for (let page = 0; page < 50; page++) {
    const r = (await alchemyRpc('getSignaturesForAddress', [wallet, { limit: 1000, ...(before ? { before } : {}) }], stats)) as SigInfo[] | null;
    if (!r || r.length === 0) break;
    sigs.push(...r);
    if (r.length < 1000) break;
    before = r[r.length - 1].signature;
  }
  stats.signatures = sigs.length;
  const valid = sigs.filter((s) => !s.err).map((s) => s.signature);
  stats.validSignatures = valid.length;
  return valid;
}

interface SolTx {
  transaction: { message: { instructions: RawInstr[]; accountKeys: Array<{ pubkey: string } | string> }; signatures?: string[] };
  meta: {
    err: unknown;
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
    innerInstructions?: Array<{ index: number; instructions: ParsedInner[] }>;
    logMessages?: string[]; // Anchor "Program data:" event logs (Raydium exact fees)
  } | null;
  blockTime: number | null;
}
interface RawInstr { programId: string; data?: string; accounts?: string[] }
interface ParsedInner { parsed?: { type?: string; info?: Record<string, unknown> } }
interface TokenBalance { accountIndex: number; mint: string; owner: string; uiTokenAmount: { amount: string; decimals: number } }

// PACED batched getTransaction with retry-until-complete. Phase A: batch=20
// serial, 120ms gap, exponential backoff on 429; a naive burst dropped 37% of
// txs, this achieves 100%. Returns a Map(signature → tx). Retries throttled
// items until the queue drains (bounded by attempt cap inside the batch).
async function fetchTransactions(sigs: string[], stats: ScanStats): Promise<Map<string, SolTx | null>> {
  const out = new Map<string, SolTx | null>();
  let queue = [...sigs];
  let outerGuard = 0;
  while (queue.length && outerGuard < 40) {
    outerGuard += 1;
    const next: string[] = [];
    for (let i = 0; i < queue.length; i += 20) {
      const batch = queue.slice(i, i + 20);
      const body = batch.map((s, k) => ({ jsonrpc: '2.0', id: k, method: 'getTransaction', params: [s, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }] }));
      stats.billedCalls += batch.length;
      const res = await fetch(ALCHEMY_RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (res.status === 429) { stats.throttleEvents += 1; next.push(...batch); await sleep(800); continue; }
      let j: unknown;
      try { j = await res.json(); } catch { stats.throttleEvents += 1; next.push(...batch); await sleep(800); continue; }
      if (!Array.isArray(j)) {
        const err = (j as { error?: { code?: number } })?.error;
        if (err && (err.code === 429 || err.code === -32005)) stats.throttleEvents += 1;
        next.push(...batch); await sleep(800); continue;
      }
      for (const r of j as Array<{ id: number; result?: SolTx | null; error?: { code?: number } }>) {
        const s = batch[r.id];
        if (r.error && (r.error.code === 429 || r.error.code === -32005)) { stats.throttleEvents += 1; next.push(s); }
        else { out.set(s, r.result ?? null); }
      }
      await sleep(120);
    }
    queue = next;
    if (queue.length) await sleep(1000);
  }
  stats.txFetched = [...out.values()].filter(Boolean).length;
  stats.complete = out.size === sigs.length;
  return out;
}

function accountKeysOf(tx: SolTx): string[] {
  return (tx.transaction.message.accountKeys || []).map((k) => (typeof k === 'string' ? k : k.pubkey));
}

// ── Pool context (mints + vaults + decimals) from the persistent pool account ──
// Whirlpool layout (see app/api/orca/route.ts): tokenMintA[101..133],
// tokenVaultA[133..165], tokenMintB[181..213], tokenVaultB[213..245].
interface PoolContext { mintA: string; mintB: string; vaultA: string; vaultB: string; decimalsA: number; decimalsB: number; }
const poolContextCache = new Map<string, PoolContext | null>();

async function fetchPoolContexts(pools: string[], decHint: Map<string, number>, stats: ScanStats): Promise<Map<string, PoolContext>> {
  const map = new Map<string, PoolContext>();
  const toFetch = pools.filter((p) => !poolContextCache.has(p));
  for (let i = 0; i < toFetch.length; i += 100) {
    const batch = toFetch.slice(i, i + 100);
    const res = (await alchemyRpc('getMultipleAccounts', [batch, { encoding: 'base64' }], stats)) as { value: Array<{ data: [string, string] } | null> } | null;
    const values = res?.value ?? [];
    batch.forEach((pool, k) => {
      const acc = values[k];
      if (!acc?.data?.[0]) { poolContextCache.set(pool, null); return; }
      const d = Buffer.from(acc.data[0], 'base64');
      if (d.length < 245) { poolContextCache.set(pool, null); return; }
      const mintA = new PublicKey(d.subarray(101, 133)).toBase58();
      const vaultA = new PublicKey(d.subarray(133, 165)).toBase58();
      const mintB = new PublicKey(d.subarray(181, 213)).toBase58();
      const vaultB = new PublicKey(d.subarray(213, 245)).toBase58();
      poolContextCache.set(pool, {
        mintA, mintB, vaultA, vaultB,
        decimalsA: decHint.get(mintA) ?? (mintA === WSOL_MINT ? 9 : 6),
        decimalsB: decHint.get(mintB) ?? (mintB === WSOL_MINT ? 9 : 6),
      });
    });
  }
  for (const p of pools) { const ctx = poolContextCache.get(p); if (ctx) map.set(p, ctx); }
  return map;
}

// getMultipleAccounts with retry-until-complete. A throttled batch must NOT be
// silently dropped — in Phase A a dropped batch silently hid a pool, discarding
// every event on it. Bounded retries per batch; a still-missing batch after the
// cap yields nulls (callers treat unresolved pools as skip, never garbage).
type GmaResult = { value: Array<{ data: [string, string]; owner: string } | null> } | null;
async function gmaAll(addrs: string[], stats: ScanStats): Promise<Map<string, { data?: [string, string]; owner?: string } | null>> {
  const out = new Map<string, { data?: [string, string]; owner?: string } | null>();
  for (let i = 0; i < addrs.length; i += 100) {
    const batch = addrs.slice(i, i + 100);
    let res: GmaResult = null;
    for (let a = 0; a < 10 && !res; a++) {
      res = (await alchemyRpc('getMultipleAccounts', [batch, { encoding: 'base64' }], stats)) as GmaResult;
      if (!res) await sleep(1000);
    }
    batch.forEach((addr, k) => out.set(addr, res?.value?.[k] ?? null));
  }
  return out;
}

// ── Raydium pool contexts (bump-first PoolState; Phase A byte-verified) ───────
// Candidates = every account referenced by a Raydium position instruction; the
// real pools are the ones owned by the CLMM program with the PoolState
// discriminator. Decimals come from the pool bytes themselves ([233],[234]).
const rayPoolContextCache = new Map<string, PoolContext | null>();
async function fetchRaydiumPoolContexts(candidates: string[], stats: ScanStats): Promise<Map<string, PoolContext>> {
  const map = new Map<string, PoolContext>();
  const toFetch = candidates.filter((c) => !rayPoolContextCache.has(c));
  if (toFetch.length > 0) {
    const gma = await gmaAll(toFetch, stats);
    for (const [addr, v] of gma) {
      if (!v?.data?.[0] || v.owner !== RAYDIUM_PROGRAM) { rayPoolContextCache.set(addr, null); continue; }
      const d = Buffer.from(v.data[0], 'base64');
      if (d.length < 273 || !d.subarray(0, 8).equals(RAY_POOL_DISC)) { rayPoolContextCache.set(addr, null); continue; }
      rayPoolContextCache.set(addr, {
        mintA: new PublicKey(d.subarray(73, 105)).toBase58(),
        mintB: new PublicKey(d.subarray(105, 137)).toBase58(),
        vaultA: new PublicKey(d.subarray(137, 169)).toBase58(),
        vaultB: new PublicKey(d.subarray(169, 201)).toBase58(),
        decimalsA: d[233],
        decimalsB: d[234],
      });
    }
  }
  for (const c of candidates) { const ctx = rayPoolContextCache.get(c); if (ctx) map.set(c, ctx); }
  return map;
}

// ── Raydium reconstruction ────────────────────────────────────────────────────
// Ever-opened discovery uses the variant-independent mint↔PDA trick: in any
// Raydium open instruction, the account X whose derived ["position", X] PDA is
// ALSO among the instruction's accounts is the NFT mint, and that PDA is the
// position — no per-variant account-index knowledge needed (the position index
// varies by instruction, same lesson as Orca). Returns pda → nftMint (the mint
// is needed to match event logs, which carry position_nft_mint).
function discoverRaydiumPositions(txs: SolTx[]): Map<string, string> {
  const posMintByPda = new Map<string, string>();
  for (const tx of txs) {
    for (const ins of tx.transaction.message.instructions ?? []) {
      if (ins.programId !== RAYDIUM_PROGRAM || !ins.data) continue;
      if (classifyRaydiumInstruction(ins.data).kind !== 'open') continue;
      const a = ins.accounts ?? [];
      for (const acc of a) {
        try {
          const pda = PublicKey.findProgramAddressSync([Buffer.from('position'), new PublicKey(acc).toBytes()], RAYDIUM_PROGRAM_PK)[0].toBase58();
          if (a.includes(pda)) { posMintByPda.set(pda, acc); break; }
        } catch { /* not a valid pubkey seed — skip */ }
      }
    }
  }
  return posMintByPda;
}

// Per-position Raydium lifecycle events + per-position reward totals.
// Amount extraction, in priority order:
//   1. Anchor EVENT LOG matched by position_nft_mint (exact; a DecreaseLiquidityEvent
//      yields a withdrawal row for principal + a SEPARATE fee_claim row for the
//      bundled fees + reward totals — precision Orca can't offer).
//   2. Vault-direction matching (deposits at open — Raydium emits no
//      IncreaseLiquidityEvent for the open itself — and any log-less tx). A
//      liquidity==0 decrease without a log is a pure fee claim (route's own rule).
function reconstructRaydiumEvents(
  txs: SolTx[],
  poolCtx: Map<string, PoolContext>,
  posMintByPda: Map<string, string>,
): Map<string, { events: SolanaPositionEvent[]; rewardsRaw: [bigint, bigint, bigint] }> {
  const vaultToPool = new Map<string, string>();
  for (const [pid, p] of poolCtx) { vaultToPool.set(p.vaultA, pid); vaultToPool.set(p.vaultB, pid); }
  const byPos = new Map<string, { events: SolanaPositionEvent[]; rewardsRaw: [bigint, bigint, bigint] }>();
  const bucket = (pda: string) => byPos.get(pda) ?? byPos.set(pda, { events: [], rewardsRaw: [0n, 0n, 0n] }).get(pda)!;

  for (const tx of txs) {
    if (!tx?.meta || tx.meta.err) continue;
    const ts = tx.blockTime ?? 0;
    const sig = tx.transaction.signatures?.[0] ?? '';
    const inner = tx.meta.innerInstructions ?? [];
    const instrs = tx.transaction.message.instructions ?? [];
    const evLogs = parseRaydiumEventLogs(tx);

    for (let i = 0; i < instrs.length; i++) {
      const ins = instrs[i];
      if (ins.programId !== RAYDIUM_PROGRAM || !ins.data) continue;
      const { kind, liq } = classifyRaydiumInstruction(ins.data);
      if (!kind || kind === 'close') continue;
      const a = ins.accounts ?? [];
      const pda = a.find((x) => posMintByPda.has(x));
      if (!pda) continue;
      const nftMint = posMintByPda.get(pda)!;
      const pool = a.map((x) => vaultToPool.get(x)).find((x): x is string => !!x);
      if (!pool) continue;
      const ctx = poolCtx.get(pool)!;
      const b = bucket(pda);

      // 1) exact event log (consume each log at most once)
      const ev = evLogs.find((e) => !e.used && e.nftMint === nftMint &&
        ((kind === 'withdrawal' && e.type === 'dec') || (kind === 'deposit' && e.type === 'inc')));
      if (ev) {
        ev.used = true;
        if (ev.type === 'dec') {
          if (ev.a0 > 0n || ev.a1 > 0n) b.events.push({ positionId: pda, kind: 'withdrawal', txHash: sig, timestamp: ts, pool, amountARaw: ev.a0, amountBRaw: ev.a1 });
          if (ev.fee0 > 0n || ev.fee1 > 0n) b.events.push({ positionId: pda, kind: 'fee_claim', txHash: sig, timestamp: ts, pool, amountARaw: ev.fee0, amountBRaw: ev.fee1 });
          b.rewardsRaw = [b.rewardsRaw[0] + ev.rewards[0], b.rewardsRaw[1] + ev.rewards[1], b.rewardsRaw[2] + ev.rewards[2]];
        } else if (ev.a0 > 0n || ev.a1 > 0n) {
          b.events.push({ positionId: pda, kind: 'deposit', txHash: sig, timestamp: ts, pool, amountARaw: ev.a0, amountBRaw: ev.a1 });
        }
        continue;
      }

      // 2) vault-direction fallback
      const grp = inner.find((g) => g.index === i);
      if (!grp) continue;
      let inA = 0n, inB = 0n, outA = 0n, outB = 0n;
      for (const ii of grp.instructions ?? []) {
        const p = ii.parsed;
        if (!p || (p.type !== 'transfer' && p.type !== 'transferChecked')) continue;
        const info = p.info ?? {};
        const amtStr = p.type === 'transferChecked'
          ? (info.tokenAmount as { amount?: string } | undefined)?.amount
          : (info.amount as string | undefined);
        if (!amtStr) continue;
        let amt: bigint; try { amt = BigInt(amtStr); } catch { continue; }
        if (amt <= 0n) continue;
        const src = info.source as string | undefined;
        const dst = info.destination as string | undefined;
        if (dst === ctx.vaultA) inA += amt; else if (dst === ctx.vaultB) inB += amt;
        else if (src === ctx.vaultA) outA += amt; else if (src === ctx.vaultB) outB += amt;
      }
      if (kind === 'open' || kind === 'deposit') {
        if (inA > 0n || inB > 0n) b.events.push({ positionId: pda, kind: 'deposit', txHash: sig, timestamp: ts, pool, amountARaw: inA, amountBRaw: inB });
      } else if (outA > 0n || outB > 0n) {
        // Without the event log, a liquidity>0 decrease bundles fees into the
        // withdrawal amount (documented approximation, same as the activity route).
        const k: SolanaPositionEvent['kind'] = liq === 0n ? 'fee_claim' : 'withdrawal';
        b.events.push({ positionId: pda, kind: k, txHash: sig, timestamp: ts, pool, amountARaw: outA, amountBRaw: outB });
      }
    }
  }
  for (const v of byPos.values()) v.events.sort((x, y) => x.timestamp - y.timestamp);
  return byPos;
}

// Currently-OWNED position PDAs (open positions) for BOTH protocols, derived
// from the SAME live NFT-mint fetch (both token programs — Orca and modern
// Raydium both use Token-2022 NFTs; legacy Raydium uses Tokenkeg). Both Orca and
// Raydium use the seed ["position", nftMint] under their respective programs.
// Subtracted from ever-opened to get CLOSED (burned-NFT) positions — the
// "ever-opened − currently-owned" rule proven in both Phase As (handles
// re-ranging correctly: a position re-ranged today is no longer owned, so it
// correctly counts as closed).
async function fetchOwnedPositionSets(wallet: string, stats: ScanStats): Promise<{ orca: Set<string>; raydium: Set<string> }> {
  const [r1, r2] = await Promise.all([
    alchemyRpc('getTokenAccountsByOwner', [wallet, { programId: TOKEN_PROGRAM }, { encoding: 'jsonParsed' }], stats) as Promise<{ value?: Array<{ account: { data: { parsed: { info: { tokenAmount: { amount: string; decimals: number }; mint: string } } } } }> } | null>,
    alchemyRpc('getTokenAccountsByOwner', [wallet, { programId: TOKEN_PROGRAM_2022 }, { encoding: 'jsonParsed' }], stats) as Promise<{ value?: Array<{ account: { data: { parsed: { info: { tokenAmount: { amount: string; decimals: number }; mint: string } } } } }> } | null>,
  ]);
  const mints = [...(r1?.value ?? []), ...(r2?.value ?? [])]
    .filter((t) => t.account.data.parsed.info.tokenAmount.amount === '1' && t.account.data.parsed.info.tokenAmount.decimals === 0)
    .map((t) => t.account.data.parsed.info.mint);
  const orca = new Set<string>();
  const raydium = new Set<string>();
  for (const m of mints) {
    try {
      const mintBytes = new PublicKey(m).toBytes();
      orca.add(PublicKey.findProgramAddressSync([Buffer.from('position'), mintBytes], WHIRLPOOL_PROGRAM_PK)[0].toBase58());
      raydium.add(PublicKey.findProgramAddressSync([Buffer.from('position'), mintBytes], RAYDIUM_PROGRAM_PK)[0].toBase58());
    } catch { /* skip invalid */ }
  }
  return { orca, raydium };
}

// ── Reconstruction ────────────────────────────────────────────────────────────
export interface SolanaPositionEvent {
  positionId: string;          // Orca position PDA
  kind: 'deposit' | 'withdrawal' | 'fee_claim';
  txHash: string;
  timestamp: number;
  pool: string;
  amountARaw: bigint;          // raw, pool side A (from mintA vault direction)
  amountBRaw: bigint;          // raw, pool side B
}

// Group every wallet-history Orca instruction into per-position lifecycle events.
// Uses the deterministic VAULT-MATCHING extraction proven in Phase A: for each
// top-level Orca instruction, its inner SPL-token transfers are matched against
// the pool's on-chain vault addresses (source==vault → tokens leaving the pool
// = withdrawal/fee; dest==vault → tokens entering = deposit). This is variant-
// independent (v1/v2) and captures WSOL temp-account legs correctly (the vault
// is deterministic, unlike the wallet's temporary WSOL account). The position
// PDA is identified by matching the instruction's accounts against the discovered
// `everOpened` set — NOT a fixed index: verified on-chain, collect_fees has the
// position at account index 2 (authority at 1) while increase/decrease_liquidity
// have an extra positionAuthority so the position sits at index 3. A fixed a[2]
// grabbed the WALLET (authority) for deposits/withdrawals, collapsing every
// position into one bucket — matching against everOpened is variant-proof.
function reconstructEvents(txs: SolTx[], poolCtx: Map<string, PoolContext>, everOpened: Set<string>): Map<string, SolanaPositionEvent[]> {
  const byPos = new Map<string, SolanaPositionEvent[]>();
  for (const tx of txs) {
    if (!tx?.meta || tx.meta.err) continue;
    const ts = tx.blockTime ?? 0;
    const sig = tx.transaction.signatures?.[0] ?? '';
    const inner = tx.meta.innerInstructions ?? [];
    const instrs = tx.transaction.message.instructions ?? [];
    for (let i = 0; i < instrs.length; i++) {
      const ins = instrs[i];
      if (ins.programId !== WHIRLPOOL_PROGRAM || !ins.data) continue;
      const kind = classifyInstruction(ins.data);
      // open / close / reward produce no lifecycle event here (rewards excluded
      // per Rule 4, like the Sui engine). Everything else — including UNCLASSIFIED
      // (null) instructions — is resolved below by vault-transfer direction, so
      // liquidity-add variants whose discriminator differs from the standard
      // Anchor hash (e.g. Orca's token-extension deposit effb097cd2c6352b, which
      // is NOT sha256("global:increase_liquidity_v2")) are captured WITHOUT
      // hardcoding an opaque discriminator.
      if (kind === 'open' || kind === 'close' || kind === 'reward') continue;
      const a = ins.accounts ?? [];
      const pool = a[0];
      const positionId = a.find((acc) => everOpened.has(acc));
      if (!positionId || !pool) continue;   // swaps etc. reference no position → skipped
      const ctx = poolCtx.get(pool);
      if (!ctx) continue;
      const grp = inner.find((g) => g.index === i);
      if (!grp) continue;
      // Sum inner SPL-transfer amounts vault-IN (dest==vault, a deposit leg) and
      // vault-OUT (source==vault, a withdrawal/fee leg) per pool side. Matching
      // the on-chain VAULT (not the wallet's account) captures WSOL temp-account
      // legs correctly and is instruction-variant-independent.
      let inA = 0n, inB = 0n, outA = 0n, outB = 0n;
      for (const ii of grp.instructions ?? []) {
        const p = ii.parsed;
        if (!p || (p.type !== 'transfer' && p.type !== 'transferChecked')) continue;
        const info = p.info ?? {};
        const source = info.source as string | undefined;
        const dest = info.destination as string | undefined;
        const amtStr = (p.type === 'transferChecked'
          ? (info.tokenAmount as { amount?: string } | undefined)?.amount
          : (info.amount as string | undefined));
        if (!amtStr) continue;
        let amt: bigint;
        try { amt = BigInt(amtStr); } catch { continue; }
        if (amt <= 0n) continue;
        if (dest === ctx.vaultA) inA += amt;
        else if (dest === ctx.vaultB) inB += amt;
        else if (source === ctx.vaultA) outA += amt;
        else if (source === ctx.vaultB) outB += amt;
      }
      const hasIn = inA > 0n || inB > 0n;
      const hasOut = outA > 0n || outB > 0n;
      // Resolve the effective kind + amounts. Classified deposit/withdrawal/fee
      // use their known direction; an unclassified instruction is inferred from
      // direction ONLY when it's unambiguous (all-in → deposit, all-out →
      // withdrawal). A mixed in+out (swap-like) unclassified instr is skipped.
      let evKind: SolanaPositionEvent['kind'] | null = null;
      let rawA = 0n, rawB = 0n;
      if (kind === 'deposit') { evKind = 'deposit'; rawA = inA; rawB = inB; }
      else if (kind === 'withdrawal') { evKind = 'withdrawal'; rawA = outA; rawB = outB; }
      else if (kind === 'fee') { evKind = 'fee_claim'; rawA = outA; rawB = outB; }
      else if (hasIn && !hasOut) { evKind = 'deposit'; rawA = inA; rawB = inB; }
      else if (hasOut && !hasIn) { evKind = 'withdrawal'; rawA = outA; rawB = outB; }
      if (!evKind || (rawA === 0n && rawB === 0n)) continue;
      const list = byPos.get(positionId) ?? byPos.set(positionId, []).get(positionId)!;
      list.push({ positionId, kind: evKind, txHash: sig, timestamp: ts, pool, amountARaw: rawA, amountBRaw: rawB });
    }
  }
  for (const list of byPos.values()) list.sort((x, y) => x.timestamp - y.timestamp);
  return byPos;
}

export interface SolanaClosedPosition {
  positionId: string;
  protocol: SolanaClmmProtocol;
  chain: 'Solana';
  pair: string;
  pool: string;
  mintA: string;
  mintB: string;
  openedTs: number;
  closedTs: number;
  depositUSD: number;
  withdrawalUSD: number;
  feesUSD: number;
  capitalGL: number;           // withdrawalUSD − depositUSD (Rule 4; NO fees)
  pendingEventCount: number;
  events: ActivityEventForPnL[];
  sourceBreakdown: Record<string, number>;
  // Sprint RAYDIUM: lifetime reward-emission totals per Raydium reward slot
  // (raw u64 sums from DecreaseLiquidityEvent.reward_amounts, stringified —
  // reward MINTS live in PoolState.reward_infos and are not resolved here).
  // Excluded from Capital G/L (Rule 4) and from feesUSD; carried so
  // POSITION-DETAIL-2 / a future reward-valuation sprint can read them without
  // re-scanning. Absent for Orca positions (rewards separate instrs there).
  rewardAmountsRaw?: [string, string, string];
}

function isStableMint(mint: string): boolean { return STABLE_MINTS.has(mint.toLowerCase()); }

// ── Valuation (historical-only; NEVER spot — Rule 1a) ─────────────────────────
// Resolve a non-stable mint's cgId once (for the CoinGecko-historical fallback
// tier). Cached across the wallet's positions. resolveToken is the canonical
// value-by-on-chain-mint path (invariant i) — never a hardcoded map.
const cgIdCache = new Map<string, string | null>();
async function resolveCgId(mint: string): Promise<string | null> {
  if (cgIdCache.has(mint)) return cgIdCache.get(mint)!;
  let cgId: string | null = null;
  try { const t = await resolveToken({ chain: 'solana', mint }); cgId = t.cgId ?? null; }
  catch { cgId = null; }
  cgIdCache.set(mint, cgId);
  return cgId;
}

// Per-side historical price: stable → $1; else DeFiLlama-by-mint → CG-historical
// by cgId → null (pending). Cache-only reads — caller MUST prewarm first.
function histSidePrice(mint: string, ts: number): { px: number; src: string } | null {
  if (isStableMint(mint)) return { px: 1, src: 'stablecoin-fixed' };
  const dl = getCachedOnlyDefillamaPrice('solana', mint, ts);
  if (dl != null) return { px: dl, src: 'defillama-historical' };
  const cgId = cgIdCache.get(mint);
  if (cgId) {
    const cg = getCachedOnlyTokenPrice(cgId, ts);
    if (cg != null) return { px: cg, src: 'cg-historical' };
  }
  return null; // → pending (never spot)
}

interface EventValue { usd: number | null; p0: number | null; p1: number | null; source: string }
function valueEvent(ev: SolanaPositionEvent, ctx: PoolContext): EventValue {
  const amtA = Number(ev.amountARaw) / 10 ** ctx.decimalsA;
  const amtB = Number(ev.amountBRaw) / 10 ** ctx.decimalsB;
  if (amtA === 0 && amtB === 0) return { usd: 0, p0: 0, p1: 0, source: 'zero_amount' };
  const a = histSidePrice(ctx.mintA, ev.timestamp);
  const b = histSidePrice(ctx.mintB, ev.timestamp);
  if (a && b) {
    const src = a.src === b.src ? a.src : `${a.src}+${b.src}`;
    return { usd: amtA * a.px + amtB * b.px, p0: a.px, p1: b.px, source: src };
  }
  return { usd: null, p0: a?.px ?? null, p1: b?.px ?? null, source: 'pending' };
}

async function valueClosedPosition(
  positionId: string,
  events: SolanaPositionEvent[],
  ctx: PoolContext,
  protocol: SolanaClmmProtocol,
  rewardAmountsRaw?: [string, string, string],
): Promise<SolanaClosedPosition> {
  // Prewarm historical caches for every non-stable side at every event ts.
  const dlByMint = new Map<string, Set<number>>();
  const cgByMint = new Map<string, Set<number>>();
  for (const ev of events) {
    for (const mint of [ctx.mintA, ctx.mintB]) {
      if (isStableMint(mint)) continue;
      const dl = dlByMint.get(mint) ?? dlByMint.set(mint, new Set()).get(mint)!;
      dl.add(ev.timestamp);
    }
  }
  // Resolve cgIds (for the CG-historical fallback) and build the CG prewarm set.
  await Promise.all([...dlByMint.keys()].map((m) => resolveCgId(m)));
  for (const [mint, tsSet] of dlByMint) { const cgId = cgIdCache.get(mint); if (cgId) cgByMint.set(cgId, tsSet); }

  await Promise.all([
    dlByMint.size > 0
      ? prewarmDefillamaPrices([...dlByMint].map(([contract, ts]) => ({ chain: 'solana' as const, contract, timestamps: [...ts] })))
      : Promise.resolve(),
    cgByMint.size > 0
      ? prewarmTokenPrices([...cgByMint].map(([coingeckoId, ts]) => ({ coingeckoId, timestamps: [...ts] })))
      : Promise.resolve(),
  ]);

  const outEvents: ActivityEventForPnL[] = [];
  const sourceBreakdown: Record<string, number> = {};
  let depositUSD = 0, withdrawalUSD = 0, feesUSD = 0, pendingEventCount = 0;
  for (const ev of events) {
    const amount0 = Number(ev.amountARaw) / 10 ** ctx.decimalsA;
    const amount1 = Number(ev.amountBRaw) / 10 ** ctx.decimalsB;
    const v = valueEvent(ev, ctx);
    sourceBreakdown[v.source] = (sourceBreakdown[v.source] ?? 0) + 1;
    if (v.usd == null) pendingEventCount += 1;
    else if (ev.kind === 'deposit') depositUSD += v.usd;
    else if (ev.kind === 'withdrawal') withdrawalUSD += v.usd;
    else feesUSD += v.usd;
    outEvents.push({
      type: ev.kind,
      timestamp: ev.timestamp,
      amount0, amount1,
      usdAtTime: v.usd,
      price0AtTime: v.p0,
      price1AtTime: v.p1,
      txHash: ev.txHash,
    });
  }

  const symbolA = ctx.mintA === WSOL_MINT ? 'SOL' : cgIdCache.get(ctx.mintA) ? shortSym(ctx.mintA) : shortSym(ctx.mintA);
  const symbolB = ctx.mintB === WSOL_MINT ? 'SOL' : shortSym(ctx.mintB);
  const pair = `${symbolA} / ${symbolB}`;
  const capitalGL = withdrawalUSD - depositUSD; // Rule 4 — NO fees

  logPrice({
    event: 'solana_closed_position_valued',
    protocol,
    positionId,
    pair,
    depositUSD, withdrawalUSD, feesUSD, capitalGL, pendingEventCount, sourceBreakdown,
  });

  return {
    positionId, protocol, chain: 'Solana', pair, pool: events[0]?.pool ?? '',
    mintA: ctx.mintA, mintB: ctx.mintB,
    openedTs: events[0]?.timestamp ?? 0, closedTs: events[events.length - 1]?.timestamp ?? 0,
    depositUSD, withdrawalUSD, feesUSD, capitalGL, pendingEventCount,
    events: outEvents, sourceBreakdown,
    ...(rewardAmountsRaw ? { rewardAmountsRaw } : {}),
  };
}

// Human symbol for a mint: stables/SOL are labelled; others fall back to a short
// mint prefix. Symbols are display-only (pricing is by mint), so a prefix is safe.
function shortSym(mint: string): string {
  if (mint === WSOL_MINT) return 'SOL';
  if (mint.toLowerCase() === 'epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v') return 'USDC';
  if (mint.toLowerCase() === 'es9vmfrzacermjfrf4h2fyd4kconky11mcce8benwnyb') return 'USDT';
  if (mint === 'A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS') return 'ZEC';
  return mint.slice(0, 4);
}

// ── Orchestrator: all CLOSED positions (Orca + Raydium) for a wallet ──────────
// ONE paced wallet-history scan serves BOTH protocols (the scan is per-WALLET;
// parsing a second program from the same transactions costs zero extra RPC —
// Sprint RAYDIUM B7 gate E). Fetches signatures + txs + owned sets ONCE,
// reconstructs and values every closed position per protocol. This is what the
// Redis-cached entry point wraps.
export interface WalletClosedPositions { orca: SolanaClosedPosition[]; raydium: SolanaClosedPosition[]; stats: ScanStats }

export async function getClosedPositionsForWallet(wallet: string): Promise<WalletClosedPositions> {
  const stats: ScanStats = { signatures: 0, validSignatures: 0, txFetched: 0, throttleEvents: 0, wallMs: 0, billedCalls: 0, complete: false };
  const t0 = Date.now();
  if (!ALCHEMY_RPC) { stats.wallMs = 0; return { orca: [], raydium: [], stats }; }

  const [validSigs, owned] = await Promise.all([
    fetchAllSignatures(wallet, stats),
    fetchOwnedPositionSets(wallet, stats),
  ]);
  if (validSigs.length === 0) { stats.wallMs = Date.now() - t0; return { orca: [], raydium: [], stats }; }

  const txMap = await fetchTransactions(validSigs, stats);
  const txs = [...txMap.values()].filter((t): t is SolTx => !!t);

  // ── ORCA (unchanged Sprint 3-FREE logic) ────────────────────────────────────
  // Ever-opened PDAs (open_position acct[2]); pools referenced; decimals hints.
  const everOpened = new Set<string>();
  const pools = new Set<string>();
  const decHint = new Map<string, number>();
  for (const tx of txs) {
    if (!tx.meta) continue;
    for (const b of [...(tx.meta.preTokenBalances ?? []), ...(tx.meta.postTokenBalances ?? [])]) {
      if (!decHint.has(b.mint)) decHint.set(b.mint, b.uiTokenAmount.decimals);
    }
    for (const ins of tx.transaction.message.instructions ?? []) {
      if (ins.programId !== WHIRLPOOL_PROGRAM || !ins.data) continue;
      const kind = classifyInstruction(ins.data);
      const a = ins.accounts ?? [];
      if (kind === 'open' && a[2]) everOpened.add(a[2]);
      if ((kind === 'deposit' || kind === 'withdrawal' || kind === 'fee') && a[0]) pools.add(a[0]);
    }
  }

  const poolCtx = await fetchPoolContexts([...pools], decHint, stats);
  const grouped = reconstructEvents(txs, poolCtx, everOpened);

  const orca: SolanaClosedPosition[] = [];
  for (const [pid, events] of grouped) {
    if (owned.orca.has(pid)) continue;                       // still open — not closed
    if (!events.some((e) => e.kind === 'deposit')) continue; // nothing to reconstruct
    const ctx = poolCtx.get(events.find((e) => e.pool)?.pool ?? '');
    if (!ctx) continue;
    orca.push(await valueClosedPosition(pid, events, ctx, 'orca'));
  }

  // ── RAYDIUM (Sprint RAYDIUM; same txs, zero extra scan) ─────────────────────
  const raydium: SolanaClosedPosition[] = [];
  const posMintByPda = discoverRaydiumPositions(txs);
  if (posMintByPda.size > 0) {
    // Pool candidates: every account referenced by a Raydium position instr
    // (the PoolState-disc filter in fetchRaydiumPoolContexts finds the pools).
    const rayCand = new Set<string>();
    for (const tx of txs) {
      for (const ins of tx.transaction.message.instructions ?? []) {
        if (ins.programId !== RAYDIUM_PROGRAM || !ins.data) continue;
        if (!classifyRaydiumInstruction(ins.data).kind) continue;
        for (const acc of ins.accounts ?? []) rayCand.add(acc);
      }
    }
    const rayPoolCtx = await fetchRaydiumPoolContexts([...rayCand], stats);
    const rayGrouped = reconstructRaydiumEvents(txs, rayPoolCtx, posMintByPda);
    for (const [pid, { events, rewardsRaw }] of rayGrouped) {
      if (owned.raydium.has(pid)) continue;
      if (!events.some((e) => e.kind === 'deposit')) continue;
      const ctx = rayPoolCtx.get(events.find((e) => e.pool)?.pool ?? '');
      if (!ctx) continue;
      const rewards: [string, string, string] = [rewardsRaw[0].toString(), rewardsRaw[1].toString(), rewardsRaw[2].toString()];
      raydium.push(await valueClosedPosition(pid, events, ctx, 'raydium', rewards));
    }
  }

  stats.wallMs = Date.now() - t0;
  return { orca, raydium, stats };
}

// ── Redis cache (Sprint 1.14 / 2.2b immutable-closed-position pattern) ─────────
// A closed position's lifecycle is IMMUTABLE (NFT burned; instructions on a
// finalized ledger). First successful reconstruction for a wallet is persisted
// and served thereafter — any instance, any user — without re-scanning (~25k CU
// once, then ~0). Same contract as suiClosedPositions: own client, PRICE_CACHE_KV_*,
// no-op stub if unset, NEVER throws, fire-and-forget writes. Empty results are
// cached ONLY after a provably-complete scan (see writeClosedPosCache).
const CLOSED_POS_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const CLOSED_POS_CACHE_VERSION = 'closed_pos_solana_v1'; // bump to invalidate on valuation-logic change

const _redisUrl = process.env.PRICE_CACHE_KV_REST_API_URL;
const _redisToken = process.env.PRICE_CACHE_KV_REST_API_TOKEN;
let _redis: Redis | null = null;
if (_redisUrl && _redisToken) {
  try { _redis = new Redis({ url: _redisUrl, token: _redisToken }); }
  catch (err) { console.warn('[solanaClosedPositions] Redis client construction failed; no-op stub:', err); _redis = null; }
}
// Per-protocol sub-keys: `closed_pos_solana_v1:orca:{wallet}` (pre-existing —
// Sprint 3-FREE entries stay byte-compatible) and `closed_pos_solana_v1:raydium:{wallet}`.
const CLOSED_POS_EMPTY_TTL_SECONDS = 24 * 60 * 60; // empty-with-complete-scan self-heals daily
function closedPosKey(protocol: SolanaClmmProtocol, wallet: string): string {
  return `${CLOSED_POS_CACHE_VERSION}:${protocol}:${wallet.toLowerCase()}`;
}

async function readClosedPosCache(protocol: SolanaClmmProtocol, wallet: string): Promise<SolanaClosedPosition[] | null> {
  if (!_redis) return null;
  try {
    const raw = await _redis.get<SolanaClosedPosition[] | string | null>(closedPosKey(protocol, wallet));
    if (raw == null) return null;
    const arr = typeof raw === 'string' ? (JSON.parse(raw) as SolanaClosedPosition[]) : raw;
    // An EMPTY array is a VALID cached value (written only after a provably
    // COMPLETE scan — see writeClosedPosCache). Distinguishes "scanned, none
    // found" from null = "never scanned".
    if (Array.isArray(arr) && arr.every((p) => p && typeof p.capitalGL === 'number' && Array.isArray(p.events))) return arr;
    return null;
  } catch { return null; }
}
// Sprint RAYDIUM refinement to the Sprint 1.14 empty-never-cached rule: an empty
// result IS cached — but ONLY when the scan was 100% complete (stats.complete),
// and with a short 24h TTL. The rule's purpose is that a TRANSIENT failure must
// never freeze in as "no closed positions" — a provably-complete scan yielding
// empty is not a transient failure, and without this a wallet legitimately empty
// on one protocol (the common case: most wallets use one AMM) would re-pay the
// full 40–120s scan on EVERY load. Partial/failed scans still never cache.
function writeClosedPosCache(protocol: SolanaClmmProtocol, wallet: string, positions: SolanaClosedPosition[], scanComplete: boolean): void {
  if (!_redis || !Array.isArray(positions)) return;
  if (positions.length === 0 && !scanComplete) return; // transient-failure empties never cached
  const ttl = positions.length === 0 ? CLOSED_POS_EMPTY_TTL_SECONDS : CLOSED_POS_TTL_SECONDS;
  _redis.set(closedPosKey(protocol, wallet), JSON.stringify(positions), { ex: ttl })
    .catch((err) => console.warn('[solanaClosedPositions] Redis write failed (ignored):', err));
}

// Redis-cached top-level entry point (mirrors sui getCachedClosedPositionCapitalGL,
// but returns BOTH protocols' closed positions from at most ONE scan). Read both
// sub-keys first; if either misses, run the single shared scan once, write both,
// and return the fresh result (fresh is a superset of cached — it also captures
// positions closed since the cache was written).
// Sprint LPPNL-PERF (Part B2): module-level in-flight dedup keyed by wallet. The
// route is fetched concurrently by useLpPnl + useWalletLevelFees; even with the
// route-level withActivityRouteCache dedup, this guarantees that within a warm
// instance the expensive scan runs ONCE per wallet no matter how many callers
// (or effect re-runs) arrive while it's in flight. Deleted on settle so a later
// load re-reads cache / re-scans normally.
const _inFlightScans = new Map<string, Promise<SolanaClosedPosition[]>>();
export function getCachedClosedPositionCapitalGL(wallet: string): Promise<SolanaClosedPosition[]> {
  if (!wallet) return Promise.resolve([]);
  const key = wallet.toLowerCase();
  const existing = _inFlightScans.get(key);
  if (existing) return existing;
  const p = (async (): Promise<SolanaClosedPosition[]> => {
    const [cachedOrca, cachedRay] = await Promise.all([
      readClosedPosCache('orca', wallet),
      readClosedPosCache('raydium', wallet),
    ]);
    if (cachedOrca !== null && cachedRay !== null) return [...cachedOrca, ...cachedRay];
    const { orca, raydium, stats } = await getClosedPositionsForWallet(wallet);
    writeClosedPosCache('orca', wallet, orca, stats.complete);
    writeClosedPosCache('raydium', wallet, raydium, stats.complete);
    return [...orca, ...raydium];
  })();
  _inFlightScans.set(key, p);
  return p.finally(() => { _inFlightScans.delete(key); });
}
