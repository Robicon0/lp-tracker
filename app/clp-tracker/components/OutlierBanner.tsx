"use client";

import type { OutlierRow } from "../lib/dataHealth";

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function usd(value: number): string {
  return usdFormatter.format(Number.isFinite(value) ? value : 0);
}

function shortDate(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value || "—";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
}

// Shared "unusual amount" banner for claims and transfers. Flags a record whose
// USD amount is an order of magnitude outside its position's usual range — the
// classic extra/missing-zero signature — and links to review it. Never
// auto-corrects: a genuinely large record can be real, so this only prompts a
// second look via Edit.
export function OutlierBanner({
  id,
  rows,
  noun,
  onEdit,
  onConfirm,
}: {
  id?: string;
  rows: OutlierRow[];
  noun: "claim" | "transfer";
  onEdit: (row: OutlierRow) => void;
  // Persisted "I checked this, it's correct" dismissal (Part 1).
  onConfirm: (row: OutlierRow) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <div
      id={id}
      className="rounded-lg border border-amber-500/40 bg-amber-500/[0.06] px-5 py-4"
    >
      <h2 className="text-sm font-semibold text-amber-300">
        {rows.length} unusually large or small{" "}
        {rows.length === 1 ? noun : `${noun}s`} to double-check
      </h2>
      <p className="mt-1 text-[11px] leading-relaxed text-[var(--muted)]">
        These {noun} amounts are 10× beyond every other {noun} on the same
        position — often an extra or missing zero. This is only a prompt to
        check; a genuinely large {noun} can be correct. Nothing is changed.
      </p>
      <ul className="mt-3 space-y-2">
        {rows.map((r) => (
          <li
            key={`${r.kind}-${r.id}`}
            className="flex flex-wrap items-center justify-between gap-2 rounded border border-[var(--border-strong)] bg-[var(--surface-2)]/40 px-3 py-2 text-[12px]"
          >
            <span className="font-medium text-[var(--foreground)]">
              {shortDate(r.date)} · {r.label}
            </span>
            <span className="tabular-nums text-[var(--muted)]">
              <span
                className={`font-medium ${
                  r.direction === "high" ? "text-amber-300" : "text-sky-300"
                }`}
              >
                {usd(r.amount)}
              </span>{" "}
              vs usual {usd(r.typicalMin)}–{usd(r.typicalMax)} ({r.siblingCount}{" "}
              others)
            </span>
            <span className="inline-flex gap-2">
              <button
                type="button"
                onClick={() => onConfirm(r)}
                className="rounded-md border border-emerald-500/40 px-2.5 py-1 text-[11px] font-medium text-emerald-300 transition-colors hover:bg-emerald-500/10"
                title="Hide this flag — the amount is correct"
              >
                Mark confirmed
              </button>
              <button
                type="button"
                onClick={() => onEdit(r)}
                className="rounded-md border border-amber-500/40 px-2.5 py-1 text-[11px] font-medium text-amber-300 transition-colors hover:bg-amber-500/10"
              >
                Review
              </button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
