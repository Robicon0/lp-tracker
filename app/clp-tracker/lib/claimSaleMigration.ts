import { claimStableFace } from "./calculations";
import type { FeeClaim, Transfer } from "./types";

// One-time correction for claims that were sold BEFORE `sale` existed.
//
// The old applyTokenSale overwrote a claim's stableAmount with the sale price,
// so the claim-time value — the actual fee income — was destroyed on the claim
// record. It survives in ONE place: the transfer that was auto-created from the
// claim at the old value and never updated. That transfer is what this reads.
//
// Everything here is PURE. The dry run and the write share one planner, so what
// the preview shows is exactly what gets written — there is no second code path
// that could disagree with the thing the user approved.

export interface ClaimSaleFix {
  claim: FeeClaim;
  // What the claim currently says (the sale price, wrongly stored as fee value).
  currentStableAmount: number;
  // What it was worth at claim time, recovered from the linked transfer.
  claimTimeValue: number;
  // The sale that actually happened, reconstructed.
  quantity: number;
  proceeds: number;
  pricePerToken: number;
  gain: number;
}

export interface ClaimSaleMigrationPlan {
  fixes: ClaimSaleFix[];
  claimTimeTotal: number;
  currentTotal: number;
  gainTotal: number;
  positionsAffected: number;
  // Price clusters that evidence a bulk sale, for the preview to show its work.
  clusters: { token: string; pricePerToken: number; claims: number; dates: number }[];
}

const STABLE = new Set([
  "USDC", "USDT", "DAI", "USDC.E", "USDBC", "USDE",
  "USD0", "USDS", "FRAX", "LUSD", "GUSD", "PYUSD",
]);

function volatileSide(c: FeeClaim): { symbol: string; amount: number } | null {
  const sides = [
    { symbol: (c.token1Symbol || "").toUpperCase(), amount: Number(c.token1Amount || 0) },
    { symbol: (c.token2Symbol || "").toUpperCase(), amount: Number(c.token2Amount || 0) },
  ].filter((s) => s.symbol !== "" && s.amount > 0 && !STABLE.has(s.symbol));
  // Only a single-volatile claim can be apportioned without guessing. A
  // two-token claim's split is ambiguous and is deliberately left alone.
  return sides.length === 1 ? sides[0] : null;
}

// A SALE re-values claims from MANY DIFFERENT dates at ONE exact price. Two
// claims on the SAME date sharing a price is just that day's price, and
// flagging those would mislabel ordinary claim-time valuation as a sale. The
// distinct-date test is what separates the two, and it is why this needs a
// threshold rather than "any repeated price".
const MIN_DISTINCT_DATES = 3;

export function planClaimSaleMigration(
  claims: FeeClaim[],
  transfers: Transfer[],
): ClaimSaleMigrationPlan {
  const transferByClaim = new Map<string, Transfer>();
  for (const t of transfers) {
    if (t.deletedAt !== undefined) continue;
    if (t.sourceClaimId === undefined) continue;
    transferByClaim.set(t.sourceClaimId, t);
  }

  // Group converted claims by (token, implied price per token).
  const groups = new Map<string, { claim: FeeClaim; qty: number; price: number }[]>();
  for (const c of claims) {
    if (c.convertedToStable !== true) continue;
    if (c.sale !== undefined) continue; // already migrated — idempotent
    const total = c.stableAmount;
    if (total === null || !Number.isFinite(total)) continue;
    const vol = volatileSide(c);
    if (!vol) continue;
    const price = (total - claimStableFace(c)) / vol.amount;
    if (!Number.isFinite(price) || price <= 0) continue;
    const key = `${vol.symbol}@${price.toFixed(2)}`;
    const list = groups.get(key) ?? [];
    list.push({ claim: c, qty: vol.amount, price });
    groups.set(key, list);
  }

  const fixes: ClaimSaleFix[] = [];
  const clusters: ClaimSaleMigrationPlan["clusters"] = [];
  for (const [key, list] of groups) {
    const dates = new Set(list.map((x) => String(x.claim.date).slice(0, 10)));
    if (dates.size < MIN_DISTINCT_DATES) continue;
    const [token, priceStr] = key.split("@");
    clusters.push({
      token,
      pricePerToken: Number(priceStr),
      claims: list.length,
      dates: dates.size,
    });
    for (const { claim, qty } of list) {
      const t = transferByClaim.get(claim.id);
      // No linked transfer means the claim-time value is not recoverable. It is
      // left exactly as it is rather than guessed at — a wrong fee figure is
      // worse than an uncorrected one.
      if (!t || !Number.isFinite(t.amount)) continue;
      const currentStableAmount = claim.stableAmount as number;
      const claimTimeValue = t.amount;
      const face = claimStableFace(claim);
      const proceeds = currentStableAmount - face;
      if (!(proceeds > 0)) continue;
      fixes.push({
        claim,
        currentStableAmount,
        claimTimeValue,
        quantity: qty,
        proceeds,
        pricePerToken: proceeds / qty,
        gain: currentStableAmount - claimTimeValue,
      });
    }
  }

  fixes.sort((a, b) => Math.abs(b.gain) - Math.abs(a.gain));
  return {
    fixes,
    claimTimeTotal: fixes.reduce((s, f) => s + f.claimTimeValue, 0),
    currentTotal: fixes.reduce((s, f) => s + f.currentStableAmount, 0),
    gainTotal: fixes.reduce((s, f) => s + f.gain, 0),
    positionsAffected: new Set(fixes.map((f) => f.claim.positionId)).size,
    clusters: clusters.sort((a, b) => b.claims - a.claims),
  };
}

// Applies a plan, returning the NEW claims array. Pure — the caller owns the
// write, the same shape as applyTokenSale.
//
// `sale.date` is "" on every record this produces: the sale date was never
// stored and cannot be recovered from anything the app kept. An invented date
// would be a fabricated fact sitting in a money record, so the field states
// "not recorded" and the UI says so.
export function applyClaimSaleMigration(
  claims: FeeClaim[],
  plan: ClaimSaleMigrationPlan,
): FeeClaim[] {
  const byId = new Map(plan.fixes.map((f) => [f.claim.id, f]));
  return claims.map((c) => {
    const f = byId.get(c.id);
    if (f === undefined) return c;
    return {
      ...c,
      stableAmount: f.claimTimeValue,
      sale: {
        date: "",
        pricePerToken: f.pricePerToken,
        quantity: f.quantity,
        proceeds: f.proceeds,
      },
    };
  });
}
