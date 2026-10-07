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
//                                      [--live-tol PCT] [--settle-max MS]
// Prints `VERDICT: PASS` and exits 0 when the figures agree; `VERDICT: FAIL`
// and exit 1 otherwise — safe for CI.
//
// WHAT MUST AGREE, AND HOW EXACTLY (queue ITEM 0f)
//   EXACT, to the cent — everything settled: Total Deposited, Capital G/L, Fees
//     Collected, and every row of the Capital G/L breakdown (closed positions).
//     These are sums over finalized history; any difference is a real defect.
//   WITHIN A TOLERANCE — everything marked to market: Current Value and Net P&L
//     (which contains it). An OPEN position is re-priced at live spot on every
//     load, so these legitimately move by cents between runs. The tolerance is
//     `--live-tol` percent of Current Value (default 1). The earlier version
//     compared them exactly, and also scraped the OPEN-positions table as if it
//     were the breakdown, so a moving live value read as "the position set is
//     unstable" and the verdict could never be green.

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
const LIVE_TOL_PCT = parseFloat(arg("live-tol", "1"));
const SETTLE_MAX_MS = parseInt(arg("settle-max", "180000"), 10); // extra wait while the page still says it is loading

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
  // structurally (a row with >=3 dollar figures) so it does not depend on exact
  // column headings.
  //
  // Row IDENTITY is (index within the table + pair + protocol/chain + the
  // deposited figure), NOT the concatenated cell text. Several rows can share a
  // pair name ("WETH / USDC" appears many times), and the earlier
  // label-only key silently merged them — which under-counted the set and could
  // hide exactly the appear/disappear signal this harness exists to detect.
  const rows = [];
  // The breakdown table marks itself and its rows (`data-testid`,
  // `data-position-id`), so rows are keyed on POSITION IDENTITY and nothing
  // outside the breakdown can be mistaken for one.
  const marked = document.querySelector('table[data-testid="capgl-breakdown"]');
  if (marked) {
    for (const tr of marked.querySelectorAll("tbody tr")) {
      const cells = [...tr.querySelectorAll("td")].map((td) => td.innerText.replace(/\s+/g, " ").trim());
      const dollars = cells.filter((c) => /^[+-]?\$/.test(c));
      const id = tr.getAttribute("data-position-id") || `row-${rows.length}`;
      rows.push({ key: id, pair: cells[0], cells, dollars, estimated: tr.getAttribute("data-estimated") === "1" });
    }
  } else {
    // Fallback for a build that predates the markers: the structural match,
    // restricted to rows that carry a CLOSED date so the open-positions table
    // (whose values move with live price) is not swept in.
    let idx = 0;
    for (const tr of document.querySelectorAll("tr")) {
      const cells = [...tr.querySelectorAll("td")].map((td) => td.innerText.replace(/\s+/g, " ").trim());
      if (cells.length < 7) continue;
      const dollars = cells.filter((c) => /^[+-]?\$/.test(c));
      if (dollars.length < 3) continue;
      if (!/\/|TOKEN|Position/i.test(cells[0])) continue;
      const pair = (cells[0].match(/^[^A-Z]*([A-Za-z0-9.]+ ?\/ ?[A-Za-z0-9.]+)/) || [, cells[0]])[1];
      // Label is itself non-deterministic (ITEM 0c), so the key is the row's
      // index plus its stable deposited figure, never the label.
      rows.push({ key: `#${idx++}|${dollars[0]}`, pair, cells, dollars, estimated: false });
    }
  }

  return {
    deposited: grab(/TOTAL DEPOSITED -?\$[\d,.]+/i),
    current: grab(/CURRENT VALUE -?\$[\d,.]+/i),
    // NOTE: tolerate a leading marker such as the "≈" the UI shows while the
    // total is still incomplete. The first version of this regex required the
    // figure to follow the label immediately and silently scraped null the
    // moment that marker shipped — the gap-detector below caught it, which is
    // precisely why that check exists.
    capitalGL: grab(/CAPITAL G\/L[^$]{0,40}-?\$[\d,.]+/i),
    netPnl: grab(/NET P&L[^$]{0,40}-?\$[\d,.]+/i),
    feesCollected: grab(/FEES COLLECTED[^$]{0,40}-?\$[\d,.]+/i),
    portfolio: grab(/TOTAL PORTFOLIO \S+/i),
    closedHeader: grab(/\d+ CLOSED POSITION/i),
    rowsFromMarkedTable: !!marked,
    rows,
    // Degrade / incompleteness signals the UI is supposed to show.
    degrade: {
      stale: /last-known|showing last/i.test(txt),
      estimated: /\bestimated\b|~\$/i.test(flat),
      excludedNotice: grab(/\d+ position[s]? (?:excluded|could not)/i),
      pending: grab(/\d+ claim[s]? pending/i),
      scanning: /scanning/i.test(txt),
      // NEW: the fix's own signal — Capital G/L declaring itself not-final.
      pricingIncomplete: /incomplete — pricing/i.test(txt) || /≈ *-?\$/.test(flat),
      approximate: grab(/approximate — \d+ positions? priced from estimates/i),
      historyIncomplete: /incomplete — some history couldn.t be loaded/i.test(txt),
      stillLoading: grab(/\d+ positions? still loading|positions still loading|closed history still loading/i),
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
  // A test load must not WRITE to the analytics snapshot store: it is one Redis
  // database shared by production, so a snapshot saved from a test build
  // becomes what real visitors to the same wallet set see first. Reads still go
  // through. The page is told the write succeeded so its own flow is unchanged.
  await ctx.route("**/api/analytics-snapshot", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, testNoWrite: true }) })
      : route.continue(),
  );
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
  // A fixed wait is not a settled page: one slow request leaves "N positions
  // still loading" on screen and the totals partial. Keep waiting (bounded)
  // while the page itself says it is loading; a run that never finishes is
  // reported as such instead of being diffed as if it were a result.
  const LOADING_RE = /still loading|calculating…/i;
  const settleDeadline = Date.now() + SETTLE_MAX_MS;
  let settled = !LOADING_RE.test(await page.evaluate(() => document.body.innerText));
  while (!settled && Date.now() < settleDeadline) {
    await page.waitForTimeout(3000);
    settled = !LOADING_RE.test(await page.evaluate(() => document.body.innerText));
  }

  // PHASE 1 — headline aggregate, read BEFORE expanding. Clicking the Capital
  // G/L cell re-flows the block, which previously made netPnl / feesCollected
  // scrape as null and silently dropped them from the diff.
  const head = await page.evaluate(CAPTURE);

  // PHASE 2 — expand for the per-position breakdown rows only.
  try {
    await page.getByText(/CAPITAL G\/L/i).first().click();
    await page.waitForTimeout(4000);
  } catch {}
  const expanded = await page.evaluate(CAPTURE);

  // Headline numbers come from phase 1; rows from phase 2.
  const cap = { ...head, rows: expanded.rows, rowsFromMarkedTable: expanded.rowsFromMarkedTable };
  const missing = ["deposited", "current", "capitalGL", "netPnl"].filter((f) => !cap[f]);
  if (missing.length) console.log(`   ⚠ capture gap: ${missing.join(", ")} not found — treat this run as unreliable`);
  runs.push({ run: r, ...cap, api, errs, settled });
  if (!settled) console.log(`   ⚠ run ${r} was still loading after ${(SETTLE_MS + SETTLE_MAX_MS) / 1000}s — not a usable reading`);

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

