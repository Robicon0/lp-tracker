"use client";

import { useState, type ReactNode } from "react";
import type { OverallPnL } from "../lib/calculations";

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function formatUsd(value: number): string {
  return usdFormatter.format(Number.isFinite(value) ? value : 0);
}

function pnlColor(value: number): string {
  if (value > 0) return "text-emerald-400";
  if (value < 0) return "text-rose-400";
  return "text-[var(--foreground)]";
}

const cardClass =
  "rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5";
const labelClass =
  "text-[11px] font-medium uppercase tracking-wider text-[var(--muted)]";
const valueClass = "mt-2 text-2xl font-semibold tracking-tight";
const hintClass = "mt-2 text-[11px] text-[var(--muted)]";

// Shared by the Dashboard and the Total P&L page so the two can never drift
// apart (Invariant #6). Editing saves immediately, matching the inline price
// fields on the Business P&L page.
export function InitialCapitalCard({
  value,
  onSave,
}: {
  value: number;
  onSave: (next: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value));

  const commit = () => {
    const parsed = Number(draft);
    onSave(Number.isFinite(parsed) && parsed >= 0 ? parsed : 0);
    setEditing(false);
  };

  return (
    <div className={cardClass}>
      <div className="flex items-center justify-between gap-2">
        <span className={labelClass}>Initial Capital</span>
        {!editing && (
          <button
            type="button"
            onClick={() => {
              setDraft(String(value));
              setEditing(true);
            }}
            aria-label="Edit initial capital"
            className="text-[11px] font-medium text-[var(--muted)] transition-colors hover:text-[var(--accent)]"
          >
            Edit
          </button>
        )}
      </div>

      {editing ? (
        <div className="mt-2 flex items-center gap-2">
          <input
            type="number"
            step="any"
            min="0"
            autoFocus
            aria-label="Initial capital amount"
            className="block w-full rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)] px-3 py-1.5 text-lg tabular-nums text-[var(--foreground)] [color-scheme:dark] focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commit();
              }
              if (e.key === "Escape") setEditing(false);
            }}
            onBlur={commit}
          />
        </div>
      ) : (
        <div className={`${valueClass} text-[var(--foreground)]`}>
          {formatUsd(value)}
        </div>
      )}

      <p className={hintClass}>
        The capital you started this LP business with. Set this once — it does
        not change automatically.
      </p>
    </div>
  );
}

export function OverallPnLCard({
  result,
  breakdown,
  heldFeesValue,
}: {
  result: OverallPnL;
  // Optional live formula breakdown, rendered only where it's passed. The
  // Dashboard omits it (keeps the compact card); the Total P&L page supplies
  // one so the number is auditable there.
  breakdown?: ReactNode;
  // What the excluded still-held tokens are worth today. The hint always said
  // they were excluded; naming the figure says HOW MUCH is excluded, which is
  // the part that actually tells you whether the exclusion matters.
  // MUST be calcUnconvertedHoldings(claims, mergedPrices).totalCurrentValue —
  // the same helper and the same fetched+manual price merge Total P&L's
  // Fees Earned card shows as "still held", so the two can never disagree.
  // Undefined (or zero, when there is nothing held) renders the old sentence.
  heldFeesValue?: number;
}) {
  return (
    <div className={cardClass}>
      <div className={labelClass}>Overall P&amp;L</div>
      <div className={`${valueClass} ${pnlColor(result.overall)}`}>
        {formatUsd(result.overall)}
      </div>
      <p className={hintClass}>
        Current active positions + realized converted profit − Initial Capital.
        Pure LP business performance — personal spending / withdrawals are
        tracked separately as Available Balance on the Transfers page. Excludes
        tokens you&apos;re still holding
        {heldFeesValue !== undefined && heldFeesValue !== 0
          ? ` — ${formatUsd(heldFeesValue)} at today's value`
          : ""}{" "}
        (see Business P&amp;L for that).
      </p>
      {breakdown}
      {result.unvaluedConvertedClaims > 0 && (
        <p className="mt-2 text-[11px] text-amber-300">
          {result.unvaluedConvertedClaims} converted{" "}
          {result.unvaluedConvertedClaims === 1 ? "claim has" : "claims have"} no
          USD value recorded and {result.unvaluedConvertedClaims === 1 ? "is" : "are"}{" "}
          counted as $0 here.
        </p>
      )}
    </div>
  );
}
