"use client";

import Link from "next/link";
import {
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  getBusinessPnLSettings,
  getClaims,
  getDeletedTransfers,
  getOutlierDismissals,
  getPositions,
  getSettings,
  getTransfers,
  getWithdrawals,
  migrateTransferMoneyStatus,
  purgeTransfer,
  restoreTransfer,
  saveBusinessPnLSettings,
  saveOutlierDismissals,
  saveTransfers,
  saveWithdrawals,
  softDeleteTransfer,
  type BusinessPnLSettings,
} from "../lib/storage";
import {
  correctTransferSymbol,
  dismissalFor,
  findTransferAmountOutliers,
  findDriftedClaimTransfers,
  findIdleUpsideTransfers,
  findOrphanedByClaimDeletion,
  findTransferSymbolMismatches,
  type DriftedClaimTransferRow,
  type OrphanedByClaimRow,
  type OutlierRow,
  type IdleUpsideRow,
  IDLE_UPSIDE_DAYS,
  type TransferSymbolMismatchRow,
} from "../lib/dataHealth";
import { calcExpensesAfter, calcYieldAfter } from "../lib/calculations";
import { OutlierBanner } from "../components/OutlierBanner";
import {
  PositionCombobox,
  type NoteTone,
  type PositionNote,
} from "../components/PositionCombobox";
import { normalizeChain, normalizeToken } from "../lib/nameNormalization";
import {
  applyBulkSplit,
  applyRevertToAuto,
  applyTransferSplit,
  applyUndoSplit,
  buildClaimTransfers,
  createUpsideTransfer,
  eligibleClaimsForBackfill,
  eligibleClosesForBackfill,
  isAutoCreated,
  planBulkSplit,
  planRevertToAuto,
  planTransferSplit,
  planUndoSplit,
  reconcileClaimTransfers,
  type AutoRevertPlan,
  type BulkSplitPlan,
  type TransferSplitPlan,
  type UndoSplitPlan,
} from "../lib/transferAutomation";
import { useHydrated } from "../lib/useHydrated";
import {
  isDeployedTransfer,
  isExpensedTransfer,
  isTransferredToPlatform,
} from "../lib/transferState";
import type {
  AppSettings,
  FeeClaim,
  OutlierDismissal,
  Position,
  Transfer,
  Withdrawal,
} from "../lib/types";

type TransferType = Transfer["transferType"];
type MoneyStatus = NonNullable<Transfer["moneyStatus"]>;

const TYPE_LABELS: Record<TransferType, string> = {
  fees: "Fees",
  undeployed: "Undeployed Tokens",
  outOfRangeUpside: "Out of Range Upside",
  expense: "Expense",
};

const SHORT_TYPE_LABELS: Record<TransferType, string> = {
  fees: "Fees",
  undeployed: "Undeployed",
  outOfRangeUpside: "OOR Upside",
  expense: "Expense",
};

const TYPE_PILL: Record<TransferType, string> = {
  fees: "bg-blue-500/10 text-blue-300 ring-blue-500/30",
  undeployed: "bg-purple-500/10 text-purple-300 ring-purple-500/30",
  outOfRangeUpside: "bg-orange-500/10 text-orange-300 ring-orange-500/30",
  expense: "bg-rose-500/10 text-rose-300 ring-rose-500/30",
};

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function formatUsd(value: number): string {
  return usdFormatter.format(Number.isFinite(value) ? value : 0);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function formatDateDDMMYYYY(value: string): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

function todayDateInput(): string {
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60_000).toISOString().slice(0, 10);
}

