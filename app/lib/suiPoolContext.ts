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
// CACHE
// A Sui CLMM pool is a SHARED object whose `Pool<A, B>` type params are IMMUTABLE
// (they survive the position's destruction). So the (poolId → context) mapping is
// cached in an in-process module Map with NO TTL — it can never go stale, and it
// clears naturally on cold start. A known-unresolvable id is cached as `null` so a
// bad id is not refetched. Per distinct pool this costs one `sui_getObject` (plus,
// only for non-pinned tokens, a `suix_getCoinMetadata`); SUI/USDC/USDT decimals
// come from tokenConstants with no RPC. The activity routes are themselves wrapped
// in `withActivityRouteCache`, so repeated identical requests pay nothing.

import { lookupHardcodedToken, normalizeSuiType } from './tokenConstants';

const SUI_RPC = process.env.SUI_RPC_URL || 'https://fullnode.mainnet.sui.io:443';

export interface SuiPoolContext {
  coinTypeA: string;
  coinTypeB: string;
  decimalsA: number;
  decimalsB: number;
}

// poolId → context | null (null = resolved-but-unresolvable; cached so we never
// refetch a known-bad id). Immutable pool type params → no TTL.
const _poolCtxCache = new Map<string, SuiPoolContext | null>();

async function suiRpc(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(SUI_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return (await res.json()).result;
}

// Decimals from the pinned high-stakes constants first (SUI/USDC/USDT — no RPC),
// then the coin's on-chain metadata, then a Sui-default 9.
async function resolveDecimals(coinType: string): Promise<number> {
  const tok = lookupHardcodedToken('sui', normalizeSuiType(coinType));
  if (tok) return tok.decimals;
  try {
    const meta = (await suiRpc('suix_getCoinMetadata', [coinType])) as { decimals?: number } | null;
    if (meta && typeof meta.decimals === 'number') return meta.decimals;
  } catch { /* ignore — fall through to default */ }
  return 9;
}

// Resolve ONE pool id → its coin types + decimals (cached, immutable).
export async function resolveSuiPoolContext(poolId: string): Promise<SuiPoolContext | null> {
  if (!poolId) return null;
  if (_poolCtxCache.has(poolId)) return _poolCtxCache.get(poolId)!;

  let ctx: SuiPoolContext | null = null;
  try {
    const obj = (await suiRpc('sui_getObject', [poolId, { showType: true }])) as { data?: { type?: string } } | null;
    const typ = obj?.data?.type ?? '';
    // Pool<A, B[, ...]> — the first two type params are the pool's coins.
    const m = typ.match(/<([^,]+),\s*([^,>]+)/);
    if (m) {
      const coinTypeA = normalizeSuiType(m[1].trim());
      const coinTypeB = normalizeSuiType(m[2].trim());
      const [decimalsA, decimalsB] = await Promise.all([
        resolveDecimals(coinTypeA),
        resolveDecimals(coinTypeB),
      ]);
      ctx = { coinTypeA, coinTypeB, decimalsA, decimalsB };
    }
  } catch {
    ctx = null;
  }
  _poolCtxCache.set(poolId, ctx);
  return ctx;
}

// Resolve MANY pool ids in parallel → Map of only the successfully-resolved ones.
// Callers treat a missing id as "pool unresolved" → that fee claim stays pending
// (usdAtTime null, Rule 1a), never priced with a guessed/hardcoded token type.
export async function resolveSuiPoolContexts(poolIds: Iterable<string>): Promise<Map<string, SuiPoolContext>> {
  const ids = [...new Set([...poolIds].filter(Boolean))];
  const out = new Map<string, SuiPoolContext>();
  await Promise.all(
    ids.map(async (id) => {
      const ctx = await resolveSuiPoolContext(id);
      if (ctx) out.set(id, ctx);
    }),
  );
  return out;
}
