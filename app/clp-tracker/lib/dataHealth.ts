// Data Health — one shared home for every "this record looks wrong" check in
// the app. Consolidates the position-symbol detector (a1b7176) and the
// claim-symbol detector (77df8e6), extends the same substring test to
// Transfers, and adds an unusual-amount outlier flag for claims and transfers.
//
// DETECTION ONLY. Nothing here mutates data. The `correct*` helpers return a
// COPY with the fix applied; persisting it is always an explicit, user-
// confirmed action in the UI. A genuinely large claim or an intentional token
// can be real, so every result is a "please double-check", never a rewrite.

import type {
  FeeClaim,
  OutlierDismissal,
  Position,
  StalePositionDismissal,
  Transfer,
} from "./types";
import { normalizeChain } from "./nameNormalization";
import { isUnvaluedConvertedClaim } from "./calculations";
import { isIdleTransfer } from "./transferState";
import { AUTO_CLAIM_NOTE, isUntouchedAuto } from "./transferAutomation";

// ---------------------------------------------------------------------------
// Shared pair parsing
// ---------------------------------------------------------------------------

// Strips a trailing fee-tier suffix like " (0.05%)" so "ETH/USDC (0.05%)"
// parses the same as "ETH/USDC". Positions store the tier separately, but
// claims sometimes fold it into the pair string.
export function pairCore(pair: string): string {
  const m = pair.match(/^(.+?)\s*\([^)]*\)\s*$/);
  return (m ? m[1] : pair).trim().toUpperCase();
}

// A symbol is plausible for a pair when it appears INSIDE the pair string.
// Substring, not equality, on purpose: Base "ETH" on pair "WETH/USDC" is a
// legitimate wrapper alias (ETH ⊂ WETH) and must not be flagged, while
// "SOL" ⊄ "SUI/USDC" is caught.
export function symbolMatchesPair(symbol: string, pairCoreStr: string): boolean {
  const s = symbol.trim().toUpperCase();
  return s === "" || pairCoreStr.includes(s);
}

// The two tokens of a pair, in order. "" for a side that cannot be parsed.
export function pairTokens(pairCoreStr: string): [string, string] {
  const [base = "", quote = ""] = pairCoreStr
    .split("/")
    .map((s) => s.trim().toUpperCase());
  return [base, quote];
}

// ---------------------------------------------------------------------------
// Position symbol ↔ pair mismatch (moved verbatim from calculations.ts)
// ---------------------------------------------------------------------------

export interface SymbolPairMismatchRow {
  position: Position;
  baseSymbol: string;
  quoteSymbol: string;
  // The symbols parsed from the Pair string itself (the likely-correct values).
  pairBase: string;
  pairQuote: string;
  baseMismatch: boolean;
  quoteMismatch: boolean;
  // Closed positions carry the higher risk: a token-amount-mode close fetched a
  // price FROM the wrong symbol and wrote it into Final Balance / Scalp, so the
  // stored dollars — not just the label — can be wrong.
  isClosed: boolean;
}

// Plausibility check (Invariant #8): a position's Base/Quote token symbol must
// appear inside its own Pair string. "SOL" on a "SUI/USDC" pair is impossible
// and means the symbol field holds the wrong token — which then drives every
// price lookup (live range bar, and critically the token-amount-mode close
// historical price) to the WRONG coin. Reports rather than repairs — only the
// user knows whether the Pair or the symbol is the typo.
export function findSymbolPairMismatches(
  positions: Position[],
): SymbolPairMismatchRow[] {
  const rows: SymbolPairMismatchRow[] = [];
  for (const p of positions) {
    const pair = pairCore(p.pair);
    if (pair === "") continue;
    const baseSymbol = p.token1Symbol.trim().toUpperCase();
    const quoteSymbol = p.token2Symbol.trim().toUpperCase();
    const baseMismatch = baseSymbol !== "" && !pair.includes(baseSymbol);
    const quoteMismatch = quoteSymbol !== "" && !pair.includes(quoteSymbol);
    if (!baseMismatch && !quoteMismatch) continue;
    const [pairBase, pairQuote] = pairTokens(pair);
    rows.push({
      position: p,
      baseSymbol,
      quoteSymbol,
      pairBase,
      pairQuote,
      baseMismatch,
      quoteMismatch,
      isClosed: p.status === "closed",
    });
  }
  // Closed (dollar-risk) positions first, then by pair for stable ordering.
  return rows.sort((a, b) => {
    if (a.isClosed !== b.isClosed) return a.isClosed ? -1 : 1;
    return a.position.pair.localeCompare(b.position.pair);
  });
}

