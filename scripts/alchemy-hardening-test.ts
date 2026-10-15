// Alchemy hardening (2026-10-15): PancakeSwap reply checks, contract-wallet scan
// reuse, the shared-store guard and the token-metadata cache. No network: fetch
// and the store are stubbed. Run: npx tsx scripts/alchemy-hardening-test.ts

// The store must not be reached from a test: unset it before any module loads.
delete process.env.PRICE_CACHE_KV_REST_API_URL;
delete process.env.PRICE_CACHE_KV_REST_API_TOKEN;
process.env.NEXT_PUBLIC_ALCHEMY_KEY = 'TESTKEY';

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures += 1;
};

const W = (n: bigint | number) => BigInt(n).toString(16).padStart(64, '0');
const ACCOUNT = '0x1111111111111111111111111111111111111111';
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const USDT = '0x55d398326f99059ff775485246999027b3197955';
const addrWord = (a: string) => '0'.repeat(24) + a.slice(2);
// positions(): nonce, operator, token0, token1, fee, tickLower, tickUpper, liquidity, fg0, fg1, owed0, owed1
const POSITION = '0x' + [W(0), W(0), addrWord(WBNB), addrWord(USDT), W(500), W(BigInt(-1000) & ((1n << 256n) - 1n)), W(1000), W(10n ** 18n), W(0), W(0), W(0), W(0)].join('');

type Mode = 'good' | 'empty' | 'empty-once' | 'http-502' | 'bad-json' | 'no-result';
function bnbStub(mode: Mode) {
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes('bnb-mainnet.g.alchemy.com')) return new Response('{}', { status: 200 }); // prices / pool list: empty
    calls++;
    const m = mode === 'empty-once' ? (calls === 1 ? 'empty' : 'good') : mode;
    if (m === 'empty') return new Response('', { status: 200 });
    if (m === 'http-502') return new Response('Bad Gateway', { status: 502 });
    if (m === 'bad-json') return new Response('<html>oops', { status: 200 });
    if (m === 'no-result') return new Response('{"jsonrpc":"2.0","id":1}', { status: 200 });
    const b = JSON.parse(String(init?.body));
    const data: string = b.params[0].data;
    const result = data.startsWith('0x70a08231') ? '0x' + W(1)          // balanceOf → 1 position
      : data.startsWith('0x2f745c59') ? '0x' + W(4242)                  // tokenOfOwnerByIndex
      : data.startsWith('0x99fd0e82') ? POSITION
      : '0x';
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 });
  }) as typeof fetch;
  return { restore: () => { globalThis.fetch = realFetch; }, calls: () => calls };
}

async function pancake() {
  const { GET } = await import('../app/api/pancakeswap/route');
  const ask = () => GET(new Request(`http://x/api/pancakeswap?account=${ACCOUNT}`));
  for (const mode of ['good', 'empty-once', 'empty', 'http-502', 'bad-json', 'no-result'] as Mode[]) {
    const stub = bnbStub(mode);
    const res = await ask();
    const j = await res.json() as { positions?: unknown[]; error?: string; protocol?: string };
    stub.restore();
    if (mode === 'good' || mode === 'empty-once') {
      check(`PancakeSwap, BNB reply ${mode}: 200 with the position`, res.status === 200 && j.positions?.length === 1, `status ${res.status}, positions ${j.positions?.length}, RPC calls ${stub.calls()}`);
    } else {
      check(`PancakeSwap, BNB reply ${mode}: named 503, never a bare 500 or an empty list`, res.status === 503 && j.error === 'position-list-read-failed' && j.protocol === 'PancakeSwap' && !Array.isArray(j.positions), `status ${res.status} ${JSON.stringify(j).slice(0, 80)}, RPC calls ${stub.calls()}`);
    }
  }
}

