import { NextResponse } from "next/server";
import { sql, isDbConfigured } from "../../../lib/db";

// GET /api/snapshots/range?address=0x...,0x...&days=30
//
// Returns every stored snapshot for the given wallet(s) within the last N
// UTC days. Addresses may be a single address or a comma-separated list
// (so watched-wallet users get aggregated history). Snapshot values are
// summed per timestamp bucket when multiple addresses are provided.
//
// Response:
//   {
//     ok: true,
//     snapshots: [{ timestamp: ISOString, totalValue, lpValue, lendingValue, tokenValue, positionCount }],
//     trackingSince: ISOString | null,   // earliest snapshot anywhere for these addresses
//     daysTracked: number
//   }

export async function GET(request: Request) {
  if (!isDbConfigured()) {
    return NextResponse.json({ ok: false, reason: "db_not_configured", snapshots: [], trackingSince: null, daysTracked: 0 });
  }

  const { searchParams } = new URL(request.url);
  const addrsParam = (searchParams.get("address") ?? "").trim();
  const days = Math.max(1, Math.min(3650, Number(searchParams.get("days") ?? 30)));
  if (!addrsParam) {
    return NextResponse.json({ ok: false, reason: "address_required" }, { status: 400 });
  }
  const addrs = addrsParam.split(",").map((s) => s.trim()).filter(Boolean);
  if (addrs.length === 0) {
    return NextResponse.json({ ok: false, reason: "address_required" }, { status: 400 });
  }

  try {
    const sinceDays = days;
    // @vercel/postgres's tagged template only accepts Primitive params, so we
    // expand the address list into a $1,$2,… IN clause via sql.query.
    const placeholders = addrs.map((_, i) => `$${i + 1}`).join(",");
    const { rows } = await sql.query(
      `
        SELECT
          timestamp,
          SUM(total_value)   AS total_value,
          SUM(lp_value)      AS lp_value,
          SUM(lending_value) AS lending_value,
          SUM(token_value)   AS token_value,
          SUM(position_count)::int AS position_count
        FROM portfolio_snapshots
        WHERE wallet_address IN (${placeholders})
          AND timestamp >= NOW() - ($${addrs.length + 1}::text || ' days')::interval
        GROUP BY timestamp
        ORDER BY timestamp ASC
      `,
      [...addrs, String(sinceDays)],
    );

    const snapshots = rows.map((r) => ({
      timestamp: new Date(r.timestamp as string).toISOString(),
      totalValue:    Number(r.total_value ?? 0),
      lpValue:       Number(r.lp_value ?? 0),
      lendingValue:  Number(r.lending_value ?? 0),
      tokenValue:    Number(r.token_value ?? 0),
      positionCount: Number(r.position_count ?? 0),
    }));

    // Earliest snapshot ever for these wallets — drives "tracking started" UX
    const { rows: firstRows } = await sql.query(
      `SELECT MIN(timestamp) AS first_seen FROM portfolio_snapshots WHERE wallet_address IN (${placeholders})`,
      addrs,
    );
    const firstSeen = firstRows[0]?.first_seen ? new Date(firstRows[0].first_seen as string) : null;
    const daysTracked = firstSeen
      ? Math.max(1, Math.floor((Date.now() - firstSeen.getTime()) / 86_400_000) + 1)
      : 0;

    return NextResponse.json({
      ok: true,
      snapshots,
      trackingSince: firstSeen ? firstSeen.toISOString() : null,
      daysTracked,
    });
  } catch (err) {
    console.error("[snapshots/range] query failed:", err);
    return NextResponse.json({ ok: false, reason: "db_error", error: String(err), snapshots: [], trackingSince: null, daysTracked: 0 }, { status: 500 });
  }
}
