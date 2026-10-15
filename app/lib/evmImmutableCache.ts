// Shared-store cache for EVM answers that can never change: a mined transaction's
// receipt logs once its block is final, and a pool's token0 / token1.
//
// The Aerodrome and Velodrome closed-position builders read, for EVERY closed
// position on EVERY request, the mint transaction's receipt (20 CU) and the
// pool's token0() and token1() (2 × 26 CU). A wallet with 65 closed positions
// spent about 4,700 CU of the account-wide Alchemy limit per request on answers
// that were the same as last time.
//
// Keys (90 days, positive answers only — a failed or empty read is never stored):
//   evm_receipt_v1:{chain}:{txHash}  → { blockNumber, logs: [{ address, topics, data, logIndex }] }
//   evm_pool_tokens_v1:{chain}:{pool} → { token0, token1 }
// A receipt is stored only when its block is at least REORG_MARGIN_BLOCKS below
// the chain head (head read at most once a minute per chain). Outside production
// writes stay in the process (app/lib/sharedStore.ts).

import { createSharedRedis } from './sharedStore';
import { evmRpcPost } from './evmRpc';

const TTL_SECONDS = 90 * 24 * 60 * 60;
const REORG_MARGIN_BLOCKS = 64;
const HEAD_TTL_MS = 60_000;
const redis = createSharedRedis('evmImmutableCache');

export interface ReceiptLog { address: string; topics: string[]; data: string; logIndex?: string }
export interface CachedReceipt { blockNumber: string; logs: ReceiptLog[] }

const receiptMemo = new Map<string, CachedReceipt>();
const poolMemo = new Map<string, { token0: string; token1: string }>();
const heads = new Map<string, { at: number; head: number }>();

async function storeGet<T>(key: string): Promise<T | null> {
  if (!redis) return null;
  try {
    const v = await redis.get(key);
    return (typeof v === 'string' ? JSON.parse(v) : v) as T | null;
  } catch { return null; }
}
function storeSet(key: string, value: unknown): void {
  if (redis) redis.set(key, JSON.stringify(value), { ex: TTL_SECONDS }).catch(() => {});
}

async function chainHead(chain: string, rpc: string): Promise<number | null> {
  const h = heads.get(chain);
  if (h && Date.now() - h.at < HEAD_TTL_MS) return h.head;
  const res = await evmRpcPost(rpc, { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] });
  const head = typeof res.result === 'string' ? parseInt(res.result, 16) : NaN;
  if (!Number.isFinite(head)) return null;
  heads.set(chain, { at: Date.now(), head });
  return head;
}

/**
 * A transaction's receipt (block number and logs): memory → shared store → RPC.
 * Null when it could not be read (never an empty receipt standing in for one).
 */
export async function cachedReceipt(chain: string, rpc: string, txHash: string): Promise<CachedReceipt | null> {
  const hash = txHash.toLowerCase();
  const key = `evm_receipt_v1:${chain}:${hash}`;
  const hit = receiptMemo.get(key) ?? await storeGet<CachedReceipt>(key);
  if (hit && Array.isArray(hit.logs)) { receiptMemo.set(key, hit); return hit; }

  const res = await evmRpcPost(rpc, { jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [hash] });
  const rc = res.result as { blockNumber?: string; logs?: ReceiptLog[] } | null | undefined;
  if (res.error || !rc || typeof rc.blockNumber !== 'string' || !Array.isArray(rc.logs)) return null;
  const receipt: CachedReceipt = {
    blockNumber: rc.blockNumber,
    logs: rc.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data, logIndex: l.logIndex })),
  };
  const head = await chainHead(chain, rpc);
  if (head != null && parseInt(receipt.blockNumber, 16) <= head - REORG_MARGIN_BLOCKS) {
    receiptMemo.set(key, receipt);
    storeSet(key, receipt);
  }
  return receipt;
}

/** A pool's token0 / token1 (immutable): memory → shared store → two eth_calls. */
export async function cachedPoolTokens(chain: string, rpc: string, pool: string): Promise<{ token0: string; token1: string } | null> {
  const addr = pool.toLowerCase();
  const key = `evm_pool_tokens_v1:${chain}:${addr}`;
  const hit = poolMemo.get(key) ?? await storeGet<{ token0: string; token1: string }>(key);
  if (hit?.token0 && hit?.token1) { poolMemo.set(key, hit); return hit; }

  const [r0, r1] = await Promise.all(['0x0dfe1681', '0xd21220a7'].map((data) =>
    evmRpcPost(rpc, { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: addr, data }, 'latest'] })));
  const word = (r: { result?: unknown; error?: unknown }) =>
    !r.error && typeof r.result === 'string' && r.result.length >= 66 ? '0x' + r.result.slice(26, 66).toLowerCase() : null;
  const token0 = word(r0), token1 = word(r1);
  if (!token0 || !token1 || /^0x0{40}$/.test(token0) || /^0x0{40}$/.test(token1)) return null;
  const out = { token0, token1 };
  poolMemo.set(key, out);
  storeSet(key, out);
  return out;
}
