"use client";

import {
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
  useEffect,
  useState,
} from "react";
import {
  getClaims,
  getPositions,
  saveClaims,
  savePositions,
} from "../lib/storage";
import { getEffectiveDeposited } from "../lib/calculations";
import {
  reconcileClaimTransfers,
  type ReconcileResult,
} from "../lib/transferAutomation";
import type { FeeClaim, Position } from "../lib/types";

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const optionDateFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
});

// Enriched label so positions with identical pair/protocol/fee tier/chain
// stay distinguishable: entry date, close date (if closed), deposited, and the
// current/last value are the disambiguators.
export function positionOptionLabel(p: Position): string {
  const parts = [p.pair];
  if (p.protocol) parts.push(p.protocol);
  const entry = new Date(p.entryDatetime);
  if (!Number.isNaN(entry.getTime())) {
    parts.push(`opened ${optionDateFormatter.format(entry)}`);
  }
  if (p.status === "closed" && p.exitDatetime) {
    const exit = new Date(p.exitDatetime);
    if (!Number.isNaN(exit.getTime())) {
      parts.push(`closed ${optionDateFormatter.format(exit)}`);
    } else {
      parts.push("closed");
    }
  }
  const deposited = getEffectiveDeposited(p);
  if (deposited > 0) parts.push(`dep ${usdFormatter.format(deposited)}`);
  const current = p.currentBalance;
  if (Number.isFinite(current) && current > 0) {
    parts.push(`now ${usdFormatter.format(current)}`);
  }
  return parts.join(" · ");
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

export function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `id_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function todayDateInput(): string {
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60_000).toISOString().slice(0, 10);
}

export interface ClaimFormState {
  positionId: string;
  date: string;
  currentPositionValue: string;
  txId: string;
  pair: string;
  platform: string;
  chain: string;
  token1Symbol: string;
  token1Amount: string;
  token2Symbol: string;
  token2Amount: string;
  convertedToStable: boolean;
  stableSymbol: string;
  stableAmount: string;
  notes: string;
}

const EMPTY_FORM: ClaimFormState = {
  positionId: "",
  date: "",
  currentPositionValue: "",
  txId: "",
  pair: "",
  platform: "",
  chain: "",
  token1Symbol: "",
  token1Amount: "",
  token2Symbol: "",
  token2Amount: "",
  convertedToStable: false,
  stableSymbol: "USDC",
  stableAmount: "",
  notes: "",
};

function claimToForm(c: FeeClaim): ClaimFormState {
  return {
    positionId: c.positionId,
    date: c.date.slice(0, 10),
    currentPositionValue:
      c.currentPositionValue === null || c.currentPositionValue === undefined
        ? ""
        : String(c.currentPositionValue),
    txId: c.txId ?? "",
    pair: c.pair,
    platform: c.platform,
    chain: c.chain,
    token1Symbol: c.token1Symbol,
    token1Amount: String(c.token1Amount),
    token2Symbol: c.token2Symbol,
    token2Amount: String(c.token2Amount),
    convertedToStable: c.convertedToStable,
    stableSymbol: c.stableSymbol ?? "USDC",
    stableAmount: c.stableAmount === null ? "" : String(c.stableAmount),
    notes: c.notes,
  };
}

function buildClaim(id: string, form: ClaimFormState): FeeClaim {
  return {
    id,
    positionId: form.positionId,
    date: form.date,
    pair: form.pair.trim().toUpperCase(),
    platform: form.platform.trim().toUpperCase(),
    chain: form.chain.trim().toUpperCase(),
    token1Symbol: form.token1Symbol.trim().toUpperCase(),
    token1Amount: num(form.token1Amount),
    token2Symbol: form.token2Symbol.trim().toUpperCase(),
    token2Amount: num(form.token2Amount),
    convertedToStable: form.convertedToStable,
    // stableSymbol only populated when converted (tracks which stable was
    // cashed out to); stableAmount is always captured — it is the USD value
    // of the claim regardless of conversion status (Invariant #10).
    stableSymbol: form.convertedToStable
      ? form.stableSymbol.trim().toUpperCase() || null
      : null,
    stableAmount: optionalNum(form.stableAmount),
    currentPositionValue: optionalNum(form.currentPositionValue),
    txId: form.txId.trim() === "" ? null : form.txId.trim(),
    // Trimmed but NOT upper-cased: the save path has to agree with the input,
    // or typed case would survive every keystroke and be lost on Save.
    notes: form.notes.trim(),
  };
}

function applyPositionValueUpdate(claim: FeeClaim): void {
  if (claim.currentPositionValue === null || !claim.positionId) return;
  const positions = getPositions();
  let changed = false;
  const updated = positions.map((p) => {
    if (p.id === claim.positionId) {
      changed = true;
      return { ...p, currentBalance: claim.currentPositionValue ?? p.currentBalance };
    }
    return p;
  });
  if (changed) savePositions(updated);
}

// Shared save paths so /claims and /positions persist claims identically
// (Invariant #6 — never duplicate this logic per page). Both also reconcile
// the claim's auto Transfer (Transfers automation, Phase B): a single-token
// claim needs no network so its transfer appears synchronously; a two-token
// claim fetches a historical split, hence fire-and-forget. An auto transfer
// the user has since edited is left untouched (reconcile detects this).
export function persistNewClaim(claim: FeeClaim): void {
  saveClaims([...getClaims(), claim]);
  applyPositionValueUpdate(claim);
  void reconcileClaimTransfers(claim);
}

// Returns the reconcile outcome so a caller can tell the user when their edit
// did NOT reach the linked transfer — "skipped-touched" means the user had
// already sent, deployed or expensed that transfer, so reconcile deliberately
// left it alone. That decision is unchanged; it was simply invisible before,
// because the promise was discarded. Callers that have nothing to say about it
// (the bulk symbol fix) can still ignore the result.
export async function persistUpdatedClaim(
  claim: FeeClaim,
): Promise<ReconcileResult> {
  saveClaims(getClaims().map((c) => (c.id === claim.id ? claim : c)));
  applyPositionValueUpdate(claim);
  return reconcileClaimTransfers(claim);
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

const inputClass =
  "block w-full rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--foreground)] placeholder:text-[var(--muted)]/60 [color-scheme:dark] caret-[var(--accent)] focus:border-[var(--accent)] focus:bg-[var(--surface-2)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]";

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

interface FormActionsProps {
  onCancel: () => void;
  submitLabel: string;
}

function FormActions({ onCancel, submitLabel }: FormActionsProps) {
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
        className="inline-flex h-9 items-center justify-center rounded-md bg-[var(--accent)] px-4 text-sm font-medium text-white shadow-sm transition-colors hover:bg-[var(--accent)]/90"
      >
        {submitLabel}
      </button>
    </div>
  );
}

const PRESET_STABLES = ["USDC", "USDT"] as const;

// seedPositionId pre-fills the position and everything derived from it. It is
// either a LOCKED position (the /positions claim flow — the field is then
// read-only) or a merely PRE-SELECTED one (the /claims page passing its current
// position filter through), which seeds identically but stays editable.
function initialForm(
  mode: "add" | "edit",
  claim: FeeClaim | undefined,
  seedPositionId: string | undefined,
  positions: Position[],
): ClaimFormState {
  if (mode === "edit" && claim) return claimToForm(claim);
  const base = { ...EMPTY_FORM, date: todayDateInput() };
  if (seedPositionId) {
    const p = positions.find((pos) => pos.id === seedPositionId);
    if (p) {
      base.positionId = p.id;
      base.pair = p.pair;
      base.platform = p.protocol;
      base.chain = p.chain;
      base.token1Symbol = p.token1Symbol;
      base.token2Symbol = p.token2Symbol;
    }
  }
  return base;
}

export interface ClaimFormModalProps {
  mode: "add" | "edit";
  positions: Position[];
  claim?: FeeClaim;
  lockedPositionId?: string;
  // Pre-selects a position without locking it — the user can still change it.
  // Ignored when lockedPositionId is set, which is the stronger statement.
  initialPositionId?: string;
  onSubmit: (claim: FeeClaim) => void;
  onCancel: () => void;
}

export function ClaimFormModal({
  mode,
  positions,
  claim,
  lockedPositionId,
  initialPositionId,
  onSubmit,
  onCancel,
}: ClaimFormModalProps) {
  const [form, setForm] = useState<ClaimFormState>(() =>
    initialForm(mode, claim, lockedPositionId ?? initialPositionId, positions),
  );
  const [positionError, setPositionError] = useState<string | null>(null);
  const [valueError, setValueError] = useState<string | null>(null);

  const title = mode === "add" ? "Add Claim" : "Edit Claim";
  const submitLabel = mode === "add" ? "Add Claim" : "Save Changes";
  const lockedPosition = lockedPositionId
    ? positions.find((p) => p.id === lockedPositionId) ?? null
    : null;

  const set = <K extends keyof ClaimFormState>(
    key: K,
    value: ClaimFormState[K],
  ) => setForm((prev) => ({ ...prev, [key]: value }));

  const upper =
    (key: keyof ClaimFormState) =>
    (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      set(key, e.target.value.toUpperCase() as ClaimFormState[typeof key]);

  const onPositionChange = (e: ChangeEvent<HTMLSelectElement>) => {
    const id = e.target.value;
    if (id) setPositionError(null);
    setForm((prev) => {
      const next = { ...prev, positionId: id };
      const p = positions.find((pos) => pos.id === id);
      if (p) {
        next.pair = p.pair;
        next.platform = p.protocol;
        next.chain = p.chain;
        if (!prev.token1Symbol) next.token1Symbol = p.token1Symbol;
        if (!prev.token2Symbol) next.token2Symbol = p.token2Symbol;
      }
      return next;
    });
  };

  const stableMode: "USDC" | "USDT" | "OTHER" = (
    PRESET_STABLES as readonly string[]
  ).includes(form.stableSymbol)
    ? (form.stableSymbol as "USDC" | "USDT")
    : "OTHER";

  const onStableModeChange = (e: ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value as "USDC" | "USDT" | "OTHER";
    if (v === "OTHER") set("stableSymbol", "");
    else set("stableSymbol", v);
  };

  // Soft warning: token amounts without a USD value save fine but
  // contribute $0 to Fee APR — surface that before the user saves.
  const usdValueMissing =
    (num(form.token1Amount) > 0 || num(form.token2Amount) > 0) &&
    form.stableAmount.trim() === "";

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    // No orphan claims — every claim must link to a position (Invariant #10).
    if (!form.positionId) {
      setPositionError("Please select which position this claim is for");
      return;
    }
    // Hard block only when there is nothing to record at all.
    if (
      num(form.token1Amount) <= 0 &&
      num(form.token2Amount) <= 0 &&
      num(form.stableAmount) <= 0
    ) {
      setValueError(
        "Nothing to record — enter a token amount or a Claim USD Value",
      );
      return;
    }
    onSubmit(buildClaim(claim?.id ?? newId(), form));
  };

  return (
    <ModalShell title={title} onCancel={onCancel}>
      <form onSubmit={submit} className="divide-y divide-[var(--border)]">
        <Section title="Claim Details">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {lockedPosition ? (
              <div className="space-y-1.5">
                <span className="block text-[11px] font-medium uppercase tracking-wider text-[var(--muted)]">
                  Position
                </span>
                <div className="rounded-md border border-dashed border-[var(--border-strong)] bg-[var(--surface-2)]/40 px-3 py-2 text-sm text-[var(--foreground)]">
                  {positionOptionLabel(lockedPosition)}
                </div>
                <p className="text-[11px] text-[var(--muted)]">
                  Claim is logged against this position
                </p>
              </div>
            ) : (
              <Field label="Position" htmlFor="positionId">
                <select
                  id="positionId"
                  required
                  value={form.positionId}
                  onChange={onPositionChange}
                  className={inputClass}
                >
                  <option value="">— Select position —</option>
                  {positions.map((p) => (
                    <option key={p.id} value={p.id}>
                      {positionOptionLabel(p)}
                    </option>
                  ))}
                </select>
                {positionError && (
                  <p className="text-[11px] text-amber-400" aria-live="polite">
                    ⚠️ {positionError}
                  </p>
                )}
              </Field>
            )}
            <Field label="Date" htmlFor="date">
              <input
                id="date"
                type="date"
                required
                className={inputClass}
                style={{ colorScheme: "dark" }}
                value={form.date}
                onChange={(e) => set("date", e.target.value)}
              />
            </Field>
            <Field
              label="Current Position Value (USD)"
              htmlFor="currentPositionValue"
              hint="This will automatically update your position's current balance"
            >
              <input
                id="currentPositionValue"
                type="number"
                step="any"
                className={inputClass}
                placeholder="Current value of your LP position"
                value={form.currentPositionValue}
                onChange={(e) => set("currentPositionValue", e.target.value)}
              />
            </Field>
            <Field
              label="Transaction ID (optional)"
              htmlFor="txId"
              hint="From your blockchain explorer e.g. etherscan.io"
            >
              <input
                id="txId"
                className={inputClass}
                placeholder="Paste transaction hash or explorer URL"
                value={form.txId}
                onChange={(e) => set("txId", e.target.value)}
              />
            </Field>
            <Field label="Pair" htmlFor="pair">
              <input
                id="pair"
                required
                className={inputClass}
                placeholder="ETH/USDC (0.05%)"
                value={form.pair}
                onChange={upper("pair")}
              />
            </Field>
            <Field label="Platform" htmlFor="platform">
              <input
                id="platform"
                required
                className={inputClass}
                placeholder="Aerodrome"
                value={form.platform}
                onChange={upper("platform")}
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
          </div>
        </Section>

        <Section title="Token 1 Fees">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Token 1 Symbol" htmlFor="token1Symbol">
              <input
                id="token1Symbol"
                required
                className={inputClass}
                placeholder="ETH"
                value={form.token1Symbol}
                onChange={upper("token1Symbol")}
              />
            </Field>
            <Field label="Token 1 Amount" htmlFor="token1Amount">
              <input
                id="token1Amount"
                type="number"
                step="any"
                required
                className={inputClass}
                value={form.token1Amount}
                onChange={(e) => set("token1Amount", e.target.value)}
              />
            </Field>
          </div>
        </Section>

        <Section title="Token 2 Fees">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Token 2 Symbol" htmlFor="token2Symbol">
              <input
                id="token2Symbol"
                required
                className={inputClass}
                placeholder="USDC"
                value={form.token2Symbol}
                onChange={upper("token2Symbol")}
              />
            </Field>
            <Field label="Token 2 Amount" htmlFor="token2Amount">
              <input
                id="token2Amount"
                type="number"
                step="any"
                required
                className={inputClass}
                value={form.token2Amount}
                onChange={(e) => set("token2Amount", e.target.value)}
              />
            </Field>
          </div>
        </Section>

        <Section title="Claim USD Value">
          <Field
            label="Claim USD Value"
            htmlFor="stableAmount"
            hint="USD value of this claim. Required if any token amount is entered."
          >
            <input
              id="stableAmount"
              type="number"
              step="any"
              placeholder="0.00"
              className={inputClass}
              value={form.stableAmount}
              onChange={(e) => {
                setValueError(null);
                set("stableAmount", e.target.value);
              }}
            />
            {usdValueMissing && (
              <p className="text-[11px] text-amber-400" aria-live="polite">
                ⚠️ No USD value entered — this claim will contribute $0 to
                Total Fees and Fee APR until a value is added.
              </p>
            )}
            {valueError && (
              <p className="text-[11px] text-amber-400" aria-live="polite">
                ⚠️ {valueError}
              </p>
            )}
          </Field>
        </Section>

        <Section title="Conversion (optional — for tracking cash-outs)">
          <div className="space-y-4">
            <p className="text-[11px] text-[var(--muted)]">
              Tracks whether you cashed out fees to a stablecoin. USD value
              above is captured either way.
            </p>
            <div className="flex items-center gap-3">
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
                  aria-checked={form.convertedToStable}
                  onClick={() => set("convertedToStable", true)}
                  className={`h-8 px-4 text-xs font-medium transition-colors ${
                    form.convertedToStable
                      ? "bg-[var(--accent)] text-white"
                      : "bg-[var(--surface-2)] text-[var(--muted)] hover:bg-[var(--surface-2)]/70"
                  }`}
                >
                  Yes
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={!form.convertedToStable}
                  onClick={() => set("convertedToStable", false)}
                  className={`h-8 px-4 text-xs font-medium border-l border-[var(--border-strong)] transition-colors ${
                    !form.convertedToStable
                      ? "bg-[var(--accent)] text-white"
                      : "bg-[var(--surface-2)] text-[var(--muted)] hover:bg-[var(--surface-2)]/70"
                  }`}
                >
                  No
                </button>
              </div>
            </div>

            {form.convertedToStable && (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Stable Symbol" htmlFor="stableMode">
                  <div className="space-y-2">
                    <select
                      id="stableMode"
                      value={stableMode}
                      onChange={onStableModeChange}
                      className={inputClass}
                    >
                      <option value="USDC">USDC</option>
                      <option value="USDT">USDT</option>
                      <option value="OTHER">Other…</option>
                    </select>
                    {stableMode === "OTHER" && (
                      <input
                        aria-label="Custom stable symbol"
                        className={inputClass}
                        placeholder="DAI"
                        value={form.stableSymbol}
                        onChange={upper("stableSymbol")}
                      />
                    )}
                  </div>
                </Field>
              </div>
            )}
          </div>
        </Section>

        {/* Plain div, not a Section: the Field already renders the "Notes"
            label, and a Section title would print the same word again above
            it. Same shape the Position and Transfer forms use. */}
        <div className="mt-4">
          <Field label="Notes" htmlFor="notes">
            <textarea
              id="notes"
              rows={2}
              className={inputClass}
              placeholder="optional"
              value={form.notes}
              // Free text, saved as typed — the pair/platform/chain/symbol
              // fields above keep upper() because the app groups on them.
              onChange={(e) => set("notes", e.target.value)}
            />
          </Field>
        </div>

        <FormActions onCancel={onCancel} submitLabel={submitLabel} />
      </form>
    </ModalShell>
  );
}
