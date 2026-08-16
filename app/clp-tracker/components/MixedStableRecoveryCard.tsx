"use client";

import { useState } from "react";
import type { FeeClaim } from "../lib/types";
import type { OverallPnL } from "../lib/calculations";
import { findMixedStableClaims } from "../lib/calculations";

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function formatUsd(value: number): string {
  return usdFormatter.format(Number.isFinite(value) ? value : 0);
}

// One-time diagnostic for the per-leg conversion fix (2026-07-28).
//
// Overall P&L used to drop a claim entirely when it was marked "not converted",
// even when part of it was already stablecoin. This card reports what that cost
// on THIS user's own data — the count of mixed claims, the dollars recovered,
// and Overall P&L before vs after — because that data lives only in the
// browser's localStorage and cannot be computed anywhere else.
//
// Read-only: it changes no stored record. "Got it" only hides the card.
export function MixedStableRecoveryCard({
  claims,
  overall,
  onDismiss,
}: {
  claims: FeeClaim[];
  overall: OverallPnL;
  onDismiss: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  // Nothing to report when no claim has a stable leg under a "No" flag.
  if (overall.mixedStableClaims === 0) return null;

  const rows = findMixedStableClaims(claims);
  const before = overall.overall - overall.mixedStableRecovered;

  return (
    <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/[0.06] px-5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-emerald-300">
          Fee accounting corrected — {overall.mixedStableClaims}{" "}
          {overall.mixedStableClaims === 1 ? "claim" : "claims"} recovered
        </h2>
        <button
          type="button"
          onClick={onDismiss}
          className="text-[11px] font-medium text-[var(--muted)] transition-colors hover:text-[var(--accent)]"
        >
          Got it, hide this
        </button>
      </div>

      <p className="mt-2 text-[12px] leading-relaxed text-[var(--muted)]">
        These claims are marked &ldquo;not converted&rdquo;, but part of each one
        was already stablecoin — money that never needed converting. It used to
        be excluded from Overall P&amp;L entirely. It now counts. Volatile token
        fees are still excluded until you mark them converted.
      </p>

      <dl className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded border border-emerald-500/30 px-3 py-2">
          <dt className="text-[11px] uppercase tracking-wider text-[var(--muted)]">
            Mixed claims found
          </dt>
          <dd className="mt-1 text-lg font-semibold tabular-nums text-[var(--foreground)]">
            {overall.mixedStableClaims}
          </dd>
        </div>
        <div className="rounded border border-emerald-500/30 px-3 py-2">
          <dt className="text-[11px] uppercase tracking-wider text-[var(--muted)]">
            Amount recovered
          </dt>
          <dd className="mt-1 text-lg font-semibold tabular-nums text-emerald-400">
            +{formatUsd(overall.mixedStableRecovered)}
          </dd>
        </div>
        <div className="rounded border border-emerald-500/30 px-3 py-2">
          <dt className="text-[11px] uppercase tracking-wider text-[var(--muted)]">
            Overall P&amp;L before → after
          </dt>
          <dd className="mt-1 text-sm font-semibold tabular-nums text-[var(--foreground)]">
            <span className="text-[var(--muted)] line-through">
              {formatUsd(before)}
            </span>{" "}
            → {formatUsd(overall.overall)}
          </dd>
        </div>
      </dl>

      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="mt-3 text-[11px] font-medium text-[var(--accent)] transition-colors hover:underline"
      >
        {expanded ? "Hide the claims" : `Show the ${rows.length} claims`}
      </button>

      {expanded && (
        <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto scrollbar-dark pr-1">
          {rows.map((r) => (
            <li
              key={r.claim.id}
              className="flex flex-wrap items-baseline justify-between gap-2 rounded border border-[var(--border)] px-3 py-2 text-[12px]"
            >
              <span className="text-[var(--foreground)]">
                {r.claim.date} · {r.claim.pair}
                {r.typedTotal === null && (
                  <span className="ml-2 text-[11px] text-[var(--muted)]">
                    no typed total — stable leg counted at face value
                  </span>
                )}
                {r.clamped && (
                  <span className="ml-2 text-[11px] text-amber-300">
                    clamped from {formatUsd(r.stableFace)}{" "}
                    to the claim&rsquo;s typed total
                  </span>
                )}
              </span>
              <span className="font-semibold tabular-nums text-emerald-400">
                +{formatUsd(r.recovered)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
