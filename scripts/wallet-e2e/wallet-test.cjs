// Wallet disconnect verification. Usage: node wallet-test.cjs <label>
const { chromium } = require("playwright");
const path = require("path");
const LABEL = process.argv[2] || "after";
const OUT = path.join(__dirname, "shots");
require("fs").mkdirSync(OUT, { recursive: true });
const BASE = process.argv[3] || "http://localhost:3000";

const EVM = "0xD99a9e66d000d4024dC77f00f784Cc45F8804F20";
const SOL = "GndRtybRYe3ShqES4RXpw9hq2MysJRLkjEf99M6PpogC";
const SUI = "0x8ef8c104d43e55b11fc6afcd58088274fabff2d30480dd4c4283ff834ac2297d";

// Simulated wallets, installed on every navigation like a real extension.
function mocks({ evm, sol, sui, EVM, SOL, SUI }) {
  if (evm) {
    const listeners = {};
    window.ethereum = {
      isRabby: true,
      request: async ({ method }) => {
        if (method === "eth_requestAccounts" || method === "eth_accounts") return [EVM];
        if (method === "eth_chainId") return "0x2105";
        if (method === "wallet_requestPermissions") return [{ parentCapability: "eth_accounts" }];
        return null;
      },
      on: (e, f) => { (listeners[e] ||= []).push(f); },
      removeListener: (e, f) => { listeners[e] = (listeners[e] || []).filter((x) => x !== f); },
    };
  }
  const icon = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=";
  const make = (name, chain, address, extra) => {
    const subs = new Set();
    let accounts = [];
    const acct = { address, publicKey: new Uint8Array(32).fill(7), chains: [chain], features: Object.keys(extra) };
    const emit = () => subs.forEach((f) => f({ accounts }));
    const w = {
      version: "1.0.0", name, icon, chains: [chain],
      get accounts() { return accounts; },
      features: {
        "standard:connect": { version: "1.0.0", connect: async () => { accounts = [acct]; emit(); return { accounts }; } },
        "standard:disconnect": { version: "1.0.0", disconnect: async () => { await new Promise((r) => setTimeout(r, 150)); accounts = []; emit(); } },
        "standard:events": { version: "1.0.0", on: (_e, f) => { subs.add(f); return () => subs.delete(f); } },
        ...extra,
      },
    };
    const reg = (api) => api.register(w);
    try { window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: reg })); } catch {}
    window.addEventListener("wallet-standard:app-ready", (e) => reg(e.detail));
  };
  const nop = { version: "1.0.0" };
  if (sol) make("Test Solana Wallet", "solana:mainnet", SOL, {
    "solana:signTransaction": { ...nop, supportedTransactionVersions: ["legacy", 0], signTransaction: async () => [] },
    "solana:signAndSendTransaction": { ...nop, supportedTransactionVersions: ["legacy", 0], signAndSendTransaction: async () => [] },
  });
  if (sui) make("Test Sui Wallet", "sui:mainnet", SUI, {
    "sui:signTransaction": { ...nop, signTransaction: async () => ({}) },
    "sui:signTransactionBlock": { ...nop, signTransactionBlock: async () => ({}) },
    "sui:signAndExecuteTransaction": { ...nop, signAndExecuteTransaction: async () => ({}) },
    "sui:signPersonalMessage": { ...nop, signPersonalMessage: async () => ({}) },
  });
}

const results = [];
const rec = (name, pass, detail) => { results.push({ name, pass }); console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };

async function ctx(browser, opts, seed) {
  const c = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await c.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
  await c.addInitScript(mocks, { ...opts, EVM, SOL, SUI });
  if (seed) await c.addInitScript((s) => {
    if (sessionStorage.getItem("__seeded")) return;
    sessionStorage.setItem("__seeded", "1");
    for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v);
  }, seed);
  // Keep the test off the real upstreams — only wallet identity is under test.
  await c.route("**/api/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"positions":[],"count":0}' }));
  const p = await c.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(String(e)));
