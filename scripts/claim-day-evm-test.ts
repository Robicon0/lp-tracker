// npx tsx scripts/claim-day-evm-test.ts
//
// Oct 18 batch, against a stubbed DeFiLlama and store (nothing leaves this process):
//   (2a) Uniswap / PancakeSwap fee claims (app/lib/evmClaimPrice.ts): claim day,
//        nearby day marked, no price → null (never spot, never $0), BNB → `bsc`.
//   (2b) Sui bridged ETH with no own price → the ETH day price, marked
//        `underlying` (app/lib/suiClaimPrice.ts).
//   (4)  The unpriceable memo (app/lib/unpriceableMemo.ts): remembered for 6 h,
//        then re-checked; a priced position is forgotten.

process.env.PRICE_CACHE_KV_REST_API_URL = 'https://store.test';
process.env.PRICE_CACHE_KV_REST_API_TOKEN = 't';
process.env.VERCEL_ENV = 'production';

const series = new Map<string, Map<string, number>>(); // llama id → day → price
const asked: string[] = [];
const storeData = new Map<string, unknown>();
let cgUp = false; let cgAsked = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.startsWith('https://store.test')) {
    const body = JSON.parse(String(init?.body ?? '[]'));
    const run = (c: string[]) => {
      const cmd = String(c[0]).toLowerCase();
      if (cmd === 'get') return { result: storeData.has(c[1]) ? JSON.stringify(storeData.get(c[1])) : null };
      if (cmd === 'set') { storeData.set(c[1], JSON.parse(c[2])); return { result: 'OK' }; }
      return { result: null };
    };
    const out = Array.isArray(body[0]) ? body.map(run) : run(body);
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url.startsWith('https://coins.llama.fi/batchHistorical')) {
    const coins = JSON.parse(decodeURIComponent(new URL(url).searchParams.get('coins')!)) as Record<string, number[]>;
    const out: Record<string, { prices: Array<{ timestamp: number; price: number }> }> = {};
    for (const [id, tss] of Object.entries(coins)) {
      asked.push(id);
      const s = series.get(id.toLowerCase());
      out[id] = { prices: tss.flatMap((ts) => { const p = s?.get(day(ts)); return p != null ? [{ timestamp: ts + 5, price: p }] : []; }) };
    }
    return new Response(JSON.stringify({ coins: out }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url.includes('coingecko')) {
    cgAsked += 1;
    if (!cgUp) return new Response('{}', { status: 429 });
    // CoinGecko answering with a DIFFERENT price than DeFiLlama (2.5016 vs 2.6158, measured 10-18)
    return new Response(JSON.stringify({ market_data: { current_price: { usd: 2.5016 } }, prices: [[Date.now(), 2.5016]] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(input, init);
}) as typeof fetch;

function day(ts: number) { const d = new Date(ts * 1000); return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`; }
const T = (iso: string) => Date.parse(iso) / 1000;
let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = '') { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); }

(async () => {
  const { prewarmEvmClaimPrices, priceEvmFeeClaim } = await import('../app/lib/evmClaimPrice');
  // ── (2a) Uniswap on Arbitrum: WETH / USDC
  const WETH_ARB = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', USDC_ARB = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
  series.set(`arbitrum:${WETH_ARB}`, new Map([['20260120', 3300], ['20260127', 3100]]));
  const sides = { chain: 'arbitrum', token0: WETH_ARB, token1: USDC_ARB, isStable0: false, isStable1: true };
  const c1 = T('2026-01-20T08:00:00Z'), c2 = T('2026-01-29T20:00:00Z'), c3 = T('2026-03-15T10:00:00Z');
  await prewarmEvmClaimPrices(sides, [c1, c2, c3]);
  let r = priceEvmFeeClaim(sides, 0.01, 10, c1);
  check('uniswap: claim day price × amount + stable $1', r.usd != null && Math.abs(r.usd - (0.01 * 3300 + 10)) < 1e-9 && r.src === 'claim-day' && !r.nearby, `usd ${r.usd}`);
  r = priceEvmFeeClaim(sides, 0.01, 10, c2);
  check('uniswap: no price on the day → earlier day (2 back), MARKED nearby', r.usd != null && Math.abs(r.usd - (0.01 * 3100 + 10)) < 1e-9 && r.nearby && r.src === 'nearby-day', `usd ${r.usd}`);
  r = priceEvmFeeClaim(sides, 0.01, 10, c3);
  check('uniswap: no price within 3 days → null, never spot, never $0', r.usd === null && r.price0 === null && !r.nearby);
  r = priceEvmFeeClaim(sides, 0, 10, c3);
  check('uniswap: a side with no amount needs no price', r.usd === 10, `usd ${r.usd}`);
  r = priceEvmFeeClaim(sides, 0.01, 10, 0);
  check('uniswap: an undated claim stays unpriced (counted), never 1970', r.usd === null);
  check('uniswap: the stable side is never asked for', !asked.some((id) => id.includes(USDC_ARB)));
  // ── PancakeSwap on BNB
  const CAKE = '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82', USDT_BNB = '0x55d398326f99059ff775485246999027b3197955';
  series.set(`bsc:${CAKE}`, new Map([['20250601', 2.5]]));
  const pan = { chain: 'bnb', token0: CAKE, token1: USDT_BNB, isStable0: false, isStable1: true };
  await prewarmEvmClaimPrices(pan, [T('2025-06-01T23:00:00Z')]);
  r = priceEvmFeeClaim(pan, 4, 1, T('2025-06-01T23:00:00Z'));
  check('pancakeswap: BNB claims are priced on DeFiLlama chain "bsc"', r.usd === 11 && asked.includes(`bsc:${CAKE}`), `usd ${r.usd}`);
  check('claim days stored per coin (bnb key)', storeData.has(`claim_day_px_v1:bnb:${CAKE}`) && (storeData.get(`claim_day_px_v1:bnb:${CAKE}`) as Record<string, number>)['20250601'] === 2.5);
  check('an unknown chain is never priced', priceEvmFeeClaim({ ...sides, chain: 'fantom' }, 1, 1, c1).usd === null);

  // ── (2b) Sui bridged ETH → ETH day price, marked underlying
  const { prewarmSuiClaimPrices, priceSuiClaimSide } = await import('../app/lib/suiClaimPrice');
  const BETH = '0xd0e89b2af5e4910726fbcd8b8dd37bb79b29e5f83f7491bca830e94f7f226d29::eth::ETH';
  const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
  series.set(`ethereum:${WETH}`, new Map([['20250123', 3330]]));
  series.set(`sui:${BETH.toLowerCase()}`, new Map([['20250601', 2600]]));
  const tGap = T('2025-01-23T10:00:00Z'), tOwn = T('2025-06-01T10:00:00Z');
  await prewarmSuiClaimPrices([{ coinType: BETH, isStable: false, isSui: false, ts: tGap }, { coinType: BETH, isStable: false, isSui: false, ts: tOwn }]);
  let sp = priceSuiClaimSide(BETH, false, false, tGap);
  check('sui bridged ETH: no own price → ETH day price, marked underlying', sp.price === 3330 && sp.nearby && sp.underlying === true, JSON.stringify(sp));
  sp = priceSuiClaimSide(BETH, false, false, tOwn);
  check('sui bridged ETH: its own price wins when it has one (not marked)', sp.price === 2600 && !sp.nearby && !sp.underlying, JSON.stringify(sp));
  check('the underlying asset is asked only for the gap day', asked.filter((id) => id === `ethereum:${WETH}`).length === 1);
  const DEEP = '0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP';
  await prewarmSuiClaimPrices([{ coinType: DEEP, isStable: false, isSui: false, ts: tGap }]);
  sp = priceSuiClaimSide(DEEP, false, false, tGap);
  check('a coin with no underlying stays unpriced', sp.price === null);

  // ── (1b) SUI claims: the stored day map only — CoinGecko up or down gives the same figure
  const SUI = '0x2::sui::SUI';
  series.set('sui:0x0000000000000000000000000000000000000000000000000000000000000002::sui::sui', new Map([['20251019', 2.6157498500736023]]));
  series.set('sui:0x2::sui::sui', new Map([['20251019', 2.6157498500736023]]));
  const tClaim = T('2025-10-19T23:57:31Z');
  const readSui = async (up: boolean) => { cgUp = up; await prewarmSuiClaimPrices([{ coinType: SUI, isStable: false, isSui: true, ts: tClaim }]); return priceSuiClaimSide(SUI, false, true, tClaim); };
  const down = await readSui(false), up = await readSui(true);
  check('SUI claim: CoinGecko down and CoinGecko up give the identical price (day map)', down.price != null && down.price === up.price && Math.abs((down.price as number) - 2.6157498500736023) < 1e-12, `down ${down.price} up ${up.price}`);
  check('SUI claim: 0x15ac 2025-10-19 Bluefin claim = 1.590032743 × 2.6158 + 3.99701 = 8.16', Math.abs(1.590032743 * (up.price as number) + 3.99701 - 8.156) < 0.01);
  check('SUI claim: CoinGecko is never asked for a claim price', cgAsked === 0, `asked ${cgAsked}`);

  // ── (4) unpriceable memo
  const { isRememberedUnpriceable, rememberUnpriceable, forgetUnpriceable, UNPRICEABLE_MEMO_MS } = await import('../app/lib/unpriceableMemo');
  const mem = new Map<string, string>();
  const st = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); }, removeItem: (k: string) => { mem.delete(k); } };
  const now = 1_800_000_000_000;
  check('memo: unknown position is retried', !isRememberedUnpriceable('p1', now, st));
  rememberUnpriceable(['p1', 'p2'], now, st);
  check('memo: after the schedule ran out, not retried for 6 h', isRememberedUnpriceable('p1', now + UNPRICEABLE_MEMO_MS - 1, st));
  check('memo: at 6 h it is re-checked (and the entry dropped)', !isRememberedUnpriceable('p1', now + UNPRICEABLE_MEMO_MS, st) && !mem.has('lp-pnl-unpriceable-v1-p1'));
  forgetUnpriceable(['p2'], st);
  check('memo: a position that got a price is forgotten at once', !isRememberedUnpriceable('p2', now + 1, st));
  const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
  rememberUnpriceable(['p3'], now, broken);
  check('memo: blocked storage never throws and means "retry"', !isRememberedUnpriceable('p3', now, broken));
  check('memo: no storage at all means "retry"', !isRememberedUnpriceable('p1', now, null));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

export {};
