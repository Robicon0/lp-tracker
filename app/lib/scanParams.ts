type ScanChain = "evm" | "solana" | "sui";
import { detectChain } from "./detectChain";

// The ?address=&chain= of a pasted-wallet link (2026-10-25). A link the page
// cannot use used to fall back to the visitor's own (often empty) wallet set
// and read a clean $0.00 with no notice. Now it is either a scan or a stated
// reason. Guard: scripts/scan-params-test.ts.

export type ScanParams =
  | { kind: "none" }
  | { kind: "ok"; address: string; chain: ScanChain }
  | { kind: "invalid"; message: string };

const CHAINS: ScanChain[] = ["evm", "solana", "sui"];
const NAME: Record<ScanChain, string> = { evm: "EVM", solana: "Solana", sui: "Sui" };
const aName = (c: ScanChain) => (c === "evm" ? "an EVM" : `a ${NAME[c]}`);
const FORMAT: Record<ScanChain, RegExp> = {
  evm: /^0x[0-9a-fA-F]{40}$/,
  sui: /^0x[0-9a-fA-F]{63,64}$/,
  solana: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
};

export function parseScanParams(address: string | null, chain: string | null): ScanParams {
  const addr = (address ?? "").trim();
  const ch = (chain ?? "").trim().toLowerCase();
  if (!addr && !ch) return { kind: "none" };
  if (!addr) return { kind: "invalid", message: "This link has no wallet address." };
  const g = detectChain(addr);
  const guess: ScanChain | null = g === "evm" || g === "solana" || g === "sui" ? g : null;
  // No chain (the paste form's plain submit, before its script runs): the
  // address format names it.
  if (!ch) {
    return guess
      ? { kind: "ok", address: addr, chain: guess }
      : { kind: "invalid", message: "This is not a valid EVM, Solana or Sui address." };
  }
  if (!CHAINS.includes(ch as ScanChain)) {
    return {
      kind: "invalid",
      message: guess
        ? `This link names an unknown chain ("${ch.slice(0, 20)}"). The address looks like ${aName(guess)} address.`
        : `This link names an unknown chain ("${ch.slice(0, 20)}") and an address that is not a valid wallet address.`,
    };
  }
  const c = ch as ScanChain;
  if (!FORMAT[c].test(addr)) {
    return {
      kind: "invalid",
      message: guess && guess !== c
        ? `This address is not ${aName(c)} address — it looks like ${aName(guess)} address.`
        : `This is not a valid ${NAME[c]} address.`,
    };
  }
  return { kind: "ok", address: addr, chain: c };
}

export function scanLink(address: string, chain: ScanChain): string {
  return `?address=${encodeURIComponent(address)}&chain=${chain}`;
}

export const CHAIN_NAME = NAME;