if (process.env.SHARE) { await p.goto(process.env.SHARE, { waitUntil: "domcontentloaded" }); await p.waitForTimeout(1500); }
  await p.goto(BASE + "/dashboard", { waitUntil: "domcontentloaded" });
  await p.waitForSelector("nav");
  await p.waitForTimeout(2500);
  return { c, p, errs };
}
const chipsText = (p) => p.evaluate(() => {
  const nav = document.querySelector("nav");
  const box = [...nav.querySelectorAll("div")].find((d) => d.className.includes("md:flex") && /no wallet|EVM|SOL|SUI/.test(d.textContent));
  return box ? box.textContent.replace(/\s+/g, " ").trim() : "(none)";
});
const ls = (p, k) => p.evaluate((k) => localStorage.getItem(k), k);
const openModal = async (p) => { await p.getByRole("button", { name: /add wallet/i }).first().click(); await p.getByText("Connect Browser Wallet").waitFor(); };
const chipBtn = (p, tag) => p.locator("nav button[aria-haspopup='menu']", { hasText: tag }).first();
const shot = (p, n) => p.screenshot({ path: path.join(OUT, `${LABEL}-${n}.png`) });

async function connectVia(p, btn, pick) {
  await openModal(p);
  // An already-authorized simulated wallet is silently reconnected on mount
  // (by design, 866ead0) — only click Connect when it is actually offered.
  if (await p.getByRole("button", { name: btn }).count()) {
    await p.getByRole("button", { name: btn }).click();
    await p.getByRole("button", { name: pick }).click();
  }
  await p.waitForTimeout(1200);
}
async function modalDisconnect(p, tag) {
  // The "Connect Browser Wallet" row for this chain: tag + address + ● CONNECTED + Disconnect.
  const row = p.locator("div", { hasText: "● CONNECTED" }).filter({ hasText: tag }).last();
  await row.getByRole("button", { name: /^disconnect$/i }).click();
}