// ---------------------------------------------------------------------------
// Claim symbol ↔ pair mismatch (moved verbatim from calculations.ts)
// ---------------------------------------------------------------------------

// Fee claims freeze their OWN token1Symbol/token2Symbol at creation (a static
// snapshot copied from the position), so a position mislabeled "SOL" mints
// claims that ALSO store "SOL" — and calcBusinessPnL sums the claim's stored
// symbol, inflating the wrong token's total. Fixing the position does NOT fix
// these claims. Each claim carries its own pair string, so the same substring
// test catches it.
export interface ClaimSymbolMismatchRow {
  claim: FeeClaim;
  baseSymbol: string;
  quoteSymbol: string;
  pairBase: string;
  pairQuote: string;
  baseMismatch: boolean;
  quoteMismatch: boolean;
}

export function findClaimSymbolMismatches(
  claims: FeeClaim[],
): ClaimSymbolMismatchRow[] {
  const rows: ClaimSymbolMismatchRow[] = [];
  for (const claim of claims) {
    const pair = pairCore(claim.pair);
    if (pair === "") continue;
    const baseSymbol = claim.token1Symbol.trim().toUpperCase();
    const quoteSymbol = claim.token2Symbol.trim().toUpperCase();
    const baseMismatch = baseSymbol !== "" && !pair.includes(baseSymbol);
    const quoteMismatch = quoteSymbol !== "" && !pair.includes(quoteSymbol);
    if (!baseMismatch && !quoteMismatch) continue;
    const [pairBase, pairQuote] = pairTokens(pair);
    rows.push({
      claim,
      baseSymbol,
      quoteSymbol,
      pairBase,
      pairQuote,
      baseMismatch,
      quoteMismatch,
    });
  }
  return rows;
}

// Real-vs-contamination subtotals: how much token quantity is filed under the
// WRONG symbol and which symbol it should be, aggregated across all flagged
// claims. This is the "X SOL is actually SUI" figure the Business P&L total is
// inflated by. Only counts a side when its pair token is known (non-empty).
export interface ClaimContaminationRow {
  wrongSymbol: string;
  correctSymbol: string;
  amount: number;
  claimCount: number;
}

export function summarizeClaimContamination(
  rows: ClaimSymbolMismatchRow[],
): ClaimContaminationRow[] {
  const map = new Map<string, ClaimContaminationRow>();
  const add = (wrong: string, correct: string, amount: number) => {
    if (correct === "" || !Number.isFinite(amount) || amount <= 0) return;
    const key = `${wrong}->${correct}`;
    const existing = map.get(key);
    if (existing) {
      existing.amount += amount;
      existing.claimCount += 1;
    } else {
      map.set(key, { wrongSymbol: wrong, correctSymbol: correct, amount, claimCount: 1 });
    }
  };
  for (const r of rows) {
    if (r.baseMismatch) add(r.baseSymbol, r.pairBase, r.claim.token1Amount);
    if (r.quoteMismatch) add(r.quoteSymbol, r.pairQuote, r.claim.token2Amount);
  }
  return [...map.values()].sort((a, b) => b.amount - a.amount);
}

// The one-click correction: returns a copy of the claim with each mismatched
// side rewritten to the pair-derived symbol. A side whose pair token is unknown
// (empty) is left untouched — we never blank a symbol we cannot replace.
export function correctClaimSymbols(row: ClaimSymbolMismatchRow): FeeClaim {
  const next = { ...row.claim };
  if (row.baseMismatch && row.pairBase !== "") next.token1Symbol = row.pairBase;
  if (row.quoteMismatch && row.pairQuote !== "") next.token2Symbol = row.pairQuote;
  return next;
}

