// Sprint SPOT-RESILIENCE-V2 — shared EVM JSON-RPC transport with a per-call
// timeout and a global concurrency semaphore. The direct EVM analogue of
// app/lib/suiRpc.ts (Sprint SUI-RPC-RELIABILITY `8d82287`).
//
// WHY THIS EXISTS
// The EVM activity routes issued their `eth_getLogs` via a bare
// `fetch(rpc, …).json()` with NO timeout. When the primary endpoint HANGS —
// measured live: Tenderly served one full-range Base `eth_getLogs` in 14 s then
// timed out (>20 s) on the next two under repeat concurrent load — the route
// blocks until the client's 150 s abort fires, which surfaces to the user as
// "Failed to load — RPC timeout after 3 attempts" and DROPS the position from
// the LP P&L totals. (The other Base endpoints have rotted: LlamaRPC returns 521,
// publicnode 403-paywalls archive getLogs, and Alchemy free tier caps getLogs at
// a 10-block range — so Tenderly is the sole healthy endpoint, and chunked
// Tenderly calls are fast, 0.3–0.7 s each.) This is a PURE TRANSPORT helper:
// identical requests, identical results; it only changes HOW the call is made
// (timed-out + paced), never WHAT is returned.
//
// TWO LEVERS
//   1. TIMEOUT — a per-call AbortController (default 12 s) so a hung call fails
//      FAST into the caller's fallback (chunked scan) instead of hanging until
//      the client's 150 s abort. This is the root-cause fix for Bug A.
//   2. PACING — a global concurrency semaphore (mirrors suiRpc / withCgPacing)
//      so a full analytics load's EVM getLogs burst can't push the single healthy
//      endpoint into the hang state observed above.
//
// CONTRACT: `evmRpcPost(url, body)` resolves to the parsed JSON-RPC envelope
// (`{ result?, error? }`), exactly like the bare `fetch(...).json()` it replaces
// — successful calls are byte-identical. On timeout / network error it resolves
// to a synthetic `{ error: { code: -32000, message: 'evm-rpc-timeout' | … } }`
// so existing `res.error` handling treats it as a normal RPC error and falls
// through to the next tier, never throwing.

// Global concurrency cap across ALL EVM getLogs calls in this process. 6 keeps a
// single analytics load (per-position + wallet-scope ever-owned scans) — and
// Fluid-reused concurrent invocations sharing the process — off the endpoint's
// hang threshold while staying well above the serial floor.
const MAX_CONCURRENT_EVM = 6;
const DEFAULT_TIMEOUT_MS = 12_000;

// ── Concurrency semaphore (race-free; slot handed directly to the next waiter) ─
let inUse = 0;
const waiters: Array<() => void> = [];
async function acquire<T>(fn: () => Promise<T>): Promise<T> {
  if (inUse < MAX_CONCURRENT_EVM) {
    inUse += 1;
  } else {
    await new Promise<void>((resolve) => waiters.push(resolve));
    // Slot inherited without decrement — count stays the same.
  }
  try {
    return await fn();
  } finally {
    const next = waiters.shift();
    if (next) next();
    else inUse -= 1;
  }
}

export interface EvmRpcEnvelope {
  result?: unknown;
  error?: { code?: number; message: string };
  [k: string]: unknown;
}

export interface EvmRpcOptions { timeoutMs?: number }

/**
 * Paced + per-call-timed EVM JSON-RPC POST. Drop-in for `fetch(url,…).json()`:
 * returns the JSON-RPC envelope on success; on timeout / network error returns a
 * synthetic `{ error }` (never throws), so callers' existing `res.error` branch
 * transparently fails over to the next endpoint / tier.
 */
export async function evmRpcPost(url: string, body: object, opts: EvmRpcOptions = {}): Promise<EvmRpcEnvelope> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return acquire(() => postWithRetry(url, body, timeoutMs)) as Promise<EvmRpcEnvelope>;
}

