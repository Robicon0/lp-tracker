// One request limiter for EVERY server-side Alchemy call (EVM, Solana, Sui JSON-RPC
// and the transfer index), plus 429 handling.
//
// WHY THIS EXISTS
// The free Alchemy plan gives the whole ACCOUNT one throughput limit (500 CU/s on
// this account's dashboard; "measured over a rolling 10-second window using a
// token bucket", and "the combined usage of all your Alchemy apps counts toward
// your overall throughput limit" — Alchemy throughput docs). Local runs, tests,
// preview and production share it. Peaks of 558/500 (7 days) and 489/500 (24 h)
// were seen, and each 429 surfaced somewhere as a failed read: one 429 in a
// contract wallet's Base history scan marked all 66 of its positions unverified.
// About twenty call sites reach Alchemy, half of them through a bare `fetch`, so
// a limiter in each would drift. Instead this module wraps `globalThis.fetch`
// once (from `instrumentation.ts`) and acts only on requests to `*.alchemy.com`.
// Every other request passes through untouched.
//
// WHAT IT DOES, per server instance (no shared store; see below)
//   1. A token bucket in COMPUTE UNITS, priced from the JSON-RPC method(s) in the
//      request body with Alchemy's published per-method costs (a batch costs the
//      sum of its calls). Default 200 CU/s with a 5-second burst (1,000 CU).
//   2. A cap on requests in flight (default 16).
//   3. On HTTP 429: every request on this instance pauses for Retry-After (or
//      about a second), the instance's rate halves (at most once a second, never
//      below 80 CU/s) and climbs back by 5% of the configured rate per second
//      without a 429. This is how several instances settle under the one
//      account limit without talking to each other: each one that is told
//      "too many" slows down.
//   4. Retries a 429 with exponential backoff and jitter (0.5 s, 1 s, 2 s, 4 s,
//      plus up to 1 s; capped at 8 s), honouring `Retry-After` when it asks for
//      longer, at most MAX_ATTEMPTS sends in all. Then it THROWS
//      `AlchemyThrottledError`. It never returns an empty or made-up answer:
//      callers already treat a thrown fetch as a failed read, which reaches the
//      page as a notice or a named failed source (Methodology rule (e)).
//
// WHY NO SHARED LIMITER. A shared counter in the Upstash store costs at least one
// command per Alchemy request (INCRBY, plus an EXPIRE on a new window). One
// Account 1 dashboard load makes about 180-190 Alchemy requests, so a single load
// would spend about 190-380 store commands, the same order as every other store
// read of the load together. The stub test (scripts/alchemy-limiter-test.ts) shows the
// per-instance bucket plus the 429 slow-down keeps 20 simulated concurrent
// wallets on 4 instances under the limit, so the shared counter is not built.
//
// Settings (env, all optional): ALCHEMY_INSTANCE_CU_PER_SEC (200),
// ALCHEMY_MAX_IN_FLIGHT (16), ALCHEMY_LIMITER=off (pass-through, for a
// before/after measurement only).

// Alchemy's published compute-unit costs (docs "Compute Unit Costs", read
// 2026-10-15). A method not listed costs DEFAULT_CU, which is the eth_call price:
// a guess on the high side keeps the bucket conservative.
const CU_COST: Record<string, number> = {
  eth_call: 26, eth_getLogs: 60, eth_blockNumber: 10, eth_getBlockByNumber: 20,
  eth_getTransactionReceipt: 20, eth_getTransactionCount: 20, eth_getCode: 20,
  eth_chainId: 0, eth_getBalance: 20, alchemy_getAssetTransfers: 120,
  alchemy_getTokenMetadata: 10, alchemy_getTokenBalances: 20,
  getTransaction: 40, getSignaturesForAddress: 40, getAccountInfo: 10,
  getMultipleAccounts: 20, getTokenAccountsByOwner: 10, getProgramAccounts: 20,
  suix_getOwnedObjects: 20, sui_multiGetObjects: 20, sui_getObject: 20,
  suix_getDynamicFieldObject: 20, suix_getCoinMetadata: 20,
  suix_queryTransactionBlocks: 20, suix_getAllBalances: 20,
};
const DEFAULT_CU = 26;

const envNum = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

export const LIMITER_DEFAULTS = {
  ratePerSec: 200,
  burstSeconds: 5,
  minRatePerSec: 80,
  recoverPerSecFraction: 0.05,
  maxInFlight: 16,
  maxAttempts: 5,
  backoffBaseMs: 500,
  backoffCapMs: 8_000,
  jitterMs: 1_000,
} as const;

