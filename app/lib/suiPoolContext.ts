// Sprint TOKEN-RESOLUTION — per-event Sui CLMM pool-context resolution.
//
// WHY THIS EXISTS
// The wallet-scope fee pipelines (`/api/{bluefin,cetus,momentum}/activity?positionId=all`)
// used to price EVERY fee claim with a SINGLE representative (coinTypeA, coinTypeB,
// decimalsA, decimalsB) passed by the client. For a wallet whose CLOSED positions
// span pools with different token pairs — or whose only context is a hardcoded
// fallback — that single context mis-prices or DROPS claims. The Bluefin
// `BLUEFIN_FALLBACK` carried a corrupted USDC coin type, so for closed-only Sui
// wallets every Bluefin fee claim's USDC side priced to null → the whole claim was
// dropped from Fee Income (~$3,847 missing for Osho's two wallets).
//
// THE FIX
// Each fee event already carries its pool id (Bluefin/Momentum `pool_id`, Cetus
// `pool`). This module resolves that pool id → its real (coinTypeA, coinTypeB,
// decimalsA, decimalsB) from the on-chain pool object, so the SAME historical
// cascade (stable→$1, SUI→getHistoricalOnlySuiPrice, DeFiLlama-by-coin-type, else
// pending) prices the RIGHT token on each side. No new pricing source, no spot —
// Rule 1a holds; this is purely about getting the correct token identity into the
// existing cascade.
//
// CACHE (Sprint SUI-RPC-RELIABILITY)
// A Sui CLMM pool is a SHARED object whose `Pool<A, B>` type params are IMMUTABLE.
// Two-tier cache: L1 in-process Map (no TTL) + L2 Upstash Redis
// (`sui_pool_ctx_v1:{poolId}`, 90-day TTL) so a warmed context survives cold
// starts and is shared cross-instance/user — repeat loads pay ZERO RPC. A
// known-unresolvable id is cached as `null` (L1 only) so a bad id is not refetched.
//
// RPC (Sprint SUI-RPC-RELIABILITY)
// Reads go through the shared paced+failover `suiRpc` client (was a bare fetch on
// a single flaky endpoint). Multiple pools are resolved in ONE `sui_multiGetObjects`
// batch (was N individual `sui_getObject` calls into the concurrent burst).

import { lookupHardcodedToken, normalizeSuiType } from './tokenConstants';
import { suiRpc } from './suiRpc';
import { getSuiCoinMetadata } from './suiHistory';
import { Redis } from '@upstash/redis';

export interface SuiPoolContext {
  coinTypeA: string;
  coinTypeB: string;
  decimalsA: number;
  decimalsB: number;
}

// poolId → context | null. `null` is stored ONLY when the chain itself says the
// id is not a pool (the object exists and its type carries no coin pair, or the
// object does not exist). A read that FAILED, or a coin whose decimals could not
// be read, is never stored: the next request tries again. Remembering a failure
// here used to drop every fee claim in that pool for the life of the instance.
const _poolCtxCache = new Map<string, SuiPoolContext | null>();

// ── L2 Redis (Sprint 1.14 contract: own client, no-op stub, never throws) ─────
const POOL_CTX_CACHE_VERSION = 'sui_pool_ctx_v1';
const POOL_CTX_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days (immutable; TTL for hygiene)
const _redisUrl = process.env.PRICE_CACHE_KV_REST_API_URL;
const _redisToken = process.env.PRICE_CACHE_KV_REST_API_TOKEN;
let _redis: Redis | null = null;
if (_redisUrl && _redisToken) {
  try { _redis = new Redis({ url: _redisUrl, token: _redisToken }); }
  catch (err) { console.warn('[suiPoolContext] Redis client construction failed; no-op stub:', err); _redis = null; }
}
const poolCtxKey = (poolId: string) => `${POOL_CTX_CACHE_VERSION}:${poolId}`;

async function redisGetPoolCtxs(ids: string[]): Promise<Map<string, SuiPoolContext>> {
  const out = new Map<string, SuiPoolContext>();
  if (!_redis || ids.length === 0) return out;
  try {
    const raw = await _redis.mget<(SuiPoolContext | string | null)[]>(...ids.map(poolCtxKey));
    ids.forEach((id, i) => {
      const v = raw?.[i];
      if (v == null) return;
      const ctx = typeof v === 'string' ? (JSON.parse(v) as SuiPoolContext) : v;
      if (ctx && ctx.coinTypeA && ctx.coinTypeB && typeof ctx.decimalsA === 'number') out.set(id, ctx);
    });
  } catch { /* treat as miss */ }
  return out;
}
function redisSetPoolCtx(id: string, ctx: SuiPoolContext): void {
  if (!_redis) return;
  _redis.set(poolCtxKey(id), JSON.stringify(ctx), { ex: POOL_CTX_TTL_SECONDS })
    .catch(() => { /* fire-and-forget */ });
}

