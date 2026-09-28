import {
  calcDaysActive,
  calcFeeAPR,
  calcPositionProfit,
  calcPriceDiff,
  calcTotalFees,
  computePositionIL,
  getEffectiveClaimed,
  getPositionSaleGain,
  getEffectiveDeposited,
  getEffectiveTotalFees,
  type ILResult,
} from "./calculations";
import type {
  FeeClaim,
} from "./types";
import type {
  LPRange,
  PoolPnLEntry,
  Position,
  Transfer,
} from "./types";

export const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});


export function formatUsd(value: number): string {
  return usdFormatter.format(Number.isFinite(value) ? value : 0);
}


export function formatPercent(value: number): string {
  const safe = Number.isFinite(value) ? value : 0;
  return `${safe.toFixed(2)}%`;
}


export function pad(n: number): string {
  return String(n).padStart(2, "0");
}


export function formatDateTime24(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}


export function nowDatetimeLocal(): string {
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60_000).toISOString().slice(0, 16);
}


export function formatUpdatedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "just now";
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}


export function isoToDatetimeLocal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60_000).toISOString().slice(0, 16);
}


export function isoToDateInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60_000).toISOString().slice(0, 10);
}


export function dateInputToIso(value: string): string | null {
  if (!value) return null;
  const d = new Date(`${value}T00:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}


export function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `id_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}


export function pnlColor(value: number): string {
  if (value > 0) return "text-emerald-400";
  if (value < 0) return "text-rose-400";
  return "text-[var(--foreground)]";
}


// The word that goes with pnlColor. Deliberately the same sign checks in the
// same order, right beside it, so the colour and the word can never disagree —
// a green "Loss" would be worse than no word at all. Exactly zero is neither,
// and gets no word rather than being called a gain.
export function pnlLabel(value: number): string {
  if (value > 0) return "Gain";
  if (value < 0) return "Loss";
  return "";
}


export function num(value: string): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}


export function optionalNum(value: string): number | null {
  if (value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}


export function normalizeFeeTier(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.endsWith("%") ? trimmed : `${trimmed}%`;
}


export function computeShortTotal(
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
export function formDeposited(
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
export function formatAmountInput(
  value: number,
  decimals: number,
  allowNegative = false,
): string {
  if (!Number.isFinite(value)) return "0";
  if (value <= 0 && !allowNegative) return "0";
  return String(Number(value.toFixed(decimals)));
}


// Parses form strings, then delegates to the shared computePositionIL in
// lib/calculations (Invariant #6 — one IL source of truth across pages).
// Form naming: token1 = base token (calcIL token0), token2 = quote token
// (calcIL token1, priced at $1 by convention). Takes primitive fields rather
// than the whole form so memoized callers can declare exact deps.
export function tryComputeIL(
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


export interface DerivedRow {
  position: Position;
  deposited: number;
  claimed: number;
  fees: number;
  days: number;
  apr: number;
  priceDiff: number;
  profit: number;
  // Gain from selling this position's reward tokens after the claim. 0 when
  // nothing was sold, which is every position until it is.
  saleGain: number;
}


export function derive(positions: Position[], allClaims: FeeClaim[]): DerivedRow[] {
  return positions.map((position) => {
    const deposited = getEffectiveDeposited(position);
    const claimed = getEffectiveClaimed(position, allClaims);
    const fees = getEffectiveTotalFees(position, allClaims);
    const days = calcDaysActive(position.entryDatetime, position.exitDatetime);
    const apr = calcFeeAPR(fees, deposited, days);
    const priceDiff = calcPriceDiff(position.currentBalance, deposited);
    const profit = calcPositionProfit(position, fees, priceDiff);
    const saleGain = getPositionSaleGain(position, allClaims);
    return {
      position, deposited, claimed, fees, days, apr, priceDiff, profit, saleGain,
    };
  });
}


// Every record linked to a position — used both to preview the cascade and to
// execute it, so the count shown and the rows removed can never disagree.
// Transfers link three ways: directly by positionId, by sourceCloseId (upside
// transfers), or by sourceClaimId pointing at one of this position's claims
// (auto fee transfers). The union covers all of them, so nothing is orphaned.
export function linkedRecords(
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


export interface PositionFormState {
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


export const EMPTY_FORM: PositionFormState = {
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


export function positionToForm(p: Position): PositionFormState {
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


export interface BuiltRecords {
  position: Position;
  range: LPRange;
  pool: PoolPnLEntry;
}


export function buildRecords(
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


// Prices are quote-per-base, not USD — formatted as plain numbers with
// enough precision for low-priced pairs without trailing noise on large ones.
export function formatPrice(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const decimals = value >= 100 ? 2 : value >= 1 ? 4 : 6;
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
}


export function fmtTokenAmount(value: number): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  });
}
