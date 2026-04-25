import { NextResponse } from 'next/server';

// Kamino Finance — main lending market on Solana.
//
// Public REST API at https://api.kamino.finance/. We use:
//   GET /kamino-market/{market}/reserves/metrics
//     → array of { reserve, liquidityToken, liquidityTokenMint, supplyApy,
//                  borrowApy, totalSupplyUsd, totalBorrowUsd, ... }
//     Used as the source of truth for symbol / mint / decimals / APY.
//
//   GET /kamino-market/{market}/users/{wallet}/obligations
//     → array of obligation objects (one per obligation account a wallet
//       owns under this market). Each carries `deposits[]` + `borrows[]`
//       with raw amounts; some endpoints also include `marketValueUsd`.
//
// We translate each on-chain obligation into supplies/borrows with USD
// values. APY + symbol are looked up from the reserves metrics map by
// reserve account pubkey OR by liquidity token mint. If a position is
// from a reserve we don't have metadata for (new listings), we fall back
// to its mint as the symbol so it still shows up — never silently dropped.

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
  exchangeRate?: string | number;
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
  marketValueUsd?: string | number;
  totalCollateralUsd?: string | number;
  totalBorrowUsd?: string | number;
  totalDepositedUsd?: string | number;
  loanToValue?: string | number;
  borrowUtilization?: string | number;
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) {
      console.error(`[kamino/route] ${url} → HTTP ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.error(`[kamino/route] ${url} threw:`, err);
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
  const account = searchParams.get('account');
  if (!account) return NextResponse.json({ error: 'account required' }, { status: 400 });

  // Reserves metrics — used to attach symbol / decimals / APY by reserve key.
  const metrics =
    (await fetchJson<ReserveMetric[]>(`${KAMINO_API}/kamino-market/${MAIN_MARKET}/reserves/metrics`)) ?? [];
  // Index by reserve account pubkey AND by liquidityTokenMint. Different
  // shapes of obligation responses reference one or the other.
  const byReserve = new Map<string, ReserveMetric>();
  const byMint = new Map<string, ReserveMetric>();
  for (const m of metrics) {
    if (m.reserve) byReserve.set(m.reserve, m);
    if (m.liquidityTokenMint) byMint.set(m.liquidityTokenMint, m);
  }

  // User obligations.
  const obligations =
    (await fetchJson<RawObligation[]>(
      `${KAMINO_API}/kamino-market/${MAIN_MARKET}/users/${encodeURIComponent(account)}/obligations`,
    )) ?? [];

  console.log(`[kamino/route] ${account.slice(0, 6)}…: ${obligations.length} obligation(s), ${metrics.length} reserves`);

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
    // Prefer human-readable amount fields, then fall back to raw / decimals.
    const candidates = [leg.amount, leg.depositedAmount, leg.borrowedAmount, leg.rawAmount];
    for (const c of candidates) {
      if (c == null) continue;
      const num = n(c);
      if (num <= 0) continue;
      // Heuristic: if magnitude is huge AND we have decimals, treat as raw.
      const dec = Number(metric?.liquidityTokenDecimals ?? metric?.decimals ?? leg.decimals ?? 0);
      if (dec > 0 && num >= 10 ** Math.max(dec - 2, 1)) {
        return num / 10 ** dec;
      }
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
    for (const leg of ob.deposits ?? []) {
      const metric = lookupReserve(leg);
      const symbol = leg.symbol ?? metric?.liquidityToken ?? leg.mint ?? leg.mintAddress ?? 'UNKNOWN';
      const apy = n(leg.apy ?? leg.supplyApy ?? metric?.supplyApy);
      const usd = legUsd(leg);
      const amount = legAmount(leg, metric);
      if (usd <= 0 && amount <= 0) continue;
      supplies.push({ symbol, amount, usdValue: usd, apy });
    }
    for (const leg of ob.borrows ?? []) {
      const metric = lookupReserve(leg);
      const symbol = leg.symbol ?? metric?.liquidityToken ?? leg.mint ?? leg.mintAddress ?? 'UNKNOWN';
      const apy = n(leg.apy ?? leg.borrowApy ?? metric?.borrowApy);
      const usd = legUsd(leg);
      const amount = legAmount(leg, metric);
      if (usd <= 0 && amount <= 0) continue;
      borrows.push({ symbol, amount, usdValue: usd, apy });
    }
  }

  return NextResponse.json({
    supplies,
    borrows,
    protocol: 'Kamino',
    chain: 'Solana',
  });
}
