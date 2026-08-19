"use client";

import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  getClaims,
  getPoolPnL,
  getPositions,
  getPositionPrices,
  getStalePositionDismissals,
  saveStalePositionDismissals,
  getRanges,
  getTransfers,
  saveClaims,
  savePoolPnL,
  savePositions,
  savePositionPrices,
  saveRanges,
  saveTransfers,
} from "../lib/storage";
import { createUpsideTransfer } from "../lib/transferAutomation";
import {
  findChainMismatches,
  findStalePositions,
  staleDismissalFor,
  type ChainMismatchRow,
  type StalePositionRow,
  STALE_POSITION_DAYS,
} from "../lib/dataHealth";
import { normalizeChain } from "../lib/nameNormalization";
import {
  calcDaysActive,
  calcFeeAPR,
  calcPositionProfit,
  calcPriceDiff,
  calcRangeHealth,
  calcScalpFromWithdrawn,
  findSuspectScalpPositions,
  findSymbolPairMismatches,
  calcClosedProfit,
  calcTotalFees,
  calcWideRangePercent,
  computePositionIL,
  depositedFromLiquidity,
  entryPriceFromDeposited,
  entryPriceFromTokens,
  getEffectiveClaimed,
  getEffectiveDeposited,
  withLiveValues,
  getEffectiveTotalFees,
  liquidityFromDeposited,
  splitDepositedIntoTokens,
  type EntryPriceFromTokens,
  type ILResult,
  type SuspectScalpRow,
  type SymbolPairMismatchRow,
  type TokenSplit,
  type RangeHealth,
  type RangeStatus,
} from "../lib/calculations";
import {
  ClaimFormModal,
  persistNewClaim,
} from "../components/ClaimFormModal";
import {
  HYPOTHETICAL_DIM,
  HypotheticalNotice,
} from "../components/Hypothetical";
import { useHydrated } from "../lib/useHydrated";
import type { FeeClaim } from "../lib/types";
import type {
  LPRange,
  PoolPnLEntry,
  Position,
  StalePositionDismissal,
  Transfer,
} from "../lib/types";

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
  const safe = Number.isFinite(value) ? value : 0;
  return `${safe.toFixed(2)}%`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function formatDateTime24(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function nowDatetimeLocal(): string {
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60_000).toISOString().slice(0, 16);
}

function formatUpdatedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "just now";
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function isoToDatetimeLocal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60_000).toISOString().slice(0, 16);
}

function isoToDateInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60_000).toISOString().slice(0, 10);
}

