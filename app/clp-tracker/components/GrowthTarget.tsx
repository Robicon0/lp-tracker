"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { calcBusinessPnL, calcGrowthTarget } from "../lib/calculations";
import { Breakdown } from "./Breakdown";
import type { FeeClaim, Position } from "../lib/types";

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function formatUsd(value: number): string {
  return usdFormatter.format(Number.isFinite(value) ? value : 0);
}

function formatPercent(value: number): string {
  return `${Number.isFinite(value) ? value.toFixed(2) : "0.00"}%`;
}

// "25 Feb 2026, 10:00" — plain and unambiguous in any locale, unlike
// 02/25/2026, and with the time so the exact start instant is visible for
// hand-checking the months-elapsed figure.
function formatPlainDateTime(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const labelClass =
  "text-[11px] font-medium uppercase tracking-wider text-[var(--muted)]";
const valueClass = "mt-2 text-2xl font-semibold tracking-tight";
const hintClass = "mt-2 text-[11px] text-[var(--muted)]";
const tileClass =
  "rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-4";

interface GrowthTargetSectionProps {
  positions: Position[];
  claims: FeeClaim[];
  // Merged token prices (fetched, with Business P&L manual overrides on top),
  // supplied by the page. This component used to fetch its own, which meant
  // every page showing it issued a SECOND identical /api/prices call — once
  // here and once for the page's own held-fees figure. Taking prices as a prop
  // keeps one fetch per page and guarantees both figures are priced from the
  // same numbers.
  prices: Record<string, number>;
  initialCapital: number;
  targetMonthlyPercent: number;
  onSaveTarget: (next: number) => void;
}

// Shared by the Dashboard and the Total P&L page so the two can never drift
// apart (Invariant #6), the same way CapitalCards is.
export function GrowthTargetSection({
  positions,
  claims,
  prices,
  initialCapital,
  targetMonthlyPercent,
  onSaveTarget,
}: GrowthTargetSectionProps) {
  // The fee half of Combined Earnings is Business P&L's "All Total", read from
  // that exact calculation rather than re-summed here.
  const business = useMemo(
    () => calcBusinessPnL(claims, prices),
    [claims, prices],
  );

  const growth = useMemo(
    () =>
      calcGrowthTarget(
        positions,
        business.allTotal,
        initialCapital,
        targetMonthlyPercent,
      ),
    [positions, business.allTotal, initialCapital, targetMonthlyPercent],
  );

  const ahead = growth.difference >= 0;

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold tracking-tight">Growth Target</h2>
        {growth.startDate && (
          <span className="text-xs text-[var(--muted)]">
            Since {formatPlainDateTime(growth.startDate)} (
            {growth.monthsElapsed.toFixed(2)} months ago)
          </span>
        )}
      </div>

      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <TargetInputTile
            value={targetMonthlyPercent}
            onSave={onSaveTarget}
          />

          <div className={tileClass}>
            <div className={labelClass}>Avg Monthly Rate Achieved</div>
            <div
              className={`${valueClass} ${
                growth.missing.initialCapital || growth.missing.startDate
                  ? "text-[var(--muted)]"
                  : ahead
                    ? "text-emerald-400"
                    : "text-amber-300"
              }`}
            >
              {growth.missing.initialCapital || growth.missing.startDate
                ? "—"
                : formatPercent(growth.averageMonthlyRate)}
            </div>
            <p className={hintClass}>
              Running average since your first position, against a target of{" "}
              {growth.missing.target
                ? "—"
                : formatPercent(growth.targetMonthlyPercent)}
              .
            </p>
          </div>

          <div className={tileClass}>
            <div className={labelClass}>Cumulative Target So Far</div>
            <div className={`${valueClass} text-[var(--foreground)]`}>
              {growth.missing.initialCapital ||
              growth.missing.target ||
              growth.missing.startDate
                ? "—"
                : formatUsd(growth.cumulativeTarget)}
            </div>
            {/* The formula with the user's own numbers substituted in, so the
                card never has to be explained. Recomputes with every input. */}
            {growth.missing.initialCapital ||
            growth.missing.target ||
            growth.missing.startDate ? (
              <p className={hintClass}>
                Initial Capital × target % × months since your first position.
              </p>
            ) : (
              <p className={`${hintClass} tabular-nums`}>
                {formatUsd(growth.initialCapital)} (Initial Capital) ×{" "}
                {formatPercent(growth.targetMonthlyPercent)} ×{" "}
                {growth.monthsElapsed.toFixed(6)} months ={" "}
                {formatUsd(growth.cumulativeTarget)}
              </p>
            )}
          </div>

          <div className={tileClass}>
            <div className={labelClass}>Combined Earnings So Far</div>
            <div
              className={`${valueClass} ${
                growth.combinedEarnings >= 0
                  ? "text-emerald-400"
                  : "text-rose-400"
              }`}
            >
              {formatUsd(growth.combinedEarnings)}
            </div>
            {/* The two halves the total is made of, so the number is auditable
                rather than a lump sum (North Star) — collapsed by default so
                this card stays the same height as the other three. The fees
                half is Business P&L's All Total verbatim (growth.feeEarnings is
                that exact value, passed into calcGrowthTarget). */}
            <Breakdown
              rows={[
                {
                  label: "LP price gain/loss (all positions)",
                  value: formatUsd(growth.positionEarnings),
                },
                {
                  label: "+ Fees earned, all-time (= Business P&L All Total)",
                  value: formatUsd(growth.feeEarnings),
                },
                {
                  label: "=",
                  value: formatUsd(growth.combinedEarnings),
                  isTotal: true,
                },
              ]}
            />
            <p className={hintClass}>
              Includes every position ever opened and every fee earned, valued
              today — a different, broader number than Overall P&amp;L.
            </p>
          </div>
        </div>

        {/* Prompts, not broken math: an unset capital or target would make the
            percentage a division by zero (Invariant #8). */}
        {growth.missing.startDate ? (
          <p className="mt-4 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3 text-xs text-[var(--muted)]">
            Add your first position to start tracking against a target — the
            start date is taken from your earliest position&apos;s entry date.
          </p>
        ) : growth.missing.initialCapital ? (
          <p className="mt-4 rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-200">
            Set your <strong>Initial Capital</strong> above to see how you are
            tracking — the target is a percentage of it.
          </p>
        ) : growth.missing.target ? (
          <p className="mt-4 rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-200">
            Set a <strong>Target Monthly %</strong> above to compare your real
            performance against a goal.
          </p>
        ) : (
          <p
            className={`mt-4 rounded-md px-4 py-3 text-sm font-medium ${
              ahead
                ? "border border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                : "border border-amber-500/30 bg-amber-500/10 text-amber-300"
            }`}
          >
            {formatUsd(Math.abs(growth.difference))}{" "}
            {ahead ? "ahead of your target" : "behind your target"}
          </p>
        )}

        <p className="mt-3 text-[11px] text-[var(--muted)]">
          Fee value uses current token prices, the same ones the{" "}
          <Link
            href="/clp-tracker/business-pnl"
            className="text-[var(--accent)] hover:underline"
          >
            Business P&amp;L
          </Link>{" "}
          page shows.
          {business.unpricedTokens.length > 0 && (
            <>
              {" "}
              <span className="text-amber-300">
                {business.unpricedTokens.join(", ")}{" "}
                {business.unpricedTokens.length === 1 ? "has" : "have"} no price
                yet and {business.unpricedTokens.length === 1 ? "is" : "are"}{" "}
                excluded.
              </span>
            </>
          )}
        </p>
      </div>
    </div>
  );
}

