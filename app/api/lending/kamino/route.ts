import { NextResponse } from 'next/server';

// Kamino Finance — main lending market on Solana.
// Public REST API at https://api.kamino.finance/.
//
// We try multiple endpoint shapes in parallel because Kamino's REST surface
// has shifted (the `/v2/...` paths and the older `/kamino-market/...` paths
// coexist for different wallet shards) and a single 404 used to mean "no
// position" when really we just hit the wrong path. Each attempt is logged
// (URL, status, item count, first-row keys) so production failures are
// debuggable from Vercel logs.

const KAMINO_API = 'https://api.kamino.finance';
const MAIN_MARKET = '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF';

interface ReserveMetric {
  reserve?: string;
  liquidityToken?: string;
  liquidityTokenMint?: string;
  liquidityTokenDecimals?: number | string;
  decimals?: number | string;
  supplyApy?: string | number;
  borrowApy?: string | number;
  totalSupplyUsd?: string | number;
  totalBorrowUsd?: string | number;
}

interface ObligationLeg {
  reserveAddress?: string;
  reserve?: string;
  mintAddress?: string;
  mint?: string;
  symbol?: string;
  decimals?: number | string;
  amount?: string | number;
  rawAmount?: string | number;
  depositedAmount?: string | number;
  borrowedAmount?: string | number;
  marketValueUsd?: string | number;
  marketValue?: string | number;
  usdValue?: string | number;
  amountUsd?: string | number;
  apy?: string | number;
  supplyApy?: string | number;
  borrowApy?: string | number;
}

interface RawObligation {
  obligationAddress?: string;
  deposits?: ObligationLeg[];
  borrows?: ObligationLeg[];
  totalCollateralUsd?: string | number;
  totalBorrowUsd?: string | number;
}

async function fetchJson<T>(url: string, label: string): Promise<T | null> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { cache: 'no-store' });
    const ms = Date.now() - t0;
    const bodyText = await res.text();
    const preview = bodyText.slice(0, 200);
    if (!res.ok) {
      console.error(`[kamino/route] FAIL ${label} ${res.status} ${ms}ms ${url} body="${preview}"`);
      return null;
    }
    let data: unknown;
    try { data = JSON.parse(bodyText); }
    catch (err) {
      console.error(`[kamino/route] FAIL parse ${label} ${ms}ms ${url} err=${String(err)} body="${preview}"`);
      return null;
    }
    const sample = Array.isArray(data)
      ? `array(len=${data.length}${data.length > 0 ? `, keys=${Object.keys(data[0] as object).slice(0, 6).join(',')}` : ''})`
      : data && typeof data === 'object'
      ? `object(keys=${Object.keys(data as object).slice(0, 6).join(',')})`
      : typeof data;
    console.log(`[kamino/route] OK ${label} ${res.status} ${ms}ms ${url} → ${sample}`);
    return data as T;
  } catch (err) {
    console.error(`[kamino/route] FAIL throw ${label} ${Date.now() - t0}ms ${url} err=${String(err)}`);
    return null;
  }
}

