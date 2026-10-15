import { createSharedRedis } from './sharedStore';
// Block timestamps for the EVM activity routes: two sources, stored once.
//
// Every EVM activity route dates its events by `eth_getBlockByNumber`. There
// was ONE source (Alchemy). When it was throttled the route kept `0` for the
// block and the event left the route dated 1970: counted in every lifetime
// total, outside every time window. Measured on production 2026-10-11: the
// three Uniswap V3 claims of one wallet (168.09) and nine Aerodrome claims
// came back undated on ordinary page loads, on every load once the key was
// under load, and two retries 0.4 s and 1.2 s apart did not get through.
//
// A block's timestamp never changes, so the lookup is now:
//   1. this process's memory;
//   2. the shared store (`evm_block_ts_v1:{chain}:{blockHex}`, no expiry);
//   3. the route's own source (Alchemy), as before;
//   4. the chain's public endpoint, for the blocks still missing;
//   5. the route's own source once more, after a pause.
// A block that is still undated after all five is returned as 0 and the page
// reports it (analytics feeIncome: "N claims could not be dated").
//
// Why a second endpoint may fill an immutable cache here (Methodology rule (f)
// forbids it in general): the answer is SELF-VERIFYING. The public endpoint's
// reply is accepted only when the block number it returns equals the block
// asked for — a reply for any other block (an endpoint that ignores the
// argument, as the public HyperEVM endpoint does for state reads) is discarded.
// Only blocks at least an hour old are stored, so a reorged block cannot be.
const KEY_PREFIX = 'evm_block_ts_v1:';
const STORE_MIN_AGE_SEC = 3600;
const FALLBACK_CONCURRENCY = 10;
// Local and preview test runs set this: read the shared store, never write to it.
const READONLY = process.env.CLOSED_POS_CACHE_READONLY === '1';

type Store = {
  mget: (...keys: string[]) => Promise<unknown[]>;
  set: (k: string, v: unknown) => Promise<unknown>;
};
let store: Store | null = null;
try {
  const url = process.env.PRICE_CACHE_KV_REST_API_URL;
  const token = process.env.PRICE_CACHE_KV_REST_API_TOKEN;
  if (url && token) {
    store = createSharedRedis('blockTimestamps') as unknown as Store;
  }
} catch {
  store = null;
}

const memory = new Map<string, number>();
const stats = { memory: 0, store: 0, primary: 0, fallback: 0, retry: 0, undated: 0 };
/** Process-wide counts of where block timestamps came from (diagnostics). */
export function blockTimestampStats() { return { ...stats, storeEnabled: store != null }; }

const hexOf = (b: number) => `0x${b.toString(16)}`;
const keyOf = (chain: string, b: number) => `${KEY_PREFIX}${chain}:${hexOf(b)}`;

async function fromPublicEndpoint(rpc: string, block: number): Promise<number> {
  for (const pause of [0, 500, 1500]) {
    if (pause) await new Promise((r) => setTimeout(r, pause));
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: block, method: 'eth_getBlockByNumber', params: [hexOf(block), false] }),
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));
      if (!res.ok) continue;
      const j = (await res.json()) as { result?: { number?: string; timestamp?: string } | null };
      const r = j.result;
      // Self-verifying: the reply must be FOR the block that was asked for.
      if (!r?.timestamp || !r.number || parseInt(r.number, 16) !== block) continue;
      const ts = parseInt(r.timestamp, 16);
      if (ts > 0) return ts;
    } catch { /* next attempt */ }
  }
  return 0;
}

/**
 * Timestamps (unix seconds) for `blockNumbers` on `chain`; 0 for a block no
 * source could date. `primary` is the route's existing lookup; `publicRpc` is
 * the chain's public endpoint (omit when the route has no second source).
 */
export async function resolveBlockTimestamps(
  chain: string,
  blockNumbers: number[],
  primary: (blocks: number[]) => Promise<Record<number, number>>,
  publicRpc?: string,
): Promise<Record<number, number>> {
  const unique = [...new Set(blockNumbers)];
  const out: Record<number, number> = {};
  const fromNetwork: number[] = [];
  const missing = () => unique.filter((b) => !(out[b] > 0));

  for (const b of unique) {
    const hit = memory.get(keyOf(chain, b));
    if (hit) { out[b] = hit; stats.memory += 1; }
  }

  if (store && missing().length > 0) {
    const need = missing();
    try {
      for (let i = 0; i < need.length; i += 200) {
        const part = need.slice(i, i + 200);
        const vals = await store.mget(...part.map((b) => keyOf(chain, b)));
        part.forEach((b, k) => {
          const v = Number(vals[k]);
          if (v > 0) { out[b] = v; memory.set(keyOf(chain, b), v); stats.store += 1; }
        });
      }
    } catch { /* a store failure is a miss, never an error */ }
  }

  const take = (got: Record<number, number>, tier: 'primary' | 'fallback' | 'retry') => {
    for (const b of missing()) if (got[b] > 0) { out[b] = got[b]; fromNetwork.push(b); stats[tier] += 1; }
  };

  if (missing().length > 0) {
    try { take(await primary(missing()), 'primary'); } catch { /* fall through to the second source */ }
  }
  if (publicRpc && missing().length > 0) {
    const need = missing();
    const got: Record<number, number> = {};
    for (let i = 0; i < need.length; i += FALLBACK_CONCURRENCY) {
      const part = need.slice(i, i + FALLBACK_CONCURRENCY);
      const ts = await Promise.all(part.map((b) => fromPublicEndpoint(publicRpc, b)));
      part.forEach((b, k) => { got[b] = ts[k]; });
    }
    take(got, 'fallback');
  }
  if (missing().length > 0) {
    await new Promise((r) => setTimeout(r, 1200));
    try { take(await primary(missing()), 'retry'); } catch { /* still undated; the page reports it */ }
  }

  const nowSec = Math.floor(Date.now() / 1000);
  for (const b of fromNetwork) {
    const ts = out[b];
    memory.set(keyOf(chain, b), ts);
    // Fire-and-forget, positive and settled blocks only; a write failure never matters.
    if (store && !READONLY && ts > 0 && nowSec - ts >= STORE_MIN_AGE_SEC) void store.set(keyOf(chain, b), ts).catch(() => {});
  }
  for (const b of unique) if (!(out[b] > 0)) { out[b] = 0; stats.undated += 1; }
  return out;
}
