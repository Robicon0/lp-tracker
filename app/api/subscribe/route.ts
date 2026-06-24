import { NextResponse } from "next/server";
import { sql, isDbConfigured } from "../../lib/db";

// Homepage email capture (Sprint EMAIL). A visitor subscribes to ship
// notifications — that's it. This is a simple email-only list, NOT user
// accounts: no login, no password, no wallet coupling. Announcements go out via
// a manual SQL export when a queued feature ships.
//
// POST /api/subscribe
//   body: { email }
//   → 200 { ok: true }                  on success OR duplicate (no existence leak)
//   → 400 { ok: false, error: "invalid_email" }
//   → 429 { ok: false, error: "rate_limited" }
//   → 500 { ok: false, error: "server_error" }
//
// The DDL `CREATE TABLE IF NOT EXISTS` runs on every request so deployments
// without a manual migration step still get the table on first use — Postgres
// idempotent DDL is cheap (same pattern as position-entries/route.ts).
//
// Emails are normalized to lowercase server-side so the UNIQUE constraint is
// effectively case-insensitive. ip_address is captured from x-forwarded-for for
// spam-protection only.

const ENSURE_TABLE = `
  CREATE TABLE IF NOT EXISTS subscribers (
    id          SERIAL PRIMARY KEY,
    email       TEXT NOT NULL UNIQUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ip_address  TEXT
  )
`;

const ENSURE_INDEX = `
  CREATE INDEX IF NOT EXISTS subscribers_email_idx ON subscribers (email)
`;

// RFC-compatible basic shape check (per spec). Server is authoritative.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Best-effort in-memory rate limit: 5 submissions per IP per rolling hour.
// Module-level state — per-instance and resets on cold start, which is fine for
// "discourage spam" (no reusable limiter exists in the codebase). NOT a security
// boundary; the UNIQUE constraint is the real dedup guard.
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const rateLog = new Map<string, number[]>();

function isRateLimited(ip: string | null): boolean {
  if (!ip) return false; // can't key without an IP — don't block
  const now = Date.now();
  const recent = (rateLog.get(ip) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX) {
    rateLog.set(ip, recent);
    return true;
  }
  recent.push(now);
  rateLog.set(ip, recent);
  return false;
}

function clientIp(request: Request): string | null {
  const xff = request.headers.get("x-forwarded-for");
  if (!xff) return null;
  const first = xff.split(",")[0]?.trim();
  return first || null;
}

export async function POST(request: Request) {
  if (!isDbConfigured()) {
    // No DB provisioned (e.g. local dev without POSTGRES_URL) — surface a server
    // error rather than silently dropping the subscription.
    return NextResponse.json({ ok: false, error: "server_error" }, { status: 500 });
  }

  let body: { email?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_email" }, { status: 400 });
  }

  const email = (body.email ?? "").trim().toLowerCase();
  if (!email || !EMAIL_RE.test(email)) {
    return NextResponse.json({ ok: false, error: "invalid_email" }, { status: 400 });
  }

  const ip = clientIp(request);
  if (isRateLimited(ip)) {
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }

  try {
    await sql.query(ENSURE_TABLE);
    await sql.query(ENSURE_INDEX);
    // ON CONFLICT DO NOTHING: succeed identically whether the email is new or a
    // duplicate — never leak whether it already exists (privacy).
    await sql.query(
      `INSERT INTO subscribers (email, ip_address)
       VALUES ($1, $2)
       ON CONFLICT (email) DO NOTHING`,
      [email, ip],
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[subscribe POST] failed:", err);
    return NextResponse.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