// ── Decimals: pinned constants (no RPC) → on-chain metadata (two sources) ─────
// Returns null when no source answers. Decimals are never guessed: a wrong
// guess mis-scales an amount by a power of ten and prices it confidently.
const _decimalsCache = new Map<string, number>();
async function resolveDecimals(coinType: string): Promise<number | null> {
  const norm = normalizeSuiType(coinType);
  const tok = lookupHardcodedToken('sui', norm);
  if (tok) return tok.decimals;
  if (_decimalsCache.has(norm)) return _decimalsCache.get(norm)!;
  let dec: number | null = null;
  try {
    const meta = (await suiRpc('suix_getCoinMetadata', [coinType])) as { decimals?: number } | null;
    if (meta && typeof meta.decimals === 'number') dec = meta.decimals;
  } catch { /* try the second source */ }
  if (dec === null) {
    const meta = await getSuiCoinMetadata(coinType);
    if (meta && typeof meta.decimals === 'number') dec = meta.decimals;
  }
  if (dec !== null) _decimalsCache.set(norm, dec);
  return dec;
}

// Extract the first two `Pool<A, B[, ...]>` type params from an object type string.
function parsePoolCoinTypes(typ: string): { a: string; b: string } | null {
  const m = typ.match(/<([^,]+),\s*([^,>]+)/);
  if (!m) return null;
  return { a: normalizeSuiType(m[1].trim()), b: normalizeSuiType(m[2].trim()) };
}

// ── Batch resolver: ONE multiGetObjects for the uncached pools ────────────────
// Callers treat a missing id as "pool unresolved" → that fee claim stays pending
// (usdAtTime null, Rule 1a), never priced with a guessed/hardcoded token type.
export async function resolveSuiPoolContexts(poolIds: Iterable<string>): Promise<Map<string, SuiPoolContext>> {
  const ids = [...new Set([...poolIds].filter(Boolean))];
  const out = new Map<string, SuiPoolContext>();

  // L1 in-process
  const need: string[] = [];
  for (const id of ids) {
    if (_poolCtxCache.has(id)) { const c = _poolCtxCache.get(id); if (c) out.set(id, c); }
    else need.push(id);
  }
  if (need.length === 0) return out;

  // L2 Redis (batched mget)
  const fromRedis = await redisGetPoolCtxs(need);
  const stillNeed: string[] = [];
  for (const id of need) {
    const c = fromRedis.get(id);
    if (c) { _poolCtxCache.set(id, c); out.set(id, c); }
    else stillNeed.push(id);
  }
  if (stillNeed.length === 0) return out;

  // RPC: ONE multiGetObjects per 50-id chunk (Sui's per-call limit), then resolve
  // each pool's decimals (pinned constants are free; others one metadata call).
  for (let i = 0; i < stillNeed.length; i += 50) {
    const chunk = stillNeed.slice(i, i + 50);
    // A failed read leaves the whole chunk unresolved for THIS request only.
    type PoolObj = { data?: { objectId?: string; type?: string }; error?: { code?: string; object_id?: string } };
    const objs = await (suiRpc('sui_multiGetObjects', [chunk, { showType: true }]) as Promise<PoolObj[] | null>).catch((err) => {
      console.error('[suiPoolContext] pool read failed (not cached):', String(err).slice(0, 160));
      return null;
    });
    if (!Array.isArray(objs)) continue;
    // multiGetObjects returns results in request order; map back by index (and by
    // objectId when present, in case an endpoint reorders).
    const byId = new Map<string, { typ: string; gone: boolean }>();
    objs.forEach((o, k) => {
      const id = o?.data?.objectId ?? o?.error?.object_id ?? chunk[k];
      const gone = o?.error?.code === 'notExists' || o?.error?.code === 'deleted';
      if (id) byId.set(id, { typ: o?.data?.type ?? '', gone });
    });
    await Promise.all(chunk.map(async (id) => {
      const got = byId.get(id);
      if (!got) return;                                   // no answer for this id → retry next time
      if (got.gone) { _poolCtxCache.set(id, null); return; } // the chain says there is no such object
      if (!got.typ) return;                               // answered without a type → not a verdict
      const pair = parsePoolCoinTypes(got.typ);
      if (!pair) { _poolCtxCache.set(id, null); return; } // a real object that is not a Pool<A,B>
      const [decimalsA, decimalsB] = await Promise.all([resolveDecimals(pair.a), resolveDecimals(pair.b)]);
      if (decimalsA === null || decimalsB === null) return; // decimals unknown → unresolved, not cached
      const ctx: SuiPoolContext = { coinTypeA: pair.a, coinTypeB: pair.b, decimalsA, decimalsB };
      _poolCtxCache.set(id, ctx);
      redisSetPoolCtx(id, ctx);
      out.set(id, ctx);
    }));
  }
  return out;
}

// Resolve ONE pool id → its coin types + decimals (thin wrapper over the batch).
export async function resolveSuiPoolContext(poolId: string): Promise<SuiPoolContext | null> {
  if (!poolId) return null;
  if (_poolCtxCache.has(poolId)) return _poolCtxCache.get(poolId)!;
  const m = await resolveSuiPoolContexts([poolId]);
  return m.get(poolId) ?? _poolCtxCache.get(poolId) ?? null;
}
