/**
 * Sugar position paging (queue item C, Phase 3).
 *
 * Aerodrome and Velodrome both enumerate a wallet's positions through a
 * Vyper "Sugar" helper contract, and DefiDesh called it exactly once with
 * `_limit = 100, _offset = 0`. Everything past the 100th ITERATION was
 * invisible — no error, no banner, and a `count` computed after truncation
 * confirmed the wrong number back to the user (architecture Rule 11 at the
 * enumeration layer).
 *
 * ── What the deployed contract actually does ─────────────────────────────
 * Read from the verified Vyper source of Aerodrome LP Sugar v3
 * (0x68c1…db0a on Base, vyper 0.3.10), `_positions`:
 *
 *   to_skip    = _offset
 *   pools_done = 0
 *   for each factory:
 *     # (a) unstaked CL positions
 *     for pindex in range(0, MAX_POSITIONS):        # MAX_POSITIONS = 200
 *       if pindex >= nfpm.balanceOf(acct) or pools_done >= _limit: break
 *       if to_skip > 0: to_skip -= 1; continue
 *       pools_done += 1
 *       ... tokenOfOwnerByIndex(acct, pindex) ...
 *     # (b) staked CL positions, by scanning the factory's pools
 *     for pindex in range(0, MAX_POOLS):            # MAX_POOLS = 2000
 *       if pindex >= factory.allPoolsLength() or pools_done >= _limit: break
 *       if to_skip > 0: to_skip -= 1; continue
 *       pools_done += 1
 *       ... voter.gauges(pool) -> gauge.stakedValues(acct) ...
 *
 * Three consequences, all load-bearing here:
 *
 *  1. `_offset` and `_limit` share ONE monotone cursor over a single flat
 *     iteration space — loop (a) then loop (b), concatenated per factory.
 *     `_offset` is NOT a pool index. Plain `offset += limit` paging is
 *     therefore CORRECT, and covers the space exactly once with no gaps and
 *     no duplicates. (Phase 1's comment claimed `_limit` counts positions
 *     while `_offset` indexes pools, and that offset paging would skip or
 *     duplicate. That reading was wrong; the source above is the evidence.)
 *
 *  2. The span of that iteration space is knowable UP FRONT, in two extra
 *     eth_calls: `min(balanceOf, 200) + min(allPoolsLength, 2000)`. Because
 *     every window is known before any of them is issued, and the windows are
 *     disjoint, they can all fire in PARALLEL.
 *
 *  3. Two of the contract's own bounds are hard ceilings that paging cannot
 *     lift, because they are `range()` bounds rather than cursor limits:
 *     loop (a) can never look past NFT index 199, and loop (b) can never look
 *     past pool index 1999. Those are reported, not worked around — see
 *     `sugarCeilingTruncations`.
 *
 * ── Page size and reverts ────────────────────────────────────────────────
 * The return type is `DynArray[Position, MAX_POSITIONS]` — at most 200
 * positions per CALL regardless of `_limit`. A window whose iterations yield
 * more than 200 positions reverts on append (and one pool's `stakedValues`
 * inner loop can append many positions from a single iteration). The revert
 * is therefore DATA-dependent, not a static limit ceiling: measured live,
 * `_limit` of 250 / 500 / 2200 all return fine for an ordinary wallet.
 *
 * So the page size is adaptive: start at 500, and on a revert retry the SAME
 * window as two halves, recursing down to a single iteration. A window that
 * still reverts at size 1 is genuinely unreachable through this contract
 * method (a single pool holding >200 staked positions for one account) and is
 * DISCLOSED rather than skipped in silence.
 *
 * ── Budget ───────────────────────────────────────────────────────────────
 * ITEM 0i: a positions source that hangs renders a confident $0.00. Paging is
 * bounded by both a call count and a wall clock, and a budget stop is
 * DISCLOSED through the same `truncated[]` channel as every other cap — never
 * returned as a clean partial.
 */

import type { RouteTruncation } from './enumerationTruncation';

/** `MAX_POSITIONS` in the Sugar source: the unstaked-NFT `range()` bound, the
 *  per-pool `stakedValues` loop bound, AND the return DynArray's capacity. */
