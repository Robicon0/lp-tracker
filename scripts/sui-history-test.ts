// Sui history client test (app/lib/suiHistory.ts). Reads the chain through
// GraphQL for one wallet and checks, against an IN-MEMORY store (nothing is
// written to the shared store):
//   1. a full scan is complete, oldest first, and the next one is one request,
//   2. with a time budget too small to finish, each load returns a flagged
//      partial result, resumes from its cursor and converges to the full scan,
//   3. an unreachable endpoint returns the stored events flagged failed and
//      leaves them untouched,
//   4. a position's own object history contains its deposit.
//
// USAGE  npx tsx scripts/sui-history-test.ts [wallet] [positionObjectId]
import { getSuiWalletHistory, getSuiObjectHistory, getSuiOwnedObjectIds, _setSuiHistoryStoreForTests } from '../app/lib/suiHistory';

const WALLET = process.argv[2] ?? '0xdce8af889df949cacbef1188e6eb59d70508b76eba4c74cb1c8dc4f34454c30d'; // Account 1
const CETUS_POSITION = '0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb::position::Position';

let requests = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = ((...a: Parameters<typeof fetch>) => { requests += 1; return realFetch(...a); }) as typeof fetch;

const mem = new Map<string, string>();
const store = {
  get: async (k: string) => mem.get(k) ?? null,
  mget: async (keys: string[]) => keys.map((k) => mem.get(k) ?? null),
  set: async (k: string, v: string, o?: { nx?: boolean }) => { if (o?.nx && mem.has(k)) return null; mem.set(k, v); return 'OK'; },
  del: async (k: string) => { mem.delete(k); return 1; },
};
const fresh = () => _setSuiHistoryStoreForTests(store);
const chunks = () => [...mem.entries()].filter(([k]) => /:c\d+$/.test(k)).map(([k, v]) => `${k}=${v.length}`).sort().join('|');

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => { if (cond) pass += 1; else fail += 1; console.log(cond ? 'PASS' : 'FAIL', name, detail); };
const sig = (h: { blocks: Array<{ digest: string; events: unknown[] }> }) => h.blocks.map((b) => `${b.digest}:${b.events.length}`).join(',');

(async () => {
  // 1. One pass with a generous budget: the reference result.
  process.env.HISTORY_SCAN_BUDGET_MS = '120000';
  fresh();
  let t = Date.now(); requests = 0;
  const full = await getSuiWalletHistory(WALLET);
  const fullMs = Date.now() - t, fullReq = requests;
  ok('full scan is complete', full.complete && full.status === 'complete', `${full.txCount} transactions, ${full.blocks.length} with position events, ${fullReq} requests, ${(fullMs / 1000).toFixed(1)} s${full.reason ? ' — ' + full.reason : ''}`);
  ok('blocks are oldest first', full.blocks.every((b, i) => i === 0 || Number(b.timestampMs) >= Number(full.blocks[i - 1].timestampMs)));

  fresh(); t = Date.now(); requests = 0;
  const again = await getSuiWalletHistory(WALLET);
  ok('second scan is incremental and identical', again.complete && requests === 1 && sig(again) === sig(full) && again.mark === full.mark, `${requests} request, ${((Date.now() - t) / 1000).toFixed(1)} s`);

  // 2. The same wallet with a budget too small to finish: partial, flagged, resumed, converging.
  const reference = sig(full);
  mem.clear(); process.env.HISTORY_SCAN_BUDGET_MS = '900';
  const loads: string[] = []; let last = 0; let grew = true; let flagged = true; let r = full;
  for (let i = 0; i < 40; i++) {
    fresh(); requests = 0; t = Date.now();
    r = await getSuiWalletHistory(WALLET);
    loads.push(`${i + 1}: ${((Date.now() - t) / 1000).toFixed(1)}s ${requests}req scanned ${r.txCount} kept ${r.blocks.length} ${r.status}`);
    if (!r.complete && r.status !== 'in-progress') flagged = false;
    if (r.blocks.length < last) grew = false; last = r.blocks.length;
    if (r.complete) break;
  }
  ok('small budget: first load is partial and flagged', loads.length > 1 && /in-progress/.test(loads[0]), loads[0]);
  ok('small budget: never shrinks, always flagged until done', grew && flagged);
  ok('small budget: converges to exactly the full scan', r.complete && sig(r) === reference, `\n     ${loads.join('\n     ')}`);

  // 3. Endpoint unreachable: stored events returned, flagged, stored chunks untouched.
  const before = chunks();
  process.env.SUI_GRAPHQL_URL = 'https://127.0.0.1:9/graphql';
  fresh();
  const down = await getSuiWalletHistory(WALLET);
  ok('endpoint unreachable → stored events returned, flagged failed, stored events untouched', !down.complete && down.status === 'failed' && sig(down) === reference && chunks() === before, `reason: ${down.reason}`);
  delete process.env.SUI_GRAPHQL_URL;
  process.env.HISTORY_SCAN_BUDGET_MS = '120000';

  fresh();
  const owned = await getSuiOwnedObjectIds(WALLET, CETUS_POSITION);
  const pid = process.argv[3] ?? [...owned][0];
  if (pid) {
    const obj = await getSuiObjectHistory(pid);
    const names = obj.flatMap((b) => b.events.map((e) => e.type.replace(/<.*/, '').split('::').pop()));
    ok('an owned position\'s object history holds its open and deposit', names.includes('OpenPositionEvent') && names.some((n) => /^AddLiquidity/.test(n ?? '')), `${pid.slice(0, 10)}…: ${obj.length} transactions [${[...new Set(names)].join(', ')}]`);
  } else {
    console.log('SKIP object history: the wallet owns no Cetus position');
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
