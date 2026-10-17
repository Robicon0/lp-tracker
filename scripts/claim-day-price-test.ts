// npx tsx scripts/claim-day-price-test.ts
//
// The claim-day price (app/lib/claimDayPrice.ts) against a stubbed DeFiLlama
// and a stubbed store: the claim day's price, the nearby-day fallback (at most
// 3 days back), a failed request, a missing day, today's provisional price, the
// store read once per coin and written once with the merged map.
// Nothing leaves this process.

process.env.PRICE_CACHE_KV_REST_API_URL = 'https://store.test';
process.env.PRICE_CACHE_KV_REST_API_TOKEN = 't';
process.env.VERCEL_ENV = 'production';

type Pt = { timestamp: number; price: number };
const series = new Map<string, Map<string, number>>(); // id → day → price
let llamaFail = false;
let llamaCalls = 0;
const storeData = new Map<string, unknown>();
const storeCmds: string[] = [];

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.startsWith('https://store.test')) {
    const body = JSON.parse(String(init?.body ?? '[]'));
    const run = (c: string[]) => {
      const cmd = String(c[0]).toLowerCase();
      storeCmds.push(cmd);
      if (cmd === 'get') return { result: storeData.has(c[1]) ? JSON.stringify(storeData.get(c[1])) : null };
      if (cmd === 'set') { storeData.set(c[1], JSON.parse(c[2])); return { result: 'OK' }; }
      return { result: null };
    };
    const out = Array.isArray(body[0]) ? body.map(run) : run(body);
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url.startsWith('https://coins.llama.fi/batchHistorical')) {
    llamaCalls += 1;
    if (llamaFail) return new Response('busy', { status: 502 });
    const coins = JSON.parse(decodeURIComponent(new URL(url).searchParams.get('coins')!)) as Record<string, number[]>;
    const out: Record<string, { prices: Pt[] }> = {};
    for (const [id, tss] of Object.entries(coins)) {
      const s = series.get(id); const prices: Pt[] = [];
      for (const ts of tss) { const d = day(ts); const p = s?.get(d); if (p != null) prices.push({ timestamp: ts + 7, price: p }); }
      out[id] = { prices };
    }
    return new Response(JSON.stringify({ coins: out }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(input, init);
}) as typeof fetch;

function day(ts: number) { const d = new Date(ts * 1000); return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`; }
const T = (iso: string) => Date.parse(iso) / 1000;

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = '') { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); }

(async () => {
  const m = await import('../app/lib/claimDayPrice');
  const DEEP = '0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP';
  const CETUS = '0x6864a6f921804860930db6ddbe2e16acdf8504495ea7481637a1c8b9a8fe54b::cetus::CETUS'; // stored (stripped) form
  const idDeep = `sui:${DEEP}`;
  const idCetus = 'sui:0x06864a6f921804860930db6ddbe2e16acdf8504495ea7481637a1c8b9a8fe54b::cetus::CETUS';
  series.set(idDeep, new Map([['20260901', 0.11], ['20260902', 0.12], ['20260905', 0.15]]));
  series.set(idCetus, new Map([['20260901', 0.03]]));

  // 1. Claim day priced; two claims the same day get one price; the request is sent with the FULL address.
  await m.prewarmClaimDayPrices([{ chain: 'sui', coin: DEEP, timestamps: [T('2026-09-01T02:00:00Z'), T('2026-09-01T23:00:00Z'), T('2026-09-02T10:00:00Z')] }, { chain: 'sui', coin: CETUS, timestamps: [T('2026-09-01T05:00:00Z')] }]);
  const a = m.getClaimDayPrice('sui', DEEP, T('2026-09-01T02:00:00Z'));
  const b = m.getClaimDayPrice('sui', DEEP, T('2026-09-01T23:00:00Z'));
  check('claim day price', a?.price === 0.11 && a.basis === 'claim-day', JSON.stringify(a));
  check('one price per UTC day', b?.price === 0.11);
  check('second day', m.getClaimDayPrice('sui', DEEP, T('2026-09-02T10:00:00Z'))?.price === 0.12);
  check('leading-zero address sent in full', m.getClaimDayPrice('sui', CETUS, T('2026-09-01T05:00:00Z'))?.price === 0.03);
  check('one DeFiLlama request for both coins', llamaCalls === 1, `calls ${llamaCalls}`);

  // 2. Missing day → nearest earlier day, ≤ 3 back, marked.
  await m.prewarmClaimDayPrices([{ chain: 'sui', coin: DEEP, timestamps: [T('2026-09-04T10:00:00Z'), T('2026-09-07T10:00:00Z'), T('2026-09-09T10:00:00Z')] }]);
  const n1 = m.getClaimDayPrice('sui', DEEP, T('2026-09-04T10:00:00Z'));
  check('missing day → day before with a price (09-02, 2 back)', n1?.price === 0.12 && n1.basis === 'nearby-day' && n1.day === '20260902', JSON.stringify(n1));
  const n2 = m.getClaimDayPrice('sui', DEEP, T('2026-09-07T10:00:00Z'));
  check('09-07 → 09-05 (2 back)', n2?.price === 0.15 && n2.basis === 'nearby-day', JSON.stringify(n2));
  check('09-09 → nothing within 3 days → unpriced (null, never 0)', m.getClaimDayPrice('sui', DEEP, T('2026-09-09T10:00:00Z')) === null);
  check('nearby lookup cost one more request', llamaCalls === 3, `calls ${llamaCalls}`);

  // 3. A failed request: not remembered, falls to an earlier known day, asked again next time.
  series.get(idDeep)!.set('20260911', 0.18);
  await m.prewarmClaimDayPrices([{ chain: 'sui', coin: DEEP, timestamps: [T('2026-09-11T10:00:00Z')] }]);
  llamaFail = true;
  await m.prewarmClaimDayPrices([{ chain: 'sui', coin: DEEP, timestamps: [T('2026-09-12T10:00:00Z')] }]);
  const f = m.getClaimDayPrice('sui', DEEP, T('2026-09-12T10:00:00Z'));
  check('failed request → earlier known day (09-11), marked nearby', f?.price === 0.18 && f.basis === 'nearby-day', JSON.stringify(f));
  await m.prewarmClaimDayPrices([{ chain: 'sui', coin: CETUS, timestamps: [T('2026-09-20T10:00:00Z')] }]);
  check('failed request, nothing earlier → unpriced', m.getClaimDayPrice('sui', CETUS, T('2026-09-20T10:00:00Z')) === null);
  llamaFail = false;
  series.get(idDeep)!.set('20260912', 0.19);
  const callsBefore = llamaCalls;
  await m.prewarmClaimDayPrices([{ chain: 'sui', coin: DEEP, timestamps: [T('2026-09-12T10:00:00Z')] }]);
  const g = m.getClaimDayPrice('sui', DEEP, T('2026-09-12T10:00:00Z'));
  check('a failed day is asked again on the next load', llamaCalls > callsBefore && g?.price === 0.19 && g.basis === 'claim-day', JSON.stringify(g));

  // 4. Store: one key per coin with a day map; read once per coin; finished days only.
  const keyDeep = `claim_day_px_v1:sui:${DEEP}`;
  const stored = storeData.get(keyDeep) as Record<string, number> | undefined;
  check('stored as one day map per coin', !!stored && stored['20260901'] === 0.11 && stored['20260905'] === 0.15 && stored['20260912'] === 0.19, JSON.stringify(stored));
  check('a missing day is never stored', stored != null && !('20260904' in stored) && !('20260909' in stored));
  const getsForDeep = storeCmds.filter((c) => c === 'get').length;
  console.log(`  store commands so far: ${storeCmds.join(',')}`);

  // 5. A fresh process reads the stored map and asks DeFiLlama nothing.
  m.resetClaimDayPricesForTest();
  storeCmds.length = 0;
  const c0 = llamaCalls;
  await m.prewarmClaimDayPrices([{ chain: 'sui', coin: DEEP, timestamps: [T('2026-09-01T02:00:00Z'), T('2026-09-05T02:00:00Z')] }]);
  check('fresh process: from the store, 0 DeFiLlama requests', llamaCalls === c0 && m.getClaimDayPrice('sui', DEEP, T('2026-09-05T02:00:00Z'))?.price === 0.15);
  check('fresh process: one store read, no write', storeCmds.join(',') === 'get', storeCmds.join(','));
  await m.prewarmClaimDayPrices([{ chain: 'sui', coin: DEEP, timestamps: [T('2026-09-02T02:00:00Z')] }]);
  check('second prewarm in the same process: no store command', storeCmds.join(',') === 'get', storeCmds.join(','));

  // 6. Today before noon UTC: provisional, never stored.
  const now = Date.now() / 1000;
  const todayNoon = T(new Date().toISOString().slice(0, 10) + 'T12:00:00Z');
  if (now < todayNoon) {
    series.get(idDeep)!.set(day(now), 0.2);
    await m.prewarmClaimDayPrices([{ chain: 'sui', coin: DEEP, timestamps: [now - 600] }]);
    const t = m.getClaimDayPrice('sui', DEEP, now - 600);
    check('today before noon: priced, not stored', t?.price === 0.2 && !((storeData.get(keyDeep) as Record<string, number> | undefined)?.[day(now)]));
  } else console.log('  (today-before-noon case skipped: it is past 12:00 UTC)');

  console.log(`\n${pass} passed, ${fail} failed (store gets in the first process: ${getsForDeep})`);
  process.exit(fail ? 1 : 0);
})();