export const SUGAR_MAX_POSITIONS = 200;
/** `MAX_POOLS` in the Sugar source: the staked-pool-scan `range()` bound. */
export const SUGAR_MAX_POOLS = 2000;
/** Iterations requested per call before any adaptive halving. */
export const SUGAR_PAGE_SIZE = 500;
/** Total eth_calls the paging sweep may spend, halving retries included. */
export const SUGAR_MAX_CALLS = 24;
/** Wall-clock budget for the paging sweep. */
export const SUGAR_BUDGET_MS = 20_000;
/** Windows in flight at once. */
export const SUGAR_CONCURRENCY = 6;
/** Calls ONE window may spend on halving before it is reported and abandoned. */
export const SUGAR_MAX_CALLS_PER_WINDOW = 8;

const SEL_ALL_POOLS_LENGTH = '0xefde4e64'; // allPoolsLength()
const SEL_BALANCE_OF = '0x70a08231';       // balanceOf(address)
const SEL_REGISTRY = '0x7b103999';         // registry()
const SEL_POOL_FACTORIES = '0x06121cd5';   // poolFactories()

function padAddress(a: string): string {
  return a.toLowerCase().replace('0x', '').padStart(64, '0');
}

/**
 * A CONTRACT REVERT and a TRANSPORT FAILURE demand opposite responses, and
 * conflating them was a real bug caught in verification: a rate-limited call
 * was read as a revert, which sent the sweep halving a window that was never
 * too big, burned the whole call budget on it, and then disclosed it to the
 * user as "one pool holds too many staked positions" — a confident, wrong
 * explanation for what was actually a 429.
 *
 * A revert means "this window is genuinely too big" -> halve it.
 * A transport failure means "ask again"                -> retry, then report.
 */
type CallOutcome =
  | { kind: 'ok'; result: string }
  | { kind: 'revert' }
  | { kind: 'transport' };

const REVERT_RE = /execution reverted|revert|invalid opcode|out of gas|stack underflow/i;

async function ethCall(rpc: string, to: string, data: string, attempts = 3): Promise<CallOutcome> {
  let last: CallOutcome = { kind: 'transport' };
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 250 * 2 ** (i - 1)));
    try {
      const res = await fetch(rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
      });
      const json = await res.json();
      if (json?.error) {
        const msg = String(json.error.message ?? '');
        // Only an EXECUTION failure is a revert. Rate limits (-32005), internal
        // errors (-32603) and timeouts are transport, and must be retried
        // rather than reinterpreted as "this window is too big".
        if (REVERT_RE.test(msg)) return { kind: 'revert' };
        last = { kind: 'transport' };
        continue;
      }
      if (typeof json?.result !== 'string') { last = { kind: 'transport' }; continue; }
      return { kind: 'ok', result: json.result };
    } catch {
      last = { kind: 'transport' };
    }
  }
  return last;
}

/* ── Span resolution ──────────────────────────────────────────────────── */

export interface SugarSpanSegment {
  /** The pool factory this segment's iterations belong to. */
  factory: string;
  /** Iterations loop (a) will spend: `min(balanceOf, 200)`, or 200 when the
   *  segment's unstaked count is unknown (deliberately erring HIGH). */
  unstakedIterations: number;
  /** Iterations loop (b) will spend: `min(allPoolsLength, 2000)`. */
  poolIterations: number;
  /** Exact `balanceOf` when this segment's NFT manager is known, else null. */
  balanceOf: number | null;
  /**
   * Whether that `balanceOf` is known to be the SAME NFT manager Sugar itself
   * walks for this factory.
   *
   * It is true only for the single-factory shape, where the caller names the
   * factory's own manager. In the registry shape Sugar resolves a manager per
   * factory through an internal `_fetch_nfpm` that is not readable from
   * outside, so a caller-supplied `balanceOf` may count NFTs from a manager
   * Sugar never touches — measured live on Optimism: a wallet holding 373
   * position NFTs is legitimately returned 0 positions by Sugar, and reporting
   * "showing 200 of 373" for it would be a confidently wrong notice.
   */
  balanceOfAuthoritative: boolean;
  /** Exact `allPoolsLength` when the probe succeeded, else null. */
  poolsLength: number | null;
}

export interface SugarSpan {
  /** Total iterations to cover — the sum over every segment. */
  span: number;
  segments: SugarSpanSegment[];
  /**
   * False when at least one probe failed and the span was assumed rather than
   * measured. The assumption always errs HIGH (an over-long span costs one
   * extra ~300 ms call that returns nothing; a short span silently drops
   * positions), so this is a quality signal, not an error.
   */
  complete: boolean;
}

