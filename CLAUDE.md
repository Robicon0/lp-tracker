# CLAUDE.md

This file is the front door for Claude Code sessions on DefiDesh. It is
read at the start of every session via the `sprint-start` skill. Stable
rules and reusable patterns live in `.claude/rules/` and `.claude/skills/`.
This file holds only what changes session-to-session: active sprint,
queue, recent fixes, known limitations.

---

## Project identity

**DefiDesh** (defidesh.com) is a public multi-chain DeFi LP position
tracker. Vision: the world's best LP tracker — accurate real-time data
for any wallet on any chain, at scale for thousands of users globally.
"Desh" means everything about crypto in one place; future scope includes
news, trends, token research, and macro sections.

**Stack:** Next.js App Router / TypeScript / Tailwind CSS / Recharts,
deployed on Vercel Pro. Neon Postgres. GitHub: `Robicon0/lp-tracker`,
branch `main`. Local dev: `~/lp-tracker-fresh`. Twitter: `@defidesh`.

**Chains and protocols:**
- EVM (Base, Arbitrum, Optimism, Ethereum, Polygon, HyperEVM): Aerodrome,
  Uniswap V3, Velodrome, HyperSwap, KittenSwap, ProjectX
- Solana: Orca, Raydium
- Sui: Bluefin, Cetus, Momentum (dashboard only; activity/P&L pending)
- Lending/borrowing: AAVE V3, Dolomite, Kamino, Jupiter Lend, Suilend,
  AlphaFi, HyperLend, Hypurr, HypurrFi

---

## How to start every session

Invoke the `sprint-start` skill before doing anything else. It runs the
six-step startup sequence: read this file, scan `.claude/rules/`, check
recent commits, confirm the active sprint, state the methodology, wait
for the specific task.

---

## Active sprint

**Sprint 1: HyperEVM cold-start hardening.**

**Goal:** Server-side price cache (Vercel KV free tier or in-memory
module cache) so the second user inherits the first user's warm CoinGecko
data. Resolves Account 2 ProjectX exclusion regression where cold-start
CG saturation drops resolution.

**Status:** Pre-sprint infrastructure work in progress. `.claude/` folder
restructure underway. Sprint 1 implementation has not yet started.

---

## Sprint queue

In order. One active at a time. Each sprint must ship before the next
begins.

1. **HyperEVM cold-start hardening** (active) — server-side price cache.
2. **Account 1 Aerodrome investigation** — diagnostic harness against
   Account 1 wallets to identify missing/wrong/excluded positions
   (manual ~$57 platform vs hundreds expected).
3. **Closed Sui position fee recovery** — Sui event indexer on free
   public RPC. Filter Bluefin/Cetus/Momentum package addresses.
   Reconstruct deposit/withdrawal/fee events from event log (objects
   destroyed but events preserved).
4. **Momentum activity route** — modeled on Bluefin, uses Sprint 3
   indexer.
5. **Closed Solana position fee recovery** — Solana event indexer using
   free public RPC. Parse Orca/Raydium program instructions from wallet
   transaction history.
6. **Capital G/L expansion to Sui + Solana** — wire indexed events into
   Capital G/L sum. Remove "EVM only" UI label.
7. **UI for closed Sui + Solana positions** — Closed tab support.

---

## Recent fixes

Most recent first. Commit hashes are authoritative; descriptions are
shorthand.

- **`751743b`** — Client data layer architectural pass. Per-endpoint
  concurrency limiter (MAX_PER_ENDPOINT=2), increased attempt timeouts
  (60/60/90s), differentiated cache TTL (success 5min, empty 60s,
  errors uncached), cache version bumped to v21.
- **`be94edf` / `dae0599`** — HyperEVM/ProjectX claim-time pricing.
  CG-historical-awaited for closed-position bounded claim-date sets
  with 25s Promise.race cap. ProjectX warm $1,776.29 vs manual
  $1,780.44.
- **`6601d38`** — Velodrome burned-NFT recovery. Uses
  `VELODROME_FALLBACK` pool `0x9763...7c8b` (USDC/WETH reversed
  ordering).
- **`7c60cce`** — Uniswap V3 burned-NFT recovery. Defensive batched
  `eth_getLogs` with $50M overflow guard.
- **`90faaf9`** — Aerodrome burned-NFT recovery via
  `app/lib/evmEverOwnedNftIds.ts`. Recovered 4 closed positions
  worth ~$743 in fees.
- **`26fd213`** — Cetus token resolution + zero-amount + Sui spot
  fallback. `0x2::sui::SUI` and CETUS reward token mapped to CG IDs.
  CETUS uses cg-spot + LKG exception. Result: 32/78 → 81/81.

---

## Where things live

**Stable rules** (always loaded, small):
- `.claude/rules/pricing-invariants.md` — fee valuation, exceptions,
  display currency, capital G/L formula
- `.claude/rules/architecture-principles.md` — platform-level fixes,
  no per-chain branches, additive-only, sprint discipline
- `.claude/rules/cache-versioning.md` — version bump protocol, current
  versions, TTL by result type
- `.claude/rules/wallet-security.md` — auto-connect prohibition,
  connected/watched parity, duplicate rejection, persistence rules
- `.claude/rules/commit-protocol.md` — build clean before commit,
  verification before "done", stop-and-report threshold
- `.claude/rules/instrumentation.md` — `[PRICE_LOG]` event schemas,
  source enum, analysis patterns

**Skills** (loaded on demand when invoked):
- `.claude/skills/sprint-start/SKILL.md` — session startup sequence
- `.claude/skills/investigate-first/SKILL.md` — 8-step debugging
  methodology
- `.claude/skills/fix-prompt-template/SKILL.md` — Claude Code prompt
  structure (Investigation / Implementation / Verification)
