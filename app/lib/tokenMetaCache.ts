// Token metadata (decimals, symbol, name) in the shared store.
//
// A token's decimals never change and its symbol practically never does, yet the
// Sui position routes asked `suix_getCoinMetadata` for every non-pinned coin on
// every request (4 calls on each Account 1 dashboard load), and the PancakeSwap
// route read `decimals()` / `symbol()` per position per request. Each is an
// Alchemy call against the one account-wide throughput limit.
//
// Kept in process memory and in the shared store as
// `token_meta_v1:{chain}:{id}` for 90 days. Only a complete answer is stored
// (integer decimals 0-36 and a symbol); a failed or partial read is never stored,
// so a transient failure cannot pin a wrong value. Outside production the store
// writes stay in the process (app/lib/sharedStore.ts).

import { createSharedRedis } from './sharedStore';
import { suiRpc } from './suiRpc';

export interface TokenMeta { symbol: string; decimals: number; name?: string }

const KEY_PREFIX = 'token_meta_v1';
const TTL_SECONDS = 90 * 24 * 60 * 60;
const memo = new Map<string, TokenMeta>();
const redis = createSharedRedis('tokenMetaCache');

const keyOf = (chain: string, id: string) =>
  `${KEY_PREFIX}:${chain}:${chain === 'sui' ? id : id.toLowerCase()}`;

const valid = (m: unknown): m is TokenMeta => {
  const t = m as TokenMeta | null;
  return !!t && Number.isInteger(t.decimals) && t.decimals >= 0 && t.decimals <= 36
    && typeof t.symbol === 'string' && t.symbol.length > 0;
};

export async function getCachedTokenMeta(chain: string, id: string): Promise<TokenMeta | null> {
  const key = keyOf(chain, id);
  const hit = memo.get(key);
  if (hit) return hit;
  if (!redis) return null;
  try {
    const stored = await redis.get(key);
    const parsed = typeof stored === 'string' ? JSON.parse(stored) : stored;
    if (valid(parsed)) { memo.set(key, parsed); return parsed; }
  } catch { /* a store miss is only a miss */ }
  return null;
}

export function setCachedTokenMeta(chain: string, id: string, meta: TokenMeta): void {
  if (!valid(meta)) return;
  const key = keyOf(chain, id);
  memo.set(key, meta);
  if (redis) redis.set(key, JSON.stringify(meta), { ex: TTL_SECONDS }).catch(() => {});
}

/**
 * A Sui coin's metadata: memory → shared store → `suix_getCoinMetadata`.
 * Null when the chain read failed or returned nothing usable (never a guess).
 */
export async function suiCoinMetadataCached(coinType: string): Promise<TokenMeta | null> {
  const cached = await getCachedTokenMeta('sui', coinType);
  if (cached) return cached;
  const r = (await suiRpc('suix_getCoinMetadata', [coinType])) as { decimals?: number; symbol?: string; name?: string } | null | undefined;
  if (!r || typeof r.decimals !== 'number') return null;
  const meta: TokenMeta = { decimals: r.decimals, symbol: r.symbol ?? '', name: r.name };
  if (valid(meta)) setCachedTokenMeta('sui', coinType, meta);
  return meta;
}
