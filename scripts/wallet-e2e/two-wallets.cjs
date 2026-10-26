// Two EVM extensions on one site: the chosen wallet must stick.
//
// Usage: node scripts/wallet-e2e/two-wallets.cjs [base]   (default http://localhost:3000)
//
// Simulates wallet A (Rabby-style: window.ethereum + EIP-6963 io.rabby) and
// wallet B (Phantom-style: window.phantom.ethereum + EIP-6963 app.phantom).
// B "trusts the site" without an EVM Connect click, as a multi-chain wallet
// does once its Solana side has been connected. Every /api call is answered
// locally: no upstream load and no write to the shared store.
//
// The rule under test (wallet-security Rule 1):
//   - the EVM identity comes ONLY from the connector picked in a Connect dialog;
//   - a Solana-only / Sui-only connect never brings an EVM account in;
//   - the disconnect flag is cleared only by a Connect pick.
// Exit code 1 if any check fails.
const { chromium } = require("playwright");
const SOL_A1 = require("../localWallets.cjs").account1().solana; // .local/wallets.json
const BASE = process.argv[2] || "http://localhost:3000";
// Throwaway test addresses. A1/A2 belong to wallet A, B1 to wallet B.
const A1 = "0xAaAaAaaAaAAAAaAAaaAAAaAaAAaaAAaAaAAA0F20";
const A2 = "0xa2A2a2a2a2A2a2A2A2a2A2a2A2a2a2A2a2a2A222";
const B1 = "0xb1B1B1b1b1B1B1b1b1B1B1b1B1B1b1b1B1B1F23c";

function sim() {
  let cfg = {};
  try { cfg = JSON.parse(localStorage.getItem("__sim") || "{}"); } catch (e) {}
  const save = () => { try { localStorage.setItem("__sim", JSON.stringify(cfg)); } catch (e) {} };
  const icon = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=";
  const mk = (flag, w) => {
    const L = {};
    const accounts = () => (w.state === "open" ? [w.addr] : []);
    return {
      [flag]: true,
      request: async ({ method }) => {
        if (method === "eth_accounts") return accounts();
        if (method === "eth_chainId") return "0x1";
        if (method === "eth_requestAccounts") { w.state = "open"; if (w.next) { w.addr = w.next; delete w.next; } save(); return accounts(); }
        if (method === "wallet_requestPermissions") {
          // The wallet's own account picker: `next` is what the user picks in it.
          w.state = "open"; if (w.next) { w.addr = w.next; delete w.next; } save();
          return [{ parentCapability: "eth_accounts", caveats: [{ type: "restrictReturnedAccounts", value: accounts() }] }];
        }
        const e = new Error("unsupported " + method); e.code = 4200; throw e;
      },
      on: (e, f) => { (L[e] ||= []).push(f); },
      removeListener: (e, f) => { L[e] = (L[e] || []).filter((x) => x !== f); },
      __emit: (e, a) => (L[e] || []).slice().forEach((f) => { try { f(a); } catch (x) {} }),
    };
  };
  const announce = (rdns, name, provider) => {
    const detail = Object.freeze({ info: { uuid: rdns + "-uuid", name, icon, rdns }, provider });
    const go = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail }));
    window.addEventListener("eip6963:requestProvider", go); go();
  };
  const api = {};
  if (cfg.a) {
    const p = mk("isRabby", cfg.a); window.ethereum = p; announce("io.rabby", "Rabby Wallet", p);
    api.aUnlock = () => { cfg.a.state = "open"; save(); p.__emit("accountsChanged", [cfg.a.addr]); p.__emit("connect", { chainId: "0x1" }); };
    api.aLock = () => { cfg.a.state = "closed"; save(); p.__emit("accountsChanged", []); };
    api.aSwitchAccount = (addr) => { cfg.a.addr = addr; cfg.a.state = "open"; save(); p.__emit("accountsChanged", [addr]); };
    api.aNextPick = (addr) => { cfg.a.next = addr; save(); };
  }
  if (cfg.b) {
    const p = mk("isPhantom", cfg.b); window.phantom = { ethereum: p }; announce("app.phantom", "Phantom", p);
    api.bTrust = () => { cfg.b.state = "open"; save(); p.__emit("accountsChanged", [cfg.b.addr]); p.__emit("connect", { chainId: "0x1" }); };
  }
  window.__w = api;
}

