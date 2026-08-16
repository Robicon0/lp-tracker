import type { ReactNode } from "react";

// Out-of-Range Upside/Downside and Net Coverage answer "what would this be
// worth IF price hit the exact edge of the range?" On an OPEN position that
// is a live decision aid. On a CLOSED one the real outcome is already known
// and recorded as Scalp / Final Withdrawn / Profit, and the projection almost
// never matches it, because a close rarely lands exactly on a range boundary.
//
// The numbers are still worth keeping — they are the honest answer to a
// different question — so nothing here changes any maths. This only makes
// clear which question is being answered, and keeps the real result visually
// primary. Shared so the Edit modal and Pool P&L cannot drift apart.
export const HYPOTHETICAL_DIM = "opacity-60";

export const HYPOTHETICAL_LABEL = "Hypothetical — not what actually happened";

export function HypotheticalNotice({
  className = "",
}: {
  className?: string;
}): ReactNode {
  return (
    <p
      className={`rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)]/40 px-3 py-2 text-[11px] text-[var(--muted)] ${className}`}
      role="note"
    >
      <span className="font-medium text-[var(--foreground)]">
        {HYPOTHETICAL_LABEL}.
      </span>{" "}
      This position is closed, so its real result is its recorded Scalp and
      Profit. The figures below are what it would have been worth at the exact
      edges of its range.
    </p>
  );
}

// Compact variant for table headers and inline detail rows, where the full
// sentence does not fit.
export function HypotheticalTag({
  className = "",
}: {
  className?: string;
}): ReactNode {
  return (
    <span
      className={`inline-flex items-center rounded-full border border-[var(--border-strong)] bg-[var(--surface-2)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-[var(--muted)] ${className}`}
      title={HYPOTHETICAL_LABEL}
    >
      Hypothetical
    </span>
  );
}
