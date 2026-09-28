"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useMemo,
  useState,
} from "react";
import {
  getClaims,
  getPositions,
  getPositionPrices,
  getStalePositionDismissals,
  saveStalePositionDismissals,
  savePositionPrices,
} from "../lib/storage";

import {
  findChainMismatches,
  findStalePositions,
  staleDismissalFor,
  type ChainMismatchRow,
  type StalePositionRow,
  STALE_POSITION_DAYS,
} from "../lib/dataHealth";
import {
  normalizeChain,
} from "../lib/nameNormalization";
import {
  calcRangeHealth,
  findSuspectScalpPositions,
  findSymbolPairMismatches,
  calcWideRangePercent,
  withLiveValues,
  type SuspectScalpRow,
  type SymbolPairMismatchRow,
  type RangeHealth,
} from "../lib/calculations";

import {
  useHydrated,
} from "../lib/useHydrated";
import type {
  FeeClaim,
} from "../lib/types";
import type {
  Position,
  StalePositionDismissal,
} from "../lib/types";
import {
  DerivedRow,
  derive,
  formatDateTime24,
  formatPercent,
  formatPrice,
  formatUpdatedAt,
  formatUsd,
  pnlColor,
} from "../lib/positionFormUtils";

import {
  Metric,
  RangeBadge,
  RangeBar,
  TxLinkBadge,
  rangeHealthDetail,
} from "../components/PositionDisplay";
import {
  inputClass,
} from "../components/PositionFormParts";
import {
  PositionActionHost,
  type ModalState,
} from "../components/PositionActions";

const ALL_CHAINS = "__all__";