- `.claude/skills/burned-nft-recovery/SKILL.md` — EVM closed-position
  recovery pattern

---

## Methodology

Investigate-first, always. Before any fix:

1. Instrument and capture logs
2. Diagnose root cause from evidence
3. Plan with Osho in plain language, get explicit confirmation
4. Write thorough Claude Code prompt using `fix-prompt-template`
5. Verify post-fix `route_summary` matches expected numbers
6. Commit and push automatically when verified — never ask permission
7. Stop and report if verification gap is significant (20%+)

All changes are additive unless explicitly replacing broken logic.
Every fix is a platform fix that benefits all current and future users
with similar position shapes. Never wallet-specific framing.

---

## Known limitations

**HyperEVM has no archival `eth_call`.** Chainstack returns -32002
"Archive Debug Trace not available on plan." Public RPC at
`rpc.hyperliquid.xyz/evm` is non-archival for state. The sqrtPriceX96
resolver cannot run on HyperEVM. Claim-time pricing for HyperSwap,
KittenSwap, ProjectX must use CG-historical awaited for closed
positions, fire-and-forget for open.

**Empty-Sugar edge case (Aerodrome, Velodrome).** For wallets with zero
open positions, the Sugar contract's enumeration returns empty, causing
`buildClosedPositions` to be skipped. Fees are recovered but closed-record
display is gated. Pending fix.

**Sui closed positions not yet retrievable.** Position objects destroyed
on close. Solution exists in plan (event reconstruction); implementation
queued as Sprint 3.

**Solana closed positions not yet retrievable.** Position state destroyed
on close. Solution exists in plan (transaction history parsing); requires
Helius RPC paid upgrade for speed. Implementation queued as Sprint 5.

**Suilend APY not showing.** Reserve interest rate fields need parsing.
AlphaFi and Dolomite APY now working from on-chain data.

**Pool Statistics N/A for some pools.** Low priority backlog item.

---

## Wallet addresses for verification

Osho's two accounts. Never mix in analysis.

**Account 1:**
- EVM: `0xD99a9e66d000d4024dC77f00f784Cc45F8804F20`
- Solana: `GndR...pogC`
- Sui: `0xdc...c30d`

**Account 2:**
- EVM: `0xEf93B7f19dcEf8E5f9c5F41CBBCe9e78B16B8d0C`
- Sui: `0x8ef8c104d43e55b11fc6afcd58088274fabff2d30480dd4c4283ff834ac2297d`

Manual claim records (Google Sheets ground truth) are kept per-account.
Always state which account the affected wallet belongs to before
investigating.

---

## Tools and resources

**Development:**
- IDE: VS Code with Claude Code extension
- Strategy/prompting: Claude.ai (this conversation)
- Repo: `Robicon0/lp-tracker`, branch `main`

**Hosting and database:**
- Vercel Pro ($20/month) — auto-deploys from `main`
- Neon Postgres

**RPC providers:**
- Chainstack `nanoreth` — HyperEVM (`HYPEREVM_ARCHIVE_RPC`)
- Alchemy — EVM chains, Solana
- Helius — Solana (paid upgrade needed for closed-position tx history
  speed)

**Price and pool data:**
- CoinGecko API — spot + historical (rate limit management active)
- On-chain sqrtPrice derivation — `app/lib/v3PriceDerivation.ts`
- DefiLlama — pool metadata
- Etherscan V2 API (chainid=999 for HyperEVM deposits) — `DefiDesh`
  API key in env

**Analytics:**
- Vercel Analytics (`@vercel/analytics`, added to `app/layout.tsx`
  outside Providers wrapper)

**Feedback:**
- Formspree floating feedback button

**Protocol-specific addresses:**
- Cetus packages: `0x1eabed72...` (fees/lifecycle),
  `0xdb5cd62a06c79695...` (V2 deposits/withdrawals),
  `0xdc67d6de3f00051c...` (V2 rewards)
- Cetus position field: `position`. Amounts: `amount_a` / `amount_b`
- Bluefin position field: `position_id`
- Velodrome fallback pool: `0x9763...7c8b` (USDC/WETH, reversed
  ordering)

**Cache versions (verify against code before bumping):**
- `lp-pnl-events-v21`
- `analytics-activity-v13`
- `cetus-activity-v3`
- `bluefin-activity-v3`

---

## Business context

DefiDesh is in trust-building phase. No subscription revenue yet. Only
paid infrastructure is Vercel Pro ($20/month). Paid services deferred
until traffic justifies: CoinGecko paid (~$129/mo at 100+ daily users),
Helius (~$49/mo for closed Solana history speed), Chainstack archival
(~$49/mo, would drop HyperEVM CG workaround).

Multi-currency display (EUR, GBP, INR, JPY, SAR, AED, etc.) planned for
future. All internal pricing stays USD; FX conversion at UI layer only.

Subscription-based feature gating planned for future. Must remain
architecturally separate from wallet logic. Server-side only.

Osho is currently sole developer due to cost constraints. Plans to hire
team once platform generates income. Architecture must stay team-friendly.

---

## When to amend this file

Amend `CLAUDE.md` at the end of every session where work was committed.
Specifically:

- Move the just-completed sprint out of "Active sprint" and into recent
  fixes (with commit hash)
- Promote the next sprint in the queue to "Active sprint"
- Add the most recent commit to "Recent fixes" (keep the list to ~6
  entries — older ones drop off)
- Update "Known limitations" if a limitation was resolved or a new one
  discovered
- Update "Cache versions" if any version was bumped
- Update Osho's wallet address if changed (rare)

Do not amend stable rules here. If a stable rule needs to change, amend
the relevant file in `.claude/rules/`. This file stays focused on what
changes session-to-session.
