# Architecture Principles

These are the platform-level rules for how DefiDesh is built. Every fix, every
new feature, every new chain integration must conform. These rules exist
because DefiDesh serves any user globally — what works for one wallet must
work for thousands.

## Core principle

DefiDesh is the world's best LP position tracker for any user on any chain.
Every fix is a platform fix that benefits all current and future users with
similar position shapes. Never frame a bug as wallet-specific.

---

## Rule 1: Every bug is a platform bug

When a bug is reported (whether by Osho's own wallets, a Twitter user, or
discovered in logs), the framing is always:

> "X% of users with Y positions on Z chain see wrong values."

**Never** frame as:
> "My wallet shows wrong fees on Aerodrome."

Reason: wallet-specific framing leads to wallet-specific patches that don't
generalize. Platform-level framing forces root-cause analysis, which fixes
all current and future users with the same position shape.

### Test for whether a fix is platform-level

After writing a fix, ask: "Would this fix work correctly for a brand-new
wallet I've never seen, on the same chain, with the same protocol, with a
different position size and different token pair?"

If the answer is no, the fix is wallet-specific. Reject it. Find the
underlying platform-level cause.

---

## Rule 2: No per-chain branches in client code

The mechanism for fetching positions, computing P&L, resolving prices, and
displaying results must be uniform across all chains. Per-chain `if` branches
in client code are forbidden.

Per-chain *parameters* (timeouts, concurrency limits, RPC endpoints) are
allowed and live in config. Per-chain *logic* is not.

### Why this matters

Per-chain branches grow combinatorially. Adding chain N+1 means touching N
files instead of one config entry. After 10 chains, the codebase becomes
unmaintainable.

### How to handle chain differences

Chain capabilities differ (HyperEVM has no archival eth_call; Sui/Solana
destroy position objects on close; EVM keeps NFTs after close). These
differences are handled in three ways, in order of preference:

1. **Uniform conservative parameters** that accommodate the slowest chain.
   Example: per-endpoint concurrency limit set to accommodate HyperEVM's
   5 req/sec Etherscan budget.

2. **Capability detection** at runtime. Example: detect whether archival
   eth_call is available, fall back to CoinGecko historical if not.

3. **Chain-specific helper modules** (not branches in client code).
   Example: `app/lib/evmEverOwnedNftIds.ts` is an EVM-only helper, but
   client code calls it through a uniform interface.

---

## Rule 3: Additive-only changes

All fixes must be additive unless explicitly replacing broken logic.

Adding new instrumentation, new fallback paths, new cache layers, new
position recovery mechanisms: additive. Allowed by default.

Replacing or deleting existing logic: requires explicit user approval and
a stop-and-report if the replacement is more than minor.

### Reason

DefiDesh has accumulated load-bearing logic over months. Replacing logic
without understanding why it was load-bearing has caused production
regressions (e.g., the concurrency-5 incident that re-broke ProjectX by
removing HyperEVM serialization that was needed for Etherscan rate limits).

When in doubt, add a new path alongside the existing one. Verify the new
path works. Only then consider removing the old path.

---

## Rule 4: Every new protocol works everywhere

When a new protocol is integrated (Curve, Balancer, Trader Joe, or any
future protocol), it must work end-to-end across all of:

- Dashboard (open + closed positions visible)
- Analytics (lifetime fees included in Fee Income by Protocol)
- LP P&L (deposits, withdrawals, IL computed correctly)
- Position detail page (per-position view works)
- Docs (protocol listed and explained)
- About page (protocol added to supported list)

A protocol that only works in some of these places is not integrated. It is
half-integrated. Half-integration is a worse user experience than no
integration because users see inconsistency.

---

## Rule 5: Every new chain must determine closed-position retrievability

When a new chain is added, the integration must explicitly determine — before
shipping — which of three categories the chain falls into:

### Category A: Closed positions are retrievable through normal queries
Example: EVM chains keep the position NFT after close. The NFT is queryable
via standard `eth_getLogs` and contract calls.

