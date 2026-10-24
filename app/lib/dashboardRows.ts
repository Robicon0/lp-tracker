// The dashboard's position tabs and the totals beside them (2026-10-25).
//
// The headline total, Protocol Allocation and Chain Distribution sum every
// position with value > 0. The list shows one status tab at a time (In Range by
// default). Rule: a position counted in any total is a row in exactly one status
// tab, so the tabs together always add up to the totals, and the page says what
// the open tab is not showing. Guard: scripts/dashboard-rows-test.ts.

export type RowStatus = 'In Range' | 'Out of Range' | 'Closed';

export interface RowLike {
  value: number;
  fees: number;
  status: string;
  protocol: string;
}

/**
 * The tab a position belongs to. Nothing held and nothing earned is Closed. A
 * status the page does not know (a new route, a typo) is shown as Out of Range
 * rather than in no tab at all.
 */
export function effectiveStatus(p: Pick<RowLike, 'value' | 'fees' | 'status'>): RowStatus {
  if (p.value === 0 && p.fees === 0) return 'Closed';
  if (p.status === 'In Range' || p.status === 'Out of Range' || p.status === 'Closed') return p.status;
  return 'Out of Range';
}

/** Protocol Allocation: value per protocol over positions holding value. */
export function protocolAllocation(positions: RowLike[]): Array<{ name: string; value: number }> {
  const m: Record<string, number> = {};
  for (const p of positions) if (p.value > 0) m[p.protocol] = (m[p.protocol] ?? 0) + p.value;
  return Object.entries(m).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
}

/** Counted positions the selected tab does not show, per tab they are in. */
export function hiddenByTab(positions: RowLike[], tab: RowStatus | 'All'): Array<{ tab: RowStatus; count: number; value: number }> {
  if (tab === 'All') return [];
  const m = new Map<RowStatus, { count: number; value: number }>();
  for (const p of positions) {
    if (p.value <= 0) continue;
    const s = effectiveStatus(p);
    if (s === tab) continue;
    const e = m.get(s) ?? { count: 0, value: 0 };
    e.count += 1;
    e.value += p.value;
    m.set(s, e);
  }
  return [...m.entries()].map(([t, e]) => ({ tab: t, ...e }));
}