export class AlchemyThrottledError extends Error {
  constructor(public network: string, public attempts: number) {
    super(`alchemy-throttled: ${network} answered 429 on ${attempts} attempts`);
    this.name = 'AlchemyThrottledError';
  }
}

export function isAlchemyThrottledError(err: unknown): err is AlchemyThrottledError {
  return err instanceof Error && err.name === 'AlchemyThrottledError';
}

export function isAlchemyUrl(url: string): boolean {
  try { return new URL(url).hostname.endsWith('.alchemy.com'); } catch { return false; }
}

/** The CU a JSON-RPC body costs: one method, or the sum over a batch. */
export function alchemyCuOf(body: unknown): number {
  let parsed: unknown = body;
  if (typeof body === 'string') {
    try { parsed = JSON.parse(body); } catch { return DEFAULT_CU; }
  }
  const calls = Array.isArray(parsed) ? parsed : [parsed];
  let cu = 0;
  for (const c of calls) {
    const m = (c as { method?: unknown } | null)?.method;
    cu += typeof m === 'string' ? (CU_COST[m] ?? DEFAULT_CU) : DEFAULT_CU;
  }
  return cu;
}

/** Retry-After in ms (seconds or an HTTP date), or 0 when absent / unreadable. */
function retryAfterMs(header: string | null): number {
  if (!header) return 0;
  const s = Number(header);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0;
}

type Fetch = typeof fetch;

