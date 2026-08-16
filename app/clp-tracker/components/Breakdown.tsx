"use client";

import { useState, type ReactNode } from "react";

export interface BreakdownRow {
  label: ReactNode;
  value: string;
  // The final "= total" row: gets a top rule and stronger text so the sum
  // reads as the card's headline number.
  isTotal?: boolean;
  valueClass?: string;
}

// A collapse/expand line-item breakdown, collapsed by default so a card that
// carries one stays the same height as its neighbours until the user asks for
// the detail. Shared by every card that shows "how this number was made"
// (Growth Target's Combined Earnings, Total P&L's LP P&L / Net P&L / Overall
// P&L) so they read and behave identically.
export function Breakdown({
  rows,
  noun = "breakdown",
  defaultOpen = false,
}: {
  rows: BreakdownRow[];
  noun?: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--muted)] transition-colors hover:text-[var(--accent)]"
      >
        <span
          aria-hidden
          className={`inline-block transition-transform ${open ? "rotate-90" : ""}`}
        >
          ▸
        </span>
        {open ? `Hide ${noun}` : `Show ${noun}`}
      </button>

      {open && (
        <dl className="mt-1.5 space-y-0.5 text-[11px] tabular-nums text-[var(--muted)]">
          {rows.map((row, i) => (
            <div
              key={i}
              className={`flex items-baseline justify-between gap-3 ${
                row.isTotal
                  ? "border-t border-[var(--border)] pt-0.5 font-medium text-[var(--foreground)]"
                  : ""
              }`}
            >
              <dt>{row.label}</dt>
              <dd className={row.valueClass}>{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
