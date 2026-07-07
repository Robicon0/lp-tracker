import { NextResponse } from 'next/server';
import { getCachedClosedPositionCapitalGL, type SolanaClosedPosition } from '../../lib/solanaClosedPositions';

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

export async function GET(request: Request) {
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
