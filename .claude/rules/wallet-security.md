# Wallet Security

These rules govern how DefiDesh handles wallet connections. They exist
because users trust DefiDesh with read-only access to their addresses, and
that trust must never be violated by surprise auto-connections, leaked
connection state, or cross-chain leakage.

## Core principle

A wallet shows as connected only when the user has actively unlocked it in
the current browser session. Locked wallets never auto-connect. Disconnect
state is persistent across page refreshes until the user explicitly
reconnects.

---

## Rule 1: Session persistence is flag-gated (amended 2026-07-19, owner-approved)

A wallet connection PERSISTS across sessions until the user explicitly
disconnects: when a user returns to DefiDesh, the last-confirmed wallet
identity is restored automatically UNLESS the per-chain
`defidesh_<chain>_disconnected` flag is set (the user clicked Disconnect).
This applies to all chains (EVM, Solana, Sui) and to any future chains added.

Original rule ("no auto-connect unless the user clicked Connect in the
current session") was amended at Osho's explicit direction for UX parity:
Solana/Sui Wallet Standard adapters already silently restored sessions, and
EVM was the outlier because MetaMask-style extensions reveal no accounts
while locked. EVM now restores the LAST-CONFIRMED address from localStorage
(`defidesh-evm-addr`, written only on a confirmed connect, cleared on
explicit disconnect) as a read-only identity — equivalent in power to a
watched address on this read-only platform. The identity is replaced by the
live wagmi address whenever the wallet is actually unlocked.

What is STILL forbidden: restoring a wallet after an explicit disconnect
(the flag always wins), and clearing the flag on anything other than a
user-confirmed connect.

### Why
Wallets that auto-connect on refresh expose user addresses without consent.
Even though DefiDesh is read-only, surprise connections violate user
expectations and are a security anti-pattern.

### How it's enforced
Per-chain localStorage flags:
- `defidesh_evm_disconnected`
- `defidesh_solana_disconnected`
- `defidesh_sui_disconnected`

Connection watchers in `providers.tsx`:
- `EvmConnectionWatcher`
- `SolanaConnectionWatcher`
- `SuiConnectionWatcher`

When a user clicks Disconnect, the flag is set. On page load, the watchers
check the flag and refuse to restore the connection if the flag is set,
even if the underlying wallet provider reports a saved session.

### Future chains
Any new chain added (Aptos, Sei, etc.) must add its own disconnected flag
and connection watcher following the same pattern. No exceptions.

---

## Rule 2: Refer to wallets by chain, not by brand

In UI text, error messages, documentation, and any user-facing string,
refer to wallets by chain name, never by brand name.

### Correct
- "Connect your Solana wallet"
- "Sui wallet disconnected"
- "EVM wallet not detected"

### Incorrect
- "Connect Phantom"
- "MetaMask not detected"
- "Sui Wallet disconnected" (the brand "Sui Wallet" looks like the chain)

### Why
Users may use any compatible wallet on a given chain. Naming a specific
brand implies preference and excludes users on other wallets. The chain is
universal; the brand is not.

---

## Rule 3: Watched addresses and connected wallets

DefiDesh supports two ways to view a wallet's positions:

- **Connected wallet**: the user has unlocked a browser wallet in the
  current session
- **Watched address**: the user has pasted an address into Manage Wallets

### Parity principle
A connected wallet must produce an identical user experience to the same
address pasted as a watched address. The connection method determines
*how* the address enters the system, not *what* the user sees afterward.

This means:
- Dashboard shows the same positions
- Analytics shows the same fees and Capital G/L
- LP P&L shows the same calculations
- Position detail pages, activity log, and every other view work identically
- No special-cased code paths that diverge connected from watched

### No duplicates across the two methods
If a user has connected a wallet on a given chain, they must not also be
able to add that same address as a watched wallet on the same chain.

When a duplicate is detected, the system rejects the addition with a clear
message such as:

> "This wallet is already connected. Disconnect it first if you want to
> view it as a watched address."

Reason: allowing duplicates causes the same positions to count twice in
fee totals, twice in capital G/L, twice in any aggregation. The user sees
inflated and incorrect numbers. The bug is hard to spot because the data
looks plausible.

### Separation in code
Connected wallets and watched addresses are stored separately in state and
in localStorage. Disconnecting a wallet does not remove watched addresses
for that chain. Adding a watched address does not affect connected wallets.

The two paths share the same downstream pipeline (position fetching, P&L
calculation, display), which is what gives them parity. But the upstream
storage and disconnect/remove actions are independent.

---

## Rule 4: Two accounts must stay strictly separate

Osho uses DefiDesh for verification with two separate accounts:

**Account 1:**
- EVM: 0xD99a9e66d000d4024dC77f00f784Cc45F8804F20
- Solana: GndR...pogC
- Sui: 0xdc...c30d

**Account 2:**
- EVM: 0xEf93B7f19dcEf8E5f9c5F41CBBCe9e78B16B8d0C
- Sui: 0x8ef8c104d43e55b11fc6afcd58088274fabff2d30480dd4c4283ff834ac2297d

These two accounts are never mixed in analysis, debugging, or fixes.

### Why
Manual claim records (Google Sheets ground truth) are kept per-account. A
bug that shows wrong values for Account 1's Aerodrome positions might not
appear in Account 2 at all because Account 2 doesn't have Aerodrome
positions. Mixing the two accounts during diagnosis produces false signals
and masked bugs.

### Rule in practice
When investigating a bug, always identify which account the affected
wallet belongs to. State it explicitly. Never assume.

---

## Rule 5: Address display follows existing conventions

When displaying an address in the UI:
- Show the first 6 and last 4 characters with `...` between
- Example: `0xD99a9e6...4F20`
- Full address on hover or click-to-copy

This is a convention, not a security rule — but it's listed here because
deviating from it is the kind of change that should require explicit
approval rather than happening as a side effect of another fix.

---

## Rule 6: Watched addresses persist across sessions

Watched addresses are stored in localStorage and persist across browser
sessions. A user who pastes an address today will see the same address
loaded automatically the next time they open DefiDesh in the same browser.

### Constraints

**Per-chain storage**
Each chain has its own watched-address list:
- EVM watched addresses
- Solana watched addresses
- Sui watched addresses

Any new chain added (Aptos, Sei, BNB Chain, etc.) must follow the same
per-chain pattern.

**Cap at 20 per chain**
A maximum of 20 watched addresses per chain. When the user tries to add a
21st watched address on a given chain, the system rejects with a message
such as: "Watched address limit reached for this chain (20). Remove an
existing address to add a new one."

Reason: localStorage has size limits, and a list of 20 covers any realistic
personal portfolio-management use case while preventing accidental bloat.

**No expiration**
Watched addresses do not expire. They are removed only when the user
explicitly clicks the delete/trash button on that address.

**User-controlled clearing**
The Manage Wallets modal must include a way for the user to remove
individual watched addresses. A bulk "Clear all watched addresses" option
is recommended but not required.

### Security note
Persistent watched addresses are not a security risk because DefiDesh is
read-only and watched addresses are public information (anyone with the
address can already see positions on a block explorer). The risk is
limited to fingerprinting on shared devices, which is mitigated by the
user-controlled clearing.

---

## Decision tree: "Is this change safe from a wallet-security standpoint?"

1. **Does my change touch wallet connection logic?**
   - No → safe, proceed
   - Yes → continue

2. **Could my change cause a wallet to auto-connect when the user has the
   disconnected flag set?**
   - Yes → reject, fix the regression
   - No → continue

3. **Does my change mix Account 1 and Account 2 wallets in any analysis,
   logging, or display?**
   - Yes → reject, separate them
   - No → continue

4. **Does my change refer to any wallet by brand name in user-facing text?**
   - Yes → reject, use chain name
   - No → safe, proceed

---

## When to amend this file

Amend wallet-security.md when:
- A new chain is added and needs its own disconnected flag + watcher
- A new connection pattern is introduced (e.g., signature-based auth, if
  ever added)
- A security review reveals a gap in current rules

Do not amend this file based on a single bug. Wallet security rules are
stable. If a bug appears that touches these rules, the fix should conform
to the rules, not change them.

---

## Forward-looking note: subscription gating

DefiDesh plans to introduce subscription-based feature gating in the future.
Some features will be available to free-tier users (basic position viewing,
limited analytics) and other features will require a paid subscription
(advanced analytics, historical portfolio tracking, alerts, etc.).

When subscription gating is implemented, it must remain architecturally
separate from wallet connection logic. Specifically:

- Wallet connection state must never depend on subscription state
- Subscription state must never affect which wallets can be connected
- Gating happens at the feature level, not the wallet level
- All wallet-security rules above continue to apply for all users
  regardless of subscription tier
- Gating logic must live server-side, never client-side, to prevent
  bypass via DevTools or modified client code

The exact subscription tiers, pricing, and feature splits are not yet
defined. This file will be updated when the design is finalized.
