// Tests for app/lib/alchemyLimiter.ts. No network: Alchemy is a stub.
//   npx tsx scripts/alchemy-limiter-test.ts          (unit tests + the 20-wallet simulation, about 2-3 min)
//   QUICK=1 npx tsx scripts/alchemy-limiter-test.ts  (unit tests only)
//   SEED=7 …       the simulation's seed (default 1); REALTIME=1 runs it on the wall clock
//
// The simulation runs on a VIRTUAL CLOCK with a seeded random source (Oct 18):
// on the wall clock its 429 share moved between 4.4% and 6.6% from run to run
// on the same code (timer drift, Math.random latency, shuffle and jitter), so
// a fixed threshold passed or failed by luck. Virtual time makes one seed one
// answer; several seeds give the spread.
//
// The simulation answers like Alchemy's account limit: a token bucket of 500 CU/s
// over a 10-second window (5,000 CU), HTTP 429 with Retry-After: 1 above it. Four
// simulated server instances, each with its own limiter, run 20 wallets at once
// (5 each), every wallet replaying one measured Account 1 dashboard load
// (113 calls, 2,852 CU, by method). It checks the limiter keeps the account
// under its limit, and that every call ends complete or as a thrown, visible
// failure, never as an empty or 429 answer handed to the caller.

import { AlchemyThrottledError, alchemyCuOf, createAlchemyLimiter, isAlchemyThrottledError, isAlchemyUrl } from '../app/lib/alchemyLimiter';

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures += 1;
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
// A fake clock for unit tests: sleeping advances it instantly.
const fakeTime = () => { let t = 1_000_000; return { now: () => t, sleep: async (ms: number) => { t += ms; } }; };
const URL_BASE = 'https://base-mainnet.g.alchemy.com/v2/KEY';
const body = (method: string) => JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] });
const ok = () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }), { status: 200, headers: { 'content-type': 'application/json' } });
const tooMany = (retryAfter = '1') => new Response('{"error":{"code":429,"message":"Your app has exceeded its compute units per second capacity"}}', { status: 429, headers: { 'retry-after': retryAfter } });

