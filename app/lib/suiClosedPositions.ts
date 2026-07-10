// Sui closed-position retrieval + Capital G/L reconstruction (Sprint 2.2b).
//
// WHY THIS EXISTS
// When a Sui CLMM position (Cetus / Bluefin) is fully closed, the on-chain
// Position object is DESTROYED (Move semantics) — unlike an EVM position NFT,
// which persists in the wallet forever. So `suix_getOwnedObjects` cannot return
// a closed Sui position, and the EVM closed-position path (which reads the still-
// existing NFT) has nothing to read. The ONLY retrieval path is to scan the
// wallet's transaction history for the position's lifecycle events and
// reconstruct deposits / withdrawals / fee claims from the event payloads. The
// pool object is a SHARED object that is NEVER destroyed, so coin types and
// decimals remain resolvable after the position is gone. (Sprint 2.2 Phase A.)
//
// HOW IT PLUGS INTO Capital G/L
// This module reconstructs each closed position as an ActivityEventForPnL[] with
// each event's `usdAtTime` resolved by the historical valuation cascade below,
// then reuses the SAME pure engine the EVM path uses — computePositionPnL() in
// app/lib/positionPnl.ts — so Capital G/L is, byte-for-byte, the same formula:
//   capitalGL = closingValue (Σ withdrawals) − initialValue (Σ deposits)
// Fees are NOT folded into Capital G/L (pricing-invariants Rule 4); they flow
// into feesCollected separately, exactly like EVM (useLpPnl aggregate()).
//
// VALUATION CASCADE (per side of every event; pricing-invariants Rule 1a/Rule 2)
//   1. Stablecoin side                → $1 (tokenConstants).
//   2. Non-stable side, deposit/withdrawal PRIMARY → USD derived from the
//      EVENT-EMBEDDED `current_sqrt_price` (the pool price AT THAT BLOCK — it is
//      historical-by-construction, NOT a current/spot query, so it does NOT
//      violate Rule 1a; this is the Sui analogue of EVM's archival sqrtPriceX96)
//      paired with the stablecoin side ($1) — or, in a both-non-stable pool,
//      the paired token's historical price.
//   3. Non-stable side, fallback (sqrtPrice missing/ambiguous, OR a fee claim,
//      which carries no sqrtPrice) → DeFiLlama historical at the event timestamp
//      (Sprint 1.12) → CoinGecko historical at the event timestamp (Sprint 1.6).
//   4. If every source fails → the event stays PENDING (usdAtTime null); it is
//      surfaced to the user, never spot-valued (Rule 1a).
// There is NO current-spot / cg-spot fallback anywhere in this module.

import { Redis } from '@upstash/redis';
import type { ActivityEventForPnL } from './positionPnl';
import { lookupHardcodedToken, normalizeSuiType } from './tokenConstants';
import { prewarmSuiPricesForTimestamps, getHistoricalOnlySuiPrice } from './suiPriceHistory';
import { prewarmDefillamaPrices, getCachedOnlyDefillamaPrice } from './defillamaPriceHistory';
import { logPrice } from './priceLogger';
import { suiRpc } from './suiRpc';

const SUI_CANONICAL = '0x2::sui::sui';
// Stablecoin cgIds → $1 anchor (pricing-invariants Rule 3, via Sprint 1.10 constants).
const STABLE_CGIDS = new Set(['usd-coin', 'tether', 'dai']);

// ── Scope (Sprint 2.2b: Cetus + Bluefin; Sprint MOMENTUM adds Momentum) ────────
export type SuiClmmProtocol = 'cetus' | 'bluefin' | 'momentum';

// ── Package allowlists (verified on-chain, Sprint 2.2 Phase A + Sprint MOMENTUM)
// Filtering is by PACKAGE PREFIX, never name-only: Momentum emits an identically-
// named AddLiquidityEvent / RemoveLiquidityEvent (Cetus has AddLiquidityEvent
// too), so a name-only filter would cross-capture across protocols. These mirror
// the allowlists in app/api/{cetus,bluefin,momentum}/activity/route.ts.
const CETUS_PKGS = [
  '0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb', // fees + lifecycle (CollectFeeEvent, Open/ClosePositionEvent)
  '0xdb5cd62a06c79695bfc9982eb08534706d3752fe123b48e0144f480209b3117f', // V2 deposits/withdrawals (Add/RemoveLiquidityV2Event)
  '0xdc67d6de3f00051c505da10d8f6fbab3b3ec21ec65f0dc22a2f36c13fc102110', // V2 rewards (CollectRewardV2Event)
] as const;
const BLUEFIN_PKG = '0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267';
// Sprint MOMENTUM — single package; emits AddLiquidityEvent / RemoveLiquidityEvent
// / FeeCollectedEvent / OpenPositionEvent / ClosePositionEvent (no current_sqrt_price
// on liquidity events — closed-position valuation rides the historical-sides fallback).
const MOMENTUM_PKG = '0x70285592c97965e811e0c6f98dccc3a9c2b4ad854b3594faab9597ada267b860';

