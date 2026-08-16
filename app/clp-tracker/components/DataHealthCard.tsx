"use client";

import Link from "next/link";
import type { DataHealthReport } from "../lib/dataHealth";

interface Category {
  label: string;
  count: number;
  href: string;
  tone: "red" | "amber";
}

// At-a-glance summary of every Data Health check (symbol mismatches across
// Positions/Claims/Transfers + unusual-amount outliers). Each category links to
// the page where its detailed banner and Fix flow live. Purely a signpost —
// all corrections happen on the destination pages, under explicit confirmation.
export function DataHealthCard({ report }: { report: DataHealthReport }) {
  const { counts } = report;
  const categories: Category[] = [
    {
      label: "Position token typos",
      count: counts.positionSymbol,
      href: "/clp-tracker/positions#position-symbol-issues",
      tone: "red" as const,
    },
    {
      label: "Claim token typos",
      count: counts.claimSymbol,
      href: "/clp-tracker/claims#claim-symbol-issues",
      tone: "red" as const,
    },
    {
      label: "Transfer token typos",
      count: counts.transferSymbol,
      href: "/clp-tracker/transfers#transfer-symbol-issues",
      tone: "red" as const,
    },
    {
      label: "Position chain typos",
      count: counts.chainMismatch,
      href: "/clp-tracker/positions#position-chain-issues",
      tone: "red" as const,
    },
    {
      label: "Unusual claim amounts",
      count: counts.claimOutliers,
      href: "/clp-tracker/claims#claim-outliers",
      tone: "amber" as const,
    },
    {
      label: "Unusual transfer amounts",
      count: counts.transferOutliers,
      href: "/clp-tracker/transfers#transfer-outliers",
      tone: "amber" as const,
    },
    // Amber, not red: a quiet pool and a claim awaiting its USD value are
    // both "worth a look", not "definitely wrong" like a token typo.
    {
      label: "Positions with no recent activity",
      count: counts.stalePositions,
      href: "/clp-tracker/positions#stale-positions",
      tone: "amber" as const,
    },
    {
      label: "Claims missing a USD value",
      count: counts.incompleteClaims,
      href: "/clp-tracker/claims#incomplete-claims",
      tone: "amber" as const,
    },
    {
      label: "Earnings sitting idle",
      count: counts.idleUpside,
      href: "/clp-tracker/transfers#idle-earnings",
      tone: "amber" as const,
    },
    {
      label: "Transfers out of step with their claim",
      count: counts.driftedClaimTransfers,
      href: "/clp-tracker/transfers#claim-drift",
      tone: "amber" as const,
    },
    {
      label: "Transfers whose claim was deleted",
      count: counts.orphanedByClaim,
      href: "/clp-tracker/transfers#claim-deleted",
      tone: "amber" as const,
    },
  ].filter((c) => c.count > 0);

  if (counts.total === 0) {
    return (
      <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/[0.05] px-5 py-4">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-emerald-300">
            Data Health
          </span>
          <span className="text-[12px] text-[var(--muted)]">
            No issues detected — every symbol matches its pair, no amounts look
            unusual, and nothing is sitting incomplete or idle.
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-red-500/40 bg-red-500/[0.06] px-5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-red-300">
          Data Health — {counts.total}{" "}
          {counts.total === 1 ? "issue" : "issues"} to review
        </h2>
        <span className="text-[11px] text-[var(--muted)]">
          Detection only — nothing changes until you confirm a fix.
        </span>
      </div>
      <ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {categories.map((c) => (
          <li key={c.href}>
            <Link
              href={c.href}
              className={`flex items-center justify-between gap-3 rounded border px-3 py-2 text-[12px] transition-colors ${
                c.tone === "red"
                  ? "border-red-500/40 hover:bg-red-500/10"
                  : "border-amber-500/40 hover:bg-amber-500/10"
              }`}
            >
              <span className="text-[var(--foreground)]">{c.label}</span>
              <span
                className={`rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums ${
                  c.tone === "red"
                    ? "bg-red-500/15 text-red-300"
                    : "bg-amber-500/15 text-amber-300"
                }`}
              >
                {c.count}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