async function unit() {
  check('CU of one call', alchemyCuOf(body('eth_call')) === 26);
  check('CU of a batch is the sum', alchemyCuOf(JSON.stringify([{ method: 'getTransaction' }, { method: 'getTransaction' }, { method: 'eth_blockNumber' }])) === 90);
  check('CU of an unknown method is the eth_call price', alchemyCuOf(body('made_up')) === 26);
  check('Alchemy hosts are matched', isAlchemyUrl(URL_BASE) && isAlchemyUrl('https://sui-mainnet.g.alchemy.com/v2/k') && isAlchemyUrl('https://solana-mainnet.g.alchemy.com/v2/k'));
  check('other hosts are not', !isAlchemyUrl('https://base.gateway.tenderly.co') && !isAlchemyUrl('https://notalchemy.com.evil.io/x') && !isAlchemyUrl('not a url'));

  // Retried 429s, honouring Retry-After, then the answer.
  {
    let n = 0; const waits: number[] = []; const ft = fakeTime();
    const lim = createAlchemyLimiter((async () => (++n <= 2 ? tooMany('2') : ok())) as typeof fetch, { now: ft.now, sleep: async (ms) => { waits.push(ms); await ft.sleep(ms); }, random: () => 0 });
    const res = await lim.fetch(URL_BASE, { method: 'POST', body: body('eth_call') });
    check('two 429s then 200 → the 200 reaches the caller', res.status === 200 && n === 3);
    check('Retry-After (2 s) is honoured over the shorter backoff', waits.filter((w) => w >= 2000).length >= 2, `waits ${waits.join(',')}`);
    check('instance rate halved after a 429', lim.stats().currentRate < 200, `rate ${lim.stats().currentRate}`);
  }
  // Give up after the maximum attempts: throws, never returns the 429.
  {
    let n = 0;
    const lim = createAlchemyLimiter((async () => { n++; return tooMany('0'); }) as typeof fetch, { ...fakeTime(), random: () => 0 });
    let thrown: unknown = null; let returned: Response | null = null;
    try { returned = await lim.fetch(URL_BASE, { method: 'POST', body: body('eth_getLogs') }); } catch (e) { thrown = e; }
    check('always-429 → throws AlchemyThrottledError after 5 sends', isAlchemyThrottledError(thrown) && returned === null && n === 5, `sends ${n}`);
    check('the error names the network', thrown instanceof AlchemyThrottledError && thrown.network === 'base-mainnet');
  }
  // Backoff is exponential with jitter and capped.
  {
    const waits: number[] = []; const ft = fakeTime();
    const lim = createAlchemyLimiter((async () => tooMany('0')) as typeof fetch, { now: ft.now, sleep: async (ms) => { waits.push(ms); await ft.sleep(ms); }, random: () => 0.5, maxAttempts: 6 });
    try { await lim.fetch(URL_BASE, { method: 'POST', body: body('eth_call') }); } catch { /* expected */ }
    const pauses = waits.filter((w) => w >= 500);
    check('backoff 1.0 s, 1.5 s, 2.5 s, 4.5 s, 8.5 s (0.5·2^n + 0.5 s jitter, capped at 8 s)', JSON.stringify(pauses.slice(0, 5)) === JSON.stringify([1000, 1500, 2500, 4500, 8500]), `got ${pauses.slice(0, 5).join(',')}`);
  }
  // A 429 storm of 30% and 80% of sends: every call ends ok or thrown.
  for (const rate of [0.3, 0.8]) {
    let i = 0;
    const rnd = (() => { let x = 12345; return () => { x = (x * 1103515245 + 12345) % 2 ** 31; return x / 2 ** 31; }; })();
    const lim = createAlchemyLimiter((async () => { i++; return rnd() < rate ? tooMany('0') : ok(); }) as typeof fetch, { ...fakeTime(), random: () => 0 });
    let okN = 0, thrownN = 0, other = 0;
    await Promise.all(Array.from({ length: 200 }, async () => {
      try { const r = await lim.fetch(URL_BASE, { method: 'POST', body: body('eth_call') }); if (r.status === 200) okN++; else other++; }
      catch (e) { if (isAlchemyThrottledError(e)) thrownN++; else other++; }
    }));
    check(`429 storm ${rate * 100}%: 200 calls end complete or thrown, none silent`, okN + thrownN === 200 && other === 0, `complete ${okN}, thrown ${thrownN}, sends ${i}`);
  }
  // Other hosts are never touched by the limiter (only the wrapped fetch decides).
  // Abort while waiting for tokens: rejects with AbortError, does not block the queue.
  {
    const lim = createAlchemyLimiter((async () => ok()) as typeof fetch, { ratePerSec: 10 });
    const ac = new AbortController();
    const big = lim.fetch(URL_BASE, { method: 'POST', body: JSON.stringify(Array.from({ length: 10 }, () => ({ method: 'getTransaction' }))), signal: ac.signal });
    const blocked = lim.fetch(URL_BASE, { method: 'POST', body: JSON.stringify(Array.from({ length: 10 }, () => ({ method: 'getTransaction' }))), signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    const r1 = await big.then((r) => r.status, (e) => e.name);
    const r2 = await blocked.then((r) => r.status, (e) => e.name);
    check('a waiter aborted by its caller rejects with AbortError', r1 === 200 && r2 === 'AbortError', `${r1} / ${r2}`);
  }
}

// ── 20-wallet simulation against an Alchemy-like account limit ────────────────
const PROFILE: Record<string, number> = { // Account 1 dashboard load, before-build measurement 2026-10-15
  getTransaction: 8, eth_call: 76, suix_getOwnedObjects: 10, suix_getDynamicFieldObject: 7,
  suix_getCoinMetadata: 4, sui_getObject: 3, eth_getTransactionCount: 2, sui_multiGetObjects: 3,
};

interface SimClock { now: () => number; sleep: (ms: number) => Promise<void>; random: () => number; timeout: (ms: number) => AbortSignal }

// mulberry32: a small seeded PRNG.
function seeded(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// Discrete-event clock: `sleep` registers a timer; the driver advances time to
// the earliest timer once every pending microtask (and setImmediate) has run.
function virtualClock(seed: number): SimClock & { drive: <T>(p: Promise<T>) => Promise<T> } {
  let t = 1_000_000, seq = 0;
  const timers: Array<{ at: number; seq: number; fire: () => void }> = [];
  const add = (ms: number, fire: () => void) => { timers.push({ at: t + Math.max(0, ms), seq: seq++, fire }); };
  const clock = {
    now: () => t,
    sleep: (ms: number) => new Promise<void>((r) => add(ms, r)),
    random: seeded(seed),
    timeout: (ms: number) => { const ac = new AbortController(); add(ms, () => ac.abort(new DOMException('timed out', 'TimeoutError'))); return ac.signal; },
    drive: async <T,>(p: Promise<T>): Promise<T> => {
      let done = false; let out: T; let err: unknown; let failed = false;
      p.then((v) => { done = true; out = v; }, (e) => { done = true; failed = true; err = e; });
      const idle = () => new Promise<void>((r) => setImmediate(r));
      for (;;) {
        for (let i = 0; i < 3; i++) await idle();
        if (done) break;
        if (timers.length === 0) throw new Error('virtual clock: nothing scheduled and not done');
        timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
        const next = timers.shift()!;
        t = Math.max(t, next.at);
        next.fire();
      }
      if (failed) throw err;
      return out!;
    },
  };
  return clock;
}
const realClock = (): SimClock => ({ now: Date.now, sleep, random: Math.random, timeout: (ms) => AbortSignal.timeout(ms) });

function alchemyStub(limitPerSec: number, windowSec: number, clock: SimClock) {
  // Alchemy: "a Free tier customer with a 300 CU/s limit can consume up to 3,000 CUs
  // over any 10-second period". So: accepted CU in ANY trailing window ≤ limit × window.
  const cap = limitPerSec * windowSec;
  const accepted: Array<[number, number]> = []; let n429 = 0, sends = 0, inWindow = 0, head = 0;
  const fn = (async (_input: unknown, init?: RequestInit) => {
    sends++;
    const now = clock.now();
    while (head < accepted.length && now - accepted[head][0] >= windowSec * 1000) { inWindow -= accepted[head][1]; head++; }
    const cu = alchemyCuOf(init?.body ?? null);
    if (inWindow + cu > cap) { n429++; return tooMany('1'); }
    inWindow += cu; accepted.push([now, cu]);
    await clock.sleep(60 + clock.random() * 90);
    return ok();
  }) as typeof fetch;
  const peak = (ms: number) => { let best = 0; for (let i = 0, j = 0, sum = 0; i < accepted.length; i++) { sum += accepted[i][1]; while (accepted[i][0] - accepted[j][0] >= ms) { sum -= accepted[j][1]; j++; } best = Math.max(best, sum); } return best; };
  return { fn, stats: () => ({ sends, n429, peak1s: peak(1000), peak10s: peak(10_000), totalCu: accepted.reduce((t, [, c]) => t + c, 0) }) };
}

async function simulate(label: string, useLimiter: boolean, timeoutMs: number | null, seed: number) {
  const vc = process.env.REALTIME ? null : virtualClock(seed);
  const clock: SimClock = vc ?? realClock();
  const stub = alchemyStub(500, 10, clock);
  const instances = Array.from({ length: 4 }, () => useLimiter ? createAlchemyLimiter(stub.fn, { now: clock.now, sleep: clock.sleep, random: clock.random }) : { fetch: stub.fn, stats: () => null });
  const calls: string[] = []; for (const [m, n] of Object.entries(PROFILE)) for (let i = 0; i < n; i++) calls.push(m);
  const outcome = { complete: 0, thrown429: 0, aborted: 0, handed429: 0, other: 0 };
  const lat: number[] = [];
  const t0 = clock.now();
  const run = Promise.all(Array.from({ length: 20 }, async (_, w) => {
    const inst = instances[w % 4];
    // A page load fires its route requests at once; each route makes a few calls in a row.
    const queue = [...calls].map((m) => [clock.random(), m] as const).sort((a, b) => a[0] - b[0]).map(([, m]) => m);
    await Promise.all(Array.from({ length: 12 }, async () => {
      while (queue.length) {
        const m = queue.pop()!; const s = clock.now();
        try {
          const res = await inst.fetch(URL_BASE, { method: 'POST', body: body(m), ...(timeoutMs ? { signal: clock.timeout(timeoutMs) } : {}) });
          if (res.status === 200) { outcome.complete++; lat.push(clock.now() - s); } else if (res.status === 429) outcome.handed429++; else outcome.other++;
        } catch (e) {
          if (isAlchemyThrottledError(e)) outcome.thrown429++;
          else if (e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError')) outcome.aborted++;
          else outcome.other++;
        }
      }
    }));
  }));
  await (vc ? vc.drive(run) : run);
  const st = stub.stats(); lat.sort((a, b) => a - b);
  const total = calls.length * 20;
  console.log(`  ${label}: ${((clock.now() - t0) / 1000).toFixed(0)} s${vc ? ' (virtual)' : ''} | calls ${total}: complete ${outcome.complete}, thrown (429) ${outcome.thrown429}, aborted by caller timeout ${outcome.aborted}, 429 handed to caller ${outcome.handed429} | Alchemy saw ${st.sends} sends, ${st.n429} answered 429, ${st.totalCu} CU accepted, peak ${st.peak1s} CU in 1 s, ${(st.peak10s / 10).toFixed(0)} CU/s over 10 s | latency p50 ${lat[lat.length >> 1] ?? '-'} ms p95 ${lat[Math.floor(lat.length * 0.95)] ?? '-'} ms`);
  return { outcome, st, total };
}

(async () => {
  await unit();
  if (process.env.QUICK) { console.log(failures ? `\n${failures} FAILED` : '\nall passed'); process.exit(failures ? 1 : 0); }
  console.log('\n20 wallets × one Account 1 dashboard load, 4 instances, stub limit 500 CU/s = 5,000 CU in any 10 s:');
  const seed = Number(process.env.SEED ?? 1);
  const control = await simulate('no limiter (before)', false, null, seed);
  if (process.env.REALTIME) await sleep(11_000); // separate stubs anyway
  const patient = await simulate('limiter, callers wait', true, null, seed);
  const timed = await simulate('limiter, 12 s caller timeout (evmRpc / suiRpc)', true, 12_000, seed);
  console.log(`  seed ${seed}: patient 429 share ${(100 * patient.st.n429 / patient.st.sends).toFixed(2)}%`);
  check('control: without the limiter the stub answers 429 to many calls', control.outcome.handed429 > control.total * 0.1, `${control.outcome.handed429} of ${control.total}`);
  check('limiter: no 429 is ever handed to a caller', patient.outcome.handed429 === 0 && timed.outcome.handed429 === 0);
  check('limiter: every call ends complete or as a thrown, visible failure', [patient, timed].every((r) => r.outcome.complete + r.outcome.thrown429 + r.outcome.aborted === r.total && r.outcome.other === 0));
  check('limiter, patient callers: all calls complete', patient.outcome.complete === patient.total, `${patient.outcome.complete} of ${patient.total}`);
  // Threshold (Oct 18): on the virtual clock the share is 4.84-5.20% over seeds
  // 1-10 on the unchanged limiter (4 instances × a 5 s burst at 200 CU/s against
  // a 500 CU/s account: the first overshoot is structural). The old 5% bound sat
  // on that mean, set from one wall-clock run (4.4%); 6% still fails a limiter
  // whose back-off is lost (no limiter: ~91%).
  check('limiter: Alchemy answers 429 to under 6% of sends', patient.st.n429 < patient.st.sends * 0.06, `${patient.st.n429} of ${patient.st.sends}`);
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