async function readUint(rpc: string, to: string, data: string): Promise<number | null> {
  const r = await ethCall(rpc, to, data);
  if (r.kind !== 'ok' || r.result === '0x') return null;
  try {
    const v = BigInt(r.result);
    return v > 1_000_000_000n ? null : Number(v);
  } catch {
    return null;
  }
}

/**
 * Span for a SINGLE known factory — the `positionsByFactory` shape (Aerodrome).
 * `balanceOf` on the factory's NFT manager is exact ground truth for loop (a).
 */
export async function resolveSugarSpanForFactory(opts: {
  rpc: string;
  account: string;
  factory: string;
  nftManager: string;
}): Promise<SugarSpan> {
  const [balanceOf, poolsLength] = await Promise.all([
    readUint(opts.rpc, opts.nftManager, SEL_BALANCE_OF + padAddress(opts.account)),
    readUint(opts.rpc, opts.factory, SEL_ALL_POOLS_LENGTH),
  ]);

  const segment: SugarSpanSegment = {
    factory: opts.factory.toLowerCase(),
    unstakedIterations: Math.min(balanceOf ?? SUGAR_MAX_POSITIONS, SUGAR_MAX_POSITIONS),
    poolIterations: Math.min(poolsLength ?? SUGAR_MAX_POOLS, SUGAR_MAX_POOLS),
    balanceOf,
    balanceOfAuthoritative: true,
    poolsLength,
  };
  return {
    span: segment.unstakedIterations + segment.poolIterations,
    segments: [segment],
    complete: balanceOf != null && poolsLength != null,
  };
}

/**
 * Span for the REGISTRY shape — Sugar's `positions(limit, offset, account)`
 * walks every factory `registry.poolFactories()` returns (Velodrome).
 *
 * Which of those factories carry an NFT manager (and so run loop (a) at all)
 * is resolved inside the contract by an internal `_fetch_nfpm`, and is not
 * readable from outside. Rather than guess, every factory is charged the full
 * `MAX_POSITIONS` unstaked allowance: over-paging costs one empty ~250 ms call,
 * under-paging silently drops positions. Err HIGH.
 *
 * `nftManager` is still probed when the caller knows the CL one, purely so the
 * exact `balanceOf` is available for ceiling disclosure — it does not shorten
 * the span.
 */
export async function resolveSugarSpanForRegistry(opts: {
  rpc: string;
  account: string;
  sugar: string;
  nftManager?: string;
}): Promise<SugarSpan> {
  const fallback = (): SugarSpan => ({
    span: SUGAR_MAX_POSITIONS + SUGAR_MAX_POOLS,
    segments: [{
      factory: 'unknown',
      unstakedIterations: SUGAR_MAX_POSITIONS,
      poolIterations: SUGAR_MAX_POOLS,
      balanceOf: null,
      balanceOfAuthoritative: false,
      poolsLength: null,
    }],
    complete: false,
  });

  const regRaw = await ethCall(opts.rpc, opts.sugar, SEL_REGISTRY);
  if (regRaw.kind !== 'ok' || regRaw.result.length < 66) return fallback();
  const registry = '0x' + regRaw.result.slice(-40);

  const facRaw = await ethCall(opts.rpc, registry, SEL_POOL_FACTORIES);
  if (facRaw.kind !== 'ok' || facRaw.result.length < 130) return fallback();
  const factories = decodeAddressArray(facRaw.result);
  if (factories.length === 0) return fallback();

  const balanceOf = opts.nftManager
    ? await readUint(opts.rpc, opts.nftManager, SEL_BALANCE_OF + padAddress(opts.account))
    : null;

  const lengths = await Promise.all(
    factories.map((f) => readUint(opts.rpc, f, SEL_ALL_POOLS_LENGTH)),
  );

  const segments: SugarSpanSegment[] = factories.map((f, i) => ({
    factory: f,
    // Err HIGH: charge every factory the full unstaked allowance.
    unstakedIterations: SUGAR_MAX_POSITIONS,
    poolIterations: Math.min(lengths[i] ?? SUGAR_MAX_POOLS, SUGAR_MAX_POOLS),
    // Attribute the known balanceOf to the first segment only, so the ceiling
    // check below counts the wallet's NFTs once rather than once per factory.
    balanceOf: i === 0 ? balanceOf : null,
    balanceOfAuthoritative: false,
    poolsLength: lengths[i],
  }));

  return {
    span: segments.reduce((s, seg) => s + seg.unstakedIterations + seg.poolIterations, 0),
    segments,
    complete: lengths.every((l) => l != null),
  };
}

