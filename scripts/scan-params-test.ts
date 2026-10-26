import { parseScanParams } from "../app/lib/scanParams";
import { account1 } from "./localWallets.cjs";
let pass = 0, fail = 0;
const t = (name: string, a: string | null, c: string | null, kind: string, re?: RegExp) => {
  const r = parseScanParams(a, c);
  const ok = r.kind === kind && (!re || (r.kind === "invalid" && re.test(r.message)));
  if (ok) pass++; else { fail++; console.log("FAIL", name, JSON.stringify(r)); }
};
const EVM = "0xD99a9e66d000d4024dC77f00f784Cc45F8804F20";
const SUI = account1().sui; // Account 1 (.local/wallets.json)
const SOL = account1().solana;
t("none", null, null, "none");
t("evm ok", EVM, "evm", "ok"); t("sui ok", SUI, "sui", "ok"); t("sol ok", SOL, "solana", "ok");
t("chain case", EVM, "EVM", "ok");
t("zsh unsplit", "undefined", `evm ${EVM}`, "invalid", /unknown chain/);
t("no address", null, "evm", "invalid", /no wallet address/);
t("no chain evm", EVM, null, "ok"); t("no chain sol", SOL, null, "ok"); t("no chain sui", SUI, "", "ok"); t("no chain junk", "hello", null, "invalid", /not a valid EVM, Solana or Sui/);
t("evm on sui", EVM, "sui", "invalid", /looks like an EVM/);
t("sui on evm", SUI, "evm", "invalid", /looks like a Sui/);
t("short evm", EVM.slice(0, -1), "evm", "invalid", /not a valid EVM/);
t("junk sol", "hello", "solana", "invalid", /not a valid Solana/);
t("sol on evm", SOL, "evm", "invalid", /looks like a Solana/);
console.log(`${pass} passed, ${fail} failed`); if (fail) process.exit(1);