export interface LimiterOptions {
  ratePerSec?: number;
  maxInFlight?: number;
  maxAttempts?: number;
  /** For tests: replace the clock, setTimeout-based sleeping and Math.random. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface LimiterStats {
  requests: number; cuSent: number; throttled: number; retried: number;
  gaveUp: number; waitedMs: number; currentRate: number;
}

/**
 * The limiter itself, independent of the global install so a test can run
 * several instances (one per simulated server instance) in one process.
 */
export function createAlchemyLimiter(baseFetch: Fetch, opts: LimiterOptions = {}) {
  const maxRate = opts.ratePerSec ?? envNum('ALCHEMY_INSTANCE_CU_PER_SEC', LIMITER_DEFAULTS.ratePerSec);
  const maxInFlight = opts.maxInFlight ?? envNum('ALCHEMY_MAX_IN_FLIGHT', LIMITER_DEFAULTS.maxInFlight);
  const maxAttempts = opts.maxAttempts ?? LIMITER_DEFAULTS.maxAttempts;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;
  const now = opts.now ?? Date.now;

  let rate = maxRate;
  let tokens = maxRate * LIMITER_DEFAULTS.burstSeconds;
  let last = now();
  let pausedUntil = 0;
  let last429 = 0;
  let inFlight = 0;
  const slotWaiters: Array<() => void> = [];
  let gate: Promise<void> = Promise.resolve();
  const stats: LimiterStats = { requests: 0, cuSent: 0, throttled: 0, retried: 0, gaveUp: 0, waitedMs: 0, currentRate: rate };

  const refill = () => {
    const t = now();
    const dt = (t - last) / 1000;
    last = t;
    if (rate < maxRate && t - last429 > 1000) {
      rate = Math.min(maxRate, rate + maxRate * LIMITER_DEFAULTS.recoverPerSecFraction * dt);
    }
    tokens = Math.min(rate * LIMITER_DEFAULTS.burstSeconds, tokens + rate * dt);
    stats.currentRate = Math.round(rate);
  };

  const abortError = () => new DOMException('The operation was aborted.', 'AbortError');

  // Takes `cu` tokens, in arrival order. A request bigger than the burst waits
  // for a full bucket and then goes into debt, so a 20-transaction batch is
  // never starved and still pays its full cost.
  const takeTokens = (cu: number, signal?: AbortSignal | null): Promise<void> => {
    const turn = gate.then(async () => {
      const t0 = now();
      for (;;) {
        if (signal?.aborted) throw abortError();
        refill();
        const t = now();
        if (t < pausedUntil) { await sleep(pausedUntil - t); continue; }
        const need = Math.min(cu, rate * LIMITER_DEFAULTS.burstSeconds);
        if (tokens >= need) { tokens -= cu; break; }
        await sleep(Math.max(10, Math.ceil(((need - tokens) / rate) * 1000)));
      }
      stats.waitedMs += now() - t0;
    });
    gate = turn.catch(() => {}); // an aborted waiter must not block the queue
    return turn;
  };

  const takeSlot = async (): Promise<void> => {
    if (inFlight < maxInFlight) { inFlight += 1; return; }
    await new Promise<void>((r) => slotWaiters.push(r)); // slot handed over, count unchanged
  };
  const releaseSlot = () => {
    const next = slotWaiters.shift();
    if (next) next(); else inFlight -= 1;
  };

  const backoffMs = (attempt: number, header: string | null): number => {
    const exp = Math.min(LIMITER_DEFAULTS.backoffCapMs, LIMITER_DEFAULTS.backoffBaseMs * 2 ** attempt);
    return Math.max(retryAfterMs(header), exp + Math.floor(random() * LIMITER_DEFAULTS.jitterMs));
  };

  async function limitedFetch(input: Parameters<Fetch>[0], init?: Parameters<Fetch>[1]): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let network = 'alchemy';
    try { network = new URL(url).hostname.split('.')[0]; } catch { /* keep the default */ }
    const cu = alchemyCuOf(init?.body ?? null);
    for (let attempt = 0; ; attempt++) {
      await takeTokens(cu, init?.signal);
      await takeSlot();
      let res: Response;
      try {
        stats.requests += 1;
        stats.cuSent += cu;
        res = await baseFetch(input, init);
      } finally {
        releaseSlot();
      }
      if (res.status !== 429) return res;

      stats.throttled += 1;
      const retryAfter = retryAfterMs(res.headers.get('retry-after'));
      const wait = backoffMs(attempt, res.headers.get('retry-after'));
      try { await res.body?.cancel(); } catch { /* nothing to drain */ }
      // Slow the whole instance down, once per second at most: several requests
      // answered 429 together are one signal, not several (halving per 429 drove
      // the rate to its floor and queued requests into their callers' timeouts).
      const t = now();
      if (t - last429 >= 1000) {
        rate = Math.max(LIMITER_DEFAULTS.minRatePerSec, rate * 0.5);
        tokens = Math.min(tokens, 0);
      }
      last429 = t;
      // Every request on the instance waits Retry-After (or about a second);
      // the request that was refused also waits its own exponential backoff.
      pausedUntil = Math.max(pausedUntil, t + Math.max(retryAfter, LIMITER_DEFAULTS.backoffBaseMs + Math.floor(random() * LIMITER_DEFAULTS.jitterMs / 2)));
      if (attempt + 1 >= maxAttempts) {
        stats.gaveUp += 1;
        console.warn(`[alchemyLimiter] 429 ${network} gave up after ${attempt + 1} attempts (instance rate now ${Math.round(rate)} CU/s)`);
        throw new AlchemyThrottledError(network, attempt + 1);
      }
      stats.retried += 1;
      console.warn(`[alchemyLimiter] 429 ${network} attempt ${attempt + 1}, retry in ${wait} ms (instance rate now ${Math.round(rate)} CU/s)`);
      await sleep(wait);
    }
  }

  return { fetch: limitedFetch, stats: () => ({ ...stats }) };
}

// ── Global install ─────────────────────────────────────────────────────────────
type Installed = { stats: () => LimiterStats };
const KEY = '__defideshAlchemyLimiter';

/**
 * Wraps `globalThis.fetch` so every request to `*.alchemy.com` goes through the
 * limiter. Idempotent. Called once per server process from `instrumentation.ts`.
 */
export function installAlchemyLimiter(): void {
  const g = globalThis as unknown as Record<string, unknown> & { fetch: Fetch };
  if (g[KEY]) return;
  if (process.env.ALCHEMY_LIMITER === 'off') { g[KEY] = { stats: () => null }; return; }
  const base: Fetch = g.fetch.bind(globalThis);
  const limiter = createAlchemyLimiter(base);
  const wrapped = (input: Parameters<Fetch>[0], init?: Parameters<Fetch>[1]): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return isAlchemyUrl(url) ? limiter.fetch(input, init) : base(input, init);
  };
  g.fetch = wrapped as Fetch;
  g[KEY] = { stats: limiter.stats } satisfies Installed;
}

/** This process's limiter counters, or null when it is not installed. */
export function alchemyLimiterStats(): LimiterStats | null {
  const inst = (globalThis as unknown as Record<string, Installed | undefined>)[KEY];
  return inst ? inst.stats() : null;
}
