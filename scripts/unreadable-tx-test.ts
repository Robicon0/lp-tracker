// Standing rule (j): a transaction the engine cannot read is a visible
// incomplete-scan notice with a count, never a skip, and a scan with unreadable
// transactions is never marked complete. Forced cases; the provider is stubbed
// and nothing is read from or written to any store.
//   npx tsx scripts/unreadable-tx-test.ts
process.env.ALCHEMY_SOLANA_RPC = 'https://stub.invalid/v2/key';
process.env.CLOSED_POS_CACHE_READONLY = '1';
delete process.env.PRICE_CACHE_KV_REST_API_URL;
delete process.env.PRICE_CACHE_KV_REST_API_TOKEN;

export {};
let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const WHIRL = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const POOL = '4QBMNZjvXRqZHYywC2zWwqkiEVkAgxp4FWD9pQ7Bqpap';
// A real Traded event of that pool (2026-05-14 15:57:56, post-price 0.0018206).
const SWAP_LOG = 'Program data: 4cpJr5MroJYygx+iRh7XUreZmVnU5vEB+VazqPXPjdTEYOm0UbpuZQAZppBstU3sCgAAAAAAAAAA/4iN2C9c7AoAAAAAAAAAAOGKDgAAAAAAkeyTHgAAAAAAAAAAAAAAAAAAAAAAAAAAyUAAAAAAAACuCQAAAAAAAA==';
const tx = (sig: string, opts: { whirl?: boolean; logs?: string[]; version?: number } = {}) => ({
  version: opts.version ?? 0, slot: 1, blockTime: 1_790_000_000,
  transaction: { signatures: [sig], message: { accountKeys: [], instructions: opts.whirl ? [{ programId: WHIRL, data: '3Bxs4h24hBtQy9rw', accounts: [POOL] }] : [{ programId: '11111111111111111111111111111111', accounts: [] }] } },
  meta: { err: null, innerInstructions: [], preTokenBalances: [], postTokenBalances: [], logMessages: opts.logs ?? [] },
});
type Answer = { result?: unknown; error?: { code: number; message: string } };
const versionError = (v: number): Answer => ({ error: { code: -32015, message: `Transaction version (${v}) is not supported by the requesting client. Please try the request again with the following configuration parameter: "maxSupportedTransactionVersion": ${v}` } });

// What the stubbed provider answers, per signature; a function is called per attempt.
const answers = new Map<string, Answer | ((attempt: number) => Answer)>();
const attempts = new Map<string, number>();
let sigPages: Record<string, Array<{ signature: string; err: null; blockTime: number }>> = {};
const askedVersions = new Set<unknown>();

