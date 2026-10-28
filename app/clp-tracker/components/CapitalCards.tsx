"use client";

import Link from "next/link";
import { useState, type FormEvent, type ReactNode } from "react";
import { calcInitialCapital, type OverallPnL } from "../lib/calculations";
import {
  getCapitalContributions,
  newRecordId,
  saveCapitalContributions,
  softDeleteCapitalContribution,
} from "../lib/storage";
import type { CapitalContribution } from "../lib/types";
import { DisclosureToggle } from "./Breakdown";
import { ModalShell } from "./ClaimFormModal";
import { Field, Section, inputClass } from "./PositionFormParts";
import { formatUsd, formatSignedUsd, usePrivacyMode, maskAmountsInText } from "../lib/format";

function pnlColor(value: number): string {
  if (value > 0) return "text-emerald-400";
  if (value < 0) return "text-rose-400";
  return "text-[var(--foreground)]";
}

const cardClass =
  "rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5";
const labelClass =
  "text-[11px] font-medium uppercase tracking-wider text-[var(--muted)]";
const valueClass = "mt-2 text-2xl font-semibold tracking-tight";
const hintClass = "mt-2 text-[11px] text-[var(--muted)]";

// Shared by the Dashboard and the Total P&L page so the two can never drift
// apart (Invariant #6). The figure is DERIVED — calcInitialCapital over the
// capital ledger the page loaded with getCapitalContributions() — so it can't
// be retyped; the history modal adds or soft-deletes entries instead.
export function InitialCapitalCard({
  contributions,
  onChanged,
  loadError,
}: {
  contributions: CapitalContribution[];
  // Called with the re-read live ledger after every add or delete, so the page
  // recomputes Overall P&L / Growth Target from the same list the card shows.
  onChanged: (next: CapitalContribution[]) => void;
  loadError?: string | null;
}) {
  usePrivacyMode();
  const [open, setOpen] = useState(false);
  const value = calcInitialCapital(contributions);

  return (
    <div className={cardClass}>
      <div className="flex items-center justify-between gap-2">
        <span className={labelClass}>Initial Capital</span>
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Initial capital history"
          className="text-[11px] font-medium text-[var(--muted)] transition-colors hover:text-[var(--accent)]"
        >
          History
        </button>
      </div>

      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`${valueClass} block text-left text-[var(--foreground)] hover:text-[var(--accent)]`}
      >
        {formatUsd(value)}
      </button>

      {loadError && (
        <p role="alert" className="mt-2 text-[11px] text-rose-300">
          {loadError}
        </p>
      )}

      <p className={hintClass}>
        Capital put into this LP business, less capital taken back out. The sum
        of {contributions.length}{" "}
        {contributions.length === 1 ? "entry" : "entries"} in its history.
      </p>

      {open && (
        <CapitalHistoryModal
          contributions={contributions}
          onChanged={onChanged}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

function todayInputDate(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Entries are stored at UTC midnight of the chosen day, so they are shown in
// UTC too: a local-time render would move 25 Nov to 24 Nov west of Greenwich.
const entryDateFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

function formatEntryDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : entryDateFormatter.format(d);
}

function CapitalHistoryModal({
  contributions,
  onChanged,
  onClose,
}: {
  contributions: CapitalContribution[];
  onChanged: (next: CapitalContribution[]) => void;
  onClose: () => void;
}) {
  usePrivacyMode();
  const [kind, setKind] = useState<"deposit" | "withdrawal">("deposit");
  const [date, setDate] = useState(todayInputDate());
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const rows = [...contributions].sort((a, b) => b.date.localeCompare(a.date));
  const total = calcInitialCapital(contributions);

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSaved(null);
    const missing: string[] = [];
    if (date.trim() === "") missing.push("Date");
    if (amount.trim() === "") missing.push("Amount");
    if (missing.length > 0) {
      setFormError(
        `Not saved — ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} still empty.`,
      );
      return;
    }
    const parsed = Number(amount);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setFormError(
        "Not saved — Amount must be a number above zero. Pick Withdrawal to take capital out.",
      );
      return;
    }
    const signed = kind === "deposit" ? parsed : -parsed;
    try {
      saveCapitalContributions([
        ...getCapitalContributions(),
        {
          id: newRecordId(),
          date: `${date}T00:00:00.000Z`,
          amount: signed,
          notes: notes.trim(),
        },
      ]);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setFormError(`Couldn’t save — ${detail}. Nothing was changed.`);
      return;
    }
    setFormError(null);
    onChanged(getCapitalContributions());
    setSaved(
      `Added ${kind === "deposit" ? "deposit" : "withdrawal"} of ${formatUsd(parsed)} on ${formatEntryDate(`${date}T00:00:00.000Z`)}.`,
    );
    setAmount("");
    setNotes("");
  };

  const confirmDelete = (id: string) => {
    try {
      softDeleteCapitalContribution(id);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setDeleteError(`Couldn’t delete — ${detail}. Nothing was changed.`);
      return;
    }
    setDeleteError(null);
    setPendingDelete(null);
    onChanged(getCapitalContributions());
  };

  const toggleClass = (active: boolean, tone: "pos" | "neg") =>
    `inline-flex h-9 flex-1 items-center justify-center rounded-md border px-4 text-sm font-medium transition-colors ${
      active
        ? tone === "pos"
          ? "border-emerald-500/60 bg-emerald-500/10 text-emerald-400"
          : "border-rose-500/60 bg-rose-500/10 text-rose-400"
        : "border-[var(--border-strong)] bg-[var(--surface-2)] text-[var(--muted)] hover:text-[var(--foreground)]"
    }`;

  return (
    <ModalShell title="Initial Capital history" onCancel={onClose}>
      <div className="px-5 py-4">
        {rows.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">
            No entries yet. Add the capital you put into the business below.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-[var(--muted)]">
                <th className="pb-2 font-medium">Date</th>
                <th className="pb-2 text-right font-medium">Amount</th>
                <th className="pb-2 pl-4 font-medium">Notes</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {rows.map((c) => (
                <tr key={c.id}>
                  <td className="whitespace-nowrap py-2 pr-4">
                    {formatEntryDate(c.date)}
                  </td>
                  <td
                    className={`whitespace-nowrap py-2 text-right tabular-nums ${pnlColor(c.amount)}`}
                  >
                    {formatSignedUsd(c.amount)}
                  </td>
                  <td className="py-2 pl-4 text-[var(--muted)]">{maskAmountsInText(c.notes)}</td>
                  <td className="whitespace-nowrap py-2 pl-4 text-right">
                    {pendingDelete === c.id ? (
                      <span className="inline-flex gap-2">
                        <button
                          type="button"
                          onClick={() => confirmDelete(c.id)}
                          className="text-[11px] font-medium text-rose-400 hover:text-rose-300"
                        >
                          Confirm delete
                        </button>
                        <button
                          type="button"
                          onClick={() => setPendingDelete(null)}
                          className="text-[11px] font-medium text-[var(--muted)] hover:text-[var(--foreground)]"
                        >
                          Keep
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setPendingDelete(c.id)}
                        aria-label={`Delete entry of ${formatSignedUsd(c.amount)} on ${formatEntryDate(c.date)}`}
                        className="text-[11px] font-medium text-[var(--muted)] hover:text-rose-400"
                      >
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-[var(--border-strong)] font-semibold">
                <td className="pt-2">Initial Capital</td>
                <td className="pt-2 text-right tabular-nums">{formatUsd(total)}</td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          </table>
        )}
        {deleteError && (
          <p role="alert" className="mt-2 text-[12px] text-rose-300">
            {deleteError}
          </p>
        )}
      </div>

      <form
        noValidate
        onSubmit={submit}
        className="border-t border-[var(--border)]"
      >
        <Section title="Add entry">
          <div className="mb-4 flex gap-2" role="group" aria-label="Entry type">
            <button
              type="button"
              aria-pressed={kind === "deposit"}
              onClick={() => setKind("deposit")}
              className={toggleClass(kind === "deposit", "pos")}
            >
              Deposit
            </button>
            <button
              type="button"
              aria-pressed={kind === "withdrawal"}
              onClick={() => setKind("withdrawal")}
              className={toggleClass(kind === "withdrawal", "neg")}
            >
              Withdrawal
            </button>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Date" htmlFor="cap_date">
              <input
                id="cap_date"
                type="date"
                className={inputClass}
                style={{ colorScheme: "dark" }}
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </Field>
            <Field label="Amount (USD)" htmlFor="cap_amount">
              <input
                id="cap_amount"
                type="number"
                step="any"
                min="0"
                className={inputClass}
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </Field>
          </div>
          <div className="mt-4">
            <Field label="Notes (optional)" htmlFor="cap_notes">
              <input
                id="cap_notes"
                className={inputClass}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </Field>
          </div>
        </Section>
        {formError && (
          <div role="alert" className="px-5 py-3 text-[12px] text-rose-300">
            {formError}
          </div>
        )}
        {saved && !formError && (
          <div role="status" className="px-5 py-3 text-[12px] text-emerald-400">
            {saved}
          </div>
        )}
        <div className="flex justify-end gap-2 px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 items-center justify-center rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)] px-4 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--surface-2)]/70"
          >
            Close
          </button>
          <button
            type="submit"
            className="inline-flex h-9 items-center justify-center rounded-md bg-[var(--accent-solid)] px-4 text-sm font-medium text-white shadow-sm transition-colors hover:bg-[var(--accent-solid)]/90"
          >
            Add entry
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

export function OverallPnLCard({
  result,
  breakdown,
  heldFeesValue,
}: {
  result: OverallPnL;
  // The live formula rows, so the number is auditable. BOTH pages that show
  // this card pass the identical construction, because a figure that reads one
  // way on the Dashboard and another on Total P&L is exactly what Invariant #6
  // forbids. Pass `<Breakdown collapsible={false} .../>` — this card owns the
  // toggle, so a Breakdown with its own would nest one inside the other.
  breakdown?: ReactNode;
  // What the excluded still-held tokens are worth today. The hint always said
  // they were excluded; naming the figure says HOW MUCH is excluded, which is
  // the part that actually tells you whether the exclusion matters.
  // MUST be calcUnconvertedHoldings(claims, mergedPrices).totalCurrentValue —
  // the same helper and the same fetched+manual price merge Total P&L's
  // Fees Earned card shows as "still held", so the two can never disagree.
  // Undefined (or zero, when there is nothing held) renders the old sentence.
  heldFeesValue?: number;
}) {
  usePrivacyMode();
  const [open, setOpen] = useState(false);

  return (
    <div className={cardClass}>
      <div className={labelClass}>Overall P&amp;L</div>
      <div className={`${valueClass} ${pnlColor(result.overall)}`}>
        {formatUsd(result.overall)}
      </div>

      {/* Unvalued converted claims are counted as $0 in the figure above, so
          the warning sits OUTSIDE the disclosure, always visible. It used to
          live behind the collapsed toggle, which meant a figure silently
          missing money looked exactly like a complete one — and Total P&L,
          which also renders this card, has no Data Health list to catch it.
          The count is calcOverallPnL's own (isUnvaluedConvertedClaim), the
          same predicate as the Claims banner the link lands on, so the three
          surfaces cannot disagree. No value is guessed: the gap is shown, not
          filled. */}
      {result.unvaluedConvertedClaims > 0 && (
        <div
          role="alert"
          className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/[0.08] px-2.5 py-2 text-[11px] text-amber-300"
        >
          <span className="font-medium">
            {result.unvaluedConvertedClaims} converted{" "}
            {result.unvaluedConvertedClaims === 1 ? "claim has" : "claims have"}{" "}
            no USD value
          </span>{" "}
          and {result.unvaluedConvertedClaims === 1 ? "is" : "are"} counted as
          $0 in this figure.{" "}
          <Link
            href="/clp-tracker/claims#incomplete-claims"
            className="underline underline-offset-2 hover:text-amber-200"
          >
            Add {result.unvaluedConvertedClaims === 1 ? "its value" : "their values"}
          </Link>
        </div>
      )}

      {/* Everything that explains the number — the hint, the Converted Fees
          split and the numeric formula — sits
          behind ONE toggle, collapsed by default, in the order it has always
          been rendered. Four always-on blocks made this card several times the
          height of its neighbours in the same grid for a figure most visits
          only need to read. Same control as every other card's breakdown. */}
      <div className="mt-2">
        <DisclosureToggle open={open} onToggle={() => setOpen((o) => !o)} />
      </div>

      {open && (
        <>
          <p className={hintClass}>
            Current active positions + realized converted profit − Initial
            Capital. Pure LP business performance — personal spending /
            withdrawals are tracked separately as Available Balance on the
            Transfers page. Excludes tokens you&apos;re still holding
            {heldFeesValue !== undefined && heldFeesValue !== 0
              ? ` — ${formatUsd(heldFeesValue)} at today's value`
              : ""}{" "}
            (see Business P&amp;L for that).
          </p>
          {/* The two halves of Converted Fees, named. Same total as before —
              this only says what the number is made of, so "realized converted
              profit" above stops being opaque. Rendered only when there is
              something to split; a business with no stablecoin-leg recovery
              reads the same as it always did. */}
          {result.convertedFees !== 0 && result.mixedStableRecovered !== 0 && (
            <p className="mt-2 text-[11px] text-[var(--muted)]">
              Converted Fees {formatUsd(result.convertedFees)} ={" "}
              {formatUsd(result.convertedFromTokens)} converted from tokens
              (ETH, SOL, etc.) + {formatUsd(result.mixedStableRecovered)}{" "}
              already earned in stablecoin.
            </p>
          )}
          {breakdown}
        </>
      )}
    </div>
  );
}
