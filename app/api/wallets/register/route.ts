// Register a wallet for snapshot tracking. Called from the frontend
// whenever a user connects an EVM/Solana/Sui wallet so the cron knows
// which addresses to snapshot.

import { NextRequest, NextResponse } from "next/server";
import { sql, isDbConfigured } from "../../../lib/db";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!isDbConfigured()) {
    return NextResponse.json({ ok: false, error: "DB not configured" }, { status: 503 });
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

  await sql`
    INSERT INTO wallets (address, chain)
    VALUES (${address}, ${chain})
    ON CONFLICT (address) DO UPDATE SET last_seen = NOW()
  `;

  return NextResponse.json({ ok: true });
}
