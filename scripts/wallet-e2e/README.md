# Wallet connect / disconnect end-to-end checks

Run from this directory. Every script takes `<label> [base-url]` (default
`http://localhost:3000`); `/api/**` is stubbed, so they put no load on upstreams.

| Script | What it drives |
|---|---|
| `wallet-test.cjs` | Desktop. Navbar chip menu + Manage Wallets disconnect, reload, reconnect, for EVM / Solana / Sui with SIMULATED wallets. |
| `sol-connect.cjs` | Fresh Solana connect on the home hero and the top Navbar. |
| `mobile-test.cjs` | Manage Wallets flow on iPhone 14 + iPad (WebKit) and Pixel 7 (Chromium). Needs `npx playwright install webkit`. |
| `real-extension.cjs` | The same flow with a REAL wallet extension. Takes `[base-url]` only. |

## Real extension

Simulated wallets are too slow and too simple to show real races — the real
extension found two bugs the simulated suites passed (2026-10-07). Setup:

1. Download the extension's `.crx` from the Chrome Web Store and unzip it to
   `ext/phantom/` (git-ignored).
2. `node real-extension-setup.cjs` creates a THROWAWAY wallet in an isolated
   profile (`prof-phantom/`, git-ignored). It stops at the optional username
   screen; the wallet is already usable at that point.
3. `node real-extension.cjs https://www.defidesh.com`

Never point these at a profile that holds a real wallet.

To run against a protected (non-production) Vercel deployment, set `SHARE` to
a share link for it; each context visits that first to pick up the cookie.
