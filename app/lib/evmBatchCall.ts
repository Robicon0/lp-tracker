/**
 * Chunked, paced `eth_call` fan-out (queue item C, Phase 2a).
 *
 * Removing the hardcoded position-scan caps means a route must be able to make
 * N `eth_call`s where N is whatever the wallet actually holds. The two shapes
 * that were already in the codebase are both wrong at scale:
 *
 *   - `for (…) await rpcCall(…)` (Uniswap V3's tokenId enumeration) — one
 *     serial round trip per position. 300 positions ≈ 300 × RTT.
 *   - `await Promise.all(ids.map(rpcCall))` (HyperSwap's positions fetch) —
 *     unbounded concurrency. 300 positions = 300 simultaneous requests at a
 *     public RPC, which is precisely how an endpoint is pushed into the
 *     throttle/hang state that ITEM 0i renders as confident zeros.
 *
 * This helper does neither: calls are grouped into JSON-RPC batches of
 * `chunkSize`, and the batches themselves are dispatched through `evmRpc`'s
 * GLOBAL semaphore (6), so total in-flight HTTP requests stay bounded no matter
 * how many positions a wallet holds, while the round-trip count falls by ~100×.
 *
 * DEGRADE, DON'T DROP (architecture Rule 11). A failed call yields `null` for
 * THAT call only — never a shortened array — so a caller can always index its
 * results against its inputs, and a transient failure can never masquerade as
 * "this position does not exist". When a whole batch fails (an endpoint with no
 * batch support answers with a single object, or the request times out), each
 * call is retried INDIVIDUALLY through `evmRpcPost` before any null is
 * returned, so batch support is an optimisation and never a correctness
 * dependency.
 */
import { evmRpcBatch, evmRpcPost, type EvmRpcEnvelope } from './evmRpc';

export interface EvmCall {
  to: string;
  data: string;
}

/**
 * Wall-clock ceiling for one fan-out, as an ABSOLUTE timestamp.
 *
 * Removing a position cap removes a bound on COUNT, and something still has to
 * bound the WORK — otherwise an extreme wallet turns a fast wrong answer into a
 * slow one that blows the function budget, which is not an improvement.
 * Measured on the Uniswap V3 Staker (470 Polygon positions) against the free
 * Alchemy tier: an unbounded run took 377 s, past the 300 s `maxDuration`.
 *
 * So the bound moves from "how many positions" to "how long", which is the
 * honest axis: a deadline hit yields nulls for the calls not made, and the
 * caller discloses them through the same `truncated` channel a cap used
 * (queue item C). A user with 470 positions sees as many as the budget allows
 * plus an explicit notice — never a confident subset.
 */
export interface EvmCallManyOptions {
  chunkSize?: number;
  blockTag?: string;
  /** Absolute epoch-ms deadline. Omitted = no time bound (small, known sets). */
  deadline?: number;
}

/**
 * Default calls per JSON-RPC batch.
 *
 * 50, not 100: measured against Alchemy's free tier on a 470-position wallet,
 * batches of 100 came back with a MINORITY of their entries errored (64 of 470
 * tokenId reads, 90 of 213 positions() reads) — a per-request compute/rate
 * limit, not a per-call revert. Smaller batches plus the retry pass below turn
 * those into successes rather than disclosed gaps.
 */
export const DEFAULT_CHUNK_SIZE = 50;

/** Chunks dispatched per wave. Matches evmRpc's global semaphore. */
const WAVE_WIDTH = 6;

/** Calls per batch on each retry pass — progressively smaller. */
const RETRY_CHUNK_SIZES = [20, 10, 5];
/** Delay before each retry pass. Backoff-to-100%, the free-tier requirement. */
const RETRY_DELAYS_MS = [700, 2_000, 5_000];

function resultOf(env: EvmRpcEnvelope | undefined): string | null {
  if (!env || env.error) return null;
  const r = env.result;
  return typeof r === 'string' && r !== '0x' ? r : null;
}

/**
 * Run `calls` and return one entry per call, in order: the hex result string,
 * or `null` if that specific call failed or returned empty.
 */
