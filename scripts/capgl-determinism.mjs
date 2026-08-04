#!/usr/bin/env node
// Capital G/L determinism harness (queue ITEM 0).
//
// WHY THIS EXISTS
// The same wallet, on the same build, produced different money across two page
// loads: Account 1's Capital G/L swung $1,053 (~33%) and Net P&L flipped sign,
// with no banner and no exclusion notice on either load. Nothing in the repo
// could have caught that — every verification to date read the number ONCE.
// This harness reads it N times and diffs, so a non-deterministic aggregate is
// a failing check rather than a coincidence someone happens to notice.
//
// It captures, per load:
//   • the headline aggregate (Deposited / Current / Capital G/L / Net P&L)
//   • the EXACT set of closed positions in the Capital G/L breakdown, with each
//     one's deposited / withdrawn / G/L  ← this is what identifies the cause
//   • degrade signals (stale / estimated / excluded / pending / scanning text)
//   • which /api routes were called and what they returned
//
// The per-position SET is the payload: if the totals differ, diffing the sets
// says whether positions appeared/vanished between runs (an enumeration or
// degrade problem) or whether the same positions were valued differently (a
// pricing problem). That distinction is the whole diagnosis.
//
// USAGE
//   node scripts/capgl-determinism.mjs [--runs N] [--wallet 0x..] [--base URL]
//                                      [--settle MS] [--json out.json]
// Exit code 1 if any monetary total varies across runs — safe for CI.

import { createRequire } from "module";
const require = createRequire("/Users/johnnyarya/lp-tracker-fresh/package.json");
const { chromium } = require("playwright");
import fs from "fs";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const RUNS = parseInt(arg("runs", "3"), 10);
const WALLET = arg("wallet", "0xD99a9e66d000d4024dC77f00f784Cc45F8804F20"); // Account 1
const BASE = arg("base", "https://defidesh.com");
const SETTLE_MS = parseInt(arg("settle", "150000"), 10);
const JSON_OUT = arg("json", "");

const money = (s) => {
  if (!s) return null;
  const m = String(s).match(/-?\$[\d,]+\.\d\d|-?\$[\d,]+/);
  if (!m) return null;
  return parseFloat(m[0].replace(/[$,]/g, ""));
};

// Runs inside the page. Scrapes the aggregate + the expanded Capital G/L
// breakdown (the per-closed-position table) + any degrade wording.
const CAPTURE = () => {
  const txt = document.body.innerText;
  const flat = txt.replace(/\s+/g, " ");
  const grab = (re) => { const m = flat.match(re); return m ? m[0] : null; };

  // Per-closed-position rows from the Capital G/L breakdown table. Matched
  // structurally (a row containing a pair and >=3 dollar figures) so it does
  // not depend on exact column headings.
  const rows = [];
  for (const tr of document.querySelectorAll("tr")) {
    const cells = [...tr.querySelectorAll("td")].map((td) => td.innerText.replace(/\s+/g, " ").trim());
    if (cells.length < 4) continue;
    const dollars = cells.filter((c) => /^-?\$/.test(c));
    if (dollars.length < 3) continue;
    if (!/\/|TOKEN|Position/i.test(cells[0])) continue;
    rows.push({ label: cells[0], cells });
  }

  return {
    deposited: grab(/TOTAL DEPOSITED -?\$[\d,.]+/i),
    current: grab(/CURRENT VALUE -?\$[\d,.]+/i),
    capitalGL: grab(/CAPITAL G\/L(?: .)? ?. -?\$[\d,.]+/i),
    netPnl: grab(/NET P&L -?\$[\d,.]+/i),
    feesCollected: grab(/FEES COLLECTED -?\$[\d,.]+/i),
    portfolio: grab(/TOTAL PORTFOLIO \S+/i),
    closedHeader: grab(/\d+ CLOSED POSITION/i),
    rows,
    // Degrade / incompleteness signals the UI is supposed to show.
    degrade: {
      stale: /last-known|showing last/i.test(txt),
      estimated: /\bestimated\b|~\$/i.test(flat),
      excludedNotice: grab(/\d+ position[s]? (?:excluded|could not)/i),
      pending: grab(/\d+ claim[s]? pending/i),
      scanning: /scanning/i.test(txt),
      calculating: /calculating/i.test(txt),
    },
  };
};

const b = await chromium.launch();
const runs = [];

