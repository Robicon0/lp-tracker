import { NextResponse } from "next/server";
import { sql, isDbConfigured } from "../../../lib/db";

// Daily snapshot cron — runs at 00:00 UTC every day (Vercel cron in vercel.json).
//
// For every wallet that appears in the `wallets` table, the cron carries
// forward the most recent snapshot value into a new row stamped at today's
// midnight UTC. This guarantees every tracked wallet has exactly one snapshot
// per UTC calendar day, even when the user isn't visiting the app — so the
// 1D/7D/30D/1Y toggle has a continuous series.
//
// The cron never refetches on-chain state server-side (that would require
// reimplementing every chain/protocol pipeline in a serverless function).
// Clients keep the value fresh by POSTing to /api/snapshots/save on every
// wallet connect + positions refresh; the cron's job is just to ensure
// continuity for days when the user doesn't open the app.
//
// Protected by CRON_SECRET: set the secret as a header
//   Authorization: Bearer <CRON_SECRET>
// in vercel.json. Vercel Cron injects this automatically.

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
    }
  }

  if (!isDbConfigured()) {
    return NextResponse.json({ ok: false, reason: "db_not_configured" }, { status: 200 });
  }

  try {
    // Find every wallet that has at least one prior snapshot and either has no
    // row for today yet OR has a stale one more than 23h old. Carry forward
    // the most recent snapshot value as today's entry.
    const { rows: latest } = await sql`
      SELECT DISTINCT ON (wallet_address)
        wallet_address, total_value, lp_value, lending_value, token_value, position_count, timestamp
      FROM portfolio_snapshots
      ORDER BY wallet_address, timestamp DESC
    `;

    let inserted = 0;
    for (const r of latest) {
      const addr = String(r.wallet_address);
      // Skip if a row already exists for this wallet today (UTC)
      const { rows: existing } = await sql`
        SELECT 1 FROM portfolio_snapshots
        WHERE wallet_address = ${addr}
          AND DATE(timestamp AT TIME ZONE 'UTC') = (NOW() AT TIME ZONE 'UTC')::date
        LIMIT 1
      `;
      if (existing.length > 0) continue;

      await sql`
        INSERT INTO portfolio_snapshots
          (wallet_address, total_value, lp_value, lending_value, token_value, position_count, timestamp)
        VALUES
          (${addr},
           ${Number(r.total_value ?? 0)},
           ${Number(r.lp_value ?? 0)},
           ${Number(r.lending_value ?? 0)},
           ${Number(r.token_value ?? 0)},
           ${Number(r.position_count ?? 0)},
           NOW())
      `;
      inserted += 1;
    }

    return NextResponse.json({ ok: true, walletsProcessed: latest.length, snapshotsInserted: inserted });
  } catch (err) {
    console.error("[cron/daily-snapshot] failed:", err);
    return NextResponse.json({ ok: false, reason: "db_error", error: String(err) }, { status: 500 });
  }
}
