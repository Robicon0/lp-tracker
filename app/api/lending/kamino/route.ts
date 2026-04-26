import { NextResponse } from 'next/server';

// Kamino Finance — three lending markets on Solana, queried per wallet:
//   Main     7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF
//   JLP      DxXdAyU3kCjnyggvHmY5nAwg5cRbbmdyX3npfDMjjMek
//   Altcoins ByYiZxp8QrdENEaskMe388D4kFqFSFJ8ZKMjKcFnf4o5
//
// Public REST API at https://api.kamino.finance/. We fan out one
// `reserves/metrics` + one `users/{wallet}/obligations` call per market in
// parallel, then aggregate every non-empty obligation into a single
// supplies/borrows pair (markets are summed because all three feed into
// the same protocol card).
//
// Real obligation response shape (verified live 2026-04-26):
//   [{
//     obligationAddress,
//     state: {
//       deposits: [{ depositReserve, depositedAmount, marketValueSf, ... }],
//       borrows:  [{ borrowReserve,  borrowedAmountSf, marketValueSf, ... }],
//     },
//     refreshedStats: { userTotalDeposit, userTotalBorrow, ... },
//   }]
// `marketValueSf` is a Q60 fixed-point USD value (divide by 2^60). This
// applies to BOTH deposits and borrows — for borrows it's already the USD
// value, not the raw token amount (e.g. a $0.006 dust borrow shows
// marketValueSf/2^60 = 0.006, while a $3,931 USDC borrow shows 3,931).
// `depositedAmount` is raw underlying-token base units (apply reserve
// decimals to get the human number for display).

const KAMINO_API = 'https://api.kamino.finance';
const MARKETS: Array<{ key: string; pubkey: string }> = [
  { key: 'Main',     pubkey: '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF' },
  { key: 'JLP',      pubkey: 'DxXdAyU3kCjnyggvHmY5nAwg5cRbbmdyX3npfDMjjMek' },
  { key: 'Altcoins', pubkey: 'ByYiZxp8QrdENEaskMe388D4kFqFSFJ8ZKMjKcFnf4o5' },
];

const TWO_60 = 2n ** 60n;

interface ReserveMetric {
  reserve?: string;
  liquidityToken?: string;
  liquidityTokenMint?: string;
  liquidityTokenDecimals?: number | string;
  decimals?: number | string;
  supplyApy?: string | number;
  borrowApy?: string | number;
  totalSupply?: string | number;
  totalBorrow?: string | number;
  totalSupplyUsd?: string | number;
  totalBorrowUsd?: string | number;
}

interface DepositLeg {
  depositReserve?: string;
  depositedAmount?: string;
  marketValueSf?: string;
}

interface BorrowLeg {
  borrowReserve?: string;
  borrowedAmountSf?: string;
  marketValueSf?: string;
  borrowedAmountOutsideElevationGroups?: string;
}

interface RawObligation {
  obligationAddress?: string;
  state?: {
    deposits?: DepositLeg[];
    borrows?: BorrowLeg[];
    owner?: string;
  };
}

async function fetchJson<T>(url: string, label: string): Promise<T | null> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { cache: 'no-store' });
    const ms = Date.now() - t0;
    if (!res.ok) {
      console.error(`[kamino/route] FAIL ${label} ${res.status} ${ms}ms ${url}`);
      return null;
    }
    const data = (await res.json()) as T;
    console.log(`[kamino/route] OK ${label} ${res.status} ${ms}ms ${url}`);
    return data;
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

// Q60 fixed-point USD → JS number. Divide BigInt(value) by 2^60. Safe for
// any value Kamino ever emits because USD totals never approach Number.MAX.
function sfToUsd(sf: string | undefined): number {
  if (!sf) return 0;
  try {
    const big = BigInt(sf);
    // Split high/low to keep precision: usd_int = big / 2^60, frac = (big % 2^60) / 2^60
    const intPart = big / TWO_60;
    const remPart = big % TWO_60;
    return Number(intPart) + Number(remPart) / Number(TWO_60);
  } catch {
    return 0;
  }
}

