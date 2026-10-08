// Sui history client test (app/lib/suiHistory.ts). Reads the chain through
// GraphQL for one wallet and checks, against an IN-MEMORY store (nothing is
// written to the shared store):
//   1. a full scan is complete and its events are stored,
//   2. the next scan is incremental — one request, same result,
//   3. a history that is behind catches up to exactly the full scan,
//   4. an unreachable endpoint returns the stored events flagged incomplete and
//      leaves the store untouched,
//   5. a position's own object history contains its deposit.
//
// USAGE  npx tsx scripts/sui-history-test.ts [wallet] [positionObjectId]
import { getSuiWalletHistory, getSuiObjectHistory, getSuiOwnedObjectIds, _setSuiHistoryStoreForTests } from '../app/lib/suiHistory';

const WALLET = process.argv[2] ?? '0xdce8af889df949cacbef1188e6eb59d70508b76eba4c74cb1c8dc4f34454c30d'; // Account 1
const CETUS_POSITION = '0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb::position::Position';

let requests = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = ((...a: Parameters<typeof fetch>) => { requests += 1; return realFetch(...a); }) as typeof fetch;

const mem = new Map<string, string>();
let writes = 0;
const store = { get: async (k: string) => mem.get(k) ?? null, set: async (k: string, v: string) => { writes += 1; mem.set(k, v); } };
const fresh = () => _setSuiHistoryStoreForTests(store);

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => { if (cond) pass += 1; else fail += 1; console.log(cond ? 'PASS' : 'FAIL', name, detail); };
const sig = (h: { blocks: Array<{ digest: string; events: unknown[] }> }) => h.blocks.map((b) => `${b.digest}:${b.events.length}`).join(',');

(async () => {
  fresh();
  let t = Date.now(); requests = 0;
  const full = await getSuiWalletHistory(WALLET);
  const fullMs = Date.now() - t, fullReq = requests;
  ok('full scan is complete', full.complete, `${full.txCount} transactions, ${full.blocks.length} with position events, ${fullReq} requests, ${(fullMs / 1000).toFixed(1)} s${full.reason ? ' — ' + full.reason : ''}`);
  ok('full scan stored once', writes === 1 && mem.size === 1, `stored ${(([...mem.values()][0]?.length ?? 0) / 1024).toFixed(0)} KB`);

  fresh(); t = Date.now(); requests = 0; writes = 0;
  const again = await getSuiWalletHistory(WALLET);
  ok('second scan is incremental and identical', again.complete && requests === 1 && sig(again) === sig(full) && again.mark === full.mark, `${requests} request, ${((Date.now() - t) / 1000).toFixed(1)} s, writes ${writes}`);

  // Put the stored history back to where it stood 40 position transactions ago.
  const key = [...mem.keys()][0];
  const stored = JSON.parse(mem.get(key)!);
  const cut = Math.max(1, stored.blocks.length - 40);
  const cutTs = Number(stored.blocks[cut].timestampMs);
  const probe = await realFetch('https://graphql.mainnet.sui.io/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: `{ transactions(first:50, filter:{sentAddress:"${WALLET}"}){ nodes{ digest } } }` }) });
  void probe;
  // Find the checkpoint of the last kept transaction by asking for it.
  const lastKept = stored.blocks[cut - 1].digest;
  const cpRes = await (await realFetch('https://graphql.mainnet.sui.io/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: `{ transaction(digest:"${lastKept}"){ effects{ checkpoint{ sequenceNumber } } } }` }) })).json();
  const cp = cpRes.data.transaction.effects.checkpoint.sequenceNumber as number;
  mem.set(key, JSON.stringify({ ...stored, blocks: stored.blocks.slice(0, cut), lastCheckpoint: cp, tailDigests: [lastKept], txCount: 0 }));
  fresh(); requests = 0; writes = 0;
  const caught = await getSuiWalletHistory(WALLET);
  ok('a history that is behind catches up to the full scan', caught.complete && sig(caught) === sig(full), `was ${cut} of ${stored.blocks.length} position transactions (cut at ${new Date(cutTs).toISOString().slice(0, 10)}), now ${caught.blocks.length}; ${requests} requests, writes ${writes}`);

  const before = mem.get(key);
  process.env.SUI_GRAPHQL_URL = 'https://127.0.0.1:9/graphql';
  fresh(); writes = 0;
  const down = await getSuiWalletHistory(WALLET);
  ok('endpoint unreachable → stored events returned, flagged incomplete, store untouched', !down.complete && sig(down) === sig(full) && writes === 0 && mem.get(key) === before, `reason: ${down.reason}`);
  delete process.env.SUI_GRAPHQL_URL;

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
