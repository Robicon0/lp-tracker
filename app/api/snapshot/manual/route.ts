// Manual snapshot — triggered from the analytics page "Take Snapshot" button.
// No CRON_SECRET required (browser-initiated, can't carry server secrets).
// Accepts either a single wallet or an array of wallets across EVM/Solana/Sui
// and snapshots each in parallel. Per-wallet positions are written to
// portfolio_snapshots/position_snapshots via the shared snapshotWallet helper.
//
// The cron route at /api/cron/snapshot remains unchanged and still requires
// CRON_SECRET for the automated daily run.

import { NextRequest, NextResponse } from "next/server";
import { isDbConfigured } from "../../../lib/db";
import { snapshotWallet, baseUrlFromHeaders, type WalletRow } from "../../../lib/snapshot";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Body = {
  address?: string;
  chain?: string;
  wallets?: Array<{ address?: string; chain?: string }>;
};

export async function POST(req: NextRequest) {
  if (!isDbConfigured()) {
    return NextResponse.json(
      { ok: false, error: "Database not configured. Set POSTGRES_URL in env." },
      { status: 503 },
    );
  }

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  // Normalize to an array of WalletRow — accept both legacy {address,chain}
  // and new {wallets:[...]} shape so older callers keep working.
  const raw: Array<{ address?: string; chain?: string }> =
    Array.isArray(body.wallets) && body.wallets.length > 0
      ? body.wallets
      : body.address
      ? [{ address: body.address, chain: body.chain }]
      : [];

  const wallets: WalletRow[] = [];
  for (const w of raw) {
    const address = (w.address || "").trim();
    const chain = (w.chain || "evm").trim();
    if (!address) continue;
    if (!["evm", "solana", "sui"].includes(chain)) continue;
    wallets.push({ address, chain });
  }

  if (wallets.length === 0) {
    return NextResponse.json(
      { ok: false, error: "No valid wallets in request" },
      { status: 400 },
    );
  }

  const base = baseUrlFromHeaders(req.headers);
  const results = await Promise.all(
    wallets.map(async (w) => {
      try {
        const r = await snapshotWallet(base, w);
        return { wallet: w.address, chain: w.chain, ok: r.ok, positionCount: r.positionCount, totalValue: r.totalValue };
      } catch (e) {
        console.error(`[snapshot/manual] ${w.chain} ${w.address} failed:`, e);
        return { wallet: w.address, chain: w.chain, ok: false, positionCount: 0, totalValue: 0, error: String(e) };
      }
    }),
  );

  const snapshotted = results.filter((r) => r.ok).length;
  const totalValue = results.reduce((s, r) => s + (r.totalValue || 0), 0);
  const positionCount = results.reduce((s, r) => s + (r.positionCount || 0), 0);

  return NextResponse.json({
    ok: snapshotted > 0,
    snapshotted,
    total: wallets.length,
    positionCount,
    totalValue,
    results,
    timestamp: new Date().toISOString(),
  });
}
