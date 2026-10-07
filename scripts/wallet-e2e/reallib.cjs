const { chromium } = require("playwright");
const path = require("path"), fs = require("fs");
exports.launch = async (fresh) => {
  const ext = path.join(__dirname, "ext/phantom"), prof = path.join(__dirname, "prof-phantom");
  if (fresh) fs.rmSync(prof, { recursive: true, force: true });
  const c = await chromium.launchPersistentContext(prof, { channel: "chromium", headless: true, viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
  await new Promise((r) => setTimeout(r, 5000));
  return c;
};
exports.dump = async (p, name) => {
  await p.waitForTimeout(1500);
  await p.screenshot({ path: path.join(__dirname, "shots", name + ".png") }).catch(() => {});
  const d = await p.evaluate(() => ({
    btn: [...document.querySelectorAll("button,a,[role=button],[role=checkbox],input")].map((b) => `${b.tagName}:${(b.innerText || b.placeholder || b.type || "").trim().replace(/\s+/g, " ").slice(0, 40)}#${b.getAttribute("data-testid") || ""}`).slice(0, 40),
    text: document.body.innerText.replace(/\s+/g, " ").slice(0, 500),
  })).catch((e) => ({ err: String(e) }));
  console.log(`--- ${name} ---`); console.log(JSON.stringify(d, null, 0).slice(0, 1800));
};
exports.EXT = "chrome-extension://bfnaelmomeimhlpmgjnjophhpkkoljpa";
exports.onboarding = async (c) => {
  let ob = c.pages().find((p) => p.url().includes("onboarding"));
  if (!ob) { ob = await c.newPage(); await ob.goto(exports.EXT + "/onboarding.html"); }
  await ob.bringToFront(); await ob.waitForTimeout(2500); return ob;
};
