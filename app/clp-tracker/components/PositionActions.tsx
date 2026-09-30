"use client";

import { type FormEvent, useState } from "react";
import {
  getClaims,
  getPoolPnL,
  getPositions,
  getPositionPrices,
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
  calcTotalFees,
  getEffectiveClaimed,
  getEffectiveTotalFees,
} from "../lib/calculations";
import { ClaimFormModal, ModalShell, persistNewClaim } from "./ClaimFormModal";
import type { FeeClaim, Position } from "../lib/types";
import {
  Field,
  FormActions,
  Section,
  inputClass,
} from "./PositionFormParts";
import {
  EMPTY_FORM,
  buildRecords,
  formatUsd,
  linkedRecords,
  newId,
  nowDatetimeLocal,
  num,
  positionToForm,
  type BuiltRecords,
  type PositionFormState,
} from "../lib/positionFormUtils";
import { PositionFormModal } from "./PositionFormModal";
import { ClosePositionModal } from "./ClosePositionModal";

export type ModalState =
  | { kind: "none" }
  | { kind: "add" }
  | { kind: "edit"; position: Position }
  | { kind: "update"; position: Position }
  | { kind: "close"; position: Position }
  | { kind: "claim"; position: Position }
  | { kind: "delete"; position: Position };


// Permanent cascade-delete confirmation (Part 3). Shows the exact record counts
// that will be destroyed and requires the user to type the pair to confirm —
// there is no undo, so a single mis-click cannot wipe out financial history.
export function DeletePositionModal({
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


export interface UpdatePositionModalProps {
  position: Position;
  derivedClaimed: number;
  onCancel: () => void;
  onSubmit: (next: {
    currentBalance: number;
    newFees: number;
  }) => void;
}


export function UpdatePositionModal({
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

// The ONE implementation of every position action — Add, Edit, Update, Claim,
// Close, Delete — shared by the Positions list and the position detail page.
// Moved here verbatim from PositionsPage so both entry points run identical
// save/close/delete logic and the identical modals; the only change is that
// "refresh the page's data" and "close the modal" arrive as callbacks.
export function PositionActionHost({
  modal,
  positions,
  claims,
  onChanged,
  onDismiss,
  onDeleted,
}: {
  modal: ModalState;
  positions: Position[];
  claims: FeeClaim[];
  onChanged: () => void;
  onDismiss: () => void;
  // Called after a delete has been written — the detail page uses it to leave
  // a page whose position no longer exists.
  onDeleted?: (position: Position) => void;
}) {
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
    onChanged();
    onDismiss();
  };

  const handleAdd = (form: PositionFormState) => {
    persistFull(buildRecords(newId(), form, null), "add");
  };

  // `base` is read FRESH from storage, never taken from the object the caller
  // passed in. For an active position that object is withLiveValues' display
  // copy, whose currentBalance is the live market value — and buildRecords
  // falls back to base.currentBalance, so using it silently persisted the live
  // price on an edit that only touched Notes. withLiveValues overrides nothing
  // but currentBalance, so every other fallback field reads the same either way.
  const handleEdit = (target: Position, form: PositionFormState) => {
    const stored = getPositions().find((p) => p.id === target.id) ?? target;
    persistFull(buildRecords(target.id, form, stored), "edit");
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
    onChanged();
    onDismiss();
  };

  // Shared claim save path (persistNewClaim) — identical to the Fee Claims
  // page so both entry points update position totals the same way.
  const handleClaimSubmit = (claim: FeeClaim) => {
    persistNewClaim(claim);
    onChanged();
    onDismiss();
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

    onChanged();
    onDismiss();
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
    onChanged();
    onDismiss();
    onDeleted?.(target);
  };

  return (
    <>
      {modal.kind === "add" && (
        <PositionFormModal
          title="Add Position"
          submitLabel="Add Position"
          initial={{ ...EMPTY_FORM, entryDatetime: nowDatetimeLocal() }}
          onCancel={onDismiss}
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
          onCancel={onDismiss}
          onSubmit={(form) => handleEdit(modal.position, form)}
        />
      )}
      {modal.kind === "update" && (
        <UpdatePositionModal
          position={modal.position}
          derivedClaimed={getEffectiveClaimed(modal.position, claims)}
          onCancel={onDismiss}
          onSubmit={(next) => handleUpdate(modal.position, next)}
        />
      )}
      {modal.kind === "claim" && (
        <ClaimFormModal
          mode="add"
          positions={positions}
          lockedPositionId={modal.position.id}
          onCancel={onDismiss}
          onSubmit={handleClaimSubmit}
        />
      )}
      {modal.kind === "close" && (
        <ClosePositionModal
          position={modal.position}
          onCancel={onDismiss}
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
          onCancel={onDismiss}
          onConfirm={() => handleDeletePosition(modal.position)}
        />
      )}
    </>
  );
}
