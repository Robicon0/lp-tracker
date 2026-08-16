import { claimStableFace, isStableSymbol } from "./calculations";
import {
  getTransfers,
  restoreTransfer,
  saveTransfers,
  softDeleteTransfer,
} from "./storage";
import type { FeeClaim, Position, Transfer } from "./types";

// Notes stamped on auto-created transfers. Also a tell-tale: an auto transfer
// still carrying its stamp and no other user edits is "untouched" and safe to
// rebuild; anything else the user has claimed as their own.
export const AUTO_CLAIM_NOTE = "AUTO-CREATED FROM FEE CLAIM";
export const AUTO_CLOSE_NOTE = "AUTO-CREATED FROM ABOVE-RANGE CLOSE";

function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `id_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function dayOf(date: string): string {
  return (date ?? "").slice(0, 10);
}

// Local calendar day (YYYY-MM-DD) of a full datetime. A closed position stores
// exitDatetime as a UTC ISO string, but the Positions page shows it in local
// time (formatDateTime24). Slicing the UTC portion would put the transfer on a
// different day than the position for any close whose local and UTC dates
// differ (e.g. a morning close in UTC+10). Deriving the local day keeps the
// two in agreement (Invariant #2 timezone note). A bare "YYYY-MM-DD" (the
// manual/claim date format, no time) round-trips unchanged.
function localDayOf(datetime: string): string {
  const s = datetime ?? "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s.slice(0, 10);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// A transfer the automation made and the user has not since edited. platform,
// destination and moneyStatus are all left in their auto state (blank / blank
// / unset), and the auto note is intact. If any of those changed, the user has
// taken ownership of the row and we must not overwrite it.
export function isUntouchedAuto(t: Transfer): boolean {
  const stamp = t.sourceClaimId ? AUTO_CLAIM_NOTE : AUTO_CLOSE_NOTE;
  // moneyStatus is now written "redeployed" at creation (the "Needs Review"
  // state was retired); undefined is still accepted for legacy auto rows made
  // before that change. A deploy-link means the user took ownership — never
  // rebuild over it.
  return (
    t.platform === "" &&
    t.destination === "" &&
    (t.moneyStatus === undefined || t.moneyStatus === "redeployed") &&
    t.deployedToPositionId === undefined &&
    t.notes === stamp
  );
}

interface ClaimSide {
  symbol: string;
  amount: number;
}

function rewardSides(claim: FeeClaim): ClaimSide[] {
  return [
    { symbol: claim.token1Symbol.trim().toUpperCase(), amount: claim.token1Amount },
    { symbol: claim.token2Symbol.trim().toUpperCase(), amount: claim.token2Amount },
  ].filter((s) => s.symbol !== "" && Number.isFinite(s.amount) && s.amount > 0);
}

// The non-stable reward legs of a claim, i.e. the price-exposed tokens. Two of
// these (e.g. ETH + BTC) is the dual-token case that needs a historical split.
export function nonStableRewardSymbols(claim: FeeClaim): string[] {
  return rewardSides(claim)
    .filter((s) => !isStableSymbol(s.symbol))
    .map((s) => s.symbol);
}

function autoClaimTransfer(
  claim: FeeClaim,
  token: string,
  amount: number,
): Transfer {
  return {
    id: newId(),
    positionId: claim.positionId,
    date: dayOf(claim.date),
    token,
    amount,
    platform: "",
    destination: "",
    transferType: "fees",
    // Redeployed by default (the "Needs Review" state was retired): fee money
    // stays in the business until the user marks it deployed or an expense.
    moneyStatus: "redeployed",
    sourceClaimId: claim.id,
    notes: AUTO_CLAIM_NOTE,
  };
}

export interface BuiltClaimTransfers {
  transfers: Transfer[];
  // True when the claim has two non-stable legs but no prices were supplied,
  // so the caller must fetch historical prices and build again.
  needsPrices: boolean;
  dualSymbols: string[];
}

// Transfers a fee claim should produce. One record for a single reward leg
// (± a stablecoin side); two records split by real historical value for a
// two-non-stable-token claim. Amounts are the claim's USD value (stableAmount),
// so they sum back to it exactly.
export function buildClaimTransfers(
  claim: FeeClaim,
  prices?: Record<string, number>,
): BuiltClaimTransfers {
  const usd = Number.isFinite(claim.stableAmount ?? NaN)
    ? (claim.stableAmount as number)
    : 0;
  const sides = rewardSides(claim);
  const nonStable = sides.filter((s) => !isStableSymbol(s.symbol));

  // Two price-exposed legs: split the USD value by each leg's real historical
  // worth on the claim date (amount x price), not by raw token count.
  if (nonStable.length >= 2) {
    const dualSymbols = nonStable.slice(0, 2).map((s) => s.symbol);
    if (!prices) {
      return { transfers: [], needsPrices: true, dualSymbols };
    }
    const [a, b] = nonStable;
    const va = a.amount * (prices[a.symbol] ?? NaN);
    const vb = b.amount * (prices[b.symbol] ?? NaN);
    if (Number.isFinite(va) && Number.isFinite(vb) && va + vb > 0) {
      const amountA = (usd * va) / (va + vb);
      // Second leg is the remainder so the two always sum to usd exactly.
      const amountB = usd - amountA;
      return {
        transfers: [
          autoClaimTransfer(claim, a.symbol, amountA),
          autoClaimTransfer(claim, b.symbol, amountB),
        ],
        needsPrices: false,
        dualSymbols,
      };
    }
    // Prices came back unusable: fall back to a single combined record rather
    // than inventing a split, so the money still reconciles and is reviewable.
    return {
      transfers: [autoClaimTransfer(claim, a.symbol, usd)],
      needsPrices: false,
      dualSymbols,
    };
  }

  // Single reward leg (or an all-stable claim): one record. Prefer the
  // non-stable symbol; else the cashed-out stable symbol; else whatever leg.
  const token =
    nonStable[0]?.symbol ??
    (claim.stableSymbol ?? "").trim().toUpperCase() ??
    sides[0]?.symbol ??
    "";
  return {
    transfers: [autoClaimTransfer(claim, token || "—", usd)],
    needsPrices: false,
    dualSymbols: [],
  };
}

async function fetchClaimDayPrices(
  claim: FeeClaim,
  symbols: string[],
): Promise<Record<string, number> | null> {
  const ts = Math.floor(
    new Date(`${dayOf(claim.date)}T12:00:00Z`).getTime() / 1000,
  );
  if (!Number.isFinite(ts) || ts <= 0) return null;
  try {
    const res = await fetch(
      `/clp-tracker/api/prices/historical?symbols=${encodeURIComponent(
        symbols.join(","),
      )}&timestamp=${ts}`,
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { prices?: Record<string, number> };
    return data.prices ?? {};
  } catch {
    return null;
  }
}

export type ReconcileResult =
  | { status: "created"; count: number }
  | { status: "updated"; count: number }
  | { status: "skipped-touched" }
  | { status: "skipped-existing" }
  | { status: "noop" };

// Creates (or, for an untouched auto row, rebuilds) the transfers a claim
// should have. If the user has edited the auto transfer, it is left exactly as
// they left it and the claim is reported as skipped so nothing silently
// diverges. Safe to call on both new and edited claims — it keys strictly off
// sourceClaimId, never the day+position heuristic.
export async function reconcileClaimTransfers(
  claim: FeeClaim,
): Promise<ReconcileResult> {
  const all = getTransfers();
  const own = all.filter((t) => t.sourceClaimId === claim.id);

  if (own.length > 0) {
    // The claim already has an auto transfer. If the user has edited it, leave
    // it exactly as they left it and report skipped so nothing diverges.
    if (!own.every(isUntouchedAuto)) return { status: "skipped-touched" };
  } else if (
    // No auto transfer yet, but a MANUAL fee transfer already covers this
    // claim's position+day — don't duplicate a hand-logged row. Restricted to
    // manual transfers (no sourceClaimId): auto transfers are deduped
    // precisely by sourceClaimId, so an auto row for a *different* claim on the
    // same position+day must NOT block this one — that false match dropped
    // legitimate same-day claims during backfill.
    all.some(
      (t) =>
        t.transferType === "fees" &&
        t.sourceClaimId === undefined &&
        t.positionId === claim.positionId &&
        dayOf(t.date) === dayOf(claim.date),
    )
  ) {
    return { status: "skipped-existing" };
  }

  const existing = own;
  let built = buildClaimTransfers(claim);
  if (built.needsPrices) {
    const prices = await fetchClaimDayPrices(claim, built.dualSymbols);
    built = buildClaimTransfers(claim, prices ?? {});
  }
  if (built.transfers.length === 0) return { status: "noop" };

  const withoutOld = all.filter((t) => t.sourceClaimId !== claim.id);
  saveTransfers([...withoutOld, ...built.transfers]);
  return {
    status: existing.length > 0 ? "updated" : "created",
    count: built.transfers.length,
  };
}

// ── Above-range close → Out-of-Range-Upside transfer ────────────────────────

export function buildUpsideTransfer(position: Position): Transfer | null {
  const scalp = position.scalp ?? 0;
  if (!Number.isFinite(scalp) || scalp <= 0) return null;
  return {
    id: newId(),
    positionId: position.id,
    date: localDayOf(position.exitDatetime ?? ""),
    token: position.token2Symbol.trim().toUpperCase() || position.pair,
    amount: scalp,
    platform: "",
    destination: "",
    transferType: "outOfRangeUpside",
    // Redeployed by default (Needs Review retired).
    moneyStatus: "redeployed",
    sourceCloseId: position.id,
    notes: AUTO_CLOSE_NOTE,
  };
}

// Idempotent: creates the upside transfer only if this close does not already
// have one (by sourceCloseId). Returns whether it created a record.
export function createUpsideTransfer(position: Position): boolean {
  const all = getTransfers();
  if (all.some((t) => t.sourceCloseId === position.id)) return false;
  const transfer = buildUpsideTransfer(position);
  if (!transfer) return false;
  saveTransfers([...all, transfer]);
  return true;
}

// ── Revert to auto-created ──────────────────────────────────────────────────

// Only a transfer the automation made has an "auto-created" state to go back
// to. Manually-logged rows (Undeployed Tokens, hand-entered fees, expenses)
// carry neither source id and must never offer the action.
export function isAutoCreated(t: Transfer): boolean {
  return t.sourceClaimId !== undefined || t.sourceCloseId !== undefined;
}

export interface AutoRevertPlan {
  source: "claim" | "close";
  // The stored records that will be replaced — the WHOLE source group, because
  // a dual-token claim produces two legs whose amounts are computed against
  // each other. Reverting one leg alone could not reproduce the split.
  current: Transfer[];
  // What the automation produces from the linked claim/close as it stands now.
  // Ids are carried over from `current` in order, so a revert edits records in
  // place instead of minting new ones.
  next: Transfer[];
  // Set when the plan cannot be built; `next` is empty and nothing may apply.
  error?: string;
}

function alignIds(built: Transfer[], existing: Transfer[]): Transfer[] {
  return built.map((t, i) =>
    existing[i] ? { ...t, id: existing[i].id } : t,
  );
}

// Recomputes what the automation WOULD produce right now from the linked
// claim/close's current stored data — deliberately a recomputation, not a
// stored snapshot, so it works on every auto transfer ever created with no
// migration. Runs the same buildClaimTransfers / buildUpsideTransfer the
// automation itself uses (including the dual-token historical price split), so
// there is no second copy of this logic to drift.
export async function planRevertToAuto(
  transfer: Transfer,
  claims: FeeClaim[],
  positions: Position[],
): Promise<AutoRevertPlan> {
  const all = getTransfers();

  if (transfer.sourceClaimId !== undefined) {
    const current = all.filter((t) => t.sourceClaimId === transfer.sourceClaimId);
    const claim = claims.find((c) => c.id === transfer.sourceClaimId);
    if (!claim) {
      return {
        source: "claim",
        current,
        next: [],
        error:
          "The fee claim this transfer was created from no longer exists, so there is nothing to recompute from.",
      };
    }
    let built = buildClaimTransfers(claim);
    if (built.needsPrices) {
      const prices = await fetchClaimDayPrices(claim, built.dualSymbols);
      built = buildClaimTransfers(claim, prices ?? {});
    }
    if (built.transfers.length === 0) {
      return {
        source: "claim",
        current,
        next: [],
        error: "This claim no longer produces a transfer.",
      };
    }
    return { source: "claim", current, next: alignIds(built.transfers, current) };
  }

  const current = all.filter((t) => t.sourceCloseId === transfer.sourceCloseId);
  const position = positions.find((p) => p.id === transfer.sourceCloseId);
  if (!position) {
    return {
      source: "close",
      current,
      next: [],
      error:
        "The closed position this transfer was created from no longer exists, so there is nothing to recompute from.",
    };
  }
  const built = buildUpsideTransfer(position);
  if (!built) {
    return {
      source: "close",
      current,
      next: [],
      error:
        "This position's Scalp is no longer positive, so the automation would not create an upside transfer for it now.",
    };
  }
  return { source: "close", current, next: alignIds([built], current) };
}

// Applies a plan: the source group is replaced wholesale by the rebuilt set.
// Every manual edit on those records — platform, destination, money status,
// deploy-link, notes, amount — is discarded, which is the point of the action.
export function applyRevertToAuto(plan: AutoRevertPlan): void {
  if (plan.next.length === 0) return;
  const replaced = new Set(plan.current.map((t) => t.id));
  saveTransfers([
    ...getTransfers().filter((t) => !replaced.has(t.id)),
    ...plan.next,
  ]);
}

// ── Claim deletion cleanup ──────────────────────────────────────────────────

export interface ClaimTransferCleanup {
  // Auto rows the user never touched — removed with the claim that made them.
  softDeleted: string[];
  // Rows the user has since sent/deployed/expensed — kept, but no longer
  // claiming a link to a record that no longer exists.
  detached: string[];
}

// Called when a fee claim is deleted. An auto transfer only exists because of
// its claim, so an UNTOUCHED one goes with it — soft-deleted, so it lands in
// Recently Deleted and restores exactly like any other transfer, never hard
// erased. A TOUCHED row is real money-movement history the user has since
// placed somewhere; deleting it would erase a record of where money actually
// went, so it stays and only loses its sourceClaimId. Dropping that id also
// stops planRevertToAuto offering a revert that can never resolve, and lets the
// day+position heuristic treat the row as the manual record it has become.
export function cleanupClaimTransfers(claimId: string): ClaimTransferCleanup {
  const own = getTransfers().filter((t) => t.sourceClaimId === claimId);
  const softDeleted: string[] = [];
  const detached: Transfer[] = [];
  for (const t of own) {
    if (isUntouchedAuto(t)) softDeleted.push(t.id);
    else detached.push(t);
  }
  if (detached.length > 0) {
    const byId = new Map(detached.map((t) => [t.id, t]));
    const now = new Date().toISOString();
    saveTransfers(
      getTransfers().map((t) => {
        if (!byId.has(t.id)) return t;
        const { sourceClaimId: _s, ...rest } = t;
        void _s;
        // Dropping the id alone made this unlink invisible: the row simply sat
        // there afterwards looking like any hand-logged transfer. The stamp
        // keeps it reviewable (Data Health) until the user edits it.
        return { ...rest, claimDeletedAt: now };
      }),
    );
  }
  // After the detach write, so the map above cannot resurrect a deleted row.
  for (const id of softDeleted) softDeleteTransfer(id);
  return { softDeleted, detached: detached.map((t) => t.id) };
}

// ── Split a transfer into its stable and token halves ───────────────────────

// Stamped on both pieces. Deliberately does NOT contain AUTO_CLAIM_NOTE:
// findOrphanedByClaimDeletion (15e8bf1) flags a fees transfer that carries that
// exact phrase with no sourceClaimId, which is precisely the shape a split
// piece has — inheriting the original's auto note would false-flag every split
// piece as "your claim was deleted". This is the trap in this feature.
export const SPLIT_NOTE = "SPLIT FROM A SINGLE TRANSFER";

export interface TransferSplitPlan {
  // Where the stable figure came from: the linked claim's stablecoin legs, or
  // the user typing it because there is no live claim to read.
  source: "claim" | "manual";
  stableAmount: number;
  tokenAmount: number;
  claim: FeeClaim | null;
  // Set when the plan cannot be built; the UI explains and blocks.
  error?: string;
}

// Proposes the split. With a live sourceClaimId the stable side is
// claimStableFace(claim) — the SAME function Overall P&L's per-leg rule uses,
// not a second reading of "which legs are stablecoin" — and the remainder is
// the token side. Without one there is nothing to read (a Transfer stores a
// single amount and a single token; only claims carry the leg breakdown), so
// the caller supplies the stable figure.
export function planTransferSplit(
  transfer: Transfer,
  claims: FeeClaim[],
  manualStable?: number,
): TransferSplitPlan {
  const total = toFiniteAmount(transfer.amount);
  const claim =
    transfer.sourceClaimId !== undefined
      ? claims.find((c) => c.id === transfer.sourceClaimId) ?? null
      : null;

  const raw = claim !== null ? claimStableFace(claim) : manualStable;
  const source: "claim" | "manual" = claim !== null ? "claim" : "manual";

  if (raw === undefined || !Number.isFinite(raw)) {
    return {
      source,
      stableAmount: 0,
      tokenAmount: total,
      claim,
      error: "Enter how much of this transfer was already in stablecoin.",
    };
  }
  const stableAmount = Math.max(0, raw);
  if (stableAmount > total) {
    return {
      source,
      stableAmount,
      tokenAmount: 0,
      claim,
      error:
        "The stablecoin portion cannot be larger than the transfer itself.",
    };
  }
  if (stableAmount <= 0 || stableAmount >= total) {
    return {
      source,
      stableAmount,
      tokenAmount: total - stableAmount,
      claim,
      error:
        "This transfer is entirely one side, so there is nothing to split out.",
    };
  }
  // The remainder, never a second rounding of the same number — the two pieces
  // sum to the original exactly, so no balance anywhere can shift.
  return {
    source,
    stableAmount,
    tokenAmount: total - stableAmount,
    claim,
    error: undefined,
  };
}

function toFiniteAmount(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

// Writes the split: two new records, then the original soft-deleted (Recently
// Deleted, restorable — the same convention as every other delete here, and the
// escape hatch if a split was a mistake).
//
// NEITHER PIECE CARRIES sourceClaimId, and that is load-bearing rather than
// tidiness. findDriftedClaimTransfers compares a linked transfer's amount to
// its claim's FULL stableAmount, so a piece keeping the link would read as
// permanently short and false-flag forever; cleanupClaimTransfers and
// reconcileClaimTransfers likewise assume one claim maps to one transfer.
// Clearing the id is what correctly excludes the pieces from all of it. The
// claim id survives as splitFromClaimId, which nothing but the UI reads.
export function applyTransferSplit(
  transfer: Transfer,
  plan: TransferSplitPlan,
): Transfer[] {
  if (plan.error !== undefined) return [];
  const base = {
    positionId: transfer.positionId,
    date: transfer.date,
    platform: transfer.platform,
    destination: transfer.destination,
    transferType: transfer.transferType,
    // The original's status carries over to both; each is independently
    // editable from here, which is the whole point of splitting.
    moneyStatus: transfer.moneyStatus,
    ...(transfer.sourceClaimId !== undefined
      ? { splitFromClaimId: transfer.sourceClaimId }
      : {}),
    // The ORIGINAL's own id, reused as the group key rather than minting a new
    // one: it already uniquely identifies this split, and it is exactly what
    // Undo needs to restore from Recently Deleted.
    splitOriginalId: transfer.id,
  };
  const pieces: Transfer[] = [
    {
      ...base,
      id: newId(),
      token: plan.claim?.token1Symbol
        ? stableSymbolOf(plan.claim) || transfer.token
        : transfer.token,
      amount: plan.stableAmount,
      splitPart: "stable",
      notes: SPLIT_NOTE,
    },
    {
      ...base,
      id: newId(),
      token: transfer.token,
      amount: plan.tokenAmount,
      splitPart: "token",
      notes: SPLIT_NOTE,
    },
  ];
  saveTransfers([...getTransfers(), ...pieces]);
  // After the write, so the save above cannot resurrect the original.
  softDeleteTransfer(transfer.id);
  return pieces;
}

// The stablecoin leg's symbol, for labelling the stable piece. Falls back to
// the original transfer's token when the claim has no identifiable stable leg.
function stableSymbolOf(claim: FeeClaim): string {
  const t1 = claim.token1Symbol.trim().toUpperCase();
  const t2 = claim.token2Symbol.trim().toUpperCase();
  if (isStableSymbol(t1)) return t1;
  if (isStableSymbol(t2)) return t2;
  return "";
}

// ── Bulk split ──────────────────────────────────────────────────────────────

export interface BulkSplitPlan {
  // Rows that can be split without asking anything: they still point at a live
  // claim, so the stable/token figures are readable.
  splittable: { transfer: Transfer; plan: TransferSplitPlan }[];
  // Rows left alone, each with the reason — a batch is never blocked by one
  // unsplittable row.
  skipped: { transfer: Transfer; reason: string }[];
}

// Bulk is deliberately CLAIM-ONLY: the manual path needs a figure typed per
// transfer, which is not a batch operation. Anything else — no claim link, a
// claim that no longer exists, an all-one-side amount, or a piece that is
// already the result of a split — is reported rather than guessed at.
export function planBulkSplit(
  transfers: Transfer[],
  claims: FeeClaim[],
): BulkSplitPlan {
  const out: BulkSplitPlan = { splittable: [], skipped: [] };
  for (const t of transfers) {
    if (t.splitPart !== undefined) {
      out.skipped.push({ transfer: t, reason: "already a split piece" });
      continue;
    }
    if (t.sourceClaimId === undefined) {
      out.skipped.push({ transfer: t, reason: "no linked claim" });
      continue;
    }
    const plan = planTransferSplit(t, claims);
    if (plan.claim === null) {
      out.skipped.push({ transfer: t, reason: "linked claim no longer exists" });
      continue;
    }
    if (plan.error !== undefined) {
      out.skipped.push({ transfer: t, reason: "nothing to split out" });
      continue;
    }
    out.splittable.push({ transfer: t, plan });
  }
  return out;
}

export function applyBulkSplit(plan: BulkSplitPlan): number {
  let count = 0;
  // One at a time through the SAME writer the single split uses, so the write
  // order (pieces first, then soft-delete) has one implementation.
  for (const { transfer, plan: p } of plan.splittable) {
    if (applyTransferSplit(transfer, p).length > 0) count += 1;
  }
  return count;
}

// ── Undo a split ────────────────────────────────────────────────────────────

export interface UndoSplitPlan {
  originalId: string;
  pieces: Transfer[];
  original: Transfer | null;
  // True when the pieces no longer add up to the original, i.e. at least one
  // was edited after the split. Undo discards that edit, so the UI confirms.
  edited: boolean;
  piecesTotal: number;
  originalAmount: number;
  // True when the original was INFERRED rather than pointed at: a piece created
  // before splitOriginalId existed has no pointer, so the sibling and original
  // are matched on shape. The match can only ever be a best guess, so the UI
  // confirms what it found before restoring anything.
  bestEffort: boolean;
  error?: string;
}

// A piece from before splitOriginalId: the split tag and the split note are
// there, the pointer is not.
function isLegacySplitPiece(t: Transfer): boolean {
  return (
    t.splitPart !== undefined &&
    t.splitOriginalId === undefined &&
    t.notes === SPLIT_NOTE
  );
}

// Same-split fingerprint: everything applyTransferSplit copies from the
// original onto both pieces. Amount is deliberately NOT part of it — that is
// what differs between the two halves.
function sameSplitShape(a: Transfer, b: Transfer): boolean {
  return (
    a.positionId === b.positionId &&
    a.date === b.date &&
    a.platform === b.platform &&
    a.transferType === b.transferType
  );
}

// Best-effort undo for a legacy piece. Finds the sibling by shape and opposite
// side, then looks for a soft-deleted transfer of the same shape whose amount
// equals the two pieces added together. Deliberately refuses to act on anything
// less than exactly ONE candidate on both counts — restoring the wrong record
// would be worse than doing nothing, and the user can always fix it by hand.
function planLegacyUndoSplit(
  piece: Transfer,
  liveTransfers: Transfer[],
  allTransfers: Transfer[],
): UndoSplitPlan {
  const blocked = (error: string, pieces: Transfer[]): UndoSplitPlan => ({
    originalId: "",
    pieces,
    original: null,
    edited: false,
    piecesTotal: pieces.reduce((s, t) => s + toFiniteAmount(t.amount), 0),
    originalAmount: 0,
    bestEffort: true,
    error,
  });

  const siblings = liveTransfers.filter(
    (t) =>
      t.id !== piece.id &&
      t.notes === SPLIT_NOTE &&
      t.splitPart !== undefined &&
      t.splitPart !== piece.splitPart &&
      sameSplitShape(t, piece),
  );
  if (siblings.length !== 1) {
    return blocked(
      siblings.length === 0
        ? "Couldn't find this piece's other half, so there is nothing to add it back to. Fix this one manually."
        : "More than one transfer could be this piece's other half, so it isn't safe to guess. Fix this one manually.",
      [piece],
    );
  }
  const sibling = siblings[0];
  const pieces = [piece, sibling];
  const total = toFiniteAmount(piece.amount) + toFiniteAmount(sibling.amount);
  const candidates = allTransfers.filter(
    (t) =>
      t.deletedAt !== undefined &&
      sameSplitShape(t, piece) &&
      Math.abs(toFiniteAmount(t.amount) - total) < 0.005,
  );
  if (candidates.length !== 1) {
    return blocked(
      candidates.length === 0
        ? "Couldn't find a deleted transfer matching these two added together, so there is nothing to restore. Fix this one manually."
        : "Several deleted transfers match these two added together, so it isn't safe to guess which one to restore. Fix this one manually.",
      pieces,
    );
  }
  const original = candidates[0];
  return {
    originalId: original.id,
    pieces,
    original,
    // The match is BY total, so the pieces necessarily add up — an edited piece
    // simply would not have matched anything, and shows as "couldn't find" above.
    edited: false,
    piecesTotal: total,
    originalAmount: toFiniteAmount(original.amount),
    bestEffort: true,
  };
}

// Undo is "delete the pieces, restore the original" — never a merge. The
// original was soft-deleted, not erased, so the record that comes back is
// byte-identical to the one that was split, including its sourceClaimId.
export function planUndoSplit(
  piece: Transfer,
  liveTransfers: Transfer[],
  allTransfers: Transfer[],
): UndoSplitPlan {
  // Legacy pieces only — anything split since dd81140 carries the pointer and
  // takes the exact path below, unchanged.
  if (isLegacySplitPiece(piece)) {
    return planLegacyUndoSplit(piece, liveTransfers, allTransfers);
  }
  const originalId = piece.splitOriginalId ?? "";
  const pieces = liveTransfers.filter((t) => t.splitOriginalId === originalId);
  const original =
    allTransfers.find((t) => t.id === originalId && t.deletedAt !== undefined) ??
    null;
  const piecesTotal = pieces.reduce(
    (sum, t) => sum + (Number.isFinite(t.amount) ? t.amount : 0),
    0,
  );
  const originalAmount = original?.amount ?? 0;
  if (originalId === "") {
    return {
      originalId,
      pieces,
      original,
      edited: false,
      piecesTotal,
      originalAmount,
      bestEffort: false,
      error: "This transfer is not part of a split.",
    };
  }
  if (original === null) {
    return {
      originalId,
      pieces,
      original,
      edited: false,
      piecesTotal,
      originalAmount,
      bestEffort: false,
      error:
        "The original transfer was permanently deleted, so there is nothing to restore. Delete these pieces by hand if you no longer want them.",
    };
  }
  // Sum-based, because the pieces do not store what they were created as. It
  // catches any single edited amount; two edits that cancel out exactly would
  // slip through, which is a far-fetched way to lose an edit you are explicitly
  // undoing. A missing piece (deleted separately) also shows up here.
  const edited =
    pieces.length !== 2 || Math.abs(piecesTotal - originalAmount) >= 0.005;
  return {
    originalId,
    pieces,
    original,
    edited,
    piecesTotal,
    originalAmount,
    bestEffort: false,
  };
}

export function applyUndoSplit(plan: UndoSplitPlan): boolean {
  if (plan.error !== undefined || plan.original === null) return false;
  for (const p of plan.pieces) softDeleteTransfer(p.id);
  // Restore last: restoreTransfer only drops deletedAt, so the original returns
  // with its platform, deploy-link, sourceClaimId and notes exactly as they were.
  restoreTransfer(plan.originalId);
  return true;
}

// ── Backfill eligibility (pure) ─────────────────────────────────────────────

// A claim already has a fee transfer if an auto row points at it (by
// sourceClaimId), OR a MANUAL row lands on the same position and calendar day
// tagged "fees" — the safe heuristic from Phase A that avoids duplicating a
// hand-logged transfer. The manual restriction matters: two legitimate fee
// claims on one position on one day would otherwise falsely mark the second as
// covered by the first's auto transfer and drop it from the backfill.
export function claimHasFeeTransfer(
  claim: FeeClaim,
  transfers: Transfer[],
): boolean {
  return transfers.some(
    (t) =>
      t.sourceClaimId === claim.id ||
      (t.transferType === "fees" &&
        t.sourceClaimId === undefined &&
        t.positionId === claim.positionId &&
        dayOf(t.date) === dayOf(claim.date)),
  );
}

export function eligibleClaimsForBackfill(
  claims: FeeClaim[],
  transfers: Transfer[],
): FeeClaim[] {
  return claims.filter((c) => !claimHasFeeTransfer(c, transfers));
}

// Upside exits cannot be detected from stored data (Phase A), so eligibility
// only narrows the list to closed, profitable positions the user must confirm;
// it never presumes the exit was above range.
export function closeHasUpsideTransfer(
  position: Position,
  transfers: Transfer[],
): boolean {
  return transfers.some(
    (t) =>
      t.sourceCloseId === position.id ||
      (t.transferType === "outOfRangeUpside" && t.positionId === position.id),
  );
}

export function eligibleClosesForBackfill(
  positions: Position[],
  transfers: Transfer[],
): Position[] {
  return positions.filter(
    (p) =>
      p.status === "closed" &&
      Number.isFinite(p.scalp ?? NaN) &&
      (p.scalp as number) > 0 &&
      !closeHasUpsideTransfer(p, transfers),
  );
}
