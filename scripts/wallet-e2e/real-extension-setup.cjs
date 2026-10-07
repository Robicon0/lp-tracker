const { launch, dump, onboarding } = require("./reallib.cjs");
const dumpInputs = async (p) => console.log("inputs:", await p.evaluate(() => [...document.querySelectorAll("input")].map((i) => i.outerHTML.slice(0, 160))));
(async () => {
  const c = await launch(true);
  const ob = await onboarding(c);
  await ob.getByRole("button", { name: "Create a New Wallet" }).click(); await ob.waitForTimeout(1200);
  await ob.getByTestId("create-manual-seed-phrase").click(); await ob.waitForTimeout(1500);
  await ob.getByTestId("onboarding-form-password-input").fill((process.env.TEST_WALLET_PW || "throwaway-local-only-1!"));
  await ob.getByTestId("onboarding-form-confirm-password-input").fill((process.env.TEST_WALLET_PW || "throwaway-local-only-1!"));
  await ob.getByTestId("onboarding-form-terms-of-service-checkbox").click({ force: true });
  await ob.getByTestId("onboarding-form-submit-button").click(); await ob.waitForTimeout(6000);
  for (let i = 0; i < 9; i++) {
    await dump(ob, "real-ob-step" + i);
    const cbs = ob.locator("input[type=checkbox]");
    for (let k = 0; k < await cbs.count(); k++) if (!(await cbs.nth(k).isChecked())) await cbs.nth(k).click({ force: true });
    const un = ob.locator("input[name=username], input[placeholder*=sername i]");
    if (await un.count()) { await dumpInputs(ob); await un.first().fill("ddtest" + Math.floor(Math.random() * 1e7)); await ob.waitForTimeout(3000); await ob.getByTestId("onboarding-create-username-continue").click().catch((e) => console.log("uname click", String(e).slice(0, 100))); await ob.waitForTimeout(5000); continue; }
    let sub = ob.getByTestId("onboarding-form-submit-button");
    if (!(await sub.count())) sub = ob.getByRole("button", { name: /continue|get started|finish|done|skip/i }).first();
    if (!(await sub.count())) break;
    await sub.click().catch(() => {}); await ob.waitForTimeout(4000);
    if (ob.isClosed()) break;
  }
  console.log("pages:", c.pages().map((p) => p.url()));
  await c.close();
})().catch((e) => { console.error(String(e).slice(0, 600)); process.exit(1); });
