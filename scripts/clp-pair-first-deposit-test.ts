// calcPairFirstDeposit + normalizePair grouping. No network, no storage.
// Run: npx tsx scripts/clp-pair-first-deposit-test.ts
import { calcPairFirstDeposit, getEffectiveDeposited } from '../app/clp-tracker/lib/calculations';
import { normalizePair } from '../app/clp-tracker/lib/nameNormalization';
import type { Position } from '../app/clp-tracker/lib/types';

let failed = 0;
let passed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) passed += 1; else { failed += 1; console.log(`FAIL ${name} ${detail}`); }
}

function pos(over: Partial<Position> & { id: string; pair: string; entryDatetime: string }): Position {
  return {
    chain: 'BASE', protocol: 'UNISWAP', exitDatetime: null, deposited: 0, currentBalance: 0,
    newFees: 0, claimed: 0, totalFees: 0, bottomRange: 0, topRange: 0,
    token1Symbol: 'ETH', token2Symbol: 'USDC', token1Count: 0, token2Count: 0, entryPrice: 0,
    shortDateStart: null, shortDateEnd: null, shortTokenAmount: null, shortUsdAmount: null,
    shortGain: null, shortLoss: null, shortFundingFees: null, shortTotal: null, shortNotes: null,
    outOfRangeUpside: null, outOfRangeDownside: null, scalp: null, txLink: null, notes: '',
    status: 'active',
    ...over,
  };
}

// (a) WETH/USDC and ETH/USDC across fee tiers are one group.
{
  check('normalize WETH tier', normalizePair('WETH/USDC (0.3%)') === 'ETH/USDC', normalizePair('WETH/USDC (0.3%)'));
  check('normalize ETH tier', normalizePair('eth/usdc (0.05%)') === 'ETH/USDC');
  const a = pos({ id: 'a', pair: 'WETH/USDC (0.3%)', entryDatetime: '2026-03-01T10:00', deposited: 1000 });
  const b = pos({ id: 'b', pair: 'ETH/USDC (0.05%)', entryDatetime: '2026-01-01T10:00', deposited: 500 });
  const c = pos({ id: 'c', pair: 'WETH/USDC (0.05%)', entryDatetime: '2026-05-01T10:00', deposited: 700 });
  const r = calcPairFirstDeposit([a, b, c], c);
  check('(a) one group of 3', r.totalInPair === 3, String(r.totalInPair));
  check('(a) oldest first', r.history.map((h) => h.position.id).join() === 'b,a,c', r.history.map((h) => h.position.id).join());
  check('(a) first is b', r.first.id === 'b' && r.firstDeposit === 500 && !r.isThisTheFirst);
}

// (b) Earliest entry wins even when closed; deposit through getEffectiveDeposited.
{
  const closed = pos({
    id: 'old', pair: 'ETH/USDC (0.3%)', entryDatetime: '2025-11-02T09:00', status: 'closed',
    deposited: 9999, token1Count: 2, entryPrice: 3000, token2Count: 4000,
  });
  const open = pos({ id: 'new', pair: 'WETH/USDC (0.3%)', entryDatetime: '2026-02-02T09:00', deposited: 800 });
  const r = calcPairFirstDeposit([open, closed], open);
  check('(b) closed earliest is first', r.first.id === 'old');
  check('(b) effective deposit used', r.firstDeposit === 10000 && r.firstDeposit === getEffectiveDeposited(closed), String(r.firstDeposit));
  check('(b) target not first', !r.isThisTheFirst && r.totalInPair === 2);
  const self = calcPairFirstDeposit([open, closed], closed);
  check('(b) closed target is itself first', self.isThisTheFirst);
}

// (c) A single-position pair: itself first, history of one (panel hidden).
{
  const only = pos({ id: 'solo', pair: 'SUI/USDC (0.25%)', entryDatetime: '2026-04-04T00:00', deposited: 1234 });
  const other = pos({ id: 'x', pair: 'ETH/USDC (0.3%)', entryDatetime: '2025-01-01T00:00', deposited: 1 });
  const r = calcPairFirstDeposit([only, other], only);
  check('(c) itself first', r.isThisTheFirst && r.first.id === 'solo' && r.firstDeposit === 1234);
  check('(c) total 1 hides history', r.totalInPair === 1 && r.history.length === 1);
}

// (d) ETH/BTC is not merged with ETH/USDC.
{
  const ethBtc = pos({ id: 'eb', pair: 'WETH/WBTC (0.05%)', entryDatetime: '2025-01-01T00:00', deposited: 50 });
  const ethUsdc = pos({ id: 'eu', pair: 'ETH/USDC (0.05%)', entryDatetime: '2026-01-01T00:00', deposited: 60 });
  check('(d) normalized differ', normalizePair('WETH/WBTC (0.05%)') === 'ETH/BTC' && normalizePair('ETH/USDC') === 'ETH/USDC');
  const r = calcPairFirstDeposit([ethBtc, ethUsdc], ethUsdc);
  check('(d) ETH/USDC alone', r.totalInPair === 1 && r.first.id === 'eu');
}

// Invalid / missing dates sort last; ties break by id.
{
  const bad = pos({ id: 'z', pair: 'ETH/USDC', entryDatetime: 'not a date', deposited: 1 });
  const t1 = pos({ id: 'b2', pair: 'ETH/USDC', entryDatetime: '2026-01-01T00:00', deposited: 2 });
  const t2 = pos({ id: 'a2', pair: 'ETH/USDC', entryDatetime: '2026-01-01T00:00', deposited: 3 });
  const r = calcPairFirstDeposit([bad, t1, t2], bad);
  check('invalid last, tie by id', r.history.map((h) => h.position.id).join() === 'a2,b2,z', r.history.map((h) => h.position.id).join());
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
