"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { getClaims, getPositions } from "../lib/storage";
import {
  calcTokenPnL,
  withLiveValues,
  computePositionIL,
  getEffectiveDeposited,
  type ILResult,
  type TokenPnLRow,
} from "../lib/calculations";
import {
  HYPOTHETICAL_DIM,
  HypotheticalNotice,
  HypotheticalTag,
} from "../components/Hypothetical";
import { useLivePositionPrices } from "../lib/useLivePositionPrices";
import { useHydrated } from "../lib/useHydrated";
import type { FeeClaim, Position } from "../lib/types";

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

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

function pnlColor(value: number): string {
  if (value > 0) return "text-emerald-400";
  if (value < 0) return "text-rose-400";
  return "text-[var(--foreground)]";
}

interface DerivedPosition {
  position: Position;
  deposited: number;
  lpProfit: number;
  shortTotal: number | null;
  netPnl: number;
  upsideIL: ILResult | null;
  downsideIL: ILResult | null;
  upsideProfit: number | null;
  downsideProfit: number | null;
}

// Delegates to the shared computePositionIL in lib/calculations
// (Invariant #6 — one IL source of truth across pages). Position naming:
// token1 = base token (calcIL token0), token2 = quote token (calcIL token1).
function computeIL(p: Position, side: "down" | "up"): ILResult | null {
  return computePositionIL(
    {
      entryPrice: p.entryPrice,
      rangeDown: p.bottomRange,
      rangeUp: p.topRange,
      deposited: getEffectiveDeposited(p),
      token0Count: p.token1Count,
      token1Count: p.token2Count,
    },
    side === "down" ? p.bottomRange : p.topRange,
  );
}

function derive(positions: Position[]): DerivedPosition[] {
  return positions.map((position) => {
    const deposited = getEffectiveDeposited(position);
    const lpProfit = position.currentBalance - deposited;
    const shortTotal = position.shortTotal;
    const netPnl = lpProfit + (shortTotal ?? 0);
    // Prefer live recomputation; fall back to the stored snapshot (which
    // may hold stale pre-fix math) only when the record can't be computed.
    const upsideIL = computeIL(position, "up");
    const downsideIL = computeIL(position, "down");
    const upsideValue = upsideIL ? upsideIL.lpValue : position.outOfRangeUpside;
    const downsideValue = downsideIL
      ? downsideIL.lpValue
      : position.outOfRangeDownside;
    const upsideProfit =
      upsideValue === null ? null : upsideValue - deposited;
    const downsideProfit =
      downsideValue === null ? null : downsideValue - deposited;
    return {
      position,
      deposited,
      lpProfit,
      shortTotal,
      netPnl,
      upsideIL,
      downsideIL,
      upsideProfit,
      downsideProfit,
    };
  });
}

type StatusFilter = "all" | "active" | "closed";