function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `id_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function num(value: string): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

interface TransferFormState {
  positionId: string;
  date: string;
  token: string;
  amount: string;
  platform: string;
  destination: string;
  transferType: TransferType;
  moneyStatus: MoneyStatus;
  notes: string;
}

const EMPTY_FORM: TransferFormState = {
  positionId: "",
  date: "",
  token: "",
  amount: "",
  platform: "",
  destination: "",
  transferType: "fees",
  // Redeployed is the safe default: it has no P&L impact, so a transfer
  // saved without thinking about it cannot invent an expense.
  moneyStatus: "redeployed",
  notes: "",
};

function transferToForm(t: Transfer): TransferFormState {
  return {
    positionId: t.positionId,
    date: t.date.slice(0, 10),
    token: t.token,
    amount: String(t.amount),
    platform: t.platform,
    destination: t.destination,
    transferType: t.transferType,
    moneyStatus: t.moneyStatus ?? "redeployed",
    notes: t.notes,
  };
}

function buildTransfer(id: string, form: TransferFormState): Transfer {
  return {
    id,
    positionId: form.positionId,
    date: form.date,
    token: form.token.trim().toUpperCase(),
    amount: num(form.amount),
    platform: form.platform.trim().toUpperCase(),
    destination: form.destination.trim().toUpperCase(),
    transferType: form.transferType,
    // Undeployed Tokens are idle — moneyStatus stays unset ("idle, not yet
    // decided") until the user marks them deployed or edits to an expense.
    moneyStatus:
      form.transferType === "undeployed" ? undefined : form.moneyStatus,
    // Trimmed but NOT upper-cased: notes are prose. Token, platform and
    // destination above stay uppercase — those are grouped and matched on.
    notes: form.notes.trim(),
  };
}

// Expenses are position-less: money that has left the business. They reuse the
// Transfer record (positionId "", token "", transferType/moneyStatus "expense")
// but have their own minimal form — Date, Amount, Notes — since picking a
// position/token/platform makes no sense for them.
interface ExpenseFormState {
  date: string;
  amount: string;
  notes: string;
}


function expenseToForm(t: Transfer): ExpenseFormState {
  return {
    date: t.date.slice(0, 10),
    amount: String(t.amount),
    notes: t.notes,
  };
}

function buildExpense(id: string, form: ExpenseFormState): Transfer {
  return {
    id,
    positionId: "",
    date: form.date,
    token: "",
    amount: num(form.amount),
    platform: "",
    destination: "",
    transferType: "expense",
    moneyStatus: "expense",
    notes: form.notes.trim(),
  };
}

// The four money-state predicates (expensed / deployed / transferred / idle)
// now live in lib/transferState.ts — imported above — so Data Health can ask
// the same question without importing this client page or re-deriving it.
//
// Sentinel deployedToPositionId for "I know this money went into a position,
// I just can't remember which". It deliberately reuses the SAME field rather
// than adding a flag, so every presence-based reader — the Deployed bucket in
// the balance memo, isDeployedTransfer, isUntouchedAuto — treats it exactly
// like a real link with no changes at all. Only the label lookups need to know
// about it. The double-underscore form cannot collide with a stored position id
// (those are crypto.randomUUID values).
const UNKNOWN_POSITION_ID = "__unknown_position__";

// Whether a transfer's money can still be sent somewhere — deploy-linked or
// pushed to a platform. NOT gated by transferType: Fees, Out of Range Upside
// and idle Undeployed Tokens all qualify (measured live 2026-07-30). The one
// state that disqualifies is Expense — that money has left the business, so
// there is nothing left to place. Module-level so the toolbar buttons and the
// batch previews that count "skipped" rows apply the identical test.
function canPlaceTransfer(t: Transfer): boolean {
  return (
    t.transferType !== "expense" &&
    (t.moneyStatus === "redeployed" || t.moneyStatus === undefined)
  );
}

// Amount is the one field on these records that silently rewrites history: the
// form overwrites `notes` with whatever was typed, so changing a figure without
// touching the note leaves nothing saying it ever changed. When (and only when)
// the amount actually moves, the change is appended to whatever note the user
// kept, never replacing it — so the original wording survives and repeated
// edits read as a trail rather than one value clobbering the last.
// Scoped to amount on purpose; stamping every field would bury the note.
function withAmountEditNote(
  notes: string,
  previous: number,
  next: number,
): string {
  if (previous === next) return notes;
  const stamp = `· amount edited from ${formatUsd(previous)} to ${formatUsd(
    next,
  )} on ${formatDateDDMMYYYY(todayDateInput())}`;
  return notes.trim() === "" ? stamp : `${notes.trim()} ${stamp}`;
}

type ModalState =
  | { kind: "none" }
  | { kind: "add" }
  | { kind: "edit"; transfer: Transfer }
  | { kind: "editExpense"; transfer: Transfer }
  // These three act on the SELECTION, so they carry a list. A single selected
  // row is just a one-element list — there is no separate single-record path.
  | { kind: "deploy"; transfers: Transfer[] }
  | { kind: "platform"; transfers: Transfer[] }
  | { kind: "revert"; transfers: Transfer[] }
  | { kind: "split"; transfers: Transfer[] }
  | { kind: "undoSplit"; transfer: Transfer }
  | { kind: "addWithdrawal" }
  | { kind: "editWithdrawal"; withdrawal: Withdrawal };

type TypeFilter = "all" | TransferType;

interface WithdrawalFormState {
  date: string;
  amount: string;
  method: string;
  notes: string;
}

const EMPTY_WITHDRAWAL_FORM: WithdrawalFormState = {
  date: "",
  amount: "",
  method: "",
  notes: "",
};

function withdrawalToForm(w: Withdrawal): WithdrawalFormState {
  return {
    date: w.date.slice(0, 10),
    amount: String(w.amount),
    method: w.method,
    notes: w.notes,
  };
}

function buildWithdrawal(id: string, form: WithdrawalFormState): Withdrawal {
  return {
    id,
    date: form.date,
    amount: num(form.amount),
    method: form.method.trim().toUpperCase(),
    notes: form.notes.trim(),
  };
}

// Compact transfer row: a select box and the facts that identify the record —
// Pair, Amount, Date(s), Type, Money Status and any settled badge. It does NOT
// expand any more. Everything you can DO to a transfer moved into the toolbar,
// which shows that transfer's actions when it is the only one selected; the
// fields this row used to reveal (Platform, Destination, Token, Notes) live in
// Edit. One selection gesture now does what selecting and expanding used to.
function TransferListRow({
  transfer: t,
  pairLabel,
  deployedLabel,
  datesLabel,
  selected,
  onToggleSelect,
}: {
  transfer: Transfer;
  pairLabel: string;
  deployedLabel: string | null;
  // Replaces the row's single bare date when one date can't tell the whole
  // story — an Out-of-Range-Upside transfer belongs to a position CLOSE, so it
  // shows that position's opened AND closed dates instead.
  datesLabel: string | null;
  selected: boolean;
  onToggleSelect: (id: string) => void;
}) {
  // Settled money is visually locked (dimmed). THREE states count as settled
  // and read identically — "this money has been put to use": a deploy-link
  // (inside a position), a platform (sent out for yield) and an Expense
  // status (left the business). None of them is idle any more.
  const isTransferred = isTransferredToPlatform(t);
  const isDeployed = isDeployedTransfer(t);
  const isSettled = isDeployed || isExpensedTransfer(t) || isTransferred;
  // The money-status pill only earns its place when nothing else on the row
  // already says where the money went. Transferred and Deployed are SUB-STATES
  // of Redeployed, so their own badges ("Sent → AAVE", "Used → PAIR") already
  // carry that information and a second "REDEPLOYED" beside them is noise.
  // Expense and idle keep the pill — it is the only thing that states them.
  return (
    <label
      className={`flex cursor-pointer items-start gap-2 px-3 py-2.5 ${
        selected ? "bg-[var(--accent)]/[0.06]" : ""
      } ${isSettled ? "opacity-60" : ""}`}
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={() => onToggleSelect(t.id)}
        aria-label="Select transfer"
        className="mt-1 h-4 w-4 shrink-0 accent-[var(--accent)]"
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-medium text-[var(--foreground)]">
            {pairLabel}
          </span>
          <span className="shrink-0 text-sm font-medium tabular-nums text-[var(--foreground)]">
            {formatUsd(t.amount)}
          </span>
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--muted)]">
          <span className="tabular-nums">
            {datesLabel ?? formatDateDDMMYYYY(t.date)}
          </span>
          <TypePill type={t.transferType} />
          {/* A split piece looks like an ordinary transfer to every calculation
              and check — this tag is the only thing that says it is one half of
              a row that used to be whole. */}
          {/* The token, not the generic side name: "Split · USDC" says what
              this row actually holds. splitPart stays the internal handle. */}
          {t.splitPart !== undefined && (
            <span className="inline-flex items-center rounded-full border border-violet-500/40 bg-violet-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-violet-300">
              Split · {t.token || t.splitPart}
            </span>
          )}
          {!isTransferred && !isDeployed && (
            <MoneyStatusPill status={t.moneyStatus} />
          )}
          {deployedLabel && (
            <span className="inline-flex items-center rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-emerald-300">
              Used → {deployedLabel}
            </span>
          )}
          {/* The Transferred badge supersedes the Money Status pill for an
              idle Undeployed row, which would otherwise still read "Idle"
              after its money was sent to a platform. */}
          {isTransferred && (
            <span className="inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-amber-300">
              Sent → {t.platform}
            </span>
          )}
        </span>
      </span>
    </label>
  );
}

// The actions the toolbar offers for the current SELECTION. Everything except
// Edit works on one row or many — the same buttons, the same handlers, just a
// longer list — so there is exactly one selection model behind all of them.
//
// Edit stays single-only: it opens one record's form, and there is no coherent
// way to point that at several different records at once.
// Remove deploy link / Remove platform are also single-only. They are undo
// operations on a specific placement rather than batch verbs, and nothing has
// asked for them in bulk; the batch equivalents (re-deploy, re-platform) exist.
function SelectionActions({
  selected,
  pendingDelete,
  onEdit,
  onMarkDeployed,
  onUnlinkDeployed,
  onSendToPlatform,
  onRemovePlatform,
  onRevertToAuto,
  onSplit,
  onUndoSplit,
  onDeleteRequest,
  onDeleteConfirm,
  onDeleteCancel,
}: {
  selected: Transfer[];
  pendingDelete: boolean;
  onEdit: (t: Transfer) => void;
  onMarkDeployed: (list: Transfer[]) => void;
  onUnlinkDeployed: (t: Transfer) => void;
  onSendToPlatform: (list: Transfer[]) => void;
  onRemovePlatform: (t: Transfer) => void;
  onRevertToAuto: (list: Transfer[]) => void;
  onSplit: (list: Transfer[]) => void;
  onUndoSplit: (t: Transfer) => void;
  onDeleteRequest: () => void;
  onDeleteConfirm: () => void;
  onDeleteCancel: () => void;
}) {
  if (selected.length === 0) return null;
  const single = selected.length === 1 ? selected[0] : null;
  const total = selected.reduce((sum, t) => sum + t.amount, 0);
  // Counted here so a button never promises more than it will do: these are the
  // same predicates the confirmation previews use.
  const placeable = selected.filter(canPlaceTransfer).length;
  const revertable = selected.filter(isAutoCreated).length;
  const splittable = selected.filter((t) => t.splitPart === undefined).length;
  const btn =
    "rounded-md border px-2.5 py-1 text-[12px] font-medium transition-colors";
  const neutral = `${btn} border-[var(--border-strong)] bg-[var(--surface-2)] text-[var(--foreground)] hover:border-[var(--accent)]`;
  const green = `${btn} border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20`;
  const amber = `${btn} border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20`;
  const sky = `${btn} border-sky-500/40 bg-sky-500/10 text-sky-300 hover:bg-sky-500/20`;
  const rose = `${btn} border-rose-500/30 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20`;

  if (pendingDelete) {
    return (
      <div className="flex w-full flex-wrap items-center gap-2 border-t border-[var(--border)] pt-2">
        <span className="text-[12px] text-[var(--foreground)]">
          Delete {selected.length}{" "}
          {selected.length === 1 ? "transfer" : "transfers"} ({formatUsd(total)}
          )? You can restore {selected.length === 1 ? "it" : "them"} from
          Recently Deleted.
        </span>
        <button type="button" onClick={onDeleteConfirm} className={rose}>
          Yes, delete {selected.length}
        </button>
        <button type="button" onClick={onDeleteCancel} className={neutral}>
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div className="flex w-full flex-wrap items-center gap-2 border-t border-[var(--border)] pt-2">
      <span className="text-[11px] uppercase tracking-wider text-[var(--muted)]">
        {single ? "This transfer" : `These ${selected.length}`}
      </span>
      {single && (
        <button type="button" onClick={() => onEdit(single)} className={neutral}>
          Edit
        </button>
      )}
      {placeable > 0 && (
        <>
          <button
            type="button"
            onClick={() => onMarkDeployed(selected)}
            className={green}
          >
            Mark as deployed
          </button>
          <button
            type="button"
            onClick={() => onSendToPlatform(selected)}
            className={amber}
          >
            Send to Platform
          </button>
        </>
      )}
      {single && canPlaceTransfer(single) && single.deployedToPositionId && (
        <button
          type="button"
          onClick={() => onUnlinkDeployed(single)}
          className={neutral}
        >
          Remove deploy link
        </button>
      )}
      {single && canPlaceTransfer(single) && isTransferredToPlatform(single) && (
        <button
          type="button"
          onClick={() => onRemovePlatform(single)}
          className={neutral}
        >
          Remove platform
        </button>
      )}
      {revertable > 0 && (
        <button
          type="button"
          onClick={() => onRevertToAuto(selected)}
          className={sky}
        >
          Revert to auto-created
        </button>
      )}
      {/* A piece is never split again (it is already one side), so the button
          only counts rows that are not themselves pieces. In a batch only
          claim-linked rows can actually be split; the modal previews which. */}
      {splittable > 0 && (
        <button
          type="button"
          onClick={() => onSplit(selected)}
          className={neutral}
        >
          {single ? "Split" : `Split ${splittable}`}
        </button>
      )}
      {/* Any split piece, including legacy ones with no splitOriginalId — those
          take the best-effort match inside planUndoSplit. */}
      {single && single.splitPart !== undefined && (
        <button
          type="button"
          onClick={() => onUndoSplit(single)}
          className={neutral}
        >
          Undo Split
        </button>
      )}
      <button type="button" onClick={onDeleteRequest} className={rose}>
        Delete
      </button>
      {/* Why the deploy/platform actions are absent, said out loud — the action
          vanishing silently is what made this look like a per-type bug. */}
      {placeable === 0 && (
        <span className="text-[11px] text-[var(--muted)]">
          {/* Explicit {" "} — the literal space after an expression is trimmed
              at build time, which rendered "aremarked as an Expense". */}
          {single ? "This transfer is" : "All of these are"}{" "}
          marked as an Expense, so the money has left the business and
          can&apos;t be placed. Undo the Expense to make it available again.
        </span>
      )}
    </div>
  );
}

// Recently Deleted: the safety net for the Delete action. Collapsed by default
// and styled like the Show/Hide Closed Positions toggle, so it reads as the
// same "there is more below" affordance. Deleted transfers are kept
// indefinitely — no expiry sweep — because this is financial history; the only
// way a record actually leaves storage is the Permanently delete action here,
// which is separately labelled and needs its own confirm.
function RecentlyDeletedSection({
  rows,
  open,
  onToggle,
  pairLabelFor,
  deployedLabelFor,
  pendingPurge,
  onPurgeRequest,
  onPurgeConfirm,
  onPurgeCancel,
  onRestore,
}: {
  rows: Transfer[];
  open: boolean;
  onToggle: () => void;
  pairLabelFor: (t: Transfer) => string;
  deployedLabelFor: (t: Transfer) => string;
  pendingPurge: string | null;
  onPurgeRequest: (id: string) => void;
  onPurgeConfirm: (id: string) => void;
  onPurgeCancel: () => void;
  onRestore: (id: string) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)]">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between border-b border-[var(--border)] px-5 py-4 text-left transition-colors hover:bg-[var(--surface-2)]/50"
      >
        <span className="text-sm font-semibold tracking-tight">
          {open ? "Hide" : "Show"} Recently Deleted ({rows.length})
        </span>
        <span className="text-xs text-[var(--muted)]" aria-hidden>
          {open ? "▴" : "▾"}
        </span>
      </button>

      {open && (
        <>
          <p className="px-5 pt-4 text-[11px] leading-relaxed text-[var(--muted)]">
            These transfers are hidden from every list, total and balance, but
            nothing has been lost — Restore brings a record back exactly as it
            was. They are kept indefinitely.
          </p>
          <div className="mt-3 divide-y divide-[var(--border)] border-t border-[var(--border)]">
            {rows.map((t) => (
              <div key={t.id} className="px-5 py-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-[var(--foreground)]">
                      {pairLabelFor(t)}
                    </p>
                    <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--muted)]">
                      <span className="tabular-nums">
                        {formatDateDDMMYYYY(t.date)}
                      </span>
                      <TypePill type={t.transferType} />
                      <MoneyStatusPill status={t.moneyStatus} />
                      <span>Deleted {formatDateDDMMYYYY(t.deletedAt ?? "")}</span>
                    </p>
                  </div>
                  <span className="shrink-0 text-sm font-medium tabular-nums text-[var(--foreground)]">
                    {formatUsd(t.amount)}
                  </span>
                </div>
                {/* Everything the record still holds, shown so the user can see
                    nothing was stripped while it sat in here. */}
                <dl className="mt-2 grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-4">
                  <div>
                    <dt className="uppercase tracking-wider text-[var(--muted)]">
                      Platform
                    </dt>
                    <dd className="text-[var(--foreground)]">
                      {t.platform || "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="uppercase tracking-wider text-[var(--muted)]">
                      Destination
                    </dt>
                    <dd className="text-[var(--foreground)]">
                      {t.destination || "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="uppercase tracking-wider text-[var(--muted)]">
                      Token
                    </dt>
                    <dd className="text-[var(--foreground)]">
                      {t.token || "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="uppercase tracking-wider text-[var(--muted)]">
                      Deployed to
                    </dt>
                    <dd className="text-[var(--foreground)]">
                      {deployedLabelFor(t)}
                    </dd>
                  </div>
                </dl>
                {t.notes && (
                  <p className="mt-2 text-[12px] text-[var(--muted)]">
                    {t.notes}
                  </p>
                )}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {pendingPurge === t.id ? (
                    <>
                      <span className="text-xs text-rose-300">
                        Permanently delete this transfer? This cannot be undone.
                      </span>
                      <button
                        type="button"
                        onClick={() => onPurgeConfirm(t.id)}
                        className="rounded-md border border-rose-500/30 bg-rose-500/10 px-2.5 py-1 text-xs font-medium text-rose-300 hover:bg-rose-500/20"
                      >
                        Yes, delete forever
                      </button>
                      <button
                        type="button"
                        onClick={onPurgeCancel}
                        className="rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)] px-2.5 py-1 text-xs font-medium text-[var(--foreground)] hover:bg-[var(--surface-2)]/70"
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => onRestore(t.id)}
                        className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-300 hover:bg-emerald-500/20"
                      >
                        Restore
                      </button>
                      <button
                        type="button"
                        onClick={() => onPurgeRequest(t.id)}
                        className="rounded-md border border-rose-500/30 bg-rose-500/10 px-2.5 py-1 text-xs font-medium text-rose-300 hover:bg-rose-500/20"
                      >
                        Permanently delete
                      </button>
                      <span className="text-[11px] text-[var(--muted)]">
                        Permanent deletion cannot be undone.
                      </span>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// Earned money — close profit AND claimed fees — that has sat idle past
// IDLE_UPSIDE_DAYS. Amber, not red: leaving earnings idle is a choice, not an
// error — the banner just makes sure the choice is a deliberate one. Each row
// names its own type, so a Fees row is never described as upside. Selecting a
// row hands it to the existing toolbar (clearing the filters first, so the row
// is guaranteed visible), which is where Mark as deployed / Send to Platform
// already live. Reports only.
function IdleUpsideBanner({
  rows,
  pairLabelFor,
  onSelect,
}: {
  rows: IdleUpsideRow[];
  pairLabelFor: (t: Transfer) => string;
  onSelect: (t: Transfer) => void;
}) {
  const total = rows.reduce((sum, r) => sum + r.transfer.amount, 0);
  return (
    <div
      id="idle-earnings"
      className="rounded-lg border border-amber-500/40 bg-amber-500/[0.06] px-5 py-4"
    >
      <h2 className="text-sm font-semibold text-amber-300">
        {rows.length}{" "}
        {rows.length === 1 ? "transfer has" : "transfers have"}{" "}
        been sitting idle for over {IDLE_UPSIDE_DAYS} days ({formatUsd(total)})
      </h2>
      <p className="mt-1 text-[11px] leading-relaxed text-[var(--muted)]">
        Claimed fees and profit taken out of a closed position that haven&apos;t
        been deployed, sent to a platform, or spent — still counted in Available
        Balance. Leaving it idle is fine; this is only here so it doesn&apos;t
        get forgotten.
      </p>
      <ul className="mt-3 space-y-2">
        {rows.map((r) => (
          <li
            key={r.transfer.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded border border-[var(--border-strong)] bg-[var(--surface-2)]/40 px-3 py-2 text-[12px]"
          >
            <span className="font-medium text-[var(--foreground)]">
              {pairLabelFor(r.transfer)}
              <span className="ml-2 font-normal text-[var(--muted)]">
                {SHORT_TYPE_LABELS[r.transfer.transferType]}
              </span>
            </span>
            <span className="tabular-nums text-[var(--muted)]">
              {formatUsd(r.transfer.amount)} ·{" "}
              <span className="font-medium text-amber-300">
                {Math.floor(r.daysIdle)} days
              </span>{" "}
              since {formatDateDDMMYYYY(r.transfer.date)}
            </span>
            <button
              type="button"
              onClick={() => onSelect(r.transfer)}
              className="rounded-md border border-amber-500/50 px-2.5 py-1 text-[11px] font-medium text-amber-300 transition-colors hover:bg-amber-500/10"
            >
              Select
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// A transfer whose fee claim has since been edited to a different USD value.
// Amber like the idle check, not red: neither number is wrong on its own — the
// claim records what was earned and the transfer records money that has already
// moved — but they were meant to agree, so the gap should be a decision rather
// than an accident. "Select" hands the row to the toolbar (clearing filters
// first so it is guaranteed visible), where Edit already lives. Reports only.
function ClaimDriftBanner({
  rows,
  pairLabelFor,
  onSelect,
}: {
  rows: DriftedClaimTransferRow[];
  pairLabelFor: (t: Transfer) => string;
  onSelect: (t: Transfer) => void;
}) {
  return (
    <div
      id="claim-drift"
      className="rounded-lg border border-amber-500/40 bg-amber-500/[0.06] px-5 py-4"
    >
      <h2 className="text-sm font-semibold text-amber-300">
        {rows.length} {rows.length === 1 ? "transfer no" : "transfers no"} longer
        matches the fee claim it came from
      </h2>
      <p className="mt-1 text-[11px] leading-relaxed text-[var(--muted)]">
        The claim&apos;s USD value was edited after this money had already been
        sent, deployed or expensed, so the transfer kept its original amount.
        Update the transfer if the new value is the right one — or leave it, if
        what actually moved was the old amount.
      </p>
      <ul className="mt-3 space-y-2">
        {rows.map((r) => (
          <li
            key={r.transfer.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded border border-[var(--border-strong)] bg-[var(--surface-2)]/40 px-3 py-2 text-[12px]"
          >
            <span className="font-medium text-[var(--foreground)]">
              {pairLabelFor(r.transfer)}
              <span className="ml-2 font-normal text-[var(--muted)]">
                {formatDateDDMMYYYY(r.transfer.date)}
              </span>
            </span>
            <span className="tabular-nums text-[var(--muted)]">
              transfer{" "}
              <span className="font-medium text-[var(--foreground)]">
                {formatUsd(r.transfer.amount)}
              </span>{" "}
              · claim now{" "}
              <span className="font-medium text-amber-300">
                {formatUsd(r.claimAmount)}
              </span>
            </span>
            <button
              type="button"
              onClick={() => onSelect(r.transfer)}
              className="rounded-md border border-amber-500/50 px-2.5 py-1 text-[11px] font-medium text-amber-300 transition-colors hover:bg-amber-500/10"
            >
              Select
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// A transfer whose source fee claim was deleted while this money had already
// been sent, deployed or expensed. Amber: nothing is wrong with the record —
// the money moved and the claim is gone, both true — it just no longer has
// anything explaining where it came from, so it is worth a look before that
// context is lost. Opening the editor and saving clears the flag.
function ClaimDeletedBanner({
  rows,
  pairLabelFor,
  onReview,
}: {
  rows: OrphanedByClaimRow[];
  pairLabelFor: (t: Transfer) => string;
  onReview: (t: Transfer) => void;
}) {
  return (
    <div
      id="claim-deleted"
      className="rounded-lg border border-amber-500/40 bg-amber-500/[0.06] px-5 py-4"
    >
      <h2 className="text-sm font-semibold text-amber-300">
        {rows.length}{" "}
        {rows.length === 1
          ? "transfer's fee claim was"
          : "transfers' fee claims were"}{" "}
        deleted
      </h2>
      <p className="mt-1 text-[11px] leading-relaxed text-[var(--muted)]">
        This money had already been sent, deployed or expensed, so the transfer
        was kept — deleting it would erase where the money actually went — but
        it no longer has a claim behind it. Check the amount still looks right,
        then save the transfer to mark it reviewed — replacing its
        &ldquo;auto-created from fee claim&rdquo; note with your own, since that
        note is what identifies a row whose deletion predates this check and is
        shown as (date unknown).
      </p>
      <ul className="mt-3 space-y-2">
        {rows.map((r) => (
          <li
            key={r.transfer.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded border border-[var(--border-strong)] bg-[var(--surface-2)]/40 px-3 py-2 text-[12px]"
          >
            <span className="font-medium text-[var(--foreground)]">
              {pairLabelFor(r.transfer)}
              <span className="ml-2 font-normal text-[var(--muted)]">
                {formatDateDDMMYYYY(r.transfer.date)}
              </span>
            </span>
            <span className="tabular-nums text-[var(--muted)]">
              {formatUsd(r.transfer.amount)} ·{" "}
              {/* An inferred row is just as real, it simply has no recorded
                  date — say that rather than printing a date we do not have. */}
              {r.confirmed && r.deletedAt !== null
                ? `claim deleted ${formatDateDDMMYYYY(r.deletedAt)}`
                : "claim deleted (date unknown)"}
            </span>
            <button
              type="button"
              onClick={() => onReview(r.transfer)}
              className="rounded-md border border-amber-500/50 px-2.5 py-1 text-[11px] font-medium text-amber-300 transition-colors hover:bg-amber-500/10"
            >
              Review
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// A transfer's token must belong to its linked position's pair (same substring
// test as the Position/Claim detectors). Offers a confirmed one-click fix that
// rewrites to the pair-derived symbol, plus per-row Edit. Detection-only until
// the user confirms.
function TransferSymbolBanner({
  rows,
  onEdit,
  onFixAll,
}: {
  rows: TransferSymbolMismatchRow[];
  onEdit: (t: Transfer) => void;
  onFixAll: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const fixable = rows.filter((r) => r.suggestedSymbol !== "").length;
  return (
    <div
      id="transfer-symbol-issues"
      className="rounded-lg border border-red-500/50 bg-red-500/[0.07] px-5 py-4"
    >
      <h2 className="text-sm font-semibold text-red-300">
        {/* The space before "a" must live in an explicit {" "}: a JSX text
            chunk that wraps across a newline loses its leading space, which
            rendered "transfers havea token". A space that sits entirely on one
            line (the one after {rows.length}) survives — that is why only this
            one broke. */}
        {rows.length} {rows.length === 1 ? "transfer has" : "transfers have"}{" "}
        a token that doesn&apos;t match its position&apos;s pair
      </h2>
      <p className="mt-1 text-[11px] leading-relaxed text-[var(--muted)]">
        A transfer&apos;s token should belong to the pair of the position it is
        linked to (e.g. SOL on a SUI/USDC position is wrong). Fixing rewrites it
        to the pair token. Nothing changes until you confirm.
      </p>
      <ul className="mt-3 space-y-2">
        {rows.map((r) => (
          <li
            key={r.transfer.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded border border-[var(--border-strong)] bg-[var(--surface-2)]/40 px-3 py-2 text-[12px]"
          >
            <span className="font-medium text-[var(--foreground)]">
              {formatDateDDMMYYYY(r.transfer.date)} · {r.position.pair}
            </span>
            <span className="tabular-nums text-[var(--muted)]">
              <span className="font-medium text-red-300">{r.token}</span>
              {r.suggestedSymbol && <> → {r.suggestedSymbol}</>}
            </span>
            <button
              type="button"
              onClick={() => onEdit(r.transfer)}
              className="rounded-md border border-red-500/50 px-2.5 py-1 text-[11px] font-medium text-red-300 transition-colors hover:bg-red-500/10"
            >
              Edit
            </button>
          </li>
        ))}
      </ul>
      {fixable > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {confirming ? (
            <>
              <span className="text-[12px] text-red-300">
                Rewrite the token on {fixable}{" "}
                {fixable === 1 ? "transfer" : "transfers"}?
              </span>
              <button
                type="button"
                onClick={() => {
                  onFixAll();
                  setConfirming(false);
                }}
                className="rounded-md bg-red-500/90 px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-red-500"
              >
                Yes, fix {fixable}
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="rounded-md border border-[var(--border-strong)] px-3 py-1.5 text-[12px] font-medium text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)]"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="rounded-md border border-red-500/50 px-3 py-1.5 text-[12px] font-medium text-red-300 transition-colors hover:bg-red-500/10"
            >
              Fix all {fixable} {fixable === 1 ? "transfer" : "transfers"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default function TransfersPage() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [withdrawals, setWithdrawals] = useState<Withdrawal[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [claims, setClaims] = useState<FeeClaim[]>([]);
  const [modal, setModal] = useState<ModalState>({ kind: "none" });
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [search, setSearch] = useState("");
  const [positionFilter, setPositionFilter] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Bulk marking has two scopes: the checkbox selection, and "all N shown"
  // (Part 4) which needs no selection once the list is narrowed to a position.
  const [pendingBulk, setPendingBulk] = useState<{
    status: MoneyStatus;
    scope: "selected" | "visible";
  } | null>(null);
  // Bulk "send all shown to platform" (Part 3): the typed platform plus its
  // own confirm step, kept separate from pendingBulk so the two bulk actions
  // can never fire each other's confirm.
  const [pendingDelete, setPendingDelete] = useState(false);
  // Chain tab for the Expenses & Withdrawals table ("" = all chains).
  const [expenseChainFilter, setExpenseChainFilter] = useState("");
  const [pendingWithdrawalDelete, setPendingWithdrawalDelete] = useState<
    string | null
  >(null);

  const [dismissals, setDismissals] = useState<OutlierDismissal[]>([]);
  // Recently Deleted: soft-deleted transfers, collapsed by default, plus the
  // two-step confirm for the one action that is genuinely irreversible.
  const [deletedTransfers, setDeletedTransfers] = useState<Transfer[]>([]);
  const [showDeleted, setShowDeleted] = useState(false);
  const [pendingPurge, setPendingPurge] = useState<string | null>(null);

  // Yield checkpoints live in the Business P&L settings key and stay there —
  // this page only reads and writes that one field, so nothing migrates.
  const [businessSettings, setBusinessSettings] = useState<BusinessPnLSettings>(
    { prices: {}, checkpoints: [] },
  );
  const [newCheckpoint, setNewCheckpoint] = useState("");

  const refresh = () => {
    setBusinessSettings(getBusinessPnLSettings());
    setSettings(getSettings());
    setTransfers(getTransfers());
    setDeletedTransfers(getDeletedTransfers());
    setWithdrawals(getWithdrawals());
    setPositions(getPositions());
    setClaims(getClaims());
    setDismissals(getOutlierDismissals());
  };

  const hydrated = useHydrated(() => {
    // Retire "Needs Review": persist an explicit moneyStatus on any legacy
    // transfer that never had one (no-op for totals — unset already behaved as
    // redeployed). Runs once; idempotent thereafter.
    migrateTransferMoneyStatus();
    refresh();
  });

  const persistBusinessSettings = (next: BusinessPnLSettings) => {
    setBusinessSettings(next);
    saveBusinessPnLSettings(next);
  };

  const addCheckpoint = () => {
    if (newCheckpoint.trim() === "") return;
    if (businessSettings.checkpoints.includes(newCheckpoint)) return;
    const checkpoints = [...businessSettings.checkpoints, newCheckpoint].sort();
    persistBusinessSettings({ ...businessSettings, checkpoints });
    setNewCheckpoint("");
  };

  const removeCheckpoint = (date: string) => {
    persistBusinessSettings({
      ...businessSettings,
      checkpoints: businessSettings.checkpoints.filter((c) => c !== date),
    });
  };

  // Two independent reads per checkpoint, never combined: what came IN as fee
  // claims (calcYieldAfter, unchanged) and what went OUT (calcExpensesAfter,
  // which shares isExpensedTransfer with the Expenses card).
  const checkpointRows = useMemo(
    () =>
      businessSettings.checkpoints.map((date) => ({
        date,
        earned: calcYieldAfter(claims, date),
        takenOut: calcExpensesAfter(transfers, withdrawals, date),
      })),
    [claims, transfers, withdrawals, businessSettings.checkpoints],
  );

  const positionPairById = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of positions) map.set(p.id, p.pair);
    return map;
  }, [positions]);

  const positionById = useMemo(() => {
    const map = new Map<string, Position>();
    for (const p of positions) map.set(p.id, p);
    return map;
  }, [positions]);

  // An Out-of-Range-Upside transfer is the profit from ONE position close, so a
  // single unlabelled date (the close day) can't say which close it came from —
  // especially on a pair that has been opened and closed more than once. Show
  // the linked position's own opened and closed dates instead. Falls back to
  // the plain transfer date if the position is gone or somehow still open.
  const upsideDatesLabel = (t: Transfer): string | null => {
    if (t.transferType !== "outOfRangeUpside") return null;
    const p = positionById.get(t.sourceCloseId ?? t.positionId);
    if (!p) return null;
    const opened = `Opened ${formatDateDDMMYYYY(p.entryDatetime)}`;
    if (!p.exitDatetime) return opened;
    return `${opened} · Closed ${formatDateDDMMYYYY(p.exitDatetime)}`;
  };

  // Positions that already hold deployed money, for the Mark as Deployed
  // picker. Counted exactly like the Deployed balance card (expense-marked rows
  // are excluded — that money left the business), so the two always agree.
  const deployedByPosition = useMemo(() => {
    const map = new Map<string, { count: number; amount: number }>();
    for (const t of transfers) {
      if (!isDeployedTransfer(t) || !t.deployedToPositionId) continue;
      const entry = map.get(t.deployedToPositionId) ?? { count: 0, amount: 0 };
      entry.count += 1;
      entry.amount += t.amount;
      map.set(t.deployedToPositionId, entry);
    }
    return map;
  }, [transfers]);

  // Settled-state indicators, judged PER TRANSFER TYPE (Fees / Out-of-Range
  // Upside / Undeployed Tokens), never across a position as a whole. The
  // combined rule hid the answer people actually want: a position can have
  // every fee it paid out spent while the profit from its close is still
  // working. They are separate pots of money.
  //
  // Per category the question is asked in two steps:
  //   1. Is any money still IDLE (redeployed, no platform, not deployed)? If
  //      so the category says nothing — there is still something to do with it.
  //   2. Otherwise everything is settled, and the note describes HOW: one
  //      uniform state gets its own label ("Fees fully expensed"), a mix gets a
  //      dollar breakdown ("Fees: $100.00 expensed, $60.00 transferred") so a
  //      part-spent, part-parked category is neither invisible nor mislabelled
  //      as one thing.
  // A type with no transfers is never reported — nothing to be "fully"
  // anything — which falls out of the tally only recording types it has seen.
  //
  // Undeployed Tokens is the rare one: those rows are hand-logged idle capital
  // carrying an UNSET money status by design (d20f3e3), so they only settle if
  // the user deliberately acts on them. Included anyway, because leaving a
  // category out of a per-category rule would be a silent gap.
  const SETTLED_STATES = useMemo(
    () =>
      [
        { key: "expense", verb: "expensed" },
        { key: "transferred", verb: "transferred" },
        { key: "deployed", verb: "deployed" },
      ] as const,
    [],
  );

  const EXPENSED_CATEGORIES: { key: TransferType; label: string }[] = useMemo(
    () => [
      { key: "fees", label: "Fees" },
      { key: "outOfRangeUpside", label: "Upside" },
      { key: "undeployed", label: "Undeployed" },
    ],
    [],
  );

  type SettledKey = "expense" | "transferred" | "deployed";
  type Bucket = {
    idle: number;
    counts: Record<SettledKey, number>;
    amounts: Record<SettledKey, number>;
  };

  // Every transfer lands in exactly one bucket, using the SAME precedence as
  // the balance cards (isExpensedTransfer > isDeployedTransfer >
  // isTransferredToPlatform > idle), so an indicator can never disagree with
  // the money it describes.
  const settledByPosition = useMemo(() => {
    const empty = (): Bucket => ({
      idle: 0,
      counts: { expense: 0, transferred: 0, deployed: 0 },
      amounts: { expense: 0, transferred: 0, deployed: 0 },
    });
    const tally = new Map<string, Map<TransferType, Bucket>>();
    for (const t of transfers) {
      if (!t.positionId) continue;
      let byType = tally.get(t.positionId);
      if (!byType) {
        byType = new Map();
        tally.set(t.positionId, byType);
      }
      const bucket = byType.get(t.transferType) ?? empty();
      const key: SettledKey | null = isExpensedTransfer(t)
        ? "expense"
        : isDeployedTransfer(t)
          ? "deployed"
          : isTransferredToPlatform(t)
            ? "transferred"
            : null;
      if (key === null) bucket.idle += 1;
      else {
        bucket.counts[key] += 1;
        bucket.amounts[key] += t.amount;
      }
      byType.set(t.transferType, bucket);
    }
    return tally;
  }, [transfers]);

  // "Fees & Upside fully expensed" rather than one note per category: uniform
  // categories in the SAME state share a sentence. Categories in different
  // states, and mixed ones, get their own note — merging those would produce a
  // sentence that is wrong for at least one of them.
  const joinCategories = (labels: string[]): string =>
    labels.length <= 1
      ? labels.join("")
      : `${labels.slice(0, -1).join(", ")} & ${labels[labels.length - 1]}`;

  // Both kinds of note can apply at once and both are shown. They describe
  // unrelated things: the settled notes look at the transfers BELONGING to the
  // position, while "already has $X deployed" looks at transfers POINTING AT it
  // as a deploy target — which usually come from other positions entirely.
  // COLOUR RULE: red means the money is simply GONE, green means it is settled
  // but still working somewhere. A single-state label takes one colour —
  // "fully expensed" red, "fully transferred"/"fully deployed" green. A MIXED
  // breakdown is coloured PER SEGMENT on one line, so "$100.00 expensed" reads
  // red right beside "$60.00 transferred" in green: colouring the whole line
  // one way would have to lie about half of it. Muted stays for the unrelated
  // "already has $X deployed" hint.
  const toneOf = (state: SettledKey): NoteTone =>
    state === "expense" ? "danger" : "success";
  const positionNotes = (p: Position): PositionNote[] => {
    const notes: PositionNote[] = [];
    const byType = settledByPosition.get(p.id);
    if (byType) {
      const uniform = new Map<SettledKey, string[]>();
      for (const { key, label } of EXPENSED_CATEGORIES) {
        const b = byType.get(key);
        if (!b || b.idle > 0) continue;
        const present = SETTLED_STATES.filter((s) => b.counts[s.key] > 0);
        if (present.length === 0) continue;
        if (present.length === 1) {
          const state = present[0].key;
          uniform.set(state, [...(uniform.get(state) ?? []), label]);
          continue;
        }
        // Separators carry the muted tone so only the figures themselves are
        // coloured; spacing lives in the strings, never in JSX.
        const segments: PositionNote = [{ text: `${label}: `, tone: "muted" }];
        present.forEach((s, i) => {
          if (i > 0) segments.push({ text: ", ", tone: "muted" });
          segments.push({
            text: `${formatUsd(b.amounts[s.key])} ${s.verb}`,
            tone: toneOf(s.key),
          });
        });
        notes.push(segments);
      }
      for (const { key, verb } of SETTLED_STATES) {
        const labels = uniform.get(key);
        if (!labels) continue;
        notes.push([
          { text: `${joinCategories(labels)} fully ${verb}`, tone: toneOf(key) },
        ]);
      }
    }
    const already = deployedByPosition.get(p.id);
    if (already) {
      notes.push([
        {
          text: `already has ${formatUsd(already.amount)} deployed`,
          tone: "muted",
        },
      ]);
    }
    return notes;
  };

  // One place decides what a deploy-link is called, so the row badge and the
  // Recently Deleted entry can never word it differently. The unknown sentinel
  // has no pair to look up and says so rather than implying a position.
  const deployedLabelOf = (t: Transfer): string | null => {
    if (!t.deployedToPositionId) return null;
    if (t.deployedToPositionId === UNKNOWN_POSITION_ID) return "Unknown position";
    return positionPairById.get(t.deployedToPositionId) ?? "position";
  };

  // Data Health: a transfer's token must belong to its linked position's pair,
  // and its amount should sit within that position's usual range.
  const transferMismatches = useMemo(
    () => (hydrated ? findTransferSymbolMismatches(transfers, positions) : []),
    [hydrated, transfers, positions],
  );
  const transferOutliers = useMemo(
    () =>
      hydrated
        ? findTransferAmountOutliers(transfers, positions, dismissals)
        : [],
    [hydrated, transfers, positions, dismissals],
  );

  // Upside profit that has sat untouched. Reads the same idle test the balance
  // cards use; changes nothing.
  const idleUpside = useMemo(
    () => (hydrated ? findIdleUpsideTransfers(transfers, positions) : []),
    [hydrated, transfers, positions],
  );

  const claimDrift = useMemo(
    () => (hydrated ? findDriftedClaimTransfers(transfers, claims) : []),
    [hydrated, transfers, claims],
  );

  const orphanedByClaim = useMemo(
    () => (hydrated ? findOrphanedByClaimDeletion(transfers) : []),
    [hydrated, transfers],
  );

  const sortedFiltered = useMemo(() => {
    if (!hydrated) return [];
    const filtered = transfers.filter(
      (t) =>
        (typeFilter === "all" ? true : t.transferType === typeFilter) &&
        (positionFilter === "" ? true : t.positionId === positionFilter),
    );
    return [...filtered].sort((a, b) => {
      const ta = new Date(a.date).getTime();
      const tb = new Date(b.date).getTime();
      return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
    });
  }, [hydrated, transfers, typeFilter, positionFilter]);

  // Free-text search over pair, notes, transfer type, token, destination,
  // platform — layered on top of the type/review filters (Part 5).
  const searchedFiltered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (q === "") return sortedFiltered;
    return sortedFiltered.filter((t) => {
      const pair = positionPairById.get(t.positionId) ?? "";
      const haystack = [
        pair,
        t.notes,
        TYPE_LABELS[t.transferType],
        t.token,
        t.destination,
        t.platform,
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [sortedFiltered, search, positionPairById]);

  const totals = useMemo(() => {
    let amount = 0;
    const breakdown: Record<TransferType, number> = {
      fees: 0,
      undeployed: 0,
      outOfRangeUpside: 0,
      expense: 0,
    };
    for (const t of transfers) {
      amount += t.amount;
      // Fees / Undeployed / Out-of-Range-Upside are TYPES and keep counting by
      // transferType. Expense is not a type — it is a money STATUS that any of
      // those three can carry. Counting it by transferType only ever matched
      // the retired position-less expense record (the Log-an-Expense-as-a-
      // transfer flow removed in d20f3e3), so the tile sat at 0 forever while
      // real expensed transfers were being counted under their own type.
      if (t.transferType !== "expense") breakdown[t.transferType] += 1;
      if (isExpensedTransfer(t)) breakdown.expense += 1;
    }
    // NOTE the four numbers deliberately no longer sum to the total: a fees
    // transfer marked as an Expense is counted in BOTH Fees and Expense,
    // because it genuinely is both. The tile answers "how many of each", not
    // "how does the total split".
    return { count: transfers.length, amount, breakdown };
  }, [transfers]);

  // Per-token NET TOTAL (Σ amount moved out of that token), mirroring the
  // sheet's per-token blocks. Sorted by amount so the biggest movers lead.
  const byToken = useMemo(() => {
    const map = new Map<string, { token: string; count: number; amount: number }>();
    for (const t of transfers) {
      const token = t.token ? normalizeToken(t.token) : "—";
      const row = map.get(token) ?? { token, count: 0, amount: 0 };
      row.count += 1;
      row.amount += t.amount;
      map.set(token, row);
    }
    return [...map.values()].sort((a, b) => b.amount - a.amount);
  }, [transfers]);

  // Per-destination breakdown (where the money went — RAKA, AAVE, …).
  // Transfers with no destination yet are grouped under "Unspecified".
  const byDestination = useMemo(() => {
    const map = new Map<
      string,
      { destination: string; count: number; amount: number }
    >();
    for (const t of transfers) {
      const destination = t.destination || "Unspecified";
      const row = map.get(destination) ?? { destination, count: 0, amount: 0 };
      row.count += 1;
      row.amount += t.amount;
      map.set(destination, row);
    }
    return [...map.values()].sort((a, b) => b.amount - a.amount);
  }, [transfers]);

  // Chain of a transfer = its linked position's chain (transfers store no chain
  // of their own). Expenses and any unlinked rows fall under "Unlinked". Sorted
  // by total moved so the busiest chains lead — mirrors Business P&L's blocks.
  const positionChainById = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of positions) map.set(p.id, normalizeChain(p.chain) || "OTHER");
    return map;
  }, [positions]);

  const byChain = useMemo(() => {
    const map = new Map<string, Transfer[]>();
    for (const t of searchedFiltered) {
      const chain = positionChainById.get(t.positionId) ?? "UNLINKED";
      const list = map.get(chain);
      if (list) list.push(t);
      else map.set(chain, [t]);
    }
    const amountOf = (list: Transfer[]) =>
      list.reduce((sum, t) => sum + t.amount, 0);
    return [...map.entries()]
      .map(([chain, list]) => ({ chain, list, amount: amountOf(list) }))
      .sort((a, b) => b.amount - a.amount);
  }, [searchedFiltered, positionChainById]);

  // Bulk-select over the currently-visible (searched + filtered) rows. Selecting
  // ids that scroll out of view is avoided by intersecting with visibleIds on
  // every action, so a bulk mark only ever touches rows the user can see.
  const visibleIds = useMemo(
    () => searchedFiltered.map((t) => t.id),
    [searchedFiltered],
  );
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));

  // The transfers the toolbar's actions operate on. Deliberately derived from
  // the VISIBLE selection: a stale id left selected behind a filter change must
  // never end up in a batch the user cannot see.
  const selectedTransfers = useMemo(
    () => searchedFiltered.filter((t) => selectedIds.has(t.id)),
    [searchedFiltered, selectedIds],
  );

  // Platforms already used anywhere, offered as autocomplete so the same
  // destination doesn't end up spelled three ways.
  const knownPlatforms = useMemo(
    () =>
      [
        ...new Set(
          transfers.map((t) => (t.platform ?? "").trim()).filter((p) => p !== ""),
        ),
      ].sort(),
    [transfers],
  );

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAllVisible = () => {
    setSelectedIds((prev) => {
      if (visibleIds.every((id) => prev.has(id))) return new Set();
      return new Set(visibleIds);
    });
  };

  const clearSelection = () => {
    setSelectedIds(new Set());
    setPendingBulk(null);
    setPendingDelete(false);
  };

  // The only new way data changes here (Part 4): set moneyStatus on every
  // selected+visible transfer at once, behind an explicit confirm. transferType
  // is untouched — Overall P&L counts expenses by moneyStatus alone.
  const applyBulkMark = (status: MoneyStatus, scope: "selected" | "visible") => {
    const targetIds = new Set(
      scope === "visible"
        ? visibleIds
        : visibleIds.filter((id) => selectedIds.has(id)),
    );
    if (targetIds.size === 0) return;
    saveTransfers(
      getTransfers().map((t) =>
        targetIds.has(t.id) ? { ...t, moneyStatus: status } : t,
      ),
    );
    clearSelection();
    refresh();
  };

  const handleConfirmOutlier = (row: OutlierRow) => {
    saveOutlierDismissals([...getOutlierDismissals(), dismissalFor(row)]);
    setDismissals(getOutlierDismissals());
  };

  const handleEditExpense = (target: Transfer, form: ExpenseFormState) => {
    const updated = buildExpense(target.id, form);
    saveTransfers(
      getTransfers().map((t) => (t.id === target.id ? updated : t)),
    );
    refresh();
    setModal({ kind: "none" });
  };

  // Two new rows in, original soft-deleted — all inside applyTransferSplit, so
  // the write order (save the pieces, THEN soft-delete) lives in one place.
  const handleSplit = (target: Transfer, plan: TransferSplitPlan) => {
    applyTransferSplit(target, plan);
    clearSelection();
    refresh();
    setModal({ kind: "none" });
  };

  const handleBulkSplit = (plan: BulkSplitPlan) => {
    applyBulkSplit(plan);
    clearSelection();
    refresh();
    setModal({ kind: "none" });
  };

  const handleUndoSplit = (plan: UndoSplitPlan) => {
    applyUndoSplit(plan);
    clearSelection();
    refresh();
    setModal({ kind: "none" });
  };

  const handleAdd = (form: TransferFormState) => {
    saveTransfers([...getTransfers(), buildTransfer(newId(), form)]);
    refresh();
    setModal({ kind: "none" });
  };

  const handleEdit = (target: Transfer, form: TransferFormState) => {
    // buildTransfer only knows the form's fields, so the record's out-of-form
    // links have to be carried across by hand: the automation idempotency ids
    // and the deploy-link. Without this, editing a deployed transfer (e.g. to
    // mark it as an Expense — Part 6) silently dropped its deploy-link and its
    // sourceClaimId, which would let a backfill re-create the same transfer.
    const updated: Transfer = {
      ...buildTransfer(target.id, form),
      ...(target.sourceClaimId !== undefined
        ? { sourceClaimId: target.sourceClaimId }
        : {}),
      ...(target.sourceCloseId !== undefined
        ? { sourceCloseId: target.sourceCloseId }
        : {}),
      ...(target.deployedToPositionId !== undefined
        ? {
            deployedToPositionId: target.deployedToPositionId,
            deployedAt: target.deployedAt,
          }
        : {}),
      // The split tags ARE carried across: they describe what the record IS,
      // not something to review, so editing a piece must not quietly turn it
      // back into an ordinary transfer.
      ...(target.splitFromClaimId !== undefined
        ? { splitFromClaimId: target.splitFromClaimId }
        : {}),
      ...(target.splitPart !== undefined
        ? { splitPart: target.splitPart }
        : {}),
      // claimDeletedAt is deliberately NOT carried across: saving the transfer
      // IS how the "source claim was deleted" flag is resolved, so rebuilding
      // without it clears the Data Health row. It is the one out-of-form field
      // that should not survive an edit.
    };
    updated.notes = withAmountEditNote(
      updated.notes,
      target.amount,
      updated.amount,
    );
    saveTransfers(
      getTransfers().map((t) => (t.id === target.id ? updated : t)),
    );
    refresh();
    setModal({ kind: "none" });
  };

  // Deleting is now reversible: the record keeps every field and simply drops
  // out of the live list (and therefore out of every total and balance) until
  // it is restored or explicitly purged.
  const handleDelete = (ids: string[]) => {
    for (const id of ids) softDeleteTransfer(id);
    clearSelection();
    refresh();
    setPendingDelete(false);
  };

  // Delete from inside an Edit modal: the same soft delete, then close the
  // modal (the record it was editing is no longer in the live list).
  const handleDeleteFromModal = (id: string) => {
    softDeleteTransfer(id);
    refresh();
    setModal({ kind: "none" });
  };

  const handleRestore = (id: string) => {
    restoreTransfer(id);
    refresh();
  };

  // The only irreversible action on this page. Gated by its own confirm.
  const handlePurge = (id: string) => {
    purgeTransfer(id);
    refresh();
    setPendingPurge(null);
  };

  // Link a Redeployed transfer to the position its money went into. The row
  // stays in the list but drops out of Available Balance. Records the date so
  // the link is auditable. Never touches the position itself.
  // Applies to every ELIGIBLE transfer in the batch; expensed rows are skipped
  // here exactly as the preview said they would be, so what the confirmation
  // promised and what is written can never drift apart.
  const handleMarkDeployed = (targets: Transfer[], positionId: string) => {
    const ids = new Set(targets.filter(canPlaceTransfer).map((t) => t.id));
    if (ids.size === 0) return;
    saveTransfers(
      getTransfers().map((t) =>
        ids.has(t.id)
          ? {
              ...t,
              deployedToPositionId: positionId,
              deployedAt: todayDateInput(),
            }
          : t,
      ),
    );
    refresh();
    setModal({ kind: "none" });
  };

  // Undo the link — clears both fields, returning the amount to Available.
  const handleUnlinkDeployed = (target: Transfer) => {
    saveTransfers(
      getTransfers().map((t) => {
        if (t.id !== target.id) return t;
        const { deployedToPositionId: _p, deployedAt: _a, ...rest } = t;
        void _p;
        void _a;
        return rest;
      }),
    );
    refresh();
  };

  // Send money to a platform (Part 2): assigning a Platform is what puts a
  // transfer in the Transferred state, so this writes that one field and
  // nothing else — transferType, moneyStatus and any deploy-link stay put.
  const handleSendToPlatform = (targets: Transfer[], platform: string) => {
    const value = platform.trim().toUpperCase();
    if (value === "") return;
    const ids = new Set(targets.filter(canPlaceTransfer).map((t) => t.id));
    if (ids.size === 0) return;
    saveTransfers(
      getTransfers().map((t) => (ids.has(t.id) ? { ...t, platform: value } : t)),
    );
    refresh();
    setModal({ kind: "none" });
  };

  // Undo — clearing the platform returns the amount to Available Balance.
  const handleRemovePlatform = (target: Transfer) => {
    saveTransfers(
      getTransfers().map((t) =>
        t.id === target.id ? { ...t, platform: "" } : t,
      ),
    );
    refresh();
  };

  // Explicit, user-confirmed bulk correction of mismatched transfer tokens.
  // Only rewrites rows with a determinable suggestion; others stay for manual
  // Edit. Detection-only elsewhere — this runs solely on the confirm click.
  const handleFixAllTransferSymbols = (rows: TransferSymbolMismatchRow[]) => {
    const fixes = new Map(
      rows
        .filter((r) => r.suggestedSymbol !== "")
        .map((r) => [r.transfer.id, correctTransferSymbol(r)]),
    );
    if (fixes.size === 0) return;
    saveTransfers(getTransfers().map((t) => fixes.get(t.id) ?? t));
    refresh();
  };

  // Balance ledger (Money Flow invariant): Lifetime Earned = Σ transfers
  // (every fee moved to a destination), Withdrawn = Σ withdrawals taken out
  // for personal use, Available Balance = the difference. Withdrawals never
  // reduce Lifetime Earned — only what's still available.
  const balance = useMemo(() => {
    const lifetimeEarned = transfers.reduce((sum, t) => sum + t.amount, 0);
    const withdrawalTotal = withdrawals.reduce((sum, w) => sum + w.amount, 0);
    // A transfer marked "expense" is money that has left the business, so it
    // must leave Available Balance exactly like a logged withdrawal does. Until
    // now nothing read moneyStatus here, so marking a transfer as an Expense
    // changed a pill and nothing else — the balance still counted the money as
    // idle. Fixed 2026-07-30 (applies to every transfer type equally).
    const expensed = transfers.reduce(
      (sum, t) => (isExpensedTransfer(t) ? sum + t.amount : sum),
      0,
    );
    // Money linked to a position ("Mark as deployed") is no longer idle — it
    // now lives inside that position's Deposited (entered separately), so it is
    // excluded from Available. Undoing the link adds it straight back. The
    // expense guard keeps the two subtractions mutually exclusive, so a row
    // that is somehow both can never be deducted twice.
    const deployed = transfers.reduce(
      (sum, t) => (isDeployedTransfer(t) ? sum + t.amount : sum),
      0,
    );
    // Money sent to a platform for yield (AAVE …) is no longer idle either: it
    // is working somewhere else. Excluded from Available from this release on
    // — a deliberate, user-confirmed change (Redeployed money WITH a platform
    // used to stay counted as available). isTransferredToPlatform re-tests the
    // expense and deploy states, so the three subtractions below can never
    // overlap: a transfer that is deployed AND platformed counts once, as
    // Deployed; one later marked Expense counts once, as an Expense.
    // Split by transfer type as well as totalled, so the card can say WHERE
    // the platform money came from. Same predicate for both, so the parts
    // always add up to the total by construction.
    const transferredByType: Record<TransferType, number> = {
      fees: 0,
      undeployed: 0,
      outOfRangeUpside: 0,
      expense: 0,
    };
    const transferredToPlatform = transfers.reduce((sum, t) => {
      if (!isTransferredToPlatform(t)) return sum;
      transferredByType[t.transferType] += t.amount;
      return sum + t.amount;
    }, 0);
    const withdrawn = withdrawalTotal + expensed;
    return {
      lifetimeEarned,
      withdrawalTotal,
      expensed,
      withdrawn,
      deployed,
      transferredToPlatform,
      transferredByType,
      available:
        lifetimeEarned - withdrawn - deployed - transferredToPlatform,
    };
  }, [transfers, withdrawals]);

  // "Expenses & Withdrawals" is the ledger of money out of the business, so it
  // lists BOTH logged withdrawals and any transfer marked as an Expense — the
  // two things the Expenses card now adds together. Transfer-backed
  // rows are shown for visibility and edited/deleted from the transfer list
  // above (single source of truth for a transfer), so they carry no Delete here.
  const expenseLedger = useMemo(() => {
    const rows: {
      key: string;
      date: string;
      amount: number;
      method: string;
      notes: string;
      // Same chain vocabulary as the main list: transfers resolve through
      // positionChainById (already normalizeChain'd), and anything without a
      // position — every logged withdrawal, by definition — is UNLINKED, the
      // label the list above already uses for chain-less rows.
      chain: string;
      withdrawal?: Withdrawal;
      transfer?: Transfer;
    }[] = withdrawals.map((w) => ({
      key: `w-${w.id}`,
      date: w.date,
      amount: w.amount,
      method: w.method || "—",
      notes: w.notes,
      chain: "UNLINKED",
      withdrawal: w,
    }));
    for (const t of transfers) {
      if (t.moneyStatus !== "expense") continue;
      rows.push({
        key: `t-${t.id}`,
        date: t.date,
        amount: t.amount,
        method:
          t.transferType === "expense"
            ? "Expense"
            : positionPairById.get(t.positionId) ?? "Transfer",
        notes: t.notes,
        chain: positionChainById.get(t.positionId) ?? "UNLINKED",
        transfer: t,
      });
    }
    return rows.sort((a, b) => {
      const ta = new Date(a.date).getTime();
      const tb = new Date(b.date).getTime();
      return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
    });
  }, [withdrawals, transfers, positionPairById, positionChainById]);

  // Only chains actually present get a tab, ordered by amount like the main
  // list's chain sections, so the two read consistently.
  const expenseChains = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of expenseLedger) {
      map.set(r.chain, (map.get(r.chain) ?? 0) + r.amount);
    }
    return [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([chain]) => chain);
  }, [expenseLedger]);

  const ledgerRows = useMemo(
    () =>
      expenseChainFilter === ""
        ? expenseLedger
        : expenseLedger.filter((r) => r.chain === expenseChainFilter),
    [expenseLedger, expenseChainFilter],
  );
  // The footer follows what is on screen. Unfiltered it is balance.withdrawn
  // exactly (same rows, same amounts); filtered it is that chain's share, which
  // is why the label says so rather than silently showing a different total
  // under the same words.
  const ledgerTotal = useMemo(
    () => ledgerRows.reduce((sum, r) => sum + r.amount, 0),
    [ledgerRows],
  );

  const handleAddWithdrawal = (form: WithdrawalFormState) => {
    saveWithdrawals([...getWithdrawals(), buildWithdrawal(newId(), form)]);
    refresh();
    setModal({ kind: "none" });
  };

  const handleEditWithdrawal = (
    target: Withdrawal,
    form: WithdrawalFormState,
  ) => {
    const updated = buildWithdrawal(target.id, form);
    updated.notes = withAmountEditNote(
      updated.notes,
      target.amount,
      updated.amount,
    );
    saveWithdrawals(
      getWithdrawals().map((w) => (w.id === target.id ? updated : w)),
    );
    refresh();
    setModal({ kind: "none" });
  };

  const handleDeleteWithdrawal = (id: string) => {
    saveWithdrawals(getWithdrawals().filter((w) => w.id !== id));
    refresh();
    setPendingWithdrawalDelete(null);
  };

  const transfersEnabled = !hydrated ? true : settings?.transfersEnabled !== false;

  return (
    <section className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Transfers</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Track where you send your claimed fees.
        </p>
      </header>

      {hydrated && !transfersEnabled ? (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-6 py-12 text-center">
          <p className="text-sm text-[var(--muted)]">
            Transfers are disabled. Enable them in Settings to start tracking
            where you send your fees.
          </p>
          <Link
            href="/clp-tracker/settings"
            className="mt-5 inline-flex h-9 items-center justify-center rounded-md bg-[var(--accent-solid)] px-4 text-sm font-medium text-white shadow-sm transition-colors hover:bg-[var(--accent-solid)]/90"
          >
            Go to Settings
          </Link>
        </div>
      ) : (
        <>
          {transferMismatches.length > 0 && (
            <TransferSymbolBanner
              rows={transferMismatches}
              onEdit={(transfer) => setModal({ kind: "edit", transfer })}
              onFixAll={() => handleFixAllTransferSymbols(transferMismatches)}
            />
          )}
          <OutlierBanner
            id="transfer-outliers"
            rows={transferOutliers}
            noun="transfer"
            onEdit={(row) =>
              row.transfer &&
              setModal(
                row.transfer.transferType === "expense"
                  ? { kind: "editExpense", transfer: row.transfer }
                  : { kind: "edit", transfer: row.transfer },
              )
            }
            onConfirm={handleConfirmOutlier}
          />
          {idleUpside.length > 0 && (
            <IdleUpsideBanner
              rows={idleUpside}
              pairLabelFor={(t) => positionPairById.get(t.positionId) ?? "—"}
              onSelect={(t) => {
                setSelectedIds(new Set([t.id]));
                setPositionFilter("");
                setTypeFilter("all");
                setSearch("");
              }}
            />
          )}

          {claimDrift.length > 0 && (
            <ClaimDriftBanner
              rows={claimDrift}
              pairLabelFor={(t) => positionPairById.get(t.positionId) ?? "—"}
              // Straight into the editor — the same modal the table's Edit
              // button opens. Correcting the amount IS the resolution for this
              // flag, so routing through select-then-find-the-row was a step
              // with no decision in it.
              onSelect={(t) => setModal({ kind: "edit", transfer: t })}
            />
          )}

          {orphanedByClaim.length > 0 && (
            <ClaimDeletedBanner
              rows={orphanedByClaim}
              pairLabelFor={(t) => positionPairById.get(t.positionId) ?? "—"}
              onReview={(t) => setModal({ kind: "edit", transfer: t })}
            />
          )}

          <div className="flex justify-end gap-2">
            {/* Expense and Withdrawal were the same concept to the user, so
                they are one action now. It records a Withdrawal (reduces
                Available Balance) — the formula is unchanged. */}
            <button
              type="button"
              onClick={() => setModal({ kind: "addWithdrawal" })}
              className="inline-flex h-9 items-center justify-center rounded-md border border-rose-500/40 bg-rose-500/10 px-4 text-sm font-medium text-rose-300 transition-colors hover:bg-rose-500/20"
            >
              Log an Expense
            </button>
            <button
              type="button"
              onClick={() => setModal({ kind: "add" })}
              className="inline-flex h-9 items-center justify-center rounded-md bg-[var(--accent-solid)] px-4 text-sm font-medium text-white shadow-sm transition-colors hover:bg-[var(--accent-solid)]/90"
            >
              Add Transfer
            </button>
          </div>

          <BackfillReview
            claims={claims}
            positions={positions}
            transfers={transfers}
            onDone={refresh}
          />


          {/* Money Flow ledger: earned − withdrawn − deployed − transferred
              = available now. The three subtracted buckets are mutually
              exclusive (see the state predicates at the top of this file). */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <SummaryStat
              label="Lifetime Earned (USD)"
              value={formatUsd(balance.lifetimeEarned)}
              hint="Everything ever moved to a destination — never decreases."
            />
            <SummaryStat
              label="Expenses (USD)"
              value={formatUsd(balance.withdrawn)}
              hint="Money out of the business: logged expenses plus any transfer marked as an Expense. Reduces Available Balance."
            />
            <SummaryStat
              label="Deployed into Positions (USD)"
              value={formatUsd(balance.deployed)}
              hint="Redeployed money you've linked to a position — now inside its Deposited, no longer idle."
            />
            <SummaryStat
              label="Transferred to Platforms (USD)"
              value={formatUsd(balance.transferredToPlatform)}
              hint="Money sent somewhere for yield (a transfer with a Platform assigned, e.g. AAVE) — working elsewhere, so no longer idle."
              // Where that money came from. Built by the same predicate as the
              // total above, so the parts always add up to it.
              parts={[
                { label: "Fees", value: balance.transferredByType.fees },
                {
                  label: "OOR Upside",
                  value: balance.transferredByType.outOfRangeUpside,
                },
                {
                  label: "Undeployed",
                  value: balance.transferredByType.undeployed,
                },
              ]}
            />
            <SummaryStat
              label="Available Balance (USD)"
              value={formatUsd(balance.available)}
              hint="Lifetime Earned − Expenses − Deployed − Transferred = what's still idle."
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <SummaryStat label="Total Transfers" value={String(totals.count)} />
            <SummaryStat
              label="Transfers Net Total (USD)"
              value={formatUsd(totals.amount)}
            />
            <BreakdownStat breakdown={totals.breakdown} />
          </div>

          {byToken.length > 0 && (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <GroupTable
                title="By Token"
                subtitle="Net total moved out per token."
                columnLabel="Token"
                rows={byToken.map((r) => ({
                  key: r.token,
                  label: r.token,
                  count: r.count,
                  amount: r.amount,
                }))}
                total={totals.amount}
              />
              <GroupTable
                title="By Destination"
                subtitle="Where the money went."
                columnLabel="Destination"
                rows={byDestination.map((r) => ({
                  key: r.destination,
                  label: r.destination,
                  count: r.count,
                  amount: r.amount,
                }))}
                total={totals.amount}
              />
            </div>
          )}

          <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)]">
            <div className="flex flex-col gap-3 border-b border-[var(--border)] px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
              <h2 className="text-sm font-semibold tracking-tight">
                Transfers by Chain
              </h2>
              <TypeFilterToggle value={typeFilter} onChange={setTypeFilter} />
            </div>

            <div className="grid grid-cols-1 gap-3 border-b border-[var(--border)] px-5 py-3 sm:grid-cols-2">
              {/* Narrowing to one position is what unlocks "Mark all N shown"
                  below — the same searchable picker Fee Claims uses. */}
              <PositionCombobox
                positions={positions}
                value={positionFilter}
                onChange={(next) => {
                  setPositionFilter(next);
                  clearSelection();
                }}
                allValue=""
                noteFor={positionNotes}
              />
              <div>
                <label className="block text-xs font-medium text-[var(--muted)]">
                  Search
                </label>
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by pair, notes, type, destination…"
                  className="mt-1 block h-9 w-full rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)] px-3 text-sm text-[var(--foreground)] placeholder:text-[var(--muted)]/60 focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
                />
              </div>
            </div>

            {searchedFiltered.length === 0 ? (
              transfers.length === 0 ? (
                <div className="px-6 py-14 text-center">
                  <EmptyIcon />
                  <h3 className="mt-3 text-base font-semibold tracking-tight text-[var(--foreground)]">
                    No transfers recorded
                  </h3>
                  <p className="mx-auto mt-1.5 max-w-sm text-sm text-[var(--muted)]">
                    After claiming fees, record where you sent them.
                  </p>
                  <button
                    type="button"
                    onClick={() => setModal({ kind: "add" })}
                    className="mt-4 inline-flex h-9 items-center justify-center rounded-md bg-[var(--accent-solid)] px-4 text-sm font-medium text-white shadow-sm transition-colors hover:bg-[var(--accent-solid)]/90"
                  >
                    Add Transfer
                  </button>
                </div>
              ) : (
                <div className="px-5 py-10 text-center text-sm text-[var(--muted)]">
                  No transfers match the current filter.
                </div>
              )
            ) : (
              <>
                {/* Bulk-select toolbar (Part 4). */}
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-[var(--border)] bg-[var(--surface-2)]/30 px-5 py-2.5">
                  <datalist id="known-platforms">
                    {knownPlatforms.map((p) => (
                      <option key={p} value={p} />
                    ))}
                  </datalist>
                  <label className="flex items-center gap-2 text-[12px] text-[var(--muted)]">
                    <input
                      type="checkbox"
                      checked={allVisibleSelected}
                      onChange={toggleSelectAllVisible}
                      className="h-4 w-4 accent-[var(--accent)]"
                    />
                    Select all visible ({visibleIds.length})
                  </label>
                  {/* Position-scoped bulk action (Part 4): once the list is
                      narrowed to one position, mark every shown transfer in one
                      go — no per-row selection needed. Still applies only to
                      rows the user can actually see. */}
                  {positionFilter !== "" && selectedIds.size === 0 && (
                    <div className="flex flex-wrap items-center gap-2">
                      {pendingBulk?.scope === "visible" ? (
                        <>
                          <span className="text-[12px] text-[var(--foreground)]">
                            {pendingBulk.status === "expense"
                              ? `Mark all ${visibleIds.length} shown as Expense?`
                              : `Undo Expense on all ${visibleIds.length} shown?`}
                          </span>
                          <button
                            type="button"
                            onClick={() =>
                              applyBulkMark(pendingBulk.status, "visible")
                            }
                            className="rounded-md bg-[var(--accent-solid)] px-2.5 py-1 text-[12px] font-medium text-white hover:bg-[var(--accent-solid)]/90"
                          >
                            Confirm
                          </button>
                          <button
                            type="button"
                            onClick={() => setPendingBulk(null)}
                            className="rounded-md border border-[var(--border-strong)] px-2.5 py-1 text-[12px] font-medium text-[var(--muted)] hover:bg-[var(--surface-2)]"
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() =>
                              setPendingBulk({
                                status: "redeployed",
                                scope: "visible",
                              })
                            }
                            className="rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)] px-2.5 py-1 text-[12px] font-medium text-[var(--foreground)] hover:border-[var(--accent)]"
                          >
                            Undo Expense on all {visibleIds.length} shown
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setPendingBulk({
                                status: "expense",
                                scope: "visible",
                              })
                            }
                            className="rounded-md border border-rose-500/40 bg-rose-500/10 px-2.5 py-1 text-[12px] font-medium text-rose-300 hover:bg-rose-500/20"
                          >
                            Mark all {visibleIds.length} shown as Expense
                          </button>
                        </>
                      )}
                    </div>
                  )}
                  {selectedIds.size > 0 && (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[12px] font-medium text-[var(--foreground)]">
                        {selectedIds.size} selected
                      </span>
                      {pendingBulk?.scope === "selected" ? (
                        <div className="flex items-center gap-2">
                          <span className="text-[12px] text-[var(--foreground)]">
                            {pendingBulk.status === "expense"
                              ? `Mark ${
                                  visibleIds.filter((id) => selectedIds.has(id))
                                    .length
                                } as Expense?`
                              : `Undo Expense on ${
                                  visibleIds.filter((id) => selectedIds.has(id))
                                    .length
                                }?`}
                          </span>
                          <button
                            type="button"
                            onClick={() =>
                              applyBulkMark(pendingBulk.status, "selected")
                            }
                            className="rounded-md bg-[var(--accent-solid)] px-2.5 py-1 text-[12px] font-medium text-white hover:bg-[var(--accent-solid)]/90"
                          >
                            Confirm
                          </button>
                          <button
                            type="button"
                            onClick={() => setPendingBulk(null)}
                            className="rounded-md border border-[var(--border-strong)] px-2.5 py-1 text-[12px] font-medium text-[var(--muted)] hover:bg-[var(--surface-2)]"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() =>
                              setPendingBulk({
                                status: "redeployed",
                                scope: "selected",
                              })
                            }
                            className="rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)] px-2.5 py-1 text-[12px] font-medium text-[var(--foreground)] hover:border-[var(--accent)]"
                          >
                            Undo Expense
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setPendingBulk({
                                status: "expense",
                                scope: "selected",
                              })
                            }
                            className="rounded-md border border-rose-500/40 bg-rose-500/10 px-2.5 py-1 text-[12px] font-medium text-rose-300 hover:bg-rose-500/20"
                          >
                            Mark as Expense
                          </button>
                          <button
                            type="button"
                            onClick={clearSelection}
                            className="text-[12px] text-[var(--muted)] hover:text-[var(--foreground)]"
                          >
                            Clear
                          </button>
                        </>
                      )}
                    </div>
                  )}
                  {/* Actions for whatever is selected — one row or a hundred.
                      Only Edit and the two "remove" undos are single-only; the
                      rest take the whole selection, which is the same list the
                      bulk money-status buttons above use. One selection model,
                      reached either by individual checkboxes or Select all
                      visible. */}
                  <SelectionActions
                    selected={selectedTransfers}
                    pendingDelete={pendingDelete}
                    onEdit={(tr) =>
                      setModal(
                        tr.transferType === "expense"
                          ? { kind: "editExpense", transfer: tr }
                          : { kind: "edit", transfer: tr },
                      )
                    }
                    onMarkDeployed={(list) =>
                      setModal({ kind: "deploy", transfers: list })
                    }
                    onUnlinkDeployed={handleUnlinkDeployed}
                    onSendToPlatform={(list) =>
                      setModal({ kind: "platform", transfers: list })
                    }
                    onRemovePlatform={handleRemovePlatform}
                    onRevertToAuto={(list) =>
                      setModal({ kind: "revert", transfers: list })
                    }
                    onSplit={(list) => setModal({ kind: "split", transfers: list })}
                    onUndoSplit={(tr) =>
                      setModal({ kind: "undoSplit", transfer: tr })
                    }
                    onDeleteRequest={() => setPendingDelete(true)}
                    onDeleteConfirm={() =>
                      handleDelete(selectedTransfers.map((t) => t.id))
                    }
                    onDeleteCancel={() => setPendingDelete(false)}
                  />
                </div>

                <div className="divide-y divide-[var(--border)]">
                  {byChain.map(({ chain, list, amount }) => (
                    <div key={chain}>
                      <div className="flex items-center justify-between bg-[var(--surface-2)]/40 px-5 py-2.5">
                        <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">
                          {chain}
                          <span className="ml-2 font-normal text-[var(--muted)]/70">
                            {list.length}{" "}
                            {list.length === 1 ? "transfer" : "transfers"}
                          </span>
                        </span>
                        <span className="text-[12px] font-semibold tabular-nums text-[var(--foreground)]">
                          {formatUsd(amount)}
                        </span>
                      </div>
                      <div className="divide-y divide-[var(--border)]">
                        {list.map((t) => (
                          <TransferListRow
                            key={t.id}
                            datesLabel={upsideDatesLabel(t)}
                            transfer={t}
                            pairLabel={
                              t.transferType === "expense"
                                ? "Expense"
                                : positionPairById.get(t.positionId) ?? "—"
                            }
                            deployedLabel={deployedLabelOf(t)}
                            selected={selectedIds.has(t.id)}
                            onToggleSelect={toggleSelect}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Moved here from Business P&L: a checkpoint asks "what has happened
              since this date", and money out lives on this page. Same storage
              key (clp_business_pnl.checkpoints) — nothing migrated. */}
          <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)]">
            <div className="border-b border-[var(--border)] px-5 py-4">
              <h2 className="text-sm font-semibold tracking-tight">
                Yield Checkpoints
              </h2>
              <p className="mt-0.5 text-xs text-[var(--muted)]">
                Fees earned = claims logged after this date. Taken out = same
                definition as the Expenses card (withdrawals + transfers marked
                Expense) after this date. Shown separately on purpose — not
                netted.
              </p>
            </div>
            <div className="space-y-3 px-5 py-4">
              {checkpointRows.length === 0 && (
                <p className="text-sm text-[var(--muted)]">
                  No checkpoints yet. Add a date below to track per-period yield.
                </p>
              )}
              {checkpointRows.map((row) => (
                <div
                  key={row.date}
                  className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-md border border-[var(--border)] bg-[var(--surface-2)]/40 px-4 py-3"
                >
                  <span className="text-sm">
                    Since{" "}
                    <span className="font-medium">
                      {formatDateDDMMYYYY(row.date)}
                    </span>
                  </span>
                  <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
                    <span className="text-sm tabular-nums text-[var(--muted)]">
                      Fees earned:{" "}
                      <span className="font-semibold text-[var(--foreground)]">
                        {formatUsd(row.earned)}
                      </span>
                    </span>
                    <span className="text-[var(--border-strong)]">·</span>
                    <span className="text-sm tabular-nums text-[var(--muted)]">
                      Taken out:{" "}
                      <span className="font-semibold text-[var(--foreground)]">
                        {formatUsd(row.takenOut)}
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={() => removeCheckpoint(row.date)}
                      className="text-xs text-[var(--muted)] hover:text-rose-400"
                    >
                      Remove
                    </button>
                  </span>
                </div>
              ))}
              <div className="flex items-center gap-3 pt-1">
                <input
                  type="date"
                  aria-label="New checkpoint date"
                  style={{ colorScheme: "dark" }}
                  className="block h-9 w-44 rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)] px-3 text-sm text-[var(--foreground)] focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
                  value={newCheckpoint}
                  onChange={(e) => setNewCheckpoint(e.target.value)}
                />
                <button
                  type="button"
                  onClick={addCheckpoint}
                  className="inline-flex h-9 items-center justify-center rounded-md bg-[var(--accent-solid)] px-4 text-sm font-medium text-white shadow-sm transition-colors hover:bg-[var(--accent-solid)]/90 disabled:opacity-50"
                  disabled={newCheckpoint.trim() === ""}
                >
                  Add Checkpoint
                </button>
              </div>
            </div>
          </div>

          {expenseLedger.length > 0 && (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)]">
              <div className="border-b border-[var(--border)] px-5 py-4">
                <h2 className="text-sm font-semibold tracking-tight">
                  Expenses &amp; Withdrawals
                </h2>
                <p className="mt-0.5 text-xs text-[var(--muted)]">
                  Money out of the business — logged expenses, personal
                  withdrawals, and any transfer marked as an Expense. Each
                  reduces Available Balance.
                </p>
                {/* Tabs rather than the grouped sections the main list uses:
                    this is one flat table, and slicing it into per-chain
                    tables would repeat the header five times. Only chains
                    present in the data appear, and the tab row is hidden
                    entirely when everything sits on one chain. */}
                {expenseChains.length > 1 && (
                  <div className="mt-3 flex flex-wrap gap-1">
                    {["", ...expenseChains].map((chain) => (
                      <button
                        key={chain || "all"}
                        type="button"
                        onClick={() => setExpenseChainFilter(chain)}
                        className={`rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors ${
                          expenseChainFilter === chain
                            ? "bg-[var(--accent-solid)] text-white"
                            : "border border-[var(--border-strong)] bg-[var(--surface-2)] text-[var(--foreground)] hover:border-[var(--accent)]"
                        }`}
                      >
                        {chain === "" ? "All" : chain}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-[var(--border)] text-sm">
                  <thead className="bg-[var(--surface-2)] text-[11px] uppercase tracking-wider text-[var(--muted)]">
                    <tr>
                      <th className="px-4 py-3 text-left font-medium">Date</th>
                      <th className="px-4 py-3 text-right font-medium">
                        Amount
                      </th>
                      <th className="px-4 py-3 text-left font-medium">Chain</th>
                      <th className="px-4 py-3 text-left font-medium">Method</th>
                      <th className="px-4 py-3 text-left font-medium">Notes</th>
                      <th className="px-4 py-3 text-right font-medium">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border)]">
                    {ledgerRows.map((row) => {
                      const w = row.withdrawal;
                      return (
                      <tr
                        key={row.key}
                        className="transition-colors hover:bg-[var(--surface-2)]/60"
                      >
                        <td className="px-4 py-3 text-[var(--muted)] tabular-nums">
                          {formatDateDDMMYYYY(row.date)}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {formatUsd(row.amount)}
                        </td>
                        <td className="px-4 py-3 text-[11px] uppercase tracking-wider text-[var(--muted)]">
                          {row.chain}
                        </td>
                        <td className="px-4 py-3 text-[var(--foreground)]">
                          {row.method}
                          {row.transfer && (
                            <span className="ml-2 inline-flex items-center rounded-full border border-[var(--border-strong)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-[var(--muted)]">
                              From transfer
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 max-w-xs truncate text-[var(--muted)]">
                          {row.notes || "—"}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {/* Transfer-backed rows are edited in the transfer
                              list above — one source of truth per record. */}
                          {!w ? (
                            <button
                              type="button"
                              onClick={() =>
                                row.transfer &&
                                setModal(
                                  row.transfer.transferType === "expense"
                                    ? {
                                        kind: "editExpense",
                                        transfer: row.transfer,
                                      }
                                    : { kind: "edit", transfer: row.transfer },
                                )
                              }
                              className="rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)] px-2.5 py-1 text-xs font-medium text-[var(--foreground)] hover:bg-[var(--surface-2)]/70"
                            >
                              Edit
                            </button>
                          ) : pendingWithdrawalDelete === w.id ? (
                            <div className="inline-flex items-center gap-2">
                              <span className="text-xs text-[var(--muted)]">
                                Delete this withdrawal?
                              </span>
                              <button
                                type="button"
                                onClick={() => handleDeleteWithdrawal(w.id)}
                                className="rounded-md border border-rose-500/30 bg-rose-500/10 px-2.5 py-1 text-xs font-medium text-rose-300 hover:bg-rose-500/20"
                              >
                                Yes
                              </button>
                              <button
                                type="button"
                                onClick={() => setPendingWithdrawalDelete(null)}
                                className="rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)] px-2.5 py-1 text-xs font-medium text-[var(--foreground)] hover:bg-[var(--surface-2)]/70"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <div className="inline-flex gap-2">
                              <button
                                type="button"
                                onClick={() =>
                                  setModal({
                                    kind: "editWithdrawal",
                                    withdrawal: w,
                                  })
                                }
                                className="rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)] px-2.5 py-1 text-xs font-medium text-[var(--foreground)] hover:bg-[var(--surface-2)]/70"
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                onClick={() => setPendingWithdrawalDelete(w.id)}
                                className="rounded-md border border-rose-500/30 bg-rose-500/10 px-2.5 py-1 text-xs font-medium text-rose-300 hover:bg-rose-500/20"
                              >
                                Delete
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                  <tfoot className="border-t border-[var(--border-strong)] bg-[var(--surface-2)]/60">
                    <tr className="font-semibold">
                      <td className="px-4 py-3">
                        Total Out of Business
                        {expenseChainFilter !== "" && (
                          <span className="ml-2 font-normal text-[var(--muted)]">
                            ({expenseChainFilter} only)
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {formatUsd(
                          expenseChainFilter === ""
                            ? balance.withdrawn
                            : ledgerTotal,
                        )}
                      </td>
                      <td className="px-4 py-3" colSpan={4} />
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          )}

          {/* Last section on the page: a recovery tool most visits never need,
              so it sits below the actual transfer data rather than above it. */}
          <RecentlyDeletedSection
            rows={deletedTransfers}
            open={showDeleted}
            onToggle={() => {
              setShowDeleted((v) => !v);
              setPendingPurge(null);
            }}
            pairLabelFor={(t) =>
              t.transferType === "expense"
                ? "Expense"
                : positionPairById.get(t.positionId) ?? "—"
            }
            deployedLabelFor={(t) => deployedLabelOf(t) ?? "—"}
            pendingPurge={pendingPurge}
            onPurgeRequest={setPendingPurge}
            onPurgeConfirm={handlePurge}
            onPurgeCancel={() => setPendingPurge(null)}
            onRestore={handleRestore}
          />

          {modal.kind === "add" && (
            <TransferFormModal
              title="Add Transfer"
              submitLabel="Add Transfer"
              initial={{ ...EMPTY_FORM, date: todayDateInput() }}
              positions={positions}
              onCancel={() => setModal({ kind: "none" })}
              onSubmit={handleAdd}
            />
          )}
          {modal.kind === "edit" && (
            <TransferFormModal
              title="Edit Transfer"
              submitLabel="Save Changes"
              initial={transferToForm(modal.transfer)}
              positions={positions}
              onCancel={() => setModal({ kind: "none" })}
              onSubmit={(form) => handleEdit(modal.transfer, form)}
              onDelete={() => handleDeleteFromModal(modal.transfer.id)}
            />
          )}
          {modal.kind === "editExpense" && (
            <ExpenseFormModal
              title="Edit Expense"
              submitLabel="Save Changes"
              initial={expenseToForm(modal.transfer)}
              onCancel={() => setModal({ kind: "none" })}
              onSubmit={(form) => handleEditExpense(modal.transfer, form)}
              onDelete={() => handleDeleteFromModal(modal.transfer.id)}
            />
          )}
          {modal.kind === "revert" && (
            <RevertToAutoModal
              transfers={modal.transfers}
              claims={claims}
              positions={positions}
              onCancel={() => setModal({ kind: "none" })}
              onApplied={() => {
                refresh();
                setModal({ kind: "none" });
              }}
            />
          )}
          {modal.kind === "deploy" && (
            <DeployLinkModal
              transfers={modal.transfers}
              positions={positions}
              noteFor={positionNotes}
              onCancel={() => setModal({ kind: "none" })}
              onSubmit={(positionId) =>
                handleMarkDeployed(modal.transfers, positionId)
              }
            />
          )}
          {modal.kind === "platform" && (
            <SendToPlatformModal
              transfers={modal.transfers}
              knownPlatforms={knownPlatforms}
              onCancel={() => setModal({ kind: "none" })}
              onSubmit={(platform) =>
                handleSendToPlatform(modal.transfers, platform)
              }
            />
          )}
          {modal.kind === "split" &&
            (modal.transfers.length === 1 ? (
              <SplitTransferModal
                transfer={modal.transfers[0]}
                claims={claims}
                onCancel={() => setModal({ kind: "none" })}
                onSubmit={(plan) => handleSplit(modal.transfers[0], plan)}
              />
            ) : (
              <BulkSplitModal
                transfers={modal.transfers}
                claims={claims}
                onCancel={() => setModal({ kind: "none" })}
                onSubmit={handleBulkSplit}
              />
            ))}
          {modal.kind === "undoSplit" && (
            <UndoSplitModal
              piece={modal.transfer}
              transfers={transfers}
              allTransfers={[...transfers, ...deletedTransfers]}
              onCancel={() => setModal({ kind: "none" })}
              onSubmit={handleUndoSplit}
            />
          )}
          {modal.kind === "addWithdrawal" && (
            <WithdrawalFormModal
              title="Log an Expense"
              submitLabel="Log Expense"
              initial={{ ...EMPTY_WITHDRAWAL_FORM, date: todayDateInput() }}
              onCancel={() => setModal({ kind: "none" })}
              onSubmit={handleAddWithdrawal}
            />
          )}
          {modal.kind === "editWithdrawal" && (
            <WithdrawalFormModal
              title="Edit Withdrawal"
              submitLabel="Save Changes"
              initial={withdrawalToForm(modal.withdrawal)}
              onCancel={() => setModal({ kind: "none" })}
              onSubmit={(form) => handleEditWithdrawal(modal.withdrawal, form)}
            />
          )}
        </>
      )}
    </section>
  );
}

interface GroupRow {
  key: string;
  label: string;
  count: number;
  amount: number;
}

interface GroupTableProps {
  title: string;
  subtitle: string;
  columnLabel: string;
  rows: GroupRow[];
  total: number;
}

function GroupTable({
  title,
  subtitle,
  columnLabel,
  rows,
  total,
}: GroupTableProps) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)]">
      <div className="border-b border-[var(--border)] px-5 py-4">
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        <p className="mt-0.5 text-xs text-[var(--muted)]">{subtitle}</p>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-[var(--border)] text-sm">
          <thead className="bg-[var(--surface-2)] text-[11px] uppercase tracking-wider text-[var(--muted)]">
            <tr>
              <th className="px-4 py-3 text-left font-medium">{columnLabel}</th>
              <th className="px-4 py-3 text-right font-medium">Transfers</th>
              <th className="px-4 py-3 text-right font-medium">Net Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)]">
            {rows.map((row) => (
              <tr key={row.key}>
                <td className="px-4 py-3 font-medium">{row.label}</td>
                <td className="px-4 py-3 text-right tabular-nums text-[var(--muted)]">
                  {row.count}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {formatUsd(row.amount)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t border-[var(--border-strong)] bg-[var(--surface-2)]/60">
            <tr className="font-semibold">
              <td className="px-4 py-3">Net Total</td>
              <td className="px-4 py-3" />
              <td className="px-4 py-3 text-right tabular-nums">
                {formatUsd(total)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

interface SummaryStatProps {
  label: string;
  value: string;
  hint?: string;
  // Optional "where this total came from" split, rendered directly under the
  // figure. Zero-value parts are dropped so a card never lists an empty
  // category; if every part is zero the whole line disappears.
  parts?: { label: string; value: number }[];
}

function SummaryStat({ label, value, hint, parts }: SummaryStatProps) {
  const [open, setOpen] = useState(false);
  const shown = (parts ?? []).filter((p) => p.value !== 0);
  // Explanatory text is hidden until asked for, so every card reads as label +
  // figure and the row is even however much a given card has to explain. The
  // old equalising devices (min-h-[168px], the reserved split-line slot,
  // mt-auto on the hint) are gone with it: collapsed content is identical
  // across cards, so the height matches on its own, and forcing the old height
  // onto a compact card would only add dead space. self-start keeps an
  // EXPANDED card from stretching its neighbours — expanding one card is a
  // deliberate act on that card alone. Wording and figures are untouched.
  const hasDetails = hint !== undefined || shown.length > 0;
  return (
    <div className="flex flex-col self-start rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
      {/* Two lines reserved for the label: at five columns some of these
          labels wrap and some don't, which would otherwise leave the collapsed
          row uneven by a line for a reason that has nothing to do with what
          the card contains. This is the ONLY reserved slot left. */}
      <div className="min-h-[2rem] text-[11px] font-medium uppercase tracking-wider text-[var(--muted)]">
        {label}
      </div>
      <div className="mt-2 text-2xl font-semibold tracking-tight text-[var(--foreground)]">
        {value}
      </div>
      {/* A card with nothing to explain gets no toggle — there is nothing
          behind it to open. */}
      {hasDetails && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="mt-2 flex w-fit items-center gap-1 text-[11px] font-medium text-[var(--muted)] transition-colors hover:text-[var(--foreground)]"
        >
          Details
          <span className="text-[9px]">{open ? "▴" : "▾"}</span>
        </button>
      )}
      {open && shown.length > 0 && (
        /* The separator belongs to the part BEFORE it, not the one after. As a
           leading "·" it was a separate inline box that could wrap with the
           next part, dropping a dangling dot onto the start of the second
           line; trailing, it can only ever end a line, which reads as
           "continues below". */
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] tabular-nums text-[var(--muted)]">
          {shown.map((p, i) => (
            <span key={p.label} className="whitespace-nowrap">
              {p.label}: {formatUsd(p.value)}
              {i < shown.length - 1 && (
                <span className="ml-2 opacity-50">·</span>
              )}
            </span>
          ))}
        </div>
      )}
      {open && hint && (
        <div className="pt-2 text-xs text-[var(--muted)]">{hint}</div>
      )}
    </div>
  );
}

interface BreakdownStatProps {
  breakdown: Record<TransferType, number>;
}

function BreakdownStat({ breakdown }: BreakdownStatProps) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
      <div className="text-[11px] font-medium uppercase tracking-wider text-[var(--muted)]">
        Breakdown by Type
      </div>
      <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {(Object.keys(TYPE_LABELS) as TransferType[]).map((t) => (
          <div key={t} className="flex flex-col items-center">
            <div
              className={`flex h-6 w-full items-center justify-center rounded-full px-2 text-[10px] font-medium uppercase tracking-wider whitespace-nowrap ring-1 ring-inset ${TYPE_PILL[t]}`}
            >
              {SHORT_TYPE_LABELS[t]}
            </div>
            <div className="mt-2 text-lg font-semibold tabular-nums text-[var(--foreground)]">
              {breakdown[t]}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

interface TypePillProps {
  type: TransferType;
}

function TypePill({ type }: TypePillProps) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider ring-1 ring-inset ${TYPE_PILL[type]}`}
    >
      {SHORT_TYPE_LABELS[type]}
    </span>
  );
}

