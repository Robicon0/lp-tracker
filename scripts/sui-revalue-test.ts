// Sui: the coin type sent to DeFiLlama keeps its leading zero, and a stored
// closed record that still has an unpriced event is valued again with ONLY its
// gaps filled. Forced cases; no chain, no store.
//   npx tsx scripts/sui-revalue-test.ts
delete process.env.PRICE_CACHE_KV_REST_API_URL;
delete process.env.PRICE_CACHE_KV_REST_API_TOKEN;

export {};
let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function main() {
  const { normalizeSuiType, suiTypeFullAddress, defillamaRequestId } = await import('../app/lib/tokenConstants');
  const { fetchDefillamaPriceAtDate, fetchDefillamaPriceAtTime } = await import('../app/lib/defillamaPriceHistory');
  const { fillUnpricedFromFresh, suiClosedWeight, unpricedEventCount } = await import('../app/lib/suiClosedPositions');
  const { mergeClosedPositions, loadClosedPositionsGuarded } = await import('../app/lib/closedPositionCache');
  type Pos = Parameters<typeof fillUnpricedFromFresh>[0];

  console.log('1. the identifier sent to DeFiLlama');
  const CETUS = '0x06864a6f921804860930db6ddbe2e16acdf8504495ea7481637a1c8b9a8fe54b::cetus::CETUS';
  const stripped = normalizeSuiType(CETUS);
  check('the stored form has the zero stripped (unchanged)', stripped === '0x6864a6f921804860930db6ddbe2e16acdf8504495ea7481637a1c8b9a8fe54b::cetus::CETUS');
  check('the request form restores it', suiTypeFullAddress(stripped) === CETUS && defillamaRequestId('sui', stripped) === CETUS);
  check('a full address is left as it is', suiTypeFullAddress(CETUS) === CETUS);
  check('SUI is written in full too', suiTypeFullAddress('0x2::sui::SUI') === `0x${'0'.repeat(63)}2::sui::SUI`);
  check('a nested type keeps its inner address', suiTypeFullAddress('0xabc::m::T<0x2::sui::SUI>') === `0x${'abc'.padStart(64, '0')}::m::T<0x2::sui::SUI>`);
  check('other chains are sent unchanged', defillamaRequestId('solana', 'So11111111111111111111111111111111111111112') === 'So11111111111111111111111111111111111111112' && defillamaRequestId('base', '0x0abc') === '0x0abc');
  const urls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (u: unknown) => { urls.push(String(u)); return new Response(JSON.stringify({ coins: { x: { price: 0.0183, timestamp: 1_785_000_000 } } }), { status: 200 }); }) as typeof fetch;
  const day = await fetchDefillamaPriceAtDate('sui', stripped, 1_785_000_000);
  const exact = await fetchDefillamaPriceAtTime('sui', stripped, 1_785_000_100);
  globalThis.fetch = realFetch;
  check('the day-price request carries the full address', urls.some((u) => u.includes(`/sui:${CETUS}?searchWidth=24h`)), urls[0]);
  check('the exact-time request carries the full address', urls.some((u) => u.includes(`/sui:${CETUS}?searchWidth=1h`)), urls[1]);
  check('both return the price', day.price === 0.0183 && exact === 0.0183);

  console.log('2. filling only the gaps of a stored record');
  type Ev = Pos['events'][number];
  const ev = (type: 'deposit' | 'withdrawal' | 'fee_claim', usd: number | null, i: number, p0: number | null = usd == null ? null : 1): Ev =>
    ({ type, timestamp: 1_700_000_000 + i, amount0: 10, amount1: 5, usdAtTime: usd, price0AtTime: p0, price1AtTime: usd == null ? null : 1, txHash: `tx${i}` });
  const pos = (events: Ev[], extra: Partial<Pos> = {}): Pos => ({
    positionId: 'P', protocol: 'cetus', chain: 'Sui', pair: 'CETUS / SUI', poolId: 'pool', coinTypeA: 'a', coinTypeB: 'b',
    openedTs: 1, closedTs: 2, depositUSD: 0, withdrawalUSD: 0, feesUSD: 0, capitalGL: 0,
    pendingEventCount: events.filter((e) => e.usdAtTime == null).length, events, sourceBreakdown: { pending: 1 }, ...extra,
  } as Pos);
  const stored = pos([ev('deposit', null, 0), ev('fee_claim', 3.21, 1), ev('withdrawal', 90, 2), ev('fee_claim', null, 3)], { withdrawalUSD: 90, feesUSD: 3.21, capitalGL: 90 });
  const fresh = pos([ev('deposit', 100, 0), ev('fee_claim', 3.3, 1), ev('withdrawal', 91.5, 2), ev('fee_claim', null, 3)], { sourceBreakdown: { 'defillama-historical': 3, pending: 1 } });
  const out = fillUnpricedFromFresh(stored, fresh);
  check('the unpriced deposit takes the fresh value', out.events[0].usdAtTime === 100);
  check('events that already had a value keep it to the cent', out.events[1].usdAtTime === 3.21 && out.events[2].usdAtTime === 90);
  check('an event still without a price stays unpriced', out.events[3].usdAtTime === null && out.pendingEventCount === 1);
  check('totals are recomputed from the events', out.depositUSD === 100 && out.withdrawalUSD === 90 && out.feesUSD === 3.21 && out.capitalGL === -10);
  check('nothing to fill returns the stored record itself', fillUnpricedFromFresh(stored, pos(stored.events.map((e) => ({ ...e })))) === stored);
  const longer = pos([...fresh.events, ev('fee_claim', 1, 4)]);
  check('a fresh record with more events replaces the stored one whole', fillUnpricedFromFresh(stored, longer) === longer);
  const shifted = pos(fresh.events.map((e, i) => (i === 2 ? { ...e, txHash: 'other' } : e)));
  check('events that do not line up: the fresh record is used whole', fillUnpricedFromFresh(stored, shifted) === shifted);

  console.log('3. never-shrink merge with the new weight');
  check('more priced events outweighs fewer', suiClosedWeight(out) > suiClosedWeight(stored) && unpricedEventCount(out) === 1 && unpricedEventCount(stored) === 2);
  check('a priced fraction never outweighs an extra event', suiClosedWeight(pos([ev('deposit', null, 0), ev('withdrawal', null, 1), ev('fee_claim', null, 2)])) > suiClosedWeight(pos([ev('deposit', 1, 0), ev('withdrawal', 1, 1)])));
  const id = (p: Pos) => p.positionId;
  check('the filled record replaces the stored one', mergeClosedPositions([stored], [out], id, suiClosedWeight)[0] === out);
  check('a record with FEWER priced events never replaces the stored one', mergeClosedPositions([out], [stored], id, suiClosedWeight)[0] === out);
  check('an equally priced record does not replace the stored one', mergeClosedPositions([out], [{ ...out }], id, suiClosedWeight)[0] === out);

  console.log('4. when a stored list is valued again');
  const mem = () => { const m = new Map<string, string>(); return { m, get: async (k: string) => m.get(k) ?? null, set: async (k: string, v: string) => { m.set(k, v); }, ttl: async () => -1, persist: async () => {} }; };
  const B = mem();
  let slot = 100, scans = 0;
  const mark = (list: readonly Pos[]) => (list.some((x) => unpricedEventCount(x) > 0) ? `h:unpriced:${slot}` : 'h');
  const priced = pos([ev('deposit', 100, 0), ev('withdrawal', 90, 1)], { positionId: 'Q' });
  const run = (scan: (cached: Pos[]) => Pos[], complete = true) => loadClosedPositionsGuarded<Pos>({
    backend: B, slots: [{ name: 'cetus', key: 'k' }], idOf: id, weightOf: suiClosedWeight, isValid: () => true,
    emptyTtlSeconds: null, legacyTtlSeconds: 1, mark, storePartial: true,
    scan: async (cached) => { scans += 1; return { bySlot: { cetus: scan(cached.cetus) }, complete }; },
  });
  B.m.set('k', JSON.stringify([priced])); B.m.set('closed_pos_meta_v1:k', JSON.stringify({ refreshedAt: Date.now(), mark: 'h' }));
  await run(() => []);
  check('a list with no unpriced event is not scanned again (stored mark unchanged)', scans === 0);
  B.m.set('k', JSON.stringify([priced, stored]));
  const r1 = await run((cached) => cached.filter((x) => unpricedEventCount(x) > 0).map((x) => fillUnpricedFromFresh(x, fresh)));
  check('a list holding an unpriced record is scanned on the first load', scans === 1 && r1.scanned);
  check('the filled record is stored, the priced one untouched', unpricedEventCount(r1.bySlot.cetus[1]) === 1 && JSON.stringify(r1.bySlot.cetus[0]) === JSON.stringify(priced));
  await run(() => []);
  check('still one unpriced event: not scanned again in the same time slot', scans === 1);
  slot = 101;
  const r2 = await run((cached) => cached.filter((x) => unpricedEventCount(x) > 0).map((x) => fillUnpricedFromFresh(x, pos(x.events.map((e) => (e.usdAtTime == null ? { ...e, usdAtTime: 2, price0AtTime: 1, price1AtTime: 1 } : e))))));
  check('scanned again in the next time slot; now fully priced', scans === 2 && unpricedEventCount(r2.bySlot.cetus[1]) === 0);
  slot = 102;
  await run(() => []);
  check('fully priced: no further scans', scans === 2);
  B.m.set('k', JSON.stringify([priced, stored])); B.m.set('closed_pos_meta_v1:k', JSON.stringify({ refreshedAt: Date.now(), mark: 'h' }));
  const r3 = await run(() => [], false);
  check('a scan cut short keeps every stored record and reports itself incomplete', r3.incomplete && r3.bySlot.cetus.length === 2 && JSON.parse(B.m.get('k')!).length === 2);

  console.log('5. re-valuing from the stored record itself (history no longer carries the events)');
  {
    const { revalueStoredRecord } = await import('../app/lib/suiClosedPositions');
    const SUI = '0x2::sui::SUI';
    const asked: string[] = [];
    const f = globalThis.fetch;
    globalThis.fetch = (async (u: unknown) => {
      const url = String(u); asked.push(url);
      // CETUS has a price on the first day only; SUI on both; nothing else answers.
      if (url.includes('coins.llama.fi')) {
        const ts = Number(/historical\/(\d+)\//.exec(url)?.[1] ?? 0);
        const price = url.includes('::sui::SUI') ? 2 : url.includes(CETUS) && ts < 1_700_050_000 ? 0.1 : null;
        return new Response(JSON.stringify({ coins: price == null ? {} : { x: { price, timestamp: ts } } }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    const rec = pos([
      { ...ev('deposit', null, 0), amount0: 100, amount1: 10 },
      { ...ev('fee_claim', 7.77, 1) },
      { ...ev('withdrawal', null, 2), timestamp: 1_700_090_000, amount0: 50, amount1: 20 },
    ], { coinTypeA: stripped, coinTypeB: SUI, sourceBreakdown: { pending: 2, 'cg-historical': 1 } });
    const out2 = await revalueStoredRecord(rec);
    globalThis.fetch = f;
    check('asked DeFiLlama with the full CETUS address', asked.some((u) => u.includes(`sui:${CETUS}`)), asked.find((u) => u.includes('cetus')));
    check('the deposit is filled at the historical price of each side (100 × 0.1 + 10 × 2)', out2.events[0].usdAtTime === 30, String(out2.events[0].usdAtTime));
    check('the priced fee claim is untouched', out2.events[1] === rec.events[1]);
    check('a leg whose token has no historical price stays unpriced (never today\'s price)', out2.events[2].usdAtTime === null && out2.pendingEventCount === 1);
    check('totals recomputed; breakdown updated', out2.depositUSD === 30 && out2.feesUSD === 7.77 && out2.sourceBreakdown.pending === 1);
    check('outweighs the stored record in the merge', suiClosedWeight(out2) > suiClosedWeight(rec));
    check('nothing to fill returns the record itself', (await revalueStoredRecord(priced)) === priced);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.log('ERR', e); process.exit(1); });
