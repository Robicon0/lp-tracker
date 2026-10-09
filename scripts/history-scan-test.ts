// Resumable history-scan engine: budget, resume, caps, failure, lock, ordering.
// Pure in-memory (fake chain + fake store). Run: npx tsx scripts/history-scan-test.ts
import { runResumableScan, _resetHistoryScanOverlay, type ScanStore, type ScanSource } from '../app/lib/historyScan';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra = '') => { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name} ${extra}`); } };

function memStore(): ScanStore & { data: Map<string, string>; writes: number } {
  const data = new Map<string, string>();
  const s = {
    data, writes: 0,
    async get(k: string) { return data.get(k) ?? null; },
    async mget(keys: string[]) { return keys.map((k) => data.get(k) ?? null); },
    async set(k: string, v: string, o?: { nx?: boolean }) { if (o?.nx && data.has(k)) return null; data.set(k, v); s.writes++; return 'OK'; },
    async del(k: string) { data.delete(k); return 1; },
  };
  return s;
}

interface Tx { id: number; pad?: string }
// A fake chain: transactions 1..n, newest = n. Page size 10, newest first.
function chain(n: () => number, opts: { failAt?: () => number | null; pad?: number } = {}) {
  const calls: Array<{ until: string | null; cursor: number | null }> = [];
  const source: ScanSource<Tx, number> = {
    async page({ until, cursor }) {
      calls.push({ until, cursor });
      const hi = cursor ?? n();
      if (opts.failAt?.() != null && hi <= opts.failAt!()!) throw new Error('provider down');
      const floor = until === null ? 0 : Number(until);
      const lo = Math.max(floor, hi - 10);
      const items: Tx[] = [];
      for (let i = lo + 1; i <= hi; i++) if (i % 2 === 0) items.push({ id: i, ...(opts.pad ? { pad: 'x'.repeat(opts.pad) } : {}) });
      return { items, scanned: hi - lo, top: String(n()), next: lo > floor ? lo : null };
    },
  };
  return { source, calls };
}
// A clock the test advances: each page costs 1 unit.
function clock() { let t = 1_000; return { now: () => t, tick: (d = 1) => { t += d; } }; }
const timed = <T, C>(source: ScanSource<T, C>, c: { tick: (d?: number) => void }): ScanSource<T, C> => ({
  async page(a) { const r = await source.page(a); c.tick(1); return r; },
});
const base = { idOf: (t: Tx) => String(t.id), maxScanned: 1e9, maxKept: 1e9, lockWaitMs: 1 };

(async () => {
  console.log('budget + resume');
  {
    _resetHistoryScanOverlay();
    const store = memStore(); const c = clock(); let n = 95; const ch = chain(() => n);
    const run = () => { _resetHistoryScanOverlay(); return runResumableScan({ ...base, key: 'k1', store, source: timed(ch.source, c), budgetMs: 3, now: c.now }); };
    const r1 = await run();
    ok('load 1 stops at the budget, flagged in-progress', r1.status === 'in-progress' && !r1.complete && ch.calls.length === 3);
    const i1 = await r1.items();
    ok('load 1 serves what it found (newest part)', i1.length === 15 && i1[0].id === 66 && i1[i1.length - 1].id === 94, JSON.stringify(i1.map((x) => x.id)));
    const r2 = await run(); const i2 = await r2.items();
    ok('load 2 resumes from the cursor (no page repeated)', ch.calls[3].cursor === 65 && new Set(ch.calls.map((x) => x.cursor)).size === ch.calls.length);
    ok('load 2 has more than load 1', i2.length > i1.length && r2.status === 'in-progress');
    let r = r2; let loads = 2; while (!r.complete && loads < 10) { r = await run(); loads++; }
    const all = await r.items();
    ok('converges to complete', r.complete && r.status === 'complete' && loads === 4, `loads ${loads}`);
    ok('every kept transaction present once, oldest first', all.length === 47 && all.every((x, i) => x.id === (i + 1) * 2));
    ok('mark changes as the set grows', r1.mark !== r2.mark && r2.mark !== r.mark);
    const before = ch.calls.length; const r5 = await run();
    ok('nothing new: one request, still complete', ch.calls.length === before + 1 && r5.complete && ch.calls[before].until === '95');
    n = 115; const r6 = await run(); const i6 = await r6.items();
    ok('new activity is added on the next load', r6.complete && i6.length === 57 && i6[i6.length - 1].id === 114 && i6[0].id === 2);
    ok('a tail that outlasts the budget is in-progress, then completes', await (async () => {
      n = 300; const a = await run(); const b = await run(); let z = b; let k = 0; while (!z.complete && k++ < 10) z = await run();
      return a.status === 'in-progress' && z.complete && (await z.items()).length === 150;
    })());
  }

  console.log('caps');
  {
    const store = memStore(); const c = clock(); const ch = chain(() => 1000);
    const run = () => { _resetHistoryScanOverlay(); return runResumableScan({ ...base, key: 'k2', store, source: timed(ch.source, c), budgetMs: 1e9, now: c.now, maxScanned: 50 }); };
    const r = await run(); const items = await r.items();
    ok('a history past the scan limit is capped, never complete', r.status === 'capped' && !r.complete && /most recent/.test(r.reason ?? ''));
    ok('the capped result is the MOST RECENT part', items.length === 25 && items[0].id === 952 && items[24].id === 1000);
    const r2 = await run();
    ok('still capped on the next load, without rescanning', r2.status === 'capped' && ch.calls.length === 6 && ch.calls[5].until === '1000');
    const s3 = memStore(); const ch3 = chain(() => 1000);
    _resetHistoryScanOverlay();
    const r3 = await runResumableScan({ ...base, key: 'k3', store: s3, source: ch3.source, budgetMs: 1e9, maxKept: 12 });
    ok('kept-record limit caps the same way', r3.status === 'capped' && (await r3.items()).length === 15);
  }

  console.log('failure + lock + storage');
  {
    const store = memStore(); const c = clock(); let down: number | null = 60; const ch = chain(() => 95, { failAt: () => down });
    const run = () => { _resetHistoryScanOverlay(); return runResumableScan({ ...base, key: 'k4', store, source: timed(ch.source, c), budgetMs: 1e9, now: c.now }); };
    const r1 = await run();
    ok('a failed page stops the scan as failed, keeping earlier pages', r1.status === 'failed' && !r1.complete && (await r1.items()).length === 20);
    down = null; const r2 = await run();
    ok('next load retries the failed page and completes', r2.complete && (await r2.items()).length === 47 && ch.calls.filter((x) => x.cursor === 55).length === 2);

    store.data.set('k4:lock', '1'); const n0 = ch.calls.length; const r3 = await run();
    ok('lock held elsewhere: serves stored items, scans nothing', ch.calls.length === n0 && (await r3.items()).length === 47);
    store.data.delete('k4:lock');

    const big = memStore(); const chB = chain(() => 4000, { pad: 4000 });
    _resetHistoryScanOverlay();
    const rb = await runResumableScan({ ...base, key: 'k5', store: big, source: chB.source, budgetMs: 1e9 });
    const sizes = [...big.data.entries()].filter(([k]) => /:c\d+$/.test(k)).map(([, v]) => v.length);
    ok('large histories are split into bounded chunks', sizes.length > 5 && Math.max(...sizes) <= 850_000 && (await rb.items()).length === 2000, `chunks ${sizes.length} max ${Math.max(...sizes)}`);

    _resetHistoryScanOverlay();
    const none = await runResumableScan({ ...base, key: 'k6', store: null, source: chain(() => 95).source, budgetMs: 1e9 });
    ok('no store configured: still returns the scan', none.complete && (await none.items()).length === 47);

    process.env.CLOSED_POS_CACHE_READONLY = '1';
    const ro = memStore(); const cR = clock(); const chR = chain(() => 95);
    const runRo = () => runResumableScan({ ...base, key: 'k7', store: ro, source: timed(chR.source, cR), budgetMs: 3, now: cR.now });
    _resetHistoryScanOverlay(); const a = await runRo(); const na = (await a.items()).length; const b = await runRo();
    ok('read-only: resumes across requests, writes nothing to the store', ro.writes === 0 && a.status === 'in-progress' && (await b.items()).length > na);
    delete process.env.CLOSED_POS_CACHE_READONLY;
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
