// npx tsx scripts/store-full-test.ts
// Batch C (2026-10-19): the shared store is 64 MB, `noeviction`. When it is full
// every write fails ("OOM command not allowed …"). Figures must stay correct and
// nothing stored may be dropped; the work is redone next load and a notice says
// it could not be saved. Also: a finished day's price copy never expires (1a).
import { runResumableScan, _resetHistoryScanOverlay, type ScanStore, type ScanSource } from '../app/lib/historyScan';
import { loadClosedPositionsGuarded } from '../app/lib/closedPositionCache';
import { isFinishedUtcDay, priceCopyOpts } from '../app/lib/finishedDay';
import { failingWritesStore, storeWriteFailuresSince } from '../app/lib/sharedStore';
import { isInfoReason, STORE_WRITE_FAILED, storeWriteFailedNotice, hasLookupFailure } from '../app/lib/enumerationTruncation';
// These checks run against an in-memory store, never the shared one. Clear the
// local read-only switch (set for every local run, Methodology rule (f)), or the
// fake store takes no writes and every resume / never-shrink check fails.
delete process.env.CLOSED_POS_CACHE_READONLY;

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra = '') => { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name} ${extra}`); } };
const OOM = "OOM command not allowed when used memory > 'maxmemory'.";

function memStore(fullAfterWrites = Infinity) {
  const data = new Map<string, string>(); let writes = 0;
  const s: ScanStore & { data: Map<string, string> } = {
    data,
    async get(k: string) { return data.get(k) ?? null; },
    async mget(keys: string[]) { return keys.map((k) => data.get(k) ?? null); },
    async set(k: string, v: string, o?: { nx?: boolean }) { if (writes >= fullAfterWrites) throw new Error(OOM); if (o?.nx && data.has(k)) return null; data.set(k, v); writes++; return 'OK'; },
    async del(k: string) { if (writes >= fullAfterWrites) throw new Error(OOM); data.delete(k); return 1; },
  };
  return s;
}
interface Tx { id: number }
const source = (n: number): ScanSource<Tx, number> => ({
  async page({ until, cursor }) {
    const hi = cursor ?? n; const floor = until === null ? 0 : Number(until); const lo = Math.max(floor, hi - 10);
    const items: Tx[] = []; for (let i = lo + 1; i <= hi; i++) items.push({ id: i });
    return { items, scanned: hi - lo, top: String(n), next: lo > floor ? lo : null };
  },
});
const base = { idOf: (t: Tx) => String(t.id), maxScanned: 1e9, maxKept: 1e9, lockWaitMs: 1, budgetMs: 1e9 };

(async () => {
  console.log('1a finished-day price copies');
  const now = Date.parse('2026-10-19T08:00:00Z');
  ok('yesterday is finished', isFinishedUtcDay(Date.parse('2026-10-18T23:59:59Z') / 1000, now));
  ok('today is not', !isFinishedUtcDay(Date.parse('2026-10-19T00:00:01Z') / 1000, now));
  ok('a finished day is stored with no expiry', priceCopyOpts(Date.parse('2025-06-01T12:00:00Z') / 1000, 2_592_000) === undefined);
  ok("today's copy keeps its expiry", priceCopyOpts(Date.now() / 1000, 2_592_000)?.ex === 2_592_000);

  console.log('1d history scan with a full store');
  {
    _resetHistoryScanOverlay();
    const store = memStore(0); // every write fails from the start
    const r = await runResumableScan({ ...base, key: 'h1', store, source: source(95) });
    const items = await r.items();
    ok('scan completes in memory (never "history could not be loaded")', r.status === 'complete' && r.complete, `${r.status} ${r.reason ?? ''}`);
    ok('every transaction returned', items.length === 95 && items[0].id === 1 && items[94].id === 95);
    ok('result says how many could not be saved', r.unsaved === 95, String(r.unsaved));
    ok('nothing was written', store.data.size === 0);
  }
  {
    _resetHistoryScanOverlay();
    const store = memStore(4); // fills up part-way through a scan
    const r = await runResumableScan({ ...base, key: 'h2', store, source: source(300) });
    const items = await r.items();
    ok('a store that fills mid-scan: still complete, nothing lost', r.complete && items.length === 300 && new Set(items.map((x) => x.id)).size === 300, `${r.status} ${items.length}`);
    _resetHistoryScanOverlay();
    const again = await runResumableScan({ ...base, key: 'h2', store: memStore(Infinity) as ScanStore, source: source(300) });
    ok('next load (store has room) reads it again from the start', again.complete && (await again.items()).length === 300);
  }

  console.log('1d closed lists with a full store');
  {
    const data = new Map<string, string>();
    const list = [{ positionId: 'a', capitalGL: -1, events: [{ type: 'deposit' }, { type: 'withdrawal' }] }, { positionId: 'b', capitalGL: 2, events: [{ type: 'deposit' }, { type: 'withdrawal' }] }];
    data.set('closed_pos_sui_v2:cetus:w', JSON.stringify(list));
    const backend = {
      get: async (k: string) => data.get(k) ?? null,
      set: async () => { throw new Error(OOM); },
      ttl: async () => -1, persist: async () => { throw new Error(OOM); },
    };
    const r = await loadClosedPositionsGuarded({
      backend, slots: [{ name: 'cetus', key: 'closed_pos_sui_v2:cetus:w' }],
      scan: async () => ({ bySlot: { cetus: [{ positionId: 'c', capitalGL: 3, events: [{ type: 'deposit' }, { type: 'withdrawal' }] }] }, complete: true }),
      idOf: (p: { positionId: string }) => p.positionId, weightOf: (p: { events: unknown[] }) => p.events.length,
      isValid: (p: unknown) => !!p && typeof (p as { capitalGL?: unknown }).capitalGL === 'number', emptyTtlSeconds: null, legacyTtlSeconds: 2_592_000,
      mark: 'm2', // history moved: a scan runs and tries to write
    } as never) as { bySlot: Record<string, Array<{ positionId: string }>> };
    ok('stored list served in full plus the new position (never dropped)', r.bySlot.cetus.map((p) => p.positionId).sort().join() === 'a,b,c');
    ok('stored value untouched', data.get('closed_pos_sui_v2:cetus:w') === JSON.stringify(list));
  }

  console.log('1d failing-writes store and the notice');
  {
    const real = { get: async () => 'v', set: async () => 'OK', mget: async () => ['v'] };
    const t0 = Date.now();
    const s = failingWritesStore(real as never, 'test') as unknown as typeof real;
    ok('reads still work', (await s.get()) === 'v');
    let threw = ''; try { await s.set(); } catch (e) { threw = (e as Error).message; }
    ok('writes fail with the out-of-memory error', threw === OOM);
    ok('failure counted for the request', storeWriteFailuresSince(t0) > 0);
    const n = storeWriteFailedNotice('closed-position history');
    ok('notice is information only: figures are not marked ≈', n.reason === STORE_WRITE_FAILED && isInfoReason(n.reason) && !hasLookupFailure([n]));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

export {};
