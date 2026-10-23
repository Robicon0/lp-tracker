// Uniswap V3 on Base + the "positions we can't read yet" count (2026-10-23).
// No network: fetch is stubbed.
//   npx tsx scripts/uniswap-base-unsupported-test.ts
// The live checks (0xd99a's NFTs 6298519 open / 6281713 closed against the chain,
// a real Base V4 holder) are in the CLAUDE.md entry for this change.

import { NextRequest } from 'next/server';
import { safeCalcPendingFeeX128, calcFeeGrowthInsideX128, U256_MASK } from '../app/lib/clmmFeeMath';
import { describeTruncation, isInfoReason, isLookupFailureReason, unsupportedSummary } from '../app/lib/enumerationTruncation';

process.env.NEXT_PUBLIC_ALCHEMY_KEY = 'TESTKEY';

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures += 1;
};
const W = (n: number | bigint) => BigInt(n).toString(16).padStart(64, '0');
const Q128 = 1n << 128n;

// ── pending-fee math (X128, u256) ───────────────────────────────────────────
{
  const r = safeCalcPendingFeeX128(10n ** 18n, 5n * Q128 / 10n ** 18n + 100n, 100n);
  check('pending fee: liquidity × delta >> 128', r.fee === 4n && !r.guarded, `fee ${r.fee}`);
  const u = safeCalcPendingFeeX128(10n ** 18n, 5n, 7n);
  check('pending fee: inside below checkpoint is guarded to 0', u.fee === 0n && u.guarded);
  // In range: inside = global − below(lower) − above(upper).
  const inside = calcFeeGrowthInsideX128(-10, 10, 0, 1000n, 100n, 200n);
  check('fee growth inside, in range', inside === 700n, String(inside));
  // Below range: inside = outsideLower − outsideUpper (wrapping).
  const below = calcFeeGrowthInsideX128(-10, 10, -20, 1000n, 300n, 100n);
  check('fee growth inside, below range', below === 200n, String(below));
  const wrap = calcFeeGrowthInsideX128(-10, 10, 0, 5n, 10n, 0n);
  check('fee growth inside wraps mod 2^256', wrap === ((5n - 10n) & U256_MASK));
}

// ── notice wording and classification ───────────────────────────────────────
{
  const n = { source: 'Uniswap', address: '0xabc', scope: 'V4 / Base', cap: 0, returned: 2, knownTotal: null, reason: 'unsupported-positions' };
  check('unsupported notice is not info (total gets ≈)', !isInfoReason(n.reason));
  check('unsupported notice is not a lookup failure', !isLookupFailureReason(n.reason));
  check('summary line', unsupportedSummary(n) === "Uniswap V4 / Base: 2 positions we can't read yet", unsupportedSummary(n));
  check('detail line says not in totals', /not in the totals/.test(describeTruncation(n)));
  const u = { ...n, returned: 0, reason: 'unsupported-unchecked' };
  check('unchecked summary', unsupportedSummary(u) === "Uniswap V4 / Base: couldn't check for positions", unsupportedSummary(u));
  check('unchecked is not info', !isInfoReason(u.reason));
}

// ── the count route ─────────────────────────────────────────────────────────
type Mode = { v4Base: number; failHost?: string };
function stub(mode: Mode) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    if (mode.failHost && url.includes(mode.failHost)) return new Response('bad gateway', { status: 502 });
    const body = JSON.parse(String(init?.body)) as Array<{ id: number; params: Array<{ to: string }> }>;
    const out = body.map((c) => {
      const to = c.params[0].to.toLowerCase();
      const n = url.includes('base-mainnet') && to === '0x7c5f5a4bbd8fd63184577525326123b519429bdc' ? mode.v4Base : 0;
      return { jsonrpc: '2.0', id: c.id, result: '0x' + W(n) };
    });
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return calls;
}

(async () => {
  const { GET } = await import('../app/api/uniswap/unsupported/route');
  const ask = async (acct: string) => (await (await GET(new NextRequest(`http://x/api/uniswap/unsupported?account=${acct}`))).json()) as {
    counts: Array<{ version: string; chain: string; count: number | null }>;
    truncated: Array<{ scope: string; reason: string; returned: number }>;
  };

  stub({ v4Base: 0 });
  const zero = await ask('0x' + '1'.repeat(40));
  check('zero everywhere → no notice', zero.truncated.length === 0, JSON.stringify(zero.truncated));
  check('16 managers counted', zero.counts.length === 16, String(zero.counts.length));

  stub({ v4Base: 3 });
  const three = await ask('0x' + '2'.repeat(40));
  check('V4 on Base → one notice with the count',
    three.truncated.length === 1 && three.truncated[0].scope === 'V4 / Base' && three.truncated[0].returned === 3 && three.truncated[0].reason === 'unsupported-positions',
    JSON.stringify(three.truncated));

  stub({ v4Base: 0, failHost: 'rpc.blast.io' });
  const failed = await ask('0x' + '3'.repeat(40));
  const scopes = failed.truncated.filter((t) => t.reason === 'unsupported-unchecked').map((t) => t.scope).sort();
  check('a failed count read → "unchecked" notice, never a clean zero',
    JSON.stringify(scopes) === JSON.stringify(['V3 / Blast', 'V4 / Blast']), JSON.stringify(scopes));

  // A failed answer is not remembered; a later good answer clears it.
  stub({ v4Base: 0 });
  const again = await ask('0x' + '3'.repeat(40));
  check('failed count is asked again next time', again.truncated.length === 0, JSON.stringify(again.truncated));

  const bad = await GET(new NextRequest('http://x/api/uniswap/unsupported?account=nope'));
  check('bad address → 400', bad.status === 400);

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
