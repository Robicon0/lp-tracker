// Yield History headline (2026-10-25). The window change and Peak Value are
// computed only from snapshots saved under the whole-total rule (`trusted`)
// for the SAME wallet set as the live total. Older snapshots (partial saves,
// or another wallet set) stay stored and charted but never feed a headline.
// When the first trusted point is later than the range start, the label says
// "since <date>" instead of the range. Test: scripts/portfolio-headline-test.ts.

import type { PortfolioSnapshot } from '../hooks/usePortfolioHistory';

export interface Headline {
  /** Change from the first trusted point to the live total; null = not shown. */
  pnlDollar: number | null;
  pnlPct: number | null;
  peak: number;
  /** ms of the baseline point, when a change is shown. */
  sinceTs: number | null;
  /** The baseline is at (or within 5% of the range length after) the range start. */
  coversRange: boolean;
}

export function computeHeadline(
  history: PortfolioSnapshot[],
  opts: { walletKey: string; rangeMs: number; now: number; liveTotal: number; liveWhole: boolean },
): Headline {
  const start = opts.now - opts.rangeMs;
  const pts = opts.walletKey
    ? history.filter((s) => s.trusted === true && s.walletKey === opts.walletKey && s.timestamp >= start && s.totalValue > 0)
    : [];
  const peak = Math.max(opts.liveWhole ? opts.liveTotal : 0, ...pts.map((s) => s.totalValue), 0);
  if (!opts.liveWhole || pts.length === 0 || opts.liveTotal <= 0) {
    return { pnlDollar: null, pnlPct: null, peak, sinceTs: null, coversRange: false };
  }
  const base = pts[0];
  // A baseline from the last few minutes says nothing; need at least 1% of the range.
  if (opts.now - base.timestamp < opts.rangeMs * 0.01) {
    return { pnlDollar: null, pnlPct: null, peak, sinceTs: null, coversRange: false };
  }
  const pnlDollar = opts.liveTotal - base.totalValue;
  return {
    pnlDollar,
    pnlPct: (pnlDollar / base.totalValue) * 100,
    peak,
    sinceTs: base.timestamp,
    coversRange: base.timestamp <= start + opts.rangeMs * 0.05,
  };
}
