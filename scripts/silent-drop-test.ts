// Standing rule (i): no closed or open position and no fee scan result may be
// dropped silently. Forced cases, one per skip path, each of which must end as a
// row or a counted notice.   npx tsx scripts/silent-drop-test.ts
import { classifyReconstructedClosed } from '../app/lib/closedPositionClassify';
import { computePositionPnL, type ActivityEventForPnL } from '../app/lib/positionPnl';
import {
  excludedPositionNotices, excludedNotice, describeTruncation, hasLookupFailure, isLookupFailureReason,
} from '../app/lib/enumerationTruncation';
import { parseWhirlpoolEvents, poolPriceForLeg, lastTradedSqrtPrice, consistentWithOneSided, usdPricesFromPool } from '../app/lib/whirlpoolEventPrice';

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
const ev = (type: ActivityEventForPnL['type'], amount0: number, amount1: number, usdAtTime: number | null, p0: number | null = null, p1: number | null = null, ts = 1_700_000_000): ActivityEventForPnL =>
  ({ type, timestamp: ts, amount0, amount1, usdAtTime, price0AtTime: p0, price1AtTime: p1 });

console.log('1. unpriced deposit');
{
  // Two deposits, the second in a token with no price; withdrawal and a fee priced.
  const v = classifyReconstructedClosed({ pendingEventCount: 1, events: [
    ev('deposit', 100, 5, 6, 0.01, 1), ev('deposit', 300, 0, null), ev('withdrawal', 0, 9, 9, null, 1, 1_700_000_100), ev('fee_claim', 0, 0.5, 0.5, null, 1),
  ] });
  check('is a row marked not priced, not dropped', v.kind === 'not-priced');
  if (v.kind === 'not-priced') {
    check('row carries the token amounts', v.detail.depositAmount0 === 400 && v.detail.depositAmount1 === 5);
    check('row carries the priced part', v.detail.pricedDepositUSD === 6 && v.detail.pricedWithdrawalUSD === 9 && v.detail.pricedFeesUSD === 0.5);
    check('reads pendingEventCount', v.detail.unpricedEvents === 1);
    check('says why', /1 deposit with no price/.test(v.detail.why), v.detail.why);
  }
  // A half-priced deposit used to pass as "priced" on its priced side alone.
  const half = classifyReconstructedClosed({ events: [ev('deposit', 349, 3.87, null, null, 1), ev('withdrawal', 0, 5, 5, null, 1, 1_700_000_100)] });
  check('half-priced deposit is not priced (was valued on one side only)', half.kind === 'not-priced');
}

console.log('2. unpriced withdrawal');
{
  const events = [ev('deposit', 0, 100, 100, null, 1), ev('withdrawal', 5000, 0, null, null, 0, 1_700_000_100)];
  const v = classifyReconstructedClosed({ events });
  check('is a row marked not priced', v.kind === 'not-priced');
  if (v.kind === 'not-priced') check('says why', /1 withdrawal with no price/.test(v.detail.why), v.detail.why);
  // The engine itself: never a withdrawal worth 0 (a loss the size of the deposit).
  const pnl = computePositionPnL({ currentValue: 0, unclaimedFeesUSD: 0, price0: 0, price1: 0, events, isClosed: true });
  check('engine reports it unpriced instead of valuing it at 0', !pnl.ok && pnl.reason === 'missing_withdrawal_prices', JSON.stringify(pnl).slice(0, 80));
  // With a current price the last resort is unchanged (and counted).
  const spot = computePositionPnL({ currentValue: 0, unclaimedFeesUSD: 0, price0: 0.02, price1: 1, events, isClosed: true });
  check('current-price last resort unchanged when a price exists', spot.ok && spot.data.closingValue === 100 && spot.data.spotFallbackEventCount === 1);
}

