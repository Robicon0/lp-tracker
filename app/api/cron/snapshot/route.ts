// Snapshot cron — runs daily via vercel.json cron config.
// Iterates over all wallets in the `wallets` table and writes a
// portfolio_snapshots row + one position_snapshots row per LP position.
//
// Authentication: requires `Authorization: Bearer ${CRON_SECRET}` header.
// Vercel cron jobs send this automatically when CRON_SECRET is set.
// For browser-triggered "Take Snapshot" use /api/snapshot/manual instead.

import { NextRequest, NextResponse } from "next/server";
import { sql, isDbConfigured } from "../../../lib/db";
import { snapshotWallet, baseUrlFromHeaders, type WalletRow } from "../../../lib/snapshot";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

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

  const base = baseUrlFromHeaders(req.headers);
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
