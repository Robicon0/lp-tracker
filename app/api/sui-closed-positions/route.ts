import { NextResponse } from 'next/server';
import { getCachedClosedPositionCapitalGL, type SuiClosedPosition } from '../../lib/suiClosedPositions';

// Sprint 2.2b — closed Sui position retrieval for Capital G/L.
//
// A closed Sui CLMM position's object is DESTROYED on close, so it cannot be
// returned by the dashboard position routes (suix_getOwnedObjects can't see it).
// This route reconstructs each closed position's lifecycle from wallet tx history
// and values it via the historical cascade (sqrtPrice block price → DeFiLlama →
// CoinGecko historical → pending; NEVER current spot, Rule 1a). Results are Redis-
// cached per (protocol, wallet) under the Sprint 1.14 immutable contract, so the
// expensive tx scan is paid once then served warm.
//
// Scope: Cetus + Bluefin (Sprint 2.2b) + Momentum (Sprint MOMENTUM). All three
// Sui CLMM protocols now reconstruct closed positions through the same engine.
// useLpPnl fetches this per connected/watched Sui address and folds the returned
// positions' Capital G/L + fees into the same totals as EVM closed positions.

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const account = searchParams.get('account');
  if (!account) {
    return NextResponse.json({ error: 'account required' }, { status: 400 });
  }

  try {
    const [cetus, bluefin, momentum] = await Promise.all([
      getCachedClosedPositionCapitalGL(account, 'cetus'),
      getCachedClosedPositionCapitalGL(account, 'bluefin'),
      getCachedClosedPositionCapitalGL(account, 'momentum'),
    ]);
    const positions: SuiClosedPosition[] = [...cetus, ...bluefin, ...momentum];
    return NextResponse.json({ positions, count: positions.length, account });
  } catch (err) {
    console.error('[sui-closed-positions] error:', err);
    return NextResponse.json(
      { error: 'Failed to retrieve closed Sui positions', details: String(err) },
      { status: 500 },
    );
  }
}