function decodeAddressArray(hex: string): string[] {
  const d = hex.startsWith('0x') ? hex.slice(2) : hex;
  try {
    const off = parseInt(d.slice(0, 64), 16) * 2;
    const n = parseInt(d.slice(off, off + 64), 16);
    if (!Number.isFinite(n) || n <= 0 || n > 64) return [];
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      const w = d.slice(off + 64 + i * 64, off + 64 + (i + 1) * 64);
      if (w.length !== 64) break;
      out.push('0x' + w.slice(24));
    }
    return out;
  } catch {
    return [];
  }
}

/* ── The paging sweep ─────────────────────────────────────────────────── */

export interface SugarPageOutcome<T> {
  /** Every row the sweep recovered, in window order. */
  rows: T[];
  /** eth_calls spent, halving retries included. */
  calls: number;
  ms: number;
  /** The sweep stopped early on its call-count or wall-clock budget. */
  budgetStopped: boolean;
  /** Windows that still reverted at a single iteration, so were not read. */
  revertSkipped: { offset: number }[];
  /** Windows whose RPC call failed outright (not a revert). */
  failedWindows: { offset: number; limit: number }[];
}

/**
 * Sweep the whole iteration space in parallel disjoint windows.
 *
 * `buildCalldata(limit, offset)` lets one helper serve both Sugar shapes —
 * `positionsByFactory` (4 args) and `positions` (3 args) — without the two
 * routes being able to drift apart in paging behaviour.
 */
export async function pageSugarPositions<T>(opts: {
  rpc: string;
  sugar: string;
  span: number;
  buildCalldata: (limit: number, offset: number) => string;
  decode: (hex: string) => T[];
  pageSize?: number;
  maxCalls?: number;
  budgetMs?: number;
  concurrency?: number;
  perWindowCalls?: number;
}): Promise<SugarPageOutcome<T>> {
  const pageSize = opts.pageSize ?? SUGAR_PAGE_SIZE;
  const maxCalls = opts.maxCalls ?? SUGAR_MAX_CALLS;
  const budgetMs = opts.budgetMs ?? SUGAR_BUDGET_MS;
  const concurrency = opts.concurrency ?? SUGAR_CONCURRENCY;
  const perWindowCalls = opts.perWindowCalls ?? SUGAR_MAX_CALLS_PER_WINDOW;

  const started = Date.now();
  let calls = 0;
  let budgetStopped = false;
  const revertSkipped: { offset: number }[] = [];
  const failedWindows: { offset: number; limit: number }[] = [];

  const windows: { offset: number; limit: number }[] = [];
  for (let o = 0; o < Math.max(opts.span, 1); o += pageSize) {
    windows.push({ offset: o, limit: Math.min(pageSize, Math.max(opts.span, 1) - o) });
  }

  const budgetLeft = () => calls < maxCalls && Date.now() - started < budgetMs;

  async function sweep(offset: number, limit: number, spent: { n: number }): Promise<T[]> {
    if (!budgetLeft()) {
      budgetStopped = true;
      return [];
    }
    // One pathological window must not consume the sweep's whole budget and
    // truncate every window after it — measured live, an unclassified 429
    // storm did exactly that (24 calls spent inside one window).
    if (spent.n >= perWindowCalls) {
      failedWindows.push({ offset, limit });
      return [];
    }
    calls++;
    spent.n++;
    const r = await ethCall(opts.rpc, opts.sugar, opts.buildCalldata(limit, offset));

    if (r.kind === 'ok') {
      try {
        return opts.decode(r.result);
      } catch {
        failedWindows.push({ offset, limit });
        return [];
      }
    }

    if (r.kind === 'transport') {
      // Already retried with backoff inside ethCall. A transport failure is NOT
      // an empty window (queue item B) — it is reported, never absorbed.
      failedWindows.push({ offset, limit });
      return [];
    }

    // Reverted. At a single iteration there is nothing left to halve: one pool
    // holds more staked positions for this account than the return array can
    // carry, and no argument to this method can reach them.
    if (limit <= 1) {
      revertSkipped.push({ offset });
      return [];
    }

    // Retry the SAME window as two halves, so the sweep advances only by what
    // it actually consumed and no iteration is skipped on the way past.
    const half = Math.max(1, Math.floor(limit / 2));
    const left = await sweep(offset, half, spent);
    const right = await sweep(offset + half, limit - half, spent);
    return [...left, ...right];
  }

  const results: T[][] = new Array(windows.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, windows.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= windows.length) return;
        results[i] = await sweep(windows[i].offset, windows[i].limit, { n: 0 });
      }
    }),
  );

  const rows: T[] = [];
  for (const r of results) if (r) rows.push(...r);

  return {
    rows,
    calls,
    ms: Date.now() - started,
    budgetStopped,
    revertSkipped,
    failedWindows,
  };
}