// ---------------------------------------------------------------------------
// Transfer symbol ↔ linked-position pair mismatch (Part 2)
// ---------------------------------------------------------------------------

// A Transfer stores both positionId and a single token symbol, so it can be
// checked against its linked position's pair with the same substring test. The
// correction TARGET must mirror how the automation assigns a transfer's token:
// an out-of-range-upside transfer carries the QUOTE symbol (buildUpsideTransfer)
// while a fee/undeployed transfer carries the volatile BASE symbol
// (buildClaimTransfer). A transfer whose position is missing or has no pair is
// skipped — it cannot be judged.
export interface TransferSymbolMismatchRow {
  transfer: Transfer;
  position: Position;
  token: string;
  pairBase: string;
  pairQuote: string;
  // The pair token this transfer's symbol most plausibly should have been,
  // chosen by transferType. "" when it cannot be determined (correction off).
  suggestedSymbol: string;
}

function suggestedTransferSymbol(
  transfer: Transfer,
  pairBase: string,
  pairQuote: string,
): string {
  return transfer.transferType === "outOfRangeUpside" ? pairQuote : pairBase;
}

export function findTransferSymbolMismatches(
  transfers: Transfer[],
  positions: Position[],
): TransferSymbolMismatchRow[] {
  const positionById = new Map(positions.map((p) => [p.id, p]));
  const rows: TransferSymbolMismatchRow[] = [];
  for (const transfer of transfers) {
    const token = transfer.token.trim().toUpperCase();
    if (token === "") continue;
    const position = positionById.get(transfer.positionId);
    if (!position) continue;
    const pair = pairCore(position.pair);
    if (pair === "") continue;
    if (pair.includes(token)) continue;
    const [pairBase, pairQuote] = pairTokens(pair);
    rows.push({
      transfer,
      position,
      token,
      pairBase,
      pairQuote,
      suggestedSymbol: suggestedTransferSymbol(transfer, pairBase, pairQuote),
    });
  }
  return rows.sort((a, b) =>
    a.position.pair.localeCompare(b.position.pair),
  );
}

export function correctTransferSymbol(row: TransferSymbolMismatchRow): Transfer {
  if (row.suggestedSymbol === "") return { ...row.transfer };
  return { ...row.transfer, token: row.suggestedSymbol };
}

// ---------------------------------------------------------------------------
// Unusual-amount outliers for claims and transfers (Part 3)
// ---------------------------------------------------------------------------

// An extra/missing zero is a 10× shift. We compare a record's USD amount to the
// MAX (for "too high") / MIN (for "too low") of the OTHER records on the same
// position — so even the position's largest legitimate record must be dwarfed
// tenfold before we flag. That makes normal 2–3× variation invisible to the
// check; it essentially only catches order-of-magnitude data-entry slips. We
// require at least MIN_SIBLINGS other records so a single data point never
// defines "typical". Flag only — a big claim can be genuine.
export const OUTLIER_MULTIPLIER = 10;
export const OUTLIER_MIN_SIBLINGS = 2;

export type OutlierKind = "claim" | "transfer";

export interface OutlierRow {
  kind: OutlierKind;
  id: string;
  positionId: string;
  position: Position | null;
  label: string;
  date: string;
  amount: number;
  direction: "high" | "low";
  // The typical band (min/max of the sibling records) this one broke out of.
  typicalMin: number;
  typicalMax: number;
  siblingCount: number;
  claim?: FeeClaim;
  transfer?: Transfer;
}

interface AmountRecord {
  id: string;
  positionId: string;
  date: string;
  amount: number;
}