function dateInputToIso(value: string): string | null {
  if (!value) return null;
  const d = new Date(`${value}T00:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `id_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function pnlColor(value: number): string {
  if (value > 0) return "text-emerald-400";
  if (value < 0) return "text-rose-400";
  return "text-[var(--foreground)]";
}

// The word that goes with pnlColor. Deliberately the same sign checks in the
// same order, right beside it, so the colour and the word can never disagree —
// a green "Loss" would be worse than no word at all. Exactly zero is neither,
// and gets no word rather than being called a gain.
function pnlLabel(value: number): string {
  if (value > 0) return "Gain";
  if (value < 0) return "Loss";
  return "";
}

function num(value: string): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function optionalNum(value: string): number | null {
  if (value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeFeeTier(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.endsWith("%") ? trimmed : `${trimmed}%`;
}

function computeShortTotal(
  gain: number | null,
  loss: number | null,
  funding: number | null,
): number | null {
  if (gain === null && loss === null && funding === null) return null;
  return (gain ?? 0) - (loss ?? 0) + (funding ?? 0);
}

// Deposited USD is derived, never typed (Invariant #9):
// (base token count × entry price) + quote token count. Falls back to the
// carried stored value only for legacy records with missing token counts —
// mirrors getEffectiveDeposited in lib/calculations. Takes primitive fields
// rather than the whole form so memoized callers can declare exact deps.
function formDeposited(
  token1Count: string,
  entryPrice: string,
  token2Count: string,
  deposited: string,
): number {
  const base = num(token1Count);
  const entry = num(entryPrice);
  const quote = num(token2Count);
  const computed =
    (base > 0 && entry > 0 ? base * entry : 0) + (quote > 0 ? quote : 0);
  return computed > 0 ? computed : num(deposited);
}

// Token counts and Deposited are written back into number inputs when the
// other side is edited, so they need trimming — a raw String(2.4000000000004)
// is a legal but unreadable field value.
// allowNegative must be set for Scalp, which is legitimately negative on a
// position closed at a loss. Left off by default because the other callers
// (token counts, deposited) have no meaningful negative value.
function formatAmountInput(
  value: number,
  decimals: number,
  allowNegative = false,
): string {
  if (!Number.isFinite(value)) return "0";
  if (value <= 0 && !allowNegative) return "0";
  return String(Number(value.toFixed(decimals)));
}

// The token counts an auto-split replaced, kept only to show them back to
// the user in the amber note.
interface TokenSplitWarning {
  base: string;
  quote: string;
}

// What a confirmed recalculation replaced, kept to report it back after the
// panel closes.
interface RecalcSummary {
  fromEntry: string;
  toEntry: string;
  fromDeposited: string;
  toDeposited: string;
  // Whether Current Balance moved with the correction, and if it did not,
  // the stale figure the user needs to review.
  balanceMoved: boolean;
  staleBalance: string | null;
}

// The one path where Edit mode may rewrite a recorded Entry Price and
// Deposited together. Everything here works on a local draft so that
// cancelling touches nothing, and the solved result is shown as an explicit
// old → new comparison that the user must confirm before it reaches the form.
function RecalcFromTokensPanel({
  rangeDown,
  rangeUp,
  currentEntryPrice,
  currentDeposited,
  savedCurrentBalance,
  balanceTracksDeposited,
  baseSymbol,
  quoteSymbol,
  initialBase,
  initialQuote,
  onApply,
  onCancel,
}: {
  rangeDown: number;
  rangeUp: number;
  currentEntryPrice: number;
  currentDeposited: number;
  savedCurrentBalance: number;
  // True when the saved Current Balance still equals the saved Deposited —
  // i.e. it has never been independently updated and is only a default.
  balanceTracksDeposited: boolean;
  baseSymbol: string;
  quoteSymbol: string;
  initialBase: string;
  initialQuote: string;
  onApply: (
    entryPrice: number,
    deposited: number,
    base: string,
    quote: string,
    newCurrentBalance: number | null,
  ) => void;
  onCancel: () => void;
}) {
  const [base, setBase] = useState(initialBase);
  const [quote, setQuote] = useState(initialQuote);

  const solved = useMemo(
    () => entryPriceFromTokens(num(base), num(quote), rangeDown, rangeUp),
    [base, quote, rangeDown, rangeUp],
  );
  const newDeposited =
    solved !== null ? num(base) * solved.entryPrice + num(quote) : null;

  const entryChanges =
    solved !== null && solved.entryPrice.toFixed(6) !== currentEntryPrice.toFixed(6);
  const depositedChanges =
    newDeposited !== null && newDeposited.toFixed(2) !== currentDeposited.toFixed(2);
  // Profit = Current Balance − Deposited, so correcting Deposited alone
  // invents profit. When the balance was only ever a default copy of the
  // deposit it moves with the correction and profit stays at zero; when it
  // holds real tracked data it is left alone and the user is told why.
  const balanceChanges = balanceTracksDeposited && depositedChanges;

  return (
    <div className="mt-4 rounded-md border border-amber-500/40 bg-amber-500/[0.06] p-4">
      <h4 className="text-[13px] font-semibold text-[var(--foreground)]">
        Recalculate from token amounts
      </h4>
      <p className="mt-1 text-[11px] leading-relaxed text-[var(--muted)]">
        Use this when the saved record itself is wrong — not to fix a typo.
        Enter the token amounts you know are correct and the entry price will
        be solved from them, then Deposited recalculated. This is the only
        place editing a position can change Deposited.
      </p>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field
          label={`Base Token Count${baseSymbol ? ` (${baseSymbol})` : ""}`}
          htmlFor="recalcBase"
        >
          <input
            id="recalcBase"
            type="number"
            step="any"
            className={inputClass}
            value={base}
            onChange={(e) => setBase(e.target.value)}
          />
        </Field>
        <Field
          label={`Quote Token Count${quoteSymbol ? ` (${quoteSymbol})` : ""}`}
          htmlFor="recalcQuote"
        >
          <input
            id="recalcQuote"
            type="number"
            step="any"
            className={inputClass}
            value={quote}
            onChange={(e) => setQuote(e.target.value)}
          />
        </Field>
      </div>

      {solved === null ? (
        <p className="mt-3 text-[12px] text-amber-300" role="status">
          {num(base) === 0 && num(quote) === 0
            ? "Enter at least one token amount."
            : "Cannot solve an entry price from these amounts. Check both range bounds are set and Range Up is above Range Down."}
        </p>
      ) : (
        <div className="mt-3 space-y-2" aria-live="polite">
          {solved.shape !== "two-sided" && (
            <p className="text-[11px] text-[var(--muted)]">
              Only one token entered, so the entry price is the{" "}
              {solved.shape === "base-only" ? "bottom" : "top"} of your range —
              the only point where a position holds{" "}
              {solved.shape === "base-only"
                ? `100% ${baseSymbol || "base token"}`
                : `100% ${quoteSymbol || "quote token"}`}
              .
            </p>
          )}
          <dl className="rounded border border-[var(--border-strong)] bg-[var(--surface-2)]/50 px-3 py-2 text-[12px]">
            <div className="flex items-center justify-between gap-3 py-0.5">
              <dt className="text-[var(--muted)]">Entry Price</dt>
              <dd className="tabular-nums">
                <span className={entryChanges ? "text-[var(--muted)] line-through" : ""}>
                  {currentEntryPrice > 0 ? currentEntryPrice : "—"}
                </span>
                {entryChanges && (
                  <span className="ml-2 font-medium text-amber-300">
                    {formatAmountInput(solved.entryPrice, 6)}
                  </span>
                )}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3 py-0.5">
              <dt className="text-[var(--muted)]">Deposited (USD)</dt>
              <dd className="tabular-nums">
                <span className={depositedChanges ? "text-[var(--muted)] line-through" : ""}>
                  {currentDeposited > 0 ? formatUsd(currentDeposited) : "—"}
                </span>
                {depositedChanges && newDeposited !== null && (
                  <span className="ml-2 font-medium text-amber-300">
                    {formatUsd(newDeposited)}
                  </span>
                )}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3 py-0.5">
              <dt className="text-[var(--muted)]">Current Balance</dt>
              <dd className="tabular-nums">
                <span className={balanceChanges ? "text-[var(--muted)] line-through" : ""}>
                  {formatUsd(savedCurrentBalance)}
                </span>
                {balanceChanges && newDeposited !== null && (
                  <span className="ml-2 font-medium text-amber-300">
                    {formatUsd(newDeposited)}
                  </span>
                )}
              </dd>
            </div>
          </dl>
          {depositedChanges && !balanceTracksDeposited && (
            <p className="rounded border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-300">
              Current Balance ({formatUsd(savedCurrentBalance)}) holds real
              tracked data from a previous Update, so it is left untouched.
              Because Profit is Current Balance minus Deposited, this position
              will show a Profit that shifts by{" "}
              {newDeposited !== null
                ? formatUsd(currentDeposited - newDeposited)
                : "—"}{" "}
              from this correction alone. Run Update on the position afterwards
              to record its real current value.
            </p>
          )}
          {balanceChanges && (
            <p className="text-[11px] text-[var(--muted)]">
              Current Balance still equals Deposited, so it has never been
              updated on its own — it moves with the correction and Profit
              stays at zero.
            </p>
          )}
          {!entryChanges && !depositedChanges && (
            <p className="text-[11px] text-[var(--muted)]">
              These amounts match what is already recorded — nothing would
              change.
            </p>
          )}
          <p className="text-[11px] text-[var(--muted)]">
            Applying replaces the recorded values when you save this position.
          </p>
        </div>
      )}

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={solved === null || newDeposited === null}
          onClick={() => {
            if (solved === null || newDeposited === null) return;
            onApply(
              solved.entryPrice,
              newDeposited,
              base,
              quote,
              balanceChanges ? newDeposited : null,
            );
          }}
          className="rounded-md bg-amber-500 px-3 py-1.5 text-[12px] font-medium text-black transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Apply recalculation
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-[var(--border-strong)] px-3 py-1.5 text-[12px] font-medium text-[var(--muted)] transition-colors hover:text-[var(--foreground)]"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// Read-only mirror of the closed-position profit on the card, so editing
// Scalp shows its effect before saving. Profit is derived, never stored:
// closed profit = scalp + total fees (Master Formulas).
function ClosedProfitSummary({
  scalp,
  totalFees,
}: {
  scalp: string;
  totalFees: number;
}) {
  const profit = calcClosedProfit(optionalNum(scalp), totalFees);
  return (
    <div className="space-y-1.5">
      <span className="block text-[11px] font-medium uppercase tracking-wider text-[var(--muted)]">
        Profit / Loss
      </span>
      <div
        className={`rounded-md border border-dashed border-[var(--border-strong)] bg-[var(--surface-2)]/40 px-3 py-2 text-sm tabular-nums ${pnlColor(profit)}`}
        aria-live="polite"
      >
        {formatUsd(profit)}
      </div>
      <p className="text-[11px] text-[var(--muted)]">
        Auto: Scalp + Total Fees ({formatUsd(totalFees)} in fees)
      </p>
    </div>
  );
}

// Chooses which fields drive the LP Range section. Add-position only.
function InputModeTabs({
  mode,
  onChange,
}: {
  mode: "price" | "tokens";
  onChange: (mode: "price" | "tokens") => void;
}) {
  const tabs: { key: "price" | "tokens"; label: string }[] = [
    { key: "price", label: "Price & deposit" },
    { key: "tokens", label: "Token amounts" },
  ];
  return (
    <div className="mb-4 space-y-1.5">
      <div
        role="tablist"
        aria-label="Position input method"
        className="inline-flex rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)]/40 p-0.5"
      >
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={mode === tab.key}
            onClick={() => onChange(tab.key)}
            className={`rounded px-3 py-1.5 text-[12px] font-medium transition-colors ${
              mode === tab.key
                ? "bg-[var(--accent-solid)] text-white"
                : "text-[var(--muted)] hover:text-[var(--foreground)]"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-[var(--muted)]">
        {mode === "price"
          ? "Type an entry price or a deposit — the token amounts follow."
          : "Type the exact token amounts from your transaction — the entry price is solved from them."}
      </p>
    </div>
  );
}

// Parses form strings, then delegates to the shared computePositionIL in
// lib/calculations (Invariant #6 — one IL source of truth across pages).
// Form naming: token1 = base token (calcIL token0), token2 = quote token
// (calcIL token1, priced at $1 by convention). Takes primitive fields rather
// than the whole form so memoized callers can declare exact deps.
function tryComputeIL(
  entryPrice: string,
  bottomRange: string,
  topRange: string,
  token1Count: string,
  token2Count: string,
  deposited: string,
  side: "down" | "up",
): ILResult | null {
  if ([entryPrice, bottomRange, topRange].some((v) => v.trim() === "")) {
    return null;
  }
  const rangeDown = Number(bottomRange);
  const rangeUp = Number(topRange);
  return computePositionIL(
    {
      entryPrice: Number(entryPrice),
      rangeDown,
      rangeUp,
      deposited: formDeposited(token1Count, entryPrice, token2Count, deposited),
      token0Count: num(token1Count),
      token1Count: num(token2Count),
    },
    side === "down" ? rangeDown : rangeUp,
  );
}

const ALL_CHAINS = "__all__";

interface DerivedRow {
  position: Position;
  deposited: number;
  claimed: number;
  fees: number;
  days: number;
  apr: number;
  priceDiff: number;
  profit: number;
}

function derive(positions: Position[], allClaims: FeeClaim[]): DerivedRow[] {
  return positions.map((position) => {
    const deposited = getEffectiveDeposited(position);
    const claimed = getEffectiveClaimed(position, allClaims);
    const fees = getEffectiveTotalFees(position, allClaims);
    const days = calcDaysActive(position.entryDatetime, position.exitDatetime);
    const apr = calcFeeAPR(fees, deposited, days);
    const priceDiff = calcPriceDiff(position.currentBalance, deposited);
    const profit = calcPositionProfit(position, fees, priceDiff);
    return { position, deposited, claimed, fees, days, apr, priceDiff, profit };
  });
}

// Every record linked to a position — used both to preview the cascade and to
// execute it, so the count shown and the rows removed can never disagree.
// Transfers link three ways: directly by positionId, by sourceCloseId (upside
// transfers), or by sourceClaimId pointing at one of this position's claims
// (auto fee transfers). The union covers all of them, so nothing is orphaned.
function linkedRecords(
  positionId: string,
  claims: FeeClaim[],
  transfers: Transfer[],
): { claimIds: Set<string>; transferIds: Set<string> } {
  const claimIds = new Set(
    claims.filter((c) => c.positionId === positionId).map((c) => c.id),
  );
  const transferIds = new Set(
    transfers
      .filter(
        (t) =>
          t.positionId === positionId ||
          t.sourceCloseId === positionId ||
          (t.sourceClaimId !== undefined && claimIds.has(t.sourceClaimId)),
      )
      .map((t) => t.id),
  );
  return { claimIds, transferIds };
}

type ModalState =
  | { kind: "none" }
  | { kind: "add" }
  | { kind: "edit"; position: Position }
  | { kind: "update"; position: Position }
  | { kind: "close"; position: Position }
  | { kind: "claim"; position: Position }
  | { kind: "delete"; position: Position };

interface PositionFormState {
  pair: string;
  feeTier: string;
  chain: string;
  protocol: string;
  entryDatetime: string;
  deposited: string;
  scalp: string;
  notes: string;
  entryPrice: string;
  bottomRange: string;
  topRange: string;
  token1Symbol: string;
  token2Symbol: string;
  token1Count: string;
  token2Count: string;
  txLink: string;
  // Close-specific fields. Only surfaced when editing a CLOSED position —
  // ignored entirely for open ones, which have no exit to describe.
  exitDatetime: string;
  closeBalance: string;
  closeTxLink: string;
  // Empty unless a confirmed recalculation decided Current Balance should
  // move with the correction. Never a visible field.
  currentBalanceOverride: string;
  shortDateStart: string;
  shortDateEnd: string;
  shortTokenAmount: string;
  shortUsdAmount: string;
  shortGain: string;
  shortLoss: string;
  shortFundingFees: string;
  shortNotes: string;
}

const EMPTY_FORM: PositionFormState = {
  pair: "",
  feeTier: "",
  chain: "",
  protocol: "",
  entryDatetime: "",
  deposited: "",
  scalp: "",
  notes: "",
  entryPrice: "",
  bottomRange: "",
  topRange: "",
  token1Symbol: "",
  token2Symbol: "",
  token1Count: "",
  token2Count: "",
  txLink: "",
  exitDatetime: "",
  closeBalance: "",
  closeTxLink: "",
  currentBalanceOverride: "",
  shortDateStart: "",
  shortDateEnd: "",
  shortTokenAmount: "",
  shortUsdAmount: "",
  shortGain: "",
  shortLoss: "",
  shortFundingFees: "",
  shortNotes: "",
};

function positionToForm(p: Position): PositionFormState {
  const m = p.pair.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  const pair = m ? m[1] : p.pair;
  const feeTier = m ? m[2] : "";
  const numStr = (n: number | null): string =>
    n === null || !Number.isFinite(n) ? "" : String(n);
  return {
    pair,
    feeTier,
    chain: p.chain,
    protocol: p.protocol,
    entryDatetime: isoToDatetimeLocal(p.entryDatetime),
    // Seed the (now editable) Deposited input from the derived value, not
    // the raw stored one, so legacy records open showing corrected money.
    // Trimmed to cents — the derivation leaves float noise the field would
    // otherwise show as 10927.460001309999.
    deposited: formatAmountInput(getEffectiveDeposited(p), 2),
    scalp: numStr(p.scalp),
    notes: p.notes,
    entryPrice: String(p.entryPrice),
    bottomRange: String(p.bottomRange),
    topRange: String(p.topRange),
    token1Symbol: p.token1Symbol,
    token2Symbol: p.token2Symbol,
    token1Count: String(p.token1Count),
    token2Count: String(p.token2Count),
    txLink: p.txLink ?? "",
    exitDatetime: isoToDatetimeLocal(p.exitDatetime ?? ""),
    closeBalance: formatAmountInput(p.currentBalance, 2),
    closeTxLink: p.closeTxLink ?? "",
    currentBalanceOverride: "",
    shortDateStart: isoToDateInput(p.shortDateStart),
    shortDateEnd: isoToDateInput(p.shortDateEnd),
    shortTokenAmount: numStr(p.shortTokenAmount),
    shortUsdAmount: numStr(p.shortUsdAmount),
    shortGain: numStr(p.shortGain),
    shortLoss: numStr(p.shortLoss),
    shortFundingFees: numStr(p.shortFundingFees),
    shortNotes: p.shortNotes ?? "",
  };
}

interface BuiltRecords {
  position: Position;
  range: LPRange;
  pool: PoolPnLEntry;
}

function buildRecords(
  id: string,
  form: PositionFormState,
  base: Position | null,
): BuiltRecords {
  const trimmedPair = form.pair.trim().toUpperCase();
  const trimmedFeeTier = normalizeFeeTier(form.feeTier);
  const combinedPair = trimmedFeeTier
    ? `${trimmedPair} (${trimmedFeeTier})`
    : trimmedPair;

  const entryIso = form.entryDatetime
    ? new Date(form.entryDatetime).toISOString()
    : new Date().toISOString();
  const isClosed = base?.status === "closed";

  // Stored deposited is a cache of the derived value — rewritten on every
  // Add/Edit save so storage stays in sync with the computed truth.
  const deposited = formDeposited(
    form.token1Count,
    form.entryPrice,
    form.token2Count,
    form.deposited,
  );
  const sGain = optionalNum(form.shortGain);
  const sLoss = optionalNum(form.shortLoss);
  const sFunding = optionalNum(form.shortFundingFees);
  const sTotal = computeShortTotal(sGain, sLoss, sFunding);
  // Stored outOfRangeUpside/Downside are last-computed values and may be
  // stale — readers must always prefer live recomputation via
  // computePositionIL and only fall back to these on corrupt/incomplete
  // records.
  const upIL = tryComputeIL(
    form.entryPrice,
    form.bottomRange,
    form.topRange,
    form.token1Count,
    form.token2Count,
    form.deposited,
    "up",
  );
  const downIL = tryComputeIL(
    form.entryPrice,
    form.bottomRange,
    form.topRange,
    form.token1Count,
    form.token2Count,
    form.deposited,
    "down",
  );
  const ooUp = upIL ? upIL.lpValue : null;
  const ooDown = downIL ? downIL.lpValue : null;

  const position: Position = {
    id,
    pair: combinedPair,
    chain: form.chain.trim().toUpperCase(),
    protocol: form.protocol.trim().toUpperCase(),
    entryDatetime: entryIso,
    // Editable only while editing a closed position; open positions have no
    // exit and must keep null.
    exitDatetime: isClosed
      ? (form.exitDatetime
          ? new Date(form.exitDatetime).toISOString()
          : base?.exitDatetime ?? null)
      : (base?.exitDatetime ?? null),
    deposited,
    // Three ways this can be set, in priority order: the final withdrawn
    // amount typed on a closed position, a confirmed token-amount
    // recalculation (currentBalanceOverride), or carried through untouched.
    currentBalance: isClosed
      ? num(form.closeBalance)
      : form.currentBalanceOverride !== ""
        ? num(form.currentBalanceOverride)
        : (base?.currentBalance ?? deposited),
    newFees: base?.newFees ?? 0,
    claimed: base?.claimed ?? 0,
    totalFees:
      base !== null
        ? calcTotalFees(base.claimed, base.newFees)
        : 0,
    bottomRange: num(form.bottomRange),
    topRange: num(form.topRange),
    token1Symbol: form.token1Symbol.trim().toUpperCase(),
    token2Symbol: form.token2Symbol.trim().toUpperCase(),
    token1Count: num(form.token1Count),
    token2Count: num(form.token2Count),
    entryPrice: num(form.entryPrice),
    shortDateStart: dateInputToIso(form.shortDateStart),
    shortDateEnd: dateInputToIso(form.shortDateEnd),
    shortTokenAmount: optionalNum(form.shortTokenAmount),
    shortUsdAmount: optionalNum(form.shortUsdAmount),
    shortGain: sGain,
    shortLoss: sLoss,
    shortFundingFees: sFunding,
    shortTotal: sTotal,
    shortNotes: form.shortNotes.trim() ? form.shortNotes.trim() : null,
    outOfRangeUpside: ooUp,
    outOfRangeDownside: ooDown,
    scalp: optionalNum(form.scalp),
    txLink: form.txLink.trim() === "" ? null : form.txLink.trim(),
    closeTxLink: isClosed
      ? (form.closeTxLink.trim() === "" ? null : form.closeTxLink.trim())
      : (base?.closeTxLink ?? null),
    // Trimmed but NOT upper-cased: the save path has to agree with the input,
    // or typed case would survive every keystroke and then be lost on Save.
    notes: form.notes.trim(),
    status: base?.status ?? "active",
  };

  const range: LPRange = {
    id,
    positionId: id,
    pair: position.pair,
    entryPrice: position.entryPrice,
    bottomRange: position.bottomRange,
    topRange: position.topRange,
    token1Symbol: position.token1Symbol,
    token2Symbol: position.token2Symbol,
    token1Count: position.token1Count,
    token2Count: position.token2Count,
    entryDatetime: position.entryDatetime,
  };

  const pool: PoolPnLEntry = {
    id,
    positionId: id,
    pair: position.pair,
    chain: position.chain,
    protocol: position.protocol,
    shortDateStart: position.shortDateStart,
    shortDateEnd: position.shortDateEnd,
    shortTokenAmount: position.shortTokenAmount,
    shortUsdAmount: position.shortUsdAmount,
    shortGain: position.shortGain,
    shortLoss: position.shortLoss,
    shortFundingFees: position.shortFundingFees,
    shortTotal: position.shortTotal,
    shortNotes: position.shortNotes,
    outOfRangeUpside: position.outOfRangeUpside,
    outOfRangeDownside: position.outOfRangeDownside,
    entryDatetime: position.entryDatetime,
  };

  return { position, range, pool };
}

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

  const persistFull = (records: BuiltRecords, mode: "add" | "edit") => {
    if (mode === "add") {
      savePositions([...getPositions(), records.position]);
      saveRanges([...getRanges(), records.range]);
      savePoolPnL([...getPoolPnL(), records.pool]);
    } else {
      savePositions(
        getPositions().map((p) =>
          p.id === records.position.id ? records.position : p,
        ),
      );
      const ranges = getRanges();
      const hasRange = ranges.some((r) => r.positionId === records.range.positionId);
      saveRanges(
        hasRange
          ? ranges.map((r) =>
              r.positionId === records.range.positionId ? records.range : r,
            )
          : [...ranges, records.range],
      );
      const pools = getPoolPnL();
      const hasPool = pools.some((p) => p.positionId === records.pool.positionId);
      savePoolPnL(
        hasPool
          ? pools.map((p) =>
              p.positionId === records.pool.positionId ? records.pool : p,
            )
          : [...pools, records.pool],
      );
    }
    refresh();
    setModal({ kind: "none" });
  };

  const handleAdd = (form: PositionFormState) => {
    persistFull(buildRecords(newId(), form, null), "add");
  };

  const handleEdit = (target: Position, form: PositionFormState) => {
    persistFull(buildRecords(target.id, form, target), "edit");
  };

  // Claimed is no longer part of the payload — it is derived from claim
  // records (Invariant #10); the stored value stays as legacy fallback.
  const handleUpdate = (
    target: Position,
    next: { currentBalance: number; newFees: number },
  ) => {
    const updated = getPositions().map((p) =>
      p.id === target.id
        ? {
            ...p,
            currentBalance: next.currentBalance,
            newFees: next.newFees,
            totalFees: calcTotalFees(p.claimed, next.newFees),
          }
        : p,
    );
    savePositions(updated);
    refresh();
    setModal({ kind: "none" });
  };

  // Shared claim save path (persistNewClaim) — identical to the Fee Claims
  // page so both entry points update position totals the same way.
  const handleClaimSubmit = (claim: FeeClaim) => {
    persistNewClaim(claim);
    refresh();
    setModal({ kind: "none" });
  };

  const handleClose = (
    target: Position,
    next: {
      exitDatetime: string;
      currentBalance: number;
      scalp: number | null;
      closeTxLink: string | null;
      rangeExit: "above" | "below" | "in" | "";
      feeClaim?: {
        token1Amount: number;
        token2Amount: number;
        stableAmount: number | null;
        convertedToStable: boolean;
        stableSymbol: string | null;
        txId: string | null;
      };
    },
  ) => {
    // Claim is created BEFORE the position is closed: if anything throws
    // between the two writes, the position stays open with a logged claim
    // (harmless, retryable) rather than closed with silently lost fees.
    if (next.feeClaim) {
      persistNewClaim({
        id: newId(),
        positionId: target.id,
        date: next.exitDatetime,
        pair: target.pair,
        platform: target.protocol,
        chain: target.chain,
        token1Symbol: target.token1Symbol,
        token1Amount: next.feeClaim.token1Amount,
        token2Symbol: target.token2Symbol,
        token2Amount: next.feeClaim.token2Amount,
        convertedToStable: next.feeClaim.convertedToStable,
        stableSymbol: next.feeClaim.stableSymbol,
        stableAmount: next.feeClaim.stableAmount,
        currentPositionValue: null,
        txId: next.feeClaim.txId,
        notes: "",
      });
    }

    const closedPosition: Position = {
      ...target,
      exitDatetime: next.exitDatetime,
      currentBalance: next.currentBalance,
      scalp: next.scalp,
      closeTxLink: next.closeTxLink,
      status: "closed" as const,
    };
    const updated = getPositions().map((p) =>
      p.id === target.id ? closedPosition : p,
    );
    savePositions(updated);

    // Above-range exit with a real profit -> set that profit aside as an
    // Out-of-Range-Upside transfer (Transfers automation, Phase B). Gated on
    // an explicit user choice because exit side is otherwise undetectable, and
    // skipped when scalp <= 0 (nothing to set aside). Idempotent by
    // sourceCloseId, so re-closing never duplicates.
    if (next.rangeExit === "above" && (next.scalp ?? 0) > 0) {
      createUpsideTransfer(closedPosition);
    }

    refresh();
    setModal({ kind: "none" });
  };

  // Permanent cascade delete: the position plus every record that references
  // it. Reads fresh from storage so the delete works on the true current data,
  // not a possibly-stale render snapshot.
  const handleDeletePosition = (target: Position) => {
    const allClaims = getClaims();
    const allTransfers = getTransfers();
    const { claimIds, transferIds } = linkedRecords(
      target.id,
      allClaims,
      allTransfers,
    );
    savePositions(getPositions().filter((p) => p.id !== target.id));
    saveClaims(allClaims.filter((c) => !claimIds.has(c.id)));
    saveTransfers(allTransfers.filter((t) => !transferIds.has(t.id)));
    saveRanges(getRanges().filter((r) => r.positionId !== target.id));
    savePoolPnL(getPoolPnL().filter((p) => p.positionId !== target.id));
    const prices = { ...getPositionPrices() };
    delete prices[target.id];
    savePositionPrices(prices);
    refresh();
    setModal({ kind: "none" });
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

      {modal.kind === "add" && (
        <PositionFormModal
          title="Add Position"
          submitLabel="Add Position"
          initial={{ ...EMPTY_FORM, entryDatetime: nowDatetimeLocal() }}
          onCancel={() => setModal({ kind: "none" })}
          onSubmit={handleAdd}
        />
      )}
      {modal.kind === "edit" && (
        <PositionFormModal
          title={`Edit — ${modal.position.pair}`}
          submitLabel="Save Changes"
          initial={positionToForm(modal.position)}
          editingStatus={modal.position.status}
          savedDeposited={modal.position.deposited}
          savedCurrentBalance={modal.position.currentBalance}
          closedTotalFees={getEffectiveTotalFees(modal.position, claims)}
          exitDatetime={modal.position.exitDatetime}
          onCancel={() => setModal({ kind: "none" })}
          onSubmit={(form) => handleEdit(modal.position, form)}
        />
      )}
      {modal.kind === "update" && (
        <UpdatePositionModal
          position={modal.position}
          derivedClaimed={getEffectiveClaimed(modal.position, claims)}
          onCancel={() => setModal({ kind: "none" })}
          onSubmit={(next) => handleUpdate(modal.position, next)}
        />
      )}
      {modal.kind === "claim" && (
        <ClaimFormModal
          mode="add"
          positions={positions}
          lockedPositionId={modal.position.id}
          onCancel={() => setModal({ kind: "none" })}
          onSubmit={handleClaimSubmit}
        />
      )}
      {modal.kind === "close" && (
        <ClosePositionModal
          position={modal.position}
          onCancel={() => setModal({ kind: "none" })}
          onSubmit={(next) => handleClose(modal.position, next)}
        />
      )}
      {modal.kind === "delete" && (
        <DeletePositionModal
          position={modal.position}
          counts={(() => {
            const { claimIds, transferIds } = linkedRecords(
              modal.position.id,
              claims,
              getTransfers(),
            );
            return { claims: claimIds.size, transfers: transferIds.size };
          })()}
          onCancel={() => setModal({ kind: "none" })}
          onConfirm={() => handleDeletePosition(modal.position)}
        />
      )}
    </section>
  );
}

interface TxLinkBadgeProps {
  value: string | null;
}

function TxLinkBadge({ value }: TxLinkBadgeProps) {
  if (!value) return null;
  const isUrl = /^https?:\/\//i.test(value);
  if (isUrl) {
    return (
      <a
        href={value}
        target="_blank"
        rel="noopener noreferrer"
        title="Open transaction"
        aria-label="Open transaction"
        className="text-[var(--accent)] hover:opacity-80"
        onClick={(e) => e.stopPropagation()}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          className="h-3.5 w-3.5"
          aria-hidden
        >
          <path
            d="M14 4h6v6M20 4l-9 9M10 6H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </a>
    );
  }
  const hint = value.length > 8 ? `${value.slice(0, 8)}…` : value;
  return (
    <span
      title={value}
      className="font-mono text-[10px] text-[var(--muted)]"
      aria-label={`Transaction ${hint}`}
    >
      {hint}
    </span>
  );
}

function rangeStatusMeta(status: RangeHealth["status"]): {
  label: string;
  cls: string;
} {
  switch (status) {
    case "safe":
      return {
        label: "In Range",
        cls: "bg-emerald-500/10 text-emerald-300 ring-emerald-500/30",
      };
    case "close":
      return {
        label: "Getting Close",
        cls: "bg-amber-500/10 text-amber-300 ring-amber-500/30",
      };
    case "out":
      return {
        label: "Out of Range",
        cls: "bg-rose-500/10 text-rose-300 ring-rose-500/30",
      };
    default:
      return {
        label: "Price needed",
        cls: "bg-[var(--surface-2)] text-[var(--muted)] ring-[var(--border-strong)]",
      };
  }
}

function rangeHealthDetail(health: RangeHealth): string {
  if (health.status === "out") {
    return health.distanceToLowerPct !== null && health.distanceToLowerPct < 0
      ? "below range"
      : "above range";
  }
  if (health.nearestEdgePct === null) return "";
  return `${health.nearestEdgePct.toFixed(1)}% to edge`;
}

function RangeBadge({ status }: { status: RangeHealth["status"] }) {
  const meta = rangeStatusMeta(status);
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ring-1 ring-inset whitespace-nowrap ${meta.cls}`}
    >
      {meta.label}
    </span>
  );
}

// Prices are quote-per-base, not USD — formatted as plain numbers with
// enough precision for low-priced pairs without trailing noise on large ones.
function formatPrice(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const decimals = value >= 100 ? 2 : value >= 1 ? 4 : 6;
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
}

const RANGE_BAR_TONE: Record<RangeStatus, { fill: string; text: string }> = {
  safe: { fill: "bg-emerald-400", text: "text-emerald-300" },
  close: { fill: "bg-amber-400", text: "text-amber-300" },
  out: { fill: "bg-rose-400", text: "text-rose-300" },
  unknown: { fill: "bg-[var(--muted)]", text: "text-[var(--muted)]" },
};

// Where price sits between the range bounds, drawn rather than described.
// bandPosition is 0 at the bottom edge and 1 at the top; it runs outside that
// when a position has drifted out of range, so the marker is clamped to the
// track and the caption carries the real distance.
function RangeBar({
  health,
  entryPrice,
  rangeDown,
  rangeUp,
}: {
  health: RangeHealth;
  entryPrice: number;
  rangeDown: number;
  rangeUp: number;
}) {
  const span = rangeUp - rangeDown;
  const tone = RANGE_BAR_TONE[health.status];
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  const pricePct =
    health.bandPosition === null ? null : clamp(health.bandPosition) * 100;
  const entryPct = span > 0 ? clamp((entryPrice - rangeDown) / span) * 100 : null;

  return (
    <div className="mt-3">
      <div className="relative h-1.5 rounded-full bg-[var(--surface-2)]">
        {entryPct !== null && (
          <span
            className="absolute top-1/2 h-3 w-px -translate-x-1/2 -translate-y-1/2 bg-[var(--muted)]/70"
            style={{ left: `${entryPct}%` }}
            aria-hidden
          />
        )}
        {pricePct !== null && (
          <span
            className={`absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-[var(--surface)] ${tone.fill}`}
            style={{ left: `${pricePct}%` }}
            aria-hidden
          />
        )}
      </div>
      <div className="mt-1.5 flex items-baseline justify-between gap-2 text-[11px] tabular-nums text-[var(--muted)]">
        <span>{formatPrice(rangeDown)}</span>
        <span className={tone.text}>{rangeHealthDetail(health)}</span>
        <span>{formatPrice(rangeUp)}</span>
      </div>
    </div>
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

// One metric in the card's grid. Kept tiny so the grid stays declarative.
function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div>
      <dt className="text-[10px] font-medium uppercase tracking-wider text-[var(--muted)]">
        {label}
      </dt>
      <dd
        className={`mt-0.5 text-sm tabular-nums ${tone ?? "text-[var(--foreground)]"}`}
      >
        {value}
      </dd>
    </div>
  );
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
  const { position, deposited, claimed, fees, days, apr, priceDiff, profit } = row;
  const [showDetails, setShowDetails] = useState(false);
  const wideRange = calcWideRangePercent(position.bottomRange, position.topRange);
  const isActive = variant === "active";
  // Closed positions are dimmed but never hidden (Invariant #4).
  const priceUnresolved = isActive && (!health || health.status === "unknown");

  return (
    <article
      className={`rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4 transition-colors hover:border-[var(--border-strong)] ${
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
        onClick={() => setShowDetails((v) => !v)}
        aria-expanded={showDetails}
        className="mt-3 text-[11px] font-medium text-[var(--muted)] transition-colors hover:text-[var(--foreground)]"
      >
        {showDetails ? "Hide details" : "Details"} {showDetails ? "▴" : "▾"}
      </button>

      {showDetails && (
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-[var(--border)] pt-3 sm:grid-cols-3">
          <Metric label="New Fees" value={formatUsd(position.newFees)} />
          <Metric label="Claimed" value={formatUsd(claimed)} />
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
          onClick={() => onEdit?.(position)}
          className="rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)] px-2.5 py-1 text-xs font-medium text-[var(--foreground)] hover:bg-[var(--surface-2)]/70"
        >
          Edit
        </button>
        {isActive && (
          <button
            type="button"
            onClick={() => onUpdate?.(position)}
            className="rounded-md border border-[var(--accent)]/40 bg-[var(--accent)]/10 px-2.5 py-1 text-xs font-medium text-[var(--accent)] hover:bg-[var(--accent)]/20"
          >
            Update
          </button>
        )}
        <button
          type="button"
          onClick={() => onClaim?.(position)}
          className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-300 hover:bg-emerald-500/20"
        >
          Claim
        </button>
        {isActive && (
          <button
            type="button"
            onClick={() => onClose?.(position)}
            className="rounded-md border border-rose-500/30 bg-rose-500/10 px-2.5 py-1 text-xs font-medium text-rose-300 hover:bg-rose-500/20"
          >
            Close
          </button>
        )}
        {onDelete && (
          <button
            type="button"
            onClick={() => onDelete(position)}
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
  const { position, deposited, claimed, fees, days, apr, priceDiff, profit } =
    row;
  const [open, setOpen] = useState(false);
  const isActive = variant === "active";
  const wideRange = calcWideRangePercent(position.bottomRange, position.topRange);

  return (
    <div className={isActive ? "" : "opacity-75"}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
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
            <Metric label="Claimed" value={formatUsd(claimed)} />
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
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => onEdit?.(position)}
              className="rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)] px-2.5 py-1 text-xs font-medium text-[var(--foreground)] hover:bg-[var(--surface-2)]/70"
            >
              Edit
            </button>
            {isActive && (
              <button
                type="button"
                onClick={() => onUpdate?.(position)}
                className="rounded-md border border-[var(--accent)]/40 bg-[var(--accent)]/10 px-2.5 py-1 text-xs font-medium text-[var(--accent)] hover:bg-[var(--accent)]/20"
              >
                Update
              </button>
            )}
            <button
              type="button"
              onClick={() => onClaim?.(position)}
              className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-300 hover:bg-emerald-500/20"
            >
              Claim
            </button>
            {isActive && (
              <button
                type="button"
                onClick={() => onClose?.(position)}
                className="rounded-md border border-rose-500/30 bg-rose-500/10 px-2.5 py-1 text-xs font-medium text-rose-300 hover:bg-rose-500/20"
              >
                Close
              </button>
            )}
            {onDelete && (
              <button
                type="button"
                onClick={() => onDelete(position)}
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

// Permanent cascade-delete confirmation (Part 3). Shows the exact record counts
// that will be destroyed and requires the user to type the pair to confirm —
// there is no undo, so a single mis-click cannot wipe out financial history.
function DeletePositionModal({
  position,
  counts,
  onCancel,
  onConfirm,
}: {
  position: Position;
  counts: { claims: number; transfers: number };
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState("");
  const confirmed =
    typed.trim().toUpperCase() === position.pair.trim().toUpperCase();
  return (
    <ModalShell title={`Delete ${position.pair}?`} onCancel={onCancel}>
      <div className="space-y-4 px-5 py-5">
        <div className="rounded-md border border-rose-500/40 bg-rose-500/[0.07] px-4 py-3 text-sm text-[var(--foreground)]">
          <p className="font-medium text-rose-300">
            This will permanently delete:
          </p>
          <ul className="mt-2 space-y-1 text-[13px] tabular-nums">
            <li>1 position ({position.pair})</li>
            <li>
              {counts.claims} fee {counts.claims === 1 ? "claim" : "claims"}
            </li>
            <li>
              {counts.transfers}{" "}
              {counts.transfers === 1 ? "transfer" : "transfers"}
            </li>
          </ul>
          <p className="mt-3 text-[12px] font-medium text-rose-300">
            This cannot be undone.
          </p>
        </div>
        <div className="space-y-1.5">
          <label
            htmlFor="delete-confirm"
            className="block text-[11px] font-medium uppercase tracking-wider text-[var(--muted)]"
          >
            Type{" "}
            <span className="font-semibold text-[var(--foreground)]">
              {position.pair}
            </span>{" "}
            to confirm
          </label>
          <input
            id="delete-confirm"
            className={inputClass}
            autoComplete="off"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={position.pair}
          />
        </div>
      </div>
      <div className="flex justify-end gap-2 px-5 py-4">
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex h-9 items-center justify-center rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)] px-4 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--surface-2)]/70"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={!confirmed}
          onClick={onConfirm}
          className="inline-flex h-9 items-center justify-center rounded-md bg-rose-600 px-4 text-sm font-medium text-white shadow-sm transition-colors hover:bg-rose-600 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Delete permanently
        </button>
      </div>
    </ModalShell>
  );
}

interface ModalShellProps {
  title: string;
  onCancel: () => void;
  children: ReactNode;
}

function ModalShell({ title, onCancel, children }: ModalShellProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 px-4 py-8"
      onClick={onCancel}
      role="presentation"
    >
      <div
        className="w-full max-w-2xl rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-4">
          <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md p-1 text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--foreground)]"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

interface DateTimeFieldsProps {
  dateLabel: string;
  timeLabel: string;
  idPrefix: string;
  value: string;
  onChange: (next: string) => void;
  required?: boolean;
}

function DateTimeFields({
  dateLabel,
  timeLabel,
  idPrefix,
  value,
  onChange,
  required,
}: DateTimeFieldsProps) {
  const [d = "", t = ""] = (value || "").split("T");
  const [hStr = "", mStr = ""] = (t || "").split(":");
  const dateId = `${idPrefix}-date`;
  const hourId = `${idPrefix}-hour`;
  const minId = `${idPrefix}-min`;

  const pad2 = (n: number) => String(n).padStart(2, "0");

  const setDate = (newDate: string) => {
    onChange(`${newDate}T${hStr || "00"}:${mStr || "00"}`);
  };
  const setHour = (raw: string) => {
    const digits = raw.replace(/\D/g, "").slice(-2);
    const n =
      digits === ""
        ? 0
        : Math.max(0, Math.min(23, Number.parseInt(digits, 10) || 0));
    onChange(`${d}T${pad2(n)}:${mStr || "00"}`);
  };
  const setMin = (raw: string) => {
    const digits = raw.replace(/\D/g, "").slice(-2);
    const n =
      digits === ""
        ? 0
        : Math.max(0, Math.min(59, Number.parseInt(digits, 10) || 0));
    onChange(`${d}T${hStr || "00"}:${pad2(n)}`);
  };

  return (
    <>
      <Field label={dateLabel} htmlFor={dateId}>
        <div suppressHydrationWarning>
          <input
            id={dateId}
            type="date"
            required={required}
            className={inputClass}
            style={{ colorScheme: "dark" }}
            value={d}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
      </Field>
      <Field
        label={timeLabel}
        htmlFor={hourId}
        hint="24hr format — e.g. 13:44"
      >
        <div className="flex items-center gap-2" suppressHydrationWarning>
          <input
            id={hourId}
            type="number"
            min={0}
            max={23}
            placeholder="HH"
            required={required}
            className={`${inputClass} w-[70px] text-center`}
            style={{ colorScheme: "dark" }}
            value={hStr}
            onChange={(e) => setHour(e.target.value)}
            aria-label={`${timeLabel} hour`}
          />
          <span className="text-[var(--muted)]" aria-hidden>
            :
          </span>
          <input
            id={minId}
            type="number"
            min={0}
            max={59}
            placeholder="MM"
            required={required}
            className={`${inputClass} w-[70px] text-center`}
            style={{ colorScheme: "dark" }}
            value={mStr}
            onChange={(e) => setMin(e.target.value)}
            aria-label={`${timeLabel} minute`}
          />
        </div>
      </Field>
    </>
  );
}

interface FieldProps {
  label: string;
  htmlFor: string;
  children: ReactNode;
  hint?: string;
}

function Field({ label, htmlFor, children, hint }: FieldProps) {
  return (
    <div className="space-y-1.5">
      <label
        htmlFor={htmlFor}
        className="block text-[11px] font-medium uppercase tracking-wider text-[var(--muted)]"
      >
        {label}
      </label>
      {children}
      {hint && <p className="text-[11px] text-[var(--muted)]">{hint}</p>}
    </div>
  );
}

// Plausibility warning (Invariant #8): exit before entry is impossible but
// was silently accepted — Days Active clamps to 0 and APR reads 0%. Warns
// without blocking so users can still correct whichever date is wrong.
function DateOrderWarning({
  entry,
  exit,
}: {
  entry: string;
  exit: string | null | undefined;
}) {
  if (!entry || !exit) return null;
  const entryMs = new Date(entry).getTime();
  const exitMs = new Date(exit).getTime();
  if (!Number.isFinite(entryMs) || !Number.isFinite(exitMs)) return null;
  if (exitMs >= entryMs) return null;
  return (
    <p className="text-xs font-medium text-amber-400 sm:col-span-2">
      ⚠ Exit date is earlier than entry date — Days Active will count as 0 and
      Fee APR will show 0%. Please check the dates.
    </p>
  );
}

const inputClass =
  "block w-full rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--foreground)] placeholder:text-[var(--muted)]/60 [color-scheme:dark] caret-[var(--accent)] focus:border-[var(--accent)] focus:bg-[var(--surface-2)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]";

interface PositionFormModalProps {
  title: string;
  submitLabel: string;
  initial: PositionFormState;
  editingStatus?: Position["status"];
  exitDatetime?: string | null;
  // Raw stored values of the position being edited. The recalculation's
  // case decision compares these two directly — NOT the derived Deposited,
  // which can differ from the stored figure by rounding and would
  // misclassify an untouched balance as real tracked data.
  savedDeposited?: number;
  savedCurrentBalance?: number;
  // Effective total fees for the position being edited, so the closed-position
  // Profit/Loss summary matches the card exactly (Invariant #10).
  closedTotalFees?: number;
  onCancel: () => void;
  onSubmit: (form: PositionFormState) => void;
}

function PositionFormModal({
  title,
  submitLabel,
  initial,
  editingStatus,
  exitDatetime,
  savedDeposited,
  savedCurrentBalance,
  closedTotalFees = 0,
  onCancel,
  onSubmit,
}: PositionFormModalProps) {
  const [form, setForm] = useState<PositionFormState>(initial);
  // Tracks whether the user hand-typed a token count. Auto-split still wins
  // (it must, or Deposited and the token counts could disagree), but when it
  // overwrites hand-typed amounts we say so instead of changing them silently.
  const [tokensTouched, setTokensTouched] = useState(false);
  const [splitWarning, setSplitWarning] = useState<TokenSplitWarning | null>(
    null,
  );
  // Set when a typed deposit exceeded what this position size can be worth,
  // holding the formatted ceiling for the note.
  const [clampNote, setClampNote] = useState<string | null>(null);
  // editingStatus is only passed from the Edit call site.
  const isEditing = editingStatus !== undefined;
  // Which fields drive the rest. "price" is the existing behaviour — entry
  // price and Deposited both editable and linked. "tokens" makes the token
  // amounts the source of truth and solves the entry price from them. Add
  // only: Edit must never rewrite a recorded position from derived numbers.
  const [inputMode, setInputMode] = useState<"price" | "tokens">("price");
  // Shape of the last token-driven solve, for the explanatory note.
  const [solvedShape, setSolvedShape] = useState<
    EntryPriceFromTokens["shape"] | null
  >(null);
  const tokenMode = !isEditing && inputMode === "tokens";
  // Edit-mode correction tool. Opt-in and confirmed — the normal Entry Price
  // field keeps its protection (re-split tokens only, never touch Deposited).
  const [recalcOpen, setRecalcOpen] = useState(false);
  const [recalcApplied, setRecalcApplied] = useState<RecalcSummary | null>(null);
  // Exact comparison of the two stored figures (tight epsilon only to absorb
  // float representation). A balance that still equals the deposit was never
  // independently updated and is safe to move with a correction.
  const balanceTracksDeposited =
    savedDeposited !== undefined &&
    savedCurrentBalance !== undefined &&
    Math.abs(savedCurrentBalance - savedDeposited) <= 1e-8;

  const set = <K extends keyof PositionFormState>(
    key: K,
    value: PositionFormState[K],
  ) => setForm((prev) => ({ ...prev, [key]: value }));

  // Writes the token counts implied by a (liquidity, entry price, range)
  // triple, flagging the case where that replaces hand-typed amounts.
  const applyTokens = (
    next: PositionFormState,
    split: TokenSplit | null,
  ): void => {
    if (!split) return;
    const baseCount = formatAmountInput(split.baseCount, 8);
    const quoteCount = formatAmountInput(split.quoteCount, 8);
    if (
      tokensTouched &&
      (baseCount !== form.token1Count || quoteCount !== form.token2Count)
    ) {
      setSplitWarning({ base: form.token1Count, quote: form.token2Count });
      setTokensTouched(false);
    }
    next.token1Count = baseCount;
    next.token2Count = quoteCount;
  };

  // Entry price and Deposited are two views of one position of a fixed size.
  // Once both are known the position's liquidity is pinned, and from then on
  // moving either one slides along the LP value curve and drags the other
  // with it — the same curve the out-of-range projections already use. Only
  // live when adding: on a saved position the recorded deposit must not move
  // just because an entry-price typo is corrected.
  const linkEntryAndDeposited = !isEditing;

  const setAnchor = (
    key: "deposited" | "entryPrice" | "bottomRange" | "topRange",
    value: string,
  ) => {
    const next: PositionFormState = { ...form, [key]: value };
    const rangeDown = num(next.bottomRange);
    const rangeUp = num(next.topRange);
    setClampNote(null);

    // Size of the position implied by what is currently on screen, before
    // this edit is folded in. Null until both numbers exist — the first pair
    // typed defines the position rather than moving it.
    const pinned = liquidityFromDeposited(
      num(form.deposited),
      num(form.entryPrice),
      num(form.bottomRange),
      num(form.topRange),
    );

    if (linkEntryAndDeposited && pinned !== null && key === "entryPrice") {
      const deposited = depositedFromLiquidity(
        pinned,
        num(value),
        rangeDown,
        rangeUp,
      );
      if (deposited !== null) {
        next.deposited = formatAmountInput(deposited, 2);
      }
    } else if (linkEntryAndDeposited && pinned !== null && key === "deposited") {
      const solved = entryPriceFromDeposited(
        num(value),
        pinned,
        rangeDown,
        rangeUp,
      );
      if (solved) {
        next.entryPrice = formatAmountInput(solved.entryPrice, 6);
        if (solved.clamped) {
          setClampNote(formatUsd(solved.maxDeposited));
          next.deposited = formatAmountInput(solved.maxDeposited, 2);
        }
      }
    }

    // Range edits keep the money fixed and re-split it (changing your range
    // is choosing a different position, not moving along one curve).
    applyTokens(
      next,
      splitDepositedIntoTokens(
        num(next.deposited),
        num(next.entryPrice),
        rangeDown,
        rangeUp,
      ),
    );
    setForm(next);
  };

  // Typing a token count directly hands control back to the user: Deposited
  // recomputes from the tokens (the original one-way flow) and auto-split
  // stops overwriting until the anchor fields move again.
  //
  // In token-amount mode the token counts are instead the source of truth:
  // the entry price is solved from them, so a position can be recorded from
  // on-chain transaction amounts rather than an estimated price.
  const setTokenCount = (
    key: "token1Count" | "token2Count",
    value: string,
  ) => {
    const next: PositionFormState = { ...form, [key]: value };

    if (inputMode === "tokens") {
      const solved = entryPriceFromTokens(
        num(next.token1Count),
        num(next.token2Count),
        num(next.bottomRange),
        num(next.topRange),
      );
      setSolvedShape(solved ? solved.shape : null);
      if (solved) {
        next.entryPrice = formatAmountInput(solved.entryPrice, 6);
      }
    }

    const computed = formDeposited(
      next.token1Count,
      next.entryPrice,
      next.token2Count,
      next.deposited,
    );
    next.deposited = computed > 0 ? formatAmountInput(computed, 2) : "";
    setTokensTouched(true);
    setSplitWarning(null);
    // Typing a token count is also how you resize past the value ceiling:
    // Deposited follows the tokens here, which re-pins the position size for
    // the next entry-price edit.
    setClampNote(null);
    setForm(next);
  };

  // Range bounds are what the entry price is solved against, so in token
  // mode moving a bound re-solves from the same token amounts.
  const setRangeBound = (
    key: "bottomRange" | "topRange",
    value: string,
  ) => {
    if (inputMode !== "tokens") {
      setAnchor(key, value);
      return;
    }
    const next: PositionFormState = { ...form, [key]: value };
    const solved = entryPriceFromTokens(
      num(next.token1Count),
      num(next.token2Count),
      num(next.bottomRange),
      num(next.topRange),
    );
    setSolvedShape(solved ? solved.shape : null);
    if (solved) {
      next.entryPrice = formatAmountInput(solved.entryPrice, 6);
    }
    const computed = formDeposited(
      next.token1Count,
      next.entryPrice,
      next.token2Count,
      next.deposited,
    );
    next.deposited = computed > 0 ? formatAmountInput(computed, 2) : "";
    setClampNote(null);
    setForm(next);
  };

  const upper = (key: keyof PositionFormState) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => set(key, e.target.value.toUpperCase());

  const shortTotal = useMemo(
    () =>
      computeShortTotal(
        optionalNum(form.shortGain),
        optionalNum(form.shortLoss),
        optionalNum(form.shortFundingFees),
      ),
    [form.shortGain, form.shortLoss, form.shortFundingFees],
  );

  const downsideIL = useMemo(
    () =>
      tryComputeIL(
        form.entryPrice,
        form.bottomRange,
        form.topRange,
        form.token1Count,
        form.token2Count,
        form.deposited,
        "down",
      ),
    [
      form.entryPrice,
      form.bottomRange,
      form.topRange,
      form.deposited,
      form.token1Count,
      form.token2Count,
    ],
  );
  const upsideIL = useMemo(
    () =>
      tryComputeIL(
        form.entryPrice,
        form.bottomRange,
        form.topRange,
        form.token1Count,
        form.token2Count,
        form.deposited,
        "up",
      ),
    [
      form.entryPrice,
      form.bottomRange,
      form.topRange,
      form.deposited,
      form.token1Count,
      form.token2Count,
    ],
  );

  // Deposited USD stays the derived audit value even though it is now
  // typeable — setAnchor keeps the token counts consistent with whatever is
  // in the field, so this recomputation agrees with it (Invariant #9).
  const effectiveDeposited = useMemo(
    () =>
      formDeposited(
        form.token1Count,
        form.entryPrice,
        form.token2Count,
        form.deposited,
      ),
    [form.token1Count, form.entryPrice, form.token2Count, form.deposited],
  );

  // Scalp is the price difference and is always knowable from the two figures
  // already on screen, so it is filled in rather than left to sit at 0.
  const setCloseBalanceAndScalp = (value: string) => {
    const balance = Number(value);
    setForm((prev) => ({
      ...prev,
      closeBalance: value,
      scalp:
        value.trim() !== "" && Number.isFinite(balance)
          ? formatAmountInput(
              calcScalpFromWithdrawn(balance, effectiveDeposited),
              2,
              true,
            )
          : prev.scalp,
    }));
  };

  const suggestedScalp = calcScalpFromWithdrawn(
    num(form.closeBalance),
    effectiveDeposited,
  );
  // Explicit, never automatic — a real round-trip genuinely has Scalp 0, and
  // only the user can tell that apart from the old blank-Scalp bug.
  const recalcScalp = () => {
    set("scalp", formatAmountInput(suggestedScalp, 2, true));
  };
  // Projections are a live decision aid while open; once closed the real
  // result is recorded and these become reference figures only.
  const isClosedPosition = editingStatus === "closed";
  const scalpLooksWrong =
    isEditing &&
    editingStatus === "closed" &&
    num(form.scalp) === 0 &&
    Math.abs(suggestedScalp) > 0.01;

  const wideRangePct = useMemo(
    () => calcWideRangePercent(num(form.bottomRange), num(form.topRange)),
    [form.bottomRange, form.topRange],
  );

  const downsideProfit =
    downsideIL && effectiveDeposited > 0
      ? downsideIL.lpValue - effectiveDeposited
      : null;
  const upsideProfit =
    upsideIL && effectiveDeposited > 0
      ? upsideIL.lpValue - effectiveDeposited
      : null;

  const netDownside =
    downsideProfit === null
      ? null
      : (shortTotal ?? 0) + downsideProfit;
  const netUpside =
    upsideProfit === null ? null : (shortTotal ?? 0) + upsideProfit;

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    onSubmit({ ...form, feeTier: normalizeFeeTier(form.feeTier) });
  };

  return (
    <ModalShell title={title} onCancel={onCancel}>
      <form onSubmit={submit} className="divide-y divide-[var(--border)]">
        <Section title="Position Details">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Pair" htmlFor="pair">
              <input
                id="pair"
                required
                className={inputClass}
                placeholder="ETH/USDC"
                value={form.pair}
                onChange={upper("pair")}
              />
            </Field>
            <Field label="Fee Tier" htmlFor="feeTier">
              <input
                id="feeTier"
                required
                className={inputClass}
                placeholder="0.05%"
                value={form.feeTier}
                onChange={(e) => set("feeTier", e.target.value)}
                onFocus={() =>
                  set("feeTier", form.feeTier.replace(/%\s*$/, ""))
                }
                onBlur={() => set("feeTier", normalizeFeeTier(form.feeTier))}
              />
            </Field>
            <Field label="Chain" htmlFor="chain">
              <input
                id="chain"
                required
                className={inputClass}
                placeholder="ETH"
                value={form.chain}
                onChange={upper("chain")}
              />
            </Field>
            <Field label="Protocol" htmlFor="protocol">
              <input
                id="protocol"
                required
                className={inputClass}
                placeholder="Aerodrome"
                value={form.protocol}
                onChange={upper("protocol")}
              />
            </Field>
            <DateTimeFields
              dateLabel="Entry Date"
              timeLabel="Entry Time (24h)"
              idPrefix="entry"
              value={form.entryDatetime}
              onChange={(v) => set("entryDatetime", v)}
              required
            />
            <DateOrderWarning
              entry={form.entryDatetime}
              exit={editingStatus === "closed" ? form.exitDatetime : exitDatetime}
            />
            {editingStatus === "closed" && (
              <>
                <DateTimeFields
                  dateLabel="Exit Date"
                  timeLabel="Exit Time (24h)"
                  idPrefix="exit"
                  value={form.exitDatetime}
                  onChange={(v) => set("exitDatetime", v)}
                />
                <Field
                  label="Final Withdrawn Amount (USD)"
                  htmlFor="closeBalance"
                  hint={`What the position was worth when you closed it. Deposited was ${formatUsd(effectiveDeposited)}.`}
                >
                  <input
                    id="closeBalance"
                    type="number"
                    step="any"
                    className={inputClass}
                    placeholder="0.00"
                    value={form.closeBalance}
                    onChange={(e) => setCloseBalanceAndScalp(e.target.value)}
                  />
                </Field>
                <Field
                  label="Close Transaction Link (Optional)"
                  htmlFor="closeTxLink"
                  hint="From your blockchain explorer e.g. hyperliquid.xyz, suiscan.xyz, basescan.org"
                >
                  <input
                    id="closeTxLink"
                    className={inputClass}
                    placeholder="Paste transaction hash or explorer URL"
                    value={form.closeTxLink}
                    onChange={(e) => set("closeTxLink", e.target.value)}
                  />
                </Field>
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <label
                      htmlFor="scalp"
                      className="block text-[11px] font-medium uppercase tracking-wider text-[var(--muted)]"
                    >
                      Scalp (USD)
                    </label>
                    <button
                      type="button"
                      onClick={recalcScalp}
                      className="text-[11px] font-medium text-[var(--muted)] transition-colors hover:text-[var(--accent)]"
                    >
                      Recalculate Scalp
                    </button>
                  </div>
                  <input
                    id="scalp"
                    type="number"
                    step="any"
                    className={inputClass}
                    placeholder="0.00"
                    value={form.scalp}
                    onChange={(e) => set("scalp", e.target.value)}
                  />
                  <p className="text-[11px] text-[var(--muted)]">
                    The price difference: Final Withdrawn − Deposited. Edit only
                    to correct it; nothing is saved until you press Save.
                  </p>
                  {scalpLooksWrong && (
                    <p className="text-[11px] text-amber-300">
                      Saved Scalp is 0 but this position moved{" "}
                      {formatUsd(suggestedScalp)} in price — Profit is currently
                      showing fees only. Recalculate to fix it.
                    </p>
                  )}
                </div>
                <ClosedProfitSummary
                  scalp={form.scalp}
                  totalFees={closedTotalFees}
                />
              </>
            )}
          </div>
          <div className="mt-4">
            <Field label="Notes" htmlFor="notes">
              <textarea
                id="notes"
                rows={2}
                className={inputClass}
                value={form.notes}
                // Free text, saved as typed. upper() stays on pair, chain,
                // protocol and the token symbols — those are identifiers the
                // app groups and matches on, so their case must be canonical.
                // A note is prose and nobody writes prose in capitals.
                onChange={(e) => set("notes", e.target.value)}
              />
            </Field>
          </div>
        </Section>

        <Section title="LP Range & Transaction">
          {!isEditing && (
            <InputModeTabs mode={inputMode} onChange={setInputMode} />
          )}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {tokenMode ? (
              <div className="space-y-1.5">
                <span className="block text-[11px] font-medium uppercase tracking-wider text-[var(--muted)]">
                  Entry Price (Base)
                </span>
                <div
                  className="rounded-md border border-dashed border-[var(--border-strong)] bg-[var(--surface-2)]/40 px-3 py-2 text-sm tabular-nums text-[var(--foreground)]"
                  aria-live="polite"
                >
                  {num(form.entryPrice) > 0 ? form.entryPrice : "—"}
                </div>
                <p className="text-[11px] text-[var(--muted)]">
                  Solved from the token amounts and your range bounds.
                </p>
              </div>
            ) : (
              <Field label="Entry Price (Base)" htmlFor="entryPrice">
                <input
                  id="entryPrice"
                  type="number"
                  step="any"
                  required
                  className={inputClass}
                  value={form.entryPrice}
                  onChange={(e) => setAnchor("entryPrice", e.target.value)}
                />
              </Field>
            )}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Range Down" htmlFor="bottomRange">
                <input
                  id="bottomRange"
                  type="number"
                  step="any"
                  required
                  className={inputClass}
                  value={form.bottomRange}
                  onChange={(e) => setRangeBound("bottomRange", e.target.value)}
                />
              </Field>
              <Field label="Range Up" htmlFor="topRange">
                <input
                  id="topRange"
                  type="number"
                  step="any"
                  required
                  className={inputClass}
                  value={form.topRange}
                  onChange={(e) => setRangeBound("topRange", e.target.value)}
                />
              </Field>
            </div>
            <div className="space-y-1.5">
              <span className="block text-[11px] font-medium uppercase tracking-wider text-[var(--muted)]">
                Wide Range %
              </span>
              <div
                className="rounded-md border border-dashed border-[var(--border-strong)] bg-[var(--surface-2)]/40 px-3 py-2 text-sm tabular-nums text-[var(--foreground)]"
                aria-live="polite"
              >
                {wideRangePct > 0 ? formatPercent(wideRangePct) : "—"}
              </div>
              <p className="text-[11px] text-[var(--muted)]">
                Auto: (Range Up − Range Down) / Range Down × 100
              </p>
            </div>
            {tokenMode ? (
              <div className="space-y-1.5">
                <span className="block text-[11px] font-medium uppercase tracking-wider text-[var(--muted)]">
                  Deposited (USD)
                </span>
                <div
                  className="rounded-md border border-dashed border-[var(--border-strong)] bg-[var(--surface-2)]/40 px-3 py-2 text-sm tabular-nums text-[var(--foreground)]"
                  aria-live="polite"
                >
                  {effectiveDeposited > 0 ? formatUsd(effectiveDeposited) : "—"}
                </div>
                <p className="text-[11px] text-[var(--muted)]">
                  Auto: (Base Token Count × Entry Price) + Quote Token Count
                </p>
              </div>
            ) : (
              <Field
                label="Deposited (USD)"
                htmlFor="deposited"
                hint={
                  linkEntryAndDeposited
                    ? "Linked to entry price along the LP value curve — moving either one moves the other, and the token counts follow both."
                    : "Type your deposit and the token counts split automatically — or type the token counts and this updates instead."
                }
              >
                <input
                  id="deposited"
                  type="number"
                  step="any"
                  className={inputClass}
                  placeholder="0.00"
                  value={form.deposited}
                  onChange={(e) => setAnchor("deposited", e.target.value)}
                />
              </Field>
            )}
            <Field label="Base Token Symbol" htmlFor="token1Symbol">
              <input
                id="token1Symbol"
                required
                className={inputClass}
                placeholder="ETH"
                value={form.token1Symbol}
                onChange={upper("token1Symbol")}
              />
            </Field>
            <Field label="Quote Token Symbol" htmlFor="token2Symbol">
              <input
                id="token2Symbol"
                required
                className={inputClass}
                placeholder="USDC"
                value={form.token2Symbol}
                onChange={upper("token2Symbol")}
              />
            </Field>
            <Field label="Base Token Count" htmlFor="token1Count">
              <input
                id="token1Count"
                type="number"
                step="any"
                required
                className={inputClass}
                value={form.token1Count}
                onChange={(e) => setTokenCount("token1Count", e.target.value)}
              />
            </Field>
            <Field label="Quote Token Count" htmlFor="token2Count">
              <input
                id="token2Count"
                type="number"
                step="any"
                required
                className={inputClass}
                value={form.token2Count}
                onChange={(e) => setTokenCount("token2Count", e.target.value)}
              />
            </Field>
          </div>
          {isEditing && !recalcOpen && (
            <button
              type="button"
              onClick={() => {
                setRecalcApplied(null);
                setRecalcOpen(true);
              }}
              className="mt-4 rounded-md border border-[var(--border-strong)] px-3 py-1.5 text-[12px] font-medium text-[var(--muted)] transition-colors hover:border-amber-500/50 hover:text-amber-300"
            >
              Recalculate from token amounts…
            </button>
          )}
          {isEditing && recalcOpen && (
            <RecalcFromTokensPanel
              rangeDown={num(form.bottomRange)}
              rangeUp={num(form.topRange)}
              currentEntryPrice={num(form.entryPrice)}
              currentDeposited={effectiveDeposited}
              savedCurrentBalance={savedCurrentBalance ?? 0}
              balanceTracksDeposited={balanceTracksDeposited}
              baseSymbol={form.token1Symbol}
              quoteSymbol={form.token2Symbol}
              initialBase={form.token1Count}
              initialQuote={form.token2Count}
              onCancel={() => setRecalcOpen(false)}
              onApply={(entryPrice, deposited, base, quote, newBalance) => {
                setRecalcApplied({
                  fromEntry: form.entryPrice,
                  toEntry: formatAmountInput(entryPrice, 6),
                  fromDeposited: formatUsd(effectiveDeposited),
                  toDeposited: formatUsd(deposited),
                  balanceMoved: newBalance !== null,
                  staleBalance:
                    newBalance === null && savedCurrentBalance !== undefined
                      ? formatUsd(savedCurrentBalance)
                      : null,
                });
                setForm((prev) => ({
                  ...prev,
                  entryPrice: formatAmountInput(entryPrice, 6),
                  deposited: formatAmountInput(deposited, 2),
                  token1Count: base,
                  token2Count: quote,
                  currentBalanceOverride:
                    newBalance !== null ? String(newBalance) : "",
                }));
                setSplitWarning(null);
                setClampNote(null);
                setRecalcOpen(false);
              }}
            />
          )}
          {recalcApplied && (
            <p
              className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-300"
              role="status"
            >
              Recalculated: Entry Price {recalcApplied.fromEntry} →{" "}
              {recalcApplied.toEntry}, Deposited {recalcApplied.fromDeposited} →{" "}
              {recalcApplied.toDeposited}
              {recalcApplied.balanceMoved
                ? `, Current Balance ${recalcApplied.fromDeposited} → ${recalcApplied.toDeposited}`
                : ""}
              . Save this position to record it, or close without saving to
              discard.
              {!recalcApplied.balanceMoved && recalcApplied.staleBalance && (
                <>
                  {" "}
                  Current Balance stays at {recalcApplied.staleBalance} — run
                  Update afterwards so Profit reflects reality.
                </>
              )}
            </p>
          )}
          {tokenMode && solvedShape !== null && solvedShape !== "two-sided" && (
            <p
              className="mt-3 rounded-md border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-[12px] text-sky-300"
              role="status"
            >
              Only one token entered, so the entry price sits exactly on your{" "}
              {solvedShape === "base-only" ? "Range Down" : "Range Up"} bound —
              that is where a position holds{" "}
              {solvedShape === "base-only"
                ? `only ${form.token1Symbol || "the base token"}`
                : `only ${form.token2Symbol || "the quote token"}`}
              . Enter both amounts to solve a price inside the range.
            </p>
          )}
          {tokenMode && form.token1Count !== "" && form.token2Count !== "" &&
            solvedShape === null && (
            <p
              className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-300"
              role="status"
            >
              Could not solve an entry price from these amounts. Check that both
              range bounds are set and Range Up is above Range Down.
            </p>
          )}
          {clampNote && (
            <p
              className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-300"
              role="status"
            >
              At this position size the deposit tops out at {clampNote} — above
              the top of your range the position is all{" "}
              {form.token2Symbol || "quote token"}, so its value stops rising.
              Change a token count to size the position differently.
            </p>
          )}
          {splitWarning && (
            <p
              className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-300"
              role="status"
            >
              Auto-split replaced your typed token counts (
              {splitWarning.base || "0"} {form.token1Symbol || "base"} /{" "}
              {splitWarning.quote || "0"} {form.token2Symbol || "quote"}). Edit
              a token count again to take back control.
            </p>
          )}
          <div className="mt-4">
            <Field
              label="LP Transaction Link (Optional)"
              htmlFor="txLink"
              hint="From your blockchain explorer e.g. hyperliquid.xyz, suiscan.xyz, basescan.org"
            >
              <input
                id="txLink"
                className={inputClass}
                placeholder="Paste transaction hash or explorer URL"
                value={form.txLink}
                onChange={(e) => set("txLink", e.target.value)}
              />
            </Field>
          </div>
        </Section>

        <Section title="Position Hedge">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Short Position — Open Date" htmlFor="shortDateStart">
              <input
                id="shortDateStart"
                type="date"
                lang="en-GB"
                className={inputClass}
                value={form.shortDateStart}
                onChange={(e) => set("shortDateStart", e.target.value)}
              />
            </Field>
            <Field label="Short Position — Close Date" htmlFor="shortDateEnd">
              <input
                id="shortDateEnd"
                type="date"
                lang="en-GB"
                className={inputClass}
                value={form.shortDateEnd}
                onChange={(e) => set("shortDateEnd", e.target.value)}
              />
            </Field>
            <Field
              label="Short Position — Token Amount"
              htmlFor="shortTokenAmount"
            >
              <input
                id="shortTokenAmount"
                type="number"
                step="any"
                className={inputClass}
                placeholder="optional"
                value={form.shortTokenAmount}
                onChange={(e) => set("shortTokenAmount", e.target.value)}
              />
            </Field>
            <Field
              label="Short Position — USD Amount"
              htmlFor="shortUsdAmount"
            >
              <input
                id="shortUsdAmount"
                type="number"
                step="any"
                className={inputClass}
                placeholder="optional"
                value={form.shortUsdAmount}
                onChange={(e) => set("shortUsdAmount", e.target.value)}
              />
            </Field>
            <Field label="Short Position — Gain" htmlFor="shortGain">
              <input
                id="shortGain"
                type="number"
                step="any"
                className={inputClass}
                placeholder="optional"
                value={form.shortGain}
                onChange={(e) => set("shortGain", e.target.value)}
              />
            </Field>
            <Field label="Short Position — Loss" htmlFor="shortLoss">
              <input
                id="shortLoss"
                type="number"
                step="any"
                className={inputClass}
                placeholder="optional"
                value={form.shortLoss}
                onChange={(e) => set("shortLoss", e.target.value)}
              />
            </Field>
            <Field
              label="Short Position — Funding Fees"
              htmlFor="shortFundingFees"
              hint="Positive = received, Negative = paid"
            >
              <input
                id="shortFundingFees"
                type="number"
                step="any"
                className={inputClass}
                placeholder="optional"
                value={form.shortFundingFees}
                onChange={(e) => set("shortFundingFees", e.target.value)}
              />
            </Field>
            <div className="space-y-1.5">
              <span className="block text-[11px] font-medium uppercase tracking-wider text-[var(--muted)]">
                Short Position — Total P&amp;L
              </span>
              <div
                className={`rounded-md border border-dashed border-[var(--border-strong)] bg-[var(--surface-2)]/40 px-3 py-2 text-sm tabular-nums ${
                  shortTotal === null ? "text-[var(--muted)]" : pnlColor(shortTotal)
                }`}
                aria-live="polite"
              >
                {shortTotal === null ? "—" : formatUsd(shortTotal)}
              </div>
              <p className="text-[11px] text-[var(--muted)]">
                Auto: gain − loss + funding
              </p>
            </div>
            <Field label="Short Position — Notes" htmlFor="shortNotes">
              <textarea
                id="shortNotes"
                rows={2}
                className={inputClass}
                placeholder="optional"
                value={form.shortNotes}
                // Free text, saved as typed (same reasoning as Notes above).
                onChange={(e) => set("shortNotes", e.target.value)}
              />
            </Field>
          </div>

          {isClosedPosition && <HypotheticalNotice className="mt-6" />}

          <div
            className={`mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 ${
              isClosedPosition ? HYPOTHETICAL_DIM : ""
            }`}
          >
            <OutOfRangeBox
              label="Out of Range — Upside"
              il={upsideIL}
              profit={upsideProfit}
              baseSymbol={form.token1Symbol}
              quoteSymbol={form.token2Symbol}
            />
            <OutOfRangeBox
              label="Out of Range — Downside"
              il={downsideIL}
              profit={downsideProfit}
              baseSymbol={form.token1Symbol}
              quoteSymbol={form.token2Symbol}
            />
          </div>

          <div
            className={`mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 ${
              isClosedPosition ? HYPOTHETICAL_DIM : ""
            }`}
          >
            <NetCoverageBox
              label="Net Downside Coverage"
              shortPresent={shortTotal !== null}
              value={netDownside}
              positiveHint="Short covers the loss"
              negativeHint="Uncovered loss remains"
              fallbackLabel="Downside P&L"
              fallbackValue={downsideProfit}
            />
            <NetCoverageBox
              label="Net Upside Coverage"
              shortPresent={shortTotal !== null}
              value={netUpside}
              positiveHint="Upside covers short loss"
              negativeHint="Short loss exceeds upside gain"
              fallbackLabel="Upside P&L"
              fallbackValue={upsideProfit}
            />
          </div>
        </Section>

        <FormActions onCancel={onCancel} submitLabel={submitLabel} />
      </form>
    </ModalShell>
  );
}

interface UpdatePositionModalProps {
  position: Position;
  derivedClaimed: number;
  onCancel: () => void;
  onSubmit: (next: {
    currentBalance: number;
    newFees: number;
  }) => void;
}

function UpdatePositionModal({
  position,
  derivedClaimed,
  onCancel,
  onSubmit,
}: UpdatePositionModalProps) {
  const [currentBalance, setCurrentBalance] = useState(
    String(position.currentBalance ?? 0),
  );
  const [newFees, setNewFees] = useState(String(position.newFees ?? 0));

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    onSubmit({
      currentBalance: num(currentBalance),
      newFees: num(newFees),
    });
  };

  return (
    <ModalShell title={`Update — ${position.pair}`} onCancel={onCancel}>
      <form onSubmit={submit} className="divide-y divide-[var(--border)]">
        <Section title="Routine Update">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Current Balance (USD)" htmlFor="u_currentBalance">
              <input
                id="u_currentBalance"
                type="number"
                step="any"
                required
                className={inputClass}
                value={currentBalance}
                onChange={(e) => setCurrentBalance(e.target.value)}
              />
            </Field>
            <Field label="New Fees (USD)" htmlFor="u_newFees">
              <input
                id="u_newFees"
                type="number"
                step="any"
                required
                className={inputClass}
                value={newFees}
                onChange={(e) => setNewFees(e.target.value)}
              />
            </Field>
            <div className="space-y-1.5">
              <span className="block text-[11px] font-medium uppercase tracking-wider text-[var(--muted)]">
                Claimed (USD)
              </span>
              <div
                className="rounded-md border border-dashed border-[var(--border-strong)] bg-[var(--surface-2)]/40 px-3 py-2 text-sm tabular-nums text-[var(--foreground)]"
                aria-live="polite"
              >
                {formatUsd(derivedClaimed)}
              </div>
              <p className="text-[11px] text-[var(--muted)]">
                Auto: sum of converted claims for this position. Log claims
                via the Fee Claims page or Claim button.
              </p>
            </div>
          </div>
        </Section>
        <FormActions onCancel={onCancel} submitLabel="Save" />
      </form>
    </ModalShell>
  );
}

type HistoricalPriceState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "done";
      sources: Record<string, string>;
      coarse: string[];
      unresolved: string[];
      at: string;
    };

const PRICE_SOURCE_LABEL: Record<string, string> = {
  stable: "stablecoin — anchored to $1.00, not fetched",
  defillama: "DeFiLlama, priced at the exact exit time",
  coingecko: "CoinGecko — daily snapshot only, not the exact time",
};

function CloseModeTabs({
  mode,
  onChange,
}: {
  mode: "manual" | "tokens";
  onChange: (next: "manual" | "tokens") => void;
}) {
  const tabs: Array<{ key: "manual" | "tokens"; label: string }> = [
    { key: "manual", label: "Enter manually" },
    { key: "tokens", label: "Enter token amounts received" },
  ];
  return (
    <div className="space-y-1.5">
      <div
        role="tablist"
        aria-label="Close entry method"
        className="inline-flex rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)]/40 p-0.5"
      >
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={mode === tab.key}
            onClick={() => onChange(tab.key)}
            className={`rounded px-3 py-1.5 text-[12px] font-medium transition-colors ${
              mode === tab.key
                ? "bg-[var(--accent-solid)] text-white"
                : "text-[var(--muted)] hover:text-[var(--foreground)]"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-[var(--muted)]">
        {mode === "manual"
          ? "Type the final balance — Scalp is calculated automatically from it (you can still correct it if needed)."
          : "Type the tokens you actually received; the app prices them at your exit time and works out the rest."}
      </p>
    </div>
  );
}

// Fetched prices are shown, not hidden, and stay editable — an index price at
// a timestamp is not necessarily the price actually filled at.
function ExitPricePanel({
  state,
  baseSymbol,
  quoteSymbol,
  basePrice,
  quotePrice,
  onBasePrice,
  onQuotePrice,
  onFetch,
  onSwitchToManual,
}: {
  state: HistoricalPriceState;
  baseSymbol: string;
  quoteSymbol: string;
  basePrice: string;
  quotePrice: string;
  onBasePrice: (v: string) => void;
  onQuotePrice: (v: string) => void;
  onFetch: () => void;
  onSwitchToManual: () => void;
}) {
  const sources = state.status === "done" ? state.sources : {};
  const unresolved = state.status === "done" ? state.unresolved : [];
  const rows = [
    { symbol: baseSymbol || "Base", value: basePrice, onChange: onBasePrice },
    { symbol: quoteSymbol || "Quote", value: quotePrice, onChange: onQuotePrice },
  ];

  return (
    <div className="rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)]/30 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--muted)]">
          Price at exit time
        </span>
        <button
          type="button"
          onClick={onFetch}
          disabled={state.status === "loading"}
          className="rounded-md border border-[var(--border-strong)] px-2.5 py-1 text-[11px] font-medium text-[var(--foreground)] transition-colors hover:border-[var(--accent)] disabled:opacity-50"
        >
          {state.status === "loading" ? "Fetching…" : "Fetch prices"}
        </button>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {rows.map((row) => {
          const source = sources[row.symbol.trim().toUpperCase()];
          return (
            <div key={row.symbol} className="space-y-1">
              <label
                htmlFor={`c_price_${row.symbol}`}
                className="block text-[11px] text-[var(--muted)]"
              >
                {row.symbol} price (USD)
              </label>
              <input
                id={`c_price_${row.symbol}`}
                type="number"
                step="any"
                className={inputClass}
                placeholder="0.00"
                value={row.value}
                onChange={(e) => row.onChange(e.target.value)}
              />
              {source && (
                <p className="text-[10px] text-[var(--muted)]">
                  {PRICE_SOURCE_LABEL[source] ?? source}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {state.status === "error" && (
        <div className="mt-3 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-300">
          {state.message} You can retry, type the prices in by hand above, or{" "}
          <button
            type="button"
            onClick={onSwitchToManual}
            className="underline underline-offset-2 hover:text-amber-200"
          >
            switch to manual entry
          </button>
          .
        </div>
      )}

      {state.status === "done" && unresolved.length > 0 && (
        <div className="mt-3 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-300">
          No historical price found for {unresolved.join(", ")}. Type it in
          above, or{" "}
          <button
            type="button"
            onClick={onSwitchToManual}
            className="underline underline-offset-2 hover:text-amber-200"
          >
            switch to manual entry
          </button>
          .
        </div>
      )}

      {state.status === "done" && state.coarse.length > 0 && (
        <p className="mt-2 text-[11px] text-amber-300">
          {state.coarse.join(", ")} priced from a daily snapshot, not your exact
          exit time — check it before saving.
        </p>
      )}
    </div>
  );
}

interface ClosePositionModalProps {
  position: Position;
  onCancel: () => void;
  onSubmit: (next: {
    exitDatetime: string;
    currentBalance: number;
    scalp: number | null;
    closeTxLink: string | null;
    rangeExit: "above" | "below" | "in" | "";
    feeClaim?: {
      token1Amount: number;
      token2Amount: number;
      stableAmount: number | null;
      convertedToStable: boolean;
      stableSymbol: string | null;
      txId: string | null;
    };
  }) => void;
}

function ClosePositionModal({
  position,
  onCancel,
  onSubmit,
}: ClosePositionModalProps) {
  const [exitDatetime, setExitDatetime] = useState(nowDatetimeLocal());
  const [scalp, setScalp] = useState("");
  const [currentBalance, setCurrentBalance] = useState(
    String(position.currentBalance ?? 0),
  );
  const [closeTxLink, setCloseTxLink] = useState("");
  // Which side the position exited on. Undetectable from stored data after the
  // fact (Phase A), so it is an explicit choice; only "above" + a positive
  // scalp creates the Out-of-Range-Upside transfer. "" until chosen/derived.
  const [rangeExitOverride, setRangeExitOverride] = useState<
    "above" | "below" | "in" | ""
  >("");
  // Mode 2: token amounts received, priced at the exit moment. Both modes
  // save the same scalp/currentBalance — this one just does the arithmetic.
  const [closeMode, setCloseMode] = useState<"manual" | "tokens">("manual");
  const [baseReceived, setBaseReceived] = useState("");
  const [quoteReceived, setQuoteReceived] = useState("");
  const [basePrice, setBasePrice] = useState("");
  const [quotePrice, setQuotePrice] = useState("");
  const [priceState, setPriceState] = useState<HistoricalPriceState>({
    status: "idle",
  });
  const [claimSectionOpen, setClaimSectionOpen] = useState(false);
  const [claimTokens1, setClaimTokens1] = useState("");
  const [claimTokens2, setClaimTokens2] = useState("");
  const [claimUsdValue, setClaimUsdValue] = useState("");
  const [claimConverted, setClaimConverted] = useState(false);
  const [claimStableSymbol, setClaimStableSymbol] = useState("USDC");
  const [claimTxId, setClaimTxId] = useState("");

  const shouldCreateClaim =
    num(claimTokens1) > 0 || num(claimTokens2) > 0 || num(claimUsdValue) > 0;

  const deposited = getEffectiveDeposited(position);

  // Manual mode: Scalp is the price difference and is always knowable once
  // the final balance is typed, so it is filled in rather than left blank —
  // a blank Scalp silently reports Profit as fees alone. Still editable.
  const setManualBalance = (value: string) => {
    setCurrentBalance(value);
    const balance = Number(value);
    if (value.trim() !== "" && Number.isFinite(balance)) {
      setScalp(
        formatAmountInput(calcScalpFromWithdrawn(balance, deposited), 2, true),
      );
    }
  };

  // Mode 2 results. Prices are whatever is in the (overridable) inputs, so an
  // edited price flows straight through without refetching.
  const tokensBalance =
    num(baseReceived) * num(basePrice) + num(quoteReceived) * num(quotePrice);
  const tokensScalp = tokensBalance - deposited;
  const usingTokens = closeMode === "tokens";

  // In token mode a CLMM close is 100% quote above range and 100% base below,
  // so the received split reveals the exit side — pre-fill from it, but let the
  // user override. Manual mode has no such signal, so no suggestion.
  const EPS = 1e-9;
  const suggestedRange: "above" | "below" | "in" | "" = (() => {
    if (!usingTokens) return "";
    const b = num(baseReceived);
    const q = num(quoteReceived);
    if (b <= EPS && q > EPS) return "above";
    if (q <= EPS && b > EPS) return "below";
    if (b > EPS && q > EPS) return "in";
    return "";
  })();
  const rangeExit = rangeExitOverride || suggestedRange;

  // The datetime-local input holds LOCAL wall-clock time. new Date() parses it
  // in the device's zone, so getTime() is already the correct absolute moment
  // — no manual offset arithmetic, which is where this usually goes wrong.
  const fetchExitPrices = useCallback(async () => {
    const ms = new Date(exitDatetime).getTime();
    const ts = Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
    if (ts === null) {
      setPriceState({ status: "error", message: "Enter a valid exit date and time first." });
      return;
    }
    const symbols = [position.token1Symbol, position.token2Symbol]
      .map((s) => (s ?? "").trim().toUpperCase())
      .filter((s) => s !== "");
    if (symbols.length === 0) {
      setPriceState({ status: "error", message: "This position has no token symbols set." });
      return;
    }
    setPriceState({ status: "loading" });
    try {
      const res = await fetch(
        `/clp-tracker/api/prices/historical?symbols=${encodeURIComponent(symbols.join(","))}&timestamp=${ts}`,
      );
      if (!res.ok) throw new Error(`Price service returned ${res.status}`);
      const data = (await res.json()) as {
        prices: Record<string, number>;
        sources: Record<string, string>;
        coarse: string[];
        unresolved: string[];
      };
      const base = position.token1Symbol.trim().toUpperCase();
      const quote = position.token2Symbol.trim().toUpperCase();
      if (typeof data.prices[base] === "number") {
        setBasePrice(formatAmountInput(data.prices[base], 8));
      }
      if (typeof data.prices[quote] === "number") {
        setQuotePrice(formatAmountInput(data.prices[quote], 8));
      }
      setPriceState({
        status: "done",
        sources: data.sources ?? {},
        coarse: data.coarse ?? [],
        unresolved: data.unresolved ?? [],
        at: new Date(ts * 1000).toISOString(),
      });
    } catch (err) {
      setPriceState({
        status: "error",
        message:
          err instanceof Error
            ? `Could not fetch prices (${err.message}).`
            : "Could not fetch prices.",
      });
    }
  }, [exitDatetime, position.token1Symbol, position.token2Symbol]);

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    onSubmit({
      exitDatetime: new Date(exitDatetime).toISOString(),
      currentBalance: usingTokens ? tokensBalance : num(currentBalance),
      scalp: usingTokens ? tokensScalp : optionalNum(scalp),
      closeTxLink: closeTxLink.trim() === "" ? null : closeTxLink.trim(),
      rangeExit,
      feeClaim: shouldCreateClaim
        ? {
            token1Amount: num(claimTokens1),
            token2Amount: num(claimTokens2),
            stableAmount: optionalNum(claimUsdValue),
            convertedToStable: claimConverted,
            stableSymbol: claimConverted
              ? claimStableSymbol.trim().toUpperCase() || null
              : null,
            txId: claimTxId.trim() === "" ? null : claimTxId.trim(),
          }
        : undefined,
    });
  };

  return (
    <ModalShell title={`Close — ${position.pair}`} onCancel={onCancel}>
      <form onSubmit={submit} className="divide-y divide-[var(--border)]">
        <Section title="Confirm Close">
          <p className="mb-4 text-sm text-[var(--muted)]">
            Closing{" "}
            <span className="font-medium text-[var(--foreground)]">
              {position.pair}
            </span>{" "}
            on {position.chain} ({position.protocol}). This sets the exit time
            and marks the position as closed.
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <DateTimeFields
              dateLabel="Exit Date"
              timeLabel="Exit Time (24h)"
              idPrefix="exit"
              value={exitDatetime}
              onChange={setExitDatetime}
              required
            />
            <DateOrderWarning
              entry={position.entryDatetime}
              exit={exitDatetime}
            />
            <div className="sm:col-span-2">
              <CloseModeTabs mode={closeMode} onChange={setCloseMode} />
            </div>
            {usingTokens ? (
              <>
                <Field
                  label={`${position.token1Symbol || "Base"} received`}
                  htmlFor="c_baseRecv"
                >
                  <input
                    id="c_baseRecv"
                    type="number"
                    step="any"
                    className={inputClass}
                    placeholder="0"
                    value={baseReceived}
                    onChange={(e) => setBaseReceived(e.target.value)}
                  />
                </Field>
                <Field
                  label={`${position.token2Symbol || "Quote"} received`}
                  htmlFor="c_quoteRecv"
                >
                  <input
                    id="c_quoteRecv"
                    type="number"
                    step="any"
                    className={inputClass}
                    placeholder="0"
                    value={quoteReceived}
                    onChange={(e) => setQuoteReceived(e.target.value)}
                  />
                </Field>
                <div className="sm:col-span-2">
                  <ExitPricePanel
                    state={priceState}
                    baseSymbol={position.token1Symbol}
                    quoteSymbol={position.token2Symbol}
                    basePrice={basePrice}
                    quotePrice={quotePrice}
                    onBasePrice={setBasePrice}
                    onQuotePrice={setQuotePrice}
                    onFetch={fetchExitPrices}
                    onSwitchToManual={() => setCloseMode("manual")}
                  />
                </div>
                {/* Deposited is the number Scalp is measured against, so it
                    reads first rather than only as a parenthetical in the hint
                    below. Same dashed styling as the other computed boxes —
                    it is derived (getEffectiveDeposited), not typed. */}
                <div className="space-y-1.5 sm:col-span-2">
                  <span className="block text-[11px] font-medium uppercase tracking-wider text-[var(--muted)]">
                    Deposited (USD)
                  </span>
                  <div className="rounded-md border border-dashed border-[var(--border-strong)] bg-[var(--surface-2)]/40 px-3 py-2 text-sm tabular-nums text-[var(--foreground)]">
                    {formatUsd(deposited)}
                  </div>
                  <p className="text-[11px] text-[var(--muted)]">
                    What went in — Scalp is measured against this.
                  </p>
                </div>
                <div className="space-y-1.5">
                  <span className="block text-[11px] font-medium uppercase tracking-wider text-[var(--muted)]">
                    Final Current Balance (USD)
                  </span>
                  <div
                    className="rounded-md border border-dashed border-[var(--border-strong)] bg-[var(--surface-2)]/40 px-3 py-2 text-sm tabular-nums text-[var(--foreground)]"
                    aria-live="polite"
                  >
                    {formatUsd(tokensBalance)}
                  </div>
                  <p className="text-[11px] text-[var(--muted)]">
                    Auto: (base × price) + (quote × price)
                  </p>
                </div>
                <div className="space-y-1.5">
                  <span className="block text-[11px] font-medium uppercase tracking-wider text-[var(--muted)]">
                    Scalp (USD)
                  </span>
                  <div
                    className={`rounded-md border border-dashed border-[var(--border-strong)] bg-[var(--surface-2)]/40 px-3 py-2 text-sm tabular-nums ${pnlColor(tokensScalp)}`}
                    aria-live="polite"
                  >
                    {/* Word and colour both come from the sign of the same
                        value, so they cannot drift apart. */}
                    {`${formatUsd(tokensScalp)}${
                      pnlLabel(tokensScalp) ? ` · ${pnlLabel(tokensScalp)}` : ""
                    }`}
                  </div>
                  <p className="text-[11px] text-[var(--muted)]">
                    Auto: Final Balance − Deposited ({formatUsd(deposited)})
                  </p>
                </div>
              </>
            ) : (
              <>
                {/* Same box as the tokens mode gets, for the same reason: the
                    figure Scalp is measured against should be visible, not
                    buried in hint prose. */}
                <div className="space-y-1.5 sm:col-span-2">
                  <span className="block text-[11px] font-medium uppercase tracking-wider text-[var(--muted)]">
                    Deposited (USD)
                  </span>
                  <div className="rounded-md border border-dashed border-[var(--border-strong)] bg-[var(--surface-2)]/40 px-3 py-2 text-sm tabular-nums text-[var(--foreground)]">
                    {formatUsd(deposited)}
                  </div>
                  <p className="text-[11px] text-[var(--muted)]">
                    What went in — Scalp is measured against this.
                  </p>
                </div>
                <Field
                  label="Final Current Balance (USD)"
                  htmlFor="c_balance"
                  hint="What the position was worth when you closed it."
                >
                  <input
                    id="c_balance"
                    type="number"
                    step="any"
                    required
                    className={inputClass}
                    value={currentBalance}
                    onChange={(e) => setManualBalance(e.target.value)}
                  />
                </Field>
                <Field
                  label="Scalp (USD)"
                  htmlFor="c_scalp"
                  hint="The price difference: Final Withdrawn − Deposited. Filled in automatically — edit only to correct it."
                >
                  <input
                    id="c_scalp"
                    type="number"
                    step="any"
                    className={inputClass}
                    placeholder="0.00"
                    value={scalp}
                    onChange={(e) => setScalp(e.target.value)}
                  />
                  {/* Live read-out of whatever the field currently holds —
                      auto-filled or hand-edited — so the manual mode gets the
                      same at-a-glance verdict the tokens mode already had.
                      Reads the input, changes nothing. */}
                  {pnlLabel(num(scalp)) !== "" && (
                    <p
                      className={`mt-1.5 text-[12px] font-medium tabular-nums ${pnlColor(
                        num(scalp),
                      )}`}
                      aria-live="polite"
                    >
                      {`${formatUsd(num(scalp))} · ${pnlLabel(num(scalp))}`}
                    </p>
                  )}
                </Field>
              </>
            )}
            <Field
              label="Close Transaction Link (Optional)"
              htmlFor="c_txLink"
              hint="From your blockchain explorer e.g. hyperliquid.xyz, suiscan.xyz, basescan.org"
            >
              <input
                id="c_txLink"
                className={inputClass}
                placeholder="Paste transaction hash or explorer URL"
                value={closeTxLink}
                onChange={(e) => setCloseTxLink(e.target.value)}
              />
            </Field>
            <div className="space-y-1.5 sm:col-span-2">
              <span className="block text-[11px] font-medium uppercase tracking-wider text-[var(--muted)]">
                Position closed
              </span>
              <div
                role="radiogroup"
                aria-label="Which side did the position exit on?"
                className="inline-flex overflow-hidden rounded-md border border-[var(--border-strong)]"
              >
                {(
                  [
                    ["above", "Above range"],
                    ["below", "Below range"],
                    ["in", "Still in range"],
                  ] as const
                ).map(([value, label], i) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={rangeExit === value}
                    onClick={() => setRangeExitOverride(value)}
                    className={`h-8 px-3 text-xs font-medium transition-colors ${
                      i > 0 ? "border-l border-[var(--border-strong)]" : ""
                    } ${
                      rangeExit === value
                        ? "bg-[var(--accent-solid)] text-white"
                        : "bg-[var(--surface-2)] text-[var(--muted)] hover:bg-[var(--surface-2)]/70"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-[var(--muted)]">
                {usingTokens && suggestedRange && !rangeExitOverride
                  ? "Pre-filled from the tokens you received — override if wrong. "
                  : ""}
                Choosing “Above range” with a profit sets that profit aside as
                an Out-of-Range-Upside transfer.
              </p>
            </div>
          </div>
        </Section>
        <Section title="Claim Fees at Close (Optional)">
          <button
            type="button"
            onClick={() => setClaimSectionOpen((v) => !v)}
            aria-expanded={claimSectionOpen}
            className="text-sm font-medium text-[var(--accent)] hover:opacity-80"
          >
            {claimSectionOpen ? "−" : "+"} Claim fees earned at close?
          </button>
          {claimSectionOpen && (
            <div className="mt-4 space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field
                  label={`${position.token1Symbol || "Token 1"} Amount`}
                  htmlFor="c_claimTokens1"
                >
                  <input
                    id="c_claimTokens1"
                    type="number"
                    step="any"
                    placeholder="0.00"
                    className={inputClass}
                    value={claimTokens1}
                    onChange={(e) => setClaimTokens1(e.target.value)}
                  />
                </Field>
                <Field
                  label={`${position.token2Symbol || "Token 2"} Amount`}
                  htmlFor="c_claimTokens2"
                >
                  <input
                    id="c_claimTokens2"
                    type="number"
                    step="any"
                    placeholder="0.00"
                    className={inputClass}
                    value={claimTokens2}
                    onChange={(e) => setClaimTokens2(e.target.value)}
                  />
                </Field>
                <Field
                  label="Claim USD Value"
                  htmlFor="c_claimUsd"
                  hint="USD value of these fees at close time"
                >
                  <input
                    id="c_claimUsd"
                    type="number"
                    step="any"
                    placeholder="0.00"
                    className={inputClass}
                    value={claimUsdValue}
                    onChange={(e) => setClaimUsdValue(e.target.value)}
                  />
                </Field>
                <Field label="Transaction ID (Optional)" htmlFor="c_claimTx">
                  <input
                    id="c_claimTx"
                    className={inputClass}
                    placeholder="Paste tx hash or explorer URL"
                    value={claimTxId}
                    onChange={(e) => setClaimTxId(e.target.value)}
                  />
                </Field>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-sm text-[var(--muted)]">
                  Converted to Stablecoin?
                </span>
                <div
                  role="radiogroup"
                  aria-label="Converted to Stablecoin?"
                  className="inline-flex overflow-hidden rounded-md border border-[var(--border-strong)]"
                >
                  <button
                    type="button"
                    role="radio"
                    aria-checked={claimConverted}
                    onClick={() => setClaimConverted(true)}
                    className={`h-8 px-4 text-xs font-medium transition-colors ${
                      claimConverted
                        ? "bg-[var(--accent-solid)] text-white"
                        : "bg-[var(--surface-2)] text-[var(--muted)] hover:bg-[var(--surface-2)]/70"
                    }`}
                  >
                    Yes
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={!claimConverted}
                    onClick={() => setClaimConverted(false)}
                    className={`h-8 px-4 text-xs font-medium border-l border-[var(--border-strong)] transition-colors ${
                      !claimConverted
                        ? "bg-[var(--accent-solid)] text-white"
                        : "bg-[var(--surface-2)] text-[var(--muted)] hover:bg-[var(--surface-2)]/70"
                    }`}
                  >
                    No
                  </button>
                </div>
                {claimConverted && (
                  <input
                    aria-label="Stable symbol"
                    className={`${inputClass} w-28`}
                    placeholder="USDC"
                    value={claimStableSymbol}
                    onChange={(e) =>
                      setClaimStableSymbol(e.target.value.toUpperCase())
                    }
                  />
                )}
              </div>
            </div>
          )}
        </Section>
        <FormActions
          onCancel={onCancel}
          submitLabel="Confirm Close"
          submitTone="danger"
        />
      </form>
    </ModalShell>
  );
}

interface SectionProps {
  title: string;
  children: ReactNode;
}

function Section({ title, children }: SectionProps) {
  return (
    <div className="px-5 py-5">
      <h3 className="mb-4 text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">
        {title}
      </h3>
      {children}
    </div>
  );
}

function fmtTokenAmount(value: number): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  });
}

interface OutOfRangeBoxProps {
  label: string;
  il: ILResult | null;
  profit: number | null;
  baseSymbol: string;
  quoteSymbol: string;
}

function OutOfRangeBox({
  label,
  il,
  profit,
  baseSymbol,
  quoteSymbol,
}: OutOfRangeBoxProps) {
  const ready = il !== null && profit !== null;
  return (
    <div className="rounded-md border border-dashed border-[var(--border-strong)] bg-[var(--surface-2)]/40 p-3">
      <div className="text-[11px] font-medium uppercase tracking-wider text-[var(--muted)]">
        {label}
      </div>
      {ready ? (
        <div className="mt-1.5 space-y-1">
          <div className="text-sm font-medium text-[var(--foreground)] tabular-nums">
            {(() => {
              const showT0 = il.futureToken0 > 0;
              const showT1 = il.futureToken1 > 0;
              if (!showT0 && !showT1) return "—";
              return (
                <>
                  {showT0 && (
                    <>
                      {fmtTokenAmount(il.futureToken0)}{" "}
                      <span className="text-[var(--muted)]">
                        {baseSymbol || "—"}
                      </span>
                    </>
                  )}
                  {showT0 && showT1 && " + "}
                  {showT1 && (
                    <>
                      {fmtTokenAmount(il.futureToken1)}{" "}
                      <span className="text-[var(--muted)]">
                        {quoteSymbol || "—"}
                      </span>
                    </>
                  )}
                </>
              );
            })()}
          </div>
          <div className="text-xs text-[var(--muted)] tabular-nums">
            LP Value: {formatUsd(il.lpValue)}
          </div>
          <div className={`text-xs tabular-nums font-medium ${pnlColor(profit)}`}>
            P/L: {formatUsd(profit)}
          </div>
        </div>
      ) : (
        <div className="mt-2 text-sm text-[var(--muted)]">—</div>
      )}
    </div>
  );
}

interface NetCoverageBoxProps {
  label: string;
  shortPresent: boolean;
  value: number | null;
  positiveHint: string;
  negativeHint: string;
  fallbackLabel: string;
  fallbackValue: number | null;
}

function NetCoverageBox({
  label,
  shortPresent,
  value,
  positiveHint,
  negativeHint,
  fallbackLabel,
  fallbackValue,
}: NetCoverageBoxProps) {
  const showFallback = !shortPresent && fallbackValue !== null;
  const displayValue = shortPresent ? value : fallbackValue;
  const isMissing = displayValue === null;
  const tone = isMissing ? "text-[var(--muted)]" : pnlColor(displayValue);
  const hint = isMissing
    ? null
    : displayValue > 0
      ? positiveHint
      : displayValue < 0
        ? negativeHint
        : null;

  return (
    <div className="rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)]/60 p-3">
      <div className="text-[11px] font-medium uppercase tracking-wider text-[var(--muted)]">
        {label}
      </div>
      <div
        className={`mt-1.5 text-sm font-semibold tabular-nums ${tone}`}
        aria-live="polite"
      >
        {isMissing
          ? "—"
          : showFallback
            ? `${fallbackLabel} = ${formatUsd(displayValue)}`
            : `Short P&L + ${label.includes("Down") ? "Downside" : "Upside"} = ${formatUsd(displayValue)}`}
      </div>
      <p className="mt-1 text-[11px] text-[var(--muted)]">
        {showFallback
          ? "No short position — showing raw P&L"
          : hint ?? "Add a short and out-of-range data to see coverage"}
      </p>
    </div>
  );
}

interface FormActionsProps {
  onCancel: () => void;
  submitLabel: string;
  submitTone?: "primary" | "danger";
}

function FormActions({
  onCancel,
  submitLabel,
  submitTone = "primary",
}: FormActionsProps) {
  const submitClass =
    submitTone === "danger"
      ? "bg-rose-600 hover:bg-rose-600/90 text-white"
      : "bg-[var(--accent-solid)] hover:bg-[var(--accent-solid)]/90 text-white";
  return (
    <div className="flex justify-end gap-2 px-5 py-4">
      <button
        type="button"
        onClick={onCancel}
        className="inline-flex h-9 items-center justify-center rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)] px-4 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--surface-2)]/70"
      >
        Cancel
      </button>
      <button
        type="submit"
        className={`inline-flex h-9 items-center justify-center rounded-md px-4 text-sm font-medium shadow-sm transition-colors ${submitClass}`}
      >
        {submitLabel}
      </button>
    </div>
  );
}
