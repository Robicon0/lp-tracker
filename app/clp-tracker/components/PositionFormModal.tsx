"use client";

import {
  type FormEvent,
  useMemo,
  useState,
} from "react";
import {
  calcScalpFromWithdrawn,
  calcClosedProfit,
  calcWideRangePercent,
  depositedFromLiquidity,
  entryPriceFromDeposited,
  entryPriceFromTokens,
  liquidityFromDeposited,
  splitDepositedIntoTokens,
  type EntryPriceFromTokens,
  type ILResult,
  type TokenSplit,
} from "../lib/calculations";
import {
  HYPOTHETICAL_DIM,
  HypotheticalNotice,
} from "../components/Hypothetical";
import {
  ModalShell,
} from "./ClaimFormModal";
import type {
  Position,
} from "../lib/types";
import {
  DateOrderWarning,
  DateTimeFields,
  Field,
  FormActions,
  Section,
  inputClass,
} from "./PositionFormParts";
import {
  PositionFormState,
  computeShortTotal,
  fmtTokenAmount,
  formDeposited,
  formatAmountInput,
  formatPercent,
  formatUsd,
  normalizeFeeTier,
  num,
  optionalNum,
  pnlColor,
  tryComputeIL,
} from "../lib/positionFormUtils";

// The token counts an auto-split replaced, kept only to show them back to
// the user in the amber note.
export interface TokenSplitWarning {
  base: string;
  quote: string;
}


// What a confirmed recalculation replaced, kept to report it back after the
// panel closes.
export interface RecalcSummary {
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
export function RecalcFromTokensPanel({
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
export function ClosedProfitSummary({
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
export function InputModeTabs({
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


export interface PositionFormModalProps {
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


export function PositionFormModal({
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


export interface OutOfRangeBoxProps {
  label: string;
  il: ILResult | null;
  profit: number | null;
  baseSymbol: string;
  quoteSymbol: string;
}


export function OutOfRangeBox({
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


export interface NetCoverageBoxProps {
  label: string;
  shortPresent: boolean;
  value: number | null;
  positiveHint: string;
  negativeHint: string;
  fallbackLabel: string;
  fallbackValue: number | null;
}


export function NetCoverageBox({
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