interface TypeFilterToggleProps {
  value: TypeFilter;
  onChange: (next: TypeFilter) => void;
}

function TypeFilterToggle({ value, onChange }: TypeFilterToggleProps) {
  const options: Array<{ value: TypeFilter; label: string }> = [
    { value: "all", label: "All" },
    { value: "fees", label: "Fees" },
    { value: "undeployed", label: "Undeployed Tokens" },
    { value: "outOfRangeUpside", label: "Out of Range Upside" },
    { value: "expense", label: "Expenses" },
  ];
  return (
    <div
      role="radiogroup"
      aria-label="Filter by transfer type"
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
            className={`h-8 px-3 text-xs font-medium transition-colors ${
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
  // Present only when editing an existing record. Calls the SAME soft-delete
  // handler the row-level Delete uses, so the record lands in Recently Deleted
  // and stays restorable — there is deliberately no second delete path.
  onDelete?: () => void;
}

function FormActions({ onCancel, submitLabel, onDelete }: FormActionsProps) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="flex flex-wrap items-center justify-end gap-2 px-5 py-4">
      {onDelete &&
        (confirming ? (
          <div className="mr-auto flex flex-wrap items-center gap-2">
            <span className="text-xs text-[var(--muted)]">
              Delete this? You can restore it from Recently Deleted.
            </span>
            <button
              type="button"
              onClick={onDelete}
              className="rounded-md border border-rose-500/30 bg-rose-500/10 px-2.5 py-1 text-xs font-medium text-rose-300 hover:bg-rose-500/20"
            >
              Yes
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)] px-2.5 py-1 text-xs font-medium text-[var(--foreground)] hover:bg-[var(--surface-2)]/70"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="mr-auto inline-flex h-9 items-center justify-center rounded-md border border-rose-500/30 bg-rose-500/10 px-4 text-sm font-medium text-rose-300 hover:bg-rose-500/20"
          >
            Delete
          </button>
        ))}
      <button
        type="button"
        onClick={onCancel}
        className="inline-flex h-9 items-center justify-center rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)] px-4 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--surface-2)]/70"
      >
        Cancel
      </button>
      <button
        type="submit"
        className="inline-flex h-9 items-center justify-center rounded-md bg-[var(--accent-solid)] px-4 text-sm font-medium text-white shadow-sm transition-colors hover:bg-[var(--accent-solid)]/90"
      >
        {submitLabel}
      </button>
    </div>
  );
}

interface TransferFormModalProps {
  title: string;
  submitLabel: string;
  initial: TransferFormState;
  positions: Position[];
  onCancel: () => void;
  onSubmit: (form: TransferFormState) => void;
  onDelete?: () => void;
}

function TransferFormModal({
  title,
  submitLabel,
  initial,
  positions,
  onCancel,
  onSubmit,
  onDelete,
}: TransferFormModalProps) {
  const [form, setForm] = useState<TransferFormState>(initial);

  const set = <K extends keyof TransferFormState>(
    key: K,
    value: TransferFormState[K],
  ) => setForm((prev) => ({ ...prev, [key]: value }));

  const upper =
    (key: keyof TransferFormState) =>
    (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      set(key, e.target.value.toUpperCase() as TransferFormState[typeof key]);

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    onSubmit(form);
  };

  return (
    <ModalShell title={title} onCancel={onCancel}>
      <form onSubmit={submit} className="divide-y divide-[var(--border)]">
        <Section title="Transfer Details">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <PositionCombobox
              positions={positions}
              value={form.positionId}
              onChange={(v) => set("positionId", v)}
            />
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
            <Field label="Token" htmlFor="token">
              <input
                id="token"
                required
                className={inputClass}
                placeholder="ETH"
                value={form.token}
                onChange={upper("token")}
              />
            </Field>
            <Field label="Amount" htmlFor="amount">
              <input
                id="amount"
                type="number"
                step="any"
                required
                className={inputClass}
                value={form.amount}
                onChange={(e) => set("amount", e.target.value)}
              />
            </Field>
            {/* Platform is OPTIONAL. It used to be `required`, which blocked
                saving any unrelated edit (a typo in the notes, a money-status
                change) on the auto-created transfers that deliberately start
                with a blank platform. Assigning one is still what moves money
                into the Transferred state — that is driven by the field's
                value, never by the form validating it. */}
            <Field
              label="Platform (from)"
              htmlFor="platform"
              hint="Where the money came from — optional. Filling this in marks the money as Transferred to that platform."
            >
              <input
                id="platform"
                className={inputClass}
                placeholder="AAVE"
                value={form.platform}
                onChange={upper("platform")}
              />
            </Field>
            <Field
              label="Destination (to)"
              htmlFor="destination"
              hint="Where you moved it — optional."
            >
              <input
                id="destination"
                className={inputClass}
                placeholder="RAKA"
                value={form.destination}
                onChange={upper("destination")}
              />
            </Field>
            <Field label="Transfer Type" htmlFor="transferType">
              <TypeSegmentedToggle
                value={form.transferType}
                onChange={(v) => set("transferType", v)}
              />
            </Field>
            {/* Undeployed Tokens are idle capital — not yet redeployed OR spent
                — so no Money Status is asked at logging time (Part 3). It stays
                idle until marked deployed or edited to an expense later. */}
            {form.transferType !== "undeployed" && (
              <Field
                label="Money Status"
                htmlFor="moneyStatus"
                hint="Redeployed is the normal state every transfer starts in — money still working in the business. Switch to Expense only when the money has genuinely left the business; setting it back to Redeployed is how you undo that."
              >
                <MoneyStatusToggle
                  value={form.moneyStatus}
                  onChange={(v) => set("moneyStatus", v)}
                />
              </Field>
            )}
          </div>
          <div className="mt-4">
            <Field label="Notes" htmlFor="notes">
              <textarea
                id="notes"
                rows={2}
                className={inputClass}
                value={form.notes}
                // Saved as typed — see the note in buildTransfer.
                onChange={(e) => set("notes", e.target.value)}
              />
            </Field>
          </div>
        </Section>
        <FormActions
          onCancel={onCancel}
          submitLabel={submitLabel}
          onDelete={onDelete}
        />
      </form>
    </ModalShell>
  );
}

interface WithdrawalFormModalProps {
  title: string;
  submitLabel: string;
  initial: WithdrawalFormState;
  onCancel: () => void;
  onSubmit: (form: WithdrawalFormState) => void;
}

function WithdrawalFormModal({
  title,
  submitLabel,
  initial,
  onCancel,
  onSubmit,
}: WithdrawalFormModalProps) {
  const [form, setForm] = useState<WithdrawalFormState>(initial);

  const set = <K extends keyof WithdrawalFormState>(
    key: K,
    value: WithdrawalFormState[K],
  ) => setForm((prev) => ({ ...prev, [key]: value }));

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    onSubmit(form);
  };

  return (
    <ModalShell title={title} onCancel={onCancel}>
      <form onSubmit={submit} className="divide-y divide-[var(--border)]">
        <Section title="Expense / Withdrawal Details">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Date" htmlFor="w_date">
              <input
                id="w_date"
                type="date"
                required
                className={inputClass}
                style={{ colorScheme: "dark" }}
                value={form.date}
                onChange={(e) => set("date", e.target.value)}
              />
            </Field>
            <Field label="Amount (USD)" htmlFor="w_amount">
              <input
                id="w_amount"
                type="number"
                step="any"
                required
                className={inputClass}
                placeholder="0.00"
                value={form.amount}
                onChange={(e) => set("amount", e.target.value)}
              />
            </Field>
            <Field
              label="Method / Category (optional)"
              htmlFor="w_method"
              hint="e.g. Rent, Bank, Personal Wallet."
            >
              <input
                id="w_method"
                className={inputClass}
                placeholder="RENT"
                value={form.method}
                onChange={(e) => set("method", e.target.value.toUpperCase())}
              />
            </Field>
          </div>
          <div className="mt-4">
            <Field label="Notes" htmlFor="w_notes">
              <textarea
                id="w_notes"
                rows={2}
                className={inputClass}
                value={form.notes}
                // Saved as typed. Method above keeps its uppercase — it is a
                // short label the ledger groups by eye, not prose.
                onChange={(e) => set("notes", e.target.value)}
              />
            </Field>
          </div>
        </Section>
        <FormActions onCancel={onCancel} submitLabel={submitLabel} />
      </form>
    </ModalShell>
  );
}

// Minimal modal for position-less expenses — Date, Amount, Notes only.
// moneyStatus/transferType are set to "expense" by buildExpense, not the user.
// Picks the position a Redeployed transfer's money went into. All positions are
// offered — usually a new active one, but a top-up into any existing position is
// valid, so we don't over-restrict; active are listed first, closed labelled.
// "Not sure which position" is offered too, so money the user knows was deployed
// is not left sitting in Available Balance just because they can't place it.
// Confirming records the link; the position itself is never modified.
function DeployLinkModal({
  transfers,
  positions,
  noteFor,
  onCancel,
  onSubmit,
}: {
  // The whole selection. Expensed rows ride along so the preview can say how
  // many are being skipped and why, rather than quietly shrinking the batch.
  transfers: Transfer[];
  positions: Position[];
  // Per-position memory aid ("already has $X deployed", "fully expensed"),
  // shared with the page's position filter so the two can never word it
  // differently. Informational only — it never blocks picking a position,
  // since topping one up is legitimate.
  noteFor: (p: Position) => PositionNote[];
  onCancel: () => void;
  onSubmit: (positionId: string) => void;
}) {
  const eligible = transfers.filter(canPlaceTransfer);
  const skipped = transfers.length - eligible.length;
  const total = eligible.reduce((sum, t) => sum + t.amount, 0);
  // Preselect only when the batch already agrees on a destination, so a mixed
  // batch never looks like it has one.
  const shared = eligible[0]?.deployedToPositionId;
  const [positionId, setPositionId] = useState(
    shared && eligible.every((t) => t.deployedToPositionId === shared)
      ? shared
      : "",
  );
  // Memory aid, not a guess: money usually goes into a position opened just
  // AFTER it came in, so positions opened soonest after the batch's EARLIEST
  // transfer date come first, then everything else by how far away it is in
  // either direction. The existing active-before-closed grouping is kept as the
  // primary key — it is a deliberate convention (a top-up into a closed
  // position is legal but rare), so proximity only reorders WITHIN each group.
  const transferTime = Math.min(
    ...eligible.map((t) => new Date(t.date).getTime() || Infinity),
  );
  const proximityRank = (p: Position): number => {
    const opened = new Date(p.entryDatetime).getTime();
    if (!Number.isFinite(opened) || !Number.isFinite(transferTime)) {
      return Number.MAX_SAFE_INTEGER;
    }
    const delta = opened - transferTime;
    // Opened after the transfer sorts ahead of the same gap before it; the
    // small penalty is what breaks the tie without hiding earlier positions.
    return delta >= 0 ? delta : -delta * 1.5;
  };
  // Applied inside each chain's Open/Closed section by the shared combobox,
  // which owns the chain grouping and the open-before-closed split.
  const byProximity = (a: Position, b: Position) => {
    const rank = proximityRank(a) - proximityRank(b);
    return rank !== 0 ? rank : a.pair.localeCompare(b.pair);
  };
  return (
    <ModalShell title="Mark as deployed" onCancel={onCancel}>
      <Section title="Deploy into a position">
        <p className="mb-3 text-[11px] leading-relaxed text-[var(--muted)]">
          {/* Explicit {" "} — the literal space after the expression is
              trimmed at build time, rendering "$500.00transfer". */}
          Link{" "}
          {eligible.length === 1
            ? `this ${formatUsd(total)} transfer`
            : `these ${eligible.length} transfers (${formatUsd(total)})`}{" "}
          to the position the money went into. They stay in the list but leave
          Available Balance until you undo. The position&apos;s own Deposited
          figure is unchanged — you entered that separately when you opened it.
          If you can&apos;t remember which position, say so — the money still
          counts as deployed and you can name it later.
        </p>
        {/* Real counts before committing: a batch that silently dropped rows
            would be indistinguishable from one that worked. */}
        {skipped > 0 && (
          <p className="mb-4 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-200">
            {eligible.length} of {transfers.length} selected will be linked.{" "}
            {skipped} {skipped === 1 ? "is" : "are"} marked as an Expense — that
            money has left the business, so {skipped === 1 ? "it" : "they"}{" "}
            cannot be deployed and will be left untouched.
          </p>
        )}
        {/* The shared searchable picker rather than a native <select>: macOS
            draws select popups itself and ignores option colour, so the red
            "fully expensed" warning could only be a ⚠ glyph there. Here the
            colour is real. Search, chain grouping and the Open/Closed split all
            come with it, matching the pickers everywhere else. "Not sure which
            position" rides in on the existing all-entry slot, so it stays
            selectable above the real positions. */}
        <PositionCombobox
          positions={positions}
          value={positionId}
          onChange={setPositionId}
          label="Position"
          allValue={UNKNOWN_POSITION_ID}
          allLabel="Not sure which position (deployed, unknown)"
          noteFor={noteFor}
          sortWithinSection={byProximity}
        />
        <p className="mt-2 text-[11px] leading-relaxed text-[var(--muted)]">
          Within each chain, positions opened closest to this transfer&apos;s
          date ({formatDateDDMMYYYY(new Date(transferTime).toISOString())})
          come first — a memory aid,
          not a guess. You can change this later.
        </p>
      </Section>
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
          disabled={positionId === "" || eligible.length === 0}
          onClick={() => onSubmit(positionId)}
          className="inline-flex h-9 items-center justify-center rounded-md bg-[var(--accent-solid)] px-4 text-sm font-medium text-white shadow-sm transition-colors hover:bg-[var(--accent-solid)]/90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Confirm
        </button>
      </div>
    </ModalShell>
  );
}

// Names the platform a single transfer's money was sent to (Part 2). Free
// text with autocomplete over platforms already in use, since platforms are
// user-defined strings everywhere else in the app; stored uppercase like every
// other platform value. Assigning it is what moves the money into the
// Transferred state, so the balance consequence is spelled out here.
function SendToPlatformModal({
  transfers,
  knownPlatforms,
  onCancel,
  onSubmit,
}: {
  // The whole selection; expensed rows ride along only so the preview can
  // report them as skipped.
  transfers: Transfer[];
  knownPlatforms: string[];
  onCancel: () => void;
  onSubmit: (platform: string) => void;
}) {
  const eligible = transfers.filter(canPlaceTransfer);
  const skipped = transfers.length - eligible.length;
  const total = eligible.reduce((sum, t) => sum + t.amount, 0);
  // Prefill only when the batch already shares one platform.
  const shared = eligible[0]?.platform ?? "";
  const [platform, setPlatform] = useState(
    shared !== "" && eligible.every((t) => t.platform === shared) ? shared : "",
  );
  return (
    <ModalShell title="Send to Platform" onCancel={onCancel}>
      <Section title="Where did this money go?">
        <p className="mb-3 text-[11px] leading-relaxed text-[var(--muted)]">
          Name the platform{" "}
          {eligible.length === 1
            ? `this ${formatUsd(total)}`
            : `these ${eligible.length} transfers (${formatUsd(total)})`}{" "}
          went to for yield (AAVE, a CEX, anywhere it is working). They stay in
          the list but leave Available Balance and join Transferred to Platforms
          — clear the platform again to bring it back.
        </p>
        {skipped > 0 && (
          <p className="mb-4 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-200">
            {eligible.length} of {transfers.length} selected will be sent.{" "}
            {skipped} {skipped === 1 ? "is" : "are"} marked as an Expense — that
            money has already left the business, so {skipped === 1 ? "it" : "they"}{" "}
            cannot be transferred and will be left untouched.
          </p>
        )}
        <Field label="Platform" htmlFor="send-platform">
          <input
            id="send-platform"
            list="send-platform-options"
            value={platform}
            onChange={(e) => setPlatform(e.target.value.toUpperCase())}
            placeholder="AAVE"
            className={inputClass}
          />
          <datalist id="send-platform-options">
            {knownPlatforms.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        </Field>
      </Section>
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
          disabled={platform.trim() === "" || eligible.length === 0}
          onClick={() => onSubmit(platform)}
          className="inline-flex h-9 items-center justify-center rounded-md bg-[var(--accent-solid)] px-4 text-sm font-medium text-white shadow-sm transition-colors hover:bg-[var(--accent-solid)]/90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Confirm
        </button>
      </div>
    </ModalShell>
  );
}

// Bulk split: only claim-linked rows can be done unattended, because the manual
// path needs a figure typed per transfer. Everything else is REPORTED with its
// reason rather than silently dropped, and one unsplittable row never blocks the
// rest — that is the whole point of previewing the batch before applying it.
function BulkSplitModal({
  transfers,
  claims,
  onCancel,
  onSubmit,
}: {
  transfers: Transfer[];
  claims: FeeClaim[];
  onCancel: () => void;
  onSubmit: (plan: BulkSplitPlan) => void;
}) {
  const plan = useMemo(
    () => planBulkSplit(transfers, claims),
    [transfers, claims],
  );
  const total = plan.splittable.reduce((sum, s) => sum + s.transfer.amount, 0);
  return (
    <ModalShell title="Split transfers" onCancel={onCancel}>
      <Section title={`${transfers.length} selected`}>
        <p className="mb-3 text-[11px] leading-relaxed text-[var(--muted)]">
          Each one becomes two rows — the stablecoin part and the token part —
          using its own linked claim to work out the amounts. Every pair adds up
          to what it replaced, so no balance moves, and each original goes to
          Recently Deleted.
        </p>
        {plan.skipped.length > 0 && (
          <p className="mb-4 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-200">
            {plan.splittable.length}{" "}
            {plan.splittable.length === 1 ? "transfer" : "transfers"} will be
            split, {plan.skipped.length} skipped — most often because there is no
            linked claim to compute the split from. Split those individually,
            where you can type the stablecoin amount yourself.
          </p>
        )}
        {plan.splittable.length > 0 && (
          <ul className="space-y-2">
            {plan.splittable.map(({ transfer: t, plan: p }) => (
              <li
                key={t.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)]/40 px-3 py-2 text-[12px]"
              >
                <span className="tabular-nums text-[var(--muted)]">
                  {formatDateDDMMYYYY(t.date)} ·{" "}
                  <span className="font-medium text-[var(--foreground)]">
                    {formatUsd(t.amount)}
                  </span>
                </span>
                <span className="tabular-nums text-[var(--muted)]">
                  {formatUsd(p.stableAmount)} stable +{" "}
                  {formatUsd(p.tokenAmount)} token
                </span>
              </li>
            ))}
          </ul>
        )}
        {plan.skipped.length > 0 && (
          <ul className="mt-3 space-y-1">
            {plan.skipped.map(({ transfer: t, reason }) => (
              <li
                key={t.id}
                className="flex flex-wrap items-center justify-between gap-2 px-3 text-[11px] text-[var(--muted)]"
              >
                <span className="tabular-nums">
                  {formatDateDDMMYYYY(t.date)} · {formatUsd(t.amount)}
                </span>
                <span>skipped — {reason}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
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
          disabled={plan.splittable.length === 0}
          onClick={() => onSubmit(plan)}
          className="inline-flex h-9 items-center justify-center rounded-md bg-[var(--accent-solid)] px-4 text-sm font-medium text-white shadow-sm transition-colors hover:bg-[var(--accent-solid)]/90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Split {plan.splittable.length} ({formatUsd(total)})
        </button>
      </div>
    </ModalShell>
  );
}

// Undo: delete both pieces, restore the original from Recently Deleted. Never a
// merge — the original was only soft-deleted, so what comes back is the exact
// record that was split, sourceClaimId and all. Confirms first when the pieces
// no longer add up to it, since undoing discards whatever was edited.
function UndoSplitModal({
  piece,
  transfers,
  allTransfers,
  onCancel,
  onSubmit,
}: {
  piece: Transfer;
  transfers: Transfer[];
  allTransfers: Transfer[];
  onCancel: () => void;
  onSubmit: (plan: UndoSplitPlan) => void;
}) {
  const plan = useMemo(
    () => planUndoSplit(piece, transfers, allTransfers),
    [piece, transfers, allTransfers],
  );
  return (
    <ModalShell title="Undo split" onCancel={onCancel}>
      <Section title="Put this back together">
        {plan.error !== undefined ? (
          <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-200">
            {plan.error}
          </p>
        ) : (
          <>
            <p className="mb-3 text-[11px] leading-relaxed text-[var(--muted)]">
              The {plan.pieces.length} split{" "}
              {plan.pieces.length === 1 ? "row" : "rows"} below go to Recently
              Deleted and the original {formatUsd(plan.originalAmount)} transfer
              comes back exactly as it was.
            </p>
            {/* A legacy piece has no stored pointer, so the original was found
                by matching shape and total. Say exactly what was matched and
                make the user agree before anything is restored. */}
            {plan.bestEffort && plan.original !== null && (
              <p className="mb-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-200">
                This split was made before undo was recorded, so the original
                was matched rather than looked up: a deleted{" "}
                {formatUsd(plan.originalAmount)} transfer dated{" "}
                {formatDateDDMMYYYY(plan.original.date)}
                {plan.original.platform ? ` on ${plan.original.platform}` : ""}.
                Check that is the right one before restoring it.
              </p>
            )}
            <ul className="space-y-2">
              {plan.pieces.map((p) => (
                <li
                  key={p.id}
                  className="flex items-center justify-between rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)]/40 px-3 py-2 text-[12px]"
                >
                  <span className="text-[var(--muted)]">
                    {p.token || p.splitPart}
                  </span>
                  <span className="font-semibold tabular-nums text-[var(--foreground)]">
                    {formatUsd(p.amount)}
                  </span>
                </li>
              ))}
            </ul>
            {plan.edited && (
              <p className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-200">
                These pieces now total {formatUsd(plan.piecesTotal)}, not the{" "}
                {formatUsd(plan.originalAmount)} they were split from — one of
                them was edited since. Undoing discards that edit. Undo anyway?
              </p>
            )}
          </>
        )}
      </Section>
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
          disabled={plan.error !== undefined}
          onClick={() => onSubmit(plan)}
          className="inline-flex h-9 items-center justify-center rounded-md bg-[var(--accent-solid)] px-4 text-sm font-medium text-white shadow-sm transition-colors hover:bg-[var(--accent-solid)]/90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {/* On an error the button is disabled anyway, but it must not sit
              there offering to restore something that was never found. */}
          {plan.error !== undefined
            ? "Undo split"
            : plan.edited
              ? "Undo anyway"
              : plan.bestEffort
                ? "Yes, restore that one"
                : "Undo split"}
        </button>
      </div>
    </ModalShell>
  );
}

// Splits ONE transfer into its stablecoin and token halves, previewing both
// before anything is written. With a live claim link the stable figure is read
// from the claim (claimStableFace) and shown read-only; without one there is
// nothing to read — a Transfer stores one amount and one token — so the user
// types it and the remainder becomes the token side.
function SplitTransferModal({
  transfer,
  claims,
  onCancel,
  onSubmit,
}: {
  transfer: Transfer;
  claims: FeeClaim[];
  onCancel: () => void;
  onSubmit: (plan: TransferSplitPlan) => void;
}) {
  const linked = useMemo(
    () => planTransferSplit(transfer, claims),
    [transfer, claims],
  );
  const fromClaim = linked.claim !== null;
  const [manual, setManual] = useState("");
  const plan = useMemo(
    () =>
      fromClaim
        ? linked
        : planTransferSplit(
            transfer,
            claims,
            manual.trim() === "" ? undefined : Number(manual),
          ),
    [fromClaim, linked, transfer, claims, manual],
  );
  return (
    <ModalShell title="Split transfer" onCancel={onCancel}>
      <Section title="Break this into two independent transfers">
        <p className="mb-3 text-[11px] leading-relaxed text-[var(--muted)]">
          {formatUsd(transfer.amount)} becomes two rows — the stablecoin part
          and the token part — each separately editable from then on, so you can
          send one to a platform now and expense the other later. The two always
          add up to the original, so no balance moves. The original goes to
          Recently Deleted and can be restored.
        </p>

        {fromClaim ? (
          <p className="mb-4 rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)]/40 px-3 py-2 text-[11px] leading-relaxed text-[var(--muted)]">
            Split read from the linked fee claim&apos;s stablecoin legs.
          </p>
        ) : (
          <Field
            label="Stablecoin portion (USD)"
            htmlFor="split-stable"
            hint="This transfer has no linked claim to read, so enter how much of it was already in stablecoin. The rest becomes the token part."
          >
            <input
              id="split-stable"
              type="number"
              step="any"
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              placeholder="0.00"
              className={inputClass}
            />
          </Field>
        )}

        {plan.error !== undefined ? (
          <p className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-200">
            {plan.error}
          </p>
        ) : (
          <div className="mt-3 space-y-2">
            {[
              { label: "Stable part", value: plan.stableAmount },
              { label: "Token part", value: plan.tokenAmount },
            ].map((row) => (
              <div
                key={row.label}
                className="flex items-center justify-between rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)]/40 px-3 py-2 text-[12px]"
              >
                <span className="text-[var(--muted)]">{row.label}</span>
                <span className="font-semibold tabular-nums text-[var(--foreground)]">
                  {formatUsd(row.value)}
                </span>
              </div>
            ))}
            <div className="flex items-center justify-between px-3 text-[11px] text-[var(--muted)]">
              <span>Total after split</span>
              <span className="tabular-nums">
                {formatUsd(plan.stableAmount + plan.tokenAmount)} · unchanged
              </span>
            </div>
          </div>
        )}
      </Section>
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
          disabled={plan.error !== undefined}
          onClick={() => onSubmit(plan)}
          className="inline-flex h-9 items-center justify-center rounded-md bg-[var(--accent-solid)] px-4 text-sm font-medium text-white shadow-sm transition-colors hover:bg-[var(--accent-solid)]/90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Split into two
        </button>
      </div>
    </ModalShell>
  );
}

// Shows what "Revert to auto-created" would produce BEFORE anything is written:
// the plan is computed on open (the dual-token case fetches historical prices,
// hence the loading state), rendered as a current → new comparison, and only
// applied on an explicit Confirm. A dual-token claim owns two transfers whose
// amounts are computed against each other, so the whole source group is shown
// and rebuilt together — reverting one leg in isolation could not reproduce the
// split.
function RevertToAutoModal({
  transfers,
  claims,
  positions,
  onCancel,
  onApplied,
}: {
  // The whole selection. Manually-created rows ride along so the preview can
  // report them as skipped rather than the batch quietly shrinking.
  transfers: Transfer[];
  claims: FeeClaim[];
  positions: Position[];
  onCancel: () => void;
  onApplied: () => void;
}) {
  const [plans, setPlans] = useState<AutoRevertPlan[] | null>(null);
  const [failed, setFailed] = useState(false);

  const eligible = useMemo(
    () => transfers.filter(isAutoCreated),
    [transfers],
  );
  const skipped = transfers.length - eligible.length;

  useEffect(() => {
    let live = true;
    // One plan per SOURCE GROUP, not per selected row: a dual-token claim owns
    // two transfers, and selecting both must not rebuild that claim twice.
    const seen = new Set<string>();
    const roots = eligible.filter((t) => {
      const key = t.sourceClaimId ?? `close:${t.sourceCloseId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    Promise.all(roots.map((t) => planRevertToAuto(t, claims, positions)))
      .then((ps) => {
        if (live) setPlans(ps);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [eligible, claims, positions]);

  const describe = (t: Transfer) =>
    `${t.token || "—"} · ${formatUsd(t.amount)} · platform ${
      t.platform || "(none)"
    } · ${t.moneyStatus ?? "idle"}`;

  const usable = (plans ?? []).filter((p) => p.next.length > 0);
  const blocked = (plans ?? []).filter((p) => p.next.length === 0);
  const rebuilt = usable.reduce((n, p) => n + p.next.length, 0);

  return (
    <ModalShell title="Revert to auto-created" onCancel={onCancel}>
      <Section title="Recomputed from the linked records">
        {skipped > 0 && (
          <p className="mb-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-200">
            {eligible.length} of {transfers.length} selected can be reverted.{" "}
            {skipped} {skipped === 1 ? "was" : "were"} created by hand, not by
            the automation, so {skipped === 1 ? "it has" : "they have"} no
            auto-created state to go back to and will be left untouched.
          </p>
        )}
        {failed ? (
          <p className="text-[12px] leading-relaxed text-amber-300">
            Could not recompute right now. Nothing has been changed.
          </p>
        ) : !plans ? (
          <p className="text-[12px] text-[var(--muted)]">
            Recomputing from the linked records…
          </p>
        ) : (
          <>
            {usable.length > 0 && (
              <p className="mb-4 text-[11px] leading-relaxed text-[var(--muted)]">
                This will discard your changes to{" "}
                {rebuilt === 1 ? "this transfer" : `these ${rebuilt} transfers`}{" "}
                and rebuild {rebuilt === 1 ? "it" : "them"} from the linked
                records as they stand now. Platform, destination, money status,
                any deploy link and the notes all go back to what the automation
                writes.
              </p>
            )}
            {blocked.map((p, i) => (
              <p
                key={`blocked-${i}`}
                className="mb-3 text-[12px] leading-relaxed text-amber-300"
              >
                {p.error ?? "One selected transfer could not be recomputed."}
              </p>
            ))}
            <div className="space-y-3">
              {usable.flatMap((plan) =>
                plan.next.map((next, i) => {
                  const before = plan.current[i];
                  return (
                    <div
                      key={next.id}
                      className="rounded-md border border-[var(--border)] bg-[var(--surface-2)]/30 px-3 py-2.5"
                    >
                      <p className="text-[10px] font-medium uppercase tracking-wider text-[var(--muted)]">
                        Now
                      </p>
                      <p className="text-[12px] text-[var(--muted)] line-through">
                        {before ? describe(before) : "— (new record)"}
                      </p>
                      <p className="mt-2 text-[10px] font-medium uppercase tracking-wider text-[var(--muted)]">
                        After revert
                      </p>
                      <p className="text-[13px] font-medium text-[var(--foreground)]">
                        {describe(next)}
                      </p>
                      <p className="mt-1 text-[11px] text-[var(--muted)]">
                        dated {formatDateDDMMYYYY(next.date)}
                      </p>
                    </div>
                  );
                }),
              )}
            </div>
          </>
        )}
      </Section>
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
          disabled={usable.length === 0}
          onClick={() => {
            // Applied one group at a time; each write re-reads storage, so the
            // groups cannot clobber one another.
            for (const plan of usable) applyRevertToAuto(plan);
            onApplied();
          }}
          className="inline-flex h-9 items-center justify-center rounded-md bg-[var(--accent-solid)] px-4 text-sm font-medium text-white shadow-sm transition-colors hover:bg-[var(--accent-solid)]/90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Continue
        </button>
      </div>
    </ModalShell>
  );
}


function ExpenseFormModal({
  title,
  submitLabel,
  initial,
  onCancel,
  onSubmit,
  onDelete,
}: {
  title: string;
  submitLabel: string;
  initial: ExpenseFormState;
  onCancel: () => void;
  onSubmit: (form: ExpenseFormState) => void;
  onDelete?: () => void;
}) {
  const [form, setForm] = useState<ExpenseFormState>(initial);

  const set = <K extends keyof ExpenseFormState>(
    key: K,
    value: ExpenseFormState[K],
  ) => setForm((prev) => ({ ...prev, [key]: value }));

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    onSubmit(form);
  };

  return (
    <ModalShell title={title} onCancel={onCancel}>
      <form onSubmit={submit} className="divide-y divide-[var(--border)]">
        <Section title="Expense Details">
          <p className="mb-4 text-[11px] text-[var(--muted)]">
            Money that has left the business (rent, subscriptions, etc.). No
            position or chain needed — it draws from one overall pool and
            subtracts from Overall P&amp;L.
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Date" htmlFor="e_date">
              <input
                id="e_date"
                type="date"
                required
                className={inputClass}
                style={{ colorScheme: "dark" }}
                value={form.date}
                onChange={(e) => set("date", e.target.value)}
              />
            </Field>
            <Field label="Amount (USD)" htmlFor="e_amount">
              <input
                id="e_amount"
                type="number"
                step="any"
                required
                className={inputClass}
                placeholder="0.00"
                value={form.amount}
                onChange={(e) => set("amount", e.target.value)}
              />
            </Field>
          </div>
          <div className="mt-4">
            <Field
              label="Notes (reason)"
              htmlFor="e_notes"
              hint="What the expense was for."
            >
              <textarea
                id="e_notes"
                rows={2}
                className={inputClass}
                value={form.notes}
                onChange={(e) => set("notes", e.target.value.toUpperCase())}
              />
            </Field>
          </div>
        </Section>
        <FormActions
          onCancel={onCancel}
          submitLabel={submitLabel}
          onDelete={onDelete}
        />
      </form>
    </ModalShell>
  );
}

function MoneyStatusToggle({
  value,
  onChange,
}: {
  value: MoneyStatus;
  onChange: (next: MoneyStatus) => void;
}) {
  const options: Array<{ value: MoneyStatus; label: string }> = [
    { value: "redeployed", label: "Redeployed" },
    { value: "expense", label: "Expense" },
  ];
  return (
    <div
      role="radiogroup"
      aria-label="Money status"
      className="inline-flex overflow-hidden rounded-md border border-[var(--border-strong)]"
    >
      {options.map((opt, idx) => {
        const selected = value === opt.value;
        const selectedClass =
          opt.value === "expense"
            ? "bg-rose-600 text-white"
            : "bg-[var(--accent-solid)] text-white";
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(opt.value)}
            className={`h-9 px-3 text-xs font-medium transition-colors ${
              idx > 0 ? "border-l border-[var(--border-strong)]" : ""
            } ${
              selected
                ? selectedClass
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

function MoneyStatusPill({ status }: { status: Transfer["moneyStatus"] }) {
  if (status === "expense") {
    return (
      <span className="inline-flex items-center rounded-full border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-rose-300">
        Expense
      </span>
    );
  }
  // Unset = an Undeployed Tokens transfer sitting idle (not yet redeployed or
  // spent). "Needs Review" was retired, so fees/upside are always redeployed.
  if (status === undefined) {
    return (
      <span className="inline-flex items-center rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-sky-300">
        Idle
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full border border-[var(--border-strong)] bg-[var(--surface-2)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-[var(--muted)]">
      Redeployed
    </span>
  );
}

interface TypeSegmentedToggleProps {
  value: TransferType;
  onChange: (next: TransferType) => void;
}

function TypeSegmentedToggle({ value, onChange }: TypeSegmentedToggleProps) {
  const options: Array<{ value: TransferType; label: string }> = [
    { value: "fees", label: "Fees" },
    { value: "undeployed", label: "Undeployed Tokens" },
    { value: "outOfRangeUpside", label: "Out of Range Upside" },
  ];
  return (
    <div
      role="radiogroup"
      aria-label="Transfer type"
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
            className={`h-9 px-3 text-xs font-medium transition-colors ${
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
      <path d="M5 7l7-4 7 4v6c0 4-3 7-7 8-4-1-7-4-7-8V7z" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9 12l2 2 4-4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const backfillDateFmt = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
});

function formatBackfillDate(iso: string): string {
  const d = new Date((iso ?? "").slice(0, 10));
  return Number.isNaN(d.getTime()) ? iso : backfillDateFmt.format(d);
}

// One-line preview of what a claim's auto transfer(s) will look like, without
// fetching prices (the dual-token split resolves on confirm).
function claimPreview(claim: FeeClaim): string {
  const built = buildClaimTransfers(claim);
  if (built.needsPrices) {
    return `2 transfers · ${built.dualSymbols.join(" + ")} split by price on ${formatBackfillDate(
      claim.date,
    )}`;
  }
  const t = built.transfers[0];
  return t ? `${formatUsd(t.amount)} · ${t.token}` : "—";
}

interface BackfillReviewProps {
  claims: FeeClaim[];
  positions: Position[];
  transfers: Transfer[];
  onDone: () => void;
}

// Safe, reviewable backfill of historical fee claims and above-range closes.
// Never writes without an explicit confirmation, and only lists records that
// have no matching transfer yet (dedup by sourceClaimId/sourceCloseId, or the
// position+day+type heuristic), so re-running cannot create duplicates.
function BackfillReview({
  claims,
  positions,
  transfers,
  onDone,
}: BackfillReviewProps) {
  const [excludedClaims, setExcludedClaims] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const eligibleClaims = useMemo(
    () => eligibleClaimsForBackfill(claims, transfers),
    [claims, transfers],
  );
  const eligibleCloses = useMemo(
    () => eligibleClosesForBackfill(positions, transfers),
    [positions, transfers],
  );

  if (eligibleClaims.length === 0 && eligibleCloses.length === 0) return null;

  const toInclude = eligibleClaims.filter((c) => !excludedClaims.has(c.id));

  const toggleClaim = (id: string) =>
    setExcludedClaims((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const runClaimBackfill = async () => {
    setBusy(true);
    for (const c of toInclude) {
      // reconcile keys off sourceClaimId; these are eligible (none), so it
      // creates. Sequential so the dual-token price fetches don't stampede.
      await reconcileClaimTransfers(c);
    }
    setBusy(false);
    setExcludedClaims(new Set());
    onDone();
  };

  const confirmClose = (p: Position) => {
    createUpsideTransfer(p);
    onDone();
  };

  return (
    <div className="space-y-4 rounded-lg border border-amber-500/30 bg-amber-500/5 p-5">
      <div>
        <h2 className="text-sm font-semibold tracking-tight text-amber-200">
          Backfill transfers from history
        </h2>
        <p className="mt-1 text-[11px] text-[var(--muted)]">
          Records with no matching transfer yet. Nothing is created until you
          confirm — anything already covered by a transfer is hidden, so this
          can&apos;t make duplicates.
        </p>
      </div>

      {eligibleClaims.length > 0 && (
        <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">
              Fee claims ({eligibleClaims.length})
            </h3>
            <button
              type="button"
              disabled={busy || toInclude.length === 0}
              onClick={() => void runClaimBackfill()}
              className="inline-flex h-8 items-center justify-center rounded-md bg-[var(--accent-solid)] px-3 text-xs font-medium text-white transition-colors hover:bg-[var(--accent-solid)]/90 disabled:opacity-50"
            >
              {busy
                ? "Creating…"
                : `Create ${toInclude.length} transfer${toInclude.length === 1 ? "" : "s"}`}
            </button>
          </div>
          <ul className="mt-3 divide-y divide-[var(--border)]">
            {eligibleClaims.map((c) => (
              <li
                key={c.id}
                className="flex items-center justify-between gap-3 py-2 text-sm"
              >
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={!excludedClaims.has(c.id)}
                    onChange={() => toggleClaim(c.id)}
                    className="h-3.5 w-3.5 accent-[var(--accent)]"
                  />
                  <span className="text-[var(--foreground)]">
                    {c.pair || "—"}
                  </span>
                  <span className="text-[11px] text-[var(--muted)]">
                    {formatBackfillDate(c.date)}
                  </span>
                </label>
                <span className="text-[11px] tabular-nums text-[var(--muted)]">
                  {claimPreview(c)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {eligibleCloses.length > 0 && (
        <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-4">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">
            Above-range closes to confirm ({eligibleCloses.length})
          </h3>
          <p className="mt-1 text-[11px] text-[var(--muted)]">
            Exit side can&apos;t be detected from stored data — confirm only the
            positions you closed <em>above</em> range. Their scalp is set aside
            as an Out-of-Range-Upside transfer.
          </p>
          <ul className="mt-3 divide-y divide-[var(--border)]">
            {eligibleCloses.map((p) => (
              <li
                key={p.id}
                className="flex items-center justify-between gap-3 py-2 text-sm"
              >
                <span>
                  <span className="text-[var(--foreground)]">{p.pair}</span>{" "}
                  <span className="text-[11px] text-[var(--muted)]">
                    closed {formatBackfillDate(p.exitDatetime ?? "")} · scalp{" "}
                    {formatUsd(p.scalp ?? 0)}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => confirmClose(p)}
                  className="inline-flex h-8 items-center justify-center rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)] px-3 text-xs font-medium text-[var(--foreground)] transition-colors hover:border-[var(--accent)]"
                >
                  Yes, above range → set aside {formatUsd(p.scalp ?? 0)}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