// Core outlier pass, shared by claims and transfers. Groups valid amounts by
// position, then flags any record an order of magnitude beyond every sibling.
function findAmountOutliers(
  records: AmountRecord[],
): Array<AmountRecord & { direction: "high" | "low"; typicalMin: number; typicalMax: number; siblingCount: number }> {
  const byPosition = new Map<string, AmountRecord[]>();
  for (const r of records) {
    if (r.positionId === "") continue;
    if (!Number.isFinite(r.amount) || r.amount <= 0) continue;
    const list = byPosition.get(r.positionId);
    if (list) list.push(r);
    else byPosition.set(r.positionId, [r]);
  }
  const out: Array<
    AmountRecord & { direction: "high" | "low"; typicalMin: number; typicalMax: number; siblingCount: number }
  > = [];
  for (const list of byPosition.values()) {
    if (list.length <= OUTLIER_MIN_SIBLINGS) continue; // need candidate + ≥2 siblings
    for (const candidate of list) {
      const siblings = list.filter((r) => r !== candidate);
      if (siblings.length < OUTLIER_MIN_SIBLINGS) continue;
      const amounts = siblings.map((s) => s.amount);
      const maxOther = Math.max(...amounts);
      const minOther = Math.min(...amounts);
      let direction: "high" | "low" | null = null;
      if (candidate.amount >= OUTLIER_MULTIPLIER * maxOther) direction = "high";
      else if (candidate.amount <= minOther / OUTLIER_MULTIPLIER) direction = "low";
      if (!direction) continue;
      out.push({
        ...candidate,
        direction,
        typicalMin: minOther,
        typicalMax: maxOther,
        siblingCount: siblings.length,
      });
    }
  }
  return out;
}

// A dismissal suppresses a flag only while the amount is UNCHANGED. Matching on
// kind+id+amount (to the cent) means a later edit to the amount no longer
// matches, so the record is re-flagged for a fresh review.
function isDismissed(
  dismissals: OutlierDismissal[],
  kind: "claim" | "transfer",
  id: string,
  amount: number,
): boolean {
  return dismissals.some(
    (d) =>
      d.kind === kind &&
      d.id === id &&
      Math.abs(d.amount - amount) <= 0.005,
  );
}

export function findClaimAmountOutliers(
  claims: FeeClaim[],
  positions: Position[] = [],
  dismissals: OutlierDismissal[] = [],
): OutlierRow[] {
  const positionById = new Map(positions.map((p) => [p.id, p]));
  const records: AmountRecord[] = claims
    .filter((c) => c.stableAmount !== null && Number.isFinite(c.stableAmount))
    .map((c) => ({
      id: c.id,
      positionId: c.positionId,
      date: c.date,
      amount: c.stableAmount as number,
    }));
  const claimById = new Map(claims.map((c) => [c.id, c]));
  return findAmountOutliers(records)
    .filter((r) => !isDismissed(dismissals, "claim", r.id, r.amount))
    .map((r) => {
      const claim = claimById.get(r.id);
      const position = positionById.get(r.positionId) ?? null;
      return {
        kind: "claim" as const,
        id: r.id,
        positionId: r.positionId,
        position,
        label: claim?.pair || position?.pair || "—",
        date: r.date,
        amount: r.amount,
        direction: r.direction,
        typicalMin: r.typicalMin,
        typicalMax: r.typicalMax,
        siblingCount: r.siblingCount,
        claim,
      };
    })
    .sort((a, b) => b.amount - a.amount);
}

export function findTransferAmountOutliers(
  transfers: Transfer[],
  positions: Position[] = [],
  dismissals: OutlierDismissal[] = [],
): OutlierRow[] {
  const positionById = new Map(positions.map((p) => [p.id, p]));
  const records: AmountRecord[] = transfers.map((t) => ({
    id: t.id,
    positionId: t.positionId,
    date: t.date,
    amount: t.amount,
  }));
  const transferById = new Map(transfers.map((t) => [t.id, t]));
  return findAmountOutliers(records)
    .filter((r) => !isDismissed(dismissals, "transfer", r.id, r.amount))
    .map((r) => {
      const transfer = transferById.get(r.id);
      const position = positionById.get(r.positionId) ?? null;
      return {
        kind: "transfer" as const,
        id: r.id,
        positionId: r.positionId,
        position,
        label:
          position?.pair || transfer?.destination || transfer?.token || "—",
        date: r.date,
        amount: r.amount,
        direction: r.direction,
        typicalMin: r.typicalMin,
        typicalMax: r.typicalMax,
        siblingCount: r.siblingCount,
        transfer,
      };
    })
    .sort((a, b) => b.amount - a.amount);
}

// Builds the dismissal record for a flagged row — captures the exact amount so
// a later edit re-triggers the flag.
export function dismissalFor(row: OutlierRow): OutlierDismissal {
  return { kind: row.kind, id: row.id, amount: row.amount };
}

