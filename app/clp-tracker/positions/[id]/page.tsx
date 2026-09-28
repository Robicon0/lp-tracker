"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { type ReactNode, useMemo, useState } from "react";
import { getClaims, getPositions } from "../../lib/storage";
import { useHydrated } from "../../lib/useHydrated";
import { useLivePositionPrices } from "../../lib/useLivePositionPrices";
import {
  calcClaimTokenTotals,
  calcRangeHealth,
  calcWideRangePercent,
  claimSaleGain,
  computePositionIL,
  getEffectiveDeposited,
  withLiveValues,
  type ILResult,
} from "../../lib/calculations";
import {
  derive,
  formatDateTime24,
  formatPercent,
  formatPrice,
  formatUsd,
  pnlColor,
} from "../../lib/positionFormUtils";
import {
  Metric,
  RangeBadge,
  RangeBar,
  TxLinkBadge,
} from "../../components/PositionDisplay";
import { OutOfRangeBox } from "../../components/PositionFormModal";
import {
  HYPOTHETICAL_DIM,
  HypotheticalNotice,
} from "../../components/Hypothetical";
import {
  ClaimTokenTotalsFooter,
  TxCell,
  compareClaimsByDateDesc,
  formatDateDDMMYYYY,
  formatToken,
} from "../../components/ClaimDisplay";
import {
  PositionActionHost,
  type ModalState,
} from "../../components/PositionActions";
import type { FeeClaim, Position } from "../../lib/types";

