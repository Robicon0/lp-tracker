// Where a transfer's money currently sits — the single source of truth for the
// four money states, moved here from app/transfers/page.tsx so non-UI code
// (Data Health) can ask the same question the Transfers page asks without
// importing a client page or, worse, re-deriving the test a second way.
// Available Balance is built from exactly these predicates, so any second
// definition would eventually disagree with the balance itself (Invariant #6).
//
// Every transfer is in exactly ONE of four states, and the predicates below are
// mutually exclusive BY CONSTRUCTION (each re-tests the states above it in the
// precedence order). That is what makes it impossible for a single amount to be
// subtracted from Available Balance twice — the reason the order is written out
// rather than left implicit:
//
//   1. Expense     — moneyStatus "expense": the money has left the business.
//   2. Deployed    — deployedToPositionId set: it now lives inside a position.
//   3. Transferred — a non-blank Platform: sent somewhere for yield (AAVE …).
//   4. Idle        — none of the above: still sitting in Available Balance.
//
// "Transferred" is DERIVED from platform rather than stored as a new flag: the
// Platform field already means "this money is sitting at X", the Edit form has
// always written it, and a derived state needs no schema change and no
// migration.
//
// Note the states are keyed off platform/deploy-link, NOT off moneyStatus
// "redeployed" specifically: an idle Undeployed Tokens transfer carries an
// UNSET moneyStatus (d20f3e3) and must be able to reach Transferred too.

import type { Transfer } from "./types";

export function isExpensedTransfer(t: Transfer): boolean {
  return t.moneyStatus === "expense";
}

export function isDeployedTransfer(t: Transfer): boolean {
  return !isExpensedTransfer(t) && t.deployedToPositionId !== undefined;
}

export function isTransferredToPlatform(t: Transfer): boolean {
  return (
    !isExpensedTransfer(t) &&
    !isDeployedTransfer(t) &&
    (t.platform ?? "").trim() !== ""
  );
}

// Money that has not gone anywhere: not spent, not inside a position, not
// parked at a platform. The fourth state, stated once so callers don't spell
// out "!a && !b && !c" and risk drifting from the precedence above.
export function isIdleTransfer(t: Transfer): boolean {
  return (
    !isExpensedTransfer(t) &&
    !isDeployedTransfer(t) &&
    !isTransferredToPlatform(t)
  );
}