// Sui object types for currently-owned (open) position discovery — used by
// retrieveClosedPositions to subtract still-owned positions from ever-opened.
const POSITION_TYPE: Record<SuiClmmProtocol, string> = {
  cetus: `${CETUS_PKGS[0]}::position::Position`,
  bluefin: `${BLUEFIN_PKG}::position::Position`,
  momentum: `${MOMENTUM_PKG}::position::Position`,
};

// The on-chain field that holds the position object id, per protocol.
const POSITION_ID_FIELD: Record<SuiClmmProtocol, string> = {
  cetus: 'position',        // Cetus events carry `position`
  bluefin: 'position_id',   // Bluefin events carry `position_id`
  momentum: 'position_id',  // Momentum events carry `position_id`
};

function eventPackageMatches(protocol: SuiClmmProtocol, eventType: string): boolean {
  if (protocol === 'cetus') return CETUS_PKGS.some((p) => eventType.startsWith(p));
  if (protocol === 'momentum') return eventType.startsWith(MOMENTUM_PKG);
  return eventType.startsWith(BLUEFIN_PKG);
}

function bigintOrNull(v: unknown): bigint | null {
  if (v == null) return null;
  try { return BigInt(v as string); } catch { return null; }
}

// One normalized lifecycle event for a closed Sui position, after protocol-
// specific parsing (Cetus `amount_a`/`amount_b`, Bluefin `coin_a_amount`/
// `coin_b_amount`, etc. all collapse to amountARaw/amountBRaw here).
export interface SuiPositionEvent {
  positionId: string;
  protocol: SuiClmmProtocol;
  kind: 'deposit' | 'withdrawal' | 'fee_claim';
  txDigest: string;
  timestamp: number;        // unix seconds
  poolId: string;
  amountARaw: bigint;       // raw on-chain integer, pool side A
  amountBRaw: bigint;       // raw on-chain integer, pool side B
  // Pool sqrt price captured IN the event payload (Q64.64). Present on
  // deposit/withdrawal; null on fee claims (which carry no price) — those fall to
  // historical pricing. Historical-by-construction (block price), never spot.
  sqrtPriceX64: bigint | null;
}

// The full reconstructed lifecycle of one closed position: pool/coin context
// (resolved from the persistent pool object) + every event in chronological order.
export interface SuiPositionLifecycle {
  positionId: string;
  protocol: SuiClmmProtocol;
  poolId: string;
  coinTypeA: string;
  coinTypeB: string;
  decimalsA: number;
  decimalsB: number;
  openedTs: number;
  closedTs: number;
  events: SuiPositionEvent[];   // chronological (oldest first)
}

