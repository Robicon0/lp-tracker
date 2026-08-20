"use client";

import { useMemo, useState } from "react";
import {
  getClaims,
  getOutlierDismissals,
  getPositions,
  saveClaims,
  saveOutlierDismissals,
} from "../lib/storage";
import { useHydrated } from "../lib/useHydrated";
import {
  calcDaysActive,
  calcFeeAPR,
  calcPortfolioSummary,
  correctClaimSymbols,
  findClaimSymbolMismatches,
  getEffectiveDeposited,
  isUnvaluedConvertedClaim,
  summarizeClaimContamination,
  type ClaimContaminationRow,
  type ClaimSymbolMismatchRow,
} from "../lib/calculations";
import {
  dismissalFor,
  findClaimAmountOutliers,
  type OutlierRow,
} from "../lib/dataHealth";
import { cleanupClaimTransfers } from "../lib/transferAutomation";
import { OutlierBanner } from "../components/OutlierBanner";
import { PositionCombobox } from "../components/PositionCombobox";
import { normalizeChain, normalizePlatform } from "../lib/nameNormalization";
import {
  ClaimFormModal,
  persistNewClaim,
  persistUpdatedClaim,
} from "../components/ClaimFormModal";
import type { FeeClaim, OutlierDismissal, Position } from "../lib/types";

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const tokenFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
});

function formatUsd(value: number): string {
  return usdFormatter.format(Number.isFinite(value) ? value : 0);
}

function formatToken(value: number): string {
  return tokenFormatter.format(Number.isFinite(value) ? value : 0);
}

function formatPercent(value: number): string {
  const safe = Number.isFinite(value) ? value : 0;
  return `${safe.toFixed(2)}%`;
}

