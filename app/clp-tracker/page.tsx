"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  dismissMixedStableNotice,
  getBusinessPnLSettings,
  getClaims,
  getOutlierDismissals,
  getStalePositionDismissals,
  getPositions,
  getSettings,
  getTransfers,
  isMixedStableNoticeDismissed,
  saveSettings,
} from "./lib/storage";
import {
  InitialCapitalCard,
  OverallPnLCard,
} from "./components/CapitalCards";
import { GrowthTargetSection } from "./components/GrowthTarget";
import { useLivePositionPrices } from "./lib/useLivePositionPrices";
import { DataHealthCard } from "./components/DataHealthCard";
import { MixedStableRecoveryCard } from "./components/MixedStableRecoveryCard";
import { computeDataHealth, type DataHealthReport } from "./lib/dataHealth";
import { useHydrated } from "./lib/useHydrated";
import { mergePrices, useTokenPrices } from "./lib/useTokenPrices";
import {
  calcDaysActive,
  calcFeeAPR,
  calcOverallPnL,
  calcPortfolioSummary,
  withLiveValues,
  calcUnconvertedHoldings,
  type OverallPnL,
  calcPositionProfit,
  calcPriceDiff,
  calcWideRangePercent,
  getEffectiveDeposited,
  getEffectiveTotalFees,
} from "./lib/calculations";
import type {
  FeeClaim,
  OutlierDismissal,
  StalePositionDismissal,
  PortfolioSummary,
  Position,
  Transfer,
} from "./lib/types";

const EMPTY_OVERALL: OverallPnL = {
  activeCurrentValue: 0,
  convertedFees: 0,
  convertedFromTokens: 0,
  expenses: 0,
  initialCapital: 0,
  overall: 0,
  unvaluedConvertedClaims: 0,
  mixedStableClaims: 0,
  mixedStableRecovered: 0,
};

const EMPTY_DATA_HEALTH: DataHealthReport = {
  positionSymbol: [],
  claimSymbol: [],
  transferSymbol: [],
  chainMismatch: [],
  claimOutliers: [],
  transferOutliers: [],
  stalePositions: [],
  incompleteClaims: [],
  driftedClaimTransfers: [],
  orphanedByClaim: [],
  idleUpside: [],
  counts: {
    positionSymbol: 0,
    claimSymbol: 0,
    transferSymbol: 0,
    chainMismatch: 0,
    claimOutliers: 0,
    transferOutliers: 0,
    stalePositions: 0,
    incompleteClaims: 0,
    idleUpside: 0,
    driftedClaimTransfers: 0,
    orphanedByClaim: 0,
    total: 0,
  },
};

const EMPTY_SUMMARY: PortfolioSummary = {
  totalDeposited: 0,
  totalCurrentValue: 0,
  totalFees: 0,
  totalProfit: 0,
  averageAPR: 0,
  activePositions: 0,
  closedPositions: 0,
};

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

function formatPercent(value: number): string {
  const safe = Number.isFinite(value) ? value : 0;
  return `${safe.toFixed(2)}%`;
}

function formatTokenAmount(value: number): string {
  return tokenFormatter.format(Number.isFinite(value) ? value : 0);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function pnlColor(value: number): string {
  if (value > 0) return "text-emerald-400";
  if (value < 0) return "text-rose-400";
  return "text-[var(--foreground)]";
}

function lastUpdatedTimestamp(
  positions: Position[],
  claims: FeeClaim[],
): string | null {
  let max = 0;
  const consider = (s: string | null | undefined) => {
    if (!s) return;
    const t = new Date(s).getTime();
    if (Number.isFinite(t) && t > max) max = t;
  };
  for (const p of positions) {
    consider(p.entryDatetime);
    consider(p.exitDatetime);
  }
  for (const c of claims) consider(c.date);
  if (max === 0) return null;
  return formatDateTime(new Date(max).toISOString());
}

interface SummaryCardProps {
  label: string;
  value: string;
  valueClass?: string;
  hint?: string;
}

function SummaryCard({ label, value, valueClass, hint }: SummaryCardProps) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
      <div className="text-[11px] font-medium uppercase tracking-wider text-[var(--muted)]">
        {label}
      </div>
      <div
        className={`mt-2 text-2xl font-semibold tracking-tight ${valueClass ?? "text-[var(--foreground)]"}`}
      >
        {value}
      </div>
      {hint && <p className="mt-2 text-[11px] text-[var(--muted)]">{hint}</p>}
    </div>
  );
}

