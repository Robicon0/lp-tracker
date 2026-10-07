// REAL wallet extension (Phantom 26.32, throwaway wallet) against a live site.
const { launch, dump, EXT } = require("./reallib.cjs");
const BASE = process.argv[2] || "https://www.defidesh.com";
let pass = 0, total = 0;
const rec = (n, ok, d) => { total++; if (ok) pass++; console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); };
(async () => {
  const c = await launch(false);
  const pop = await c.newPage(); await pop.goto(EXT + "/popup.html"); await pop.waitForTimeout(3000);
  await pop.getByTestId("unlock-form-password-input").fill((process.env.TEST_WALLET_PW || "throwaway-local-only-1!")); await pop.getByTestId("unlock-form-submit-button").click(); await pop.waitForTimeout(3000);
  await c.route("**/api/**", (r) => r.request().url().includes("defidesh.com") || r.request().url().includes("localhost") ? r.fulfill({ status: 200, contentType: "application/json", body: '{"positions":[],"count":0}' }) : r.continue());
  const p = await c.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(String(e)));
  await p.goto(BASE + "/dashboard", { waitUntil: "domcontentloaded" }); await p.waitForTimeout(5000);
  let dumped = false;
  const approve = async () => {
    for (let i = 0; i < 16; i++) {
      const n = c.pages().find((x) => x.url().includes("notification"));
      if (n) { await n.waitForTimeout(1500); if (!dumped) { dumped = true; await dump(n, "real-approve"); }
        const b = n.getByTestId("primary-button"); if (await b.count()) await b.click(); else await n.getByRole("button", { name: /connect|approve|confirm/i }).last().click();
        await p.waitForTimeout(2500); return true; }
      await p.waitForTimeout(500);
    }
    return false;
  };
  const chips = () => p.evaluate(() => { const nav = document.querySelector("nav"); const box = [...nav.querySelectorAll("div")].find((d) => d.className.includes("md:flex") && /no wallet|EVM|SOL|SUI/.test(d.textContent)); return box ? box.textContent.replace(/\s+/g, " ").trim() : "(none)"; });
  const openModal = async () => { if (!(await p.getByText("Connect Browser Wallet").count())) await p.getByRole("button", { name: /add wallet/i }).first().click(); await p.getByText("Connect Browser Wallet").waitFor(); };
  const closeModal = async () => { if (await p.getByText("Connect Browser Wallet").count()) { await p.getByRole("button", { name: "[X]" }).first().click(); await p.waitForTimeout(400); } };
  let tag_ = "";
  const connect = async (btn) => {
    await openModal();
    if (await p.getByRole("button", { name: btn }).count()) {
      await p.getByRole("button", { name: btn }).click(); await p.waitForTimeout(600);
      const pick = p.getByRole("button", { name: /phantom/i });
      if (!(await pick.count())) { console.log("     picker has no Phantom entry:", (await p.locator("text=/CHOOSE_/").locator("xpath=../..").innerText().catch(() => "?")).replace(/\s+/g, " ").slice(0, 200)); return "no-entry"; }
      await pick.last().click();
      const popped = await approve();
      for (let i = 0; i < 20 && !(await p.getByText("● CONNECTED").count() && new RegExp(tag_).test(await chips())); i++) await p.waitForTimeout(500);
      return popped;
    }
    return null;
  };
  const reload = async () => { await p.reload({ waitUntil: "domcontentloaded" }); await p.waitForTimeout(6000); };

  for (const [tag, btn, flag] of [["SOL", /connect solana wallet/i, "defidesh_solana_disconnected"], ["SUI", /connect sui wallet/i, "defidesh_sui_disconnected"], ["EVM", /connect evm wallet/i, "defidesh_evm_disconnected"]]) {
    tag_ = tag;
    const has = async () => new RegExp(tag).test(await chips());
    const before0 = await chips();
    const popped = await connect(btn);
    if (popped !== "no-entry") rec(`${tag} connect with the real extension`, await has(), `${await chips()} (approval window: ${popped}; chips before: ${before0})`);
    if (popped === "no-entry") { console.log(`SKIP  ${tag}: this extension does not offer a ${tag} wallet to the page`); await p.keyboard.press("Escape"); await p.getByRole("button", { name: "[X]" }).first().click().catch(() => {}); await closeModal(); continue; }
    if (!(await has())) { await p.screenshot({ path: `shots/real-${tag}-connect-fail.png` }); await closeModal(); continue; }
    await closeModal();
    await p.screenshot({ path: `shots/real-${tag}-connected.png` });
    // 1) disconnect via navbar chip
    await p.locator("nav button[aria-haspopup='menu']", { hasText: tag }).first().click();
    await p.getByRole("menu").waitFor(); await p.screenshot({ path: `shots/real-${tag}-chip-menu.png` });
    await p.getByRole("menuitem", { name: /disconnect/i }).click(); await p.waitForTimeout(1200);
    rec(`${tag} disconnect via navbar chip`, !(await has()), await chips());
    await reload();
    rec(`${tag} stays disconnected after reload (extension still unlocked)`, !(await has()), await chips());
    // 2) reconnect, reload, disconnect via Manage Wallets
    const pop2 = await connect(btn);
    rec(`${tag} reconnect after chip disconnect`, await has(), `${await chips()} (approval window: ${pop2})`);
    if (!(await has())) await p.screenshot({ path: `shots/real-${tag}-reconnect-fail.png` });
    await closeModal(); await reload();
    rec(`${tag} reconnected wallet persists across reload`, await has(), await chips());
    await openModal();
    if (await has()) await p.locator(`xpath=//span[normalize-space()="${tag}"]/ancestor::div[2]//button[normalize-space()="Disconnect"]`).first().click({ timeout: 5000 }).catch(() => console.log("     no connected row for", tag)); await p.waitForTimeout(1200);
    rec(`${tag} disconnect via Manage Wallets`, !(await has()) && (await p.getByRole("button", { name: btn }).count()) > 0, await chips());
    rec(`${tag} disconnected flag set`, (await p.evaluate((f) => localStorage.getItem(f), flag)) === "true");
    await p.screenshot({ path: `shots/real-${tag}-modal-disconnected.png` });
    await closeModal(); await reload();
    rec(`${tag} stays disconnected after reload`, !(await has()), await chips());
    // 3) reconnect once more
    await connect(btn);
    rec(`${tag} reconnect after Manage Wallets disconnect`, await has(), await chips());
    await closeModal();
  }
  rec("no page errors", errs.length === 0, errs.join(" ; ").slice(0, 300));
  await p.screenshot({ path: "shots/real-final.png" });
  console.log(`\n[real extension @ ${BASE}] ${pass}/${total} passed`);
  await c.close();
})().catch((e) => { console.error("HARNESS ERROR", String(e).slice(0, 700)); process.exit(2); });