// Settled figures must match to the cent. Marked-to-market figures may differ
// by the live-price tolerance (see the header).
const EXACT_FIELDS = ["deposited", "capitalGL", "feesCollected"];
const LIVE_FIELDS = ["current", "netPnl"];
let varied = false;
const failures = [];
for (const r of runs) if (!r.settled) { varied = true; failures.push(`run ${r.run} never finished loading — inconclusive, not a determinism result`); }
for (const f of EXACT_FIELDS) {
  const vals = runs.map((r) => money(r[f]));
  const uniq = [...new Set(vals.map((v) => (v === null ? "null" : v.toFixed(2))))];
  const ok = uniq.length === 1 && uniq[0] !== "null";
  if (!ok) { varied = true; failures.push(`${f} differs across runs`); }
  const nums = vals.filter((v) => v !== null);
  const spread = nums.length ? (Math.max(...nums) - Math.min(...nums)) : 0;
  console.log(`  ${ok ? "IDENTICAL" : "VARIES ✗ "} ${f.padEnd(14)} ${uniq.join("  |  ")}${spread ? `   spread=$${spread.toFixed(2)}` : ""}   (exact)`);
}
{
  const currents = runs.map((r) => money(r.current)).filter((v) => v !== null);
  const tol = currents.length ? (Math.max(...currents.map(Math.abs)) * LIVE_TOL_PCT) / 100 : 0;
  for (const f of LIVE_FIELDS) {
    const vals = runs.map((r) => money(r[f]));
    const nums = vals.filter((v) => v !== null);
    const spread = nums.length ? (Math.max(...nums) - Math.min(...nums)) : 0;
    const ok = nums.length === vals.length && spread <= tol + 0.005;
    if (!ok) { varied = true; failures.push(`${f} moved $${spread.toFixed(2)}, over the live-price tolerance $${tol.toFixed(2)}`); }
    console.log(`  ${ok ? "WITHIN   " : "VARIES ✗ "} ${f.padEnd(14)} ${vals.map((v) => (v === null ? "null" : v.toFixed(2))).join("  |  ")}   spread=$${spread.toFixed(2)}   (live value, tolerance $${tol.toFixed(2)} = ${LIVE_TOL_PCT}% of Current Value)`);
  }
}
if (runs.some((r) => !r.rowsFromMarkedTable)) {
  console.log(`  ⚠ this build has no marked breakdown table — rows were matched structurally (older build).`);
}

