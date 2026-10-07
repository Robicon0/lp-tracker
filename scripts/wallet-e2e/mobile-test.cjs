// Mobile / tablet Manage Wallets flow. Usage: node mobile-test.cjs <label> [base]
const pw = require("playwright");
const src = require("fs").readFileSync(__dirname + "/wallet-test.cjs", "utf8");
const mocks = eval("(" + src.slice(src.indexOf("function mocks("), src.indexOf("const results")).trim() + ")");
const LABEL = process.argv[2] || "after", BASE = process.argv[3] || "http://localhost:3000";
const EVM = "0xD99a9e66d000d4024dC77f00f784Cc45F8804F20", SOL = "GndRtybRYe3ShqES4RXpw9hq2MysJRLkjEf99M6PpogC", SUI = "0x8ef8c104d43e55b11fc6afcd58088274fabff2d30480dd4c4283ff834ac2297d";
let pass = 0, total = 0;
const rec = (n, ok, d) => { total++; if (ok) pass++; console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); };
const SEED = {
  "defidesh-evm-addr": EVM,
  "defidesh-solana-addr": SOL, walletName: JSON.stringify("Test Solana Wallet"),
  "defidesh-sui-addr": SUI, "sui-dapp-kit:wallet-connection-info": JSON.stringify({ state: { lastConnectedWalletName: "Test Sui Wallet", lastConnectedAccountAddress: SUI }, version: 0 }),
};
(async () => {
  for (const [devName, engine] of [["iPhone 14", "webkit"], ["iPad (gen 7)", "webkit"], ["Pixel 7", "chromium"]]) {
    const b = await pw[engine].launch();
    const c = await b.newContext({ ...pw.devices[devName] });
    await c.addInitScript(mocks, { sol: true, sui: true, EVM, SOL, SUI });   // EVM stays "locked": restored LAST USED identity
    await c.addInitScript((s) => { if (sessionStorage.getItem("__seeded")) return; sessionStorage.setItem("__seeded", "1"); for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); }, SEED);
    await c.route("**/api/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"positions":[],"count":0}' }));
    const p = await c.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(String(e)));
if (process.env.SHARE) { await p.goto(process.env.SHARE, { waitUntil: "domcontentloaded" }); await p.waitForTimeout(1500); }
    await p.goto(BASE + "/dashboard", { waitUntil: "domcontentloaded" }); await p.waitForTimeout(4000);
    const T = `[${devName}]`;
    const vw = p.viewportSize();
    const chipVisible = await p.locator("nav button[aria-haspopup='menu']").first().isVisible().catch(() => false);
    const open = async () => { await p.locator("button.term-btn", { hasText: /wallets/i }).first().tap(); await p.getByText("Connect Browser Wallet").waitFor(); };
    const rows = async () => { const t = await p.locator("text=Connect Browser Wallet").locator("xpath=..").innerText(); return { evm: /EVM[\s\S]*?CONNECTED/.test(t.split("SOL")[0]), text: t.replace(/\s+/g, " ") }; };
    const connected = async (tag) => (await p.locator("div", { hasText: "● CONNECTED" }).filter({ hasText: tag }).count()) > 0 && !(await p.getByRole("button", { name: new RegExp(`connect ${tag === "SOL" ? "solana" : tag.toLowerCase()} wallet`, "i") }).count());
    await open();
    await p.screenshot({ path: `${__dirname}/shots/${LABEL}-mobile-${devName.replace(/\W+/g, "")}-modal.png` });
    for (const tag of ["EVM", "SOL", "SUI"]) rec(`${T} ${tag} shown as connected in Manage Wallets`, await connected(tag));
    for (const [tag, key, flag] of [["EVM", "defidesh-evm-addr", "defidesh_evm_disconnected"], ["SOL", "defidesh-solana-addr", "defidesh_solana_disconnected"], ["SUI", "defidesh-sui-addr", "defidesh_sui_disconnected"]]) {
      if (!(await connected(tag))) continue;
      const btn = p.locator("div", { hasText: "● CONNECTED" }).filter({ hasText: tag }).last().getByRole("button", { name: /^disconnect$/i });
      const box = await btn.boundingBox();
      rec(`${T} ${tag} Disconnect button is on screen and tappable`, !!box && box.x >= 0 && box.x + box.width <= vw.width + 1 && box.height >= 20, box ? `${Math.round(box.width)}x${Math.round(box.height)} at x=${Math.round(box.x)}` : "no box");
      const rowBox = await btn.locator("xpath=ancestor::div[2]").boundingBox();
      rec(`${T} ${tag} Disconnect button sits inside its row (no overflow)`, !!box && !!rowBox && box.x + box.width <= rowBox.x + rowBox.width + 1 && box.height >= 30, box && rowBox ? `button right=${Math.round(box.x + box.width)} row right=${Math.round(rowBox.x + rowBox.width)} height=${Math.round(box.height)}` : "no box");
      await btn.tap(); await p.waitForTimeout(1000);
      rec(`${T} ${tag} disconnected 1s after tap`, !(await connected(tag)));
      const st = await p.evaluate(([k, f]) => [localStorage.getItem(k), localStorage.getItem(f)], [key, flag]);
      rec(`${T} ${tag} saved address removed + flag set`, st[0] === null && st[1] === "true", `key=${st[0] && st[0].slice(0, 8)} flag=${st[1]}`);
    }
    await p.waitForTimeout(3000);
    for (const tag of ["EVM", "SOL", "SUI"]) rec(`${T} ${tag} still disconnected 4s later`, !(await connected(tag)));
    await p.screenshot({ path: `${__dirname}/shots/${LABEL}-mobile-${devName.replace(/\W+/g, "")}-after.png` });
    await p.reload(); await p.waitForTimeout(4000); await open();
    for (const tag of ["EVM", "SOL", "SUI"]) rec(`${T} ${tag} not restored after reload`, !(await connected(tag)));
    // Reconnect (switch wallet) from the same modal.
    for (const [tag, btn, pick] of [["SOL", /connect solana wallet/i, /test solana wallet/i], ["SUI", /connect sui wallet/i, /test sui wallet/i]]) {
      await p.getByRole("button", { name: btn }).tap(); await p.getByRole("button", { name: pick }).tap(); await p.waitForTimeout(1500);
      rec(`${T} ${tag} can reconnect from Manage Wallets`, await connected(tag));
    }
    rec(`${T} no page errors`, errs.length === 0, errs.join(" ; ").slice(0, 200));
    console.log(`     ${T} viewport ${vw.width}x${vw.height}, engine ${engine}, navbar chip visible: ${chipVisible}`);
    await b.close();
  }
  console.log(`\n[${LABEL}] ${pass}/${total} passed`);
})().catch((e) => { console.error("HARNESS ERROR", String(e).slice(0, 600)); process.exit(2); });