// Full detail for ONE position, open or closed. Every figure comes from the
// same helpers the Positions list uses (derive, withLiveValues, the live-price
// hook with the list's resolution order), every claim from the same filter +
// sort the Fee Claims page uses, and every action from the same
// PositionActionHost — so nothing here can disagree with the list.
export default function PositionDetailPage() {
  const params = useParams<{ id: string }>();
  const id = decodeURIComponent(String(params?.id ?? ""));
  const router = useRouter();
  const [positions, setPositions] = useState<Position[]>([]);
  const [claims, setClaims] = useState<FeeClaim[]>([]);
  const [modal, setModal] = useState<ModalState>({ kind: "none" });

  const reload = () => {
    setPositions(getPositions());
    setClaims(getClaims());
  };
  const hydrated = useHydrated(reload);

  // Same live valuation as the list: manual price override, else the fetched
  // base/quote ratio; closed positions pass through with their stored value.
  const { pairPriceById } = useLivePositionPrices(positions);
  const livePositions = useMemo(
    () => withLiveValues(positions, pairPriceById),
    [positions, pairPriceById],
  );
  const row = useMemo(() => {
    const p = livePositions.find((x) => x.id === id);
    return p ? derive([p], claims)[0] : null;
  }, [livePositions, claims, id]);

  // The Fee Claims page's Position filter (c.positionId === id) and its sort.
  const positionClaims = useMemo(
    () => claims.filter((c) => c.positionId === id).sort(compareClaimsByDateDesc),
    [claims, id],
  );
  const claimTotals = useMemo(
    () => calcClaimTokenTotals(positionClaims),
    [positionClaims],
  );

  if (!hydrated) {
    return <p className="text-sm text-[var(--muted)]">Loading position…</p>;
  }

  if (!row) {
    return (
      <section className="space-y-4">
        <BackLink />
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-5 py-10 text-center">
          <h1 className="text-lg font-semibold">Position not found</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            No position with this id exists in this browser&apos;s data — it may
            have been deleted.
          </p>
          <Link
            href="/clp-tracker/positions"
            className="mt-4 inline-flex h-9 items-center rounded-md bg-[var(--accent-solid)] px-4 text-sm font-medium text-white hover:bg-[var(--accent-solid)]/90"
          >
            Back to positions
          </Link>
        </div>
      </section>
    );
  }

  const { position, deposited, claimed, fees, days, apr, priceDiff, profit, saleGain } =
    row;
  const isActive = position.status === "active";
  const health = calcRangeHealth(
    pairPriceById.get(position.id) ?? null,
    position.bottomRange,
    position.topRange,
  );
  const wideRange = calcWideRangePercent(position.bottomRange, position.topRange);

  return (
    <section className="space-y-6">
      <BackLink />

      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{position.pair}</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            {position.chain} · {position.protocol}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-[var(--muted)]">
            {isActive ? (
              <>
                <StatusPill label="Open" tone="open" />
                {health.status !== "unknown" ? (
                  <RangeBadge status={health.status} />
                ) : (
                  <span className="uppercase tracking-wider">Price needed</span>
                )}
              </>
            ) : (
              <StatusPill label="Closed" tone="closed" />
            )}
            {position.txLink && (
              <span className="inline-flex items-center gap-1" data-tx="open">
                Opening tx <TxLinkBadge value={position.txLink} />
              </span>
            )}
            {position.closeTxLink && (
              <span className="inline-flex items-center gap-1" data-tx="close">
                Closing tx <TxLinkBadge value={position.closeTxLink} />
              </span>
            )}
          </div>
        </div>
        <ActionRow
          isActive={isActive}
          onEdit={() => setModal({ kind: "edit", position })}
          onUpdate={() => setModal({ kind: "update", position })}
          onClaim={() => setModal({ kind: "claim", position })}
          onClose={() => setModal({ kind: "close", position })}
          onDelete={() => setModal({ kind: "delete", position })}
        />
      </header>

      <Panel title="Position">
        {isActive && health.status !== "unknown" && (
          <div className="mb-4">
            <RangeBar
              health={health}
              entryPrice={position.entryPrice}
              rangeDown={position.bottomRange}
              rangeUp={position.topRange}
            />
          </div>
        )}
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-4">
          <Metric label="Deposited" value={formatUsd(deposited)} />
          <Metric label="Current" value={formatUsd(position.currentBalance)} />
          <Metric
            label="Profit"
            value={formatUsd(profit)}
            tone={`font-medium ${pnlColor(profit)}`}
          />
          <Metric label="Total Fees" value={formatUsd(fees)} />
          <Metric label="Fee APR" value={formatPercent(apr)} />
          <Metric label="Days Active" value={days.toFixed(1)} />
          <Metric label="New Fees" value={formatUsd(position.newFees)} />
          <Metric label="Fees Earned" value={formatUsd(claimed)} />
          {Math.abs(saleGain) >= 0.005 && (
            <Metric
              label="After Selling"
              value={formatUsd(claimed + saleGain)}
              tone={`font-medium ${pnlColor(saleGain)}`}
            />
          )}
          <Metric
            label="Price Diff"
            value={formatUsd(priceDiff)}
            tone={`font-medium ${pnlColor(priceDiff)}`}
          />
          <Metric label="Entry Price" value={formatPrice(position.entryPrice)} />
          <Metric label="Entry Date" value={formatDateTime24(position.entryDatetime)} />
          <Metric
            label="Range"
            value={`${formatPrice(position.bottomRange)} – ${formatPrice(position.topRange)}`}
          />
          <Metric
            label="Range %"
            value={wideRange > 0 ? formatPercent(wideRange) : "—"}
          />
          <Metric
            label={`${position.token1Symbol || "Token 1"} Deposited`}
            value={`${formatToken(position.token1Count)} ${position.token1Symbol}`.trim()}
          />
          <Metric
            label={`${position.token2Symbol || "Token 2"} Deposited`}
            value={`${formatToken(position.token2Count)} ${position.token2Symbol}`.trim()}
          />
        </dl>
        {position.notes.trim() !== "" && (
          <div className="mt-4 border-t border-[var(--border)] pt-3">
            <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--muted)]">
              Notes
            </div>
            <p className="mt-1 whitespace-pre-wrap text-sm text-[var(--foreground)]">
              {position.notes}
            </p>
          </div>
        )}
      </Panel>

      {!isActive && <ClosedPanel position={position} deposited={deposited} />}

      <Panel title={`Fee Claims (${positionClaims.length})`} flush>
        {positionClaims.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-[var(--muted)]">
            No fee claims recorded for this position.
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-[var(--border)] text-sm">
                <thead className="bg-[var(--surface-2)] text-[11px] uppercase tracking-wider text-[var(--muted)]">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium">Date</th>
                    <th className="px-4 py-3 text-right font-medium">Token 1</th>
                    <th className="px-4 py-3 text-right font-medium">Token 2</th>
                    <th className="px-4 py-3 text-left font-medium">Converted</th>
                    <th className="px-4 py-3 text-right font-medium">Claim USD Value</th>
                    <th className="px-4 py-3 text-left font-medium">Sale</th>
                    <th className="px-4 py-3 text-left font-medium">Tx</th>
                    <th className="px-4 py-3 text-left font-medium">Notes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {positionClaims.map((claim) => (
                    <tr key={claim.id} data-claim-row={claim.id}>
                      <td className="px-4 py-3 tabular-nums text-[var(--muted)]">
                        {formatDateDDMMYYYY(claim.date)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {formatToken(claim.token1Amount)}{" "}
                        <span className="text-[var(--muted)]">{claim.token1Symbol}</span>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {formatToken(claim.token2Amount)}{" "}
                        <span className="text-[var(--muted)]">{claim.token2Symbol}</span>
                      </td>
                      <td className="px-4 py-3 text-[var(--muted)]">
                        {claim.convertedToStable
                          ? `Yes — ${claim.stableSymbol ?? ""}`.trim()
                          : "No"}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {claim.stableAmount !== null ? formatUsd(claim.stableAmount) : "—"}
                      </td>
                      <td className="px-4 py-3 text-[12px]">
                        <SaleCell claim={claim} />
                      </td>
                      <td className="px-4 py-3 text-[var(--muted)]">
                        <ClaimTx value={claim.txId ?? null} />
                      </td>
                      <td className="max-w-[16rem] px-4 py-3 text-[12px] text-[var(--muted)]">
                        {claim.notes?.trim() ? claim.notes : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ClaimTokenTotalsFooter
              totals={claimTotals}
              claimCount={positionClaims.length}
            />
          </>
        )}
      </Panel>

      <PositionActionHost
        modal={modal}
        positions={positions}
        claims={claims}
        onChanged={reload}
        onDismiss={() => setModal({ kind: "none" })}
        onDeleted={() => router.push("/clp-tracker/positions")}
      />
    </section>
  );
}

function BackLink() {
  return (
    <Link
      href="/clp-tracker/positions"
      className="inline-flex text-sm text-[var(--muted)] hover:text-[var(--foreground)]"
    >
      ← Back to positions
    </Link>
  );
}

function StatusPill({ label, tone }: { label: string; tone: "open" | "closed" }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ring-1 ring-inset ${
        tone === "open"
          ? "bg-emerald-500/10 text-emerald-300 ring-emerald-500/30"
          : "bg-[var(--surface-2)] text-[var(--muted)] ring-[var(--border-strong)]"
      }`}
    >
      {label}
    </span>
  );
}

function Panel({
  title,
  children,
  flush,
}: {
  title: string;
  children: ReactNode;
  flush?: boolean;
}) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)]">
      <h2 className="border-b border-[var(--border)] px-5 py-3 text-sm font-semibold tracking-tight">
        {title}
      </h2>
      <div className={flush ? "" : "px-5 py-4"}>{children}</div>
    </div>
  );
}

// Same buttons, same tones and the same Update/Close-only-when-active rule as
// the Positions list card.
function ActionRow({
  isActive,
  onEdit,
  onUpdate,
  onClaim,
  onClose,
  onDelete,
}: {
  isActive: boolean;
  onEdit: () => void;
  onUpdate: () => void;
  onClaim: () => void;
  onClose: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      <button
        type="button"
        onClick={onEdit}
        className="rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)] px-3 py-1.5 text-xs font-medium text-[var(--foreground)] hover:bg-[var(--surface-2)]/70"
      >
        Edit
      </button>
      {isActive && (
        <button
          type="button"
          onClick={onUpdate}
          className="rounded-md border border-[var(--accent)]/40 bg-[var(--accent)]/10 px-3 py-1.5 text-xs font-medium text-[var(--accent)] hover:bg-[var(--accent)]/20"
        >
          Update
        </button>
      )}
      <button
        type="button"
        onClick={onClaim}
        className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-300 hover:bg-emerald-500/20"
      >
        Claim
      </button>
      {isActive && (
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-1.5 text-xs font-medium text-rose-300 hover:bg-rose-500/20"
        >
          Close
        </button>
      )}
      <button
        type="button"
        onClick={onDelete}
        className="rounded-md border border-rose-500/40 px-3 py-1.5 text-xs font-medium text-rose-300 hover:bg-rose-500/10"
      >
        Delete
      </button>
    </div>
  );
}

// Out-of-range projections, computed the way Pool P&L does: live through the
// shared computePositionIL, falling back to the stored snapshot only when the
// record can't be computed. The stored fields are written on every save and
// may hold stale math, so they are never read first.
function outOfRange(p: Position, side: "up" | "down"): {
  il: ILResult | null;
  value: number | null;
} {
  const il = computePositionIL(
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
  const stored = side === "up" ? p.outOfRangeUpside : p.outOfRangeDownside;
  return { il, value: il ? il.lpValue : stored };
}

function ClosedPanel({
  position: p,
  deposited,
}: {
  position: Position;
  deposited: number;
}) {
  // Hedge fields, each shown only when THIS position actually has a value.
  const hedge: { label: string; value: string; tone?: string }[] = [];
  const addUsd = (label: string, v: number | null, signed = false) => {
    if (v === null || v === undefined || !Number.isFinite(v)) return;
    hedge.push({
      label,
      value: formatUsd(v),
      tone: signed ? `font-medium ${pnlColor(v)}` : undefined,
    });
  };
  if (p.shortDateStart) {
    hedge.push({ label: "Short Start", value: formatDateTime24(p.shortDateStart) });
  }
  if (p.shortDateEnd) {
    hedge.push({ label: "Short End", value: formatDateTime24(p.shortDateEnd) });
  }
  if (p.shortTokenAmount !== null && Number.isFinite(p.shortTokenAmount)) {
    hedge.push({ label: "Short Token Amount", value: formatToken(p.shortTokenAmount) });
  }
  addUsd("Short USD Amount", p.shortUsdAmount);
  addUsd("Short Gain", p.shortGain, true);
  addUsd("Short Loss", p.shortLoss, true);
  addUsd("Short Funding Fees", p.shortFundingFees, true);
  addUsd("Short Total", p.shortTotal, true);

  const up = outOfRange(p, "up");
  const down = outOfRange(p, "down");
  const showOor = up.value !== null || down.value !== null;

  return (
    <Panel title="Closed">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-4">
        <Metric label="Exit Date" value={formatDateTime24(p.exitDatetime)} />
        <Metric
          label="Scalp"
          value={formatUsd(p.scalp ?? 0)}
          tone={`font-medium ${pnlColor(p.scalp ?? 0)}`}
        />
        <div className="col-span-2">
          <dt className="text-[10px] font-medium uppercase tracking-wider text-[var(--muted)]">
            Closing Transaction
          </dt>
          <dd className="mt-0.5 text-sm" data-close-tx>
            {p.closeTxLink ? (
              /^https?:\/\//i.test(p.closeTxLink) ? (
                <a
                  href={p.closeTxLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="break-all text-[var(--accent)] hover:underline"
                >
                  {p.closeTxLink} ↗
                </a>
              ) : (
                <span className="select-all break-all font-mono text-xs">
                  {p.closeTxLink}
                </span>
              )
            ) : (
              <span className="text-[var(--muted)]">Not recorded</span>
            )}
          </dd>
        </div>
      </dl>

      {(hedge.length > 0 || p.shortNotes) && (
        <div className="mt-4 border-t border-[var(--border)] pt-3">
          <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-[var(--muted)]">
            Hedge / Short
          </div>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
            {hedge.map((h) => (
              <Metric key={h.label} label={h.label} value={h.value} tone={h.tone} />
            ))}
          </dl>
          {p.shortNotes && (
            <p className="mt-2 whitespace-pre-wrap text-[12px] text-[var(--muted)]">
              {p.shortNotes}
            </p>
          )}
        </div>
      )}

      {showOor && (
        <div className="mt-4 border-t border-[var(--border)] pt-3">
          {/* A closed position's range-exit values are scenarios, not money it
              made — presented exactly as the Edit form presents them for a
              closed position. */}
          <HypotheticalNotice />
          <div className={`mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 ${HYPOTHETICAL_DIM}`}>
            {up.value !== null && (
              <OutOfRangeBox
                label="Out of Range — Upside"
                il={up.il}
                profit={up.value - deposited}
                baseSymbol={p.token1Symbol}
                quoteSymbol={p.token2Symbol}
              />
            )}
            {down.value !== null && (
              <OutOfRangeBox
                label="Out of Range — Downside"
                il={down.il}
                profit={down.value - deposited}
                baseSymbol={p.token1Symbol}
                quoteSymbol={p.token2Symbol}
              />
            )}
          </div>
        </div>
      )}
    </Panel>
  );
}

function SaleCell({ claim }: { claim: FeeClaim }) {
  if (claim.sale === undefined) return <span className="text-[var(--muted)]">—</span>;
  const gain = claimSaleGain(claim);
  return (
    <div className="space-y-0.5 tabular-nums">
      <div>
        Sold {formatToken(claim.sale.quantity)} @ {formatUsd(claim.sale.pricePerToken)}
      </div>
      <div className="text-[var(--muted)]">
        {claim.sale.date ? formatDateDDMMYYYY(claim.sale.date) : "date not recorded"} ·
        proceeds {formatUsd(claim.sale.proceeds)}
      </div>
      <div className={pnlColor(gain)}>
        {gain >= 0 ? "+" : ""}
        {formatUsd(gain)} vs claim time
      </div>
    </div>
  );
}

// A URL opens exactly as the Fee Claims page's Tx cell does; anything else is
// shown in full and selectable, so a bare hash can be copied.
function ClaimTx({ value }: { value: string | null }) {
  if (!value) return <span>—</span>;
  if (/^https?:\/\//i.test(value)) return <TxCell value={value} />;
  return (
    <span className="select-all break-all font-mono text-xs" title={value}>
      {value}
    </span>
  );
}
