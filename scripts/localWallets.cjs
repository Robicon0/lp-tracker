// Full wallet addresses for tests and scripts, read from a local file that is
// never committed: .local/wallets.json (git-ignored). The pre-commit check
// (scripts/hooks/pre-commit-scan.mjs) blocks a full wallet address anywhere
// else in a commit.
//
// Shape:
//   { "private":   { "account1": { "evm": "0x...", "solana": "...", "sui": "0x..." } },
//     "prodCheck": { "evm1": "0x...", "evm2": "0x...", "sol1": "...", "sol2": "...",
//                    "sol3": "...", "sui1": "0x...", "sui2": "0x..." } }
//
// LOCAL_WALLETS_JSON (the file's JSON as a string) overrides the file, for CI.
/* eslint-disable @typescript-eslint/no-require-imports -- a CommonJS module, required by the .cjs scripts */
const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(__dirname, '..', '.local', 'wallets.json');

function localWallets() {
  if (process.env.LOCAL_WALLETS_JSON) return JSON.parse(process.env.LOCAL_WALLETS_JSON);
  if (!fs.existsSync(FILE)) {
    throw new Error(`missing ${FILE}: create it locally (see scripts/localWallets.cjs for the shape)`);
  }
  return JSON.parse(fs.readFileSync(FILE, 'utf8'));
}

/** Account 1's EVM, Solana and Sui addresses. */
function account1() {
  const a = localWallets().private?.account1;
  if (!a?.solana || !a?.sui) throw new Error('.local/wallets.json has no private.account1.solana / .sui');
  return a;
}

module.exports = { localWallets, account1, FILE };
