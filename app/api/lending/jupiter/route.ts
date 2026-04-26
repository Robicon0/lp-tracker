import { NextResponse } from 'next/server';

// Jupiter Lend — covers TWO Solana products under the same `lend/v1` API:
//   • Earn (supply-only)    GET .../lend/v1/earn/positions?users={wallet}
//   • Borrow (collateralised) GET .../lend/v1/borrow/positions?users={wallet}
//
// Different wallets use different products (some only deposit into earn
// vaults, others use the borrow vaults to lever-loop). Querying only one
// product means a wallet with positions in the other comes back empty
// even though the user can see the position on jup.ag/lend. Both
// products are now hit and merged into the same supplies / borrows lists.
//
// Endpoints are queried in parallel against both `lite-api.jup.ag`
// (public, no key) and `api.jup.ag` (requires JUPITER_API_KEY) so a 5xx
// or shard miss on one host doesn't drop a wallet's positions. Both the
// `?users=` and `?wallets=` query-param variants are tried because
// different shards honour different param names.
//
// Detailed `BEGIN`/`OK`/`MERGE`/`+ supply`/`- borrow`/`DONE` logs go to
// the Vercel function log so wallet-by-wallet debugging is straightforward.

const JUPITER_API_KEY = process.env.JUPITER_API_KEY;

interface RawEarnPosition {
  shares?: string;
  underlyingAssets?: string;
  token?: {
    symbol?: string;
    decimals?: number;
    totalRate?: number | string;
    supplyRate?: number | string;
    rewardsRate?: number | string;
    asset?: { symbol?: string; decimals?: number; price?: string | number; address?: string };
  };
}

interface RawBorrowPosition {
  id?: number;
  vaultId?: number;
  address?: string;          // position address
  supply?: string;           // raw, decimals from vault.supplyToken
  borrow?: string;           // raw, decimals from vault.borrowToken
  ownerAddress?: string;
  isSupplyPosition?: boolean;
  vault?: {
    id?: number;
    address?: string;
    supplyRate?: string | number;       // basis points
    borrowRate?: string | number;       // basis points
    supplyToken?: { address?: string; symbol?: string; decimals?: number; price?: string | number };
    borrowToken?: { address?: string; symbol?: string; decimals?: number; price?: string | number };
  };
}

interface AttemptResult<T> {
  url: string;
  status: number | 'error';
  positions: T[] | null;
  shape: string;
}

async function fetchAttempt<T>(url: string, headers: Record<string, string>): Promise<AttemptResult<T>> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers, cache: 'no-store' });
    const ms = Date.now() - t0;
    const bodyText = await res.text();
    if (!res.ok) {
      console.error(`[jupiter/route] FAIL ${res.status} ${ms}ms ${url} body="${bodyText.slice(0, 200)}"`);
      return { url, status: res.status, positions: null, shape: 'http_error' };
    }
    let data: unknown;
    try { data = JSON.parse(bodyText); }
    catch (err) {
      console.error(`[jupiter/route] FAIL parse-json ${ms}ms ${url} err=${String(err)}`);
      return { url, status: res.status, positions: null, shape: 'parse_error' };
    }
    let positions: T[] | null = null;
    let shape = 'unknown';
    if (Array.isArray(data)) { positions = data as T[]; shape = 'array'; }
    else if (data && typeof data === 'object') {
      const d = data as Record<string, unknown>;
      if (Array.isArray(d.positions)) { positions = d.positions as T[]; shape = 'object.positions'; }
      else if (Array.isArray(d.data))  { positions = d.data as T[];      shape = 'object.data'; }
      else if (Array.isArray(d.results)) { positions = d.results as T[]; shape = 'object.results'; }
    }
    console.log(`[jupiter/route] OK ${res.status} ${ms}ms ${url} shape=${shape} count=${positions?.length ?? 'null'}`);
    return { url, status: res.status, positions, shape };
  } catch (err) {
    console.error(`[jupiter/route] FAIL throw ${Date.now() - t0}ms ${url} err=${String(err)}`);
    return { url, status: 'error', positions: null, shape: 'throw' };
  }
}

