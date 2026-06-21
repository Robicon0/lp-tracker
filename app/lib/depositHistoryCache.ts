// app/lib/depositHistoryCache.ts
//
// Persistent (Upstash Redis) cache of a CLOSED HyperEVM position's raw
// deposit/withdrawal/fee logs, keyed by (nftManager, tokenId) (Sprint 1.14).
//
// WHY (measured, Sprint 1.14): a closed HyperEVM position's deposit history is
// only retrievable via Tier 1 (Etherscan V2, fromBlock=0). Tier 2 (Chainstack
// archive) is useless for these positions — its SCAN_DEPTH window is the last
// ~5M blocks (~57 days at HyperEVM's ~1s block time), and the deposits are
// months old; and a true fromBlock=0 archive query returns -32002 ("Archive
// requests not available on your current plan"). So when Etherscan's free-tier
// rate limit throttles Tier 1 for one position under concurrent load, it falls
// to a Tier 2 that physically cannot find the deposit → the route returns 0
// deposits → analytics excludes the position with "Deposit history could not be
// retrieved." Sprint 1.13's in-process dedup cut the call VOLUME but can't help
// when the one remaining Etherscan call is throttled.
//
// THE FIX: a CLOSED position's on-chain history is IMMUTABLE. The FIRST time any
// user / any instance retrieves it successfully (Etherscan not throttled at that
// moment), persist the raw logs here. Every subsequent load — any instance, any
// user, even while Etherscan is throttling — serves from Redis and never re-hits
// Etherscan. The intermittent banner resolves to "permanently works after the
// first success."
//
// SCOPE / SAFETY:
//   - CLOSED positions only (caller passes the open/closed status). Open
//     positions can gain new deposits, so they are never cached here — they keep
//     fetching fresh (and, being value>0, already have the client-side fallback).
//   - The caller MUST NOT write an empty / deposit-less result (a position always
//     has >=1 IncreaseLiquidity; 0 means a failed retrieval, not a real state).
//     This module additionally refuses to cache an empty array as a guard.
//   - Mirrors the Sprint 1.6 redisPriceCache contract: own client, same
//     PRICE_CACHE_KV_* env, no-op stub if unset, NEVER throws, writes are
//     fire-and-forget.

import { Redis } from '@upstash/redis';

// 30 days. Closed-position history is immutable in practice; the TTL only bounds
// the free-tier keyspace and lets a (hypothetical) reorg correction propagate.
const TTL_SECONDS = 30 * 24 * 60 * 60;

// The minimal shape of an EVM log this cache round-trips. Kept structurally
// identical to the route's RawLog so cached entries feed the parser unchanged.
export interface CachedRawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
}

const REST_URL = process.env.PRICE_CACHE_KV_REST_API_URL;
const REST_TOKEN = process.env.PRICE_CACHE_KV_REST_API_TOKEN;
let redis: Redis | null = null;
if (REST_URL && REST_TOKEN) {
  try {
    redis = new Redis({ url: REST_URL, token: REST_TOKEN });
  } catch (err) {
    console.warn('[depositHistoryCache] Redis client construction failed; no-op stub:', err);
    redis = null;
  }
}

let warnedDisabled = false;
function warnDisabledOnce(): void {
  if (warnedDisabled) return;
  warnedDisabled = true;
  console.warn(
    '[depositHistoryCache] PRICE_CACHE_KV_REST_API_URL / _TOKEN not set — closed ' +
      'HyperEVM deposit-history cache disabled (no-op stub). Retrieval still works ' +
      'via Etherscan/archive each load. Set both env vars to enable persistence.',
  );
}

export function isDepositCacheEnabled(): boolean {
  if (!redis) {
    warnDisabledOnce();
    return false;
  }
  return true;
}

// Deterministic, debuggable key. nftManager lowercased; tokenId is the decimal
// NFT id string the route already has. chain pinned to hyperevm (the only chain
// with this two-tier retrieval today; explicit so a future chain can't collide).
function buildKey(nftManager: string, tokenId: string): string {
  return `deposit:logs:hyperevm:${nftManager.toLowerCase()}:${tokenId}`;
}

// Read cached logs, or null on miss / error / malformed. Never throws.
export async function getCachedDepositLogs(
  nftManager: string,
  tokenId: string,
): Promise<CachedRawLog[] | null> {
  if (!redis || !nftManager || !tokenId) return null;
  try {
    const raw = await redis.get<CachedRawLog[] | string | null>(buildKey(nftManager, tokenId));
    if (raw == null) return null;
    const arr = typeof raw === 'string' ? (JSON.parse(raw) as CachedRawLog[]) : raw;
    // Defensive: only return a non-empty, well-shaped array.
    if (Array.isArray(arr) && arr.length > 0 && arr.every((l) => l && Array.isArray(l.topics) && typeof l.blockNumber === 'string')) {
      return arr;
    }
    return null;
  } catch {
    return null; // miss on error — caller falls through to live retrieval
  }
}

// Persist logs for a CLOSED position. Fire-and-forget; never awaited on the hot
// path. Refuses to cache an empty array (a deposit-less result must never be
// persisted — see module header). Never throws.
export async function setCachedDepositLogs(
  nftManager: string,
  tokenId: string,
  logs: CachedRawLog[],
): Promise<void> {
  if (!redis || !nftManager || !tokenId) return;
  if (!Array.isArray(logs) || logs.length === 0) return;
  try {
    await redis.set(buildKey(nftManager, tokenId), JSON.stringify(logs), { ex: TTL_SECONDS });
  } catch (err) {
    console.warn('[depositHistoryCache] Redis write failed (ignored):', err);
  }
}
