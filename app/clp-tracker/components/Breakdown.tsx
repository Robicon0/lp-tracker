"use client";

import { Fragment, useState, type ReactNode } from "react";

export interface BreakdownRow {
  label: ReactNode;
  value: string;
  // The final "= total" row: gets a top rule and stronger text so the sum
  // reads as the card's headline number.
  isTotal?: boolean;
  valueClass?: string;
  // Optional full-width detail rendered directly BENEATH this row while the
  // breakdown is open. Used to nest a drill-down list under the single line it
  // explains (Total P&L's closed-position Scalp list) without competing with
  // this component's own toggle.
  after?: ReactNode;
}

// The one disclosure control every "how this number was made" card uses.
// Extracted from Breakdown below so a card that has to own its own open state
// (OverallPnLCard, which reveals prose AND rows together) reuses this exact
// button rather than growing a second, slightly-different one.
export function DisclosureToggle({
  open,
  onToggle,
  noun = "breakdown",
}: {
  open: boolean;
  onToggle: () => void;
  noun?: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--muted)] transition-colors hover:text-[var(--accent)]"
    >
      <span
        aria-hidden
        className={`inline-block transition-transform ${open ? "rotate-90" : ""}`}
      >
        &#9656;
      </span>
      {open ? `Hide ${noun}` : `Show ${noun}`}
    </button>
  );
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
  collapsible = true,
}: {
  rows: BreakdownRow[];
  noun?: string;
  defaultOpen?: boolean;
  // false when an enclosing card already owns the toggle that reveals this —
  // the rows then render bare, so a card never shows two nested "Show
  // breakdown" controls one inside the other.
  collapsible?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const shown = collapsible ? open : true;

  return (
    <div className="mt-2">
      {collapsible && (
        <DisclosureToggle
          open={open}
          onToggle={() => setOpen((o) => !o)}
          noun={noun}
        />
      )}

      {shown && (
        <dl className="mt-1.5 space-y-0.5 text-[11px] tabular-nums text-[var(--muted)]">
          {rows.map((row, i) => (
            <Fragment key={i}>
              <div
                className={`flex items-baseline justify-between gap-3 ${
                  row.isTotal
                    ? "border-t border-[var(--border)] pt-0.5 font-medium text-[var(--foreground)]"
                    : ""
                }`}
              >
                <dt>{row.label}</dt>
                <dd className={row.valueClass}>{row.value}</dd>
              </div>
              {row.after}
            </Fragment>
          ))}
        </dl>
      )}
    </div>
  );
}
