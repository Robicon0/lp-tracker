import { isExpensedTransfer } from "./transferState";
import type { Transfer } from "./types";

// One-time reclassification of transfers that were marked EXPENSE while also
// naming a Platform (From).
//
// Before moneyStatus "platform" existed, the only way to take parked money out
// of Available Balance without naming it a deployment was to call it an
// Expense. Those rows DO name where the money sits (ALPHAFI, JUPITER, AAVE …),
// so the money was never spent — it was parked. Because Expense outranks the
// platform in transferState's precedence chain, they count under Expenses
// (USD) instead of Transferred to Platforms (USD).
//
// Available Balance is UNCHANGED by this: both states are subtracted from it.
// Only the card a row is counted under moves — plus, as a direct consequence,
// Business P&L's per-checkpoint "taken out" figure, which reads expenses.
//
// Everything here is PURE. Preview and Apply share one planner, so what the
// preview lists is exactly what gets written.

export interface PlatformReclassPlan {
  transfers: Transfer[];
  total: number;
  byPlatform: { platform: string; count: number; total: number }[];
}

// A row qualifies only if it is an Expense AND names a platform AND is not a
// standalone business expense. A standalone expense (transferType "expense",
// created from the Expenses form, no position) is spending by definition —
// if one ever carries a platform it is still an expense, and moving it would
// hide real spending.
export function isPlatformReclassCandidate(t: Transfer): boolean {
  return (
    t.deletedAt === undefined &&
    isExpensedTransfer(t) &&
    t.transferType !== "expense" &&
    (t.platform ?? "").trim() !== ""
  );
}

export function planPlatformReclass(transfers: Transfer[]): PlatformReclassPlan {
  const matches = transfers
    .filter(isPlatformReclassCandidate)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const groups = new Map<string, { count: number; total: number }>();
  for (const t of matches) {
    const key = (t.platform ?? "").trim().toUpperCase();
    const g = groups.get(key) ?? { count: 0, total: 0 };
    g.count += 1;
    g.total += Number(t.amount) || 0;
    groups.set(key, g);
  }
  return {
    transfers: matches,
    total: matches.reduce((sum, t) => sum + (Number(t.amount) || 0), 0),
    byPlatform: [...groups.entries()]
      .map(([platform, g]) => ({ platform, ...g }))
      .sort((a, b) => b.total - a.total),
  };
}

// Returns the NEW transfers array. Only moneyStatus changes, and only on the
// planned ids; the platform name, amount and every other field stay as they
// were. Idempotent: a reclassified row is no longer an Expense, so a second
// plan finds nothing.
export function applyPlatformReclass(
  transfers: Transfer[],
  plan: PlatformReclassPlan,
): Transfer[] {
  const ids = new Set(plan.transfers.map((t) => t.id));
  return transfers.map((t) =>
    ids.has(t.id) ? { ...t, moneyStatus: "platform" as const } : t,
  );
}