Requirement: integrate closed positions in the **same release** as open
positions. Do not ship "open only" and promise closed later.

Currently implemented for: Aerodrome (commit 90faaf9), Uniswap V3 (7c60cce),
Velodrome (6601d38). Helper: `app/lib/evmEverOwnedNftIds.ts`.

### Category B: Closed positions are retrievable through event reconstruction or tx-history parsing
Example: Sui destroys the position object on close but preserves the event
log forever on-chain. Solana destroys the position state on close but
preserves the full transaction history.

Requirement: integrate open positions first. Queue closed-position recovery
as a separate sprint. Document the temporary gap in the about page so users
understand why closed positions on that chain are pending.

Currently IMPLEMENTED:
- Sui event reconstruction — `app/lib/suiClosedPositions.ts` (Cetus + Bluefin
  Sprint 2.2b `bb7fc0d`; Momentum Sprint MOMENTUM `750f566`).
- Solana tx-history parsing — `app/lib/solanaClosedPositions.ts` (Orca Sprint
  3-FREE `d1bf447`; Raydium Sprint RAYDIUM `d7c6c81` — ONE shared wallet scan
  serves both protocols, since the scan is per-WALLET not per-protocol).

**Canonical Category-B pattern (proven twice — Sui `bb7fc0d`, Solana `d1bf447`):**
scan the wallet's full immutable history ONCE → reconstruct per-position
lifecycles from on-chain artifacts (Sui: event payloads; Solana: instruction
accounts + inner transfers matched against the pool's on-chain VAULT addresses,
position identified by ever-opened-set match, never a fixed account index) →
closed = ever-opened − currently-owned → value historical-only (never spot) →
reuse `computePositionPnL` → persist in a versioned immutable Redis key
(`closed_pos_{chain}_v1`, empty-never-cached). For chains whose free-tier RPC
throttles the backfill, use the **Alchemy free-tier paced-scan pattern**
(Sprint 3-FREE): serial small batches + exponential backoff on 429 +
retry-until-complete — target 100% completeness, not speed (a naive burst
dropped 37% of txs); the scan is background + cached-once-per-wallet, so
latency is a non-issue and a paid RPC tier is unnecessary until sustained
hundreds of NEW wallets/day.

### Category C: Closed positions are not retrievable at all
Example: a hypothetical chain that destroys all on-chain history at close
with no events, no transaction logs, no archival access.

Requirement: document the permanent limitation in the about page. Open
positions only.

No currently supported chains fall into this category.

### Decision rule for new chains
Before integrating chain N+1, the integrator must answer:
1. Is the position state preserved after close? (Category A if yes)
2. If no, are events or transaction history preserved? (Category B if yes)
3. If no to both, document as Category C.

---

## Rule 6: Conservative parameters accommodate the slowest chain

When choosing global parameters (timeouts, concurrency limits, cache TTLs,
retry counts), use values that work for the most-constrained chain, not the
fastest.

### Examples

- **Concurrency**: HyperEVM's Etherscan free-tier budget is 5 req/sec.
  Per-endpoint concurrency is capped at 2 to leave headroom.

- **Timeouts**: HYPE historical CoinGecko fetches can take 60+ seconds
  under load. Activity route attempt timeouts are set to 60/60/90s, not
  the original 30/30/45s.

- **Cache TTLs**: success cached 5 minutes, empty results cached 60 seconds,
  errors not cached. Empty-result caching prevents stampedes against slow
  chains; not caching errors allows fast recovery from transient failures.

---

## Rule 7: One active sprint at a time

The active sprint is the only thing being actively implemented. Future
sprints are queued, not started in parallel.

### Why
Parallel work on overlapping concerns creates merge conflicts, context-switch
cost, and half-finished features that ship as inconsistent user experiences.
The cost of finishing one sprint before starting the next is small. The cost
of half-finishing five sprints is large.

### How it scales
This rule is about avoiding parallel work that creates conflicts — not about
team size.

