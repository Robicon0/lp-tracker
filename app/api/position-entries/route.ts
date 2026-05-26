import { NextResponse } from "next/server";
import { sql, isDbConfigured } from "../../lib/db";

// Manual deposit/withdrawal entries for closed LP positions whose on-chain
// history cannot be reconstructed from public RPCs (HyperEVM closed positions
// older than the 5M-block DRPC window, BSC archive limits, etc.). Users enter
// values ONCE on the analytics page and they persist across sessions.
//
// GET  /api/position-entries?wallet=0x...     → array of saved entries
// POST /api/position-entries
//   body: { wallet, positionId, depositUsd, withdrawalUsd }
//   upserts on (wallet_address, position_id)
//
// Wallet addresses are normalized to lowercase server-side so callers can pass
// any case-mix (EVM checksummed, Solana base58 untouched — base58 is
// case-sensitive but Solana doesn't have this on-chain-archive issue today;
// Sui hex addresses are case-insensitive so lowercase is safe).
//
// The DDL `CREATE TABLE IF NOT EXISTS` runs on every request so deployments
// without manual migration step still get the table on first use — Postgres
// idempotent DDL is cheap.

const ENSURE_TABLE = `
  CREATE TABLE IF NOT EXISTS position_manual_entries (
    id              SERIAL PRIMARY KEY,
    wallet_address  TEXT NOT NULL,
    position_id     TEXT NOT NULL,
    deposit_usd     NUMERIC(24, 6) NOT NULL,
    withdrawal_usd  NUMERIC(24, 6) NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (wallet_address, position_id)
  )
`;

interface EntryRow {
  position_id: string;
  deposit_usd: string | number;
  withdrawal_usd: string | number;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface PositionManualEntry {
  positionId: string;
  depositUsd: number;
  withdrawalUsd: number;
  createdAt: string;
  updatedAt: string;
}

function mapRow(r: EntryRow): PositionManualEntry {
  return {
    positionId: r.position_id,
    depositUsd: Number(r.deposit_usd),
    withdrawalUsd: Number(r.withdrawal_usd),
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

export async function GET(request: Request) {
  if (!isDbConfigured()) {
    return NextResponse.json({ ok: false, reason: "db_not_configured", entries: [] });
  }

  const wallet = (new URL(request.url).searchParams.get("wallet") ?? "").trim().toLowerCase();
  if (!wallet) {
    return NextResponse.json({ ok: false, reason: "wallet_required", entries: [] }, { status: 400 });
  }

  try {
    await sql.query(ENSURE_TABLE);
    const { rows } = await sql.query<EntryRow>(
      `SELECT position_id, deposit_usd, withdrawal_usd, created_at, updated_at
         FROM position_manual_entries
        WHERE wallet_address = $1
        ORDER BY updated_at DESC`,
      [wallet],
    );
    return NextResponse.json({ ok: true, entries: rows.map(mapRow) });
  } catch (err) {
    console.error("[position-entries GET] failed:", err);
    return NextResponse.json(
      { ok: false, reason: "db_error", error: String(err), entries: [] },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  if (!isDbConfigured()) {
    return NextResponse.json({ ok: false, reason: "db_not_configured" }, { status: 200 });
  }

  let body: { wallet?: string; positionId?: string; depositUsd?: number; withdrawalUsd?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, reason: "bad_json" }, { status: 400 });
  }

  const wallet = (body.wallet ?? "").trim().toLowerCase();
  const positionId = (body.positionId ?? "").trim();
  const depositUsd = Number(body.depositUsd);
  const withdrawalUsd = Number(body.withdrawalUsd);

  if (!wallet || !positionId) {
    return NextResponse.json({ ok: false, reason: "bad_input" }, { status: 400 });
  }
  if (!Number.isFinite(depositUsd) || depositUsd < 0) {
    return NextResponse.json({ ok: false, reason: "invalid_deposit" }, { status: 400 });
  }
  if (!Number.isFinite(withdrawalUsd) || withdrawalUsd < 0) {
    return NextResponse.json({ ok: false, reason: "invalid_withdrawal" }, { status: 400 });
  }
  // Same $10M ceiling as the on-chain P&L overflow guard — keeps obvious typos
  // (extra zero, raw-uint paste) from poisoning the LP P&L total. Above $10M,
  // a real user can split into multiple entries or contact support.
  if (depositUsd > 10_000_000 || withdrawalUsd > 10_000_000) {
    return NextResponse.json({ ok: false, reason: "value_overflow" }, { status: 400 });
  }

  try {
    await sql.query(ENSURE_TABLE);
    const { rows } = await sql.query<EntryRow>(
      `INSERT INTO position_manual_entries
         (wallet_address, position_id, deposit_usd, withdrawal_usd)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (wallet_address, position_id) DO UPDATE
         SET deposit_usd = EXCLUDED.deposit_usd,
             withdrawal_usd = EXCLUDED.withdrawal_usd,
             updated_at = NOW()
       RETURNING position_id, deposit_usd, withdrawal_usd, created_at, updated_at`,
      [wallet, positionId, depositUsd, withdrawalUsd],
    );
    return NextResponse.json({ ok: true, entry: mapRow(rows[0]) });
  } catch (err) {
    console.error("[position-entries POST] failed:", err);
    return NextResponse.json(
      { ok: false, reason: "db_error", error: String(err) },
      { status: 500 },
    );
  }
}