interface NormalisedAsset { symbol: string; amount: number; usdValue: number; apy: number; }

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const account = (searchParams.get('account') ?? '').trim();
  if (!account) return NextResponse.json({ error: 'account required' }, { status: 400 });
  console.log(`[kamino/route] BEGIN account="${account}" markets=${MARKETS.length}`);

  // Per-market parallel fetches: each market needs its OWN reserves metric
  // map (reserves are scoped to a market) and its own obligations list.
  const marketResults = await Promise.all(MARKETS.map(async (market) => {
    const [metrics, obligations] = await Promise.all([
      fetchJson<ReserveMetric[]>(
        `${KAMINO_API}/kamino-market/${market.pubkey}/reserves/metrics`,
        `${market.key}:reserves`,
      ),
      fetchJson<RawObligation[]>(
        `${KAMINO_API}/kamino-market/${market.pubkey}/users/${encodeURIComponent(account)}/obligations`,
        `${market.key}:obligations`,
      ),
    ]);
    return { market, metrics: metrics ?? [], obligations: obligations ?? [] };
  }));

  const supplies: NormalisedAsset[] = [];
  const borrows: NormalisedAsset[] = [];

  for (const { market, metrics, obligations } of marketResults) {
    if (obligations.length === 0) {
      console.log(`[kamino/route]  ${market.key}: 0 obligations`);
      continue;
    }
    const byReserve = new Map<string, ReserveMetric>();
    for (const m of metrics) if (m.reserve) byReserve.set(m.reserve, m);

    for (const ob of obligations) {
      const deposits = ob.state?.deposits ?? [];
      const borrowsArr = ob.state?.borrows ?? [];
      console.log(
        `[kamino/route]  ${market.key} obligation=${ob.obligationAddress?.slice(0, 8)}… ` +
        `deposits=${deposits.length} borrows=${borrowsArr.length}`,
      );

      for (const d of deposits) {
        const usdValue = sfToUsd(d.marketValueSf);
        if (usdValue <= 0) continue;
        const reserve = d.depositReserve ? byReserve.get(d.depositReserve) : undefined;
        const symbol = reserve?.liquidityToken ?? d.depositReserve ?? 'UNKNOWN';
        const apy = n(reserve?.supplyApy) * 100;
        // Derive price-per-token from the reserve's totalSupplyUsd / totalSupply
        // (both are in human units in the metrics endpoint).
        const supplyHuman = n(reserve?.totalSupply);
        const supplyUsd = n(reserve?.totalSupplyUsd);
        const price = supplyHuman > 0 ? supplyUsd / supplyHuman : 0;
        const amount = price > 0 ? usdValue / price : 0;
        console.log(`[kamino/route]   + ${market.key} supply ${symbol} amount=${amount.toFixed(6)} usd=${usdValue.toFixed(2)} apy=${apy.toFixed(2)}%`);
        supplies.push({ symbol, amount, usdValue, apy });
      }

      for (const b of borrowsArr) {
        const usdValue = sfToUsd(b.marketValueSf);
        if (usdValue <= 0.01) continue; // ignore dust borrows
        const reserve = b.borrowReserve ? byReserve.get(b.borrowReserve) : undefined;
        const symbol = reserve?.liquidityToken ?? b.borrowReserve ?? 'UNKNOWN';
        const apy = n(reserve?.borrowApy) * 100;
        const borrowHuman = n(reserve?.totalBorrow);
        const borrowUsd = n(reserve?.totalBorrowUsd);
        const price = borrowHuman > 0 ? borrowUsd / borrowHuman : 0;
        const amount = price > 0 ? usdValue / price : 0;
        console.log(`[kamino/route]   - ${market.key} borrow ${symbol} amount=${amount.toFixed(6)} usd=${usdValue.toFixed(2)} apy=${apy.toFixed(2)}%`);
        borrows.push({ symbol, amount, usdValue, apy });
      }
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