// ---------------------------------------------------------------------------
// Chain ↔ pair mismatch (Part 4a)
// ---------------------------------------------------------------------------

// Base tokens that trade natively on exactly ONE chain, so a position's chain
// is checkable against its pair. Kept intentionally tiny and unambiguous:
// ETH/BTC/USDC etc. are omitted because they legitimately live on many chains
// and would false-flag. A SUI/USDC position stored on chain "SOL"/"Solana" is
// the reported typo class this catches. Expected values are canonical
// (normalizeChain output).
const NATIVE_CHAIN_FOR_BASE: Record<string, string> = {
  SUI: "SUI",
  SOL: "SOLANA", // canonical chain label (normalizeChain output)
};

export interface ChainMismatchRow {
  position: Position;
  baseSymbol: string;
  chain: string; // raw stored value
  expectedChain: string; // canonical
}

// Reports positions whose stored chain contradicts a chain-native base token.
// Reports only — the user confirms any fix (same pattern as symbol mismatches).
export function findChainMismatches(positions: Position[]): ChainMismatchRow[] {
  const rows: ChainMismatchRow[] = [];
  for (const p of positions) {
    const pair = pairCore(p.pair);
    if (pair === "") continue;
    const [pairBase] = pairTokens(pair);
    const expected = NATIVE_CHAIN_FOR_BASE[pairBase];
    if (!expected) continue;
    const chain = normalizeChain(p.chain);
    if (chain === "") continue; // no chain set — nothing to contradict
    if (chain === expected) continue;
    rows.push({
      position: p,
      baseSymbol: pairBase,
      chain: p.chain,
      expectedChain: expected,
    });
  }
  return rows.sort((a, b) => a.position.pair.localeCompare(b.position.pair));
}


// ---------------------------------------------------------------------------
// Stale positions
// ---------------------------------------------------------------------------

// An open position that has not produced a fee claim in a while. Not
// necessarily wrong — a quiet pool is still a real position — but it is the
// shape of a position the user forgot to close, or forgot to log claims for,
// so it is worth a look.
export const STALE_POSITION_DAYS = 14;

export interface StalePositionRow {
  position: Position;
  // Latest claim date, or the position's own entry date when it has never
  // been claimed — the honest "last time anything happened here".
  lastActivity: string;
  daysSince: number;
  claimCount: number;
}

// Only ACTIVE positions can be stale: a closed one is finished by definition
// and nothing more is expected of it.
export function findStalePositions(
  positions: Position[],
  claims: FeeClaim[],
  dismissals: StalePositionDismissal[] = [],
  now: Date = new Date(),
): StalePositionRow[] {
  // "I've looked at this, it's fine" — keyed by the lastActivity value at the
  // time it was dismissed, so the dismissal only silences the exact situation
  // the user reviewed. Log a claim and lastActivity moves, the key stops
  // matching, and the position is watched again from there.
  const dismissedAt = new Map(
    dismissals.map((d) => [d.positionId, d.lastActivity]),
  );
  const latestClaim = new Map<string, string>();
  const claimCounts = new Map<string, number>();
  for (const c of claims) {
    if (!c.positionId) continue;
    claimCounts.set(c.positionId, (claimCounts.get(c.positionId) ?? 0) + 1);
    const seen = latestClaim.get(c.positionId);
    if (seen === undefined || new Date(c.date) > new Date(seen)) {
      latestClaim.set(c.positionId, c.date);
    }
  }
  const rows: StalePositionRow[] = [];
  for (const p of positions) {
    if (p.status !== "active") continue;
    const lastActivity = latestClaim.get(p.id) ?? p.entryDatetime;
    const at = new Date(lastActivity).getTime();
    // An unparseable date says nothing either way, so it is not flagged
    // rather than being reported as infinitely stale.
    if (!Number.isFinite(at)) continue;
    const daysSince = (now.getTime() - at) / 86_400_000;
    if (daysSince <= STALE_POSITION_DAYS) continue;
    if (dismissedAt.get(p.id) === lastActivity) continue;
    rows.push({
      position: p,
      lastActivity,
      daysSince,
      claimCount: claimCounts.get(p.id) ?? 0,
    });
  }
  // Oldest first — the ones most worth looking at lead.
  return rows.sort((a, b) => b.daysSince - a.daysSince);
}

