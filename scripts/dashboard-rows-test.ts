// Guard: a position counted in any dashboard total is a row in exactly one
// status tab, so the tabs together add up to Protocol Allocation.
// Run: npx tsx scripts/dashboard-rows-test.ts
import { effectiveStatus, protocolAllocation, hiddenByTab, type RowLike, type RowStatus } from '../app/lib/dashboardRows';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log('FAIL', m); } };
const TABS: RowStatus[] = ['In Range', 'Out of Range', 'Closed'];
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6 * Math.max(1, Math.abs(a));

function check(rows: RowLike[], label: string) {
  const alloc = protocolAllocation(rows).reduce((s, e) => s + e.value, 0);
  const counted = rows.filter((r) => r.value > 0);
  // each counted row is in exactly one tab
  for (const r of counted) {
    const n = TABS.filter((t) => effectiveStatus(r) === t).length;
    ok(n === 1, `${label}: row ${JSON.stringify(r)} in ${n} tabs`);
  }
  // sum over tabs of the rows each tab lists = allocation sum
  const tabSum = TABS.reduce((s, t) => s + rows.filter((r) => effectiveStatus(r) === t && r.value > 0).reduce((a, r) => a + r.value, 0), 0);
  ok(near(tabSum, alloc), `${label}: tabs ${tabSum} vs allocation ${alloc}`);
  // shown + hidden = allocation, for every tab
  for (const t of TABS) {
    const shown = rows.filter((r) => effectiveStatus(r) === t && r.value > 0).reduce((a, r) => a + r.value, 0);
    const hidden = hiddenByTab(rows, t).reduce((a, h) => a + h.value, 0);
    ok(near(shown + hidden, alloc), `${label}: tab ${t} shown ${shown} + hidden ${hidden} vs ${alloc}`);
  }
  ok(hiddenByTab(rows, 'All').length === 0, `${label}: All hides nothing`);
}

// The 2026-10-24 case: two Orca In Range, Cetus and Uniswap Out of Range.
const demo: RowLike[] = [
  { value: 2553.91, fees: 3, status: 'In Range', protocol: 'Orca' },
  { value: 3408.56, fees: 4, status: 'In Range', protocol: 'Orca' },
  { value: 9925.0, fees: 10, status: 'Out of Range', protocol: 'Cetus' },
  { value: 8318.0, fees: 64, status: 'Out of Range', protocol: 'Uniswap V3' },
  { value: 0, fees: 0, status: 'Closed', protocol: 'Aerodrome' },
];
check(demo, 'demo');
const h = hiddenByTab(demo, 'In Range');
ok(h.length === 1 && h[0].tab === 'Out of Range' && h[0].count === 2 && near(h[0].value, 18243), 'demo: In Range tab names the 2 out-of-range positions');

// Edge cases: unknown status, Closed with value, zero value with fees, empty list.
check([
  { value: 50, fees: 0, status: 'Staked', protocol: 'X' },
  { value: 20, fees: 1, status: '', protocol: 'Y' },
  { value: 30, fees: 0, status: 'Closed', protocol: 'Z' },
  { value: 0, fees: 5, status: 'In Range', protocol: 'W' },
], 'edge');
ok(effectiveStatus({ value: 50, fees: 0, status: 'Staked' }) === 'Out of Range', 'unknown status is shown, as Out of Range');
check([], 'empty');

// Random lists.
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const STATUSES = ['In Range', 'Out of Range', 'Closed', 'Unknown', ''];
for (let i = 0; i < 300; i++) {
  const n = Math.floor(rnd() * 12);
  const rows: RowLike[] = Array.from({ length: n }, () => ({
    value: rnd() < 0.25 ? 0 : Math.round(rnd() * 1e6) / 100,
    fees: rnd() < 0.5 ? 0 : Math.round(rnd() * 1e4) / 100,
    status: STATUSES[Math.floor(rnd() * STATUSES.length)],
    protocol: ['A', 'B', 'C'][Math.floor(rnd() * 3)],
  }));
  check(rows, `random#${i}`);
}

console.log(`dashboard-rows-test: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
