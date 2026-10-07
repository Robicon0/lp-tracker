// Fresh Solana (and Sui) connect on the home hero and the top Navbar. Usage: node sol-connect.cjs <label> [base]
const { chromium } = require("playwright");
const src = require("fs").readFileSync(__dirname + "/wallet-test.cjs", "utf8");
const mocks = eval(("(" + src.slice(src.indexOf("function mocks("), src.indexOf("const results")).trim() + ")").replace('"Test Solana Wallet"', '"Phantom"')); void ("(" + src.slice(src.indexOf("function mocks("), src.indexOf("const results")).trim() + ")");
const LABEL = process.argv[2] || "after", BASE = process.argv[3] || "http://localhost:3000";
const SOL = "GndRtybRYe3ShqES4RXpw9hq2MysJRLkjEf99M6PpogC", SUI = "0x8ef8c104d43e55b11fc6afcd58088274fabff2d30480dd4c4283ff834ac2297d";
let pass = 0, total = 0;
const rec = (n, ok, d) => { total++; if (ok) pass++; console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); };
(async () => {
  const b = await chromium.launch();
  for (const [name, url, openBtn] of [["hero", "/", /^SOLANA/i], ["navbar", "/watched", /connect solana/i]]) {
    const c = await b.newContext({ viewport: { width: 1440, height: 900 } });
    await c.addInitScript(mocks, { sol: true, sui: true, EVM: "", SOL, SUI });
    await c.route("**/api/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"positions":[],"count":0}' }));
    const p = await c.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(String(e)));
if (process.env.SHARE) { await p.goto(process.env.SHARE, { waitUntil: "domcontentloaded" }); await p.waitForTimeout(1500); }
    await p.goto(BASE + url, { waitUntil: "domcontentloaded" }); await p.waitForTimeout(3000);
    const shown = async () => (await p.locator("body").innerText()).includes("GndR");
    let clicks = 0;
    for (; clicks < 3 && !(await shown()); ) {
      clicks++;
      const open = name === "hero" ? p.locator(".hwc-chips button", { hasText: "SOLANA" }).first() : p.getByRole("button", { name: openBtn }).first();
      if (!(await open.count())) break;
      await open.click(); await p.waitForTimeout(400);
      const pick = p.getByRole("button", { name: /phantom/i }).last();
      if (await pick.count()) await pick.click();
      await p.waitForTimeout(1800);
    }
    rec(`${name}: Solana connects on the FIRST attempt`, (await shown()) && clicks === 1, `shown=${await shown()} attempts=${clicks}`);
    await p.screenshot({ path: `${__dirname}/shots/${LABEL}-solconnect-${name}.png` });
    if (await shown()) {
      await p.reload(); await p.waitForTimeout(3500);
      rec(`${name}: Solana persists across reload`, await shown());
    }
    rec(`${name}: no page errors`, errs.length === 0, errs.join(" ; ").slice(0, 200));
    await c.close();
  }
  await b.close(); console.log(`\n[${LABEL}] ${pass}/${total} passed`);
})();
