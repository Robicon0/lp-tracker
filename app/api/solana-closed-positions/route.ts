import { NextResponse } from 'next/server';
import { getCachedClosedPositionCapitalGL, type SolanaClosedPosition } from '../../lib/solanaClosedPositions';
import { withActivityRouteCache } from '../../lib/activityRouteCache';

// Sprint LPPNL-PERF (Part B1): the wallet tx-history scan is unbounded (scales
// with tx count). Without maxDuration the route dies at Vercel's low default →
// 504 → never caches → re-scan+re-fail every load. 300 s is the Pro ceiling and
// covers the vast majority of real wallets; only extreme bot wallets exceed it.
export const maxDuration = 300;

// Sprint 3-FREE — closed Solana (Orca) position retrieval for Capital G/L.
//
// A closed Orca Whirlpool position's NFT is BURNED on close, so it cannot be
// returned by the dashboard positions route (getNftMints's amount===1 filter
// can't see a burned NFT). This route reconstructs each closed position's
// lifecycle from the wallet's transaction history — scanned via the FREE Alchemy
// Solana endpoint (ALCHEMY_SOLANA_RPC), NOT paid Helius — and values it via the
// historical cascade (DeFiLlama-by-mint → CoinGecko-historical → pending; NEVER
// current spot, Rule 1a) using the REAL on-chain mints (invariant i). Results are
// Redis-cached per wallet under the Sprint 1.14 immutable contract
// (closed_pos_solana_v1), so the ~25k-CU tx scan is paid once then served warm.
//
// Scope: Orca + Raydium (Sprint RAYDIUM) — BOTH protocols reconstructed from at
// most ONE shared wallet scan (per-protocol Redis sub-keys :orca:/:raydium:).
// useLpPnl fetches this per connected/watched Solana address and folds the
// returned positions' Capital G/L into the same totals as EVM + Sui closed
// positions; useWalletLevelFees folds their fee claims into Fee Income (tagged
// by each position's protocol).

// Sprint LPPNL-PERF (Part B2/B3): wrapped in withActivityRouteCache for
// **in-flight dedup**. This route is fetched CONCURRENTLY by TWO client hooks on
// every fresh load — useLpPnl (Capital G/L) and useWalletLevelFees (Fee Income) —
// with the identical `?account=` URL. Un-deduped, that ran the heavy scan TWICE
// at once (double CU + double Alchemy contention, worsening throttling). The
// wrapper's URL-keyed in-flight map collapses both callers onto ONE scan (the
// dominant win), plus a short TTL result mirror. The authoritative durable cache
// remains Redis `closed_pos_solana_v1:*` inside getCachedClosedPositionCapitalGL.
async function GET_impl(request: Request) {
  const { searchParams } = new URL(request.url);
  const account = searchParams.get('account');
  if (!account) {
    return NextResponse.json({ error: 'account required' }, { status: 400 });
  }

  try {
    const positions: SolanaClosedPosition[] = await getCachedClosedPositionCapitalGL(account);
    return NextResponse.json({ positions, count: positions.length, account });
  } catch (err) {
    console.error('[solana-closed-positions] error:', err);
    return NextResponse.json(
      { error: 'Failed to retrieve closed Solana positions', details: String(err) },
      { status: 500 },
    );
  }
}

export const GET = withActivityRouteCache(GET_impl);
