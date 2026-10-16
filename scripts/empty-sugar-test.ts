// Queue item a (2026-10-16): an empty position list never hides history, and a
// closed list never shrinks. No network: fetch and the store are stubbed.
//   npx tsx scripts/empty-sugar-test.ts
// The live checks (Account 1's 14 burned Aerodrome positions, 76833100 replayed
// from the chain, forced 429s on the transfer index) run against a local server:
// see the `empty-sugar` entry in CLAUDE.md.

delete process.env.PRICE_CACHE_KV_REST_API_URL;
delete process.env.PRICE_CACHE_KV_REST_API_TOKEN;
process.env.NEXT_PUBLIC_ALCHEMY_KEY = 'TESTKEY';

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures += 1;
};
const W = (n: number | bigint) => BigInt(n).toString(16).padStart(64, '0');
const EMPTY_ARRAY = '0x' + W(32) + W(0); // abi-encoded empty dynamic array

function stubBase(balanceOf: 'zero' | 'one' | 'fail') {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes('base-mainnet.g.alchemy.com')) return new Response('{}', { status: 200 });
    const b = JSON.parse(String(init?.body));
    const one = (body: { method: string; params: Array<{ data?: string }> }) => {
      const data = body.params?.[0]?.data ?? '';
      if (data.startsWith('0x70a08231')) {
        if (balanceOf === 'fail') return { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'stub failure' } };
        return { jsonrpc: '2.0', id: 1, result: '0x' + W(balanceOf === 'one' ? 1 : 0) };
      }
      if (data.startsWith('0xefde4e64')) return { jsonrpc: '2.0', id: 1, result: '0x' + W(10) }; // allPoolsLength
      return { jsonrpc: '2.0', id: 1, result: EMPTY_ARRAY };                                    // the Sugar sweep
    };
    const out = Array.isArray(b) ? b.map((x, i) => ({ ...one(x), id: x.id ?? i })) : one(b);
    return new Response(JSON.stringify(out), { status: 200 });
  }) as typeof fetch;
  return () => { globalThis.fetch = real; };
}

async function openScope() {
  const { GET } = await import('../app/api/aerodrome/route');
  const ask = async (who: string) => {
    const res = await GET(new Request(`http://x/api/aerodrome?account=0x${who.repeat(40).slice(0, 40)}&scope=open`));
    return { status: res.status, body: await res.json() as { positions: unknown[]; truncated?: Array<{ reason: string; scope: string; returned: number }> } };
  };
  for (const [mode, who] of [['zero', '1'], ['one', '2'], ['fail', '3']] as const) {
    const restore = stubBase(mode);
    const r = await ask(who);
    restore();
    const reasons = (r.body.truncated ?? []).map((t) => t.reason);
    if (mode === 'zero') check('Sugar empty, NFT balance 0 (confirmed by the chain): empty list, no notice beyond the pool ceiling', r.status === 200 && r.body.positions.length === 0 && !reasons.some((x) => x.startsWith('lookup-')), reasons.join(','));
    if (mode === 'one') check('Sugar empty, wallet holds 1 NFT: a counted "not listed" notice, never a silent empty', r.status === 200 && reasons.includes('lookup-excluded:not-listed') && (r.body.truncated ?? []).find((t) => t.reason === 'lookup-excluded:not-listed')?.returned === 1, reasons.join(','));
    if (mode === 'fail') check('Sugar empty, NFT balance unreadable: a lookup notice (the empty is not confirmed)', r.status === 200 && reasons.includes('lookup-failed'), reasons.join(','));
  }
}

async function guard() {
  const { mergeClosedLists, guardClosedList } = await import('../app/lib/evmClosedListGuard');
  const rec = (id: string, extra: Record<string, unknown> = {}) => ({ id, status: 'Closed', ...extra });
  const stored = [rec('a', { poolAddress: '0xp' }), rec('b', { poolAddress: '0xq' }), rec('c')];
  let m = mergeClosedLists(stored, [rec('a', { poolAddress: '0xp' }), rec('b')]);
  check('shorter fresh list: the missing stored position is kept', m.merged.length === 3 && m.kept.map((r) => r.id).join() === 'c');
  check('a fresh record that lost its pool keeps the stored one', (m.merged.find((r) => r.id === 'b') as { poolAddress?: string }).poolAddress === '0xq');
  m = mergeClosedLists(stored, [rec('a', { poolAddress: '0xp' }), rec('b', { poolAddress: '0xq' }), rec('c'), rec('d')]);
  check('longer fresh list: grows, nothing kept from the store', m.merged.length === 4 && m.kept.length === 0);
  m = mergeClosedLists(stored, []);
  check('empty fresh list (the empty-Sugar case): every stored position kept', m.merged.length === 3 && m.kept.length === 3);

  const mem = new Map<string, string>(); const writes: string[] = [];
  const store = { get: async (k: string) => mem.get(k) ?? null, set: async (k: string, v: string) => { writes.push(k); mem.set(k, v); return 'OK'; } };
  const base = { protocol: 'aerodrome', chain: 'base', wallet: '0xABC', scope: 'Base closed-position recovery', store };
  let g = await guardClosedList({ ...base, fresh: [rec('1'), rec('2'), rec('3')] });
  check('first build is stored', g.positions.length === 3 && writes.length === 1 && g.notice === null);
  g = await guardClosedList({ ...base, fresh: [rec('1')] });
  check('a shorter build serves all 3 with a counted kept-from-store notice, and is not written', g.positions.length === 3 && g.notice?.reason === 'lookup-kept-stored' && g.notice.returned === 2 && writes.length === 1, JSON.stringify(g.notice));
  g = await guardClosedList({ ...base, fresh: [] });
  check('an empty build serves the stored list with a notice', g.positions.length === 3 && g.notice?.returned === 3);
  g = await guardClosedList({ ...base, fresh: [rec('1'), rec('2'), rec('3'), rec('4')] });
  check('a longer build is stored and has no notice', g.positions.length === 4 && writes.length === 2 && g.notice === null);
  g = await guardClosedList({ ...base, fresh: [rec('1'), rec('2'), rec('3'), rec('4')] });
  check('the same build again is not rewritten', writes.length === 2);
  g = await guardClosedList({ ...base, fresh: [rec('1'), { id: 'x', status: 'In Range' }] });
  check('open (staked) records are not stored as closed', !g.positions.some((r) => r.id === 'x') && g.positions.length === 4);
  const failing = { get: async () => { throw new Error('down'); }, set: async () => { writes.push('bad'); return 'OK'; } };
  g = await guardClosedList({ ...base, store: failing, fresh: [rec('1')] });
  check('an unreadable store: the fresh list is served and nothing is written', g.positions.length === 1 && !writes.includes('bad'));
}

(async () => {
  await openScope();
  await guard();
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();

export {};
