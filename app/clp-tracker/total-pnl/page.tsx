"use client";

import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import {
  getBusinessPnLSettings,
  getClaims,
  getPositions,
  getSettings,
  getTransfers,
  saveSettings,
} from "../lib/storage";
import {
  calcConvertedFees,
  calcDaysActive,
  calcFeeAPR,
  calcOverallPnL,
  withLiveValues,
  calcPositionProfit,
  calcPriceDiff,
  calcUnconvertedHoldings,
  getEffectiveDeposited,
  getEffectiveTotalFees,
  type OverallPnL,
} from "../lib/calculations";
import {
  InitialCapitalCard,
  OverallPnLCard,
} from "../components/CapitalCards";
import { Breakdown } from "../components/Breakdown";
import { GrowthTargetSection } from "../components/GrowthTarget";
import { useLivePositionPrices } from "../lib/useLivePositionPrices";
import { useHydrated } from "../lib/useHydrated";
import { mergePrices, useTokenPrices } from "../lib/useTokenPrices";
import type { FeeClaim, Position, Transfer } from "../lib/types";

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

function formatDate(iso: string | null): string {
  if (!iso) return "\u2014";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "\u2014";
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatPercent(value: number): string {
  const safe = Number.isFinite(value) ? value : 0;
  return `${safe.toFixed(2)}%`;
}

function pnlColor(value: number): string {
  if (value > 0) return "text-emerald-400";
  if (value < 0) return "text-rose-400";
  return "text-[var(--foreground)]";
}

function pnlBorder(value: number): string {
  if (value > 0) return "border-emerald-500/40";
  if (value < 0) return "border-rose-500/40";
  return "border-[var(--border-strong)]";
}

const STABLE_SYMBOLS = new Set(["USDC", "USDT", "DAI"]);

interface PortfolioTotals {
  totalInvested: number;
  totalCurrentValue: number;
  // Claim-time value, for the Total Fees Earned card.
  totalFees: number;
  // The fee term Net P&L actually adds — current value when supplied.
  netFees: number;
  totalShortPnL: number;
  lpPnL: number;
  netPnL: number;
}

interface SegmentSummary {
  count: number;
  invested: number;
  fees: number;
  weightedApr: number;
  weight: number;
  profit: number;
  best: { pair: string; apr: number } | null;
}

// One closed position's contribution to the Scalp figure. Built in the SAME
// pass as lpSplit.closed below and from the same two values, so the list can
// never disagree with the number it explains.
interface ClosedScalpRow {
  id: string;
  pair: string;
  closedAt: string | null;
  closedTs: number;
  deposited: number;
  finalAmount: number;
  scalp: number;
}

interface TokenRow {
  symbol: string;
  claimCount: number;
  totalAmount: number;
  converted: "yes" | "no" | "stable";
  stableSum: number;
}

interface MonthRow {
  monthKey: string;
  monthLabel: string;
  claimCount: number;
  totalFeesUsd: number;
  positionsActive: number;
}

// feesForNetPnL, when supplied, is the fee term Net P&L adds: realized
// converted fees (claim-time, already banked) + still-held non-stable fee
// tokens at today's price — the fee money the business actually has. totalFees
// stays the claim-time sum either way, because the Total Fees Earned card
// beside it is a record of what was booked when it was claimed and must not
// move. The two deliberately differ. Omitted (the activeCapital pass) it falls
// back to totalFees, which is harmless there since that pass is only read for
// capital figures.
function computeTotals(
  positions: Position[],
  allClaims: FeeClaim[],
  feesForNetPnL?: number,
): PortfolioTotals {
  let totalInvested = 0;
  let totalCurrentValue = 0;
  let totalFees = 0;
  let totalShortPnL = 0;
  for (const p of positions) {
    totalInvested += getEffectiveDeposited(p);
    totalCurrentValue += p.currentBalance;
    totalFees += getEffectiveTotalFees(p, allClaims);
    if (p.shortTotal !== null && Number.isFinite(p.shortTotal)) {
      totalShortPnL += p.shortTotal;
    }
  }
  const lpPnL = totalCurrentValue - totalInvested;
  const netFees = feesForNetPnL ?? totalFees;
  return {
    totalInvested,
    totalCurrentValue,
    totalFees,
    netFees,
    totalShortPnL,
    lpPnL,
    netPnL: lpPnL + netFees + totalShortPnL,
  };
}

function emptySegment(): SegmentSummary {
  return {
    count: 0,
    invested: 0,
    fees: 0,
    weightedApr: 0,
    weight: 0,
    profit: 0,
    best: null,
  };
}

function summarizeSegment(
  positions: Position[],
  allClaims: FeeClaim[],
): SegmentSummary {
  const out = emptySegment();
  for (const p of positions) {
    const deposited = getEffectiveDeposited(p);
    const fees = getEffectiveTotalFees(p, allClaims);
    const days = calcDaysActive(p.entryDatetime, p.exitDatetime);
    const apr = calcFeeAPR(fees, deposited, days);
    const priceDiff = calcPriceDiff(p.currentBalance, deposited);
    const profit = calcPositionProfit(p, fees, priceDiff);
    out.count += 1;
    out.invested += deposited;
    out.fees += fees;
    out.profit += profit;
    if (deposited > 0) {
      out.weightedApr += apr * deposited;
      out.weight += deposited;
    }
    if (out.best === null || apr > out.best.apr) {
      out.best = { pair: p.pair, apr };
    }
  }
  return out;
}

function buildTokenRows(claims: FeeClaim[]): TokenRow[] {
  type Acc = {
    symbol: string;
    claimIds: Set<string>;
    totalAmount: number;
    convertedClaims: Set<string>;
    stableContributed: Map<string, number>; // claimId -> stableAmount once
  };
  const map = new Map<string, Acc>();

  const ensure = (sym: string): Acc => {
    let acc = map.get(sym);
    if (!acc) {
      acc = {
        symbol: sym,
        claimIds: new Set(),
        totalAmount: 0,
        convertedClaims: new Set(),
        stableContributed: new Map(),
      };
      map.set(sym, acc);
    }
    return acc;
  };

  for (const c of claims) {
    const sides: Array<{ sym: string; amt: number }> = [];
    if (c.token1Symbol) sides.push({ sym: c.token1Symbol, amt: c.token1Amount });
    if (c.token2Symbol) sides.push({ sym: c.token2Symbol, amt: c.token2Amount });
    for (const { sym, amt } of sides) {
      const acc = ensure(sym);
      acc.claimIds.add(c.id);
      acc.totalAmount += Number.isFinite(amt) ? amt : 0;
      if (c.convertedToStable) {
        acc.convertedClaims.add(c.id);
        if (
          c.stableAmount !== null &&
          Number.isFinite(c.stableAmount) &&
          !acc.stableContributed.has(c.id)
        ) {
          acc.stableContributed.set(c.id, c.stableAmount);
        }
      }
    }
  }

  const rows: TokenRow[] = [];
  for (const acc of map.values()) {
    const isStable = STABLE_SYMBOLS.has(acc.symbol);
    let stableSum = 0;
    for (const v of acc.stableContributed.values()) stableSum += v;
    rows.push({
      symbol: acc.symbol,
      claimCount: acc.claimIds.size,
      totalAmount: acc.totalAmount,
      converted: isStable
        ? "stable"
        : acc.convertedClaims.size > 0
          ? "yes"
          : "no",
      stableSum: isStable ? 0 : stableSum,
    });
  }
  rows.sort((a, b) => b.claimCount - a.claimCount || a.symbol.localeCompare(b.symbol));
  return rows;
}

function buildMonthRows(claims: FeeClaim[], positions: Position[]): MonthRow[] {
  const buckets = new Map<string, { claimCount: number; feesUsd: number; date: Date }>();
  for (const c of claims) {
    const d = new Date(c.date);
    if (Number.isNaN(d.getTime())) continue;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { claimCount: 0, feesUsd: 0, date: new Date(d.getFullYear(), d.getMonth(), 1) };
      buckets.set(key, bucket);
    }
    bucket.claimCount += 1;
    // USD value counts regardless of conversion status (Invariant #10)
    if (c.stableAmount !== null && Number.isFinite(c.stableAmount)) {
      bucket.feesUsd += c.stableAmount;
    }
  }

  const rows: MonthRow[] = [];
  for (const [key, b] of buckets) {
    const monthStart = b.date.getTime();
    const monthEnd = new Date(b.date.getFullYear(), b.date.getMonth() + 1, 0, 23, 59, 59, 999).getTime();
    let positionsActive = 0;
    for (const p of positions) {
      const entry = new Date(p.entryDatetime).getTime();
      if (!Number.isFinite(entry) || entry > monthEnd) continue;
      const exitRaw = p.exitDatetime ? new Date(p.exitDatetime).getTime() : null;
      if (exitRaw !== null && Number.isFinite(exitRaw) && exitRaw < monthStart) continue;
      positionsActive += 1;
    }
    rows.push({
      monthKey: key,
      monthLabel: b.date.toLocaleDateString("en-US", { month: "long", year: "numeric" }),
      claimCount: b.claimCount,
      totalFeesUsd: b.feesUsd,
      positionsActive,
    });
  }
  rows.sort((a, b) => (a.monthKey < b.monthKey ? 1 : a.monthKey > b.monthKey ? -1 : 0));
  return rows;
}

