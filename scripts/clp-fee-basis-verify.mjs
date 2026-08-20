// Verification harness for the CLP fee-basis change (Task A + Task B).
// Loads the REAL calculation functions (no re-implementation) and reports the
// before/after Net P&L fee term plus the Converted Fees breakdown.
//
// Usage:
//   node scripts/clp-fee-basis-verify.mjs                 # built-in sample data
//   node scripts/clp-fee-basis-verify.mjs claims.json     # your exported clp_claims
import createJiti from "jiti";
import { readFileSync } from "node:fs";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const calc = jiti("./../app/clp-tracker/lib/calculations.ts");

const usd = (n) => (n < 0 ? "-$" : "$") + Math.abs(n).toFixed(2);

let claim = (o) => ({
  id: o.id, positionId: "p1", date: o.date ?? "2026-01-01", pair: "X/USDC",
  platform: "aerodrome", chain: "base",
  token1Symbol: o.t1, token1Amount: o.a1,
  token2Symbol: o.t2 ?? "", token2Amount: o.a2 ?? 0,
  convertedToStable: o.converted, stableSymbol: o.converted ? "USDC" : null,
  stableAmount: o.stable, currentPositionValue: null, txId: null, notes: "",
});

// A deliberately representative set: a converted-and-sold volatile claim, a
// mixed claim (volatile still held + USDC leg already realized), and a claim
// still fully held in a volatile token.
const sample = [
  claim({ id: "c1", t1: "ETH", a1: 1, converted: true, stable: 2000 }),   // sold at $2000
  claim({ id: "c2", t1: "SOL", a1: 10, t2: "USDC", a2: 300, converted: false, stable: 1300 }),
  claim({ id: "c3", t1: "ETH", a1: 0.5, converted: false, stable: 1100 }),
];
// Today's prices — ETH has doubled since c1 was sold.
const samplePrices = { ETH: 4000, SOL: 100, USDC: 1 };

const arg = process.argv[2];
const claims = arg ? JSON.parse(readFileSync(arg, "utf8")) : sample;
const prices = arg && process.argv[3]
  ? JSON.parse(readFileSync(process.argv[3], "utf8"))
  : samplePrices;

// ---- Task A: Converted Fees breakdown -------------------------------------
const d = calc.calcConvertedFeesDetail(claims);
console.log("TASK A — Converted Fees breakdown");
console.log("  convertedFees (unchanged total) :", usd(d.convertedFees));
console.log("  convertedFromTokens             :", usd(d.convertedFromTokens));
console.log("  mixedStableRecovered            :", usd(d.mixedStableRecovered));
const sum = d.convertedFromTokens + d.mixedStableRecovered;
console.log("  parts sum                       :", usd(sum),
  Math.abs(sum - d.convertedFees) < 1e-9 ? "✓ identical to total" : "✗ MISMATCH");

// ---- Task B: Net P&L fee term ---------------------------------------------
const before = calc.calcBusinessPnL(claims, prices).allTotal;
const held = calc.calcUnconvertedHoldings(claims, prices, { excludeStables: true }).totalCurrentValue;
const after = calc.calcConvertedFees(claims) + held;
console.log("\nTASK B — Net P&L fee term");
console.log("  BEFORE (calcBusinessPnL.allTotal, every token at today's price):", usd(before));
console.log("  AFTER  (converted realized + still-held non-stable at today's):", usd(after));
console.log("         realized      :", usd(calc.calcConvertedFees(claims)));
console.log("         still held    :", usd(held));
console.log("  DELTA  :", usd(after - before));