for (let r = 1; r <= RUNS; r++) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 1600 } });
  await ctx.addInitScript((a) => {
    try {
      localStorage.setItem("lp-watched-wallets", JSON.stringify([{ address: a, chain: "evm", label: "det" }]));
    } catch (e) {}
  }, WALLET);
  const page = await ctx.newPage();

  const api = [];
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).slice(0, 120)));
  page.on("response", async (res) => {
    const u = res.url();
    if (!u.includes("/api/")) return;
    const path = u.split("/api/")[1].split("?")[0];
    let summary = "";
    try {
      const ct = res.headers()["content-type"] || "";
      if (ct.includes("json")) {
        const j = await res.json();
        if (Array.isArray(j?.positions)) summary = `pos=${j.positions.length}`;
        else if (Array.isArray(j?.events)) summary = `ev=${j.events.length}`;
        else if (typeof j?.count === "number") summary = `count=${j.count}`;
        if (Array.isArray(j?.excluded) && j.excluded.length) summary += ` excl=${j.excluded.length}`;
      }
    } catch {}
    api.push({ path, status: res.status(), summary });
  });

  await page.goto(`${BASE}/analytics`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(SETTLE_MS);
  // Expand the Capital G/L breakdown so the per-position rows render.
  try {
    await page.getByText(/CAPITAL G\/L/i).first().click();
    await page.waitForTimeout(4000);
  } catch {}

  const cap = await page.evaluate(CAPTURE);
  runs.push({ run: r, ...cap, api, errs });

  console.log(`\n── run ${r} ─────────────────────────────────────────`);
  console.log(`   ${cap.deposited} | ${cap.current}`);
  console.log(`   ${cap.capitalGL} | ${cap.netPnl}`);
  console.log(`   closed rows captured: ${cap.rows.length}`);
  console.log(`   degrade: ${JSON.stringify(cap.degrade)}`);
  console.log(`   pageErrors: ${errs.length}`);

  await ctx.close();
}
await b.close();

// ── Diff ────────────────────────────────────────────────────────────────
console.log(`\n══════════ DETERMINISM REPORT (${RUNS} identical loads) ══════════`);
console.log(`wallet ${WALLET}   base ${BASE}`);

const FIELDS = ["deposited", "current", "capitalGL", "netPnl", "feesCollected"];
let varied = false;
for (const f of FIELDS) {
  const vals = runs.map((r) => money(r[f]));
  const uniq = [...new Set(vals.map((v) => (v === null ? "null" : v.toFixed(2))))];
  const ok = uniq.length === 1;
  if (!ok) varied = true;
  const nums = vals.filter((v) => v !== null);
  const spread = nums.length ? (Math.max(...nums) - Math.min(...nums)) : 0;
  console.log(`  ${ok ? "STABLE  " : "VARIES ✗"} ${f.padEnd(14)} ${uniq.join("  |  ")}${spread ? `   spread=$${spread.toFixed(2)}` : ""}`);
}

// The decisive diff: did the SET of closed positions change between runs?
console.log(`\n  closed-position SET per run:`);
const sets = runs.map((r) => new Set(r.rows.map((x) => x.label)));
runs.forEach((r, i) => console.log(`    run ${r.run}: ${r.rows.length} rows  [${[...sets[i]].join(" · ") || "none"}]`));
const union = new Set(sets.flatMap((s) => [...s]));
const unstable = [...union].filter((k) => !sets.every((s) => s.has(k)));
if (unstable.length) {
  varied = true;
  console.log(`  ✗ POSITIONS THAT APPEAR IN SOME RUNS BUT NOT OTHERS:`);
  unstable.forEach((k) => console.log(`      ${k}  present in runs: ${sets.map((s, i) => (s.has(k) ? i + 1 : null)).filter(Boolean).join(",")}`));
  console.log(`  => the SET is unstable: an ENUMERATION / degrade problem, not pricing.`);
} else if (union.size) {
  console.log(`  ✓ identical position set across all runs.`);
  // Same set but different money => valuation differs per load.
  const perPos = {};
  for (const r of runs) for (const row of r.rows) (perPos[row.label] ||= []).push(row.cells.join(" | "));
  const valueUnstable = Object.entries(perPos).filter(([, v]) => new Set(v).size > 1);
  if (valueUnstable.length) {
    varied = true;
    console.log(`  ✗ SAME positions VALUED DIFFERENTLY across runs => a PRICING/valuation problem:`);
    valueUnstable.forEach(([k, v]) => { console.log(`      ${k}`); [...new Set(v)].forEach((x) => console.log(`         ${x}`)); });
  }
}

// API-call diff — a differing call set points at the enumeration layer.
console.log(`\n  /api call counts per run:`);
const apiKey = (r) => r.api.map((a) => a.path).sort().join(",");
runs.forEach((r) => {
  const counts = {};
  for (const a of r.api) counts[a.path] = (counts[a.path] || 0) + 1;
  console.log(`    run ${r.run}: ${Object.entries(counts).map(([k, v]) => `${k}×${v}`).join("  ")}`);
});
if (new Set(runs.map(apiKey)).size > 1) {
  console.log(`  ✗ the SET of API calls differs between runs.`);
}

if (JSON_OUT) { fs.writeFileSync(JSON_OUT, JSON.stringify(runs, null, 2)); console.log(`\n  raw capture -> ${JSON_OUT}`); }
console.log(`\n  VERDICT: ${varied ? "NON-DETERMINISTIC ✗" : "deterministic ✓"}`);
process.exit(varied ? 1 : 0);