export default function TotalPnlPage() {
  const [positions, setPositions] = useState<Position[]>([]);
  const [claims, setClaims] = useState<FeeClaim[]>([]);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [initialCapital, setInitialCapital] = useState(0);
  const [targetMonthlyPercent, setTargetMonthlyPercent] = useState(0);

  // ONE price fetch for the whole page (state declared here so the hydrate
  // callback below can seed it). Both consumers — the portfolio cards'
  // held-fees figure and Growth Target's Business P&L total — read the merged
  // result, so the page issues a single /api/prices call and everything on it
  // is priced identically.
  const [manualPrices, setManualPrices] = useState<Record<string, number>>({});

  const hydrated = useHydrated(() => {
    setManualPrices(getBusinessPnLSettings().prices);
    setPositions(getPositions());
    setClaims(getClaims());
    setTransfers(getTransfers());
    const settings = getSettings();
    setInitialCapital(settings.initialCapital);
    setTargetMonthlyPercent(settings.targetMonthlyPercent);
  });

  // Manual overrides from Business P&L settings sit on top of the fetched
  // values — the same merge order used everywhere else. Declared here, above
  // the totals below, because Net P&L's fee term is now priced from it; the
  // page still issues exactly ONE /api/prices call, shared by the portfolio
  // cards' held-fees figure, Growth Target and Net P&L.
  const { fetchedPrices } = useTokenPrices(claims);
  const prices = useMemo(
    () => mergePrices(fetchedPrices, manualPrices),
    [fetchedPrices, manualPrices],
  );

  // The fee money you ACTUALLY have: what was realized, plus what is still
  // held, each on its own honest basis.
  //
  //   realized  = calcConvertedFees — fixed, claim-time dollars, already banked
  //   still held = calcUnconvertedHoldings(excludeStables) — live token prices
  //
  // Deliberately NOT Business P&L's All Total, which this used to be. All Total
  // prices EVERY reward token ever claimed at TODAY's rate, including tokens
  // that were converted and sold long ago — so a token that has since doubled
  // inflated Net P&L by money the business never received. Stablecoins are
  // excluded from the held half because their dollars are already inside the
  // realized half (the same reason Business P&L's holdings table excludes
  // them); counting them twice would double-count real money.
  //
  // Both halves come from the functions that already own those definitions, so
  // Net P&L cannot drift from Overall P&L's Converted Fees or Business P&L's
  // Unconverted Holdings (Invariant #6).
  const feesForNetPnL = useMemo(
    () =>
      hydrated
        ? calcConvertedFees(claims) +
          calcUnconvertedHoldings(claims, prices, { excludeStables: true })
            .totalCurrentValue
        : 0,
    [hydrated, claims, prices],
  );

  // This page is the whole-business view, so the PROFIT figures it computes —
  // Fees Earned, LP P&L, Short P&L and the Net P&L that sums them — span every
  // position ever opened, closed included. Money already earned does not stop
  // counting because the position that earned it was closed. The CAPITAL cards
  // beside them stay open-only and are computed separately (see
  // activeCapital below): capital in a closed position has been withdrawn and
  // redeployed, so counting it again would double-count it. The Dashboard
  // carries the open-only view of profit.
  // Active positions at live market value, same helper and same price
  // resolution as the Positions page and Dashboard (Invariant #6 — these
  // figures appear on more than one page and may not disagree).
  const { pairPriceById } = useLivePositionPrices(positions);
  const livePositions = useMemo(
    () => withLiveValues(positions, pairPriceById),
    [positions, pairPriceById],
  );

  const totals = useMemo(
    () =>
      hydrated
        ? computeTotals(livePositions, claims, feesForNetPnL)
        : {
            totalInvested: 0,
            totalCurrentValue: 0,
            totalFees: 0,
            netFees: 0,
            totalShortPnL: 0,
            lpPnL: 0,
            netPnL: 0,
          },
    [hydrated, livePositions, claims, feesForNetPnL],
  );

  // Capital deployed RIGHT NOW. Deliberately a separate, open-only pass:
  // `totals` above went whole-business for the profit figures, but Total
  // Invested and Total Current Value must keep describing money currently in
  // pools — a closed position's principal was withdrawn and redeployed, and
  // counting it again double-counts it.
  const activeCapital = useMemo(
    () =>
      hydrated
        ? computeTotals(
            livePositions.filter((p) => p.status === "active"),
            claims,
          )
        : {
            totalInvested: 0,
            totalCurrentValue: 0,
            totalFees: 0,
            netFees: 0,
            totalShortPnL: 0,
            lpPnL: 0,
            netPnL: 0,
          },
    [hydrated, livePositions, claims],
  );

  // LP P&L split into active price movement vs closed-position scalp, drawn
  // from the SAME arithmetic as totals.lpPnL (Σ currentBalance − deposited)
  // so the two parts add up to it exactly. For a closed position
  // currentBalance is the final withdrawn amount, so (final − deposited) is
  // that position's scalp by the app's definition (c372b30).
  // The per-position rows behind `closed` are collected here rather than in a
  // second pass, so the "Show breakdown" list under Closed positions (Scalp)
  // is the identical arithmetic, item by item, and sums to it by construction.
  const lpSplit = useMemo(() => {
    let active = 0;
    let closed = 0;
    const closedRows: ClosedScalpRow[] = [];
    for (const p of positions) {
      const deposited = getEffectiveDeposited(p);
      const v = p.currentBalance - deposited;
      if (p.status === "active") {
        active += v;
        continue;
      }
      closed += v;
      const ts = p.exitDatetime ? new Date(p.exitDatetime).getTime() : NaN;
      closedRows.push({
        id: p.id,
        pair: p.pair,
        closedAt: p.exitDatetime,
        // Undated closes sort last rather than being dropped from the list.
        closedTs: Number.isFinite(ts) ? ts : Number.NEGATIVE_INFINITY,
        deposited,
        finalAmount: p.currentBalance,
        scalp: v,
      });
    }
    closedRows.sort((a, b) => b.closedTs - a.closedTs);
    return { active, closed, closedRows };
  }, [positions]);

  const handleSaveInitialCapital = (next: number) => {
    saveSettings({ ...getSettings(), initialCapital: next });
    setInitialCapital(next);
  };

  const handleSaveTarget = (next: number) => {
    saveSettings({ ...getSettings(), targetMonthlyPercent: next });
    setTargetMonthlyPercent(next);
  };

  const overall = useMemo(
    () =>
      hydrated
        ? calcOverallPnL(livePositions, claims, transfers, initialCapital)
        : EMPTY_OVERALL,
    [hydrated, livePositions, claims, transfers, initialCapital],
  );

  const lifetimeDeposited = useMemo(
    () =>
      hydrated
        ? positions.reduce((sum, p) => sum + getEffectiveDeposited(p), 0)
        : 0,
    [hydrated, positions],
  );

  const activeSummary = useMemo(
    () =>
      hydrated
        ? summarizeSegment(
            livePositions.filter((p) => p.status === "active"),
            claims,
          )
        : emptySegment(),
    [hydrated, livePositions, claims],
  );

  const closedSummary = useMemo(
    () =>
      hydrated
        ? summarizeSegment(
            positions.filter((p) => p.status === "closed"),
            claims,
          )
        : emptySegment(),
    [hydrated, positions, claims],
  );

  const tokenRows = useMemo(
    () => (hydrated ? buildTokenRows(claims) : []),
    [hydrated, claims],
  );

  const monthRows = useMemo(
    () => (hydrated ? buildMonthRows(claims, positions) : []),
    [hydrated, claims, positions],
  );

  const isEmpty = hydrated && positions.length === 0 && claims.length === 0;

  return (
    <section className="space-y-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Total P&amp;L</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Complete overview of your DeFi LP performance.
        </p>
      </header>

      {isEmpty ? (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-6 py-14 text-center">
          <EmptyIcon />
          <h2 className="mt-3 text-lg font-semibold tracking-tight text-[var(--foreground)]">
            No data yet
          </h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-[var(--muted)]">
            Add positions and log fee claims to see your complete P&amp;L
            overview.
          </p>
          <Link
            href="/clp-tracker/positions"
            className="mt-5 inline-flex h-9 items-center justify-center rounded-md bg-[var(--accent-solid)] px-4 text-sm font-medium text-white shadow-sm transition-colors hover:bg-[var(--accent-solid)]/90"
          >
            Go to Positions
          </Link>
        </div>
      ) : (
        <>
          <PortfolioSummarySection
            totals={totals}
            activeCapital={activeCapital}
            lpSplit={lpSplit}
            lifetimeDeposited={lifetimeDeposited}
            overall={overall}
            claims={claims}
            prices={prices}
            initialCapital={initialCapital}
            onSaveInitialCapital={handleSaveInitialCapital}
          />
          <PerformanceBreakdownSection
            active={activeSummary}
            closed={closedSummary}
          />
          <FeeIncomeSection rows={tokenRows} />
          <MonthlyPerformanceSection rows={monthRows} />
          <GrowthTargetSection
            positions={positions}
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
      <path d="M3 3v18h18" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M7 14l3-3 3 3 4-5 4 4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

interface PortfolioSummarySectionProps {
  totals: PortfolioTotals;
  activeCapital: PortfolioTotals;
  lpSplit: { active: number; closed: number; closedRows: ClosedScalpRow[] };
  lifetimeDeposited: number;
  overall: OverallPnL;
  claims: FeeClaim[];
  prices: Record<string, number>;
  initialCapital: number;
  onSaveInitialCapital: (next: number) => void;
}

function PortfolioSummarySection({
  totals,
  activeCapital,
  lpSplit,
  lifetimeDeposited,
  overall,
  claims,
  prices,
  initialCapital,
  onSaveInitialCapital,
}: PortfolioSummarySectionProps) {
  // Prices arrive from the page, which fetches them once for every consumer
  // (this section AND Growth Target). Only the derived figure lives here.
  const heldFeesValue = useMemo(
    () => calcUnconvertedHoldings(claims, prices).totalCurrentValue,
    [claims, prices],
  );

  return (
    <div className="space-y-3">
      <SectionHeading title="Portfolio Summary" />
      <p className="-mt-1 text-xs text-[var(--muted)]">
        Profit figures cover your whole LP business, active and closed
        positions combined. The two capital figures stay open-only — a closed
        position&apos;s capital was withdrawn and redeployed.
      </p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <BigStat
          label="Total Invested (Active)"
          value={formatUsd(activeCapital.totalInvested)}
          hint="Capital currently deployed in open positions."
        />
        <BigStat
          label="Lifetime Total Deposited"
          value={formatUsd(lifetimeDeposited)}
          hint="All positions ever opened, including closed."
        />
        <BigStat
          label="Total Current Value"
          value={formatUsd(activeCapital.totalCurrentValue)}
          hint="Open positions only."
        />
        {/* Scoped labels on purpose: the Dashboard carries the open-only
            versions of these figures, so neither page may reuse the other's
            label for a different scope (Invariant #6). */}
        <FeesEarnedCard
          totalFees={totals.totalFees}
          convertedFees={overall.convertedFees}
          heldFeesValue={heldFeesValue}
        />
        <BigStat
          label="Total Short P&L"
          value={formatUsd(totals.totalShortPnL)}
          valueClass={pnlColor(totals.totalShortPnL)}
          hint="Every short ever recorded — a short is logged on its position and has no separate open/closed state."
        />
        <BigStat
          label="LP P&L"
          value={formatUsd(totals.lpPnL)}
          valueClass={pnlColor(totals.lpPnL)}
          hint="Sum of (current value − deposited) across all positions, active and closed. Price movement only, before fees."
          breakdown={
            <Breakdown
              rows={[
                {
                  label: "Active positions (price movement)",
                  value: formatUsd(lpSplit.active),
                },
                {
                  label: "+ Closed positions (Scalp)",
                  value: formatUsd(lpSplit.closed),
                  after: (
                    <ClosedScalpList
                      rows={lpSplit.closedRows}
                      expected={lpSplit.closed}
                    />
                  ),
                },
                { label: "=", value: formatUsd(totals.lpPnL), isTotal: true },
              ]}
            />
          }
        />
        <NetPnlCard
          value={totals.netPnL}
          breakdown={
            <Breakdown
              rows={[
                { label: "LP P&L", value: formatUsd(totals.lpPnL) },
                {
                  // Not "Total Fees Earned" — that card is the claim-time sum
                  // of every fee ever earned, while this term is realized
                  // fees + only what is STILL held, priced today. Reusing its
                  // name would put two different numbers under one label
                  // (Invariant #6).
                  label: "+ Fees Realized + Still Held",
                  value: formatUsd(totals.netFees),
                },
                {
                  label: "+ Short P&L",
                  value: formatUsd(totals.totalShortPnL),
                },
                { label: "=", value: formatUsd(totals.netPnL), isTotal: true },
              ]}
            />
          }
        />
        <InitialCapitalCard
          value={initialCapital}
          onSave={onSaveInitialCapital}
        />
        <OverallPnLCard
          result={overall}
          heldFeesValue={heldFeesValue}
          breakdown={
            <Breakdown
              rows={[
                {
                  label: "Current Value (active)",
                  value: formatUsd(overall.activeCurrentValue),
                },
                {
                  label: "+ Converted Fees (realized, all-time)",
                  value: formatUsd(overall.convertedFees),
                },
                {
                  label: "− Initial Capital",
                  value: formatUsd(overall.initialCapital),
                },
                { label: "=", value: formatUsd(overall.overall), isTotal: true },
              ]}
            />
          }
        />
      </div>
    </div>
  );
}

// The closed-position list behind "Closed positions (Scalp)". Collapsed by
// default and nested under that single line, so the LP P&L card keeps its
// height until the user asks to see the math. Purely a view of values already
// computed in lpSplit — it adds no arithmetic of its own beyond re-summing the
// rows for the footer, which is exactly the point: the footer proves the list
// adds up to the figure above it.
function ClosedScalpList({
  rows,
  expected,
}: {
  rows: ClosedScalpRow[];
  // The "Closed positions (Scalp)" figure this list explains. Equal to the
  // footer sum by construction (same values, same pass) — passed in only so a
  // future divergence would be visible rather than silent.
  expected: number;
}) {
  const [open, setOpen] = useState(false);

  if (rows.length === 0) return null;

  const listTotal = rows.reduce((sum, r) => sum + r.scalp, 0);
  const matches = Math.abs(listTotal - expected) < 0.005;

  return (
    <div className="mt-1 pl-3">
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
          &#9656;
        </span>
        {open
          ? "Hide breakdown"
          : `Show breakdown (${rows.length} closed ${
              rows.length === 1 ? "position" : "positions"
            })`}
      </button>

      {open && (
        <ul className="mt-1.5 space-y-1.5">
          {rows.map((row) => (
            <li key={row.id} className="leading-tight">
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-medium text-[var(--foreground)]">
                  {row.pair}
                </span>
                <span className={`tabular-nums ${pnlColor(row.scalp)}`}>
                  {formatUsd(row.scalp)}
                </span>
              </div>
              <div className="text-[10px] tabular-nums text-[var(--muted)]">
                {formatDate(row.closedAt)} &middot; deposited{" "}
                {formatUsd(row.deposited)} &rarr; received{" "}
                {formatUsd(row.finalAmount)}
              </div>
            </li>
          ))}

          <li className="flex items-baseline justify-between gap-3 border-t border-[var(--border)] pt-1 font-medium text-[var(--foreground)]">
            <span>= Closed positions (Scalp)</span>
            <span className={`tabular-nums ${pnlColor(listTotal)}`}>
              {formatUsd(listTotal)}
            </span>
          </li>
          {!matches && (
            <li className="text-[10px] text-amber-400">
              List sum does not match the figure above ({formatUsd(expected)}).
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

interface BigStatProps {
  label: string;
  value: string;
  valueClass?: string;
  hint?: string;
  breakdown?: ReactNode;
}

function BigStat({ label, value, valueClass, hint, breakdown }: BigStatProps) {
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
      {breakdown}
    </div>
  );
}

// Total Fees Earned with a converted-vs-still-held note. The converted figure
// is Overall P&L's realized convertedFees (converted-to-stable claims only);
// the still-held figure is Business P&L's Unconverted Holdings current value,
// computed with the same calcUnconvertedHoldings + merged prices so the two
// pages show the same number (Invariant #6). Not recomputed here beyond
// calling that shared helper.
function FeesEarnedCard({
  totalFees,
  convertedFees,
  heldFeesValue,
}: {
  totalFees: number;
  convertedFees: number;
  // Computed once by the parent section and shared with Overall P&L, so both
  // cards quote the identical figure by construction.
  heldFeesValue: number;
}) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
      <div className="text-[11px] font-medium uppercase tracking-wider text-[var(--muted)]">
        Total Fees Earned
      </div>
      <div
        className={`mt-2 text-2xl font-semibold tracking-tight ${pnlColor(totalFees)}`}
      >
        {formatUsd(totalFees)}
      </div>
      <p className="mt-2 text-[11px] text-[var(--muted)]">
        Your whole LP business, active and closed positions combined.
      </p>
      <p className="mt-1 text-[11px] tabular-nums text-[var(--muted)]">
        {formatUsd(convertedFees)} converted · {formatUsd(heldFeesValue)}{" "}
        still held at today&apos;s value (
        <Link href="/clp-tracker/business-pnl" className="text-[var(--accent)] hover:underline">
          see Business P&amp;L
        </Link>
        )
      </p>
    </div>
  );
}

interface NetPnlCardProps {
  value: number;
  breakdown?: ReactNode;
}

function NetPnlCard({ value, breakdown }: NetPnlCardProps) {
  return (
    <div
      className={`rounded-lg border-2 ${pnlBorder(value)} bg-[var(--surface)] p-6 shadow-lg`}
    >
      <div className="text-[11px] font-semibold uppercase tracking-widest text-[var(--muted)]">
        Net P&amp;L
      </div>
      <div
        className={`mt-2 text-4xl font-bold tracking-tight tabular-nums ${pnlColor(value)}`}
      >
        {formatUsd(value)}
      </div>
      <p className="mt-2 text-[11px] text-[var(--muted)]">
        LP P&amp;L + fee money you actually have (realized + still held) + Short
        P&amp;L, across every position ever opened
      </p>
      {breakdown}
    </div>
  );
}

interface PerformanceBreakdownSectionProps {
  active: SegmentSummary;
  closed: SegmentSummary;
}

function PerformanceBreakdownSection({
  active,
  closed,
}: PerformanceBreakdownSectionProps) {
  const avgApr = active.weight > 0 ? active.weightedApr / active.weight : 0;
  return (
    <div className="space-y-3">
      <SectionHeading title="Performance Breakdown" />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SegmentCard
          title="Active Positions Summary"
          rows={[
            { label: "Active positions", value: String(active.count) },
            { label: "Total invested", value: formatUsd(active.invested) },
            { label: "Total fees earned", value: formatUsd(active.fees) },
            { label: "Average Fee APR", value: formatPercent(avgApr) },
            {
              label: "Best performing",
              value: active.best
                ? `${active.best.pair} · ${formatPercent(active.best.apr)}`
                : "—",
            },
          ]}
        />
        <SegmentCard
          title="Closed Positions Summary"
          rows={[
            { label: "Closed positions", value: String(closed.count) },
            { label: "Total invested", value: formatUsd(closed.invested) },
            { label: "Total fees earned", value: formatUsd(closed.fees) },
            {
              label: "Total profit",
              value: formatUsd(closed.profit),
              valueClass: pnlColor(closed.profit),
            },
          ]}
        />
      </div>
    </div>
  );
}

interface SegmentRow {
  label: string;
  value: string;
  valueClass?: string;
}

interface SegmentCardProps {
  title: string;
  rows: SegmentRow[];
}

function SegmentCard({ title, rows }: SegmentCardProps) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
      <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
      <dl className="mt-4 divide-y divide-[var(--border)]">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex items-baseline justify-between gap-4 py-2.5"
          >
            <dt className="text-[11px] uppercase tracking-wider text-[var(--muted)]">
              {row.label}
            </dt>
            <dd
              className={`text-sm font-medium tabular-nums ${row.valueClass ?? "text-[var(--foreground)]"}`}
            >
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

interface FeeIncomeSectionProps {
  rows: TokenRow[];
}

function FeeIncomeSection({ rows }: FeeIncomeSectionProps) {
  return (
    <div className="space-y-3">
      <SectionHeading title="Fee Income Breakdown" />
      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)]">
        {rows.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-[var(--muted)]">
            No fee income recorded yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-[var(--border)] text-sm">
              <thead className="bg-[var(--surface-2)] text-[11px] uppercase tracking-wider text-[var(--muted)]">
                <tr>
                  <th className="px-4 py-3 text-left font-medium">Token</th>
                  <th className="px-4 py-3 text-right font-medium">
                    Total Claims
                  </th>
                  <th className="px-4 py-3 text-right font-medium">
                    Total Amount
                  </th>
                  <th className="px-4 py-3 text-left font-medium">
                    Converted to Stable
                  </th>
                  <th className="px-4 py-3 text-right font-medium">
                    Total Stable Amount
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {rows.map((row) => (
                  <tr key={row.symbol}>
                    <td className="px-4 py-3 font-medium text-[var(--foreground)]">
                      {row.symbol}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {row.claimCount}{" "}
                      <span className="text-[var(--muted)]">
                        {row.claimCount === 1 ? "claim" : "claims"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {formatToken(row.totalAmount)}{" "}
                      <span className="text-[var(--muted)]">{row.symbol}</span>
                    </td>
                    <td className="px-4 py-3 text-[var(--muted)]">
                      {row.converted === "stable"
                        ? "—"
                        : row.converted === "yes"
                          ? "Yes"
                          : "No"}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {row.converted === "stable" || row.stableSum === 0
                        ? "—"
                        : formatUsd(row.stableSum)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

interface MonthlyPerformanceSectionProps {
  rows: MonthRow[];
}

function MonthlyPerformanceSection({ rows }: MonthlyPerformanceSectionProps) {
  return (
    <div className="space-y-3">
      <SectionHeading title="Monthly Performance" />
      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)]">
        {rows.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-[var(--muted)]">
            No claims recorded yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-[var(--border)] text-sm">
              <thead className="bg-[var(--surface-2)] text-[11px] uppercase tracking-wider text-[var(--muted)]">
                <tr>
                  <th className="px-4 py-3 text-left font-medium">Month</th>
                  <th className="px-4 py-3 text-right font-medium">Claims</th>
                  <th className="px-4 py-3 text-right font-medium">
                    Total Fees (USD)
                  </th>
                  <th className="px-4 py-3 text-right font-medium">
                    Positions Active
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {rows.map((row) => (
                  <tr key={row.monthKey}>
                    <td className="px-4 py-3 font-medium text-[var(--foreground)]">
                      {row.monthLabel}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {row.claimCount}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {formatUsd(row.totalFeesUsd)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {row.positionsActive}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

interface SectionHeadingProps {
  title: string;
}

function SectionHeading({ title }: SectionHeadingProps) {
  return (
    <h2 className="text-sm font-semibold tracking-tight text-[var(--foreground)]">
      {title}
    </h2>
  );
}
