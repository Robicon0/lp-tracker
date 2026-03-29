import { NextResponse } from 'next/server';

// Jupiter Lend REST API — requires API key from https://portal.jup.ag
// Set JUPITER_API_KEY in .env.local to enable this integration.
//
// Actual response shape (verified 2026-03-29):
//   GET /earn/positions?users={address}
//   Returns: Array<{
//     token: { symbol, decimals, asset: { symbol, decimals, price }, supplyRate, rewardsRate, totalRate },
//     ownerAddress, shares, underlyingAssets, underlyingBalance, allowance
//   }>
//   - shares/underlyingAssets are raw integer strings (divide by 10^decimals)
//   - totalRate = supplyRate + rewardsRate, in basis points (e.g. 347 = 3.47% APY)
//   - token.asset.price is a USD price string already provided (no CoinGecko needed)
const JUPITER_API_KEY = process.env.JUPITER_API_KEY;
const JUPITER_BASE    = 'https://api.jup.ag/lend/v1';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const account = searchParams.get('account');

  if (!account) return NextResponse.json({ error: 'account required' }, { status: 400 });

  if (!JUPITER_API_KEY) {
    return NextResponse.json({
      supplies: [],
      borrows: [],
      protocol: 'Jupiter Lend',
      chain: 'Solana',
      note: 'JUPITER_API_KEY not configured — get a free key at https://portal.jup.ag',
    });
  }

  try {
    console.log(`[jupiter/route] Fetching positions for ${account}`);
    const res = await fetch(
      `${JUPITER_BASE}/earn/positions?users=${account}`,
      { headers: { 'x-api-key': JUPITER_API_KEY, 'Content-Type': 'application/json' } },
    );

    if (!res.ok) {
      console.error(`[jupiter/route] API error ${res.status}: ${await res.text()}`);
      return NextResponse.json({ supplies: [], borrows: [], protocol: 'Jupiter Lend', chain: 'Solana' });
    }

    const data = await res.json();
    console.log(`[jupiter/route] Raw response type: ${typeof data}, isArray: ${Array.isArray(data)}, keys: ${typeof data === 'object' ? Object.keys(data ?? {}).join(',') : 'n/a'}`);

    // Response is a flat array of all token positions for the user (including zero-balance ones)
    const rawPositions: Record<string, unknown>[] = Array.isArray(data) ? data
      : Array.isArray(data?.positions) ? (data.positions as Record<string, unknown>[])
      : [];

    console.log(`[jupiter/route] Total positions in response: ${rawPositions.length}`);

    const supplies: Array<{ symbol: string; amount: number; usdValue: number; apy: number }> = [];
    const borrows:  Array<{ symbol: string; amount: number; usdValue: number; apy: number }> = [];

    for (const pos of rawPositions) {
      try {
        // Filter zero-share positions first
        const sharesBig = BigInt(String(pos.shares ?? '0'));
        if (sharesBig === 0n) continue;

        const token = (pos.token as Record<string, unknown>) ?? {};
        const asset = (token.asset as Record<string, unknown>) ?? {};

        // Prefer asset.symbol (underlying token, e.g. "USDC") over token.symbol (vault token, e.g. "jlUSDC")
        const symbol   = String(asset.symbol ?? token.symbol ?? 'UNKNOWN');
        const decimals = Number(asset.decimals ?? token.decimals ?? 6);

        // underlyingAssets = amount deposited in the protocol (in raw integer units)
        const rawAmt = String(pos.underlyingAssets ?? pos.shares ?? '0');
        const amount = Number(BigInt(rawAmt)) / Math.pow(10, decimals);

        if (amount < 0.000001) {
          console.log(`[jupiter/route] Skipping ${symbol}: amount too small (${amount})`);
          continue;
        }

        // Price is provided directly by the API in token.asset.price
        const price    = parseFloat(String(asset.price ?? '0'));
        const usdValue = amount * price;

        // totalRate = supplyRate + rewardsRate, in basis points (divide by 100 to get %)
        const apy = Number(token.totalRate ?? token.supplyRate ?? 0) / 100;

        console.log(`[jupiter/route] Position: ${symbol} amount=${amount.toFixed(4)} usd=${usdValue.toFixed(2)} apy=${apy.toFixed(2)}%`);

        // Jupiter Lend earn positions are supply-only (borrow API is "coming soon")
        supplies.push({ symbol, amount, usdValue, apy });
      } catch (err) {
        console.error('[jupiter/route] position parse failed:', err, JSON.stringify(pos).slice(0, 200));
      }
    }

    console.log(`[jupiter/route] Parsed ${supplies.length} supply positions`);
    return NextResponse.json({ supplies, borrows, protocol: 'Jupiter Lend', chain: 'Solana' });
  } catch (err) {
    console.error('[jupiter/route] fetch failed:', err);
    return NextResponse.json({ supplies: [], borrows: [], error: String(err) });
  }
}
