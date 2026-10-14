// /api/prices stale-while-error (CoinGecko 429). Forced: CoinGecko is stubbed;
// the shared store is only READ (CLOSED_POS_CACHE_READONLY=1 stops the write).
//   CLOSED_POS_CACHE_READONLY=1 npx tsx scripts/prices-last-known-test.ts
import { NextRequest } from 'next/server';

export {};
let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

(async () => {
  if (process.env.CLOSED_POS_CACHE_READONLY !== '1') { console.log('set CLOSED_POS_CACHE_READONLY=1'); process.exit(2); }
  const { GET } = await import('../app/api/prices/route');
  const realFetch = globalThis.fetch;
  let cg: 'ok' | '429' | 'down' = 'ok';
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.includes('api.coingecko.com')) return realFetch(input, init);
    if (cg === 'down') throw new TypeError('fetch failed');
    if (cg === '429') return new Response('{"status":{"error_code":429}}', { status: 429 });
    return new Response(JSON.stringify({ 'zzz-test-coin': { usd: 2.5, usd_24h_change: 1.2 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const call = async (ids: string) => GET(new NextRequest(`http://x/api/prices?endpoint=simple/price&ids=${ids}&vs_currencies=usd&include_24hr_change=true`));

  console.log('1. live answer');
  let r = await call('zzz-test-coin');
  let j = await r.json();
  check('200, live price, no last-known mark', r.status === 200 && j['zzz-test-coin']?.usd === 2.5 && j['zzz-test-coin']?.last_known_at === undefined && r.headers.get('x-price-basis') === null);

  console.log('2. CoinGecko 429 after the in-process entry went stale');
  const realNow = Date.now;
  Date.now = () => realNow() + 61_000;
  cg = '429';
  r = await call('zzz-test-coin');
  j = await r.json();
  check('200 with the last known price, marked', r.status === 200 && j['zzz-test-coin']?.usd === 2.5 && typeof j['zzz-test-coin']?.last_known_at === 'number' && r.headers.get('x-price-basis') === 'last-known', JSON.stringify(j));
  check('no 24h change invented for a last known price', j['zzz-test-coin']?.usd_24h_change === undefined);

  console.log('3. CoinGecko unreachable, id never priced on this instance: shared store');
  cg = 'down';
  r = await call('bitcoin,zzz-never-priced');
  j = await r.json();
  const fromStore = typeof j.bitcoin?.usd === 'number';
  check(`answers ${fromStore ? '200 from the shared store' : '503 (no stored bitcoin price right now)'}`, fromStore ? r.status === 200 && typeof j.bitcoin.last_known_at === 'number' : r.status === 503, `${r.status} ${JSON.stringify(j).slice(0, 120)}`);
  check('an id with no last known price is left out, never 0', !('zzz-never-priced' in j));

  console.log('4. nothing known at all');
  cg = '429';
  r = await call('zzz-never-priced-a,zzz-never-priced-b');
  j = await r.json();
  check('503 "unavailable", no prices', r.status === 503 && j.unavailable === true && !('zzz-never-priced-a' in j), `${r.status} ${JSON.stringify(j)}`);
  Date.now = realNow;
  globalThis.fetch = realFetch;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
