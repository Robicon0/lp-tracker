// Returns historical portfolio snapshots for a wallet.
// GET /api/history/portfolio?wallet=0x...&range=30d
// range: 7d | 30d | 90d | all

import { NextRequest, NextResponse } from "next/server";
import { sql, isDbConfigured } from "../../../lib/db";

export const dynamic = "force-dynamic";

const RANGE_DAYS: Record<string, number | null> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  all: null,
};

export async function GET(req: NextRequest) {
  if (!isDbConfigured()) {
    return NextResponse.json({ ok: false, snapshots: [], error: "DB not configured" });
  }

  const url = new URL(req.url);
  const wallet = url.searchParams.get("wallet");
  const range = (url.searchParams.get("range") || "30d").toLowerCase();
  if (!wallet) {
    return NextResponse.json({ ok: false, error: "Missing wallet" }, { status: 400 });
  }

  const days = RANGE_DAYS[range];

  try {
    const result =
      days === null
        ? await sql`
            SELECT timestamp, total_value, lp_value, lending_value, token_value, total_fees_earned, position_count
            FROM portfolio_snapshots
            WHERE wallet_address = ${wallet}
            ORDER BY timestamp ASC
          `
        : await sql`
            SELECT timestamp, total_value, lp_value, lending_value, token_value, total_fees_earned, position_count
            FROM portfolio_snapshots
            WHERE wallet_address = ${wallet}
              AND timestamp >= NOW() - (${days}::int * INTERVAL '1 day')
            ORDER BY timestamp ASC
          `;

    const snapshots = result.rows.map((r) => ({
      timestamp: new Date(r.timestamp as string).getTime(),
      totalValue: Number(r.total_value),
      lpValue: Number(r.lp_value),
      lendingValue: Number(r.lending_value),
      tokenValue: Number(r.token_value),
      fees: Number(r.total_fees_earned),
      positionCount: Number(r.position_count),
    }));

    return NextResponse.json({ ok: true, snapshots });
  } catch (e) {
    console.error("[history/portfolio] query failed:", e);
    return NextResponse.json({ ok: false, snapshots: [], error: String(e) });
  }
}
