# Commit Protocol

These rules govern how Claude Code commits work to GitHub. They exist to
prevent unverified code from reaching production and to remove the friction
of asking permission for routine actions.

## Core principle

Claude Code commits and pushes automatically when work is verified and the
build is clean. Asking the user for permission to commit is forbidden.
Asking the user to confirm that work is "done" is also forbidden until the
verification steps have actually been completed.

---

## Rule 1: Build must pass before commit

No commit happens if the build is broken. Period.

Before any commit:
1. `npm run build` must complete with no errors
2. TypeScript type-checks must pass
3. No new lint warnings introduced by the change

If the build is broken, fix the build first. Do not commit a broken build
"for later cleanup." There is no later. Later means production users see
broken code.

---

## Rule 2: Verification before "done"

Claude Code never marks work as done until it has been verified.

Verification means three things, in order:

1. **Build is clean** (see Rule 1)
2. **Local smoke test passes** — the relevant page or endpoint has been
   tested on localhost and produces the expected output
3. **Instrumentation confirms success** — if the change touches a route
   with `[PRICE_LOG]` instrumentation, the `route_summary` event for the
   relevant route shows resolved counts matching expected values

If any of the three fail, the work is not done. Continue iterating.

---

## Rule 3: Stop-and-report when verification fails by significant margin

If verification produces numbers that are off by a small amount (a few
percent), Claude Code may iterate quietly to find the root cause.

If verification produces numbers that are off by a significant margin
(20%+, or wildly different from expected), Claude Code must stop and
report to the user before continuing.

### Why
Significant-margin failures are usually a sign of architectural mismatch,
not a small bug. Iterating without reporting wastes tokens and risks
silently shipping wrong logic that "kind of works" but doesn't actually
match the rule it claims to implement.

The concurrency-5 incident is the canonical example: a refactor produced
much worse resolution numbers than expected. Stopping and reporting caught
it before commit. Iterating silently would have shipped broken code.

### What "stop-and-report" looks like
Claude Code writes a brief summary of what was expected, what was observed,
and what hypothesis explains the gap. The user reviews and decides whether
to proceed, revise the approach, or abort.

---

## Rule 4: Automatic commit and push

When Rules 1, 2, and 3 are satisfied — build clean, work verified, no
significant-margin failures — Claude Code commits and pushes to GitHub
without asking permission.

### Commit message convention
- One-line summary in imperative mood ("Fix Cetus token resolution
  zero-amount handling")
- Optional body with reason and verification numbers ("81/81 resolved, was
  32/78. Sticky LKG cache prevents CG saturation.")
- Optional reference to relevant rules or sprints ("Addresses Sprint 1
  cold-start regression.")

### Branch
All commits go to `main`. Feature branches are not used at current team
size (see architecture-principles.md Rule 7).

### Push
Every commit is pushed to GitHub immediately. Vercel auto-deploys from
`main`, so push = production deploy.

---

## Rule 5: Preserve instrumentation through every fix

The `[PRICE_LOG]` instrumentation system in `app/lib/priceLogger.ts` is
permanent diagnostic infrastructure. It must survive every fix.

### What's preserved
- All `[PRICE_LOG]` emit calls in activity routes
- The event schemas (`price_lookup`, `fee_claim_resolution`,
  `route_summary`, `lp_pnl_position_lookup`, `lp_pnl_summary`)
- The source enum (`sqrtPriceX96`, `cg-historical-cache`,
  `cg-historical-fetch`, `cg-spot`, `symbol-search`, `sui-historical`,
  `stablecoin-fixed`, `unknown`)

### What's allowed
- Adding new emit calls for new code paths
- Adding new source values to the enum when a new resolution path is
  added
- Adding new event schemas for new categories of observability

### What's forbidden
- Removing existing emit calls
- Renaming existing event types or source values without updating
  downstream grep commands
- Disabling instrumentation in production

If instrumentation appears noisy or redundant, the answer is to filter
during analysis, not to remove emits from the code.

---

## Rule 6: Update CLAUDE.md at end of session

At the end of every Claude Code session where work was committed,
CLAUDE.md must be updated to reflect:

- What sprint or fix was completed
- Any new commit hashes for major fixes
- Any new architectural decisions worth preserving across sessions
- Any new entries to the queue of upcoming work

This is how state persists across Claude Code sessions. If CLAUDE.md is
not updated, the next session starts blind to the work that just shipped.

### What goes in CLAUDE.md vs. memory vs. `.claude/rules/`
- **`.claude/rules/`** — stable architectural rules, pricing invariants,
  cache versioning, security. Rarely change.
- **CLAUDE.md** — current state, active sprint, recent fixes with commit
  hashes, sprint queue. Updates every session.
- **Memory (userMemories)** — cross-session context for Claude.ai sessions
  (the strategy/prompting side, not Claude Code). Updates rarely.

---

## Decision tree: "Should I commit now?"

1. **Is the build clean?**
   - No → fix build first
   - Yes → continue

2. **Has the change been verified on localhost?**
   - No → run local smoke test
   - Yes → continue

3. **Does `route_summary` (or relevant verification metric) show numbers
   matching expected values?**
   - No, off by small amount → iterate quietly
   - No, off by significant margin (20%+) → stop and report to user
   - Yes → continue

4. **Has CLAUDE.md been updated to reflect the change?**
   - No → update CLAUDE.md
   - Yes → commit and push automatically

---

## When to amend this file

Amend commit-protocol.md when:
- A new verification step is added (e.g., automated tests introduced)
- A new branch strategy is adopted (e.g., feature branches when team
  grows past one developer)
- A new instrumentation system is added that should be preserved like
  `[PRICE_LOG]` is preserved today

Do not amend this file based on a single failed fix. Commit protocol is
stable. If a fix fails to verify, the answer is to follow the protocol
more carefully, not to change the protocol.
