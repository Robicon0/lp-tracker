// Returns historical snapshots for a single position.
// GET /api/history/position?id=aero-50093212&range=30d

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
  const id = url.searchParams.get("id");
  const range = (url.searchParams.get("range") || "30d").toLowerCase();
  if (!id) {
    return NextResponse.json({ ok: false, error: "Missing id" }, { status: 400 });
  }

  const days = RANGE_DAYS[range];

  try {
    const result =
      days === null
        ? await sql`
            SELECT timestamp, value, uncollected_fees, claimed_fees, status
            FROM position_snapshots
            WHERE position_id = ${id}
            ORDER BY timestamp ASC
          `
        : await sql`
            SELECT timestamp, value, uncollected_fees, claimed_fees, status
            FROM position_snapshots
            WHERE position_id = ${id}
              AND timestamp >= NOW() - (${days}::int * INTERVAL '1 day')
            ORDER BY timestamp ASC
          `;

    const snapshots = result.rows.map((r) => ({
      timestamp: new Date(r.timestamp as string).getTime(),
      value: Number(r.value),
      fees: Number(r.uncollected_fees),
      claimedFees: Number(r.claimed_fees),
      status: r.status as string,
    }));

    return NextResponse.json({ ok: true, snapshots });
  } catch (e) {
    console.error("[history/position] query failed:", e);
    return NextResponse.json({ ok: false, snapshots: [], error: String(e) });
  }
}