// What ONE claim earned, annualised over the stretch it actually covers: from
// the previous claim on the same position (or the position's entry, for the
// first one) to this claim's date. Runs through the shared calcFeeAPR with
// claim-scoped inputs rather than cumulative ones, so it can never disagree
// with any other APR in the app about how the rate is computed (Invariant #6).
// (The cumulative per-position column that used to sit beside this one was
// removed with its helper; the summary cards' Average Position APR is a
// separate figure from calcPortfolioSummary and is unaffected.)
//
// The previous claim is found in the FULL claim list, never the filtered one:
// a claim's own APR is a property of the record, not of what the page happens
// to be showing, so filtering must not silently re-baseline it (the same
// reasoning as the Average Position APR fix in 4ac704f).
//
// null means "not computable", rendered as "—": either the claim has no USD
// value yet, or the window is zero/negative (two claims on one day, or a claim
// backdated before its position's entry). calcFeeAPR returns 0 for a
// non-positive window, and a flat 0.00% would read as a real, earned-nothing
// result rather than an unanswerable question.
function claimFeeAPR(
  claim: FeeClaim,
  position: Position,
  allClaims: FeeClaim[],
): number | null {
  if (claim.stableAmount === null || claim.stableAmount === undefined) {
    return null;
  }
  const samePosition = allClaims
    .filter((c) => c.positionId === claim.positionId)
    .sort((a, b) => a.date.localeCompare(b.date));
  const index = samePosition.findIndex((c) => c.id === claim.id);
  const previous = index > 0 ? samePosition[index - 1] : undefined;
  const since = previous ? previous.date : position.entryDatetime;
  const days = calcDaysActive(since, claim.date);
  if (days <= 0) return null;
  return calcFeeAPR(claim.stableAmount, getEffectiveDeposited(position), days);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function formatDateDDMMYYYY(value: string): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

// Flags claims whose stored token symbol contradicts their own pair, shows the
// per-token "X wrong is really Y" subtotal that inflates Business P&L, and
// offers a confirmed one-click bulk correction plus per-row Edit. Reports and
// corrects only on explicit user action — never silently.
function ClaimSymbolMismatchBanner({
  rows,
  contamination,
  onEdit,
  onFixAll,
}: {
  rows: ClaimSymbolMismatchRow[];
  contamination: ClaimContaminationRow[];
  onEdit: (claim: FeeClaim) => void;
  onFixAll: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div
      id="claim-symbol-issues"
      className="rounded-lg border border-red-500/50 bg-red-500/[0.07] px-5 py-4"
    >
      <h2 className="text-sm font-semibold text-red-300">
        {rows.length} {rows.length === 1 ? "claim has" : "claims have"} a token
        symbol that doesn&apos;t match its pair
      </h2>
      <p className="mt-1 text-[11px] leading-relaxed text-[var(--muted)]">
        These claims stored the wrong reward-token symbol (e.g. SOL logged
        against a SUI/USDC pair), which inflates that token&apos;s total on
        Business P&amp;L. Fixing them re-sums those totals correctly. Nothing
        changes until you confirm.
      </p>

      {contamination.length > 0 && (
        <div className="mt-3 rounded border border-red-500/30 bg-[var(--surface-2)]/40 px-3 py-2">
          <p className="text-[11px] font-medium uppercase tracking-wider text-[var(--muted)]">
            Mislabeled amounts
          </p>
          <ul className="mt-1.5 space-y-1">
            {contamination.map((c) => (
              <li
                key={`${c.wrongSymbol}->${c.correctSymbol}`}
                className="text-[12px] tabular-nums text-[var(--foreground)]"
              >
                <span className="font-medium text-red-300">
                  {formatToken(c.amount)} {c.wrongSymbol}
                </span>{" "}
                is actually{" "}
                <span className="font-medium text-emerald-300">
                  {c.correctSymbol}
                </span>{" "}
                <span className="text-[var(--muted)]">
                  ({c.claimCount} {c.claimCount === 1 ? "claim" : "claims"})
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <ul className="mt-3 space-y-2">
        {rows.map((r) => (
          <li
            key={r.claim.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded border border-[var(--border-strong)] bg-[var(--surface-2)]/40 px-3 py-2 text-[12px]"
          >
            <span className="font-medium text-[var(--foreground)]">
              {formatDateDDMMYYYY(r.claim.date)} · {r.claim.pair}
            </span>
            <span className="tabular-nums text-[var(--muted)]">
              {r.baseMismatch && (
                <>
                  <span className="font-medium text-red-300">{r.baseSymbol}</span>
                  {r.pairBase && <> → {r.pairBase}</>}
                </>
              )}
              {r.baseMismatch && r.quoteMismatch && " · "}
              {r.quoteMismatch && (
                <>
                  <span className="font-medium text-red-300">{r.quoteSymbol}</span>
                  {r.pairQuote && <> → {r.pairQuote}</>}
                </>
              )}
            </span>
            <button
              type="button"
              onClick={() => onEdit(r.claim)}
              className="rounded-md border border-red-500/50 px-2.5 py-1 text-[11px] font-medium text-red-300 transition-colors hover:bg-red-500/10"
            >
              Edit
            </button>
          </li>
        ))}
      </ul>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {confirming ? (
          <>
            <span className="text-[12px] text-red-300">
              Rewrite symbols on {rows.length}{" "}
              {rows.length === 1 ? "claim" : "claims"}?
            </span>
            <button
              type="button"
              onClick={() => {
                onFixAll();
                setConfirming(false);
              }}
              className="rounded-md bg-red-500/90 px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-red-500"
            >
              Yes, fix all
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="rounded-md border border-[var(--border-strong)] px-3 py-1.5 text-[12px] font-medium text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)]"
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="rounded-md border border-red-500/50 px-3 py-1.5 text-[12px] font-medium text-red-300 transition-colors hover:bg-red-500/10"
          >
            Fix all {rows.length} {rows.length === 1 ? "claim" : "claims"}
          </button>
        )}
      </div>
    </div>
  );
}

type ModalState =
  | { kind: "none" }
  | { kind: "add" }
  | { kind: "edit"; claim: FeeClaim };

type PositionStatusFilter = "all" | "open" | "closed";

// Deliberately NOT folded into Status. Status is a property of the claim's
// PARENT POSITION (open/closed); this is a property of the CLAIM itself
// (cashed out to stablecoin or still held as the reward token). Two different
// questions — one control answering both would be unable to express
// "converted claims on closed positions".
type ConvertedFilter = "all" | "converted" | "not-converted";

interface FilterState {
  positionId: string;
  platform: string;
  chain: string;
  // Filter claims by whether their linked position is active or closed.
  positionStatus: PositionStatusFilter;
  // Filter claims by the claim's own convertedToStable flag.
  converted: ConvertedFilter;
  // When true, show only claims marked converted with no saved USD value.
  needsValueOnly: boolean;
}

const ALL = "__all__";
const EMPTY_FILTERS: FilterState = {
  positionId: ALL,
  platform: ALL,
  chain: ALL,
  positionStatus: "all",
  converted: "all",
  needsValueOnly: false,
};

export default function ClaimsPage() {
  const [claims, setClaims] = useState<FeeClaim[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [modal, setModal] = useState<ModalState>({ kind: "none" });
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const [dismissals, setDismissals] = useState<OutlierDismissal[]>([]);

  const refresh = () => {
    setClaims(getClaims());
    setPositions(getPositions());
    setDismissals(getOutlierDismissals());
  };

  const hydrated = useHydrated(refresh);

  // Options normalized so synonyms merge into one entry (Part 5). Grouping/
  // label only — stored claim.chain/platform are never modified.
  const platformOptions = useMemo(() => {
    const set = new Set<string>();
    for (const c of claims) if (c.platform) set.add(normalizePlatform(c.platform));
    return Array.from(set).sort();
  }, [claims]);

  const chainOptions = useMemo(() => {
    const set = new Set<string>();
    for (const c of claims) if (c.chain) set.add(normalizeChain(c.chain));
    return Array.from(set).sort();
  }, [claims]);

  const needsValueCount = useMemo(
    () => claims.filter(isUnvaluedConvertedClaim).length,
    [claims],
  );

  // Claims whose stored token symbol contradicts their own pair (the SUI→SOL
  // contamination). These inflate the wrong token's Business P&L total until
  // corrected, and are invisible to the position-level detector.
  const claimMismatches = useMemo(
    () => (hydrated ? findClaimSymbolMismatches(claims) : []),
    [hydrated, claims],
  );
  const contamination = useMemo(
    () => summarizeClaimContamination(claimMismatches),
    [claimMismatches],
  );
  // Unusual-amount outliers: claims 10× outside their position's usual range.
  const claimOutliers = useMemo(
    () =>
      hydrated ? findClaimAmountOutliers(claims, positions, dismissals) : [],
    [hydrated, claims, positions, dismissals],
  );

  const handleConfirmOutlier = (row: OutlierRow) => {
    saveOutlierDismissals([...getOutlierDismissals(), dismissalFor(row)]);
    setDismissals(getOutlierDismissals());
  };

  const statusById = useMemo(() => {
    const map = new Map<string, "active" | "closed">();
    for (const p of positions) map.set(p.id, p.status);
    return map;
  }, [positions]);

  const filteredSorted = useMemo(() => {
    if (!hydrated) return [];
    const filtered = claims.filter((c) => {
      if (filters.positionId !== ALL && c.positionId !== filters.positionId) return false;
      if (filters.platform !== ALL && normalizePlatform(c.platform) !== filters.platform) return false;
      if (filters.chain !== ALL && normalizeChain(c.chain) !== filters.chain) return false;
      if (filters.positionStatus !== "all") {
        const status = statusById.get(c.positionId);
        const wantClosed = filters.positionStatus === "closed";
        // A claim with no resolvable position is treated as open (not closed).
        if ((status === "closed") !== wantClosed) return false;
      }
      if (filters.converted !== "all") {
        const wantConverted = filters.converted === "converted";
        if (c.convertedToStable !== wantConverted) return false;
      }
      if (filters.needsValueOnly && !isUnvaluedConvertedClaim(c)) return false;
      return true;
    });
    return filtered.sort((a, b) => {
      const ta = new Date(a.date).getTime();
      const tb = new Date(b.date).getTime();
      const safeA = Number.isFinite(ta) ? ta : 0;
      const safeB = Number.isFinite(tb) ? tb : 0;
      return safeB - safeA;
    });
  }, [hydrated, claims, filters, statusById]);

  // Summary cards describe the same claims the table shows, so they read from
  // the filtered set — not the raw list. Computing over all claims while the
  // table filtered was the recurring "cards ignore the filter" bug already
  // fixed on Dashboard (7ae0e50) and Pool P&L (741ac8a).
  const totals = useMemo(() => {
    let convertedCount = 0;
    let stableSum = 0;
    for (const c of filteredSorted) {
      if (c.convertedToStable) convertedCount += 1;
      // USD value counts regardless of conversion status (Invariant #10)
      if (c.stableAmount !== null && Number.isFinite(c.stableAmount)) {
        stableSum += c.stableAmount;
      }
    }
    return {
      total: filteredSorted.length,
      stableSum,
      converted: convertedCount,
    };
  }, [filteredSorted]);

  const positionById = useMemo(() => {
    const map = new Map<string, Position>();
    for (const p of positions) map.set(p.id, p);
    return map;
  }, [positions]);

  // Deposit-weighted average APR across the positions represented in the
  // FILTERED claims, so this card follows the filters like the other three.
  // The APR uses the full claim list for each included position's fee total
  // (getEffectiveTotalFees inside calcPortfolioSummary) — a position's APR is
  // a property of the position, not of a claim subset, so it must not be
  // computed from a sliced fee history (Invariant #10). The filter decides
  // WHICH positions are in scope; each position's APR stays whole.
  const averagePositionApr = useMemo<number | null>(() => {
    if (filteredSorted.length === 0) return null;
    const claimedPositionIds = new Set(
      filteredSorted.map((c) => c.positionId),
    );
    const claimedPositions = positions.filter((p) =>
      claimedPositionIds.has(p.id),
    );
    if (claimedPositions.length === 0) return null;
    return calcPortfolioSummary(claimedPositions, claims).averageAPR;
  }, [filteredSorted, positions, claims]);

  const handleAdd = (claim: FeeClaim) => {
    persistNewClaim(claim);
    refresh();
    setModal({ kind: "none" });
  };

  // Result ignored: the "skipped-touched" outcome — reconcile refusing to
  // overwrite a transfer the user has already sent, deployed or expensed — is
  // now reported by the Data Health drift check, which keeps showing it on
  // Transfers and the Dashboard until someone acts, rather than as a one-time
  // notice that vanished on the next click.
  const handleEdit = (claim: FeeClaim) => {
    void persistUpdatedClaim(claim);
    refresh();
    setModal({ kind: "none" });
  };

  const handleDelete = (id: string) => {
    // The transfer this claim created must not outlive it as an orphan: an
    // untouched auto row is soft-deleted with the claim (restorable from
    // Recently Deleted), a row the user has since placed keeps its money
    // history and only loses the dead link.
    cleanupClaimTransfers(id);
    saveClaims(getClaims().filter((c) => c.id !== id));
    refresh();
    setPendingDelete(null);
  };

  // One-click bulk correction: rewrite each flagged claim's mismatched symbol
  // to its pair-derived value, through the shared persist path so transfers
  // stay reconciled (Invariant #10). User-triggered and confirmed — never
  // silent. Fixing the symbols re-sums the Business P&L totals correctly.
  // Result deliberately ignored here: N claims would raise N identical notices,
  // and a symbol correction does not change any transfer AMOUNT, which is what
  // the notice is about.
  const handleFixAllSymbols = (rows: ClaimSymbolMismatchRow[]) => {
    for (const row of rows) {
      void persistUpdatedClaim(correctClaimSymbols(row));
    }
    refresh();
  };

  return (
    <section className="space-y-8">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Fee Claims</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Log every fee claim from your LP positions.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setModal({ kind: "add" })}
          className="inline-flex h-9 items-center justify-center rounded-md bg-[var(--accent-solid)] px-4 text-sm font-medium text-white shadow-sm transition-colors hover:bg-[var(--accent-solid)]/90"
        >
          Add Claim
        </button>
      </header>

      {claimMismatches.length > 0 && (
        <ClaimSymbolMismatchBanner
          rows={claimMismatches}
          contamination={contamination}
          onEdit={(claim) => setModal({ kind: "edit", claim })}
          onFixAll={() => handleFixAllSymbols(claimMismatches)}
        />
      )}

      <OutlierBanner
        id="claim-outliers"
        rows={claimOutliers}
        noun="claim"
        onEdit={(row) => row.claim && setModal({ kind: "edit", claim: row.claim })}
        onConfirm={handleConfirmOutlier}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryStat label="Total Claims" value={String(totals.total)} />
        <SummaryStat
          label="Total Fees Earned (USD)"
          value={formatUsd(totals.stableSum)}
        />
        <SummaryStat
          label="Total Converted to Stable"
          value={`${totals.converted} / ${totals.total}`}
        />
        <SummaryStat
          label="Average Position APR (Claimed)"
          value={
            averagePositionApr === null
              ? "—"
              : formatPercent(averagePositionApr)
          }
          hint="Deposit-weighted across all positions with claims here — active AND closed. The Dashboard's Average Fee APR is active-only, so this runs higher."
        />
      </div>

      {/* This banner already IS the Data Health "incomplete claims" surface —
          same canonical predicate (isUnvaluedConvertedClaim), same count. It
          only needed the anchor the Dashboard card deep-links to; adding a
          second banner would have shown the user the same claims twice. */}
      {needsValueCount > 0 && (
        <div
          id="incomplete-claims"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/40 bg-amber-500/[0.06] px-5 py-4"
        >
          <div>
            <p className="text-[13px] font-medium text-amber-300">
              {needsValueCount}{" "}
              {needsValueCount === 1 ? "claim needs" : "claims need"} a USD value
            </p>
            <p className="mt-0.5 text-[11px] text-[var(--muted)]">
              Marked converted to stablecoin but saved with no USD value, so
              they count as $0 toward Overall P&amp;L. Open each and add the
              value it converted to.
            </p>
          </div>
          <button
            type="button"
            onClick={() =>
              setFilters((prev) => ({
                ...prev,
                needsValueOnly: !prev.needsValueOnly,
              }))
            }
            className="rounded-md border border-amber-500/40 px-2.5 py-1 text-[11px] font-medium text-amber-300 transition-colors hover:bg-amber-500/10"
          >
            {filters.needsValueOnly ? "Show all claims" : "Show only these"}
          </button>
        </div>
      )}

      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)]">
        {filters.needsValueOnly && (
          <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] bg-amber-500/[0.04] px-5 py-2.5">
            <span className="text-[11px] font-medium text-amber-300">
              Showing only claims that need a USD value
            </span>
            <button
              type="button"
              onClick={() =>
                setFilters((prev) => ({ ...prev, needsValueOnly: false }))
              }
              className="text-[11px] font-medium text-[var(--muted)] transition-colors hover:text-[var(--foreground)]"
            >
              Clear
            </button>
          </div>
        )}
        <div className="grid grid-cols-1 gap-3 border-b border-[var(--border)] px-5 py-4 sm:grid-cols-2 lg:grid-cols-5">
          <PositionCombobox
            positions={positions}
            value={filters.positionId}
            onChange={(v) =>
              setFilters((prev) => ({ ...prev, positionId: v }))
            }
            allValue={ALL}
          />
          <FilterSelect
            label="Platform"
            value={filters.platform}
            onChange={(v) =>
              setFilters((prev) => ({ ...prev, platform: v }))
            }
            options={[
              { value: ALL, label: "All platforms" },
              ...platformOptions.map((p) => ({ value: p, label: p })),
            ]}
          />
          <FilterSelect
            label="Chain"
            value={filters.chain}
            onChange={(v) => setFilters((prev) => ({ ...prev, chain: v }))}
            options={[
              { value: ALL, label: "All chains" },
              ...chainOptions.map((c) => ({ value: c, label: c })),
            ]}
          />
          {/* Was a standalone pill toggle above this row; same filter state and
              same predicate, just moved in-line with the other filters. */}
          <FilterSelect
            label="Status"
            value={filters.positionStatus}
            onChange={(v) =>
              setFilters((prev) => ({
                ...prev,
                positionStatus: v as PositionStatusFilter,
              }))
            }
            options={[
              { value: "all", label: "All positions" },
              { value: "open", label: "Open positions" },
              { value: "closed", label: "Closed positions" },
            ]}
          />
          {/* Its own control, not part of Status: Status asks about the parent
              position, this asks about the claim. They AND together like every
              other pair here. */}
          <FilterSelect
            label="Converted"
            value={filters.converted}
            onChange={(v) =>
              setFilters((prev) => ({
                ...prev,
                converted: v as ConvertedFilter,
              }))
            }
            options={[
              { value: "all", label: "All claims" },
              { value: "converted", label: "Converted" },
              { value: "not-converted", label: "Not converted" },
            ]}
          />
        </div>

        {filteredSorted.length === 0 ? (
          claims.length === 0 ? (
            <div className="px-6 py-14 text-center">
              <EmptyIcon />
              <h3 className="mt-3 text-base font-semibold tracking-tight text-[var(--foreground)]">
                No fee claims yet
              </h3>
              <p className="mx-auto mt-1.5 max-w-sm text-sm text-[var(--muted)]">
                Start by adding your first fee claim after claiming from your LP
                position.
              </p>
              <button
                type="button"
                onClick={() => setModal({ kind: "add" })}
                className="mt-4 inline-flex h-9 items-center justify-center rounded-md bg-[var(--accent-solid)] px-4 text-sm font-medium text-white shadow-sm transition-colors hover:bg-[var(--accent-solid)]/90"
              >
                Add Claim
              </button>
            </div>
          ) : (
            <div className="px-5 py-10 text-center text-sm text-[var(--muted)]">
              No claims match the current filters.
            </div>
          )
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-[var(--border)] text-sm">
              <thead className="bg-[var(--surface-2)] text-[11px] uppercase tracking-wider text-[var(--muted)]">
                <tr>
                  <th className="px-4 py-3 text-left font-medium">Date</th>
                  <th className="px-4 py-3 text-left font-medium">Pair</th>
                  <th className="px-4 py-3 text-left font-medium">Platform</th>
                  <th className="px-4 py-3 text-left font-medium">Chain</th>
                  <th className="px-4 py-3 text-right font-medium">
                    This Claim&apos;s APR
                  </th>
                  <th className="px-4 py-3 text-right font-medium">Token 1</th>
                  <th className="px-4 py-3 text-right font-medium">Token 2</th>
                  <th className="px-4 py-3 text-left font-medium">Converted</th>
                  <th className="px-4 py-3 text-right font-medium">
                    USD Value
                  </th>
                  <th className="px-4 py-3 text-left font-medium">Tx</th>
                  <th className="px-4 py-3 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {filteredSorted.map((claim) => {
                  const parentPosition = positionById.get(claim.positionId);
                  const ownApr = parentPosition
                    ? claimFeeAPR(claim, parentPosition, claims)
                    : null;
                  return (
                  <tr
                    key={claim.id}
                    className="transition-colors hover:bg-[var(--surface-2)]/60"
                  >
                    <td className="px-4 py-3 text-[var(--muted)] tabular-nums">
                      {formatDateDDMMYYYY(claim.date)}
                    </td>
                    <td className="px-4 py-3 font-medium text-[var(--foreground)]">
                      {claim.pair}
                    </td>
                    <td className="px-4 py-3 text-[var(--muted)]">
                      {claim.platform}
                    </td>
                    <td className="px-4 py-3 text-[var(--muted)]">
                      {claim.chain}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {ownApr === null ? "—" : formatPercent(ownApr)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {formatToken(claim.token1Amount)}{" "}
                      <span className="text-[var(--muted)]">
                        {claim.token1Symbol}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {formatToken(claim.token2Amount)}{" "}
                      <span className="text-[var(--muted)]">
                        {claim.token2Symbol}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-[var(--muted)]">
                      {claim.convertedToStable
                        ? `Yes — ${claim.stableSymbol ?? ""}`.trim()
                        : "No"}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {claim.stableAmount !== null
                        ? formatUsd(claim.stableAmount)
                        : "—"}
                    </td>
                    <td className="px-4 py-3 text-[var(--muted)]">
                      <TxCell value={claim.txId ?? null} />
                    </td>
                    <td className="px-4 py-3 text-right">
                      {pendingDelete === claim.id ? (
                        <div className="inline-flex items-center gap-2">
                          <span className="text-xs text-[var(--muted)]">
                            Delete this claim?
                          </span>
                          <button
                            type="button"
                            onClick={() => handleDelete(claim.id)}
                            className="rounded-md border border-rose-500/30 bg-rose-500/10 px-2.5 py-1 text-xs font-medium text-rose-300 hover:bg-rose-500/20"
                          >
                            Yes
                          </button>
                          <button
                            type="button"
                            onClick={() => setPendingDelete(null)}
                            className="rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)] px-2.5 py-1 text-xs font-medium text-[var(--foreground)] hover:bg-[var(--surface-2)]/70"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <div className="inline-flex gap-2">
                          <button
                            type="button"
                            onClick={() => setModal({ kind: "edit", claim })}
                            className="rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)] px-2.5 py-1 text-xs font-medium text-[var(--foreground)] hover:bg-[var(--surface-2)]/70"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => setPendingDelete(claim.id)}
                            className="rounded-md border border-rose-500/30 bg-rose-500/10 px-2.5 py-1 text-xs font-medium text-rose-300 hover:bg-rose-500/20"
                          >
                            Delete
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {modal.kind === "add" && (
        <ClaimFormModal
          mode="add"
          positions={positions}
          // If the page is already filtered to one position, that is almost
          // certainly the position being claimed — pre-select it rather than
          // making the user pick it a second time. Still editable; on "All
          // positions" the form opens blank exactly as before.
          initialPositionId={
            filters.positionId === ALL ? undefined : filters.positionId
          }
          onCancel={() => setModal({ kind: "none" })}
          onSubmit={handleAdd}
        />
      )}
      {modal.kind === "edit" && (
        <ClaimFormModal
          mode="edit"
          claim={modal.claim}
          positions={positions}
          onCancel={() => setModal({ kind: "none" })}
          onSubmit={handleEdit}
        />
      )}
    </section>
  );
}

interface SummaryStatProps {
  label: string;
  value: string;
  hint?: string;
}

function SummaryStat({ label, value, hint }: SummaryStatProps) {
  const [showHint, setShowHint] = useState(false);
  return (
    <div className="relative rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-[var(--muted)]">
        <span>{label}</span>
        {hint && (
          <button
            type="button"
            onClick={() => setShowHint((v) => !v)}
            aria-label="What does this mean?"
            aria-expanded={showHint}
            className="flex h-4 w-4 items-center justify-center rounded-full border border-[var(--border-strong)] text-[9px] leading-none text-[var(--muted)] transition-colors hover:border-[var(--accent)] hover:text-[var(--foreground)]"
          >
            i
          </button>
        )}
      </div>
      <div className="mt-2 text-2xl font-semibold tracking-tight text-[var(--foreground)]">
        {value}
      </div>
      {/* Absolutely positioned so revealing the hint never changes card height
          — all cards in the row stay aligned (Part 4c). */}
      {hint && showHint && (
        <div className="absolute left-3 right-3 top-full z-10 -mt-1 rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)] px-3 py-2 text-[11px] leading-relaxed text-[var(--muted)] shadow-lg">
          {hint}
        </div>
      )}
    </div>
  );
}

interface TxCellProps {
  value: string | null;
}

function TxCell({ value }: TxCellProps) {
  if (!value) return <span>—</span>;
  const isUrl = /^https?:\/\//i.test(value);
  if (isUrl) {
    return (
      <a
        href={value}
        target="_blank"
        rel="noopener noreferrer"
        className="text-[var(--accent)] hover:underline"
        onClick={(e) => e.stopPropagation()}
      >
        Open ↗
      </a>
    );
  }
  const display = value.length > 8 ? `${value.slice(0, 8)}…` : value;
  return <span className="font-mono text-xs" title={value}>{display}</span>;
}

interface FilterSelectProps {
  label: string;
  value: string;
  onChange: (next: string) => void;
  options: Array<{ value: string; label: string }>;
}

function FilterSelect({ label, value, onChange, options }: FilterSelectProps) {
  return (
    <label className="space-y-1.5">
      <span className="block text-[11px] font-medium uppercase tracking-wider text-[var(--muted)]">
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="block w-full rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--foreground)] [color-scheme:dark] focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function EmptyIcon() {
  return (
    <svg
      className="mx-auto h-10 w-10 text-[var(--muted)]/60"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      aria-hidden
    >
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M8 10h8M8 14h8M8 18h5" strokeLinecap="round" />
    </svg>
  );
}
