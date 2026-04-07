// Snapshot cron — runs every 4 hours via vercel.json cron config.
// Iterates over all wallets in the `wallets` table and writes a
// portfolio_snapshots row + one position_snapshots row per LP position.
//
// Authentication: requires `Authorization: Bearer ${CRON_SECRET}` header.
// Vercel cron jobs send this automatically when CRON_SECRET is set.
// Manual trigger from the analytics page also passes the same header.

import { NextRequest, NextResponse } from "next/server";
import { sql, isDbConfigured } from "../../../lib/db";
import type { AerodromePosition } from "../../../lib/aerodrome";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type WalletRow = { address: string; chain: string };

// EVM = call Aerodrome / Uniswap V3 / Velodrome / HyperSwap / PancakeSwap
// solana = Raydium / Orca
// sui = Cetus / Bluefin / Momentum
const EVM_ROUTES = ["aerodrome", "uniswap/v3", "velodrome", "hyperswap", "pancakeswap"];
const SOL_ROUTES = ["raydium", "orca"];
const SUI_ROUTES = ["cetus", "bluefin", "momentum"];

function baseUrlFrom(req: NextRequest): string {
  // Prefer the explicit incoming host so this works on local + Vercel.
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  if (host) return `${proto}://${host}`;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

async function fetchPositions(base: string, route: string, account: string): Promise<AerodromePosition[]> {
  try {
    const r = await fetch(`${base}/api/${route}?account=${account}`, { cache: "no-store" });
    if (!r.ok) return [];
    const data = await r.json();
    return data.positions || [];
  } catch (e) {
    console.error(`[snapshot] fetch ${route} for ${account} failed:`, e);
    return [];
  }
}

async function snapshotWallet(base: string, wallet: WalletRow): Promise<{ ok: boolean; positionCount: number; totalValue: number }> {
  const routes =
    wallet.chain === "evm" ? EVM_ROUTES :
    wallet.chain === "solana" ? SOL_ROUTES :
    wallet.chain === "sui" ? SUI_ROUTES : [];

  if (routes.length === 0) return { ok: false, positionCount: 0, totalValue: 0 };

  const results = await Promise.all(routes.map((r) => fetchPositions(base, r, wallet.address)));
  const positions: AerodromePosition[] = results.flat();

  // Compute aggregates
  const lpValue = positions.reduce((s, p) => s + (p.value || 0), 0);
  const totalFees = positions.reduce((s, p) => s + (p.fees || 0), 0);
  const totalValue = lpValue; // lending/token captured separately if available below

  // Insert portfolio snapshot
  await sql`
    INSERT INTO portfolio_snapshots
      (wallet_address, total_value, lp_value, lending_value, token_value, total_fees_earned, position_count)
    VALUES
      (${wallet.address}, ${totalValue}, ${lpValue}, 0, 0, ${totalFees}, ${positions.length})
  `;

  // Insert per-position snapshots
  for (const p of positions) {
    await sql`
      INSERT INTO position_snapshots
        (wallet_address, position_id, protocol, chain, token_pair, value, uncollected_fees, claimed_fees, status)
      VALUES
        (${wallet.address}, ${p.id}, ${p.protocol}, ${p.chain}, ${p.pair}, ${p.value || 0}, ${p.fees || 0}, 0, ${p.status})
    `;
  }

  // Bump last_seen
  await sql`UPDATE wallets SET last_seen = NOW() WHERE address = ${wallet.address}`;

  return { ok: true, positionCount: positions.length, totalValue };
}

async function handle(req: NextRequest) {
  if (!isDbConfigured()) {
    return NextResponse.json(
      { ok: false, error: "Database not configured. Set POSTGRES_URL in env." },
      { status: 503 },
    );
  }

  // Auth: require CRON_SECRET if it is set. (If unset we allow it through for
  // first-time local testing — production should always have CRON_SECRET set.)
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
  }

  // Optional `?wallet=0x...` for manual single-wallet snapshot
  const url = new URL(req.url);
  const filterWallet = url.searchParams.get("wallet");
  const filterChain = url.searchParams.get("chain"); // optional override

  let wallets: WalletRow[];
  if (filterWallet) {
    wallets = [{ address: filterWallet, chain: filterChain || "evm" }];
  } else {
    const { rows } = await sql<WalletRow>`SELECT address, chain FROM wallets`;
    wallets = rows;
  }

  if (wallets.length === 0) {
    return NextResponse.json({ ok: true, snapshotted: 0, message: "No wallets registered yet." });
  }

  const base = baseUrlFrom(req);
  const results = [];
  for (const w of wallets) {
    try {
      const r = await snapshotWallet(base, w);
      results.push({ wallet: w.address, ...r });
    } catch (e) {
      console.error(`[snapshot] wallet ${w.address} failed:`, e);
      results.push({ wallet: w.address, ok: false, error: String(e) });
    }
  }

  return NextResponse.json({
    ok: true,
    snapshotted: results.filter((r) => r.ok).length,
    total: wallets.length,
    timestamp: new Date().toISOString(),
    results,
  });
}

export async function GET(req: NextRequest) { return handle(req); }
export async function POST(req: NextRequest) { return handle(req); }