export default function PositionsPage() {
  const [positions, setPositions] = useState<Position[]>([]);
  const [claims, setClaims] = useState<FeeClaim[]>([]);
  const [modal, setModal] = useState<ModalState>({ kind: "none" });
  const [showClosed, setShowClosed] = useState(false);
  const [view, setView] = useState<"cards" | "list">("cards");
  const [chainFilter, setChainFilter] = useState<string>(ALL_CHAINS);
  const [fetchedPrices, setFetchedPrices] = useState<Record<string, number>>(
    {},
  );
  const [positionPrices, setPositionPrices] = useState<Record<string, number>>(
    {},
  );
  const [staleDismissals, setStaleDismissals] = useState<
    StalePositionDismissal[]
  >([]);
  const [priceUpdatedAt, setPriceUpdatedAt] = useState<string | null>(null);
  const [priceLoading, setPriceLoading] = useState(false);

  const refresh = () => {
    setPositions(getPositions());
    setClaims(getClaims());
    setPositionPrices(getPositionPrices());
  };

  // Fetch live USD prices for every token used by active positions, reusing
  // the Sprint 8.5 /api/prices route. A pair's current price is then
  // usd(base) / usd(quote), computed in currentPriceById below.
  const refreshPrices = useCallback(async (allPositions: Position[]) => {
    const symbols = new Set<string>();
    for (const p of allPositions) {
      if (p.status !== "active") continue;
      const b = p.token1Symbol.trim().toUpperCase();
      const q = p.token2Symbol.trim().toUpperCase();
      if (b) symbols.add(b);
      if (q) symbols.add(q);
    }
    if (symbols.size === 0) return;
    setPriceLoading(true);
    try {
      const res = await fetch(
        `/clp-tracker/api/prices?symbols=${encodeURIComponent([...symbols].join(","))}`,
        { cache: "no-store" },
      );
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as {
        prices: Record<string, number>;
        updatedAt: string;
      };
      setFetchedPrices(data.prices ?? {});
      setPriceUpdatedAt(data.updatedAt ?? new Date().toISOString());
    } catch {
      // Leave prices empty; positions fall back to manual current price.
    } finally {
      setPriceLoading(false);
    }
  }, []);

  const hydrated = useHydrated(() => {
    const loaded = getPositions();
    setPositions(loaded);
    setClaims(getClaims());
    setPositionPrices(getPositionPrices());
    setStaleDismissals(getStalePositionDismissals());
    void refreshPrices(loaded);
  });

  // Current pair price per position: manual override wins, else fetched
  // base/quote ratio (stablecoin quote → base price directly). null = unknown.
  const currentPriceById = useMemo(() => {
    const STABLES = new Set(["USDC", "USDT", "DAI", "USD"]);
    const map = new Map<string, number | null>();
    for (const p of positions) {
      const manual = positionPrices[p.id];
      if (Number.isFinite(manual) && manual > 0) {
        map.set(p.id, manual);
        continue;
      }
      const base = p.token1Symbol.trim().toUpperCase();
      const quote = p.token2Symbol.trim().toUpperCase();
      const basePrice = fetchedPrices[base];
      const quotePrice = STABLES.has(quote) ? 1 : fetchedPrices[quote];
      if (
        Number.isFinite(basePrice) &&
        basePrice > 0 &&
        Number.isFinite(quotePrice) &&
        quotePrice > 0
      ) {
        map.set(p.id, basePrice / quotePrice);
      } else {
        map.set(p.id, null);
      }
    }
    return map;
  }, [positions, positionPrices, fetchedPrices]);

  // Active positions carry their LIVE value in currentBalance, derived from the
  // same currentPriceById that Range Health already uses — so Current, Profit
  // and Fee APR on the card read the market, not the last manual Update, and
  // the card cannot disagree with the badge beside it. Closed positions and any
  // active one whose price is unresolved pass through with their stored value.
  // Nothing is persisted; the stored field stays the fallback.
  const livePositions = useMemo(
    () => withLiveValues(positions, currentPriceById),
    [positions, currentPriceById],
  );

  const healthById = useMemo(() => {
    const map = new Map<string, RangeHealth>();
    for (const p of positions) {
      map.set(
        p.id,
        calcRangeHealth(
          currentPriceById.get(p.id) ?? null,
          p.bottomRange,
          p.topRange,
        ),
      );
    }
    return map;
  }, [positions, currentPriceById]);

  const setPositionPrice = (positionId: string, raw: string) => {
    const next = { ...positionPrices };
    const value = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(value) || value <= 0) {
      delete next[positionId];
    } else {
      next[positionId] = value;
    }
    setPositionPrices(next);
    savePositionPrices(next);
  };

  // Chain options for the filter, normalized so synonyms (SOL/Solana) merge
  // into one option (Part 5). Grouping/label only — stored chain is untouched.
  const chainOptions = hydrated
    ? Array.from(
        new Set(
          positions
            .map((p) => normalizeChain(p.chain))
            .filter((c) => c !== ""),
        ),
      ).sort()
    : [];

  const inChain = (p: Position) =>
    chainFilter === ALL_CHAINS || normalizeChain(p.chain) === chainFilter;

  // Most-recent-first: active by entry date desc, closed by exit date desc.
  const byEntryDesc = (a: Position, b: Position) =>
    (new Date(b.entryDatetime).getTime() || 0) -
    (new Date(a.entryDatetime).getTime() || 0);
  const byExitDesc = (a: Position, b: Position) =>
    (new Date(b.exitDatetime ?? "").getTime() || 0) -
    (new Date(a.exitDatetime ?? "").getTime() || 0);

  const active = hydrated
    ? derive(
        livePositions
          .filter((p) => p.status === "active" && inChain(p))
          .sort(byEntryDesc),
        claims,
      )
    : [];
  const closed = hydrated
    ? derive(
        positions
          .filter((p) => p.status === "closed" && inChain(p))
          .sort(byExitDesc),
        claims,
      )
    : [];
  const suspectScalp = hydrated ? findSuspectScalpPositions(positions) : [];
  const symbolMismatches = hydrated ? findSymbolPairMismatches(positions) : [];
  const chainMismatches = hydrated ? findChainMismatches(positions) : [];
  const stalePositions = hydrated
    ? findStalePositions(positions, claims, staleDismissals)
    : [];

  // Same shape as confirming an outlier: write the dismissal, then re-read it
  // into state so the row leaves the banner immediately, without a reload.
  const handleMarkStaleReviewed = (row: StalePositionRow) => {
    saveStalePositionDismissals([
      ...getStalePositionDismissals(),
      staleDismissalFor(row),
    ]);
    setStaleDismissals(getStalePositionDismissals());
  };

  return (
    <section className="space-y-8">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Positions</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Open new positions, track active ones, and close finished ones.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {chainOptions.length > 0 && (
            <select
              aria-label="Filter by chain"
              value={chainFilter}
              onChange={(e) => setChainFilter(e.target.value)}
              className="h-9 rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)] px-3 text-sm text-[var(--foreground)] focus:border-[var(--accent)] focus:outline-none"
            >
              <option value={ALL_CHAINS}>All chains</option>
              {chainOptions.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            onClick={() => setModal({ kind: "add" })}
            className="inline-flex h-9 items-center justify-center rounded-md bg-[var(--accent-solid)] px-4 text-sm font-medium text-white shadow-sm transition-colors hover:bg-[var(--accent-solid)]/90"
          >
            Add Position
          </button>
        </div>
      </header>

      {symbolMismatches.length > 0 && (
        <SymbolMismatchBanner
          rows={symbolMismatches}
          onEdit={(p) => setModal({ kind: "edit", position: p })}
        />
      )}

      {chainMismatches.length > 0 && (
        <ChainMismatchBanner
          rows={chainMismatches}
          onEdit={(p) => setModal({ kind: "edit", position: p })}
        />
      )}

      {stalePositions.length > 0 && (
        <StalePositionsBanner
          rows={stalePositions}
          onEdit={(p) => setModal({ kind: "edit", position: p })}
          onMarkReviewed={handleMarkStaleReviewed}
        />
      )}

      {suspectScalp.length > 0 && (
        <SuspectScalpBanner rows={suspectScalp} onEdit={(p) => setModal({ kind: "edit", position: p })} />
      )}

      {active.length > 0 && (
        <RangeHealthSummary
          rows={active}
          healthById={healthById}
          priceLoading={priceLoading}
          priceUpdatedAt={priceUpdatedAt}
          onRefresh={() => void refreshPrices(positions)}
        />
      )}

      <PositionsTable
        title="Active Positions"
        rows={active}
        variant="active"
        healthById={healthById}
        onSetPrice={setPositionPrice}
        onEdit={(p) => setModal({ kind: "edit", position: p })}
        onUpdate={(p) => setModal({ kind: "update", position: p })}
        onClose={(p) => setModal({ kind: "close", position: p })}
        onClaim={(p) => setModal({ kind: "claim", position: p })}
        onDelete={(p) => setModal({ kind: "delete", position: p })}
        emptyText="No active positions. Click Add Position to get started."
        view={view}
        onViewChange={setView}
      />

      <ClosedSection
        rows={closed}
        open={showClosed}
        onToggle={() => setShowClosed((v) => !v)}
        view={view}
        onEdit={(p) => setModal({ kind: "edit", position: p })}
        onClaim={(p) => setModal({ kind: "claim", position: p })}
        onDelete={(p) => setModal({ kind: "delete", position: p })}
      />

      <PositionActionHost
        modal={modal}
        positions={positions}
        claims={claims}
        onChanged={refresh}
        onDismiss={() => setModal({ kind: "none" })}
      />
    </section>
  );
}

interface RangeHealthSummaryProps {
  rows: DerivedRow[];
  healthById: Map<string, RangeHealth>;
  priceLoading: boolean;
  priceUpdatedAt: string | null;
  onRefresh: () => void;
}

// Surfaces the closed positions whose Profit is currently showing fees alone
// because Scalp was left at 0. Lists them rather than repairing them — see
// findSuspectScalpPositions.
function SuspectScalpBanner({
  rows,
  onEdit,
}: {
  rows: SuspectScalpRow[];
  onEdit: (p: Position) => void;
}) {
  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/[0.06] px-5 py-4">
      <h2 className="text-sm font-semibold text-amber-300">
        {rows.length} closed{" "}
        {rows.length === 1 ? "position has" : "positions have"} a missing Scalp
      </h2>
      <p className="mt-1 text-[11px] leading-relaxed text-[var(--muted)]">
        Scalp is the price difference (Final Withdrawn − Deposited). These have
        it saved as 0 while the money actually moved, so their Profit is
        showing fees only. Open each one and press Recalculate Scalp — nothing
        is changed until you save. If a position genuinely broke even, leave it.
      </p>
      <ul className="mt-3 space-y-2">
        {rows.map((r) => (
          <li
            key={r.position.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded border border-[var(--border-strong)] bg-[var(--surface-2)]/40 px-3 py-2 text-[12px]"
          >
            <span className="font-medium text-[var(--foreground)]">
              {r.position.pair}
            </span>
            <span className="tabular-nums text-[var(--muted)]">
              {formatUsd(r.deposited)} → {formatUsd(r.withdrawn)}
            </span>
            <span className={`tabular-nums font-medium ${pnlColor(r.correctScalp)}`}>
              Scalp should be {formatUsd(r.correctScalp)}
            </span>
            <button
              type="button"
              onClick={() => onEdit(r.position)}
              className="rounded-md border border-amber-500/40 px-2.5 py-1 text-[11px] font-medium text-amber-300 transition-colors hover:bg-amber-500/10"
            >
              Fix
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Banner driven by findSymbolPairMismatches. A wrong token symbol silently
// prices the wrong coin — for a token-amount-mode close it corrupts the stored
// Final Balance / Scalp, not just the label.
// Flags positions whose stored chain contradicts a chain-native base token
// (Part 4a) — e.g. a SUI/USDC pair stored on chain "SOL". Reports only; the
// user fixes via Edit. Shows the raw stored chain and the expected one.
function ChainMismatchBanner({
  rows,
  onEdit,
}: {
  rows: ChainMismatchRow[];
  onEdit: (p: Position) => void;
}) {
  return (
    <div
      id="position-chain-issues"
      className="rounded-lg border border-red-500/50 bg-red-500/[0.07] px-5 py-4"
    >
      <h2 className="text-sm font-semibold text-red-300">
        {rows.length}{" "}
        {rows.length === 1 ? "position has" : "positions have"} a chain that
        doesn&apos;t match its pair
      </h2>
      <p className="mt-1 text-[11px] leading-relaxed text-[var(--muted)]">
        A pair whose base token lives on one chain (e.g. SUI) can&apos;t sit on a
        different chain. This usually means the Chain field holds a typo. Open
        each one and fix it — nothing changes until you save.
      </p>
      <ul className="mt-3 space-y-2">
        {rows.map((r) => (
          <li
            key={r.position.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded border border-[var(--border-strong)] bg-[var(--surface-2)]/40 px-3 py-2 text-[12px]"
          >
            <span className="font-medium text-[var(--foreground)]">
              {r.position.pair}
            </span>
            <span className="tabular-nums text-[var(--muted)]">
              chain{" "}
              <span className="font-medium text-red-300">
                {r.chain || "—"}
              </span>{" "}
              → expected {r.expectedChain}
            </span>
            <button
              type="button"
              onClick={() => onEdit(r.position)}
              className="rounded-md border border-red-500/50 px-2.5 py-1 text-[11px] font-medium text-red-300 transition-colors hover:bg-red-500/10"
            >
              Fix
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Active positions with nothing logged against them for a while. Amber, not
// red: a quiet pool is a perfectly real position, so this asks a question
// rather than reporting an error. Reports only — no data is touched.
function StalePositionsBanner({
  rows,
  onEdit,
  onMarkReviewed,
}: {
  rows: StalePositionRow[];
  onEdit: (p: Position) => void;
  onMarkReviewed: (row: StalePositionRow) => void;
}) {
  return (
    <div
      id="stale-positions"
      className="rounded-lg border border-amber-500/40 bg-amber-500/[0.06] px-5 py-4"
    >
      <h2 className="text-sm font-semibold text-amber-300">
        {rows.length}{" "}
        {rows.length === 1 ? "open position has" : "open positions have"}{" "}
        had no activity in over {STALE_POSITION_DAYS} days
      </h2>
      <p className="mt-1 text-[11px] leading-relaxed text-[var(--muted)]">
        Counted from the most recent fee claim, or the opening date when nothing
        has ever been claimed. Log a new claim, mark the position closed if
        it&apos;s done, or mark this reviewed if it&apos;s genuinely fine as-is.
        Marking it reviewed only hides this row — no figure changes, and it
        comes back if the position goes quiet again after its next claim.
      </p>
      <ul className="mt-3 space-y-2">
        {rows.map((r) => (
          <li
            key={r.position.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded border border-[var(--border-strong)] bg-[var(--surface-2)]/40 px-3 py-2 text-[12px]"
          >
            <span className="font-medium text-[var(--foreground)]">
              {r.position.pair}
            </span>
            <span className="tabular-nums text-[var(--muted)]">
              {r.claimCount === 0
                ? "never claimed · opened"
                : "last claim"}{" "}
              <span className="font-medium text-amber-300">
                {formatDateTime24(r.lastActivity).split(" ")[0]}
              </span>{" "}
              · {Math.floor(r.daysSince)} days ago
            </span>
            <span className="flex gap-2">
              <button
                type="button"
                onClick={() => onEdit(r.position)}
                className="rounded-md border border-amber-500/50 px-2.5 py-1 text-[11px] font-medium text-amber-300 transition-colors hover:bg-amber-500/10"
              >
                Review
              </button>
              <button
                type="button"
                onClick={() => onMarkReviewed(r)}
                className="rounded-md border border-[var(--border-strong)] px-2.5 py-1 text-[11px] font-medium text-[var(--muted)] transition-colors hover:bg-white/5"
              >
                Mark reviewed
              </button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SymbolMismatchBanner({
  rows,
  onEdit,
}: {
  rows: SymbolPairMismatchRow[];
  onEdit: (p: Position) => void;
}) {
  return (
    <div
      id="position-symbol-issues"
      className="rounded-lg border border-red-500/50 bg-red-500/[0.07] px-5 py-4"
    >
      <h2 className="text-sm font-semibold text-red-300">
        {rows.length}{" "}
        {rows.length === 1 ? "position has" : "positions have"} a token symbol
        that doesn&apos;t match its pair
      </h2>
      <p className="mt-1 text-[11px] leading-relaxed text-[var(--muted)]">
        A position&apos;s Base/Quote symbol should appear in its Pair (e.g. pair
        SUI/USDC, base SUI). When it doesn&apos;t, every price lookup fetches the
        wrong coin. Open each one and fix the token symbol.{" "}
        <span className="text-red-300">
          If the position was closed using &ldquo;Token amounts&rdquo; mode, its
          Final Balance and Scalp were calculated from the wrong price — after
          fixing the symbol, use &ldquo;Recalculate from token amounts&rdquo; to
          correct the dollars.
        </span>{" "}
        Nothing changes until you save.
      </p>
      <ul className="mt-3 space-y-2">
        {rows.map((r) => (
          <li
            key={r.position.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded border border-[var(--border-strong)] bg-[var(--surface-2)]/40 px-3 py-2 text-[12px]"
          >
            <span className="font-medium text-[var(--foreground)]">
              {r.position.pair}
              {r.isClosed && (
                <span className="ml-2 rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] font-medium text-red-300">
                  closed · check $
                </span>
              )}
            </span>
            <span className="tabular-nums text-[var(--muted)]">
              {r.baseMismatch && (
                <>
                  base{" "}
                  <span className="font-medium text-red-300">
                    {r.baseSymbol}
                  </span>
                  {r.pairBase && <> → should be {r.pairBase}</>}
                </>
              )}
              {r.baseMismatch && r.quoteMismatch && " · "}
              {r.quoteMismatch && (
                <>
                  quote{" "}
                  <span className="font-medium text-red-300">
                    {r.quoteSymbol}
                  </span>
                  {r.pairQuote && <> → should be {r.pairQuote}</>}
                </>
              )}
            </span>
            <button
              type="button"
              onClick={() => onEdit(r.position)}
              className="rounded-md border border-red-500/50 px-2.5 py-1 text-[11px] font-medium text-red-300 transition-colors hover:bg-red-500/10"
            >
              Fix
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RangeHealthSummary({
  rows,
  healthById,
  priceLoading,
  priceUpdatedAt,
  onRefresh,
}: RangeHealthSummaryProps) {
  let out = 0;
  let close = 0;
  let safe = 0;
  let unknown = 0;
  const atRisk: Array<{ position: Position; health: RangeHealth }> = [];
  for (const { position } of rows) {
    const health = healthById.get(position.id);
    if (!health || health.status === "unknown") {
      unknown += 1;
      continue;
    }
    if (health.status === "out") {
      out += 1;
      atRisk.push({ position, health });
    } else if (health.status === "close") {
      close += 1;
      atRisk.push({ position, health });
    } else {
      safe += 1;
    }
  }
  atRisk.sort(
    (a, b) => (a.health.nearestEdgePct ?? 0) - (b.health.nearestEdgePct ?? 0),
  );

  const updatedLabel = priceLoading
    ? "Updating prices…"
    : priceUpdatedAt
      ? `Prices updated ${formatUpdatedAt(priceUpdatedAt)}`
      : "Prices not fetched yet";

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)]">
      <div className="flex flex-col gap-3 border-b border-[var(--border)] px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-sm font-semibold tracking-tight">Range Health</h2>
          <p className="mt-0.5 text-xs text-[var(--muted)]">
            How close each active position is to going out of its range
            (auto-priced; type a price where none is available).
          </p>
        </div>
        <div className="flex items-center gap-3 whitespace-nowrap">
          <span className="text-xs text-[var(--muted)]">{updatedLabel}</span>
          <button
            type="button"
            onClick={onRefresh}
            disabled={priceLoading}
            className="inline-flex h-8 items-center justify-center rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)] px-3 text-xs font-medium text-[var(--foreground)] transition-colors hover:border-[var(--accent)] disabled:opacity-50"
          >
            Refresh
          </button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 px-5 py-4 sm:grid-cols-4">
        <RangeCount label="Out of Range" value={out} tone="rose" />
        <RangeCount label="Getting Close" value={close} tone="amber" />
        <RangeCount label="In Range" value={safe} tone="emerald" />
        <RangeCount label="Price Needed" value={unknown} tone="muted" />
      </div>
      {atRisk.length > 0 && (
        <div className="border-t border-[var(--border)] px-5 py-3">
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-[var(--muted)]">
            Needs attention (closest to the edge first)
          </p>
          <ul className="space-y-1.5">
            {atRisk.map(({ position, health }) => (
              <li
                key={position.id}
                className="flex items-center justify-between gap-3 text-sm"
              >
                <span className="flex items-center gap-2">
                  <RangeBadge status={health.status} />
                  <span className="font-medium">{position.pair}</span>
                  <span className="text-[var(--muted)]">
                    ({position.chain})
                  </span>
                </span>
                <span className="text-xs text-[var(--muted)] tabular-nums">
                  {rangeHealthDetail(health)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function RangeCount({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "rose" | "amber" | "emerald" | "muted";
}) {
  const toneCls: Record<typeof tone, string> = {
    rose: "text-rose-300",
    amber: "text-amber-300",
    emerald: "text-emerald-300",
    muted: "text-[var(--muted)]",
  };
  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--surface-2)]/40 px-3 py-2.5 text-center">
      <div className={`text-2xl font-semibold tabular-nums ${toneCls[tone]}`}>
        {value}
      </div>
      <div className="mt-0.5 text-[11px] uppercase tracking-wider text-[var(--muted)]">
        {label}
      </div>
    </div>
  );
}

type PositionView = "cards" | "list";

interface PositionsTableProps {
  title: string;
  rows: DerivedRow[];
  variant: "active" | "closed";
  healthById?: Map<string, RangeHealth>;
  onSetPrice?: (positionId: string, raw: string) => void;
  onEdit?: (p: Position) => void;
  onUpdate?: (p: Position) => void;
  onClose?: (p: Position) => void;
  onClaim?: (p: Position) => void;
  onDelete?: (p: Position) => void;
  emptyText: string;
  view?: PositionView;
  onViewChange?: (v: PositionView) => void;
}

function PositionCard({
  row,
  variant,
  health,
  onSetPrice,
  onEdit,
  onUpdate,
  onClose,
  onClaim,
  onDelete,
}: {
  row: DerivedRow;
  variant: "active" | "closed";
  health?: RangeHealth;
  onSetPrice?: (raw: string) => void;
  onEdit?: (p: Position) => void;
  onUpdate?: (p: Position) => void;
  onClose?: (p: Position) => void;
  onClaim?: (p: Position) => void;
  onDelete?: (p: Position) => void;
}) {
  const {
    position, deposited, claimed, fees, days, apr, priceDiff, profit, saleGain,
  } = row;
  const [showDetails, setShowDetails] = useState(false);
  const wideRange = calcWideRangePercent(position.bottomRange, position.topRange);
  const isActive = variant === "active";
  // Closed positions are dimmed but never hidden (Invariant #4).
  const priceUnresolved = isActive && (!health || health.status === "unknown");
  // The card's own background opens the detail page. Every control inside it
  // stops propagation, so a button/toggle/input click does exactly what it did
  // before and never also navigates.
  const router = useRouter();
  const openDetail = () => router.push(`/clp-tracker/positions/${position.id}`);

  return (
    <article
      role="link"
      tabIndex={0}
      aria-label={`Open ${position.pair} details`}
      data-position-card={position.id}
      onClick={openDetail}
      onKeyDown={(e) => {
        // Only the card itself — Enter inside the price input must not navigate.
        if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          openDetail();
        }
      }}
      className={`cursor-pointer rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4 transition-colors hover:border-[var(--border-strong)] ${
        isActive ? "" : "opacity-75 hover:opacity-100"
      }`}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-[var(--foreground)]">
            <span className="truncate">{position.pair}</span>
            <TxLinkBadge value={position.txLink ?? null} />
          </h3>
          <p className="mt-0.5 text-[11px] text-[var(--muted)]">
            {position.chain} · {position.protocol}
          </p>
        </div>
        {isActive ? (
          priceUnresolved ? (
            <input
              type="number"
              step="any"
              min="0"
              placeholder="current price"
              aria-label={`Current price for ${position.pair}`}
              className={`${inputClass} w-28 text-right`}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
              onBlur={(e) => onSetPrice?.(e.target.value)}
            />
          ) : (
            <RangeBadge status={health!.status} />
          )
        ) : (
          <div className="text-right text-[11px] text-[var(--muted)]">
            <div className="tabular-nums">
              <span className="text-[var(--muted)]/70">Opened </span>
              {formatDateTime24(position.entryDatetime)}
            </div>
            <div className="tabular-nums">
              <span className="text-[var(--muted)]/70">Closed </span>
              {formatDateTime24(position.exitDatetime)}
            </div>
            <div className="text-[var(--muted)]/80">
              {days.toFixed(1)} days held
            </div>
          </div>
        )}
      </header>

      {isActive && health && health.status !== "unknown" && (
        <RangeBar
          health={health}
          entryPrice={position.entryPrice}
          rangeDown={position.bottomRange}
          rangeUp={position.topRange}
        />
      )}

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
        <Metric label="Deposited" value={formatUsd(deposited)} />
        <Metric label="Current" value={formatUsd(position.currentBalance)} />
        <Metric
          label="Profit"
          value={formatUsd(profit)}
          tone={`font-medium ${pnlColor(profit)}`}
        />
        <Metric label="Total Fees" value={formatUsd(fees)} />
        <Metric label="Fee APR" value={formatPercent(apr)} />
        {isActive ? (
          <Metric label="Days Active" value={days.toFixed(1)} />
        ) : (
          <Metric
            label="Scalp"
            value={formatUsd(position.scalp ?? 0)}
            tone={`font-medium ${pnlColor(position.scalp ?? 0)}`}
          />
        )}
      </dl>

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setShowDetails((v) => !v);
        }}
        aria-expanded={showDetails}
        className="mt-3 text-[11px] font-medium text-[var(--muted)] transition-colors hover:text-[var(--foreground)]"
      >
        {showDetails ? "Hide details" : "Details"} {showDetails ? "▴" : "▾"}
      </button>

      {showDetails && (
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-[var(--border)] pt-3 sm:grid-cols-3">
          <Metric label="New Fees" value={formatUsd(position.newFees)} />
          {/* Claim-time fee income, and — only when the reward tokens were
              actually sold later — what that money became. Two real numbers;
              the second is absent on a position that never sold. */}
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
          <Metric
            label="Entry Date"
            value={formatDateTime24(position.entryDatetime)}
          />
          <Metric
            label="Range"
            value={`${formatPrice(position.bottomRange)} – ${formatPrice(position.topRange)}`}
          />
          <Metric
            label="Range %"
            value={wideRange > 0 ? formatPercent(wideRange) : "—"}
          />
        </dl>
      )}

      <div className="mt-4 flex flex-wrap gap-2 border-t border-[var(--border)] pt-3">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onEdit?.(position);
          }}
          className="rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)] px-2.5 py-1 text-xs font-medium text-[var(--foreground)] hover:bg-[var(--surface-2)]/70"
        >
          Edit
        </button>
        {isActive && (
          <button
            type="button"
            onClick={(e) => {
            e.stopPropagation();
            onUpdate?.(position);
          }}
            className="rounded-md border border-[var(--accent)]/40 bg-[var(--accent)]/10 px-2.5 py-1 text-xs font-medium text-[var(--accent)] hover:bg-[var(--accent)]/20"
          >
            Update
          </button>
        )}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClaim?.(position);
          }}
          className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-300 hover:bg-emerald-500/20"
        >
          Claim
        </button>
        {isActive && (
          <button
            type="button"
            onClick={(e) => {
            e.stopPropagation();
            onClose?.(position);
          }}
            className="rounded-md border border-rose-500/30 bg-rose-500/10 px-2.5 py-1 text-xs font-medium text-rose-300 hover:bg-rose-500/20"
          >
            Close
          </button>
        )}
        {onDelete && (
          <button
            type="button"
            onClick={(e) => {
            e.stopPropagation();
            onDelete(position);
          }}
            className="ml-auto rounded-md border border-rose-500/40 px-2.5 py-1 text-xs font-medium text-rose-300 hover:bg-rose-500/10"
          >
            Delete
          </button>
        )}
      </div>
    </article>
  );
}

function PositionsTable({
  title,
  rows,
  variant,
  healthById,
  onSetPrice,
  onEdit,
  onUpdate,
  onClose,
  onClaim,
  onDelete,
  emptyText,
  view = "cards",
  onViewChange,
}: PositionsTableProps) {
  return (
    <div>
      {title && (
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
          <div className="flex items-center gap-3">
            {onViewChange && <ViewToggle value={view} onChange={onViewChange} />}
            <span className="text-xs text-[var(--muted)]">
              {rows.length} {rows.length === 1 ? "position" : "positions"}
            </span>
          </div>
        </div>
      )}

      {rows.length === 0 ? (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-5 py-10 text-center text-sm text-[var(--muted)]">
          {emptyText}
        </div>
      ) : view === "list" ? (
        <div className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)] divide-y divide-[var(--border)]">
          {rows.map((row) => (
            <PositionListRow
              key={row.position.id}
              row={row}
              variant={variant}
              health={healthById?.get(row.position.id)}
              onEdit={onEdit}
              onUpdate={onUpdate}
              onClose={onClose}
              onClaim={onClaim}
              onDelete={onDelete}
            />
          ))}
        </div>
      ) : (
        // items-start so expanding one card's details does not stretch its
        // row-mates into tall cards with dead space under the buttons.
        <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-2 xl:grid-cols-3">
          {rows.map((row) => (
            <PositionCard
              key={row.position.id}
              row={row}
              variant={variant}
              health={healthById?.get(row.position.id)}
              onSetPrice={
                onSetPrice ? (raw) => onSetPrice(row.position.id, raw) : undefined
              }
              onEdit={onEdit}
              onUpdate={onUpdate}
              onClose={onClose}
              onClaim={onClaim}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ViewToggle({
  value,
  onChange,
}: {
  value: PositionView;
  onChange: (v: PositionView) => void;
}) {
  const options: Array<{ value: PositionView; label: string }> = [
    { value: "cards", label: "Cards" },
    { value: "list", label: "List" },
  ];
  return (
    <div
      role="radiogroup"
      aria-label="Positions view"
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
            className={`h-7 px-2.5 text-[11px] font-medium transition-colors ${
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

// Compact, inline-expandable row for the List view (Part 4). Collapsed shows
// Pair, Status, Profit — the three scan-at-a-glance fields. Expanded reveals
// the same figures as the card's Details plus all action buttons. No table, so
// it reflows to any width without horizontal scroll.
function PositionListRow({
  row,
  variant,
  health,
  onEdit,
  onUpdate,
  onClose,
  onClaim,
  onDelete,
}: {
  row: DerivedRow;
  variant: "active" | "closed";
  health?: RangeHealth;
  onEdit?: (p: Position) => void;
  onUpdate?: (p: Position) => void;
  onClose?: (p: Position) => void;
  onClaim?: (p: Position) => void;
  onDelete?: (p: Position) => void;
}) {
  const {
    position, deposited, claimed, fees, days, apr, priceDiff, profit, saleGain,
  } = row;
  const [open, setOpen] = useState(false);
  const isActive = variant === "active";
  const wideRange = calcWideRangePercent(position.bottomRange, position.topRange);
  // Same rule as the card: the row's own background opens the detail page and
  // every control inside stops propagation. The collapsed row IS the expand
  // toggle, so it keeps expanding; the explicit "View details" link and the
  // expanded panel's background are the ways in from the List view.
  const router = useRouter();
  const openDetail = () => router.push(`/clp-tracker/positions/${position.id}`);

  return (
    <div
      data-position-row={position.id}
      onClick={openDetail}
      className={`cursor-pointer ${isActive ? "" : "opacity-75"}`}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--surface-2)]/60"
      >
        <span className="text-[10px] text-[var(--muted)]">{open ? "▴" : "▾"}</span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--foreground)]">
          {position.pair}
        </span>
        {isActive ? (
          health && health.status !== "unknown" ? (
            <RangeBadge status={health.status} />
          ) : (
            <span className="text-[10px] uppercase tracking-wider text-[var(--muted)]">
              Price needed
            </span>
          )
        ) : (
          <span className="rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-[10px] uppercase tracking-wider text-[var(--muted)]">
            Closed
          </span>
        )}
        <span
          className={`w-24 shrink-0 text-right text-sm tabular-nums ${pnlColor(profit)}`}
        >
          {formatUsd(profit)}
        </span>
      </button>

      {open && (
        <div className="border-t border-[var(--border)] bg-[var(--surface-2)]/20 px-4 py-3">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
            <Metric label="Deposited" value={formatUsd(deposited)} />
            <Metric label="Current" value={formatUsd(position.currentBalance)} />
            <Metric label="Total Fees" value={formatUsd(fees)} />
            <Metric label="Fee APR" value={formatPercent(apr)} />
            <Metric label="Days Active" value={days.toFixed(1)} />
            {!isActive && (
              <Metric
                label="Scalp"
                value={formatUsd(position.scalp ?? 0)}
                tone={`font-medium ${pnlColor(position.scalp ?? 0)}`}
              />
            )}
            <Metric label="New Fees" value={formatUsd(position.newFees)} />
            {/* Fees Earned is ALWAYS claim-time: what these fees were worth
                when they were earned. "After Selling" appears only when the
                reward tokens were actually sold later, so an ordinary position
                still shows exactly one figure. */}
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
            <Metric
              label="Entry Price"
              value={formatPrice(position.entryPrice)}
            />
            <Metric
              label="Entry Date"
              value={formatDateTime24(position.entryDatetime)}
            />
            <Metric
              label="Range"
              value={`${formatPrice(position.bottomRange)} – ${formatPrice(position.topRange)}`}
            />
            <Metric
              label="Range %"
              value={wideRange > 0 ? formatPercent(wideRange) : "—"}
            />
          </dl>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Link
              href={`/clp-tracker/positions/${position.id}`}
              onClick={(e) => e.stopPropagation()}
              className="text-xs font-medium text-[var(--accent)] hover:opacity-80"
            >
              View details →
            </Link>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onEdit?.(position);
              }}
              className="rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)] px-2.5 py-1 text-xs font-medium text-[var(--foreground)] hover:bg-[var(--surface-2)]/70"
            >
              Edit
            </button>
            {isActive && (
              <button
                type="button"
                onClick={(e) => {
                e.stopPropagation();
                onUpdate?.(position);
              }}
                className="rounded-md border border-[var(--accent)]/40 bg-[var(--accent)]/10 px-2.5 py-1 text-xs font-medium text-[var(--accent)] hover:bg-[var(--accent)]/20"
              >
                Update
              </button>
            )}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onClaim?.(position);
              }}
              className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-300 hover:bg-emerald-500/20"
            >
              Claim
            </button>
            {isActive && (
              <button
                type="button"
                onClick={(e) => {
                e.stopPropagation();
                onClose?.(position);
              }}
                className="rounded-md border border-rose-500/30 bg-rose-500/10 px-2.5 py-1 text-xs font-medium text-rose-300 hover:bg-rose-500/20"
              >
                Close
              </button>
            )}
            {onDelete && (
              <button
                type="button"
                onClick={(e) => {
                e.stopPropagation();
                onDelete(position);
              }}
                className="ml-auto rounded-md border border-rose-500/40 px-2.5 py-1 text-xs font-medium text-rose-300 hover:bg-rose-500/10"
              >
                Delete
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

interface ClosedSectionProps {
  rows: DerivedRow[];
  open: boolean;
  onToggle: () => void;
  view?: PositionView;
  onEdit?: (p: Position) => void;
  onClaim?: (p: Position) => void;
  onDelete?: (p: Position) => void;
}

function ClosedSection({
  rows,
  open,
  onToggle,
  view = "cards",
  onEdit,
  onClaim,
  onDelete,
}: ClosedSectionProps) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)]">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between border-b border-[var(--border)] px-5 py-4 text-left transition-colors hover:bg-[var(--surface-2)]/50"
        aria-expanded={open}
      >
        <span className="text-sm font-semibold tracking-tight">
          {open ? "Hide" : "Show"} Closed Positions ({rows.length})
        </span>
        <span className="text-xs text-[var(--muted)]" aria-hidden>
          {open ? "▴" : "▾"}
        </span>
      </button>

      {open &&
        (rows.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-[var(--muted)]">
            No closed positions yet.
          </div>
        ) : (
          <div className="p-4">
            <PositionsTable
              title=""
              rows={rows}
              variant="closed"
              view={view}
              onEdit={onEdit}
              onClaim={onClaim}
              onDelete={onDelete}
              emptyText=""
            />
          </div>
        ))}
    </div>
  );
}
