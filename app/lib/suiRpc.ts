import { rpcUrlFromEnv } from './rpcEnv';

// Sprint SUI-RPC-RELIABILITY — shared Sui JSON-RPC client with automatic
// endpoint failover, per-call timeout, and a global concurrency semaphore.
//
// WHY THIS EXISTS
// Every Sui route/lib previously defined its own bare `suiRpc = fetch(SUI_RPC …)`
// helper with NO timeout, NO retry, and NO fallback endpoint. A full analytics
// load fires a large UNPACED concurrent Sui burst (Cetus + Bluefin + Momentum
// dashboard + per-position activity, each paginating getOwnedObjects + multiGet,
// plus per-pool getObject, plus balances/lending — × up to 3 wallets = 100+
// simultaneous calls). Measured (Phase A): the public fullnode 429s at ~80
// concurrent (17% dropped) and collapses at 150 (55%); Alchemy holds ~3× more but
// 429s at ~450. With no timeout/failover/pacing, a single 429 or slow call dropped
// the position from the LP P&L totals ("Failed to load — RPC timeout"). This is a
// PURE TRANSPORT fix — identical requests, identical results; it only changes HOW
// the call is made (paced + failed-over), never WHAT is returned.
//
// THREE LEVERS
//   1. FAILOVER — ordered endpoints (SUI_RPC_URL / Alchemy primary → public
//      fullnode fallback). A timeout / 429 / 5xx / network error on one endpoint
//      transparently retries the NEXT before giving up. A call fails only if ALL
//      endpoints are simultaneously unavailable (rare).
//   2. TIMEOUT — a per-call AbortController (default 12 s) so a hung call fails
//      FAST into the fallback instead of hanging until the client's 150 s abort.
//   3. PACING — a global concurrency semaphore (mirrors the CoinGecko withCgPacing
//      queue) so the in-process Sui burst can never exceed the rate limit. Both
//      endpoints were clean at ≤40 concurrent; failures began at 80.
//
// CONTRACT: `suiRpc(method, params)` returns the JSON-RPC `.result` (any), exactly
// like the bare helpers it replaces — successful calls are byte-identical. On
// total failure across all endpoints it returns `undefined` (same shape the old
// helper produced on a bad response), so existing callers' null/undefined guards
// are unchanged; the failover simply makes total failure far rarer.

const PUBLIC_FULLNODE = 'https://fullnode.mainnet.sui.io:443';

// Ordered endpoint list: primary first. SUI_RPC_URL (Alchemy in prod) leads; the
// public fullnode is the automatic fallback. De-duplicated so we never retry the
// same URL twice (e.g. if SUI_RPC_URL is unset or is itself the public node).
const SUI_ENDPOINTS: string[] = (() => {
  // rpcUrlFromEnv: a malformed SUI_RPC_URL (e.g. bare API key) is treated as
  // unset, so the public fullnode fallback carries the load instead of every
  // primary attempt throwing on URL parse.
  const list = [rpcUrlFromEnv('SUI_RPC_URL'), PUBLIC_FULLNODE].filter((u): u is string => !!u);
  return [...new Set(list)];
})();

// Global concurrency cap across ALL Sui calls in this process. 8 keeps a single
// route invocation (which can make dozens of Sui calls) — and Fluid-reused
// concurrent invocations sharing the process — comfortably under the per-IP rate
// limit that starts biting at ~80 simultaneous.
const MAX_CONCURRENT_SUI = 8;
const DEFAULT_TIMEOUT_MS = 12_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── Concurrency semaphore (race-free; slot handed directly to the next waiter) ─
let inUse = 0;
const waiters: Array<() => void> = [];
async function acquire<T>(fn: () => Promise<T>): Promise<T> {
  if (inUse < MAX_CONCURRENT_SUI) {
    inUse += 1;
  } else {
    await new Promise<void>((resolve) => waiters.push(resolve));
    // Slot inherited without decrement — count stays the same.
  }
  try {
    return await fn();
  } finally {
    const next = waiters.shift();
    if (next) next(); // hand our slot straight to the next waiter (count unchanged)
    else inUse -= 1;
  }
}

interface EndpointOutcome { ok: boolean; status: number; result?: unknown; rpcError?: boolean }

async function callEndpoint(url: string, method: string, params: unknown[], timeoutMs: number): Promise<EndpointOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: controller.signal,
    });
    if (res.status === 429 || res.status >= 500) {
      return { ok: false, status: res.status };
    }
    if (!res.ok) return { ok: false, status: res.status };
    const json = (await res.json()) as { result?: unknown; error?: unknown };
    if (json.error) return { ok: false, status: 200, rpcError: true };
    return { ok: true, status: 200, result: json.result };
  } catch {
    // AbortError (timeout) or network error — both retryable via the next endpoint.
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

export interface SuiRpcOptions { timeoutMs?: number }

/**
 * Shared Sui JSON-RPC call: paced (global semaphore), timed-out per attempt, and
 * automatically failed over across the ordered endpoint list. Returns the
 * JSON-RPC `.result` on success, or `undefined` if every endpoint failed
 * (same shape the old bare helper produced on a bad response).
 */
export async function suiRpc(method: string, params: unknown[], opts: SuiRpcOptions = {}): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return acquire(async () => {
    for (let i = 0; i < SUI_ENDPOINTS.length; i++) {
      const url = SUI_ENDPOINTS[i];
      const outcome = await callEndpoint(url, method, params, timeoutMs);
      if (outcome.ok) return outcome.result;
      // A genuine RPC-level error (bad params, etc.) is deterministic — failing
      // over won't help and would just waste the fallback's budget. Only retry
      // the next endpoint for transport failures (429 / 5xx / timeout / network).
      if (outcome.rpcError) return undefined;
      // Back off briefly on a rate-limit before hitting the fallback.
      if (outcome.status === 429 && i < SUI_ENDPOINTS.length - 1) await sleep(150);
    }
    return undefined; // all endpoints exhausted
  });
}

// Exposed for diagnostics / tests (never a per-token branch).
export function _suiEndpointCount(): number { return SUI_ENDPOINTS.length; }
