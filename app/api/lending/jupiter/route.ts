import { NextResponse } from 'next/server';

// Jupiter Lend (a.k.a. Jupiter Earn) — supply positions for a Solana wallet.
//
// We hit four candidate endpoints in parallel because the API has shifted
// hosts and param names a few times in 2026 and different wallets land on
// different shards:
//   GET https://lite-api.jup.ag/lend/v1/earn/positions?users={wallet}    (public)
//   GET https://lite-api.jup.ag/lend/v1/earn/positions?wallets={wallet}  (public)
//   GET https://api.jup.ag/lend/v1/earn/positions?users={wallet}         (key)
//   GET https://api.jup.ag/lend/v1/earn/positions?wallets={wallet}       (key)
// Surviving responses are merged + deduped.
//
// This route logs heavily on purpose. If a wallet shows positions on
// jup.ag/lend but not in DefiDesh, the Vercel function logs make the
// failure mode obvious: which URL was hit, status, response shape,
// raw item count, parse skips with reasons, and the final supply count.

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

interface AttemptResult {
  url: string;
  status: number | "error";
  positions: RawPosition[] | null;
  shape: string;
  bodyPreview: string;
}

async function fetchAttempt(url: string, headers: Record<string, string>): Promise<AttemptResult> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers, cache: 'no-store' });
    const ms = Date.now() - t0;
    const bodyText = await res.text();
    const bodyPreview = bodyText.slice(0, 200);
    if (!res.ok) {
      console.error(`[jupiter/route] FAIL ${res.status} ${ms}ms ${url} body="${bodyPreview}"`);
      return { url, status: res.status, positions: null, shape: 'http_error', bodyPreview };
    }
    let data: unknown;
    try { data = JSON.parse(bodyText); }
    catch (err) {
      console.error(`[jupiter/route] FAIL parse-json ${ms}ms ${url} err=${String(err)} body="${bodyPreview}"`);
      return { url, status: res.status, positions: null, shape: 'parse_error', bodyPreview };
    }
    let positions: RawPosition[] | null = null;
    let shape = 'unknown';
    if (Array.isArray(data)) { positions = data as RawPosition[]; shape = 'array'; }
    else if (data && typeof data === 'object') {
      const d = data as Record<string, unknown>;
      if (Array.isArray(d.positions)) { positions = d.positions as RawPosition[]; shape = 'object.positions'; }
      else if (Array.isArray(d.data)) { positions = d.data as RawPosition[]; shape = 'object.data'; }
      else if (Array.isArray(d.results)) { positions = d.results as RawPosition[]; shape = 'object.results'; }
    }
    console.log(`[jupiter/route] OK ${res.status} ${ms}ms ${url} shape=${shape} count=${positions?.length ?? 'null'}`);
    return { url, status: res.status, positions, shape, bodyPreview };
  } catch (err) {
    console.error(`[jupiter/route] FAIL throw ${Date.now() - t0}ms ${url} err=${String(err)}`);
    return { url, status: 'error', positions: null, shape: 'throw', bodyPreview: String(err).slice(0, 200) };
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const account = searchParams.get('account');
  if (!account) return NextResponse.json({ error: 'account required' }, { status: 400 });

  const trimmed = account.trim();
  const encoded = encodeURIComponent(trimmed);
  console.log(`[jupiter/route] BEGIN account="${trimmed}" length=${trimmed.length} keyConfigured=${!!JUPITER_API_KEY}`);

  const candidates: Array<{ url: string; headers: Record<string, string> }> = [
    { url: `https://lite-api.jup.ag/lend/v1/earn/positions?users=${encoded}`,    headers: { 'Content-Type': 'application/json' } },
    { url: `https://lite-api.jup.ag/lend/v1/earn/positions?wallets=${encoded}`,  headers: { 'Content-Type': 'application/json' } },
  ];
  if (JUPITER_API_KEY) {
    candidates.push(
      { url: `https://api.jup.ag/lend/v1/earn/positions?users=${encoded}`,    headers: { 'x-api-key': JUPITER_API_KEY, 'Content-Type': 'application/json' } },
      { url: `https://api.jup.ag/lend/v1/earn/positions?wallets=${encoded}`,  headers: { 'x-api-key': JUPITER_API_KEY, 'Content-Type': 'application/json' } },
    );
  }

  const attempts = await Promise.all(candidates.map((c) => fetchAttempt(c.url, c.headers)));

  // Merge + dedupe across all surviving responses.
  const merged: RawPosition[] = [];
  const seen = new Set<string>();
  for (const a of attempts) {
    if (!a.positions) continue;
    for (const p of a.positions) {
      const key = `${p.token?.asset?.address ?? ''}::${p.shares ?? p.underlyingAssets ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(p);
    }
  }
  const successfulShapes = attempts.filter((a) => a.positions != null).map((a) => a.shape);
  console.log(
    `[jupiter/route] MERGE account="${trimmed.slice(0, 6)}…" tried=${attempts.length} ` +
    `succeeded=${successfulShapes.length}/${attempts.length} shapes=[${successfulShapes.join(',')}] ` +
    `unique=${merged.length}`,
  );

  const supplies: Array<{ symbol: string; amount: number; usdValue: number; apy: number }> = [];
  let skipZeroShares = 0;
  let skipDust = 0;
  let skipParseError = 0;

  for (const pos of merged) {
    try {
      const sharesBig = BigInt(String(pos.shares ?? '0'));
      if (sharesBig === 0n) { skipZeroShares++; continue; }

      const token = pos.token ?? {};
      const asset = token.asset ?? {};
      const symbol = String(asset.symbol ?? token.symbol ?? 'UNKNOWN');
      const decimals = Number(asset.decimals ?? token.decimals ?? 6);

      const rawAmt = String(pos.underlyingAssets ?? pos.shares ?? '0');
      const amount = Number(BigInt(rawAmt)) / Math.pow(10, decimals);
      if (amount < 0.000001) { skipDust++; continue; }

      const price = parseFloat(String(asset.price ?? '0'));
      const usdValue = amount * price;
      const apy = Number(token.totalRate ?? token.supplyRate ?? 0) / 100;

      console.log(`[jupiter/route]  + ${symbol} amount=${amount.toFixed(6)} usd=${usdValue.toFixed(2)} apy=${apy.toFixed(2)}%`);
      supplies.push({ symbol, amount, usdValue, apy });
    } catch (err) {
      skipParseError++;
      console.error(`[jupiter/route] parse-error pos=${JSON.stringify(pos).slice(0, 200)} err=${String(err)}`);
    }
  }

  console.log(
    `[jupiter/route] DONE account="${trimmed.slice(0, 6)}…" supplies=${supplies.length} ` +
    `skipped(zero=${skipZeroShares} dust=${skipDust} parse=${skipParseError})`,
  );

  return NextResponse.json({
    supplies,
    borrows: [], // earn product is supply-only; borrow API not yet available
    protocol: 'Jupiter Lend',
    chain: 'Solana',
  });
}
