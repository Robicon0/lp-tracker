// getBurnedTokenIds: saved list, reorg margin, failures. No network: the sources
// and the store are fakes. Run: npx tsx scripts/burned-ids-test.ts
import { getBurnedTokenIds, mergeBurns, REORG_MARGIN_BLOCKS } from '../app/lib/evmBurnedNftIds';

let failed = 0;
let passed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) passed += 1; else { failed += 1; console.log(`FAIL ${name} ${detail}`); }
}

function fakeStore(initial?: unknown, opts: { failGet?: boolean } = {}) {
  const data = new Map<string, unknown>();
  const writes: string[] = [];
  if (initial !== undefined) data.set('__init', initial);
  return {
    writes,
    data,
    get: async (k: string) => {
      if (opts.failGet) throw new Error('store down');
      return data.has(k) ? data.get(k) : data.get('__init') ?? null;
    },
    set: async (k: string, v: string) => { writes.push(v); data.set(k, JSON.parse(v)); return 'OK'; },
  };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const base = { chain: 'arbitrum' as const, nftManager: '0xNPM', wallet: '0xWALLET', fromBlock: 1000 };
const M = REORG_MARGIN_BLOCKS.arbitrum;

async function main() {
  // 1. Cold read: burns below head-margin saved, inside it returned only.
  {
    const store = fakeStore();
    const head = 100_000;
    const r = await getBurnedTokenIds({ ...base, store, sources: [async (from) => {
      check('cold read starts at deploy block', from === 1000, String(from));
      return { head, burns: [{ id: '5', block: 2000 }, { id: '9', block: head - 10 }] };
    }] });
    await tick();
    check('cold complete', r.complete && r.reason === null);
    check('cold returns both', JSON.stringify(r.ids) === '["5","9"]', JSON.stringify(r.ids));
    const saved = JSON.parse(store.writes[0]);
    check('cold saves only below margin', JSON.stringify(saved.ids) === '["5"]', store.writes[0]);
    check('cold cursor = head - margin', saved.cursor === head - M, String(saved.cursor));
  }
  // 2. Update: reads from cursor+1 (re-reads the margin), keeps stored ids.
  {
    const store = fakeStore({ v: 1, ids: ['5'], cursor: 50_000 });
    const r = await getBurnedTokenIds({ ...base, store, sources: [async (from) => {
      check('update starts after cursor', from === 50_001, String(from));
      return { head: 200_000, burns: [{ id: '9', block: 60_000 }] };
    }] });
    await tick();
    check('update returns stored + new', JSON.stringify(r.ids) === '["5","9"]', JSON.stringify(r.ids));
    const saved = JSON.parse(store.writes[0]);
    check('update saves union', JSON.stringify(saved.ids) === '["5","9"]');
    check('update cursor advances', saved.cursor === 200_000 - M);
  }
  // 3. Both sources fail: stored ids returned, incomplete, nothing written.
  {
    const store = fakeStore({ v: 1, ids: ['5', '7'], cursor: 50_000 });
    const r = await getBurnedTokenIds({ ...base, store, sources: [
      async () => { throw new Error('logs down'); },
      async () => { throw new Error('index down'); },
    ] });
    await tick();
    check('all failed → incomplete', !r.complete && r.reason !== null);
    check('all failed keeps stored ids', JSON.stringify(r.ids) === '["5","7"]');
    check('all failed writes nothing', store.writes.length === 0);
  }
  // 4. No stored list and every source fails: never "burned nothing" complete.
  {
    const r = await getBurnedTokenIds({ ...base, store: fakeStore(), sources: [async () => { throw new Error('down'); }] });
    check('cold failure is incomplete', !r.complete && r.ids.length === 0);
  }
  // 5. First source fails, second answers: complete.
  {
    const store = fakeStore();
    const r = await getBurnedTokenIds({ ...base, store, sources: [
      async () => { throw new Error('logs down'); },
      async () => ({ head: 100_000, burns: [{ id: '3', block: 5_000 }] }),
    ] });
    check('fallback source completes', r.complete && JSON.stringify(r.ids) === '["3"]');
  }
  // 6. Store read fails: full read, result complete, but no write over the unseen list.
  {
    const store = fakeStore(undefined, { failGet: true });
    const r = await getBurnedTokenIds({ ...base, store, sources: [async (from) => {
      check('store failure reads from deploy block', from === 1000);
      return { head: 100_000, burns: [{ id: '3', block: 5_000 }] };
    }] });
    await tick();
    check('store failure still complete', r.complete && r.ids.length === 1);
    check('store failure writes nothing', store.writes.length === 0);
  }
  // 7. Nothing new: no write (cursor would not move past the stored one).
  {
    const store = fakeStore({ v: 1, ids: ['5'], cursor: 99_000 });
    await getBurnedTokenIds({ ...base, store, sources: [async () => ({ head: 99_000 + M, burns: [] })] });
    await tick();
    check('unchanged writes nothing', store.writes.length === 0, store.writes.join());
  }
  // 8. mergeBurns never shrinks and never duplicates.
  {
    const { ids, save } = mergeBurns({ v: 1, ids: ['1', '2'], cursor: 10 }, [{ id: '2', block: 11 }, { id: '4', block: 12 }], 1_000, 100, 0);
    check('merge no duplicate', JSON.stringify(ids) === '["1","2","4"]', JSON.stringify(ids));
    check('merge keeps stored', save.ids.includes('1') && save.ids.includes('2'));
    const back = mergeBurns({ v: 1, ids: ['1'], cursor: 500 }, [], 300, 100, 0);
    check('cursor never moves back', back.save.cursor === 500);
  }
  // 9. Head inside the margin of the deploy block: cursor stays before the deploy block.
  {
    const { save } = mergeBurns(null, [{ id: '8', block: 1001 }], 1005, M, 1000);
    check('young chain saves nothing', save.ids.length === 0 && save.cursor === 999);
  }
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main();
