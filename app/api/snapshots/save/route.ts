import { NextResponse } from "next/server";
import { sql, isDbConfigured } from "../../../lib/db";

// Persist a single portfolio snapshot. Idempotent per UTC calendar day:
// if a row already exists for (wallet_address, today UTC), it is replaced
// with the latest value — so a user opening the app several times in one
// day never inflates the snapshot count, but the most recent value wins.
//
// Body: { walletAddress: string, totalLpValue: number,
//         lendingValue?: number, tokenValue?: number, positionCount?: number }
//
// Safe to call on every wallet connect + every positions refresh; the server
// owns "one snapshot per UTC day" semantics.

export async function POST(request: Request) {
  if (!isDbConfigured()) {
    return NextResponse.json({ ok: false, reason: "db_not_configured" }, { status: 200 });
  }

  let body: {
    walletAddress?: string;
    totalLpValue?: number;
    lendingValue?: number;
    tokenValue?: number;
    positionCount?: number;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, reason: "bad_json" }, { status: 400 });
  }

  const addr = (body.walletAddress ?? "").trim();
  const lpValue = Number(body.totalLpValue ?? 0);
  const lending = Number(body.lendingValue ?? 0);
  const tokens = Number(body.tokenValue ?? 0);
  const positionCount = Number.isFinite(Number(body.positionCount)) ? Number(body.positionCount) : 0;
  if (!addr || !Number.isFinite(lpValue)) {
    return NextResponse.json({ ok: false, reason: "bad_input" }, { status: 400 });
  }

  try {
    await sql`
      INSERT INTO wallets (address, chain)
      VALUES (${addr}, 'evm')
      ON CONFLICT (address) DO UPDATE SET last_seen = NOW()
    `;

    // Upsert per UTC day — delete today's row if any, then insert fresh.
    await sql`
      DELETE FROM portfolio_snapshots
      WHERE wallet_address = ${addr}
        AND DATE(timestamp AT TIME ZONE 'UTC') = (NOW() AT TIME ZONE 'UTC')::date
    `;
    const totalValue = lpValue + lending + tokens;
    await sql`
      INSERT INTO portfolio_snapshots
        (wallet_address, total_value, lp_value, lending_value, token_value, position_count, timestamp)
      VALUES
        (${addr}, ${totalValue}, ${lpValue}, ${lending}, ${tokens}, ${positionCount}, NOW())
    `;

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[snapshots/save] insert failed:", err);
    return NextResponse.json({ ok: false, reason: "db_error", error: String(err) }, { status: 500 });
  }
}