Currently DefiDesh is built by a single developer (Osho with Claude Code),
so "one active sprint" is naturally enforced.

When the team grows, this rule evolves: multiple parallel sprints are
allowed, but only if each sprint has explicit ownership and they touch
different files. Two sprints touching the same files is never allowed.

The sprint queue lives in CLAUDE.md and is updated only at sprint boundaries
(after one sprint ships, before the next begins).

---

## Rule 8: Shared CLMM utilities are the canonical pattern

All current and future concentrated-liquidity (CLMM) protocols — on any chain —
import their fee math from `app/lib/clmmFeeMath.ts` and (for binary-account
chains) register their tick decoders into the appropriate registry in
`app/lib/clmmTickDecoder.ts`. **Inline underflow guards and inline tick decoders
are forbidden in new code.**

This exists because the Sprint 1.7 → 1.7e arc proved two things travel together
for every CLMM protocol: (1) the u128 fee-growth underflow guard, and (2) verified
tick/fee-growth decoder coverage. A guard without decoder coverage masks real fees
(Sprint 1.7c/1.7d: Orca's ZEC/USDC hid ~$141 behind an unsupported tick-array
format); decoder coverage without a guard lets a malformed read explode to
sextillions. Extracting both into shared utilities means a new protocol inherits
the protection by **importing and registering**, not by a developer remembering.

### The canonical imports
- `safeCalcPendingFee(liquidity, feeGrowthInside, checkpoint)` → `{ fee, guarded,
  wrappedDelta }` — universal, pure bigint, chain-agnostic.
- `calcFeeGrowthInside(...)` — the shared Uniswap-V3 fee-growth-inside recomputation.
- `emitFeeUnderflow(result, ctx)` — logs `fee_underflow_detected` on a guard fire
  so callers can't forget the instrumentation.
- `solanaCLMMTickRegistry` + `anchorDiscriminator(name)` — Solana binary
  tick-array dispatch; each protocol registers a decoder per discriminator.

### Tick decoding is chain-family-specific BY DESIGN (not a leaky abstraction)
- **Solana** (binary accounts, Anchor discriminators, possible multiple formats):
  use `solanaCLMMTickRegistry`. Register EVERY known format so a new on-chain
  format fails loudly (`unsupported_tick_array_format`) rather than silently
  zeroing fees.
- **Sui** (Move `Table` of JSON dynamic fields, one format per protocol): NO tick
  registry — extract JSON fields and feed them straight into the shared fee math.
  A buffer/discriminator registry would be a leaky abstraction here.
- **Future chain families** (Aptos, Sei): add a new per-chain-family registry if
  the chain uses binary tick accounts; otherwise follow the Sui pattern. Never
  force one registry across chain families.

### A guard fire is a signal, not a zero
Never treat a `fee_underflow_detected` event as "fees are genuinely zero." It can
indicate an upstream decoder gap. Verify the decoder before trusting a guarded
zero. New protocols follow `.claude/skills/add-new-protocol/SKILL.md`.

---

## Rule 9: tokenResolver is canonical for token identity

`app/lib/tokenResolver.ts` (Sprint 1.10) is the single, platform-wide source of
truth for resolving an on-chain token identifier (EVM/HyperEVM contract, Solana
mint, Sui coin type) to its `{ symbol, decimals, cgId, priceable }`. Every
current and future protocol on every chain resolves token identity through it.

**Per-protocol hardcoded token maps are forbidden in new code.** A new protocol
must NOT carry its own `KNOWN_COINS` / `KNOWN_TOKENS` / `TOKENS` map. Pass the
on-chain identifier to `resolveToken()` and use the returned symbol, decimals,
and cgId (feed cgId into the existing CoinGecko pricing pipeline — the resolver
is identity, not price).

