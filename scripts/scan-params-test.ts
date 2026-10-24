import { parseScanParams } from "../app/lib/scanParams";
let pass = 0, fail = 0;
const t = (name: string, a: string | null, c: string | null, kind: string, re?: RegExp) => {
  const r = parseScanParams(a, c);
  const ok = r.kind === kind && (!re || (r.kind === "invalid" && re.test(r.message)));
  if (ok) pass++; else { fail++; console.log("FAIL", name, JSON.stringify(r)); }
};
const EVM = "0xD99a9e66d000d4024dC77f00f784Cc45F8804F20";
const SUI = "0xdce8af889df949cacbef1188e6eb59d70508b76eba4c74cb1c8dc4f34454c30d";
const SOL = "GndRtybRYe3ShqES4RXpw9hq2MysJRLkjEf99M6PpogC";
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