function buildCandidates<T>(productPath: 'earn' | 'borrow', encoded: string): Array<{ url: string; headers: Record<string, string> }> {
  const liteHost = 'https://lite-api.jup.ag';
  const authHost = 'https://api.jup.ag';
  const path = `/lend/v1/${productPath}/positions`;
  const cands: Array<{ url: string; headers: Record<string, string> }> = [
    { url: `${liteHost}${path}?users=${encoded}`,   headers: { 'Content-Type': 'application/json' } },
    { url: `${liteHost}${path}?wallets=${encoded}`, headers: { 'Content-Type': 'application/json' } },
  ];
  if (JUPITER_API_KEY) {
    cands.push(
      { url: `${authHost}${path}?users=${encoded}`,   headers: { 'x-api-key': JUPITER_API_KEY, 'Content-Type': 'application/json' } },
      { url: `${authHost}${path}?wallets=${encoded}`, headers: { 'x-api-key': JUPITER_API_KEY, 'Content-Type': 'application/json' } },
    );
  }
  return cands;
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
  const encoded = encodeURIComponent(account);
  console.log(`[jupiter/route] BEGIN account="${account}" length=${account.length} keyConfigured=${!!JUPITER_API_KEY}`);

  // Earn product (supply-only vaults like jlUSDC, jlEURC, jlSOL).
  const earnAttempts = await Promise.all(
    buildCandidates<RawEarnPosition>('earn', encoded).map((c) => fetchAttempt<RawEarnPosition>(c.url, c.headers)),
  );
  const earnMerged: RawEarnPosition[] = [];
  const earnSeen = new Set<string>();
  for (const a of earnAttempts) {
    if (!a.positions) continue;
    for (const p of a.positions) {
      const key = `${p.token?.asset?.address ?? ''}::${p.shares ?? p.underlyingAssets ?? ''}`;
      if (earnSeen.has(key)) continue;
      earnSeen.add(key);
      earnMerged.push(p);
    }
  }

  // Borrow product (collateralised supply/borrow vaults).
  const borrowAttempts = await Promise.all(
    buildCandidates<RawBorrowPosition>('borrow', encoded).map((c) => fetchAttempt<RawBorrowPosition>(c.url, c.headers)),
  );
  const borrowMerged: RawBorrowPosition[] = [];
  const borrowSeen = new Set<string>();
  for (const a of borrowAttempts) {
    if (!a.positions) continue;
    for (const p of a.positions) {
      // Dedupe by position address (each position has its own pubkey).
      const key = `${p.address ?? ''}::${p.vaultId ?? ''}`;
      if (borrowSeen.has(key)) continue;
      borrowSeen.add(key);
      borrowMerged.push(p);
    }
  }

  console.log(
    `[jupiter/route] MERGE account="${account.slice(0, 6)}…" ` +
    `earn={tried:${earnAttempts.length}, ok:${earnAttempts.filter(a => a.positions).length}, unique:${earnMerged.length}} ` +
    `borrow={tried:${borrowAttempts.length}, ok:${borrowAttempts.filter(a => a.positions).length}, unique:${borrowMerged.length}}`,
  );

  const supplies: Array<{ symbol: string; amount: number; usdValue: number; apy: number }> = [];
  const borrows: Array<{ symbol: string; amount: number; usdValue: number; apy: number }> = [];

  // Parse Earn product: each position is a supply leg. shares=0 is filtered.
  let earnSkipZero = 0, earnSkipDust = 0;
  for (const pos of earnMerged) {
    try {
      const sharesBig = BigInt(String(pos.shares ?? '0'));
      if (sharesBig === 0n) { earnSkipZero++; continue; }
      const token = pos.token ?? {};
      const asset = token.asset ?? {};
      const symbol = String(asset.symbol ?? token.symbol ?? 'UNKNOWN');
      const decimals = Number(asset.decimals ?? token.decimals ?? 6);
      const amount = Number(BigInt(String(pos.underlyingAssets ?? pos.shares ?? '0'))) / 10 ** decimals;
      if (amount < 0.000001) { earnSkipDust++; continue; }
      const price = n(asset.price);
      const apy = n(token.totalRate ?? token.supplyRate) / 100;
      console.log(`[jupiter/route]  + earn ${symbol} amount=${amount.toFixed(6)} usd=${(amount * price).toFixed(2)} apy=${apy.toFixed(2)}%`);
      supplies.push({ symbol, amount, usdValue: amount * price, apy });
    } catch (err) {
      console.error(`[jupiter/route] earn parse-error: ${String(err)}`);
    }
  }

  // Parse Borrow product: each position has BOTH a supply (collateral) and
  // a borrow leg, possibly zero. Emit non-zero ones into the appropriate
  // bucket. Rates come from vault.supplyRate / vault.borrowRate (basis points).
  let borrowSkipEmpty = 0;
  for (const pos of borrowMerged) {
    try {
      const vault = pos.vault ?? {};
      const st = vault.supplyToken ?? {};
      const bt = vault.borrowToken ?? {};
      const supRaw = BigInt(String(pos.supply ?? '0'));
      const borRaw = BigInt(String(pos.borrow ?? '0'));
      if (supRaw === 0n && borRaw === 0n) { borrowSkipEmpty++; continue; }

      if (supRaw > 0n) {
        const decimals = Number(st.decimals ?? 6);
        const amount = Number(supRaw) / 10 ** decimals;
        const price = n(st.price);
        const apy = n(vault.supplyRate) / 100;
        const symbol = String(st.symbol ?? 'UNKNOWN');
        console.log(`[jupiter/route]  + borrow-product collateral ${symbol} amount=${amount.toFixed(6)} usd=${(amount * price).toFixed(2)} apy=${apy.toFixed(2)}%`);
        supplies.push({ symbol, amount, usdValue: amount * price, apy });
      }
      if (borRaw > 0n) {
        const decimals = Number(bt.decimals ?? 6);
        const amount = Number(borRaw) / 10 ** decimals;
        const price = n(bt.price);
        const apy = n(vault.borrowRate) / 100;
        const symbol = String(bt.symbol ?? 'UNKNOWN');
        console.log(`[jupiter/route]  - borrow-product debt ${symbol} amount=${amount.toFixed(6)} usd=${(amount * price).toFixed(2)} apy=${apy.toFixed(2)}%`);
        borrows.push({ symbol, amount, usdValue: amount * price, apy });
      }
    } catch (err) {
      console.error(`[jupiter/route] borrow-product parse-error: ${String(err)}`);
    }
  }

  console.log(
    `[jupiter/route] DONE account="${account.slice(0, 6)}…" ` +
    `supplies=${supplies.length} borrows=${borrows.length} ` +
    `earnSkipped(zero=${earnSkipZero},dust=${earnSkipDust}) borrowSkippedEmpty=${borrowSkipEmpty}`,
  );

  return NextResponse.json({
    supplies,
    borrows,
    protocol: 'Jupiter Lend',
    chain: 'Solana',
  });
}
