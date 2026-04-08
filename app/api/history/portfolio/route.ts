// Returns historical portfolio snapshots, optionally aggregated across
// multiple wallets (EVM + Solana + Sui). Pass `wallets=a,b,c` to sum
// across all three chains, or `wallet=a` for a single wallet (legacy).
//
// Rows whose timestamps fall within a 5-second window are treated as
// belonging to the same snapshot batch and summed together so the chart
// shows the user's true cross-chain portfolio total per batch.
//
// GET /api/history/portfolio?wallets=0x...,GndR...,0xdce...&range=30d
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

const BATCH_WINDOW_MS = 5_000;

type Row = {
  timestamp: string;
  total_value: string | number;
  lp_value: string | number;
  lending_value: string | number;
  token_value: string | number;
  total_fees_earned: string | number;
  position_count: string | number;
};

export async function GET(req: NextRequest) {
  if (!isDbConfigured()) {
    return NextResponse.json({ ok: false, snapshots: [], error: "DB not configured" });
  }

  const url = new URL(req.url);
  const walletsParam = url.searchParams.get("wallets");
  const wallet = url.searchParams.get("wallet");
  const range = (url.searchParams.get("range") || "30d").toLowerCase();

  // Optional wallet filter — when omitted, return ALL wallets in DB summed
  // per 5s batch window. This is what the analytics page wants because the
  // user may have multiple EVM accounts (e.g. main + HyperEVM) that were
  // connected during different snapshot runs. wagmi only exposes the
  // currently-connected one, so filtering to it would hide history from
  // other wallets the user has previously snapshotted.
  const walletFilter = walletsParam
    ? walletsParam.split(",").map((w) => w.trim()).filter(Boolean)
    : wallet
    ? [wallet]
    : null;

  const days = RANGE_DAYS[range];

  try {
    let result;
    if (walletFilter) {
      // Per-wallet path — fetch each in parallel and merge.
      const perWallet = await Promise.all(
        walletFilter.map((w) =>
          days === null
            ? sql`
                SELECT timestamp, total_value, lp_value, lending_value, token_value, total_fees_earned, position_count
                FROM portfolio_snapshots
                WHERE wallet_address = ${w}
                ORDER BY timestamp ASC
              `
            : sql`
                SELECT timestamp, total_value, lp_value, lending_value, token_value, total_fees_earned, position_count
                FROM portfolio_snapshots
                WHERE wallet_address = ${w}
                  AND timestamp >= NOW() - (${days}::int * INTERVAL '1 day')
                ORDER BY timestamp ASC
              `,
        ),
      );
      result = perWallet.flatMap((r) => r.rows);
    } else {
      // Global path — sum every wallet's rows in the range.
      const r =
        days === null
          ? await sql`
              SELECT timestamp, total_value, lp_value, lending_value, token_value, total_fees_earned, position_count
              FROM portfolio_snapshots
              ORDER BY timestamp ASC
            `
          : await sql`
              SELECT timestamp, total_value, lp_value, lending_value, token_value, total_fees_earned, position_count
              FROM portfolio_snapshots
              WHERE timestamp >= NOW() - (${days}::int * INTERVAL '1 day')
              ORDER BY timestamp ASC
            `;
      result = r.rows;
    }
    const allRows = (result as Row[]).sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );

    // Group rows whose timestamps are within BATCH_WINDOW_MS of each other.
    // Each batch represents one "Take Snapshot" event across all wallets and
    // its summed lp_value is the user's true cross-chain portfolio total.
    type Batch = {
      timestamp: number;
      totalValue: number;
      lpValue: number;
      lendingValue: number;
      tokenValue: number;
      fees: number;
      positionCount: number;
    };
    const batches: Batch[] = [];
    let current: Batch | null = null;
    for (const r of allRows) {
      const ts = new Date(r.timestamp).getTime();
      if (!current || ts - current.timestamp > BATCH_WINDOW_MS) {
        current = {
          timestamp: ts,
          totalValue: 0,
          lpValue: 0,
          lendingValue: 0,
          tokenValue: 0,
          fees: 0,
          positionCount: 0,
        };
        batches.push(current);
      }
      current.totalValue += Number(r.total_value);
      current.lpValue += Number(r.lp_value);
      current.lendingValue += Number(r.lending_value);
      current.tokenValue += Number(r.token_value);
      current.fees += Number(r.total_fees_earned);
      current.positionCount += Number(r.position_count);
    }

    return NextResponse.json({ ok: true, snapshots: batches });
  } catch (e) {
    console.error("[history/portfolio] query failed:", e);
    return NextResponse.json({ ok: false, snapshots: [], error: String(e) });
  }
}
