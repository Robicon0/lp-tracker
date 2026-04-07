// Manual snapshot — triggered from the analytics page "Take Snapshot" button.
// No CRON_SECRET required (browser-initiated, can't carry server secrets).
// Snapshots a single wallet at a time, taken from the request body.
//
// The cron route at /api/cron/snapshot remains unchanged and still requires
// CRON_SECRET for the automated daily run.

import { NextRequest, NextResponse } from "next/server";
import { isDbConfigured } from "../../../lib/db";
import { snapshotWallet, baseUrlFromHeaders } from "../../../lib/snapshot";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  if (!isDbConfigured()) {
    return NextResponse.json(
      { ok: false, error: "Database not configured. Set POSTGRES_URL in env." },
      { status: 503 },
    );
  }

  let body: { address?: string; chain?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const address = (body.address || "").trim();
  const chain = (body.chain || "evm").trim();
  if (!address) {
    return NextResponse.json({ ok: false, error: "Missing address" }, { status: 400 });
  }
  if (!["evm", "solana", "sui"].includes(chain)) {
    return NextResponse.json({ ok: false, error: "Unsupported chain" }, { status: 400 });
  }

  const base = baseUrlFromHeaders(req.headers);
  try {
    const result = await snapshotWallet(base, { address, chain });
    return NextResponse.json({
      ok: true,
      snapshotted: result.ok ? 1 : 0,
      total: 1,
      wallet: address,
      positionCount: result.positionCount,
      totalValue: result.totalValue,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    console.error(`[snapshot/manual] ${address} failed:`, e);
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