// What to store when a stale row is marked reviewed: the position and the
// exact lastActivity being dismissed. One helper, so the banner that writes a
// dismissal and the test above that reads it can never key it differently.
export function staleDismissalFor(
  row: StalePositionRow,
): StalePositionDismissal {
  return { positionId: row.position.id, lastActivity: row.lastActivity };
}

// ---------------------------------------------------------------------------
// Incomplete claims
// ---------------------------------------------------------------------------

export interface IncompleteClaimRow {
  claim: FeeClaim;
  position: Position | null;
}

// Claims marked converted to stablecoin but saved without a USD value. They
// contribute $0 to Overall P&L, silently. The predicate is NOT redefined here:
// isUnvaluedConvertedClaim in calculations.ts is the canonical definition and
// is what calcOverallPnL counts, so the Data Health total and the P&L figure
// can never disagree about which claims are affected.
export function findIncompleteClaims(
  claims: FeeClaim[],
  positions: Position[],
): IncompleteClaimRow[] {
  const byId = new Map(positions.map((p) => [p.id, p]));
  return claims
    .filter(isUnvaluedConvertedClaim)
    .map((claim) => ({ claim, position: byId.get(claim.positionId) ?? null }))
    .sort((a, b) => (b.claim.date ?? "").localeCompare(a.claim.date ?? ""));
}


// ---------------------------------------------------------------------------
// Idle earnings (out-of-range upside + fee claims)
// ---------------------------------------------------------------------------

// Money the business EARNED — close profit and claimed fees — that has then sat
// untouched. Uses the SAME idle test Available Balance is built from
// (lib/transferState) rather than a second definition, so a row flagged here is
// exactly a row still counted as available — the two can never disagree
// (Invariant #6). Undeployed Tokens is deliberately NOT included: that money is
// idle capital by definition (it carries an unset money status on purpose,
// d20f3e3), so flagging it would be flagging it for being what it is.
export const IDLE_UPSIDE_DAYS = 14;

const IDLE_EARNING_TYPES: ReadonlySet<string> = new Set([
  "outOfRangeUpside",
  "fees",
]);

export interface IdleUpsideRow {
  transfer: Transfer;
  position: Position | null;
  daysIdle: number;
}

export function findIdleUpsideTransfers(
  transfers: Transfer[],
  positions: Position[],
  now: Date = new Date(),
): IdleUpsideRow[] {
  const byId = new Map(positions.map((p) => [p.id, p]));
  const rows: IdleUpsideRow[] = [];
  for (const t of transfers) {
    if (!IDLE_EARNING_TYPES.has(t.transferType)) continue;
    if (!isIdleTransfer(t)) continue;
    const at = new Date(t.date).getTime();
    // An unparseable date says nothing either way, so it is skipped rather
    // than reported as infinitely idle.
    if (!Number.isFinite(at)) continue;
    const daysIdle = (now.getTime() - at) / 86_400_000;
    // Give it time before nagging — money that landed this week is not a
    // problem, it is just recent.
    if (daysIdle <= IDLE_UPSIDE_DAYS) continue;
    rows.push({
      transfer: t,
      position: byId.get(t.positionId) ?? null,
      daysIdle,
    });
  }
  return rows.sort((a, b) => b.daysIdle - a.daysIdle);
}

// ---------------------------------------------------------------------------
// Drifted claim transfers
// ---------------------------------------------------------------------------

// A transfer whose linked fee claim has since been edited to a different USD
// value, while the transfer kept the old one. This is the visible, persistent
// half of the "skipped-touched" outcome (36cafc6): reconcileClaimTransfers
// deliberately refuses to overwrite a transfer the user has already sent,
// deployed or expensed, so the two legitimately diverge — and stay diverged
// until someone reconciles them by hand.
//
// UNTOUCHED transfers are excluded by construction, not by choice: reconcile
// rebuilds those to match on every save, so they cannot drift. isUntouchedAuto
// is IMPORTED from transferAutomation, the same predicate reconcile itself
// branches on, so this check flags exactly the set reconcile skipped — a second
// definition of "touched" would eventually flag rows that did sync, or miss
// rows that did not (Invariant #6).
export interface DriftedClaimTransferRow {
  transfer: Transfer;
  claim: FeeClaim;
  claimAmount: number;
  difference: number;
}

