import { NextResponse } from 'next/server';
import { readAnalyticsSnapshot, writeAnalyticsSnapshot, type AnalyticsSnapshot } from '../../lib/analyticsSnapshot';

// Sprint INSTANT-LOAD — read/write the per-wallet-set computed-aggregates
// snapshot (see app/lib/analyticsSnapshot.ts for the full rationale + policy).
//
// GET  ?wallets={canonical wallet-set string} → { snapshot: AnalyticsSnapshot | null }
// POST { wallets, snapshot }                  → { ok: boolean }
//
// The canonical wallet-set string is built by the CLIENT (chain-prefixed,
// normalized, sorted — analytics/page.tsx walletSetKey memo); the server only
// hashes it, so there is no normalization drift between the two sides. The
// snapshot is computed OUTPUT only — no pricing/valuation runs here; the write
// path is guarded by shape validation + a size cap, and the client only posts
// after the pipeline settled with zero transport errors.

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const wallets = searchParams.get('wallets');
  if (!wallets) return NextResponse.json({ error: 'wallets required' }, { status: 400 });
  const snapshot = await readAnalyticsSnapshot(wallets);
  return NextResponse.json({ snapshot });
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { wallets?: string; snapshot?: AnalyticsSnapshot };
    if (!body?.wallets || !body?.snapshot) {
      return NextResponse.json({ error: 'wallets and snapshot required' }, { status: 400 });
    }
    const ok = await writeAnalyticsSnapshot(body.wallets, body.snapshot);
    return NextResponse.json({ ok });
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }
}
