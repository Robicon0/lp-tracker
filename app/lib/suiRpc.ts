import { rpcUrlFromEnv } from './rpcEnv';
import { isAlchemyThrottledError } from './alchemyLimiter';
import { SUI_GQL_METHODS, suiGqlAsRpc } from './suiGraphql';

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

interface EndpointOutcome { ok: boolean; status: number; result?: unknown; rpcError?: boolean; timedOut?: boolean; throttledOut?: boolean }

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
  } catch (err) {
    // The Alchemy limiter retried its 429s before throwing; another round of
    // retries here would only multiply them.
    if (isAlchemyThrottledError(err)) return { ok: false, status: 429, throttledOut: true };
    // AbortError (timeout) or network error — both retryable via the next endpoint.
    return { ok: false, status: 0, timedOut: controller.signal.aborted };
  } finally {
    clearTimeout(timer);
  }
}

const RETRY_PAUSES_MS = [350, 1000, 2500];
let retries = 0, recovered = 0, exhausted = 0;
/** Process-wide retry counts (diagnostics): rounds retried, calls a retry saved, calls that failed anyway. */
export function suiRpcRetryStats() { return { retries, recovered, exhausted }; }

export interface SuiRpcOptions { timeoutMs?: number }

/**
 * Shared Sui JSON-RPC call: paced (global semaphore), timed-out per attempt, and
 * automatically failed over across the ordered endpoint list. Returns the
 * JSON-RPC `.result` on success, or `undefined` if every endpoint failed
 * (same shape the old bare helper produced on a bad response).
 */
export async function suiRpc(method: string, params: unknown[], opts: SuiRpcOptions = {}): Promise<unknown> {
  // 2026-10-23: Sui switched JSON-RPC off (Alchemy and the public fullnodes).
  // The six live-state methods are answered from Sui GraphQL in the same shapes
  // (app/lib/suiGraphql.ts, its own limiter, timeouts and backoff). A read that
  // cannot be answered is `undefined`, as before.
  if (SUI_GQL_METHODS.has(method)) {
    try {
      return await suiGqlAsRpc(method, params);
    } catch (err) {
      exhausted += 1;
      console.error(`[suiRpc] ${method} failed over GraphQL:`, err instanceof Error ? err.message : err);
      return undefined;
    }
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return acquire(async () => {
    // Sprint 2b — retry with backoff. Before this, ONE throttled or timed-out
    // call ended the read: the fallback (the public fullnode) no longer serves
    // JSON-RPC ("Method not found … deprecated", measured 2026-10-07 and again
    // 2026-10-11), so in practice there is a single endpoint and a single
    // attempt. A brief 429 from it surfaced as a failed pool read, a 503 from a
    // position route, or ten Momentum claims left unpriced. Rounds are spaced
    // 0.35 s, 1 s and 2.5 s apart; only transport failures are retried.
    let gaveUpOnTimeout = false;
    for (let round = 0; round <= RETRY_PAUSES_MS.length; round++) {
      if (round > 0) { if (gaveUpOnTimeout) break; retries += 1; await sleep(RETRY_PAUSES_MS[round - 1]); }
      for (let i = 0; i < SUI_ENDPOINTS.length; i++) {
        const url = SUI_ENDPOINTS[i];
        const outcome = await callEndpoint(url, method, params, timeoutMs);
        if (outcome.ok) { if (round > 0) recovered += 1; return outcome.result; }
        // A genuine RPC-level error from the PRIMARY (bad params, etc.) is
        // deterministic — retrying would only waste the budget. The same answer
        // from a fallback only says that endpoint cannot serve the method.
        if (outcome.rpcError && i === 0) return undefined;
        // A TIMEOUT on the primary already cost the full per-call budget (12 s).
        // It is not retried: under a real outage every call would otherwise take
        // several times as long and a route would hang instead of failing fast
        // (the pre-retry behaviour, kept exactly). Only fast failures — 429, 5xx,
        // a refused connection — get the backoff rounds.
        if (outcome.timedOut && i === 0) gaveUpOnTimeout = true;
        if (outcome.throttledOut && i === 0) gaveUpOnTimeout = true;
        // Back off briefly on a rate-limit before hitting the fallback.
        if (outcome.status === 429 && i < SUI_ENDPOINTS.length - 1) await sleep(150);
      }
    }
    exhausted += 1;
    return undefined; // every endpoint failed on every round
  });
}

/**
 * INDEX-DEPENDENT Sui query (e.g. suix_queryTransactionBlocks with an object
 * filter like ChangedObject / InputObject). These filters are NOT served by
 * every endpoint: the public fullnode returns a silent `200 { data: [] }` for
 * object filters it doesn't index (verified live 2026-07-18 — a position with 5
 * on-chain txs returned 0), so an ordinary failover would convert "index
 * unavailable" into an authoritative-looking "no results". This variant runs
 * against the PRIMARY endpoint ONLY (SUI_RPC_URL / Alchemy) and THROWS
 * `SuiIndexUnavailableError` when the primary is unset or unreachable — the
 * caller must treat that as "I don't know", never as "nothing found".
 * Same pacing semaphore and per-call timeout as suiRpc.
 */
export class SuiIndexUnavailableError extends Error {
  constructor(reason: string) { super(`sui-index-unavailable: ${reason}`); this.name = 'SuiIndexUnavailableError'; }
}

export async function suiRpcIndexed(method: string, params: unknown[], opts: SuiRpcOptions = {}): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const primary = SUI_ENDPOINTS[0];
  // If SUI_RPC_URL is unset/malformed the only endpoint is the public fullnode,
  // which does not serve object-filter indexes — that's unavailability, not data.
  if (!primary || primary === PUBLIC_FULLNODE) {
    throw new SuiIndexUnavailableError('no indexed primary endpoint configured (SUI_RPC_URL)');
  }
  return acquire(async () => {
    // One retry on transport failure (429/5xx/timeout), then give up LOUDLY —
    // never silently fall to an endpoint that would answer [] for everything.
    for (let attempt = 0; attempt < 2; attempt++) {
      const outcome = await callEndpoint(primary, method, params, timeoutMs);
      if (outcome.ok) return outcome.result;
      if (outcome.rpcError) throw new SuiIndexUnavailableError('primary returned RPC error');
      if (outcome.throttledOut) throw new SuiIndexUnavailableError('primary throttled (429)');
      if (attempt === 0) await sleep(outcome.status === 429 ? 500 : 150);
    }
    throw new SuiIndexUnavailableError('primary endpoint unreachable');
  });
}

// Exposed for diagnostics / tests (never a per-token branch).
export function _suiEndpointCount(): number { return SUI_ENDPOINTS.length; }

/**
 * A Sui read that did not answer (every endpoint, every round). Callers that
 * must not turn a failed read into "owns nothing" (Methodology rule (e)) throw
 * this and let it reach the route, which answers 503 `sui-unavailable`.
 * Per-item catch blocks rethrow it instead of skipping the item.
 */
export class SuiReadError extends Error {
  constructor(method: string) { super(`Sui RPC failed (all endpoints) for ${method}`); this.name = 'SuiReadError'; }
}
export function isSuiReadError(err: unknown): err is SuiReadError {
  return err instanceof SuiReadError || (err instanceof Error && err.name === 'SuiReadError');
}
/** `suiRpc` that throws `SuiReadError` instead of answering `undefined`. */
export async function suiRpcOrThrow(method: string, params: unknown[], opts: SuiRpcOptions = {}): Promise<unknown> {
  const result = await suiRpc(method, params, opts);
  if (result === undefined) throw new SuiReadError(method);
  return result;
}