export function findDriftedClaimTransfers(
  transfers: Transfer[],
  claims: FeeClaim[],
): DriftedClaimTransferRow[] {
  const byId = new Map(claims.map((c) => [c.id, c]));
  const rows: DriftedClaimTransferRow[] = [];
  for (const t of transfers) {
    if (t.sourceClaimId === undefined) continue;
    const claim = byId.get(t.sourceClaimId);
    // A claim that no longer exists is not drift — deleting a claim already
    // detaches or removes its transfer (93719c5), so there is nothing to
    // compare against and nothing to fix.
    if (!claim) continue;
    if (isUntouchedAuto(t)) continue;
    // A claim with no USD value yet is an incomplete claim, which
    // findIncompleteClaims already reports; comparing against it would flag the
    // same record twice under a wrong name.
    const claimAmount = claim.stableAmount;
    if (claimAmount === null || !Number.isFinite(claimAmount)) continue;
    // Cent-level equality: these are both stored dollar figures, and a float
    // representation gap is not drift a user could act on.
    const difference = t.amount - claimAmount;
    if (Math.abs(difference) < 0.005) continue;
    rows.push({ transfer: t, claim, claimAmount, difference });
  }
  return rows.sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference));
}

// ---------------------------------------------------------------------------
// Orphaned by claim deletion
// ---------------------------------------------------------------------------

// A transfer whose source fee claim was deleted while this money had already
// been sent, deployed or expensed. cleanupClaimTransfers keeps the record —
// the money genuinely moved and erasing it would erase where it went — but the
// unlink used to be silent, leaving a row that looked like any hand-logged
// transfer. The stamp it now writes is what this reads.
//
// No predicate of its own beyond "is the stamp there": the decision about WHICH
// transfers get detached rather than soft-deleted lives in cleanupClaimTransfers
// (isUntouchedAuto), and restating it here would let the two disagree.
// Resolution is an edit — saving the transfer clears the stamp — because
// reviewing it is the only thing that can be done about it.
// confirmed=true: claimDeletedAt was stamped at the moment of deletion, so both
// the fact and its date are exact. confirmed=false: INFERRED from the record's
// own shape, for deletions that happened before the stamp existed (f9c43f9) —
// the fact is certain, the date is not, so deletedAt is null and the UI says so.
export interface OrphanedByClaimRow {
  transfer: Transfer;
  deletedAt: string | null;
  confirmed: boolean;
}

// THE TELL, for a deletion that predates the stamp: a fees transfer carrying
// AUTO_CLAIM_NOTE but NO sourceClaimId. Only the automation writes that note,
// and it always writes the id alongside it, so the note surviving without the
// id means the id was stripped — and cleanupClaimTransfers' detach branch is
// the only code that strips it. AUTO_CLAIM_NOTE is imported rather than typed
// out, so the note and the test cannot drift apart.
//
// Deliberately NOT caught by this heuristic: a manually-logged transfer (never
// had the note), and a "Revert to auto-created" row (rebuilt WITH its
// sourceClaimId, so the id is present). An untouched auto transfer whose claim
// was deleted was soft-deleted with it and is not in the live list at all.
function looksOrphanedByNote(t: Transfer): boolean {
  return (
    t.sourceClaimId === undefined &&
    t.transferType === "fees" &&
    t.notes.includes(AUTO_CLAIM_NOTE)
  );
}

