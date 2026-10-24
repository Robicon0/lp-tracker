// Run: npx tsx scripts/portfolio-headline-test.ts
import { computeHeadline } from '../app/lib/portfolioHeadline';
import type { PortfolioSnapshot } from '../app/hooks/usePortfolioHistory';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log('FAIL', m); } };
const D = 86_400_000, now = Date.UTC(2026, 9, 25, 12);
const K = 'evm:0xd99a,solana:gndr,sui:0xdce8';
const pt = (daysAgo: number, v: number, extra: Partial<PortfolioSnapshot> = {}): PortfolioSnapshot =>
  ({ timestamp: now - daysAgo * D, totalValue: v, positionCount: 5, ...extra });
const T = { trusted: true as const, walletKey: K };
const base = { walletKey: K, rangeMs: 30 * D, now, liveTotal: 24_300, liveWhole: true };

// The reported case: old partial points (no flag) give +$5,504 from an $18.8k dip.
const old = [pt(29, 18_796), pt(20, 6_000), pt(10, 24_000)];
let h = computeHeadline(old, base);
ok(h.pnlDollar === null, 'untrusted points never give a headline');
ok(h.peak === 24_300, 'peak ignores untrusted points (live total only)');

// One trusted point 2 days ago, among old ones: "since" label, not "30 days".
h = computeHeadline([...old, pt(2, 24_000, T)], base);
ok(h.pnlDollar === 300 && Math.abs(h.pnlPct! - 1.25) < 1e-9, 'change from first trusted point');
ok(h.coversRange === false && h.sinceTs === now - 2 * D, 'label is "since", range not covered');

// Trusted point at the range start covers the range.
h = computeHeadline([pt(29.9, 20_000, T), pt(1, 30_000, T)], base);
ok(h.coversRange === true && h.pnlDollar === 4_300 && h.peak === 30_000, 'covers range; peak from trusted');

// Another wallet set's points are ignored.
h = computeHeadline([pt(5, 1_000, { trusted: true, walletKey: 'evm:0xother' })], base);
ok(h.pnlDollar === null && h.peak === 24_300, 'other wallet set ignored');

// Live total not whole: no change shown, no peak from the partial live total.
h = computeHeadline([pt(5, 20_000, T)], { ...base, liveTotal: 15_000, liveWhole: false });
ok(h.pnlDollar === null && h.peak === 20_000, 'partial live total gives no headline');

// Baseline only minutes old: not shown.
h = computeHeadline([{ ...pt(0, 24_000, T), timestamp: now - 60_000 }], base);
ok(h.pnlDollar === null, 'a minutes-old baseline is not a window');

// No wallet key (scan mode, nothing connected): nothing.
h = computeHeadline([pt(5, 20_000, T)], { ...base, walletKey: '' });
ok(h.pnlDollar === null, 'empty wallet key gives nothing');

// Points outside the range are not used.
h = computeHeadline([pt(40, 10_000, T), pt(3, 23_000, T)], base);
ok(h.sinceTs === now - 3 * D && h.pnlDollar === 1_300, 'baseline is inside the range');

console.log(`portfolio-headline-test: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
