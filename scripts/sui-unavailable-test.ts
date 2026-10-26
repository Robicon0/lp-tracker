// Sui unavailable (2026-10-23): a failed Sui read is a 503 and one plain notice,
// never an empty 200 or a clean zero. No network: fetch is stubbed to answer the
// way Alchemy and the public fullnode answer since 2026-10-22 (JSON-RPC removed).
//   npx tsx scripts/sui-unavailable-test.ts
import { NextRequest } from 'next/server';
import { account1 } from './localWallets.cjs';
import {
  reportSuiRead, getTruncationSnapshot, resetTruncationNotices, isInfoReason, isLookupFailureReason,
  isSuiUnavailableReason, describeTruncation, SUI_UNAVAILABLE_TEXT,
} from '../app/lib/enumerationTruncation';

process.env.SUI_RPC_URL = 'https://sui-mainnet.example/v2/KEY';
process.env.CLOSED_POS_CACHE_READONLY = '1';

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures += 1;
};

globalThis.fetch = (async () => new Response(JSON.stringify({
  jsonrpc: '2.0', id: 1,
  error: { code: -32601, message: 'suix_getOwnedObjects is not supported. JSON-RPC has been removed on Sui as of Sui v1.82. Please migrate to gRPC.' },
}), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;

const A = account1().sui; // Account 1 (.local/wallets.json)

(async () => {
  // ── the notice ────────────────────────────────────────────────────────────
  resetTruncationNotices();
  reportSuiRead('Cetus', A, false);
  reportSuiRead('balances', A, false);
  let snap = getTruncationSnapshot();
  check('two feeders → two entries, one reason', snap.length === 2 && snap.every((n) => isSuiUnavailableReason(n.reason)));
  check('not info (totals get ≈)', !isInfoReason(snap[0].reason));
  check('not a history lookup failure', !isLookupFailureReason(snap[0].reason));
  const cet = snap.find((n) => n.source === 'Sui (Cetus)')!;
  check('detail line names the feeder', /^Sui \(Cetus\): data temporarily unavailable/.test(describeTruncation(cet)), describeTruncation(cet));
  check('banner text', SUI_UNAVAILABLE_TEXT === "Sui data temporarily unavailable: open Sui positions and balances can't be read right now");
  reportSuiRead('Cetus', A, true);
  snap = getTruncationSnapshot();
  check('an answer clears that feeder only', snap.length === 1 && snap[0].source === 'Sui (balances)');
  reportSuiRead('balances', A, true);
  check('all cleared', getTruncationSnapshot().length === 0);

  // ── the routes ────────────────────────────────────────────────────────────
  const ask = async (mod: string, path: string) => {
    const { GET } = await import(mod);
    const res = await GET(new NextRequest(`http://x/api/${path}?account=${A}`));
    return { status: res.status as number, body: await res.json() };
  };
  const bal = await ask('../app/api/sui/balances/route', 'sui/balances');
  check('balances: 503 sui-unavailable, never an empty list', bal.status === 503 && bal.body.error === 'sui-unavailable', JSON.stringify(bal));
  const sl = await ask('../app/api/lending/suilend/route', 'lending/suilend');
  check('suilend: 503, never an empty 200', sl.status === 503 && sl.body.error === 'sui-unavailable', JSON.stringify(sl).slice(0, 120));
  const af = await ask('../app/api/lending/alphafi/route', 'lending/alphafi');
  check('alphafi: 503, never an empty 200', af.status === 503 && af.body.error === 'sui-unavailable', JSON.stringify(af).slice(0, 120));
  for (const [mod, path] of [['../app/api/cetus/route', 'cetus'], ['../app/api/bluefin/route', 'bluefin'], ['../app/api/momentum/route', 'momentum']]) {
    const r = await ask(mod, path);
    check(`${path}: non-200 on a failed owned-object read`, r.status >= 500 && !Array.isArray(r.body.positions), `${r.status} ${JSON.stringify(r.body).slice(0, 80)}`);
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