export async function ethCallMany(
  rpc: string,
  calls: EvmCall[],
  opts: EvmCallManyOptions = {},
): Promise<Array<string | null>> {
  if (calls.length === 0) return [];
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const blockTag = opts.blockTag ?? 'latest';

  const chunks: EvmCall[][] = [];
  for (let i = 0; i < calls.length; i += chunkSize) chunks.push(calls.slice(i, i + chunkSize));

  const expired = () => opts.deadline != null && Date.now() >= opts.deadline;
  const results: Array<string | null> = new Array(calls.length).fill(null);

  const runChunk = async (chunk: EvmCall[]): Promise<Array<string | null>> => {
    const envs = await evmRpcBatch(
      rpc,
      chunk.map((c) => ({ method: 'eth_call', params: [{ to: c.to, data: c.data }, blockTag] })),
    );
    const out = envs.map(resultOf);

    // Whole-batch failure → fall back to individual calls. Distinguished from a
    // per-call revert by ALL entries failing: a genuine revert set is
    // essentially never unanimous across an unrelated chunk, and paying a few
    // redundant single calls is far cheaper than reporting a wallet's positions
    // as missing because an endpoint lacks batch support.
    if (out.length > 0 && out.every((r) => r === null) && !expired()) {
      return Promise.all(
        chunk.map(async (c) => {
          const env = await evmRpcPost(rpc, {
            jsonrpc: '2.0', id: 1, method: 'eth_call',
            params: [{ to: c.to, data: c.data }, blockTag],
          });
          return resultOf(env);
        }),
      );
    }
    return out;
  };

  // Dispatched in waves rather than one Promise.all so the deadline can be
  // honoured between waves. Wave width matches evmRpc's global semaphore, which
  // is what actually bounds in-flight requests — a wider wave would only queue.
  for (let w = 0; w < chunks.length; w += WAVE_WIDTH) {
    if (expired()) break;
    const wave = chunks.slice(w, w + WAVE_WIDTH);
    const done = await Promise.all(wave.map(runChunk));
    done.forEach((vals, k) => {
      const base = (w + k) * chunkSize;
      vals.forEach((v, i) => { results[base + i] = v; });
    });
  }

  // ── Retry passes ──────────────────────────────────────────────────────────
  // A null here is usually a per-REQUEST throughput limit — the provider errors
  // SOME entries of an otherwise valid batch while returning HTTP 200, so
  // evmRpc's HTTP-level 403/429 backoff never sees it. Measured on the Uniswap
  // V3 Staker (470 Polygon positions) against the free Alchemy tier: 64 of 470
  // tokenId reads failed on the first pass.
  //
  // This is the same lesson as the Sprint 3-FREE Solana scan: on a free tier a
  // burst DROPS work, and backoff-to-100% is the requirement, not speed. So the
  // failed subset is retried in progressively smaller batches with a growing
  // delay, up to RETRY_DELAYS_MS.length passes. Anything still null afterwards
  // is a real failure and the caller DISCLOSES it (queue item C) rather than
  // reporting the position as absent.
  for (let pass = 0; pass < RETRY_DELAYS_MS.length; pass++) {
    const failedIdx = results.map((r, i) => (r === null ? i : -1)).filter((i) => i >= 0);
    // All-null means the endpoint itself is down, not a throughput limit —
    // grinding through more passes would only delay the caller's disclosure.
    if (failedIdx.length === 0 || failedIdx.length === calls.length) break;
    if (expired()) break;

    await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[pass]));
    if (expired()) break;
    const size = RETRY_CHUNK_SIZES[Math.min(pass, RETRY_CHUNK_SIZES.length - 1)];
    const retryChunks: number[][] = [];
    for (let i = 0; i < failedIdx.length; i += size) retryChunks.push(failedIdx.slice(i, i + size));

    const retried = await Promise.all(
      retryChunks.map(async (idxs) => {
        const envs = await evmRpcBatch(
          rpc,
          idxs.map((i) => ({ method: 'eth_call', params: [{ to: calls[i].to, data: calls[i].data }, blockTag] })),
        );
        return envs.map(resultOf);
      }),
    );
    retryChunks.forEach((idxs, c) => {
      idxs.forEach((callIdx, k) => {
        const v = retried[c][k];
        if (v !== null) results[callIdx] = v;
      });
    });
  }

  return results;
}