const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
  if (!String(url).startsWith('https://stub.invalid')) return new Response('{}', { status: 404 });
  const body = JSON.parse(init?.body ?? '{}');
  const one = (req: { id: number; method: string; params: unknown[] }) => {
    if (req.method === 'getSignaturesForAddress') {
      const [addr, o] = req.params as [string, { before?: string; until?: string }];
      // Newest first; nothing is newer than the stored head, nothing older than the page.
      return { jsonrpc: '2.0', id: req.id, result: o.until || o.before ? [] : (sigPages[addr] ?? []) };
    }
    if (req.method === 'getTransaction') {
      const [sig, o] = req.params as [string, { maxSupportedTransactionVersion?: number }];
      askedVersions.add(o.maxSupportedTransactionVersion);
      const n = (attempts.get(sig) ?? 0) + 1; attempts.set(sig, n);
      const a = answers.get(sig);
      const ans = typeof a === 'function' ? a(n) : a ?? { result: null };
      return { jsonrpc: '2.0', id: req.id, ...ans };
    }
    if (req.method === 'getTokenAccountsByOwner') return { jsonrpc: '2.0', id: req.id, result: { value: [] } };
    if (req.method === 'getMultipleAccounts') return { jsonrpc: '2.0', id: req.id, result: { value: (req.params[0] as string[]).map(() => null) } };
    return { jsonrpc: '2.0', id: req.id, result: null };
  };
  return new Response(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

async function main() {
  const eng = await import('../app/lib/solanaClosedPositions');
  const { unreadableTxNotice, describeTruncation, isLookupFailureReason, hasLookupFailure } = await import('../app/lib/enumerationTruncation');
  const { SOLANA_MAX_TX_VERSION, isUnsupportedTxVersion, unreadableCause } = await import('../app/lib/solanaTxVersion');
  const hooks = eng._solanaEngineTestHooks;
  const sig = (n: string) => ({ signature: n, err: null, blockTime: 1_790_000_000 });

  console.log('1. the request and the provider answer');
  check('the engine asks for version 1', SOLANA_MAX_TX_VERSION === 1);
  check('"version not supported" is recognised by code and by text', isUnsupportedTxVersion(versionError(2).error) && isUnsupportedTxVersion({ message: 'Transaction version (1) is not supported by the requesting client' }) && !isUnsupportedTxVersion({ code: -32000, message: 'x' }));
  check('cause names the version', unreadableCause(versionError(2).error) === 'version-2' && unreadableCause(null) === 'not-returned');

  console.log('2. a wallet scan with unreadable transactions');
  const W = 'WalletForcedAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1';
  sigPages = { [W]: [sig('sV2'), sig('sNull'), sig('sLate'), sig('sV1'), sig('sOk')] };
  answers.set('sV2', versionError(2));                                   // a version the engine does not read
  answers.set('sNull', { result: null });                                // never returned
  answers.set('sLate', (n) => (n < 3 ? { result: null } : { result: tx('sLate', { whirl: true }) })); // returned on the third ask
  answers.set('sV1', { result: tx('sV1', { whirl: true, version: 1 }) }); // a version-1 transaction
  answers.set('sOk', { result: tx('sOk', { whirl: true }) });
  const h1 = await hooks.getSolanaWalletHistory(W, hooks.newStats());
  check('every getTransaction asked with maxSupportedTransactionVersion 1', askedVersions.size === 1 && askedVersions.has(1), [...askedVersions].join(','));
  check('the version-1 transaction is read and kept', h1.txs.some((t) => t.transaction.signatures?.[0] === 'sV1'));
  check('a transaction returned on a later ask is read, not marked', h1.txs.some((t) => t.transaction.signatures?.[0] === 'sLate') && (attempts.get('sLate') ?? 0) === 3);
  check('two transactions are counted unreadable', h1.unreadable === 2, String(h1.unreadable));
  check('an unsupported version is not asked again in the same scan', attempts.get('sV2') === 1, String(attempts.get('sV2')));
  check('the scan is NOT complete', h1.complete === false && h1.status === 'failed', `${h1.complete} ${h1.status}`);
  check('the reason carries the count', /2 transactions could not be read/.test(h1.reason ?? ''), h1.reason);
  check('the mark carries the count', h1.mark.endsWith(':u2'), h1.mark);
  check('no marker reaches the reconstruction', h1.txs.length === 3 && h1.txs.every((t) => !t.unreadable && t.meta));

  console.log('3. the route answer for that wallet');
  const r1 = await eng.getCachedClosedPositionsGuarded(W);
  check('incomplete, with the count', r1.incomplete === true && r1.status === 'failed' && r1.unreadableTx === 2, JSON.stringify({ i: r1.incomplete, s: r1.status, u: r1.unreadableTx }));
  const notice = unreadableTxNotice('closed-position history', r1.unreadableTx ?? 0);
  const line = describeTruncation({ ...notice, source: 'Solana', address: W });
  check('notice text names the number', /Solana · closed-position history: 2 transactions could not be read/.test(line), line);
  check('the notice marks the totals (lookup class)', isLookupFailureReason(notice.reason) && hasLookupFailure([notice]));

  console.log('4. asked again on a later load');
  answers.set('sNull', { result: tx('sNull') });                         // now returned; touches neither program
  hooks.allowReread();
  const h2 = await hooks.getSolanaWalletHistory(W, hooks.newStats());
  check('one read now, one still unreadable', h2.unreadable === 1 && h2.complete === false && h2.mark.endsWith(':u1'), `${h2.unreadable} ${h2.mark}`);
  check('a version above the one asked for is never asked again', attempts.get('sV2') === 1, String(attempts.get('sV2')));
  const W3 = 'WalletForcedCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC3';
  sigPages[W3] = [sig('eA'), sig('eB')];
  answers.set('eA', { error: { code: -32603, message: 'internal error' } });
  answers.set('eB', { result: tx('eB', { whirl: true }) });
  const g1 = await hooks.getSolanaWalletHistory(W3, hooks.newStats());
  check('any other error is asked three times, then counted', g1.unreadable === 1 && g1.complete === false && (attempts.get('eA') ?? 0) >= 3, `${g1.unreadable} ${attempts.get('eA')}`);
  answers.set('eA', { result: tx('eA', { whirl: true }) });              // readable at last, and it matters
  hooks.allowReread();
  const h3 = await hooks.getSolanaWalletHistory(W3, hooks.newStats());
  check('all read: complete, and the newly read transaction is in the history', h3.unreadable === 0 && h3.complete === true && h3.status === 'complete' && h3.txs.some((t) => t.transaction.signatures?.[0] === 'eA'), `${h3.unreadable} ${h3.status} ${h3.txs.length}`);
  check('the mark has no unreadable suffix once all are read', !/:u\d+$/.test(h3.mark), h3.mark);
  const r3 = await eng.getCachedClosedPositionsGuarded(W3);
  check('route answer: complete, no count', r3.incomplete === false && r3.status === 'complete' && r3.unreadableTx === undefined, JSON.stringify({ i: r3.incomplete, s: r3.status }));

  console.log('5. a wallet with nothing unreadable is unchanged');
  const W2 = 'WalletForcedBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB2';
  sigPages[W2] = [sig('qA'), sig('qB')];
  answers.set('qA', { result: tx('qA', { whirl: true }) });
  answers.set('qB', { result: tx('qB') });
  const h4 = await hooks.getSolanaWalletHistory(W2, hooks.newStats());
  check('complete, mark in the old form', h4.complete && h4.status === 'complete' && h4.unreadable === 0 && h4.mark === '1:complete', h4.mark);

  console.log('6. the pool look-back');
  const lookback = async (ans: Record<string, Answer>) => {
    const names = Object.keys(ans);
    sigPages = { ...sigPages };
    for (const n of names) answers.set(n, ans[n]);
    const realPage = sigPages[POOL];
    // The look-back asks with `before`: serve the page for that call only.
    const f = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
      const b = JSON.parse(init?.body ?? '{}');
      if (!Array.isArray(b) && b.method === 'getSignaturesForAddress' && b.params[0] === POOL) {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: b.id, result: names.map(sig) }), { status: 200 });
      }
      return f(url as never, init as never);
    }) as typeof fetch;
    try { return await hooks.lastSwapSqrtBefore(POOL, 'legSig', hooks.newStats(), Date.now() + 20_000); }
    finally { globalThis.fetch = f; sigPages[POOL] = realPage; }
  };
  const a = await lookback({ a1: { result: tx('a1', { version: 1 }) }, a2: { result: tx('a2', { logs: [SWAP_LOG] }) } });
  check('a version-1 transaction in the way is read and passed; the swap behind it prices the leg', a != null && Math.abs(a * a - 0.001820649448) < 1e-8, String(a));
  const b = await lookback({ b1: versionError(2), b2: { result: tx('b2', { logs: [SWAP_LOG] }) } });
  check('an unreadable transaction before the swap stops the look-back (leg stays unpriced)', b === null, String(b));

  console.log(`\n${pass} passed, ${fail} failed`);
  globalThis.fetch = realFetch;
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.log('ERR', e); process.exit(1); });
