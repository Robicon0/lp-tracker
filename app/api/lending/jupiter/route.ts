import { NextResponse } from 'next/server';

// Jupiter Lend (a.k.a. Jupiter Earn) supply positions for a Solana wallet.
//
// The endpoint shape changed in early 2026: the public path is
//   GET https://lite-api.jup.ag/lend/v1/earn/positions?users={wallet}
// and the API-key path is
//   GET https://api.jup.ag/lend/v1/earn/positions?users={wallet}
//
// Some wallets returned empty even when they had positions because:
//   (1) the wallet base58 address was not URL-encoded → `+`/`/` chars broke,
//   (2) only one of the two endpoints was being tried (key path 401s for
//       wallets the key isn't entitled to, lite path is open),
//   (3) the array `users` param is sometimes only honoured under one host.
//
// This route now tries lite-api first (no key, always works), then falls
// back to api.jup.ag with the key when set. Each attempt URL-encodes the
// wallet, accepts both `?users=` and `?wallets=`, and merges supplies
// from any successful call (deduped by token mint).

const JUPITER_API_KEY = process.env.JUPITER_API_KEY;

interface RawPosition {
  shares?: string;
  underlyingAssets?: string;
  ownerAddress?: string;
  token?: {
    symbol?: string;
    decimals?: number;
    totalRate?: number | string;
    supplyRate?: number | string;
    rewardsRate?: number | string;
    asset?: { symbol?: string; decimals?: number; price?: string | number; address?: string };
  };
}

async function fetchAttempt(url: string, headers: Record<string, string>): Promise<RawPosition[] | null> {
  try {
    const res = await fetch(url, { headers, cache: 'no-store' });
    if (!res.ok) {
      console.error(`[jupiter/route] ${url} → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return null;
    }
    const data = await res.json();
    if (Array.isArray(data)) return data as RawPosition[];
    if (Array.isArray(data?.positions)) return data.positions as RawPosition[];
    return null;
  } catch (err) {
    console.error(`[jupiter/route] ${url} threw:`, err);
    return null;
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const account = searchParams.get('account');
  if (!account) return NextResponse.json({ error: 'account required' }, { status: 400 });

  const encoded = encodeURIComponent(account);
  const candidates: Array<{ url: string; headers: Record<string, string> }> = [
    { url: `https://lite-api.jup.ag/lend/v1/earn/positions?users=${encoded}`, headers: { 'Content-Type': 'application/json' } },
    { url: `https://lite-api.jup.ag/lend/v1/earn/positions?wallets=${encoded}`, headers: { 'Content-Type': 'application/json' } },
  ];
  if (JUPITER_API_KEY) {
    candidates.push(
      { url: `https://api.jup.ag/lend/v1/earn/positions?users=${encoded}`, headers: { 'x-api-key': JUPITER_API_KEY, 'Content-Type': 'application/json' } },
      { url: `https://api.jup.ag/lend/v1/earn/positions?wallets=${encoded}`, headers: { 'x-api-key': JUPITER_API_KEY, 'Content-Type': 'application/json' } },
    );
  }

  // Hit endpoints in parallel and merge. Dedupe by token-asset address since
  // the same vault may be returned twice across endpoints (or zero-share
  // duplicates may exist in the response).
  const results = await Promise.all(candidates.map((c) => fetchAttempt(c.url, c.headers)));
  const merged: RawPosition[] = [];
  const seen = new Set<string>();
  for (const arr of results) {
    if (!arr) continue;
    for (const p of arr) {
      const key = `${p.token?.asset?.address ?? ''}::${p.shares ?? p.underlyingAssets ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(p);
    }
  }
  console.log(`[jupiter/route] ${account.slice(0, 6)}…: ${candidates.length} endpoints tried, ${merged.length} unique positions found`);

  const supplies: Array<{ symbol: string; amount: number; usdValue: number; apy: number }> = [];

  for (const pos of merged) {
    try {
      const sharesBig = BigInt(String(pos.shares ?? '0'));
      if (sharesBig === 0n) continue;

      const token = pos.token ?? {};
      const asset = token.asset ?? {};
      const symbol = String(asset.symbol ?? token.symbol ?? 'UNKNOWN');
      const decimals = Number(asset.decimals ?? token.decimals ?? 6);

      const rawAmt = String(pos.underlyingAssets ?? pos.shares ?? '0');
      const amount = Number(BigInt(rawAmt)) / Math.pow(10, decimals);
      if (amount < 0.000001) continue;

      const price = parseFloat(String(asset.price ?? '0'));
      const usdValue = amount * price;
      const apy = Number(token.totalRate ?? token.supplyRate ?? 0) / 100;

      supplies.push({ symbol, amount, usdValue, apy });
    } catch (err) {
      console.error('[jupiter/route] parse failed:', err, JSON.stringify(pos).slice(0, 200));
    }
  }

  return NextResponse.json({
    supplies,
    borrows: [], // Jupiter Earn is supply-only; borrow product not yet exposed via this endpoint.
    protocol: 'Jupiter Lend',
    chain: 'Solana',
  });
}