// A valued closed position, ready to fold into Capital G/L. Carries both the
// summary figures (for the B7 cross-check export, the Redis cache payload, and
// the future Sprint 4 clickable breakdown) AND the ActivityEventForPnL[] so
// useLpPnl can run computePositionPnL() for exact EVM parity.
export interface SuiClosedPosition {
  positionId: string;
  protocol: SuiClmmProtocol;
  chain: 'Sui';
  pair: string;                 // e.g. "SUI / USDC"
  poolId: string;
  coinTypeA: string;
  coinTypeB: string;
  openedTs: number;
  closedTs: number;
  depositUSD: number;           // Σ deposit events, historical
  withdrawalUSD: number;        // Σ withdrawal events, historical
  feesUSD: number;              // Σ fee-claim events, historical (separate from Cap G/L)
  capitalGL: number;            // withdrawalUSD − depositUSD (Rule 4; NO fees)
  pendingEventCount: number;    // events left unpriced (Rule 1a pending, never spot)
  // Per-event records in the EVM engine's shape, so useLpPnl can call
  // computePositionPnL({ isClosed:true, events }) and get identical semantics.
  events: ActivityEventForPnL[];
  // Per-event valuation source breakdown for verification ([PRICE_LOG] / B7
  // export). Keys are cascade tiers: stablecoin-fixed | sqrtprice-historical |
  // defillama-historical | cg-historical | pending. NEVER cg-spot.
  sourceBreakdown: Record<string, number>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Function signatures (skeleton — bodies land in B2/B3/B4). Each throws until
// implemented so the module type-checks while the phases are built out.
// ─────────────────────────────────────────────────────────────────────────────

// ── Internal Sui JSON-RPC + tx-history loading ────────────────────────────────
// Sprint SUI-RPC-RELIABILITY: routed through the shared paced+failover client
// (was a bare fetch with no timeout/fallback).

// Currently-owned (open) position object IDs — the set we subtract from the
// ever-opened set to find CLOSED (destroyed-object) positions.
async function fetchOwnedPositionIds(account: string, protocol: SuiClmmProtocol): Promise<Set<string>> {
  const ids = new Set<string>();
  let cursor: string | null = null;
  do {
    const result = (await suiRpc('suix_getOwnedObjects', [
      account,
      { filter: { StructType: POSITION_TYPE[protocol] }, options: { showType: false, showContent: false } },
      cursor,
      50,
    ])) as { data?: Array<{ data?: { objectId?: string } }>; nextCursor?: string; hasNextPage?: boolean } | null;
    if (!result?.data) break;
    for (const item of result.data) { const id = item?.data?.objectId; if (id) ids.add(id); }
    cursor = result.hasNextPage ? (result.nextCursor ?? null) : null;
  } while (cursor);
  return ids;
}

interface SuiTxBlock {
  digest: string;
  timestampMs: string;
  events?: Array<{ type: string; parsedJson: Record<string, unknown> }>;
}

// Fetch every transaction the wallet signed, with events — the SAME pagination
// the cetus/bluefin activity routes already run (FromAddress, 50/page, then
// multiGet 25/batch with showEvents). Returns all blocks.
async function fetchWalletBlocks(account: string): Promise<SuiTxBlock[]> {
  const digests: string[] = [];
  let cursor: string | null = null;
  do {
    const result = (await suiRpc('suix_queryTransactionBlocks', [
      { filter: { FromAddress: account } }, cursor, 50, true,
    ])) as { data?: Array<{ digest: string }>; nextCursor?: string; hasNextPage?: boolean } | null;
    if (!result?.data) break;
    digests.push(...result.data.map((t) => t.digest));
    cursor = result.hasNextPage ? (result.nextCursor ?? null) : null;
  } while (cursor);

  const blocks: SuiTxBlock[] = [];
  for (let i = 0; i < digests.length; i += 25) {
    const batch = (await suiRpc('sui_multiGetTransactionBlocks', [
      digests.slice(i, i + 25),
      { showEvents: true, showInput: false, showEffects: false, showObjectChanges: false, showBalanceChanges: false },
    ])) as SuiTxBlock[] | null;
    if (batch) blocks.push(...batch);
  }
  return blocks;
}

// Parse + group every lifecycle event in the wallet's history by position id.
function groupEventsByPosition(
  protocol: SuiClmmProtocol,
  blocks: SuiTxBlock[],
): Map<string, SuiPositionEvent[]> {
  const grouped = new Map<string, SuiPositionEvent[]>();
  for (const tx of blocks) {
    const ts = tx.timestampMs ? Math.floor(parseInt(tx.timestampMs, 10) / 1000) : 0;
    for (const ev of tx.events ?? []) {
      const parsed = parseCloseEvent(protocol, tx.digest, ts, ev);
      if (!parsed) continue;
      const list = grouped.get(parsed.positionId) ?? grouped.set(parsed.positionId, []).get(parsed.positionId)!;
      list.push(parsed);
    }
  }
  for (const list of grouped.values()) list.sort((a, b) => a.timestamp - b.timestamp);
  return grouped;
}

// ── Pool context (coin types + decimals) — resolved from the persistent pool ──
// The pool is a SHARED object that survives the position's destruction, so its
// `Pool<A, B>` type params + coin metadata are always available. Cached per pool.
const poolContextCache = new Map<string, { coinTypeA: string; coinTypeB: string; decimalsA: number; decimalsB: number } | null>();

async function resolveDecimals(coinType: string): Promise<number> {
  const tok = lookupHardcodedToken('sui', normalizeSuiType(coinType));
  if (tok) return tok.decimals;
  try {
    const meta = (await suiRpc('suix_getCoinMetadata', [coinType])) as { decimals?: number } | null;
    if (meta && typeof meta.decimals === 'number') return meta.decimals;
  } catch { /* ignore */ }
  return 9; // Sui default
}

async function resolvePoolContext(poolId: string) {
  if (poolContextCache.has(poolId)) return poolContextCache.get(poolId)!;
  const obj = (await suiRpc('sui_getObject', [poolId, { showType: true }])) as { data?: { type?: string } } | null;
  const typ = obj?.data?.type ?? '';
  const m = typ.match(/<([^,]+),\s*([^,>]+)/); // Pool<A, B[, ...]>
  if (!m) { poolContextCache.set(poolId, null); return null; }
  const coinTypeA = normalizeSuiType(m[1].trim());
  const coinTypeB = normalizeSuiType(m[2].trim());
  const [decimalsA, decimalsB] = await Promise.all([resolveDecimals(coinTypeA), resolveDecimals(coinTypeB)]);
  const ctx = { coinTypeA, coinTypeB, decimalsA, decimalsB };
  poolContextCache.set(poolId, ctx);
  return ctx;
}

function isStable(coinType: string): boolean {
  const tok = lookupHardcodedToken('sui', normalizeSuiType(coinType));
  return !!tok && STABLE_CGIDS.has(tok.cgId);
}

// B3 — Retrieve the object IDs of every CLOSED position of `protocol` for a
// wallet: positions that appear in tx history (have lifecycle events) but are
// NOT in the wallet's current `getOwnedObjects` (object destroyed on close).
export async function retrieveClosedPositions(
  walletAddress: string,
  protocol: SuiClmmProtocol,
): Promise<string[]> {
  const [blocks, owned] = await Promise.all([
    fetchWalletBlocks(walletAddress),
    fetchOwnedPositionIds(walletAddress, protocol),
  ]);
  const grouped = groupEventsByPosition(protocol, blocks);
  const closed: string[] = [];
  for (const [pid, events] of grouped) {
    if (owned.has(pid)) continue;                          // still open — not a closed position
    if (!events.some((e) => e.kind === 'deposit')) continue; // nothing to reconstruct
    closed.push(pid);
  }
  return closed;
}

// B2 — Parse one raw Sui event into a normalized SuiPositionEvent, dispatched by
// protocol. Returns null for events that are not lifecycle-relevant (swaps,
// open/close markers, foreign-package events). `rawEvent` is the Sui RPC
// `{ type, parsedJson }`; `txDigest`/`timestamp` come from the enclosing tx.
export function parseCloseEvent(
  protocol: SuiClmmProtocol,
  txDigest: string,
  timestamp: number,
  rawEvent: { type: string; parsedJson: Record<string, unknown> },
): SuiPositionEvent | null {
  const { type, parsedJson: pj } = rawEvent;
  if (!eventPackageMatches(protocol, type)) return null;
  if (!pj) return null;

  const name = type.split('::').pop() ?? '';
  const positionId = (pj[POSITION_ID_FIELD[protocol]] as string) ?? '';
  const poolId =
    (pj.pool as string) ??       // Cetus
    (pj.pool_id as string) ??    // Bluefin
    '';
  if (!positionId || !poolId) return null;

  // Normalize each protocol's distinct field names onto amountARaw/amountBRaw.
  // sqrtPriceX64 is present on deposit/withdrawal, absent (null) on fee claims.
  let kind: SuiPositionEvent['kind'];
  let aRaw: bigint | null;
  let bRaw: bigint | null;
  let sqrt: bigint | null = null;

  if (protocol === 'cetus') {
    // Deposits/withdrawals: 0xdb5cd62a… AddLiquidityV2Event / RemoveLiquidityV2Event
    //   (amount_a, amount_b, current_sqrt_price). Fees: 0x1eabed72… CollectFeeEvent
    //   (amount_a, amount_b; NO sqrt price). CollectRewardV2Event is NOT a fee
    //   claim and is excluded here (rewards are a separate, deferred path).
    if (name === 'AddLiquidityV2Event') kind = 'deposit';
    else if (name === 'RemoveLiquidityV2Event') kind = 'withdrawal';
    else if (name === 'CollectFeeEvent') kind = 'fee_claim';
    else return null;
    aRaw = bigintOrNull(pj.amount_a);
    bRaw = bigintOrNull(pj.amount_b);
    if (kind !== 'fee_claim') sqrt = bigintOrNull(pj.current_sqrt_price);
  } else if (protocol === 'momentum') {
    // Momentum (Sprint MOMENTUM): AddLiquidityEvent / RemoveLiquidityEvent
    //   (amount_x, amount_y; NO current_sqrt_price — Momentum liquidity events
    //   carry no pool price). Fees: FeeCollectedEvent (amount_x, amount_y; no
    //   sqrt). CollectPoolRewardEvent is a separate reward path (excluded from
    //   Capital G/L per Rule 4). sqrt is ALWAYS null → every deposit/withdrawal
    //   rides the historical-sides fallback (stable $1 + SUI historical), which
    //   is Rule-1a-clean for the SUI/USDC pools Momentum runs.
    if (name === 'AddLiquidityEvent') kind = 'deposit';
    else if (name === 'RemoveLiquidityEvent') kind = 'withdrawal';
    else if (name === 'FeeCollectedEvent') kind = 'fee_claim';
    else return null;
    aRaw = bigintOrNull(pj.amount_x);
    bRaw = bigintOrNull(pj.amount_y);
    // sqrt stays null for all Momentum events (no current_sqrt_price field).
  } else {
    // Bluefin: LiquidityProvided / LiquidityRemoved (coin_a_amount, coin_b_amount,
    //   current_sqrt_price). Fees: UserFeeCollected (coin_a_amount, coin_b_amount;
    //   NO sqrt price). UserRewardCollected is a separate reward path (excluded).
    if (name === 'LiquidityProvided') kind = 'deposit';
    else if (name === 'LiquidityRemoved') kind = 'withdrawal';
    else if (name === 'UserFeeCollected') kind = 'fee_claim';
    else return null;
    aRaw = bigintOrNull(pj.coin_a_amount);
    bRaw = bigintOrNull(pj.coin_b_amount);
    if (kind !== 'fee_claim') sqrt = bigintOrNull(pj.current_sqrt_price);
  }

  return {
    positionId,
    protocol,
    kind,
    txDigest,
    timestamp,
    poolId,
    amountARaw: aRaw ?? 0n,
    amountBRaw: bRaw ?? 0n,
    sqrtPriceX64: sqrt,
  };
}

// B3 — Reconstruct one closed position's full lifecycle: gather all its events
// from the wallet's tx history, resolve coin types/decimals from the persistent
// pool object, order chronologically. Returns null if the position cannot be
// reconstructed (e.g. pool unresolvable, no events found).
// Build a SuiPositionLifecycle from already-grouped events (internal; avoids
// re-fetching tx history per position). Resolves pool context once.
async function buildLifecycle(
  protocol: SuiClmmProtocol,
  positionId: string,
  events: SuiPositionEvent[],
): Promise<SuiPositionLifecycle | null> {
  if (events.length === 0) return null;
  const poolId = events.find((e) => e.poolId)?.poolId ?? '';
  if (!poolId) return null;
  const ctx = await resolvePoolContext(poolId);
  if (!ctx) return null;
  return {
    positionId,
    protocol,
    poolId,
    coinTypeA: ctx.coinTypeA,
    coinTypeB: ctx.coinTypeB,
    decimalsA: ctx.decimalsA,
    decimalsB: ctx.decimalsB,
    openedTs: events[0].timestamp,
    closedTs: events[events.length - 1].timestamp,
    events,
  };
}

export async function reconstructPositionLifecycle(
  walletAddress: string,
  protocol: SuiClmmProtocol,
  positionId: string,
): Promise<SuiPositionLifecycle | null> {
  const blocks = await fetchWalletBlocks(walletAddress);
  const grouped = groupEventsByPosition(protocol, blocks);
  const events = grouped.get(positionId);
  if (!events) return null;
  return buildLifecycle(protocol, positionId, events);
}

// ── Valuation cascade (pricing-invariants Rule 1a/Rule 2; NEVER current spot) ──

// price of token0(A) in token1(B), HUMAN units, from the event-embedded Q64.64
// sqrt price (the pool price AT THAT BLOCK — historical-by-construction).
function sqrtToHumanPriceAinB(sqrtX64: bigint, decA: number, decB: number): number {
  const s = Number(sqrtX64) / 2 ** 64;
  const priceRaw = s * s; // raw B per raw A
  return priceRaw * 10 ** (decA - decB); // human B per human A
}

interface SideValue { usd: number | null; p0: number | null; p1: number | null; source: string }

// Historical per-side pricing (used for fee claims, and for deposits/withdrawals
// when sqrt is missing or the pool has no stable anchor). SUI uses CoinGecko
// historical first (Rule 1c primary) then DeFiLlama; other non-stable uses
// DeFiLlama. Reads are cache-only — caller MUST prewarm first.
function histSidePrice(coinType: string, stable: boolean, ts: number): { px: number; src: string } | null {
  if (stable) return { px: 1, src: 'stablecoin-fixed' };
  if (normalizeSuiType(coinType).toLowerCase() === SUI_CANONICAL) {
    // HISTORICAL-ONLY CoinGecko SUI price (Rule 1c primary). Deliberately NOT
    // getCachedSuiPriceForTimestamp — that helper can return the FIX-C current
    // cg-spot fallback, which would violate Rule 1a for a fee claim.
    const cg = getHistoricalOnlySuiPrice(ts);
    if (cg != null) return { px: cg, src: 'cg-historical' };
  }
  const dl = getCachedOnlyDefillamaPrice('sui', coinType, ts);
  if (dl != null) return { px: dl, src: 'defillama-historical' };
  return null; // → pending (Rule 1a: never current spot)
}

function valueByHistoricalSides(
  amtA: number, amtB: number, ctA: string, ctB: string, stA: boolean, stB: boolean, ts: number,
): SideValue {
  const a = histSidePrice(ctA, stA, ts);
  const b = histSidePrice(ctB, stB, ts);
  if (a && b) {
    const src = a.src === b.src ? a.src : `${a.src}+${b.src}`;
    return { usd: amtA * a.px + amtB * b.px, p0: a.px, p1: b.px, source: src };
  }
  return { usd: null, p0: a?.px ?? null, p1: b?.px ?? null, source: 'pending' };
}

function valueEvent(ev: SuiPositionEvent, ctx: SuiPositionLifecycle): SideValue {
  const amtA = Number(ev.amountARaw) / 10 ** ctx.decimalsA;
  const amtB = Number(ev.amountBRaw) / 10 ** ctx.decimalsB;
  // Zero-amount artifact (protocol-side rebalance / dust) → resolved at $0.
  if (amtA === 0 && amtB === 0) return { usd: 0, p0: 0, p1: 0, source: 'zero_amount' };

  const stA = isStable(ctx.coinTypeA);
  const stB = isStable(ctx.coinTypeB);

  // PRIMARY (deposit/withdrawal only): event-embedded sqrtPrice + stable anchor,
  // when EXACTLY one side is a stablecoin. Block price → historical, NOT spot.
  if (ev.kind !== 'fee_claim' && ev.sqrtPriceX64 != null && stA !== stB) {
    const hAinB = sqrtToHumanPriceAinB(ev.sqrtPriceX64, ctx.decimalsA, ctx.decimalsB);
    if (Number.isFinite(hAinB) && hAinB > 0) {
      const p0 = stB ? hAinB : 1;        // B stable → A priced from sqrt; else A stable ($1)
      const p1 = stB ? 1 : 1 / hAinB;    // B priced from sqrt when A is the stable side
      if (Number.isFinite(p0) && Number.isFinite(p1) && p0 >= 0 && p1 >= 0) {
        return { usd: amtA * p0 + amtB * p1, p0, p1, source: 'sqrtprice-historical' };
      }
    }
  }
  // FALLBACK (and all fee claims): historical per side. NEVER current spot.
  return valueByHistoricalSides(amtA, amtB, ctx.coinTypeA, ctx.coinTypeB, stA, stB, ev.timestamp);
}

// B3 — Apply the valuation cascade to a lifecycle, producing a fully-valued
// SuiClosedPosition (events carry usdAtTime; summary fields computed). No spot.
export async function valuePositionLifecycle(
  lifecycle: SuiPositionLifecycle,
): Promise<SuiClosedPosition> {
  // PREWARM the historical caches for every side that needs a historical lookup:
  // all fee claims, plus any deposit/withdrawal that won't hit the sqrt path
  // (sqrt missing, or pool has 0 or 2 stable sides). Deposits/withdrawals on a
  // one-stable pool with sqrt present need NO fetch (pure math from the event).
  const stA = isStable(lifecycle.coinTypeA);
  const stB = isStable(lifecycle.coinTypeB);
  const suiTs = new Set<number>();
  const dlByCoin = new Map<string, Set<number>>();
  const needHistorical = (e: SuiPositionEvent) =>
    e.kind === 'fee_claim' || e.sqrtPriceX64 == null || stA === stB;
  for (const e of lifecycle.events) {
    if (!needHistorical(e)) continue;
    for (const [ct, stable] of [[lifecycle.coinTypeA, stA], [lifecycle.coinTypeB, stB]] as const) {
      if (stable) continue;
      if (normalizeSuiType(ct).toLowerCase() === SUI_CANONICAL) suiTs.add(e.timestamp);
      const set = dlByCoin.get(ct) ?? dlByCoin.set(ct, new Set()).get(ct)!;
      set.add(e.timestamp); // DeFiLlama as SUI's historical fallback + non-SUI primary
    }
  }
  await Promise.all([
    suiTs.size > 0 ? prewarmSuiPricesForTimestamps([...suiTs]) : Promise.resolve(),
    dlByCoin.size > 0
      ? prewarmDefillamaPrices([...dlByCoin].map(([contract, ts]) => ({ chain: 'sui' as const, contract, timestamps: [...ts] })))
      : Promise.resolve(),
  ]);

  // Value every event synchronously (cache-only reads) → ActivityEventForPnL[].
  const events: ActivityEventForPnL[] = [];
  const sourceBreakdown: Record<string, number> = {};
  let depositUSD = 0, withdrawalUSD = 0, feesUSD = 0, pendingEventCount = 0;
  for (const ev of lifecycle.events) {
    const amount0 = Number(ev.amountARaw) / 10 ** lifecycle.decimalsA;
    const amount1 = Number(ev.amountBRaw) / 10 ** lifecycle.decimalsB;
    const v = valueEvent(ev, lifecycle);
    sourceBreakdown[v.source] = (sourceBreakdown[v.source] ?? 0) + 1;
    if (v.usd == null) pendingEventCount += 1;
    else if (ev.kind === 'deposit') depositUSD += v.usd;
    else if (ev.kind === 'withdrawal') withdrawalUSD += v.usd;
    else feesUSD += v.usd;
    events.push({
      type: ev.kind,
      timestamp: ev.timestamp,
      amount0,
      amount1,
      usdAtTime: v.usd,
      price0AtTime: v.p0,
      price1AtTime: v.p1,
      txHash: ev.txDigest,
    });
  }

  const symbolA = lifecycle.coinTypeA.split('::').pop() ?? 'A';
  const symbolB = lifecycle.coinTypeB.split('::').pop() ?? 'B';
  const pair = `${symbolA} / ${symbolB}`;
  const capitalGL = withdrawalUSD - depositUSD; // Rule 4 — NO fees

  logPrice({
    event: 'sui_closed_position_valued',
    protocol: lifecycle.protocol,
    positionId: lifecycle.positionId,
    pair,
    depositUSD, withdrawalUSD, feesUSD, capitalGL, pendingEventCount, sourceBreakdown,
  });

  return {
    positionId: lifecycle.positionId,
    protocol: lifecycle.protocol,
    chain: 'Sui',
    pair,
    poolId: lifecycle.poolId,
    coinTypeA: lifecycle.coinTypeA,
    coinTypeB: lifecycle.coinTypeB,
    openedTs: lifecycle.openedTs,
    closedTs: lifecycle.closedTs,
    depositUSD, withdrawalUSD, feesUSD, capitalGL, pendingEventCount,
    events, sourceBreakdown,
  };
}

// ── Orchestrator: all closed positions for a wallet+protocol, fully valued ────
// Fetches tx history + owned set ONCE (not per position), reconstructs and values
// every closed position. This is what the Redis-cached entry point (B4) wraps.
export async function getClosedPositionsForWallet(
  walletAddress: string,
  protocol: SuiClmmProtocol,
): Promise<SuiClosedPosition[]> {
  const [blocks, owned] = await Promise.all([
    fetchWalletBlocks(walletAddress),
    fetchOwnedPositionIds(walletAddress, protocol),
  ]);
  const grouped = groupEventsByPosition(protocol, blocks);
  const out: SuiClosedPosition[] = [];
  for (const [pid, evs] of grouped) {
    if (owned.has(pid)) continue;
    if (!evs.some((e) => e.kind === 'deposit')) continue;
    const lifecycle = await buildLifecycle(protocol, pid, evs);
    if (!lifecycle) continue;
    out.push(await valuePositionLifecycle(lifecycle));
  }
  return out;
}

// ── Redis cache (Sprint 1.14 immutable-closed-position pattern) ───────────────
// A closed Sui position's lifecycle is IMMUTABLE (object destroyed; events on a
// finalized ledger). So the first successful reconstruction for a (protocol,
// wallet) is persisted and served thereafter — any instance, any user — without
// re-scanning tx history. Mirrors depositHistoryCache.ts exactly: own client,
// same PRICE_CACHE_KV_* env, no-op stub if unset, NEVER throws, fire-and-forget
// writes, and an EMPTY result is NEVER cached (no false negatives — a transient
// RPC failure during the scan must not be frozen in as "no closed positions").
const CLOSED_POS_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
// Cache VERSION key — bump this suffix to invalidate on a valuation-logic change.
const CLOSED_POS_CACHE_VERSION = 'closed_pos_sui_v1';

const _redisUrl = process.env.PRICE_CACHE_KV_REST_API_URL;
const _redisToken = process.env.PRICE_CACHE_KV_REST_API_TOKEN;
let _redis: Redis | null = null;
if (_redisUrl && _redisToken) {
  try { _redis = new Redis({ url: _redisUrl, token: _redisToken }); }
  catch (err) { console.warn('[suiClosedPositions] Redis client construction failed; no-op stub:', err); _redis = null; }
}

function closedPosKey(protocol: SuiClmmProtocol, walletAddress: string): string {
  return `${CLOSED_POS_CACHE_VERSION}:${protocol}:${walletAddress.toLowerCase()}`;
}

async function readClosedPosCache(protocol: SuiClmmProtocol, walletAddress: string): Promise<SuiClosedPosition[] | null> {
  if (!_redis) return null;
  try {
    const raw = await _redis.get<SuiClosedPosition[] | string | null>(closedPosKey(protocol, walletAddress));
    if (raw == null) return null;
    const arr = typeof raw === 'string' ? (JSON.parse(raw) as SuiClosedPosition[]) : raw;
    if (Array.isArray(arr) && arr.length > 0 && arr.every((p) => p && typeof p.capitalGL === 'number' && Array.isArray(p.events))) {
      return arr;
    }
    return null;
  } catch { return null; }
}

function writeClosedPosCache(protocol: SuiClmmProtocol, walletAddress: string, positions: SuiClosedPosition[]): void {
  // Fire-and-forget; never block the hot path, never throw. NEVER cache empty
  // (Sprint 1.14 invariant — a transient empty scan must not become a frozen
  // "no closed positions" false negative).
  if (!_redis || !Array.isArray(positions) || positions.length === 0) return;
  _redis
    .set(closedPosKey(protocol, walletAddress), JSON.stringify(positions), { ex: CLOSED_POS_TTL_SECONDS })
    .catch((err) => console.warn('[suiClosedPositions] Redis write failed (ignored):', err));
}

// B4 — Redis-cached top-level entry point. Read-first; on miss, retrieve +
// reconstruct + value all closed positions, write fire-and-forget. Empty results
// are NEVER cached. This is what useLpPnl (B5) calls per (wallet, protocol).
//
// Sprint LPPNL-PERF (Part B2): module-level in-flight dedup keyed by
// (protocol, wallet) so the sui-closed route's concurrent 3-protocol Promise.all
// (and any effect re-run) never launches two identical scans within a warm
// instance — the expensive tx-history walk runs once per (protocol, wallet).
const _inFlightSuiScans = new Map<string, Promise<SuiClosedPosition[]>>();
export function getCachedClosedPositionCapitalGL(
  walletAddress: string,
  protocol: SuiClmmProtocol,
): Promise<SuiClosedPosition[]> {
  if (!walletAddress) return Promise.resolve([]);
  const key = `${protocol}:${walletAddress.toLowerCase()}`;
  const existing = _inFlightSuiScans.get(key);
  if (existing) return existing;
  const p = (async (): Promise<SuiClosedPosition[]> => {
    const cached = await readClosedPosCache(protocol, walletAddress);
    if (cached) return cached;
    const fresh = await getClosedPositionsForWallet(walletAddress, protocol);
    writeClosedPosCache(protocol, walletAddress, fresh);
    return fresh;
  })();
  _inFlightSuiScans.set(key, p);
  return p.finally(() => { _inFlightSuiScans.delete(key); });
}