/* ── Truncation detection ─────────────────────────────────────────────── */

/**
 * Derive truncation notices from the CONTRACT'S OWN ceilings and from what the
 * sweep actually managed to read.
 *
 * This REPLACES the Phase 1 saturation check (`rawPositions.length >= limit`),
 * which produced FALSE NEGATIVES on exactly the wallets that matter. That
 * check counted POSITIONS RETURNED, while `_limit` bounds ITERATIONS EXAMINED:
 * a wallet whose one staked position sits past pool index 100 exhausted the
 * whole 100-iteration budget and returned ZERO rows, so `0 >= 100` was false
 * and the wallet was reported complete-and-empty. Iteration coverage against
 * the ceilings cannot miss that case, because it never looks at the row count.
 */
export function sugarCeilingTruncations(
  scope: string,
  span: SugarSpan,
  outcome: Pick<SugarPageOutcome<unknown>, 'rows' | 'budgetStopped' | 'revertSkipped' | 'calls' | 'failedWindows'>,
): RouteTruncation[] {
  const out: RouteTruncation[] = [];

  for (const seg of span.segments) {
    // (1) Loop (a) is `range(0, MAX_POSITIONS)`: NFTs at index >= 200 are
    //     structurally unreachable. balanceOf is exact ground truth.
    if (seg.balanceOfAuthoritative && seg.balanceOf != null && seg.balanceOf > SUGAR_MAX_POSITIONS) {
      out.push({
        scope,
        cap: SUGAR_MAX_POSITIONS,
        returned: SUGAR_MAX_POSITIONS,
        knownTotal: seg.balanceOf,
        reason: 'unstaked-position-ceiling',
      });
    }
    // (2) Loop (b) is `range(0, MAX_POOLS)`: staked positions in pools at index
    //     >= 2000 are structurally unreachable. The contract reports no total
    //     for them, so knownTotal stays honestly null — "there may be more",
    //     never a fabricated missing count.
    if (seg.poolsLength != null && seg.poolsLength > SUGAR_MAX_POOLS) {
      out.push({
        scope,
        cap: SUGAR_MAX_POOLS,
        returned: SUGAR_MAX_POOLS,
        knownTotal: null,
        reason: 'pool-scan-ceiling',
      });
    }
  }

  // (3) A window that reverts even at one iteration.
  if (outcome.revertSkipped.length > 0) {
    out.push({
      scope,
      cap: SUGAR_MAX_POSITIONS,
      returned: outcome.rows.length,
      knownTotal: null,
      reason: 'page-revert-skipped',
    });
  }

  // (5) A window whose RPC call failed even after retries. NOT in the original
  //     four reasons, added because verification proved the case reachable: a
  //     failed window silently drops every position in its range, which is the
  //     exact Rule 11 failure this whole item exists to end.
  if (outcome.failedWindows.length > 0) {
    out.push({
      scope,
      cap: 0,
      returned: outcome.rows.length,
      knownTotal: null,
      reason: 'page-fetch-failed',
    });
  }

  // (4) The sweep ran out of its call-count or wall-clock budget.
  if (outcome.budgetStopped) {
    out.push({
      scope,
      cap: outcome.calls,
      returned: outcome.rows.length,
      knownTotal: null,
      reason: 'page-budget',
    });
  }

  return out;
}
