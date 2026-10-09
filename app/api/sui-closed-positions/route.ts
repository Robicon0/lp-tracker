import { NextResponse } from 'next/server';
import { getCachedClosedPositionsGuarded, type SuiClosedPosition } from '../../lib/suiClosedPositions';
import { scanStatusNotice, type RouteTruncation } from '../../lib/enumerationTruncation';
import { capClosedPositions } from '../../lib/closedPositionResponse';

// Sprint LPPNL-PERF (Part B1): pin to the Vercel Pro ceiling so the tx-history
// scan (public-Sui-RPC queryTransactionBlocks + multiGet, ~18–50 s cold) never
// dies at the low default before it can complete + write its Redis cache.
export const maxDuration = 300;

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
      getCachedClosedPositionsGuarded(account, 'cetus'),
      getCachedClosedPositionsGuarded(account, 'bluefin'),
      getCachedClosedPositionsGuarded(account, 'momentum'),
    ]);
    const all: SuiClosedPosition[] = [...cetus.positions, ...bluefin.positions, ...momentum.positions];
    // A history scan that is not whole is reported, never passed off as the
    // whole list. The positions found so far are still returned (stored ones are
    // never dropped); the notice is what makes the page mark its totals as
    // incomplete. `in-progress` means the resumable scan stopped at its time
    // budget and the next request continues it; `capped` means the history is
    // too long to read in full.
    const statuses = [cetus.status, bluefin.status, momentum.status];
    const status = statuses.includes('in-progress') ? 'in-progress'
      : statuses.includes('capped') ? 'capped'
      : statuses.includes('failed') ? 'failed' : 'complete';
    const notice = scanStatusNotice('closed-position history', status);
    const { positions, notice: capNotice } = capClosedPositions(all, (p) => p.closedTs);
    const truncated: RouteTruncation[] = [...(notice ? [notice] : []), ...(capNotice ? [capNotice] : [])];
    return NextResponse.json({
      positions, count: positions.length, account,
      ...(truncated.length > 0 ? { truncated } : {}),
    });
  } catch (err) {
    console.error('[sui-closed-positions] error:', err);
    return NextResponse.json(
      { error: 'Failed to retrieve closed Sui positions', details: String(err) },
      { status: 500 },
    );
  }
}