export function findOrphanedByClaimDeletion(
  transfers: Transfer[],
): OrphanedByClaimRow[] {
  const rows: OrphanedByClaimRow[] = [];
  for (const t of transfers) {
    // The stamp is the source of truth when present, and the `continue` is what
    // stops a stamped row ALSO matching the heuristic below and being listed
    // twice under two different confidence levels.
    if (t.claimDeletedAt !== undefined && t.claimDeletedAt !== null) {
      rows.push({ transfer: t, deletedAt: t.claimDeletedAt, confirmed: true });
      continue;
    }
    if (looksOrphanedByNote(t)) {
      rows.push({ transfer: t, deletedAt: null, confirmed: false });
    }
  }
  // Confirmed rows first (most recent first among them), then the inferred ones,
  // which have no date to sort by — ordered by transfer date so they are stable.
  return rows.sort((a, b) => {
    if (a.confirmed !== b.confirmed) return a.confirmed ? -1 : 1;
    if (a.deletedAt && b.deletedAt) return b.deletedAt.localeCompare(a.deletedAt);
    return (b.transfer.date ?? "").localeCompare(a.transfer.date ?? "");
  });
}

// ---------------------------------------------------------------------------
// Consolidated report (Part 4)
// ---------------------------------------------------------------------------

export interface DataHealthCounts {
  positionSymbol: number;
  claimSymbol: number;
  transferSymbol: number;
  chainMismatch: number;
  claimOutliers: number;
  transferOutliers: number;
  stalePositions: number;
  incompleteClaims: number;
  idleUpside: number;
  driftedClaimTransfers: number;
  orphanedByClaim: number;
  total: number;
}

export interface DataHealthReport {
  positionSymbol: SymbolPairMismatchRow[];
  claimSymbol: ClaimSymbolMismatchRow[];
  transferSymbol: TransferSymbolMismatchRow[];
  chainMismatch: ChainMismatchRow[];
  claimOutliers: OutlierRow[];
  transferOutliers: OutlierRow[];
  stalePositions: StalePositionRow[];
  incompleteClaims: IncompleteClaimRow[];
  driftedClaimTransfers: DriftedClaimTransferRow[];
  orphanedByClaim: OrphanedByClaimRow[];
  idleUpside: IdleUpsideRow[];
  counts: DataHealthCounts;
}

export function computeDataHealth(
  positions: Position[],
  claims: FeeClaim[],
  transfers: Transfer[],
  dismissals: OutlierDismissal[] = [],
  staleDismissals: StalePositionDismissal[] = [],
): DataHealthReport {
  const positionSymbol = findSymbolPairMismatches(positions);
  const claimSymbol = findClaimSymbolMismatches(claims);
  const transferSymbol = findTransferSymbolMismatches(transfers, positions);
  const chainMismatch = findChainMismatches(positions);
  const claimOutliers = findClaimAmountOutliers(claims, positions, dismissals);
  const transferOutliers = findTransferAmountOutliers(
    transfers,
    positions,
    dismissals,
  );
  const stalePositions = findStalePositions(positions, claims, staleDismissals);
  const incompleteClaims = findIncompleteClaims(claims, positions);
  const idleUpside = findIdleUpsideTransfers(transfers, positions);
  const driftedClaimTransfers = findDriftedClaimTransfers(transfers, claims);
  const orphanedByClaim = findOrphanedByClaimDeletion(transfers);
  const counts: DataHealthCounts = {
    positionSymbol: positionSymbol.length,
    claimSymbol: claimSymbol.length,
    transferSymbol: transferSymbol.length,
    chainMismatch: chainMismatch.length,
    claimOutliers: claimOutliers.length,
    transferOutliers: transferOutliers.length,
    stalePositions: stalePositions.length,
    incompleteClaims: incompleteClaims.length,
    idleUpside: idleUpside.length,
    driftedClaimTransfers: driftedClaimTransfers.length,
    orphanedByClaim: orphanedByClaim.length,
    total:
      positionSymbol.length +
      claimSymbol.length +
      transferSymbol.length +
      chainMismatch.length +
      claimOutliers.length +
      transferOutliers.length +
      stalePositions.length +
      incompleteClaims.length +
      idleUpside.length +
      driftedClaimTransfers.length +
      orphanedByClaim.length,
  };
  return {
    positionSymbol,
    claimSymbol,
    transferSymbol,
    chainMismatch,
    claimOutliers,
    transferOutliers,
    stalePositions,
    incompleteClaims,
    driftedClaimTransfers,
    orphanedByClaim,
    idleUpside,
    counts,
  };
}