function TargetInputTile({
  value,
  onSave,
}: {
  value: number;
  onSave: (next: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  // A never-set value is 0, and String(0) puts a literal "0" in the box that
  // the user has to delete before typing. Blank instead, so typing 5000 gives
  // 5000 rather than 05000. A real value still shows for editing. Saving a
  // blank box is unchanged: Number("") is 0, which the commit check accepts.
  const [draft, setDraft] = useState(value === 0 ? "" : String(value));

  const commit = () => {
    const parsed = Number(draft);
    onSave(Number.isFinite(parsed) && parsed >= 0 ? parsed : 0);
    setEditing(false);
  };

  return (
    <div className={tileClass}>
      <div className="flex items-center justify-between gap-2">
        <span className={labelClass}>Target Monthly %</span>
        {!editing && (
          <button
            type="button"
            onClick={() => {
              setDraft(value === 0 ? "" : String(value));
              setEditing(true);
            }}
            aria-label="Edit target monthly percent"
            className="text-[11px] font-medium text-[var(--muted)] transition-colors hover:text-[var(--accent)]"
          >
            Edit
          </button>
        )}
      </div>

      {editing ? (
        <input
          type="number"
          step="any"
          min="0"
          autoFocus
          aria-label="Target monthly percent"
          className="mt-2 block w-full rounded-md border border-[var(--border-strong)] bg-[var(--surface)] px-3 py-1.5 text-lg tabular-nums text-[var(--foreground)] [color-scheme:dark] focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
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
      ) : (
        <div className={`${valueClass} text-[var(--foreground)]`}>
          {value > 0 ? formatPercent(value) : "Not set"}
        </div>
      )}

      <p className={hintClass}>
        Your monthly earning goal, as a percentage of Initial Capital.
      </p>
    </div>
  );
}