console.log('3. no deposit event');
{
  const v = classifyReconstructedClosed({ events: [ev('withdrawal', 1, 50, 60, 10, 1), ev('fee_claim', 0, 2, 2, null, 1)] });
  check('is a row marked history incomplete', v.kind === 'history-incomplete');
  if (v.kind === 'history-incomplete') check('row carries what was withdrawn', v.detail.withdrawalAmount1 === 50 && v.detail.pricedWithdrawalUSD === 60);
  check('a position with no amounts at all is empty, not a row', classifyReconstructedClosed({ events: [ev('fee_claim', 0, 0, 0)] }).kind === 'empty');
  // A fully priced position is unchanged: same figures as the engine.
  const events = [ev('deposit', 1, 100, 300, 200, 1), ev('withdrawal', 0.5, 180, 290, 220, 1, 1_700_000_100), ev('fee_claim', 0, 3, 3, null, 1)];
  const ok = classifyReconstructedClosed({ events });
  const ref = computePositionPnL({ currentValue: 0, unclaimedFeesUSD: 0, price0: 0, price1: 0, events, isClosed: true });
  check('priced position: identical to the engine', ok.kind === 'priced' && ref.ok && ok.data.initialValue === ref.data.initialValue && ok.data.closingValue === ref.data.closingValue && ok.data.feesCollected === ref.data.feesCollected);
}

console.log('4. excluded[] from a wallet-wide fee scan');
{
  const excluded = [
    { tokenId: '1', reason: 'pool-context-unresolved' }, { tokenId: '2', reason: 'pool-context-unresolved' },
    { tokenId: '3', reason: 'aerodrome activity error' }, { tokenId: '4', reason: 'wallet-scope-time-budget' },
    { tokenId: '5', reason: 'wallet-scope-id-cap' },
  ];
  const notices = excludedPositionNotices('Base history scan', excluded, 66);
  check('one counted notice per cause (the id cap keeps its own)', notices.length === 3 && notices.map((n) => n.returned).join(',') === '2,1,1', JSON.stringify(notices.map((n) => [n.reason, n.returned])));
  check('each marks the totals (lookup class)', notices.every((n) => isLookupFailureReason(n.reason)) && hasLookupFailure(notices));
  const lines = notices.map((n) => describeTruncation({ ...n, source: 'Aerodrome history scan', address: '0x0' }));
  check('text has the count and the reason', /2 of 66 positions left out — their pools could not be identified/.test(lines[0]) && /1 of 66 position left out — its history request failed/.test(lines[1]) && /time limit/.test(lines[2]), lines.join(' | '));
  check('nothing left out, no notice', excludedPositionNotices('Base history scan', [], 14).length === 0);
}

console.log('5. holder check failure');
{
  const n = excludedNotice('Base closed-position recovery', 'holder-check', 3, 65);
  const line = describeTruncation({ ...n, source: 'Aerodrome history', address: '0x0' });
  check('counted notice with the reason', /3 of 65 positions left out — the check of who holds them now failed/.test(line), line);
  check('marks the totals', hasLookupFailure([n]));
}