const short = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : String(a));
const results = [];
function check(id, what, pass, observed) {
  results.push({ id, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${id}  ${what}\n        observed: ${observed}`);
}

(async () => {
  const browser = await chromium.launch();
  const open = async (seed) => {
    const c = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await c.addInitScript((s) => {
      if (sessionStorage.getItem("__seeded")) return;
      sessionStorage.setItem("__seeded", "1");
      for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v);
    }, seed);
    await c.addInitScript(sim);
    await c.route("**/api/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"positions":[],"count":0}' }));
    const p = await c.newPage();
    const errs = [];
    p.on("pageerror", (e) => errs.push(String(e).slice(0, 140)));
    if (process.env.SHARE) { await p.goto(process.env.SHARE, { waitUntil: "domcontentloaded" }); await p.waitForTimeout(1500); }
    return { c, p, errs };
  };
  const load = async (p, ms = 3500) => {
    await p.goto(BASE + "/dashboard", { waitUntil: "domcontentloaded", timeout: 120000 });
    await p.waitForSelector("nav");
    await p.waitForTimeout(ms);
  };
  // What the page shows and what it has saved.
  const read = (p) => p.evaluate(() => {
    const nav = document.querySelector("nav");
    const chip = nav ? [...nav.querySelectorAll("button[aria-haspopup='menu']")].map((b) => b.textContent.replace(/\s+/g, " ").trim()).filter((t) => /^EVM/.test(t)) : [];
    const g = (k) => localStorage.getItem(k);
    return {
      chips: chip,
      saved: g("defidesh-evm-addr"),
      flag: g("defidesh_evm_disconnected"),
      chosen: g("defidesh-evm-connector"),
      watched: JSON.parse(g("lp-watched-wallets") || "[]").length,
    };
  });
  const says = (s) => `chip ${s.chips.length ? s.chips.join(" + ") : "(no EVM wallet)"} | saved ${short(s.saved)} | chosen ${s.chosen} | flag ${s.flag}`;
  // The app shows addresses in checksum case; compare without regard to case.
  const eq = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
  const shows = (s, addr) => s.chips.some((t) => t.toLowerCase().includes(addr.slice(0, 4).toLowerCase()) && t.toLowerCase().includes(addr.slice(-4).toLowerCase()));
  const live = (s, addr) => s.chips.length === 1 && shows(s, addr) && !/LAST USED/.test(s.chips[0]);
  const lastUsed = (s, addr) => s.chips.length === 1 && shows(s, addr) && /LAST USED/.test(s.chips[0]);
  const none = (s) => s.chips.length === 0;
  const setSim = (p, cfg) => p.evaluate((c) => localStorage.setItem("__sim", JSON.stringify(c)), cfg);
  const openModal = async (p) => {
    await p.getByRole("button", { name: /add wallet/i }).first().click();
    await p.getByText("Connect Browser Wallet").waitFor();
  };
  // Pick a wallet in the EVM picker by its exact name (first entry with that name).
  const pick = async (p, name) => {
    const i = await p.evaluate((n) => {
      const bs = [...document.querySelectorAll("button")].filter((b) => /Browser extension/.test(b.textContent));
      return bs.findIndex((b) => b.textContent.replace("▸", "").replace("Browser extension", "").trim() === n);
    }, name);
    if (i < 0) throw new Error("picker has no " + name);
    await p.locator("button", { hasText: "Browser extension" }).nth(i).click();
    await p.waitForTimeout(2000);
  };
  // False when no Connect EVM button is offered (an EVM identity is already on screen).
  const connectPick = async (p, name) => {
    await openModal(p);
    const btn = p.getByRole("button", { name: /Connect EVM Wallet/i });
    if (!(await btn.count())) return false;
    await btn.click(); await pick(p, name);
    return true;
  };
  const paste = async (p, addr) => {
    await p.getByPlaceholder("0x… / sol… / 0x(sui)…").fill(addr);
    await p.getByPlaceholder("0x… / sol… / 0x(sui)…").press("Enter");
    await p.waitForTimeout(600);
    return p.evaluate(() => { const m = document.body.innerText.match(/(This wallet is already connected[^\n]*|already in your watched[^\n]*|Watched address limit reached[^\n]*)/i); return m ? m[1] : "(no message)"; });
  };
  const A = (state, addr = A1) => ({ state, addr });
  const B = (state) => ({ state, addr: B1 });
  const pageErrors = [];

  // ── Row 1–3: an explicit choice of A, then a load where A is locked and B trusts the site ──
  {
    const { c, p, errs } = await open({ __sim: JSON.stringify({ a: A("closed") }) });
    await load(p);
    await connectPick(p, "Rabby");
    await load(p);
    let s = await read(p);
    check("R1", "Connect EVM → pick A; reload: A's account, connected", live(s, A1) && s.chosen === "rabby", says(s));
    await setSim(p, { a: A("closed"), b: B("open") });
    await load(p);
    s = await read(p);
    check("R2", "next load, A locked, B trusts the site: A's address as LAST USED, never B's", lastUsed(s, A1) && eq(s.saved, A1), says(s));
    await p.evaluate(() => window.__w.aUnlock()); await p.waitForTimeout(2500);
    s = await read(p);
    check("R3", "A unlocks (no reload): A's account, connected", live(s, A1), says(s));
    await p.evaluate((x) => window.__w.aSwitchAccount(x), A2); await p.waitForTimeout(2000);
    s = await read(p);
    check("R3b", "account switched INSIDE the chosen wallet: the chip follows", live(s, A2) && eq(s.saved, A2), says(s));
    await p.evaluate(() => window.__w.aLock()); await p.waitForTimeout(2000);
    s = await read(p);
    check("R3c", "chosen wallet locks mid-session: address stays, as LAST USED", lastUsed(s, A2), says(s));
    pageErrors.push(...errs); await c.close();
  }
  // ── Row 4: no choice on record. B trusts the site (as after a Solana-only connect); A locked, then unlocks ──
  {
    const { c, p, errs } = await open({ __sim: JSON.stringify({ a: A("closed"), b: B("open") }) });
    await load(p);
    let s = await read(p);
    check("R4a", "Solana-only style trust by B, nobody clicked Connect EVM: no EVM wallet", none(s) && !s.saved, says(s));
    await p.evaluate(() => window.__w.aUnlock()); await p.waitForTimeout(2500);
    await p.evaluate(() => document.dispatchEvent(new Event("visibilitychange"))); await p.waitForTimeout(1500);
    s = await read(p);
    check("R4b", "A unlocks, tab refocused: still no EVM wallet until a Connect pick", none(s) && !s.saved, says(s));
    await load(p);
    s = await read(p);
    check("R4c", "reload with both unlocked: still none", none(s) && !s.saved, says(s));
    pageErrors.push(...errs); await c.close();
  }
  // ── Row 5: A carries an old "disconnected" mark from an earlier Disconnect; both unlocked ──
  {
    const { c, p, errs } = await open({ __sim: JSON.stringify({ a: A("open"), b: B("open") }), "wagmi.recentConnectorId": '"rabby"', "wagmi.rabby.disconnected": "true" });
    await load(p);
    let s = await read(p);
    check("R5a", "A marked disconnected by the library, B trusts the site: B's account is never the identity", !shows(s, B1) && !eq(s.saved, B1), says(s));
    await load(p);
    s = await read(p);
    check("R5b", "same after a reload", !shows(s, B1) && !eq(s.saved, B1), says(s));
    pageErrors.push(...errs); await c.close();
  }
  // ── Row 6: explicit Disconnect, then B announces an account ──
  {
    const { c, p, errs } = await open({ __sim: JSON.stringify({ b: B("closed") }), defidesh_evm_disconnected: "true" });
    await load(p);
    await p.evaluate(() => window.__w.bTrust()); await p.waitForTimeout(2500);
    let s = await read(p);
    check("R6a", "Disconnect EVM was clicked; B announces an account: no EVM wallet, flag still set", none(s) && s.flag === "true" && !s.saved, says(s));
    await load(p);
    s = await read(p);
    check("R6b", "same after a reload", none(s) && s.flag === "true" && !s.saved, says(s));
    await connectPick(p, "Phantom");
    s = await read(p);
    check("R6c", "a Connect pick (B) is what clears the flag", live(s, B1) && s.flag === null && s.chosen === "phantom", says(s));
    pageErrors.push(...errs); await c.close();
  }
  // ── Migration (rule 6): a browser saved before the choice was stored ──
  {
    // The state found in a real profile: B's account saved and "current" in the
    // library's saved connection list, last explicit connect = A.
    const stale = JSON.stringify({ state: { connections: { __type: "Map", value: [["59b2787de21", { accounts: [B1], chainId: 1, connector: { id: "phantom", name: "Phantom", type: "injected", uid: "59b2787de21" } }]] }, chainId: 1, current: "59b2787de21" }, version: 3 });
    const seed = { "defidesh-evm-addr": B1, "wagmi.recentConnectorId": '"rabby"', "wagmi.store": stale };
    {
      const { c, p, errs } = await open({ ...seed, __sim: JSON.stringify({ a: A("open"), b: B("open") }) });
      await load(p);
      const s = await read(p);
      check("M1", "no stored choice, last explicit connect = A, A unlocked: A's account, connected; saved address corrected", live(s, A1) && eq(s.saved, A1) && s.chosen === "rabby", says(s));
      pageErrors.push(...errs); await c.close();
    }
    {
      const { c, p, errs } = await open({ ...seed, __sim: JSON.stringify({ a: A("closed"), b: B("open") }) });
      await load(p);
      const s = await read(p);
      check("M2", "same, A locked: the saved address as LAST USED, nothing adopted from B", s.chips.length === 1 && /LAST USED/.test(s.chips[0]) && eq(s.saved, B1), says(s));
      pageErrors.push(...errs); await c.close();
    }
    {
      const { c, p, errs } = await open({ "defidesh-evm-addr": A1, "wagmi.store": stale, __sim: JSON.stringify({ a: A("open"), b: B("open") }) });
      await load(p);
      let s = await read(p);
      check("M3", "saved address, NO explicit connect on record: LAST USED, no live account adopted", lastUsed(s, A1) && eq(s.saved, A1) && !s.chosen, says(s));
      // A LAST USED row offers Switch wallet rather than Connect.
      if (!(await connectPick(p, "Rabby")) && (await p.getByRole("button", { name: /switch wallet/i }).count())) {
        await p.getByRole("button", { name: /switch wallet/i }).click(); await pick(p, "Rabby");
      }
      s = await read(p);
      check("M3b", "…until the user picks a wallet", live(s, A1) && s.chosen === "rabby", says(s));
      pageErrors.push(...errs); await c.close();
    }
  }
  // ── Switch wallet, Disconnect ──
  {
    const { c, p, errs } = await open({ __sim: JSON.stringify({ a: A("closed"), b: B("open") }) });
    await load(p);
    await connectPick(p, "Rabby");
    let s = await read(p);
    const hasSwitch = await p.getByRole("button", { name: /switch wallet/i }).count();
    check("S1", "connected row offers Switch wallet", live(s, A1) && hasSwitch > 0, `${says(s)} | Switch wallet buttons: ${hasSwitch}`);
    if (hasSwitch) {
      await p.getByRole("button", { name: /switch wallet/i }).click(); await pick(p, "Phantom");
      s = await read(p);
      check("S2", "Switch wallet → B, no disconnect first: B's account, connected", live(s, B1) && s.chosen === "phantom" && s.flag === null, says(s));
      await load(p); s = await read(p);
      check("S3", "reload: B sticks", live(s, B1), says(s));
      await openModal(p); await p.getByRole("button", { name: /switch wallet/i }).click(); await pick(p, "Rabby");
      await load(p); s = await read(p);
      check("S4", "Switch back to A, reload: A sticks", live(s, A1) && s.chosen === "rabby", says(s));
      await p.evaluate((x) => window.__w.aNextPick(x), A2);
      await openModal(p); await p.getByRole("button", { name: /switch wallet/i }).click(); await pick(p, "Rabby");
      s = await read(p);
      check("S5", "Switch wallet → the SAME wallet, another account picked in it", live(s, A2) && eq(s.saved, A2), says(s));
      const row = p.locator("div", { hasText: "● CONNECTED" }).filter({ hasText: "EVM" }).last();
      await row.getByRole("button", { name: /^disconnect$/i }).click(); await p.waitForTimeout(1200);
      s = await read(p);
      check("S6", "Disconnect: no EVM wallet, flag set, choice forgotten", none(s) && s.flag === "true" && !s.chosen && !s.saved, says(s));
      await load(p); s = await read(p);
      check("S7", "reload with both wallets unlocked: stays disconnected", none(s) && s.flag === "true", says(s));
    }
    pageErrors.push(...errs); await c.close();
  }
  // ── Pasted addresses: duplicate, cap, one row ──
  {
    const { c, p, errs } = await open({ __sim: JSON.stringify({ a: A("closed") }), "lp-watched-wallets": JSON.stringify([{ address: B1, chain: "evm", label: "w", addedAt: 1 }]) });
    await load(p);
    await connectPick(p, "Rabby");
    let msg = await paste(p, A1.toLowerCase());
    let s = await read(p);
    check("P1", "paste the CONNECTED address (other letter case): rejected with a message", /already connected/i.test(msg) && s.watched === 1, `message: ${msg} | watched ${s.watched}`);
    msg = await paste(p, B1.toUpperCase().replace("0X", "0x"));
    s = await read(p);
    check("P2", "paste an address that is already WATCHED: rejected with a message", /already in your watched/i.test(msg) && s.watched === 1, `message: ${msg} | watched ${s.watched}`);
    pageErrors.push(...errs); await c.close();
  }
  {
    const twenty = Array.from({ length: 20 }, (_, i) => ({ address: "0x" + (i + 1).toString(16).padStart(40, "0"), chain: "evm", addedAt: i }));
    const { c, p, errs } = await open({ "lp-watched-wallets": JSON.stringify(twenty) });
    await load(p); await openModal(p);
    const msg = await paste(p, "0x" + "c".repeat(40));
    const s = await read(p);
    check("P3", "21st watched address on one chain: rejected with the limit message", /limit reached/i.test(msg) && s.watched === 20, `message: ${msg} | watched ${s.watched}`);
    const sol = await paste(p, SOL_A1);
    const s2 = await read(p);
    check("P4", "the cap is per chain: a Solana address is still accepted", s2.watched === 21, `message: ${sol} | watched ${s2.watched}`);
    pageErrors.push(...errs); await c.close();
  }
  {
    // Saved before the rule existed: the same address is both watched and (by pick) connected.
    const { c, p, errs } = await open({ __sim: JSON.stringify({ a: A("closed") }), "lp-watched-wallets": JSON.stringify([{ address: A1.toLowerCase(), chain: "evm", label: "pasted", addedAt: 1 }]) });
    await load(p);
    await connectPick(p, "Rabby");
    const rows = await p.evaluate((a) => {
      const t = document.body.innerText; const i = t.indexOf("YOUR WALLETS"); const part = i < 0 ? "" : t.slice(i);
      const re = new RegExp(a.slice(0, 8) + "…" + a.slice(-6), "gi");
      return { n: (part.match(re) || []).length, text: part.slice(0, 120).replace(/\s+/g, " ") };
    }, A1);
    const s = await read(p);
    check("P5", "same address connected AND watched: one row in Manage Wallets, one chip", rows.n === 1 && s.chips.length === 1, `rows for the address: ${rows.n} | chips ${s.chips.length} | ${rows.text}`);
    pageErrors.push(...errs); await c.close();
  }

  check("ERR", "no page errors in any case", pageErrors.length === 0, pageErrors.length ? pageErrors.slice(0, 3).join(" / ") : "0");
  await browser.close();
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? " — failed: " + failed.map((r) => r.id).join(", ") : ""}`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.log("SCRIPT ERROR", String(e.message).slice(0, 400)); process.exit(2); });
