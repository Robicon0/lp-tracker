// The shared closed-Solana request (app/lib/solanaClosedScan.ts). No network.
// Run: npx tsx scripts/solana-closed-scan-test.ts
import {
  fetchSolanaClosed, solanaHistoryStates, summarizeSolanaHistory, phaseOf, _resetSolanaClosedScan,
} from '../app/lib/solanaClosedScan';

let failed = 0, passed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) passed += 1; else { failed += 1; console.log(`FAIL ${name} ${detail}`); }
}

let calls = 0;
let next: () => Response | Promise<Response> = () => new Response('{}');
(globalThis as { fetch: unknown }).fetch = async () => { calls += 1; return next(); };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const reading = { reason: 'lookup-in-progress', scope: 'closed-position history', cap: 0, returned: 0, knownTotal: null };

(async () => {
  // Two consumers at once: ONE request.
  _resetSolanaClosedScan(); calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  next = async () => { await gate; return json({ positions: [1], truncated: [reading], progress: { scanned: 2000, total: 13966, totalAtLeast: false } }); };
  const a = fetchSolanaClosed('Wallet1');
  const b = fetchSolanaClosed('Wallet1');
  check('state reading before answer', solanaHistoryStates(['Wallet1'])[0].phase === 'reading');
  check('hold before answer', summarizeSolanaHistory(solanaHistoryStates(['Wallet1'])).note === 'reading Solana closed history…');
  release();
  const [ra, rb] = await Promise.all([a, b]);
  check('joined: one request', calls === 1, String(calls));
  check('same answer', ra === rb && ra.ok);
  const s1 = summarizeSolanaHistory(solanaHistoryStates(['Wallet1']));
  check('progress note', s1.hold && s1.note === 'reading history (2,000 of about 14,000)', String(s1.note));

  // A reading answer is never reused: the next round asks again.
  next = () => json({ positions: [1, 2], truncated: [] });
  await fetchSolanaClosed('Wallet1');
  check('reading not reused', calls === 2, String(calls));
  check('complete clears hold', !summarizeSolanaHistory(solanaHistoryStates(['Wallet1'])).hold);
  // A complete answer is reused.
  await fetchSolanaClosed('Wallet1');
  check('complete reused', calls === 2, String(calls));
  // Case-sensitive account: a different string is a different wallet.
  await fetchSolanaClosed('wallet1');
  check('case-sensitive key', calls === 3, String(calls));

  // A failure is never reused and holds the figures.
  _resetSolanaClosedScan(); calls = 0;
  next = () => json({ error: 'x' }, 500);
  const f = await fetchSolanaClosed('W2');
  check('failed answer', !f.ok);
  const sf = summarizeSolanaHistory(solanaHistoryStates(['W2']));
  check('failed holds', sf.hold && sf.note === "couldn't read Solana closed history", String(sf.note));
  await fetchSolanaClosed('W2');
  check('failure not reused', calls === 2, String(calls));
  next = () => { throw new TypeError('network'); };
  const n = await fetchSolanaClosed('W2');
  check('network error is a failure', !n.ok);

  // Phases from the route's notices.
  check('phase capped', phaseOf({ truncated: [{ ...reading, reason: 'lookup-capped' }] }) === 'capped');
  check('phase unavailable = failed', phaseOf({ truncated: [{ ...reading, reason: 'lookup-unavailable' }] }) === 'failed');
  check('phase unreadable-tx = complete', phaseOf({ truncated: [{ ...reading, reason: 'lookup-unreadable-tx' }] }) === 'complete');
  check('capped does not hold', !summarizeSolanaHistory([{ phase: 'capped', scanned: null, total: null, totalAtLeast: false }]).hold);
  // Several wallets: sums; total unknown; at the limit.
  const two = summarizeSolanaHistory([
    { phase: 'reading', scanned: 1000, total: 2801, totalAtLeast: false },
    { phase: 'reading', scanned: 1400, total: 50000, totalAtLeast: true },
  ]);
  check('sum + at least', two.note === 'reading history (2,400 of at least 53,000)', String(two.note));
  const noTotal = summarizeSolanaHistory([{ phase: 'reading', scanned: 300, total: null, totalAtLeast: false }]);
  check('no total yet', noTotal.note === 'reading history (300 transactions read)', String(noTotal.note));
  check('empty list no hold', !summarizeSolanaHistory([]).hold);

  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