console.log('6. pool price from the Orca program events (chain data, position Ca6vyt…, pool 4QBMNZ…)');
{
  const POOL = '4QBMNZjvXRqZHYywC2zWwqkiEVkAgxp4FWD9pQ7Bqpap';
  const POS = 'Ca6vytcVV1UiKxswkusAbr8UkjZU4Smbhakmc1uhcEkD';
  const near = (a: number, b: number, rel = 1e-6) => Math.abs(a - b) <= Math.abs(b) * rel;
  // 2026-05-13 12:25:06 — two-sided deposit (the swap before it is in ANOTHER pool).
  const tx1 = [
    'Program data: 4cpJr5MroJbA9aBmkuv7QiH/+yBR/zg73MpUAHEAi6Mp+vJPuJzddgCnXvTAoMq5DAAAAAAAAAAAa46NHvSkugwAAAAAAAAAALzvDQAAAAAAdNKvFQAAAAAAAAAAAAAAAAAAAAAAAAAAoy8AAAAAAAAdBwAAAAAAAA==',
    'Program data: HgeQtWb+m6Eygx+iRh7XUreZmVnU5vEB+VazqPXPjdTEYOm0UbpuZavrbcMaVJhOK0C9gnVshdfJExhFDz4HZvyZfOKj0xSWAAr//wAY//+Hd7EhAAAAAAAAAAAAAAAA6UvRFAAAAACIBjsAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  ];
  const r1 = poolPriceForLeg(parseWhirlpoolEvents(tx1), { pool: POOL, position: POS, dir: 'in', amountARaw: 349260777n, amountBRaw: 3868296n });
  check('two-sided deposit: price from the liquidity event', r1.status === 'priced' && r1.method === 'liquidity-event' && near(r1.rawPrice, 0.002475410997, 1e-6), JSON.stringify(r1));
  // 2026-05-14 15:57:56 — one-sided deposit, swap in the same pool just before it.
  const tx2 = [
    'Program data: 4cpJr5MroJYygx+iRh7XUreZmVnU5vEB+VazqPXPjdTEYOm0UbpuZQAZppBstU3sCgAAAAAAAAAA/4iN2C9c7AoAAAAAAAAAAOGKDgAAAAAAkeyTHgAAAAAAAAAAAAAAAAAAAAAAAAAAyUAAAAAAAACuCQAAAAAAAA==',
    'Program data: HgeQtWb+m6Eygx+iRh7XUreZmVnU5vEB+VazqPXPjdTEYOm0UbpuZavrbcMaVJhOK0C9gnVshdfJExhFDz4HZvyZfOKj0xSWAAr//wAY///UpIwSAAAAAAAAAAAAAAAAMujqRgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  ];
  const r2 = poolPriceForLeg(parseWhirlpoolEvents(tx2), { pool: POOL, position: POS, dir: 'in', amountARaw: 1189799986n, amountBRaw: 0n });
  check('one-sided deposit: post-price of the same-pool swap in its transaction', r2.status === 'priced' && r2.method === 'same-tx-swap' && near(r2.rawPrice, 0.001820649448, 1e-6), JSON.stringify(r2));
  if (r2.status === 'priced') {
    const px = usdPricesFromPool(r2.rawPrice, { side: 'b', usd: 1 }, 6, 6);
    check('value of the deposit: 1,189.799986 × 0.00182065 = 2.1662', !!px && near(1189.799986 * px.p0, 2.166209, 1e-4), String(px && 1189.799986 * px.p0));
    const other = usdPricesFromPool(r2.rawPrice, { side: 'b', usd: 1 }, 9, 6);
    check('value does not depend on the unpriced token\'s decimals', !!other && !!px && near(1189799986 / 1e9 * other.p0, 1189.799986 * px.p0, 1e-9));
  }
  check('same-tx swap also read by lastTradedSqrtPrice', near((lastTradedSqrtPrice(tx2, POOL) ?? 0) ** 2, 0.001820649448, 1e-6));
  // 2026-05-22 14:46:25 — one-sided withdrawal, no swap in its transaction.
  const only = parseWhirlpoolEvents([tx2[1]]);
  const r3 = poolPriceForLeg(only, { pool: POOL, position: POS, dir: 'in', amountARaw: 1189799986n, amountBRaw: 0n });
  check('one-sided leg with no swap beside it asks for the pool history', r3.status === 'need-pool-history' && r3.side === 'a-only' && r3.tickLower === -62976, JSON.stringify(r3));
  check('a price inside the range contradicts a one-sided leg and is rejected', !consistentWithOneSided(Math.sqrt(0.0021), 'a-only', -62976, -59392) && consistentWithOneSided(Math.sqrt(0.00182), 'a-only', -62976, -59392));
  check('no liquidity event: nothing is derived', poolPriceForLeg(parseWhirlpoolEvents([tx2[0]]), { pool: POOL, position: POS, dir: 'in', amountARaw: 1n, amountBRaw: 0n }).status === 'none');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
