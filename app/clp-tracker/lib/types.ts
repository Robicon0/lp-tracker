export interface Position {
  id: string;
  pair: string;
  chain: string;
  protocol: string;
  entryDatetime: string;
  exitDatetime: string | null;
  deposited: number;
  currentBalance: number;
  newFees: number;
  claimed: number;
  totalFees: number;
  bottomRange: number;
  topRange: number;
  token1Symbol: string;
  token2Symbol: string;
  token1Count: number;
  token2Count: number;
  entryPrice: number;
  shortDateStart: string | null;
  shortDateEnd: string | null;
  shortTokenAmount: number | null;
  shortUsdAmount: number | null;
  shortGain: number | null;
  shortLoss: number | null;
  shortFundingFees: number | null;
  shortTotal: number | null;
  shortNotes: string | null;
  outOfRangeUpside: number | null;
  outOfRangeDownside: number | null;
  scalp: number | null;
  txLink: string | null;
  // Explorer link for the CLOSING transaction, mirroring txLink which covers
  // the opening one. Optional; absent on positions closed before this existed.
  closeTxLink?: string | null;
  notes: string;
  status: "active" | "closed";
}

export interface FeeClaim {
  id: string;
  positionId: string;
  date: string;
  pair: string;
  platform: string;
  chain: string;
  token1Symbol: string;
  token1Amount: number;
  token2Symbol: string;
  token2Amount: number;
  convertedToStable: boolean;
  stableSymbol: string | null;
  stableAmount: number | null;
  currentPositionValue: number | null;
  txId: string | null;
  notes: string;
}

export interface Transfer {
  id: string;
  positionId: string;
  date: string;
  token: string;
  amount: number;
  platform: string;
  // Where the money was moved TO (the sheet's TRANSFER column, e.g.
  // "RAKA TEZ", "AAVE BASE"). Optional — legacy records default to "".
  destination: string;
  // "expense" is a position-less category: money that has genuinely left the
  // business (rent, fees, etc.). It carries positionId "" and moneyStatus
  // "expense", and is created only via the dedicated Log Expense flow — the
  // position-linked automation (fees/undeployed/outOfRangeUpside) never uses it.
  transferType: "fees" | "undeployed" | "outOfRangeUpside" | "expense";
  // Whether the money is still working in the LP business ("redeployed", e.g.
  // moved to AAVE) or has genuinely left it ("expense", e.g. rent). Only
  // expenses reduce Overall P&L.
  //
  // Deliberately optional rather than backfilled: undefined means "logged
  // before expense tracking existed and never reviewed". It is treated
  // exactly as "redeployed" by every calculation, so legacy data can never
  // manufacture a loss, while still being countable for the review prompt.
  // Saving a transfer through the form always writes an explicit value.
  moneyStatus?: "redeployed" | "expense";
  // Idempotency links back to the event that auto-created this Transfer, so a
  // future save/backfill can tell "this claim/close already has an auto
  // transfer" without the fragile position+day+type heuristic. Both optional
  // and absent on manually-created and legacy records — their presence is the
  // signal that automation, not a person, made the row.
  sourceClaimId?: string;
  sourceCloseId?: string;
  // "Mark as deployed" linking: when Redeployed money is actually put into an
  // LP position, the transfer is tagged with that position id (and the date it
  // was linked). Additive/optional — absent on every existing record. A tagged
  // transfer stays visible in the list but is excluded from Available Balance
  // (the money now lives inside that position's Deposited, entered separately).
  deployedToPositionId?: string;
  deployedAt?: string;
  // Soft delete. Deleting a transfer sets this ISO timestamp instead of
  // removing the record: the row leaves every list, total and balance exactly
  // as if it were gone, but keeps all its data (platform, deploy-link,
  // sourceClaimId …) so Restore can bring it back untouched. There is no
  // automatic expiry — this is financial history. Only the explicit
  // "Permanently delete" action in Recently Deleted actually erases a record.
  // Absent on every live and legacy transfer; getTransfers() hides any record
  // that has it, and getAllTransfers() is the only reader that sees them.
  deletedAt?: string;
  // Set when this transfer's source fee claim was DELETED while the transfer
  // had already been sent, deployed or expensed. That money really moved, so
  // the record is kept and only its sourceClaimId is dropped (93719c5) — this
  // timestamp is what stops the unlink being silent, feeding the Data Health
  // "claim deleted" check until the user edits the transfer, which clears it.
  // Absent on every other transfer, including ones whose claim never existed.
  claimDeletedAt?: string;
  // Split (opt-in, per transfer): one transfer broken into a stablecoin piece
  // and a token piece so each can be expensed / platformed / deployed on its
  // own. Both are DISPLAY/traceability only — no automation, balance or Data
  // Health check reads them, which is the point: a split piece must behave like
  // an ordinary manual transfer everywhere else. Note that sourceClaimId is
  // deliberately NOT carried onto the pieces (see applyTransferSplit).
  splitFromClaimId?: string;
  splitPart?: "stable" | "token";
  // The id of the transfer this piece was split OUT of. Doubles as the group
  // key (both pieces share it) and as the restore target for Undo Split — the
  // original is soft-deleted, not erased, so undo is "delete the pieces, put
  // the original back" rather than any kind of merge.
  splitOriginalId?: string;
  notes: string;
}

