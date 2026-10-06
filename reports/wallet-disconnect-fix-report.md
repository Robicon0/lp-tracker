# Wallet disconnect fix — report

Date: 2026-10-07

## What was reported

- **Bug A** — clicking a wallet chip in the top navbar (EVM / SOL / SUI) does nothing.
- **Bug B** — the "Disconnect" button in Manage Wallets does nothing; the wallet stays connected.

Both are fixed for all three chains. A third bug found during testing (Solana could not be
connected from Manage Wallets) is fixed too, because without it "disconnect, then connect a
different wallet" still would not work.

## What I found

### Bug A — navbar chip

There was a click handler, but all it did was silently copy the address to the clipboard
(`app/components/TerminalNavbar.tsx`). No menu and no disconnect option had ever been built
there. With no visible feedback, the click looked like nothing happened. Identical on all three
chains. Not a regression — the feature was simply missing.

### Bug B — Manage Wallets "Disconnect"

The handler existed but was incomplete (`app/dashboard/page.tsx`, in two places: the
"Connect Browser Wallet" rows and the ✕ button in "Your Wallets"). A correct disconnect needs
four steps; this one did one or two of them.

| Step | Needed for | EVM (before) | Solana / Sui (before) |
|---|---|---|---|
| Set the "user disconnected" flag | stops silent reconnect | missing | missing |
| Clear the address the site displays | chip, row and positions go away | **missing** | done |
| Remove the saved `defidesh-<chain>-addr` | stops restore re-adopting it | **missing** | **missing** |
| Tell the wallet library to disconnect | ends the adapter session | done | done |

- **EVM — fully broken.** Only the wallet library (wagmi) was told to disconnect. The address the
  site shows lives in our own store, which nothing cleared, so the chip, the row and every
  position stayed. For a "LAST USED" (restored) address wagmi is not even connected, so the click
  was a complete no-op.
- **Solana / Sui — a race.** The displayed address was cleared, but the saved address was left in
  place. The adapter stays connected for a moment while it tears down, and in that moment
  `WalletRestoreEffect` saw "adapter connected, saved address matches, nothing displayed" and put
  the wallet straight back. It then lingered until the 15 s settle gate plus 2 s debounce expired,
  so a click within about 17 s of page load appeared to do nothing.

### Is it related to the "live vs restored" identity work?

Yes, both halves.

- `f64da31` / `866ead0` (EVM session persistence, live vs restored) moved the EVM identity out of
  wagmi and into our own store. The Manage Wallets button was never updated to clear that store.
- `5bec9df` (the fix for Sui/Solana wallets disconnecting by themselves) replaced an instant clear
  with the 15 s settle gate. The old instant clear had been hiding the incomplete handler; once it
  was gone, the gap became visible.

The top `Navbar.tsx` and the home-page `HeroWalletConnect.tsx` already had the full four-step
handler. The dashboard modal was a weaker hand-copy that drifted.

### Extra bug found while testing — Solana connect from Manage Wallets

`handleSolanaConnectFromModal` called `select(wallet)` and then `connect()` in the same tick.
`select` only takes effect on the next render, so `connect()` threw `WalletNotSelectedError` for
any wallet not already selected — every first connect, and every reconnect after a disconnect
(which clears the selection). The error handler then dropped the "awaiting connect" marker, so the
address was never captured, no matter how many times the button was clicked.

## What I changed

| File | Change |
|---|---|
| `app/hooks/useWalletDisconnect.ts` (new) | The one implementation of an explicit disconnect, all four steps, flag first. |
| `app/dashboard/page.tsx` | Both Manage Wallets disconnect buttons use the shared hook. Solana connect now waits for the selection to land before connecting. |
| `app/components/TerminalNavbar.tsx` | Clicking a chip opens a small menu: **Copy address**, plus **Disconnect {chain} wallet** (connected) or **Remove watched wallet** (watched). Closes on outside click or Escape. |
| `app/components/DashboardSidebar.tsx` | The sidebar SOL row uses the shared hook instead of its own copy. |
| `app/components/WalletRestoreEffect.tsx` | Restore never re-adopts a Solana/Sui wallet whose "user disconnected" flag is set. |

No pricing, position or cache logic was touched, so there are no cache version bumps. The change
conforms to `wallet-security.md` Rule 1 (an explicit disconnect is never overridden by a silent
restore) and Rule 2 (the menu names the chain, never a wallet brand); the rule file is unchanged.

## How it was tested

Playwright on `localhost:3000`, clean browser profile, 1440×900, with `/api/**` stubbed so only
wallet identity was under test. Wallets were **simulated**: an injected EIP-1193 provider for EVM
and Wallet Standard test wallets for Solana and Sui, re-installed on every page load the way a
real extension is.

The same script was run against the code before the fix (my changes reverted, nothing else
touched) and after it.

| Scenario | Before | After |
|---|---|---|
| S1 restored ("LAST USED") EVM: chip click opens a menu, Disconnect removes it, stays gone after reload | no menu | pass |
| S2 restored EVM: Manage Wallets Disconnect | wallet stays | pass |
| S3 live EVM: Manage Wallets Disconnect; not silently reconnected on reload while the wallet is still unlocked; can reconnect | wallet stays | pass |
| S4 Solana, returning user: Disconnect within the settle window; gone at 1 s and 4 s; not restored on reload; can reconnect | still shown at 1 s and 4 s | pass |
| S4 Solana, fresh connect from the modal | could not connect at all | pass |
| S5 Sui, returning user and fresh connect: same checks as S4 | still shown at 1 s and 4 s | pass |
| S6 all three connected: disconnect each from its navbar chip | no menu | pass |
| S7 Copy address still works; Escape and outside click close the menu; opening the menu does not disconnect | n/a | pass |

Totals: **before 22 of 43 checks, after 62 of 62** (the before run has fewer checks because
scenarios that could not get a wallet connected were skipped). No page errors in any after-run
scenario. Screenshots of the open chip menu and of Manage Wallets after disconnecting were
inspected by eye.

`npm run build` and `tsc --noEmit` are clean.

## Limits

- **Simulated wallets, not real extensions.** The library code paths are the real ones, but real
  extension timing may differ. Worth one manual pass with a real wallet per chain: connect,
  disconnect from the chip, disconnect from Manage Wallets, reload, reconnect.
- **The chip menu is desktop only**, as the chips themselves are (hidden below the `md`
  breakpoint). On mobile, disconnect is reachable through Manage Wallets.
- **Not changed:** `Navbar.tsx` and `HeroWalletConnect.tsx` use the same `select()` then
  `connect()` pattern for Solana that failed in the modal. They have a fallback path the modal
  lacked, so a second click may succeed there; I did not test those two surfaces. Recorded as a
  follow-up in `CLAUDE.md`.
- In scan mode the chip menu offers Copy only; leaving scan mode is still done from the banner.