function n(v: unknown): number {
  if (v == null) return 0;
  const num = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(num) ? num : 0;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const account = (searchParams.get('account') ?? '').trim();
  if (!account) return NextResponse.json({ error: 'account required' }, { status: 400 });
  const enc = encodeURIComponent(account);
  console.log(`[kamino/route] BEGIN account="${account}" market="${MAIN_MARKET}"`);

  // Reserves metrics — used to attach symbol / decimals / APY by reserve key.
  const metrics =
    (await fetchJson<ReserveMetric[]>(
      `${KAMINO_API}/kamino-market/${MAIN_MARKET}/reserves/metrics`,
      'reserves',
    )) ?? [];
  const byReserve = new Map<string, ReserveMetric>();
  const byMint = new Map<string, ReserveMetric>();
  for (const m of metrics) {
    if (m.reserve) byReserve.set(m.reserve, m);
    if (m.liquidityTokenMint) byMint.set(m.liquidityTokenMint, m);
  }

  // Try every known user-positions endpoint shape in parallel — first one
  // that returns a non-empty array wins. Empty/404/error responses are
  // logged but don't abort the search.
  const candidateUrls: Array<[string, string]> = [
    [`${KAMINO_API}/kamino-market/${MAIN_MARKET}/users/${enc}/obligations`, 'obligations:legacy'],
    [`${KAMINO_API}/v2/kamino-market/${MAIN_MARKET}/users/${enc}/obligations`, 'obligations:v2'],
    [`${KAMINO_API}/v2/users/${enc}/markets/${MAIN_MARKET}/obligations`, 'obligations:v2-userfirst'],
    [`${KAMINO_API}/kamino-market/${MAIN_MARKET}/users/${enc}/positions`, 'positions:legacy'],
    [`${KAMINO_API}/v2/kamino-market/${MAIN_MARKET}/users/${enc}/positions`, 'positions:v2'],
  ];
  const obligationResults = await Promise.all(
    candidateUrls.map(([url, label]) => fetchJson<RawObligation[] | { obligations?: RawObligation[] } | null>(url, label)),
  );

  let obligations: RawObligation[] = [];
  let pickedLabel = '<none>';
  for (let i = 0; i < obligationResults.length; i++) {
    const r = obligationResults[i];
    if (!r) continue;
    let arr: RawObligation[] | null = null;
    if (Array.isArray(r)) arr = r as RawObligation[];
    else if (typeof r === 'object' && Array.isArray((r as { obligations?: RawObligation[] }).obligations)) {
      arr = (r as { obligations: RawObligation[] }).obligations;
    }
    if (arr && arr.length > 0) {
      obligations = arr;
      pickedLabel = candidateUrls[i][1];
      break;
    }
  }

  console.log(
    `[kamino/route] account="${account.slice(0, 6)}…" reserves=${metrics.length} ` +
    `obligations=${obligations.length} via=${pickedLabel}`,
  );

  const supplies: Array<{ symbol: string; amount: number; usdValue: number; apy: number }> = [];
  const borrows: Array<{ symbol: string; amount: number; usdValue: number; apy: number }> = [];

  function lookupReserve(leg: ObligationLeg): ReserveMetric | undefined {
    const rk = leg.reserveAddress ?? leg.reserve;
    if (rk && byReserve.has(rk)) return byReserve.get(rk);
    const mk = leg.mintAddress ?? leg.mint;
    if (mk && byMint.has(mk)) return byMint.get(mk);
    return undefined;
  }

  function legAmount(leg: ObligationLeg, metric: ReserveMetric | undefined): number {
    const candidates = [leg.amount, leg.depositedAmount, leg.borrowedAmount, leg.rawAmount];
    for (const c of candidates) {
      if (c == null) continue;
      const num = n(c);
      if (num <= 0) continue;
      const dec = Number(metric?.liquidityTokenDecimals ?? metric?.decimals ?? leg.decimals ?? 0);
      if (dec > 0 && num >= 10 ** Math.max(dec - 2, 1)) return num / 10 ** dec;
      return num;
    }
    return 0;
  }
  function legUsd(leg: ObligationLeg): number {
    const candidates = [leg.marketValueUsd, leg.usdValue, leg.amountUsd, leg.marketValue];
    for (const c of candidates) {
      const num = n(c);
      if (num > 0) return num;
    }
    return 0;
  }

  for (const ob of obligations) {
    console.log(
      `[kamino/route]  obligation=${ob.obligationAddress ?? '?'} ` +
      `deposits=${ob.deposits?.length ?? 0} borrows=${ob.borrows?.length ?? 0}`,
    );
    for (const leg of ob.deposits ?? []) {
      const metric = lookupReserve(leg);
      const symbol = leg.symbol ?? metric?.liquidityToken ?? leg.mint ?? leg.mintAddress ?? 'UNKNOWN';
      const apy = n(leg.apy ?? leg.supplyApy ?? metric?.supplyApy);
      const usd = legUsd(leg);
      const amount = legAmount(leg, metric);
      console.log(`[kamino/route]   + supply ${symbol} amount=${amount.toFixed(6)} usd=${usd.toFixed(2)} apy=${apy.toFixed(2)}%`);
      if (usd <= 0 && amount <= 0) continue;
      supplies.push({ symbol, amount, usdValue: usd, apy });
    }
    for (const leg of ob.borrows ?? []) {
      const metric = lookupReserve(leg);
      const symbol = leg.symbol ?? metric?.liquidityToken ?? leg.mint ?? leg.mintAddress ?? 'UNKNOWN';
      const apy = n(leg.apy ?? leg.borrowApy ?? metric?.borrowApy);
      const usd = legUsd(leg);
      const amount = legAmount(leg, metric);
      console.log(`[kamino/route]   - borrow ${symbol} amount=${amount.toFixed(6)} usd=${usd.toFixed(2)} apy=${apy.toFixed(2)}%`);
      if (usd <= 0 && amount <= 0) continue;
      borrows.push({ symbol, amount, usdValue: usd, apy });
    }
  }

  console.log(
    `[kamino/route] DONE account="${account.slice(0, 6)}…" supplies=${supplies.length} borrows=${borrows.length}`,
  );

  return NextResponse.json({
    supplies,
    borrows,
    protocol: 'Kamino',
    chain: 'Solana',
  });
}