The cascade is: in-process + Upstash Redis cache → hardcoded high-stakes
constants (`app/lib/tokenConstants.ts`: native tokens + canonical stables, the
only things that NEVER auto-resolve) → CoinGecko contract lookup → on-chain
metadata (authoritative symbol+decimals — decimals is NEVER a blind 18) →
CoinGecko symbol search → DeFiLlama coverage check → graceful unresolvable
(correct symbol/decimals, `priceable:false`, Option A "price unavailable" UX).

The existing `KNOWN_COINS`/`KNOWN_TOKENS`/`TOKENS` maps still present in the
dashboard routes are **byte-identical fallbacks consulted before the resolver**,
intentionally left in place during Sprint 1.10 so previously-mapped tokens are
provably unchanged. They are being phased out — a future sprint removes them once
resolver coverage is proven in production. Do not add entries to them; add
high-stakes pins to `tokenConstants.ts` instead, and let everything else
auto-resolve.

All CoinGecko HTTP in the resolver flows through the process-wide `withCgPacing`
queue (architecture Rule 6 / pricing-invariants) so long-tail discovery can never
burst the free-tier budget. A `token_resolution_failed` event is a
discoverability gap to investigate, never a reason to hide a token or break a
page.

---

## Rule 10: Aggregate blocks render progressively — never "no partial totals reveal"

Any UI block that aggregates over data arriving from multiple independent async
sources (positions across chains, per-position activity fetches, closed-position
scans, wallet-scope fee scans) MUST render its **partial** result as soon as the
FIRST input lands, and show remaining work as a **non-blocking status indicator**
— never skeleton/spinner the whole block until the LAST input completes.

This is the "no partial totals reveal" anti-pattern, removed platform-wide in
Sprint LPPNL-PERF (`535453e`). The analytics LP P&L block used to skeleton every
cell while `lpPnl.isLoading` (= any per-position fetch in flight), showing
"calculating…" for 5+ minutes on a heavy first-time wallet — even though the
aggregate was already recomputed on every landed fetch. Sprint PERFORMANCE
(`f4b58ac`) had fixed the identical gate for the positions TABLE (progressive rows)
but the aggregate block was missed.

### The rule in practice
- Gate the initial skeleton on "nothing computed yet" (`included === 0 && loading`),
  NOT on "everything computed" (`loading`). Once any item lands, show live partials.
- Slow/optional contributors (e.g. a closed-position tx-history scan) are surfaced
  as a **badge** ("scanning {chain} closed history…"), never a block-wide gate;
  cells that depend on them show the current partial + a sub-note, then finalize.
- Every long/unbounded contributor needs: a **client-side budget** (so a value is
  never silently pending forever), **in-flight dedup** (so concurrent consumers
  don't launch duplicate scans — module-level per-key promise map +
  `withActivityRouteCache`), and a server **`maxDuration`** (so the scan completes
  and caches instead of 504-looping). See PERFORMANCE baselines in CLAUDE.md.

### Test
Before shipping any aggregate/summary block, ask: "For a brand-new wallet with
significant history and NO warm cache, does this block show *some* real number
within a few seconds, and never an endless spinner?" If not, it violates Rule 10.

---

## Decision tree: "Is this fix platform-level?"

Ask in order:

1. **Does this fix work for any user with similar positions, not just
   Osho's wallets?**
   - No → not platform-level, find the root cause
   - Yes → continue

2. **Does this fix add a per-chain branch to client code?**
   - Yes → reject, move the logic to a helper module or runtime detection
   - No → continue

3. **Is this fix additive, or does it replace existing logic?**
   - Additive → proceed
   - Replacing → stop, get explicit approval, document why the old logic
     was wrong

4. **If this fix is for a new protocol or chain, does it work everywhere
   (dashboard, analytics, LP P&L, position detail, docs, about page)?**
   - Yes → proceed
   - No → not done yet

If all four checks pass, the fix is platform-level.

---

## When to amend this file

Amend architecture-principles.md when:
- A new architectural pattern is established and proven in production
- An existing principle is demonstrated wrong by evidence
- A new chain or capability category requires a new structural rule

Do **not** amend this file based on a single bug. Architectural principles
are stable; bug fixes are not.