// Money taken OUT of the business for personal/other use (Sprint 10).
// Distinct from Transfer (which moves money between protocols/destinations
// but keeps it in the business). Withdrawals draw down Available Balance;
// Lifetime Earned (Σ transfers) is never reduced by them.
export interface Withdrawal {
  id: string;
  date: string;
  amount: number;
  method: string;
  notes: string;
}

// A user's "I checked this, it's correct" dismissal of an outlier flag. Keyed
// by record kind+id AND the exact amount at confirmation time, so a later edit
// that changes the amount no longer matches and the record is re-flagged for
// review (Part 1 re-trigger rule).
export interface OutlierDismissal {
  kind: "claim" | "transfer";
  id: string;
  amount: number;
}

// A user's "I've looked at this, it's fine as-is" dismissal of a stale-position
// flag. Keyed by position AND the exact lastActivity at dismissal time, the
// same re-trigger rule as OutlierDismissal: logging a new claim moves
// lastActivity, so the dismissal stops matching and the position is watched
// again from that point (and can go stale a second time later).
export interface StalePositionDismissal {
  positionId: string;
  lastActivity: string;
}

export interface LPRange {
  id: string;
  positionId: string;
  pair: string;
  entryPrice: number;
  bottomRange: number;
  topRange: number;
  token1Symbol: string;
  token2Symbol: string;
  token1Count: number;
  token2Count: number;
  entryDatetime: string;
}

export interface PoolPnLEntry {
  id: string;
  positionId: string;
  pair: string;
  chain: string;
  protocol: string;
  shortDateStart: string | null;
  shortDateEnd: string | null;
  shortTokenAmount: number | null;
  shortUsdAmount: number | null;
  shortGain: number | null;
  shortLoss: number | null;
  shortFundingFees: number | null;
  shortTotal: number | null;
  shortNotes: string | null;
  outOfRangeUpside: number | null;
  outOfRangeDownside: number | null;
  entryDatetime: string;
}

export interface AppSettings {
  transfersEnabled: boolean;
  currency: "USD";
  // Real capital the business started with. Manually entered, never derived
  // from position records, and never changed automatically.
  initialCapital: number;
  // Personal monthly earning goal, as a percentage of initialCapital (e.g. 4
  // means "4% a month"). Manually entered; 0 means "no target set yet" and the
  // Growth Target card prompts instead of computing against zero.
  targetMonthlyPercent: number;
}

export interface PortfolioSummary {
  totalDeposited: number;
  totalCurrentValue: number;
  totalFees: number;
  totalProfit: number;
  averageAPR: number;
  activePositions: number;
  closedPositions: number;
}
