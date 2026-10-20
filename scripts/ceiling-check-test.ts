// Batch E (Job 1): the Sugar 2,000-pool notice clears only when the NFT history
// accounts for every NFT the wallet ever held. No network: the chain is stubbed.
//   npx tsx scripts/ceiling-check-test.ts
import { checkPoolCeilingCoverage } from '../app/lib/aerodromeCeilingCheck';

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures += 1;
};
const W = (n: number | bigint | string) => (typeof n === 'string' ? n.replace(/^0x/, '').toLowerCase() : BigInt(n).toString(16)).padStart(64, '0');

const RPC = 'https://stub.rpc/base';
const NFTM = '0x' + '11'.repeat(20);
const VOTER = '0x' + '22'.repeat(20);
const WALLET = '0x' + 'aa'.repeat(20);
const GAUGE = '0x' + '33'.repeat(20);
const POOL = '0x' + '44'.repeat(20);
const T0 = '0x' + '55'.repeat(20);
const T1 = '0x' + '66'.repeat(20);
const OTHER = '0x' + '77'.repeat(20);

interface Chain {
  owners: Record<string, string | 'burned' | 'fail'>; // tokenId → owner
  balanceOf: number | 'fail';
  gaugeStaked: string[] | 'fail';
}

function stub(c: Chain) {
  const real = globalThis.fetch;
  globalThis.fetch = (async (_i: RequestInfo | URL, init?: RequestInit) => {
    const b = JSON.parse(String(init?.body));
    const one = (body: { params: Array<{ to?: string; data?: string }> }) => {
      const to = (body.params?.[0]?.to ?? '').toLowerCase();
      const d = body.params?.[0]?.data ?? '';
      const ok = (hex: string) => ({ jsonrpc: '2.0', id: 1, result: '0x' + hex });
      const err = (m: string) => ({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: m } });
      const sel = d.slice(0, 10);
      if (to === NFTM && sel === '0x6352211e') {
        const id = BigInt('0x' + d.slice(10)).toString();
        const o = c.owners[id];
        if (o === 'burned') return err('execution reverted: ERC721: invalid token ID');
        if (o === 'fail' || !o) return err('upstream timeout');
        return ok(W(o));
      }
      if (to === NFTM && sel === '0x70a08231') return c.balanceOf === 'fail' ? err('upstream timeout') : ok(W(c.balanceOf));
      if (to === NFTM && sel === '0x99fbab88') return ok([0, 0, T0, T1, 1, 0, 100, 5000, 0, 0, 0, 0].map((x) => W(x as never)).join(''));
      if (sel === '0x16f0115b') return to === GAUGE ? ok(W(POOL)) : err('execution reverted');
      if (sel === '0x47ccca02') return to === GAUGE ? ok(W(NFTM)) : err('execution reverted');
      if (to === VOTER && sel === '0xb9a09fd5') return ok(W(GAUGE));
      if (to === POOL && sel === '0x3850c7bd') return ok(W(2n ** 96n) + W(0));
      if (to === POOL && sel === '0x0dfe1681') return ok(W(T0));
      if (to === POOL && sel === '0xd21220a7') return ok(W(T1));
      if (to === GAUGE && sel === '0x4b937763') {
        if (c.gaugeStaked === 'fail') return err('upstream timeout');
        return ok(W(32) + W(c.gaugeStaked.length) + c.gaugeStaked.map((x) => W(BigInt(x))).join(''));
      }
      return err('unknown call ' + sel);
    };
    const out = Array.isArray(b) ? b.map((x, i) => ({ ...one(x), id: x.id ?? i })) : { ...one(b), id: b.id };
    return new Response(JSON.stringify(out), { status: 200 });
  }) as typeof fetch;
  return () => { globalThis.fetch = real; };
}

async function run(name: string, c: Chain, history: { ids: string[]; complete: boolean; burned?: string[] }, shown: string[], want: boolean, reasonLike?: RegExp) {
  const restore = stub(c);
  try {
    const r = await checkPoolCeilingCoverage({
      rpc: RPC, nftManager: NFTM, voter: VOTER, account: WALLET,
      history: { ids: history.ids, complete: history.complete, burned: Object.fromEntries((history.burned ?? []).map((i) => [i, true])) },
      shownOpenIds: new Set(shown),
    });
    check(name, r.covered === want && (!reasonLike || reasonLike.test(r.reason ?? '')), `covered=${r.covered} reason=${r.reason ?? '-'} calls=${r.rpcCalls}`);
  } finally { restore(); }
}

(async () => {
  // Only burned NFTs (Account 1's shape): covered, plain total.
  await run('all burned → covered', { owners: {}, balanceOf: 0, gaugeStaked: [] }, { ids: ['1', '2', '3'], complete: true, burned: ['1', '2', '3'] }, [], true);
  // Burned after the history was read: ownerOf reverts → burned, covered.
  await run('burned since history → covered', { owners: { '4': 'burned' }, balanceOf: 0, gaugeStaked: [] }, { ids: ['4'], complete: true }, [], true);
  // One held in the wallet + one staked in a verified gauge, both shown.
  await run('held + staked, both listed → covered', { owners: { '5': WALLET, '6': GAUGE }, balanceOf: 1, gaugeStaked: ['6'] }, { ids: ['5', '6'], complete: true }, ['5', '6'], true);
  // Transferred to somebody else: not this wallet's, covered.
  await run('transferred away → covered', { owners: { '7': OTHER }, balanceOf: 0, gaugeStaked: [] }, { ids: ['7'], complete: true }, [], true);
  // Must keep the notice:
  await run('history incomplete → kept', { owners: {}, balanceOf: 0, gaugeStaked: [] }, { ids: [], complete: false }, [], false, /history/);
  await run('ownerOf read fails → kept', { owners: { '8': 'fail' }, balanceOf: 0, gaugeStaked: [] }, { ids: ['8'], complete: true }, [], false, /could not be read/);
  await run('balanceOf read fails → kept', { owners: {}, balanceOf: 'fail', gaugeStaked: [] }, { ids: ['1'], complete: true, burned: ['1'] }, [], false, /balanceOf could not/);
  await run('balanceOf above history → kept', { owners: {}, balanceOf: 1, gaugeStaked: [] }, { ids: ['1'], complete: true, burned: ['1'] }, [], false, /balanceOf 1/);
  await run('gauge lists one the history lacks → kept', { owners: { '6': GAUGE }, balanceOf: 0, gaugeStaked: ['6', '9'] }, { ids: ['6'], complete: true }, ['6'], false, /gauge/);
  await run('gauge read fails → kept', { owners: { '6': GAUGE }, balanceOf: 0, gaugeStaked: 'fail' }, { ids: ['6'], complete: true }, ['6'], false, /gauge/);
  await run('held but not listed → kept', { owners: { '5': WALLET }, balanceOf: 1, gaugeStaked: [] }, { ids: ['5'], complete: true }, [], false, /not listed/);
  await run('staked but not listed → kept', { owners: { '6': GAUGE }, balanceOf: 0, gaugeStaked: ['6'] }, { ids: ['6'], complete: true }, [], false, /not listed/);
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
