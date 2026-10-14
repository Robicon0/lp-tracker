// Shared DeFiLlama pool list (defillamaPools.ts) and Orca per-pool statistics
// (orcaPoolStats.ts). Upstream is stubbed; run WITHOUT the store env so nothing
// is read from or written to the shared store.
//   npx tsx scripts/pool-lists-test.ts
export {};
let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

(async () => {
  if (process.env.PRICE_CACHE_KV_REST_API_URL) { console.log('run without the store env'); process.exit(2); }
  const { getLlamaPools, llamaPoolsNotices, _resetLlamaPoolsMemory } = await import('../app/lib/defillamaPools');
  const { fetchOrcaPoolStats, _resetOrcaPoolStats } = await import('../app/lib/orcaPoolStats');
  const realFetch = globalThis.fetch;
  const realNow = Date.now;
  let llama: 'ok' | 'down' | 'short' = 'ok';
  let orca: 'ok' | 'down' | '429-once' = 'ok';
  const calls = { llama: 0, orca: 0, orcaUrls: [] as string[] };
  let orcaThrottled = false;
  const big = (n: number) => Array.from({ length: n }, (_, i) => ({
    project: i % 3 === 0 ? 'cetus-clmm' : i % 3 === 1 ? 'uniswap-v3' : 'some-other-dex',
    chain: 'Sui', symbol: `A${i}-B`, pool: `p${i}`, underlyingTokens: ['0x2::sui::SUI', '0xabc::usdc::USDC'],
    apy: 10 + i, apyBase: 5 + i, tvlUsd: 1000 * i, volumeUsd1d: 7, extra: 'x'.repeat(50),
  }));
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('https://yields.llama.fi/pools')) {
      calls.llama++;
      if (llama === 'down') throw new TypeError('fetch failed');
      return new Response(JSON.stringify({ data: big(llama === 'short' ? 50 : 3000) }), { status: 200 });
    }
    if (url.startsWith('https://api.orca.so/v2/solana/pools')) {
      calls.orca++; calls.orcaUrls.push(url);
      if (orca === 'down') return new Response('{}', { status: 500 });
      if (orca === '429-once' && !orcaThrottled) { orcaThrottled = true; return new Response('', { status: 429 }); }
      const addrs = new URL(url).searchParams.get('addresses')!.split(',');
      return new Response(JSON.stringify({ data: addrs.filter((a) => a !== 'gone').map((a) => ({ address: a, tvlUsdc: '1000000', stats: { '7d': { fees: '7000' } } })) }), { status: 200 });
    }
    throw new Error('unexpected fetch ' + url.slice(0, 40));
  }) as typeof fetch;

  console.log('1. DeFiLlama list: fetched once, cut to the tracked projects, shared');
  _resetLlamaPoolsMemory();
  const a = await getLlamaPools(['cetus-clmm']);
  check('live, only the asked project, only the nine fields', a.basis === 'live' && a.pools.length === 1000 && a.pools.every((p) => p.project === 'cetus-clmm') && !('extra' in a.pools[0]));
  const b = await getLlamaPools(['uniswap-v3']);
  check('a second route within 30 minutes: no new download', calls.llama === 1 && b.pools.length === 1000 && b.basis === 'live');
  check('live figures: no notice', llamaPoolsNotices(['cetus-clmm']).length === 0);
  const [c1, c2] = await Promise.all([(async () => { Date.now = () => realNow() + 31 * 60_000; return getLlamaPools(['cetus-clmm']); })(), getLlamaPools(['cetus-clmm'])]);
  check('after 30 minutes: read again, overlapping requests share one download', calls.llama === 2 && c1.basis === 'live' && c2.basis === 'live', String(calls.llama));

  console.log('2. DeFiLlama down');
  Date.now = () => realNow() + 62 * 60_000;
  llama = 'down';
  const d = await getLlamaPools(['cetus-clmm']);
  check('stale copy served as LAST KNOWN, never dropped', d.basis === 'last-known' && d.pools.length === 1000 && typeof d.at === 'number');
  check('notice: last known (information, not a gap)', llamaPoolsNotices(['cetus-clmm'])[0]?.reason === 'pool-stats-last-known');
  _resetLlamaPoolsMemory();
  const e = await getLlamaPools(['cetus-clmm']);
  check('nothing known: unavailable, no pools', e.basis === 'unavailable' && e.pools.length === 0);
  check('notice: unavailable', llamaPoolsNotices(['cetus-clmm'])[0]?.reason === 'pool-stats-unavailable');
  llama = 'short';
  const f = await getLlamaPools(['cetus-clmm']);
  check('a short answer (50 pools) is not taken as the list', f.basis === 'unavailable');
  Date.now = realNow;

  console.log('3. Orca: only the wallet\'s pools, by address');
  _resetOrcaPoolStats();
  const o = await fetchOrcaPoolStats(['poolA', 'poolB']);
  check('one request for the two pools, nothing else', calls.orca === 1 && /addresses=poolA,poolB$/.test(calls.orcaUrls[0]));
  check('fee APR = 7-day fees / TVL, annualized', !o.failed && Math.abs(o.stats.poolA.feeAprWeek - (7000 / 1e6) * (365 / 7)) < 1e-12 && o.stats.poolA.tvl === 1e6);
  await fetchOrcaPoolStats(['poolA']);
  check('asked again within 5 minutes: no request', calls.orca === 1);
  const many = Array.from({ length: 60 }, (_, i) => `m${i}`);
  const before = calls.orca;
  await Promise.all([fetchOrcaPoolStats(many), fetchOrcaPoolStats(many)]);
  check('60 pools: 3 requests of 25, shared by overlapping callers', calls.orca - before === 3, String(calls.orca - before));
  const g = await fetchOrcaPoolStats(['gone']);
  check('a pool the API does not list: no APR, not a failure', !g.failed && !g.stats.gone);
  orca = '429-once'; _resetOrcaPoolStats();
  const t = await fetchOrcaPoolStats(['poolC']);
  check('one throttle (429) is retried once', !t.failed && !!t.stats.poolC);
  orca = 'down'; _resetOrcaPoolStats();
  const h = await fetchOrcaPoolStats(['poolD']);
  check('lookup fails: reported failed (route adds the notice), no APR', h.failed && !h.stats.poolD);

  globalThis.fetch = realFetch;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
