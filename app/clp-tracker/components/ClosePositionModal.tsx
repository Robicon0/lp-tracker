"use client";

import {
  type FormEvent,
  useCallback,
  useState,
} from "react";
import {
  calcScalpFromWithdrawn,
  getEffectiveDeposited,
} from "../lib/calculations";
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
  formatAmountInput,
  formatUsd,
  nowDatetimeLocal,
  num,
  optionalNum,
  pnlColor,
  pnlLabel,
} from "../lib/positionFormUtils";

export type HistoricalPriceState =
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


export const PRICE_SOURCE_LABEL: Record<string, string> = {
  stable: "stablecoin — anchored to $1.00, not fetched",
  defillama: "DeFiLlama, priced at the exact exit time",
  coingecko: "CoinGecko — daily snapshot only, not the exact time",
};


export function CloseModeTabs({
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
export function ExitPricePanel({
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


export interface ClosePositionModalProps {
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


export function ClosePositionModal({
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

  // The claim section is OPTIONAL as a whole but ALL-OR-NOTHING once touched.
  // Partially filled, it used to submit anyway: the blank fields became 0 (or a
  // null USD value), producing a claim that under-reports fee income and lands
  // on the Claims page as an "incomplete claim" the user then has to chase.
  // Nothing on screen said so.
  //
  // "Touched" is a non-empty FIELD, not a positive number — an explicit "0" is
  // a real answer ("no fees on this side") and must count as filled, while
  // testing `num(x) > 0` would read it as untouched and let a half-filled
  // section through. Transaction ID is excluded on purpose: it is labelled
  // optional and stays optional.
  const claimFieldState: { label: string; value: string }[] = [
    { label: `${position.token1Symbol || "Token 1"} Amount`, value: claimTokens1 },
    { label: `${position.token2Symbol || "Token 2"} Amount`, value: claimTokens2 },
    { label: "Claim USD Value", value: claimUsdValue },
  ];
  const claimSectionInUse = claimFieldState.some((f) => f.value.trim() !== "");
  const missingClaimFields = claimSectionInUse
    ? claimFieldState.filter((f) => f.value.trim() === "").map((f) => f.label)
    : [];
  const [showClaimError, setShowClaimError] = useState(false);

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

  // Two REQUIRED close fields, checked on submit rather than by disabling the
  // button — a disabled button says nothing about why. Position closed: in
  // token mode it usually pre-fills from the received split (untouched here);
  // in manual mode nothing derives it, so it could be left unpicked and the
  // close saved with no exit side. Close Transaction Link: only non-blank is
  // required — a literal "-" is a deliberate answer and passes. Not validated
  // as a URL on purpose; the point is a conscious entry, not a real link.
  const missingCloseFields: string[] = [
    ...(rangeExit === "" ? ["Position closed (Above / Below / Still in range)"] : []),
    ...(closeTxLink.trim() === "" ? ["Close Transaction Link"] : []),
  ];
  const [showCloseError, setShowCloseError] = useState(false);

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
    const closeBlocked = missingCloseFields.length > 0;
    const claimBlocked = missingClaimFields.length > 0;
    // Both checks run together so one click names EVERYTHING missing, rather
    // than revealing the next problem only after the first is fixed.
    setShowCloseError(closeBlocked);
    if (claimBlocked) {
      // Blocked, and the reason goes on screen — never a dead button. The
      // section auto-opens so the named fields are actually visible; a message
      // about fields hidden inside a collapsed section explains nothing.
      setShowClaimError(true);
      setClaimSectionOpen(true);
    }
    if (closeBlocked || claimBlocked) return;
    setShowClaimError(false);
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
              label="Close Transaction Link"
              htmlFor="c_txLink"
              hint="From your blockchain explorer e.g. hyperliquid.xyz, suiscan.xyz, basescan.org — or type “-” if you don’t have one"
            >
              <input
                id="c_txLink"
                className={inputClass}
                placeholder="Paste transaction hash or explorer URL"
                aria-required="true"
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
        {showCloseError && missingCloseFields.length > 0 && (
          <div role="alert" className="px-5 py-3 text-[12px] text-rose-300">
            Can&rsquo;t close yet — {missingCloseFields.join(" and ")}{" "}
            {missingCloseFields.length === 1 ? "is" : "are"} still missing.
            {closeTxLink.trim() === "" &&
              " If you don’t have a transaction link, type “-” to confirm there isn’t one."}
          </div>
        )}
        {showClaimError && missingClaimFields.length > 0 && (
          <div role="alert" className="px-5 py-3 text-[12px] text-rose-300">
            Can&rsquo;t close yet — you&rsquo;ve started a fee claim, so{" "}
            {missingClaimFields.join(" and ")}{" "}
            {missingClaimFields.length === 1 ? "is" : "are"} still empty. Fill{" "}
            {missingClaimFields.length === 1 ? "it" : "them"} in, or clear the
            claim fields to close without recording a claim. (Transaction ID
            stays optional.)
          </div>
        )}
        <FormActions
          onCancel={onCancel}
          submitLabel="Confirm Close"
          submitTone="danger"
        />
      </form>
    </ModalShell>
  );
}