// The decisive diff: did the SET of closed positions change between runs?
console.log(`\n  closed-position SET per run:`);
const sets = runs.map((r) => new Set(r.rows.map((x) => x.key)));
runs.forEach((r, i) => console.log(`    run ${r.run}: ${r.rows.length} rows  [${[...sets[i]].join(" · ") || "none"}]`));
const union = new Set(sets.flatMap((s) => [...s]));
const unstable = [...union].filter((k) => !sets.every((s) => s.has(k)));
if (unstable.length) {
  varied = true; failures.push("the set of closed positions differs across runs");
  console.log(`  ✗ POSITIONS THAT APPEAR IN SOME RUNS BUT NOT OTHERS:`);
  unstable.forEach((k) => console.log(`      ${k}  present in runs: ${sets.map((s, i) => (s.has(k) ? i + 1 : null)).filter(Boolean).join(",")}`));
  console.log(`  => the SET is unstable: an ENUMERATION / degrade problem, not pricing.`);
} else if (union.size) {
  console.log(`  ✓ identical position set across all runs.`);
  // Label (token symbol) drift — real, but a DISPLAY issue, not a set change.
  const labelsByKey = {};
  for (const r of runs) for (const row of r.rows) (labelsByKey[row.key] ||= new Set()).add(row.pair);
  const drifted = Object.entries(labelsByKey).filter(([, v]) => v.size > 1);
  if (drifted.length) {
    console.log(`  ⚠ token-SYMBOL drift (display only, does not affect totals):`);
    drifted.forEach(([k, v]) => console.log(`      ${k}  ->  ${[...v].join("  /  ")}`));
  }
  // Same set but different money => valuation differs per load.
  const perPos = {};
  for (const r of runs) for (const row of r.rows) (perPos[row.key] ||= []).push(row.dollars.join(" | ")); // money only — the label drifts (ITEM 0c)
  const valueUnstable = Object.entries(perPos).filter(([, v]) => new Set(v).size > 1);
  if (valueUnstable.length) {
    varied = true; failures.push("a closed position was valued differently across runs");
    console.log(`  ✗ SAME positions VALUED DIFFERENTLY across runs => a PRICING/valuation problem:`);
    valueUnstable.forEach(([k, v]) => { console.log(`      ${k}`); [...new Set(v)].forEach((x) => console.log(`         ${x}`)); });
  }
}