(async () => {
  const browser = await chromium.launch();

  // ── S1: restored (locked) EVM → navbar chip menu ───────────────────────
  {
    const { c, p, errs } = await ctx(browser, {}, { "defidesh-evm-addr": EVM });
    const before = await chipsText(p);
    rec("S1 restored EVM chip shown", /EVM/.test(before), before);
    const hasMenuBtn = await chipBtn(p, "EVM").count();
    if (!hasMenuBtn) {
      await p.locator("nav button", { hasText: "EVM" }).first().click();
      await p.waitForTimeout(400);
      rec("S1 chip click opens a menu", (await p.locator("[role=menu]").count()) > 0, "no menu rendered");
    } else {
      await chipBtn(p, "EVM").click();
      await p.getByRole("menu").waitFor();
      await shot(p, "S1-chip-menu-open");
      rec("S1 chip click opens a menu", true, (await p.getByRole("menu").innerText()).replace(/\n/g, " | "));
      await p.getByRole("menuitem", { name: /disconnect/i }).click();
      await p.waitForTimeout(600);
      const after = await chipsText(p);
      rec("S1 chip gone after Disconnect", !/EVM/.test(after), after);
      rec("S1 persisted key removed + flag set", (await ls(p, "defidesh-evm-addr")) === null && (await ls(p, "defidesh_evm_disconnected")) === "true");
      await shot(p, "S1-after-disconnect");
      await p.reload(); await p.waitForTimeout(2500);
      rec("S1 stays disconnected after reload", !/EVM/.test(await chipsText(p)), await chipsText(p));
    }
    rec("S1 no page errors", errs.length === 0, errs.join(" ; "));
    await c.close();
  }

  // ── S2: restored EVM → Manage Wallets Disconnect ───────────────────────
  {
    const { c, p, errs } = await ctx(browser, {}, { "defidesh-evm-addr": EVM });
    await openModal(p);
    await shot(p, "S2-modal-before");
    await modalDisconnect(p, "EVM");
    await p.waitForTimeout(800);
    await shot(p, "S2-modal-after");
    rec("S2 modal row flips to Connect EVM Wallet", (await p.getByRole("button", { name: /connect evm wallet/i }).count()) > 0);
    rec("S2 navbar chip gone", !/EVM/.test(await chipsText(p)), await chipsText(p));
    rec("S2 no page errors", errs.length === 0, errs.join(" ; "));
    await c.close();
  }

  // ── S3: LIVE EVM (simulated provider) → Manage Wallets Disconnect ──────
  {
    const { c, p, errs } = await ctx(browser, { evm: true });
    await connectVia(p, /connect evm wallet/i, /rabby/i);
    const connected = await chipsText(p);
    rec("S3 live EVM connected", /EVM/.test(connected) && !/LAST USED/.test(connected), connected);
    await modalDisconnect(p, "EVM");
    await p.waitForTimeout(800);
    rec("S3 modal row flips to Connect EVM Wallet", (await p.getByRole("button", { name: /connect evm wallet/i }).count()) > 0);
    rec("S3 navbar chip gone", !/EVM/.test(await chipsText(p)), await chipsText(p));
    await p.reload(); await p.waitForTimeout(3500);
    rec("S3 not silently reconnected after reload (wallet still unlocked)", !/EVM/.test(await chipsText(p)), await chipsText(p));
    await connectVia(p, /connect evm wallet/i, /rabby/i);
    rec("S3 can RECONNECT after disconnect", /EVM/.test(await chipsText(p)) && !/LAST USED/.test(await chipsText(p)), await chipsText(p));
    await p.reload(); await p.waitForTimeout(3500);
    rec("S3 reconnected wallet persists across reload", /EVM/.test(await chipsText(p)), await chipsText(p));
    rec("S3 no page errors", errs.length === 0, errs.join(" ; "));
    await c.close();
  }

  // ── S4/S5: Solana + Sui → Manage Wallets Disconnect, inside the settle window.
  // "returning" = identity auto-restored from a previous session (seeded);
  // "fresh" = connected through the modal in this session.
  const SOL_SEED = { "defidesh-solana-addr": SOL, walletName: JSON.stringify("Test Solana Wallet") };
  const SUI_SEED = { "defidesh-sui-addr": SUI, "sui-dapp-kit:wallet-connection-info": JSON.stringify({ state: { lastConnectedWalletName: "Test Sui Wallet", lastConnectedAccountAddress: SUI }, version: 0 }) };
  for (const [id, opts, tag, btn, pick, key, flag, seed] of [
    ["S4-returning", { sol: true }, "SOL", /connect solana wallet/i, /test solana wallet/i, "defidesh-solana-addr", "defidesh_solana_disconnected", SOL_SEED],
    ["S4-fresh", { sol: true }, "SOL", /connect solana wallet/i, /test solana wallet/i, "defidesh-solana-addr", "defidesh_solana_disconnected", null],
    ["S5-returning", { sui: true }, "SUI", /connect sui wallet/i, /test sui wallet/i, "defidesh-sui-addr", "defidesh_sui_disconnected", SUI_SEED],
    ["S5-fresh", { sui: true }, "SUI", /connect sui wallet/i, /test sui wallet/i, "defidesh-sui-addr", "defidesh_sui_disconnected", null],
  ]) {
    const { c, p, errs } = await ctx(browser, opts, seed);
    await connectVia(p, btn, pick);
    const connected = await chipsText(p);
    rec(id + " " + tag + " connected", new RegExp(tag).test(connected), connected);
    if (!new RegExp(tag).test(connected)) { await c.close(); continue; }
    await shot(p, id + "-connected");
    await modalDisconnect(p, tag);
    await p.waitForTimeout(1000);
    const after = await chipsText(p);
    rec(id + " chip gone 1s after Disconnect", !new RegExp(tag).test(after), after);
    rec(id + " modal row flips to Connect", (await p.getByRole("button", { name: btn }).count()) > 0);
    rec(id + " persisted key removed + flag set", (await ls(p, key)) === null && (await ls(p, flag)) === "true", "key=" + (await ls(p, key)) + " flag=" + (await ls(p, flag)));
    await shot(p, id + "-after-disconnect");
    await p.waitForTimeout(3000);
    rec(id + " still gone 4s later", !new RegExp(tag).test(await chipsText(p)), await chipsText(p));
    await p.reload(); await p.waitForTimeout(3500);
    rec(id + " not restored after reload", !new RegExp(tag).test(await chipsText(p)), await chipsText(p));
    // Switching wallets = disconnect then connect again.
    await connectVia(p, btn, pick);
    rec(id + " can RECONNECT after disconnect", new RegExp(tag).test(await chipsText(p)), await chipsText(p));
    await p.reload(); await p.waitForTimeout(3500);
    rec(id + " reconnected wallet persists across reload", new RegExp(tag).test(await chipsText(p)), await chipsText(p));
    rec(id + " no page errors", errs.length === 0, errs.join(" ; "));
    await c.close();
  }

  // ── S6: all three connected → disconnect each from its navbar chip ─────
  {
    const { c, p, errs } = await ctx(browser, { evm: true, sol: true, sui: true });
    await connectVia(p, /connect evm wallet/i, /rabby/i);
    await p.getByRole("button", { name: /connect solana wallet/i }).click();
    await p.getByRole("button", { name: /test solana wallet/i }).click();
    await p.waitForTimeout(1000);
    await p.getByRole("button", { name: /connect sui wallet/i }).click();
    await p.getByRole("button", { name: /test sui wallet/i }).click();
    await p.waitForTimeout(1000);
    await p.keyboard.press("Escape");
    await p.mouse.click(20, 500); // backdrop closes the modal
    await p.waitForTimeout(400);
    const all = await chipsText(p);
    rec("S6 three chips shown", /EVM/.test(all) && /SOL/.test(all) && /SUI/.test(all), all);
    if (!(/EVM/.test(all) && /SOL/.test(all) && /SUI/.test(all))) { /* setup failed — nothing to exercise */ }
    else if ((await chipBtn(p, "EVM").count()) === 0) rec("S6 chip menus exist", false, "no menu buttons");
    else for (const tag of ["SOL", "SUI", "EVM"]) {
      await chipBtn(p, tag).click();
      await p.getByRole("menu").waitFor();
      if (tag === "SOL") await shot(p, "S6-sol-menu");
      await p.getByRole("menuitem", { name: /disconnect/i }).click();
      await p.waitForTimeout(1000);
      const t = await chipsText(p);
      rec(`S6 ${tag} chip gone after chip-menu Disconnect`, !new RegExp(tag).test(t), t);
    }
    await shot(p, "S6-all-disconnected");
    // Outside-click + Escape close behaviour and Copy.
    rec("S6 no page errors", errs.length === 0, errs.join(" ; "));
    await c.close();
  }

  // ── S7: menu ergonomics — copy, Escape, outside click, watched wallet ──
  if (LABEL !== "before") {
    const { c, p, errs } = await ctx(browser, {}, {
      "defidesh-evm-addr": EVM,
    });
    await chipBtn(p, "EVM").click();
    await p.getByRole("menuitem", { name: /copy address/i }).click();
    const clip = await p.evaluate(() => navigator.clipboard.readText()).catch(() => "(unreadable)");
    rec("S7 Copy address still works", clip === EVM, clip);
    await p.keyboard.press("Escape"); await p.waitForTimeout(200);
    rec("S7 Escape closes menu", (await p.locator("[role=menu]").count()) === 0);
    await chipBtn(p, "EVM").click(); await p.mouse.click(700, 500); await p.waitForTimeout(200);
    rec("S7 outside click closes menu", (await p.locator("[role=menu]").count()) === 0);
    rec("S7 wallet NOT disconnected by merely opening the menu", /EVM/.test(await chipsText(p)));
    rec("S7 no page errors", errs.length === 0, errs.join(" ; "));
    await c.close();
  }

  await browser.close();
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n[${LABEL}] ${results.length - failed}/${results.length} passed`);
})().catch((e) => { console.error("HARNESS ERROR", e); process.exit(2); });