async function reuse() {
  const { storedScanReuse } = await import('../app/lib/evmAssetTransferHistory');
  const now = 10_000_000;
  const base = { settled: true, pending: [] as string[], at: now - 60_000 };
  check('contract wallet, settled scan 1 min old → reused', storedScanReuse({ ...base, eoa: false }, now, null) === 'contract-recent');
  check('contract wallet, scan 4 min old → rescanned', storedScanReuse({ ...base, eoa: false, at: now - 4 * 60_000 }, now, null) === null);
  check('contract wallet, scan not settled → rescanned', storedScanReuse({ ...base, eoa: false, settled: false }, now, null) === null);
  check('contract wallet, receipts pending → rescanned', storedScanReuse({ ...base, eoa: false, pending: ['0xabc'] }, now, null) === null);
  check('EOA, same fingerprint → reused', storedScanReuse({ ...base, eoa: true, sig: '0x5:0x1' }, now, '0x5:0x1') === 'eoa-unchanged');
  check('EOA, new transaction → rescanned', storedScanReuse({ ...base, eoa: true, sig: '0x5:0x1' }, now, '0x6:0x1') === null);
  check('EOA, fingerprint unreadable → rescanned', storedScanReuse({ ...base, eoa: true, sig: '0x5:0x1' }, now, null) === null);
  check('EOA is never reused on age alone', storedScanReuse({ ...base, eoa: true }, now, null) === null);
  check('unknown wallet kind → rescanned', storedScanReuse({ ...base }, now, null) === null);
}

async function store() {
  const { sharedStoreMode, overlayStore } = await import('../app/lib/sharedStore');
  check('VERCEL_ENV=production writes', sharedStoreMode({ VERCEL_ENV: 'production' }) === 'write');
  check('VERCEL_ENV=preview does not write', sharedStoreMode({ VERCEL_ENV: 'preview' }) === 'overlay');
  check('VERCEL_ENV=development does not write', sharedStoreMode({ VERCEL_ENV: 'development' }) === 'overlay');
  check('VERCEL_ENV unset (local) does not write', sharedStoreMode({}) === 'overlay');
  check('an unknown VERCEL_ENV value does not write', sharedStoreMode({ VERCEL_ENV: 'Production ' }) === 'overlay');
  check('explicit maintenance override writes', sharedStoreMode({ SHARED_STORE_WRITES: 'allow-nonproduction' }) === 'write');

  const written: string[] = [];
  const backing: Record<string, unknown> = { 'k:prod': { v: 1 }, 'k:del': 'x' };
  const real = {
    get: async (k: string) => backing[k] ?? null,
    mget: async (...ks: string[]) => ks.map((k) => backing[k] ?? null),
    set: async (k: string, ..._rest: unknown[]) => { written.push('set ' + k + _rest.length); return 'OK'; },
    del: async (...ks: unknown[]) => { written.push('del ' + ks.join(',')); return 1; },
    incrby: async (k: string) => { written.push('incrby ' + k); return 1; },
  };
  const o = overlayStore(real, 'test');
  check('overlay: a miss is read from the store', JSON.stringify(await o.get('k:prod')) === '{"v":1}');
  await o.set('k:new', { a: 1 }, { ex: 60 });
  check('overlay: a write is read back in the same process', JSON.stringify(await o.get('k:new')) === '{"a":1}');
  check('overlay: nx on a key it holds is refused', (await o.set('k:new', 'z', { nx: true })) === null);
  await o.del('k:del');
  check('overlay: a deleted key reads as missing', (await o.get('k:del')) === null);
  check('overlay: mget merges overlay and store', JSON.stringify(await o.mget('k:new', 'k:prod', 'k:del')) === '[{"a":1},{"v":1},null]');
  await o.set('k:str', 'plain');
  check('overlay: a string comes back as stored', (await o.get('k:str')) === 'plain');
  check('overlay: an unknown command is refused', (await (o as unknown as { incrby: (k: string) => Promise<unknown> }).incrby('k')) === null);
  check('overlay: nothing reached the store', written.length === 0, written.join(','));
}

async function tokenMeta() {
  const { getCachedTokenMeta, setCachedTokenMeta } = await import('../app/lib/tokenMetaCache');
  setCachedTokenMeta('bnb', '0xAbC', { symbol: 'ABC', decimals: 9 });
  const hit = await getCachedTokenMeta('bnb', '0xabc');
  check('token metadata: stored once, read back by any case of the address', hit?.decimals === 9 && hit.symbol === 'ABC');
  setCachedTokenMeta('bnb', '0xdef', { symbol: '', decimals: 9 });
  setCachedTokenMeta('bnb', '0x123', { symbol: 'X', decimals: 77 });
  check('token metadata: an incomplete or impossible answer is never stored', (await getCachedTokenMeta('bnb', '0xdef')) === null && (await getCachedTokenMeta('bnb', '0x123')) === null);
}

(async () => {
  await pancake();
  await reuse();
  await store();
  await tokenMeta();
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