// ── ITEM 0b REGRESSION GUARD: the deposited === withdrawn fingerprint ──────
// When an activity route substitutes CURRENT SPOT for a cold claim-date
// historical price, it applies the SAME prices to that position's deposits AND
// its withdrawals, so the two sides converge and its Capital G/L collapses
// toward $0. Deposited matching Withdrawn to the cent on a closed position is
// therefore the signature of a spot-substituted valuation, not a coincidence.
//
// The guard is conditional on DISCLOSURE, which is the whole point of the fix:
//   - fingerprint present AND the UI declares the total incomplete  => ⚠ expected,
//     transient; the background retry should resolve it (not a failure).
//   - fingerprint present AND the total renders as FINAL             => ✗ FAIL,
//     the substitution went unreported. This is the ITEM 0b bug returning.
//
// What the fingerprint CANNOT tell apart is a position that really did come out
// at what went in: one deposited and withdrawn entirely in a stablecoin (a
// range parked above/below price) is $1-priced on both sides and matches to the
// cent by construction. So a flat row is a FAILURE only when it is undisclosed
// AND its figures are not reproduced on every run — a substituted basis moves
// with cache warmth, a stablecoin round trip cannot. A flat row that is
// identical on every run is listed for a human to recognise, not failed.
console.log(`\n  deposited===withdrawn fingerprint (ITEM 0b):`);
{
  const flatByKey = {};
  for (const r of runs) {
    for (const row of r.rows) {
      const dep = money(row.dollars[0]), wd = money(row.dollars[1]);
      if (row.dollars.length < 2 || dep === null || dep === 0 || dep !== wd) continue;
      const disclosed = row.estimated || r.degrade?.pricingIncomplete === true;
      (flatByKey[row.key] ||= []).push({ run: r.run, dep, disclosed, pair: row.pair });
    }
  }
  const keys = Object.keys(flatByKey);
  if (!keys.length) console.log(`  ✓ no flat (deposited === withdrawn) closed row in any run.`);
  for (const k of keys) {
    const hits = flatByKey[k];
    const everyRun = hits.length === runs.length;
    const sameFigure = new Set(hits.map((h) => h.dep.toFixed(2))).size === 1;
    const disclosed = hits.every((h) => h.disclosed);
    const stable = everyRun && sameFigure;
    if (!stable && !disclosed) {
      varied = true; failures.push(`flat row ${k} is not reproduced across runs and is not disclosed`);
      console.log(`  ✗ ${k}  dep=wd in runs ${hits.map((h) => h.run).join(",")} of ${runs.length} — changes between loads and rendered as final (ITEM 0b regression).`);
    } else {
      console.log(`  · ${k}  dep = wd = $${hits[0].dep.toFixed(2)} on ${hits.length}/${runs.length} runs${stable ? " — reproduced exactly (consistent with a stablecoin-only round trip)" : " — disclosed as not final"}`);
    }
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
  // Informational: request ORDER and background refreshes vary with timing.
  console.log(`  (the list of API calls differs between runs — informational, not part of the verdict)`);
}

if (JSON_OUT) { fs.writeFileSync(JSON_OUT, JSON.stringify(runs, null, 2)); console.log(`\n  raw capture -> ${JSON_OUT}`); }
if (failures.length) { console.log(`\n  why:`); failures.forEach((f) => console.log(`    - ${f}`)); }
console.log(`\n  VERDICT: ${varied ? "FAIL — NON-DETERMINISTIC ✗" : "PASS — deterministic ✓"}`);
process.exit(varied ? 1 : 0);