// Average Fee APR with a timeframe toggle (Part 2). Pure display conversion of
// the one underlying yearly APR — yearly as-is, monthly /12, weekly /52,
// daily /365. No change to how APR is computed.
const APR_TIMEFRAMES = [
  { key: "daily", label: "Daily", divisor: 365 },
  { key: "weekly", label: "Weekly", divisor: 52 },
  { key: "monthly", label: "Monthly", divisor: 12 },
  { key: "yearly", label: "Yearly", divisor: 1 },
] as const;

type AprTimeframe = (typeof APR_TIMEFRAMES)[number]["key"];

function AverageFeeAprCard({ yearlyApr }: { yearlyApr: number }) {
  const [timeframe, setTimeframe] = useState<AprTimeframe>("yearly");
  const divisor =
    APR_TIMEFRAMES.find((t) => t.key === timeframe)?.divisor ?? 1;
  const value = (Number.isFinite(yearlyApr) ? yearlyApr : 0) / divisor;
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
      <div className="flex items-start justify-between gap-2">
        <div className="text-[11px] font-medium uppercase tracking-wider text-[var(--muted)]">
          Average Fee APR (Active)
        </div>
      </div>
      <div className="mt-2 text-2xl font-semibold tracking-tight text-[var(--foreground)]">
        {formatPercent(value)}
      </div>
      <div
        role="radiogroup"
        aria-label="APR timeframe"
        className="mt-3 inline-flex overflow-hidden rounded-md border border-[var(--border-strong)]"
      >
        {APR_TIMEFRAMES.map((t, idx) => {
          const selected = t.key === timeframe;
          return (
            <button
              key={t.key}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => setTimeframe(t.key)}
              className={`h-7 px-2.5 text-[11px] font-medium transition-colors ${
                idx > 0 ? "border-l border-[var(--border-strong)]" : ""
              } ${
                selected
                  ? "bg-[var(--accent-solid)] text-white"
                  : "bg-[var(--surface-2)] text-[var(--muted)] hover:bg-[var(--surface-2)]/70"
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-[11px] text-[var(--muted)]">
        Deposit-weighted across open positions only.
      </p>
    </div>
  );
}

interface DerivedRow {
  position: Position;
  deposited: number;
  fees: number;
  days: number;
  apr: number;
  profit: number;
  rangeState: "in" | "out" | "unknown";
}

function rangeState(p: Position): "in" | "out" | "unknown" {
  if (
    !Number.isFinite(p.entryPrice) ||
    !Number.isFinite(p.bottomRange) ||
    !Number.isFinite(p.topRange) ||
    p.bottomRange === 0 ||
    p.topRange === 0
  ) {
    return "unknown";
  }
  return p.entryPrice >= p.bottomRange && p.entryPrice <= p.topRange
    ? "in"
    : "out";
}

function deriveRows(
  positions: Position[],
  allClaims: FeeClaim[],
): DerivedRow[] {
  return positions.map((position) => {
    const deposited = getEffectiveDeposited(position);
    const fees = getEffectiveTotalFees(position, allClaims);
    const days = calcDaysActive(position.entryDatetime, position.exitDatetime);
    const apr = calcFeeAPR(fees, deposited, days);
    const priceDiff = calcPriceDiff(position.currentBalance, deposited);
    const profit = calcPositionProfit(position, fees, priceDiff);
    return {
      position,
      deposited,
      fees,
      days,
      apr,
      profit,
      rangeState: rangeState(position),
    };
  });
}

function recentClaims(claims: FeeClaim[]): FeeClaim[] {
  return [...claims]
    .sort((a, b) => {
      const ta = new Date(a.date).getTime();
      const tb = new Date(b.date).getTime();
      const safeA = Number.isFinite(ta) ? ta : 0;
      const safeB = Number.isFinite(tb) ? tb : 0;
      return safeB - safeA;
    })
    .slice(0, 5);
}

export default function DashboardPage() {
  const [positions, setPositions] = useState<Position[]>([]);
  const [claims, setClaims] = useState<FeeClaim[]>([]);

  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [initialCapital, setInitialCapital] = useState(0);
  const [targetMonthlyPercent, setTargetMonthlyPercent] = useState(0);
  const [dismissals, setDismissals] = useState<OutlierDismissal[]>([]);
  const [staleDismissals, setStaleDismissals] = useState<
    StalePositionDismissal[]
  >([]);
  // One-time diagnostic for the per-leg conversion fix; hidden once seen.
  const [mixedNoticeHidden, setMixedNoticeHidden] = useState(true);
  // Manual price overrides from the Business P&L page. Same source, same merge
  // order as Total P&L, so the held-fees figure matches there exactly.
  const [manualPrices, setManualPrices] = useState<Record<string, number>>({});

  const hydrated = useHydrated(() => {
    setPositions(getPositions());
    setClaims(getClaims());
    setTransfers(getTransfers());
    setDismissals(getOutlierDismissals());
    setStaleDismissals(getStalePositionDismissals());
    setMixedNoticeHidden(isMixedStableNoticeDismissed());
    setManualPrices(getBusinessPnLSettings().prices);
    const settings = getSettings();
    setInitialCapital(settings.initialCapital);
    setTargetMonthlyPercent(settings.targetMonthlyPercent);
  });

  const handleSaveInitialCapital = (next: number) => {
    saveSettings({ ...getSettings(), initialCapital: next });
    setInitialCapital(next);
  };

  const handleSaveTarget = (next: number) => {
    saveSettings({ ...getSettings(), targetMonthlyPercent: next });
    setTargetMonthlyPercent(next);
  };

  // Active positions valued at the live market price, exactly as the Positions
  // page cards show them. Invariant #6: Current Value and Total Profit (Active)
  // here must be the same figures that page reports, so both read the same
  // helper over the same price resolution. Closed positions and unresolved
  // prices keep their stored value.
  const { pairPriceById } = useLivePositionPrices(positions);
  const livePositions = useMemo(
    () => withLiveValues(positions, pairPriceById),
    [positions, pairPriceById],
  );

  const overall = useMemo(
    () =>
      hydrated
        ? calcOverallPnL(livePositions, claims, transfers, initialCapital)
        : EMPTY_OVERALL,
    [hydrated, livePositions, claims, transfers, initialCapital],
  );

  // What the still-held (unconverted) fee tokens are worth today — the figure
  // Overall P&L excludes. Same helper and same fetched-over-manual merge as
  // Total P&L's Fees Earned card; this page had no price fetching before.
  const { fetchedPrices } = useTokenPrices(claims);
  const prices = useMemo(
    () => mergePrices(fetchedPrices, manualPrices),
    [fetchedPrices, manualPrices],
  );
  const heldFeesValue = useMemo(
    () => (hydrated ? calcUnconvertedHoldings(claims, prices).totalCurrentValue : 0),
    [hydrated, claims, prices],
  );

  const dataHealth = useMemo(
    () =>
      hydrated
        ? computeDataHealth(
            positions,
            claims,
            transfers,
            dismissals,
            staleDismissals,
          )
        : EMPTY_DATA_HEALTH,
    [hydrated, positions, claims, transfers, dismissals, staleDismissals],
  );

  // Two scopes, deliberately kept apart. The Dashboard answers "where do I
  // stand right now", so every headline card — capital AND profit — reads
  // `activeSummary` (open positions only). `summary` spans every position
  // ever opened and now feeds exactly one card: Lifetime Total Deposited.
  // The whole-business view of profit lives on the Total P&L page.
  const summary = hydrated
    ? calcPortfolioSummary(livePositions, claims)
    : EMPTY_SUMMARY;
  const activeSummary = hydrated
    ? calcPortfolioSummary(
        livePositions.filter((p) => p.status === "active"),
        claims,
      )
    : EMPTY_SUMMARY;
  const activeRows = hydrated
    ? deriveRows(livePositions.filter((p) => p.status === "active"), claims)
    : [];
  const claimRows = hydrated ? recentClaims(claims) : [];
  const lastUpdated = useMemo(
    () => (hydrated ? lastUpdatedTimestamp(positions, claims) : null),
    [hydrated, positions, claims],
  );

  const isEmpty = hydrated && positions.length === 0 && claims.length === 0;

  return (
    <section className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Portfolio overview across all tracked positions.
        </p>
        {lastUpdated && (
          <p className="mt-1 text-xs text-[var(--muted)]/80">
            Last updated {lastUpdated}
          </p>
        )}
      </header>

      {hydrated && !isEmpty && <DataHealthCard report={dataHealth} />}

      {hydrated && !isEmpty && !mixedNoticeHidden && (
        <MixedStableRecoveryCard
          claims={claims}
          overall={overall}
          onDismiss={() => {
            dismissMixedStableNotice();
            setMixedNoticeHidden(true);
          }}
        />
      )}

      {isEmpty ? (
        <WelcomeEmptyState />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <SummaryCard
              label="Total Deposited (Active)"
              value={formatUsd(activeSummary.totalDeposited)}
              hint="Capital currently deployed in open positions."
            />
            <SummaryCard
              label="Lifetime Total Deposited"
              value={formatUsd(summary.totalDeposited)}
              hint="All positions ever opened, including closed."
            />
            <SummaryCard
              label="Current Value"
              value={formatUsd(activeSummary.totalCurrentValue)}
              hint="Open positions only."
            />
            {/* Scoped labels on purpose: the Total P&L page carries the
                whole-business versions of these three figures, and Invariant #6
                forbids the same label standing for two different scopes. */}
            <SummaryCard
              label="Fees Earned (Active)"
              value={formatUsd(activeSummary.totalFees)}
              valueClass={pnlColor(activeSummary.totalFees)}
              hint="Active only. Total P&L page covers everything, including closed."
            />
            <SummaryCard
              label="Total Profit (Active)"
              value={formatUsd(activeSummary.totalProfit)}
              valueClass={pnlColor(activeSummary.totalProfit)}
              hint="Price change + fees, open positions only. Total P&L page covers everything, including closed."
            />
            <AverageFeeAprCard yearlyApr={activeSummary.averageAPR} />
            <SummaryCard
              label="Active Positions"
              value={String(activeSummary.activePositions)}
              hint="Positions currently open."
            />
            <InitialCapitalCard
              value={initialCapital}
              onSave={handleSaveInitialCapital}
            />
            <OverallPnLCard result={overall} heldFeesValue={heldFeesValue} />
          </div>

          <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)]">
            <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-4">
              <h2 className="text-sm font-semibold tracking-tight">
                Active Positions
              </h2>
              <span className="text-xs text-[var(--muted)]">
                {activeRows.length}{" "}
                {activeRows.length === 1 ? "position" : "positions"}
              </span>
            </div>

            {activeRows.length === 0 ? (
              <div className="px-5 py-10 text-center text-sm text-[var(--muted)]">
                No active positions yet. Go to Positions to add your first one.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-[var(--border)] text-sm">
                  <thead className="bg-[var(--surface-2)] text-[11px] uppercase tracking-wider text-[var(--muted)]">
                    <tr>
                      <th className="px-4 py-3 text-left font-medium">Pair</th>
                      <th className="px-4 py-3 text-left font-medium">Chain</th>
                      <th className="px-4 py-3 text-left font-medium">
                        Protocol
                      </th>
                      <th className="px-4 py-3 text-right font-medium">
                        Deposited
                      </th>
                      <th className="px-4 py-3 text-right font-medium">
                        Current Value
                      </th>
                      <th className="px-4 py-3 text-right font-medium">
                        Total Fees
                      </th>
                      <th className="px-4 py-3 text-right font-medium">
                        Fee APR
                      </th>
                      <th className="px-4 py-3 text-right font-medium">
                        Days Active
                      </th>
                      <th className="px-4 py-3 text-right font-medium">
                        Range %
                      </th>
                      <th className="px-4 py-3 text-right font-medium">
                        Profit
                      </th>
                      <th className="px-4 py-3 text-left font-medium">
                        Status
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border)]">
                    {activeRows.map(
                      ({ position, deposited, fees, days, apr, profit, rangeState: rs }) => (
                        <tr
                          key={position.id}
                          className="transition-colors hover:bg-[var(--surface-2)]/60"
                        >
                          <td className="px-4 py-3 font-medium text-[var(--foreground)]">
                            <div className="inline-flex items-center gap-2">
                              <RangeDot state={rs} />
                              {position.pair}
                            </div>
                          </td>
                          <td className="px-4 py-3 text-[var(--muted)]">
                            {position.chain}
                          </td>
                          <td className="px-4 py-3 text-[var(--muted)]">
                            {position.protocol}
                          </td>
                          <td className="px-4 py-3 text-right tabular-nums">
                            {formatUsd(deposited)}
                          </td>
                          <td className="px-4 py-3 text-right tabular-nums">
                            {formatUsd(position.currentBalance)}
                          </td>
                          <td className="px-4 py-3 text-right tabular-nums">
                            {formatUsd(fees)}
                          </td>
                          <td className="px-4 py-3 text-right tabular-nums">
                            {formatPercent(apr)}
                          </td>
                          <td className="px-4 py-3 text-right tabular-nums text-[var(--muted)]">
                            {days.toFixed(1)}
                          </td>
                          <td className="px-4 py-3 text-right tabular-nums text-[var(--muted)]">
                            {(() => {
                              const wr = calcWideRangePercent(
                                position.bottomRange,
                                position.topRange,
                              );
                              return wr > 0 ? formatPercent(wr) : "—";
                            })()}
                          </td>
                          <td
                            className={`px-4 py-3 text-right tabular-nums font-medium ${pnlColor(profit)}`}
                          >
                            {formatUsd(profit)}
                          </td>
                          <td className="px-4 py-3">
                            <span className="inline-flex items-center rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider text-emerald-400 ring-1 ring-inset ring-emerald-500/20">
                              {position.status}
                            </span>
                          </td>
                        </tr>
                      ),
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)]">
            <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-4">
              <h2 className="text-sm font-semibold tracking-tight">
                Recent Fee Claims
              </h2>
              <span className="text-xs text-[var(--muted)]">
                Last {claimRows.length} of {claims.length}
              </span>
            </div>

            {claimRows.length === 0 ? (
              <div className="px-5 py-10 text-center text-sm text-[var(--muted)]">
                No fee claims recorded yet.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-[var(--border)] text-sm">
                  <thead className="bg-[var(--surface-2)] text-[11px] uppercase tracking-wider text-[var(--muted)]">
                    <tr>
                      <th className="px-4 py-3 text-left font-medium">Date</th>
                      <th className="px-4 py-3 text-left font-medium">Pair</th>
                      <th className="px-4 py-3 text-left font-medium">
                        Platform
                      </th>
                      <th className="px-4 py-3 text-right font-medium">
                        Token 1 Amount
                      </th>
                      <th className="px-4 py-3 text-right font-medium">
                        Token 2 Amount
                      </th>
                      <th className="px-4 py-3 text-left font-medium">
                        Converted to Stable
                      </th>
                      <th className="px-4 py-3 text-right font-medium">
                        USD Value
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border)]">
                    {claimRows.map((claim) => (
                      <tr key={claim.id}>
                        <td className="px-4 py-3 text-[var(--muted)]">
                          {formatDate(claim.date)}
                        </td>
                        <td className="px-4 py-3 font-medium text-[var(--foreground)]">
                          {claim.pair}
                        </td>
                        <td className="px-4 py-3 text-[var(--muted)]">
                          {claim.platform}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {formatTokenAmount(claim.token1Amount)}{" "}
                          <span className="text-[var(--muted)]">
                            {claim.token1Symbol}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {formatTokenAmount(claim.token2Amount)}{" "}
                          <span className="text-[var(--muted)]">
                            {claim.token2Symbol}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-[var(--muted)]">
                          {claim.convertedToStable ? "Yes" : "No"}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {claim.stableAmount !== null
                            ? formatUsd(claim.stableAmount)
                            : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <GrowthTargetSection
            positions={livePositions}
            claims={claims}
            prices={prices}
            initialCapital={initialCapital}
            targetMonthlyPercent={targetMonthlyPercent}
            onSaveTarget={handleSaveTarget}
          />
        </>
      )}
    </section>
  );
}

interface RangeDotProps {
  state: "in" | "out" | "unknown";
}

function RangeDot({ state }: RangeDotProps) {
  if (state === "unknown") return null;
  const tone =
    state === "in"
      ? "bg-emerald-400 ring-emerald-500/30"
      : "bg-rose-400 ring-rose-500/30";
  const title = state === "in" ? "In Range" : "Out of Range";
  return (
    <span
      aria-label={title}
      title={title}
      className={`inline-block h-2 w-2 rounded-full ring-2 ring-inset ${tone}`}
    />
  );
}

function WelcomeEmptyState() {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-6 py-16 text-center">
      <EmptyStateIcon />
      <h2 className="mt-4 text-lg font-semibold tracking-tight text-[var(--foreground)]">
        Welcome to CLP Tracker
      </h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-[var(--muted)]">
        Start by adding your first LP position.
      </p>
      <Link
        href="/clp-tracker/positions"
        className="mt-5 inline-flex h-9 items-center justify-center rounded-md bg-[var(--accent-solid)] px-4 text-sm font-medium text-white shadow-sm transition-colors hover:bg-[var(--accent-solid)]/90"
      >
        Add Position
      </Link>
    </div>
  );
}

function EmptyStateIcon() {
  return (
    <svg
      className="mx-auto h-10 w-10 text-[var(--muted)]/60"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      aria-hidden
    >
      <path
        d="M3 3v18h18"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M7 14l3-3 3 3 4-5 4 4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