/**
 * JSON-RPC BATCH (queue item C Phase 2a). Sends N calls as ONE array-bodied
 * HTTP request and returns their envelopes IN THE ORDER GIVEN.
 *
 * Why this exists: removing the position-scan caps means enumerating every
 * tokenId a wallet holds, and the routes did that with one sequential
 * `await` per index — 300 positions was 300 serial round trips, which is
 * exactly the "one giant blocking call" shape a cap was papering over.
 * Batching collapses each chunk into a single request while the SAME global
 * semaphore, timeout and 403/429 backoff as `evmRpcPost` still apply, so an
 * uncapped scan cannot burst an endpoint into its throttle state.
 *
 * Responses are correlated BY ID, never by array position: the JSON-RPC spec
 * explicitly permits a server to return batch results out of order, and
 * matching by index would silently attribute one position's data to another —
 * the same class of defect as the wallet-scope decimals bug (`78e80db`).
 *
 * A server that does not support batching (non-array body, HTTP error) yields
 * one synthetic error envelope PER CALL, so callers fall back to individual
 * `evmRpcPost`s instead of mistaking "no batch support" for "no positions".
 */
export async function evmRpcBatch(
  url: string,
  calls: Array<{ method: string; params: unknown[] }>,
  opts: EvmRpcOptions = {},
): Promise<EvmRpcEnvelope[]> {
  if (calls.length === 0) return [];
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const body = calls.map((c, i) => ({ jsonrpc: '2.0', id: i + 1, method: c.method, params: c.params }));
  const raw = await acquire(() => postWithRetry(url, body, timeoutMs));
  const fail = (message: string): EvmRpcEnvelope[] =>
    calls.map(() => ({ error: { code: -32000, message } }));

  if (!Array.isArray(raw)) {
    // Either an error envelope from the transport, or a server that answered a
    // batch with a single object — both mean "this batch produced nothing
    // usable", never "these calls returned empty".
    const msg = (raw as EvmRpcEnvelope)?.error?.message ?? 'evm-rpc-batch-unsupported';
    return fail(msg);
  }
  const byId = new Map<number, EvmRpcEnvelope>();
  for (const item of raw as EvmRpcEnvelope[]) {
    const id = typeof item?.id === 'number' ? item.id : null;
    if (id != null) byId.set(id, item);
  }
  return calls.map((_, i) => byId.get(i + 1) ?? { error: { code: -32000, message: 'evm-rpc-batch-missing-id' } });
}

// Shared POST body for evmRpcPost and evmRpcBatch. Called INSIDE a semaphore
// slot by both, so the 403/429 backoff below stays serial by construction.
async function postWithRetry(url: string, body: object, timeoutMs: number): Promise<EvmRpcEnvelope | EvmRpcEnvelope[]> {
    // Throttle backoff (2026-07-18 Krishna/RAKA investigation): the public
    // Tenderly gateway hard-throttles CONCURRENT getLogs per IP (403 from
    // Vercel's shared IP, 429/drops elsewhere) but serves serial calls
    // instantly and recovers immediately. So an HTTP 403/429 is retried here
    // (up to 2 backoffs) INSIDE the semaphore slot — the retry is serial by
    // construction, which is exactly the traffic shape the gateway accepts.
    // All other failures keep the original single-attempt fail-fast contract.
    const delays = [1_500, 4_000];
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let out: EvmRpcEnvelope | EvmRpcEnvelope[];
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!res.ok) {
          // HTTP-level failure (429 / 5xx / 4xx) — surface as an RPC-shaped error so
          // the caller fails over instead of trying to parse a non-JSON body.
          out = { error: { code: -32000, message: `evm-rpc-http-${res.status}` } };
        } else {
          out = (await res.json()) as EvmRpcEnvelope | EvmRpcEnvelope[];
        }
      } catch (err) {
        const isAbort = err instanceof Error && err.name === 'AbortError';
        out = { error: { code: -32000, message: isAbort ? 'evm-rpc-timeout' : 'evm-rpc-network-error' } };
      } finally {
        clearTimeout(timer);
      }
      const msg = Array.isArray(out) ? '' : (out.error?.message ?? '');
      const throttled = msg === 'evm-rpc-http-403' || msg === 'evm-rpc-http-429';
      if (!throttled || attempt >= delays.length) return out;
      const jitter = Math.floor(Math.random() * 500);
      await new Promise((r) => setTimeout(r, delays[attempt] + jitter));
    }
}

// True when an evmRpcPost error message is an HTTP-level throttle (per-IP rate
// limit) — transient by nature; callers should fall through to another tier
// rather than treating it as a terminal route failure.
export function isEvmRpcThrottle(message: string | undefined): boolean {
  return message === 'evm-rpc-http-403' || message === 'evm-rpc-http-429';
}

// Exposed for diagnostics / tests.
export function _evmConcurrencyCap(): number { return MAX_CONCURRENT_EVM; }