export default function PoolPnlPage() {
  const [positions, setPositions] = useState<Position[]>([]);
  const [claims, setClaims] = useState<FeeClaim[]>([]);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const hydrated = useHydrated(() => {
    setPositions(getPositions());
    setClaims(getClaims());
  });

  // Active positions at live market value, same helper and same price
  // resolution as the Positions page and Dashboard (Invariant #6 — these
  // figures appear on more than one page and may not disagree).
  const { pairPriceById } = useLivePositionPrices(positions);
  const livePositions = useMemo(
    () => withLiveValues(positions, pairPriceById),
    [positions, pairPriceById],
  );

  const tokenRows = useMemo(
    () => (hydrated ? calcTokenPnL(livePositions, claims) : []),
    [hydrated, livePositions, claims],
  );

  // The single filtered set the whole page describes. Both the table and the
  // summary cards read from this — computing totals over raw `positions`
  // instead was the bug where the cards ignored the Active/Closed toggle and
  // Pool P&L's Net P&L could disagree with the Sidebar's (Invariant #6).
  const filteredPositions = useMemo(
    () =>
      hydrated
        ? livePositions.filter((p) =>
            statusFilter === "all" ? true : p.status === statusFilter,
          )
        : [],
    [hydrated, livePositions, statusFilter],
  );

  const rows = useMemo(() => {
    const sorted = [...filteredPositions].sort((a, b) => {
      const ta = new Date(a.entryDatetime).getTime();
      const tb = new Date(b.entryDatetime).getTime();
      return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
    });
    return derive(sorted);
  }, [filteredPositions]);

  const totals = useMemo(() => {
    let invested = 0;
    let currentValue = 0;
    let lpPnl = 0;
    let shortPnl = 0;
    for (const p of filteredPositions) {
      const deposited = getEffectiveDeposited(p);
      invested += deposited;
      currentValue += p.currentBalance;
      lpPnl += p.currentBalance - deposited;
      if (p.shortTotal !== null && Number.isFinite(p.shortTotal)) {
        shortPnl += p.shortTotal;
      }
    }
    return {
      invested,
      currentValue,
      lpPnl,
      shortPnl,
      netPnl: lpPnl + shortPnl,
    };
  }, [filteredPositions]);

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <section className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Pool P&amp;L</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Profit and loss breakdown per LP position.
        </p>
      </header>

      <p className="-mt-4 text-xs text-[var(--muted)]">
        These totals reflect whichever filter is selected below — All, Active,
        or Closed —{" "}
        <span className="text-[var(--foreground)]">
          currently {statusFilter === "all" ? "All" : statusFilter === "active" ? "Active" : "Closed"}
        </span>
        . They change when you switch it.
      </p>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <SummaryStat label="Total Invested" value={formatUsd(totals.invested)} />
        <SummaryStat
          label="Total Current Value"
          value={formatUsd(totals.currentValue)}
        />
        <SummaryStat
          label="Total LP P&L"
          value={formatUsd(totals.lpPnl)}
          valueClass={pnlColor(totals.lpPnl)}
        />
        <SummaryStat
          label="Total Short P&L"
          value={formatUsd(totals.shortPnl)}
          valueClass={pnlColor(totals.shortPnl)}
        />
        <SummaryStat
          label="Net P&L"
          value={formatUsd(totals.netPnl)}
          valueClass={pnlColor(totals.netPnl)}
        />
      </div>

      {tokenRows.length > 0 && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)]">
          <div className="border-b border-[var(--border)] px-5 py-4">
            <h2 className="text-sm font-semibold tracking-tight">By Token</h2>
            <p className="mt-0.5 text-xs text-[var(--muted)]">
              Positions grouped by base token. Realized = closed positions,
              Unrealized = active positions — price movement only. Fees are
              shown separately and not included in Net P&amp;L.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-[var(--border)] text-sm">
              <thead className="bg-[var(--surface-2)] text-[11px] uppercase tracking-wider text-[var(--muted)]">
                <tr>
                  <th className="px-4 py-3 text-left font-medium">Token</th>
                  <th className="px-4 py-3 text-right font-medium">Positions</th>
                  <th className="px-4 py-3 text-right font-medium">
                    Unrealized P&L
                  </th>
                  <th className="px-4 py-3 text-right font-medium">
                    Realized P&L
                  </th>
                  <th className="px-4 py-3 text-right font-medium">Short P&L</th>
                  <th className="px-4 py-3 text-right font-medium">Net P&L</th>
                  <th className="px-4 py-3 text-right font-medium">Fees (info)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {tokenRows.map((row) => (
                  <TokenRow key={row.token} row={row} />
                ))}
              </tbody>
              <tfoot className="border-t border-[var(--border-strong)] bg-[var(--surface-2)]/60">
                <TokenTotalsRow rows={tokenRows} />
              </tfoot>
            </table>
          </div>
        </div>
      )}

      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)]">
        <div className="flex flex-col gap-3 border-b border-[var(--border)] px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-sm font-semibold tracking-tight">By Position</h2>
          <StatusFilterToggle value={statusFilter} onChange={setStatusFilter} />
        </div>

        {rows.length === 0 ? (
          positions.length === 0 ? (
            <div className="px-6 py-14 text-center">
              <EmptyIcon />
              <h3 className="mt-3 text-base font-semibold tracking-tight text-[var(--foreground)]">
                No positions yet
              </h3>
              <p className="mx-auto mt-1.5 max-w-sm text-sm text-[var(--muted)]">
                Add an LP position to see your Pool P&amp;L breakdown.
              </p>
              <Link
                href="/clp-tracker/positions"
                className="mt-4 inline-flex h-9 items-center justify-center rounded-md bg-[var(--accent-solid)] px-4 text-sm font-medium text-white shadow-sm transition-colors hover:bg-[var(--accent-solid)]/90"
              >
                Go to Positions
              </Link>
            </div>
          ) : (
            <div className="px-5 py-10 text-center text-sm text-[var(--muted)]">
              No positions match the current filter.
            </div>
          )
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-[var(--border)] text-sm">
              <thead className="bg-[var(--surface-2)] text-[11px] uppercase tracking-wider text-[var(--muted)]">
                <tr>
                  <th className="w-8 px-2 py-3" aria-label="Expand" />
                  <th className="px-4 py-3 text-left font-medium">Pair</th>
                  <th className="px-4 py-3 text-left font-medium">Chain</th>
                  <th className="px-4 py-3 text-left font-medium">Protocol</th>
                  <th className="px-4 py-3 text-right font-medium">Deposited</th>
                  <th className="px-4 py-3 text-right font-medium">
                    Current Value
                  </th>
                  <th className="px-4 py-3 text-right font-medium">LP P&L</th>
                  <th className="px-4 py-3 text-right font-medium">Short P&L</th>
                  <th className="px-4 py-3 text-right font-medium">Net P&L</th>
                  <th className="px-4 py-3 text-right font-medium">OOR Upside</th>
                  <th className="px-4 py-3 text-right font-medium">
                    OOR Downside
                  </th>
                  <th className="px-4 py-3 text-left font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {rows.map((row) => {
                  const isOpen = expanded.has(row.position.id);
                  return (
                    <PositionRow
                      key={row.position.id}
                      row={row}
                      isOpen={isOpen}
                      onToggle={() => toggleExpanded(row.position.id)}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

interface TokenRowProps {
  row: TokenPnLRow;
}

function TokenRow({ row }: TokenRowProps) {
  const positionsLabel = [
    row.activeCount > 0 ? `${row.activeCount} active` : null,
    row.closedCount > 0 ? `${row.closedCount} closed` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <tr>
      <td className="px-4 py-3 font-medium text-[var(--foreground)]">
        {row.token}
      </td>
      <td className="px-4 py-3 text-right text-[var(--muted)]">
        {positionsLabel || "—"}
      </td>
      <td
        className={`px-4 py-3 text-right tabular-nums ${
          row.activeCount === 0 ? "text-[var(--muted)]" : pnlColor(row.unrealized)
        }`}
      >
        {row.activeCount === 0 ? "—" : formatUsd(row.unrealized)}
      </td>
      <td
        className={`px-4 py-3 text-right tabular-nums ${
          row.closedCount === 0 ? "text-[var(--muted)]" : pnlColor(row.realized)
        }`}
      >
        {row.closedCount === 0 ? "—" : formatUsd(row.realized)}
      </td>
      <td
        className={`px-4 py-3 text-right tabular-nums ${
          row.shortPnl === 0 ? "text-[var(--muted)]" : pnlColor(row.shortPnl)
        }`}
      >
        {row.shortPnl === 0 ? "—" : formatUsd(row.shortPnl)}
      </td>
      <td
        className={`px-4 py-3 text-right tabular-nums font-semibold ${pnlColor(row.netPnl)}`}
      >
        {formatUsd(row.netPnl)}
      </td>
      <td className="px-4 py-3 text-right tabular-nums text-[var(--muted)]">
        {formatUsd(row.fees)}
      </td>
    </tr>
  );
}

interface TokenTotalsRowProps {
  rows: TokenPnLRow[];
}

function TokenTotalsRow({ rows }: TokenTotalsRowProps) {
  let active = 0;
  let closed = 0;
  let unrealized = 0;
  let realized = 0;
  let shortPnl = 0;
  let netPnl = 0;
  let fees = 0;
  for (const r of rows) {
    active += r.activeCount;
    closed += r.closedCount;
    unrealized += r.unrealized;
    realized += r.realized;
    shortPnl += r.shortPnl;
    netPnl += r.netPnl;
    fees += r.fees;
  }
  return (
    <tr className="text-sm font-semibold">
      <td className="px-4 py-3 text-[var(--foreground)]">Total</td>
      <td className="px-4 py-3 text-right text-[var(--muted)]">
        {active} active · {closed} closed
      </td>
      <td className={`px-4 py-3 text-right tabular-nums ${pnlColor(unrealized)}`}>
        {formatUsd(unrealized)}
      </td>
      <td className={`px-4 py-3 text-right tabular-nums ${pnlColor(realized)}`}>
        {formatUsd(realized)}
      </td>
      <td className={`px-4 py-3 text-right tabular-nums ${pnlColor(shortPnl)}`}>
        {formatUsd(shortPnl)}
      </td>
      <td className={`px-4 py-3 text-right tabular-nums ${pnlColor(netPnl)}`}>
        {formatUsd(netPnl)}
      </td>
      <td className="px-4 py-3 text-right tabular-nums text-[var(--muted)]">
        {formatUsd(fees)}
      </td>
    </tr>
  );
}

interface SummaryStatProps {
  label: string;
  value: string;
  valueClass?: string;
}

function SummaryStat({ label, value, valueClass }: SummaryStatProps) {
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
    </div>
  );
}

interface StatusFilterToggleProps {
  value: StatusFilter;
  onChange: (next: StatusFilter) => void;
}

function StatusFilterToggle({ value, onChange }: StatusFilterToggleProps) {
  const options: Array<{ value: StatusFilter; label: string }> = [
    { value: "all", label: "All" },
    { value: "active", label: "Active" },
    { value: "closed", label: "Closed" },
  ];
  return (
    <div
      role="radiogroup"
      aria-label="Filter by status"
      className="inline-flex overflow-hidden rounded-md border border-[var(--border-strong)]"
    >
      {options.map((opt, idx) => {
        const selected = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(opt.value)}
            className={`h-8 px-4 text-xs font-medium transition-colors ${
              idx > 0 ? "border-l border-[var(--border-strong)]" : ""
            } ${
              selected
                ? "bg-[var(--accent-solid)] text-white"
                : "bg-[var(--surface-2)] text-[var(--muted)] hover:bg-[var(--surface-2)]/70"
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

interface PositionRowProps {
  row: DerivedPosition;
  isOpen: boolean;
  onToggle: () => void;
}

function PositionRow({ row, isOpen, onToggle }: PositionRowProps) {
  const { position, deposited, lpProfit, shortTotal, netPnl, upsideIL, downsideIL, upsideProfit, downsideProfit } =
    row;
  // Live recomputation is the source of truth; the stored snapshot is only
  // a fallback for records the live math can't compute (and may hold stale
  // pre-fix values).
  const oorUp = upsideIL ? upsideIL.lpValue : position.outOfRangeUpside;
  const oorDown = downsideIL
    ? downsideIL.lpValue
    : position.outOfRangeDownside;
  // Projections stay visible on a closed row but step back visually, so the
  // real Net P&L beside them reads as the answer.
  const rowIsClosed = position.status === "closed";
  return (
    <>
      <tr
        className="cursor-pointer transition-colors hover:bg-[var(--surface-2)]/60"
        onClick={onToggle}
        aria-expanded={isOpen}
      >
        <td className="w-8 px-2 py-3 text-center text-[var(--muted)]" aria-hidden>
          {isOpen ? "▾" : "▸"}
        </td>
        <td className="px-4 py-3 font-medium text-[var(--foreground)]">
          {position.pair}
        </td>
        <td className="px-4 py-3 text-[var(--muted)]">{position.chain}</td>
        <td className="px-4 py-3 text-[var(--muted)]">{position.protocol}</td>
        <td className="px-4 py-3 text-right tabular-nums">
          {formatUsd(deposited)}
        </td>
        <td className="px-4 py-3 text-right tabular-nums">
          {formatUsd(position.currentBalance)}
        </td>
        <td
          className={`px-4 py-3 text-right tabular-nums font-medium ${pnlColor(lpProfit)}`}
        >
          {formatUsd(lpProfit)}
        </td>
        <td
          className={`px-4 py-3 text-right tabular-nums font-medium ${
            shortTotal === null ? "text-[var(--muted)]" : pnlColor(shortTotal)
          }`}
        >
          {shortTotal === null ? "—" : formatUsd(shortTotal)}
        </td>
        <td
          className={`px-4 py-3 text-right tabular-nums font-medium ${pnlColor(netPnl)}`}
        >
          {formatUsd(netPnl)}
        </td>
        <td
          className={`px-4 py-3 text-right tabular-nums ${
            rowIsClosed ? HYPOTHETICAL_DIM : ""
          }`}
        >
          {oorUp === null || upsideProfit === null ? (
            <span className="text-[var(--muted)]">—</span>
          ) : (
            <div>
              <div>{formatUsd(oorUp)}</div>
              <div
                className={`text-[11px] font-medium ${pnlColor(upsideProfit)}`}
              >
                {formatUsd(upsideProfit)}
              </div>
              {rowIsClosed && <HypotheticalTag className="mt-1" />}
            </div>
          )}
        </td>
        <td
          className={`px-4 py-3 text-right tabular-nums ${
            rowIsClosed ? HYPOTHETICAL_DIM : ""
          }`}
        >
          {oorDown === null || downsideProfit === null ? (
            <span className="text-[var(--muted)]">—</span>
          ) : (
            <div>
              <div>{formatUsd(oorDown)}</div>
              <div
                className={`text-[11px] font-medium ${pnlColor(downsideProfit)}`}
              >
                {formatUsd(downsideProfit)}
              </div>
              {rowIsClosed && <HypotheticalTag className="mt-1" />}
            </div>
          )}
        </td>
        <td className="px-4 py-3">
          {position.status === "active" ? (
            <span className="inline-flex items-center rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider text-emerald-400 ring-1 ring-inset ring-emerald-500/20">
              ACTIVE
            </span>
          ) : (
            <span className="inline-flex items-center rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider text-[var(--muted)] ring-1 ring-inset ring-[var(--border-strong)]">
              CLOSED
            </span>
          )}
        </td>
      </tr>
      {isOpen && (
        <tr className="bg-[var(--surface-2)]/40">
          <td />
          <td colSpan={11} className="px-4 py-5">
            <ExpandedDetail row={row} />
          </td>
        </tr>
      )}
    </>
  );
}

interface ExpandedDetailProps {
  row: DerivedPosition;
}

function ExpandedDetail({ row }: ExpandedDetailProps) {
  const { position, shortTotal, upsideIL, downsideIL, upsideProfit, downsideProfit } =
    row;
  const isClosed = position.status === "closed";

  const hasShort =
    position.shortDateStart !== null ||
    position.shortDateEnd !== null ||
    position.shortTokenAmount !== null ||
    position.shortUsdAmount !== null ||
    position.shortGain !== null ||
    position.shortLoss !== null ||
    position.shortFundingFees !== null ||
    shortTotal !== null;

  const netUpside =
    upsideProfit === null ? null : (shortTotal ?? 0) + upsideProfit;
  const netDownside =
    downsideProfit === null ? null : (shortTotal ?? 0) + downsideProfit;

  return (
    <div className="space-y-6">
      <DetailSection title="Short Position Details">
        {hasShort ? (
          <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
            <DetailItem
              label="Open Date"
              value={formatDate(position.shortDateStart)}
            />
            <DetailItem
              label="Close Date"
              value={formatDate(position.shortDateEnd)}
            />
            <DetailItem
              label="Token Amount"
              value={
                position.shortTokenAmount === null
                  ? "—"
                  : formatToken(position.shortTokenAmount)
              }
            />
            <DetailItem
              label="USD Amount"
              value={
                position.shortUsdAmount === null
                  ? "—"
                  : formatUsd(position.shortUsdAmount)
              }
            />
            <DetailItem
              label="Gain"
              value={
                position.shortGain === null
                  ? "—"
                  : formatUsd(position.shortGain)
              }
              tone={
                position.shortGain === null ? undefined : pnlColor(position.shortGain)
              }
            />
            <DetailItem
              label="Loss"
              value={
                position.shortLoss === null
                  ? "—"
                  : formatUsd(position.shortLoss)
              }
              tone={
                position.shortLoss === null
                  ? undefined
                  : pnlColor(-Math.abs(position.shortLoss))
              }
            />
            <DetailItem
              label="Funding Fees"
              value={
                position.shortFundingFees === null
                  ? "—"
                  : formatUsd(position.shortFundingFees)
              }
              tone={
                position.shortFundingFees === null
                  ? undefined
                  : pnlColor(position.shortFundingFees)
              }
            />
            <DetailItem
              label="Total P&L"
              value={shortTotal === null ? "—" : formatUsd(shortTotal)}
              tone={shortTotal === null ? undefined : pnlColor(shortTotal)}
            />
            {position.shortNotes && (
              <div className="col-span-2 sm:col-span-4">
                <DetailItem label="Notes" value={position.shortNotes} />
              </div>
            )}
          </div>
        ) : (
          <p className="text-sm text-[var(--muted)]">No short position recorded.</p>
        )}
      </DetailSection>

      <DetailSection title="Out of Range Scenarios">
        {isClosed && <HypotheticalNotice className="mb-4" />}
        <div
          className={`grid grid-cols-1 gap-4 sm:grid-cols-2 ${
            isClosed ? HYPOTHETICAL_DIM : ""
          }`}
        >
          <ScenarioBox
            label="Upside"
            il={upsideIL}
            profit={upsideProfit}
            baseSymbol={position.token1Symbol}
            quoteSymbol={position.token2Symbol}
          />
          <ScenarioBox
            label="Downside"
            il={downsideIL}
            profit={downsideProfit}
            baseSymbol={position.token1Symbol}
            quoteSymbol={position.token2Symbol}
          />
        </div>
        <div
          className={`mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 ${
            isClosed ? HYPOTHETICAL_DIM : ""
          }`}
        >
          <CoverageBox
            label="Net Upside Coverage"
            shortPresent={shortTotal !== null}
            value={netUpside}
            fallback={upsideProfit}
            direction="Upside"
          />
          <CoverageBox
            label="Net Downside Coverage"
            shortPresent={shortTotal !== null}
            value={netDownside}
            fallback={downsideProfit}
            direction="Downside"
          />
        </div>
      </DetailSection>
    </div>
  );
}

interface DetailSectionProps {
  title: string;
  children: React.ReactNode;
}

function DetailSection({ title, children }: DetailSectionProps) {
  return (
    <div>
      <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">
        {title}
      </h3>
      {children}
    </div>
  );
}

interface DetailItemProps {
  label: string;
  value: string;
  tone?: string;
}

function DetailItem({ label, value, tone }: DetailItemProps) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-[var(--muted)]">
        {label}
      </div>
      <div
        className={`text-sm font-medium tabular-nums ${tone ?? "text-[var(--foreground)]"}`}
      >
        {value}
      </div>
    </div>
  );
}

interface ScenarioBoxProps {
  label: string;
  il: ILResult | null;
  profit: number | null;
  baseSymbol: string;
  quoteSymbol: string;
}

function ScenarioBox({
  label,
  il,
  profit,
  baseSymbol,
  quoteSymbol,
}: ScenarioBoxProps) {
  if (il === null || profit === null) {
    return (
      <div className="rounded-md border border-dashed border-[var(--border-strong)] bg-[var(--surface)]/60 p-3">
        <div className="text-[11px] font-medium uppercase tracking-wider text-[var(--muted)]">
          {label}
        </div>
        <div className="mt-2 text-sm text-[var(--muted)]">
          Range/price data missing.
        </div>
      </div>
    );
  }
  const showT0 = il.futureToken0 > 0;
  const showT1 = il.futureToken1 > 0;
  return (
    <div className="rounded-md border border-dashed border-[var(--border-strong)] bg-[var(--surface)]/60 p-3">
      <div className="text-[11px] font-medium uppercase tracking-wider text-[var(--muted)]">
        {label}
      </div>
      <div className="mt-1.5 space-y-1">
        <div className="text-sm font-medium text-[var(--foreground)] tabular-nums">
          {!showT0 && !showT1
            ? "—"
            : (
                <>
                  {showT0 && (
                    <>
                      {formatToken(il.futureToken0)}{" "}
                      <span className="text-[var(--muted)]">
                        {baseSymbol || "—"}
                      </span>
                    </>
                  )}
                  {showT0 && showT1 && " + "}
                  {showT1 && (
                    <>
                      {formatToken(il.futureToken1)}{" "}
                      <span className="text-[var(--muted)]">
                        {quoteSymbol || "—"}
                      </span>
                    </>
                  )}
                </>
              )}
        </div>
        <div className="text-xs text-[var(--muted)] tabular-nums">
          LP Value: {formatUsd(il.lpValue)}
        </div>
        <div className={`text-xs tabular-nums font-medium ${pnlColor(profit)}`}>
          P/L: {formatUsd(profit)}
        </div>
      </div>
    </div>
  );
}

interface CoverageBoxProps {
  label: string;
  shortPresent: boolean;
  value: number | null;
  fallback: number | null;
  direction: "Upside" | "Downside";
}

function CoverageBox({
  label,
  shortPresent,
  value,
  fallback,
  direction,
}: CoverageBoxProps) {
  const showFallback = !shortPresent && fallback !== null;
  const display = shortPresent ? value : fallback;
  const missing = display === null;
  return (
    <div className="rounded-md border border-[var(--border-strong)] bg-[var(--surface)]/60 p-3">
      <div className="text-[11px] font-medium uppercase tracking-wider text-[var(--muted)]">
        {label}
      </div>
      <div
        className={`mt-1.5 text-sm font-semibold tabular-nums ${
          missing ? "text-[var(--muted)]" : pnlColor(display)
        }`}
      >
        {missing
          ? "—"
          : showFallback
            ? `${direction} P&L = ${formatUsd(display)}`
            : `Short P&L + ${direction} = ${formatUsd(display)}`}
      </div>
      <p className="mt-1 text-[11px] text-[var(--muted)]">
        {showFallback
          ? "No short position — showing raw P&L"
          : missing
            ? "Add a short and out-of-range data to see coverage"
            : `short total + out-of-range ${direction.toLowerCase()} profit`}
      </p>
    </div>
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
