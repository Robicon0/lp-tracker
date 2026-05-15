import type { WatchedWalletChain } from "../contexts/WatchedWalletsContext";

// Address-format detection used by the homepage SCAN form to route a pasted
// address to /dashboard?address=...&chain=... in read-only mode.
//
// Format rules:
//   - EVM:    0x + 40 hex chars  (e.g. 0xD99a5c1d3F93F1a7cfA77025A8F1532a0cEF4F20)
//   - Sui:    0x + 64 hex chars  (Sui addresses are 32 bytes / 64 hex chars after 0x)
//   - Solana: base58 (no 0x prefix), 32–44 chars (no 0/O/I/l)
//
// Returns null when the input doesn't match any known format. Adding a new
// chain in the future = add one line here and one entry to WatchedWalletChain.
const EVM_RE = /^0x[a-fA-F0-9]{40}$/;
const SUI_RE = /^0x[a-fA-F0-9]{64}$/;
const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function detectChain(addr: string): WatchedWalletChain | null {
  const trimmed = addr.trim();
  if (EVM_RE.test(trimmed)) return "evm";
  if (SUI_RE.test(trimmed)) return "sui";
  if (SOL_RE.test(trimmed)) return "solana";
  return null;
}
