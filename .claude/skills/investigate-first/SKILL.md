---
name: investigate-first
description: Use this skill whenever a DefiDesh bug, regression, or unexpected behavior is reported — wrong fee values, missing positions, low resolution rates, route failures, or any production discrepancy from manual claim records or expected behavior. This skill enforces the investigate-first methodology that broke a 3-week debugging loop: instrument, capture logs, diagnose from evidence, plan with the user, then write a thorough Claude Code prompt. Triggers include phrases like "bug", "wrong", "missing", "regression", "doesn't match", "should be X but shows Y", "ProjectX gap", "Aerodrome under-reports", "resolution rate", any mention of route_summary, or any new diagnostic question about why DefiDesh is producing incorrect output.
allowed-tools: Read, Bash, Grep, Glob
---

# Investigate-First Debugging

This skill enforces the methodology that turns vague bug reports into
verified platform-level fixes. It exists because pattern-matching fixes
based on guessing symptoms produced a 3-week loop of failed attempts.
Reading evidence before writing fixes broke that loop.

## When to use this skill

Invoke this skill whenever any of the following happens:

- A bug or regression is reported (Osho's wallets, Twitter user, or
  discovered in production logs)
- Resolution rates drop or fail to meet target (e.g., 32/78 instead of
  81/81)
- Manual claim records (Google Sheets ground truth) disagree with what
  DefiDesh displays
- A previously working route starts failing intermittently
- Any production discrepancy where the cause is not obvious

Do not invoke this skill for:
- Documentation updates
- Pure refactors with no behavior change
- UI-only changes (color, layout, copy)
- New feature additions that don't touch existing logic

## The methodology

Eight steps, in order. Do not skip steps.

### Step 1: Confirm the symptom

State the bug in concrete platform-level terms:

> "X% of users with Y positions on Z chain see wrong values for W."

If the symptom can only be expressed as "my wallet shows X," it's not yet
platform-level. Generalize before continuing.

If the symptom involves a verification number (e.g., manual record says
$1,780, platform shows $1,776), record both numbers explicitly. The
target gap is what defines "fixed."

### Step 2: Capture logs from real load

Reproduce the bug while capturing `[PRICE_LOG]` output:

```bash
# Start the dev server with log capture
npm run dev 2>&1 | tee /tmp/devserver.log
```

Then reproduce the bug by:
- Loading the affected wallet on localhost
- Triggering the affected route (visit the dashboard, analytics, LP P&L)
- Letting the route complete (some routes are slow on cold start)

If the bug only appears in production, capture from Vercel logs instead.
See `.claude/rules/instrumentation.md` Rule 4.

### Step 3: Diagnose from evidence

Read the logs. Do not guess. Use the analysis patterns from
`.claude/rules/instrumentation.md` Rule 5.

Primary diagnostic questions:
- What does the `route_summary` event say? (Resolution rate, duration)
- Which positions failed to resolve? (`source: "unknown"` in
  `fee_claim_resolution`)
- Is there a pattern in the failures? (Same protocol, same chain, same
  token, same time of day)
- Is the failure cold-start specific or persistent?
- Are there rate-limit symptoms? (CoinGecko 429, Etherscan 5/sec budget)

Write the diagnosis as a one-paragraph summary that another developer
could read and understand without seeing the logs.

### Step 4: Identify root cause vs. symptom

The diagnosis from Step 3 may surface multiple issues. Separate them:

- **Root cause**: the underlying logic flaw producing wrong values
- **Symptom**: the observable behavior (wrong number, missing position)
- **Compounding factor**: something that makes the symptom worse but is
  not the cause (cold start, rate limit pressure, etc.)

Fixes target root causes. Compounding factors are noted but not patched
in the same fix unless the root cause is in the compounding factor itself.

### Step 5: Plan with the user

Before writing any code or any Claude Code prompt, summarize the plan in
plain language for Osho:

1. What the bug is (platform-level framing)
2. What the diagnosis showed
3. What the proposed fix does and why
4. What metric will verify the fix (target `route_summary` numbers)
5. What edge cases to test

Wait for Osho's explicit approval before continuing. Never just build.

### Step 6: Write a thorough Claude Code prompt

Use the `fix-prompt-template` skill to structure the prompt. Key elements:

- Exact problem statement with platform-level framing
- Exact expected outcome with verification numbers
- All known edge cases
- Three-phase structure: Investigation / Implementation / Verification
- Strict rules: preserve `[PRICE_LOG]` instrumentation, additive-only
  changes unless replacing broken logic, no per-chain branches in
  client code
- Always end with: "Build, test on localhost, confirm visually that it
  works, then push to GitHub. Do not mark it done until the output is
  verified. Update CLAUDE.md when done."

### Step 7: Verify post-fix `route_summary`

After Claude Code reports completion, do not commit until the
`route_summary` event for the relevant route shows numbers matching the
target from Step 5.

If the numbers match within a small margin: proceed to commit per
`.claude/rules/commit-protocol.md`.

If the numbers are off by a significant margin (20%+): stop and report
to Osho per `commit-protocol.md` Rule 3. Do not iterate silently.

### Step 8: Update memory and CLAUDE.md

Once the fix is verified and committed:

- Update CLAUDE.md to reflect the completed fix (commit hash, sprint
  status, any new constraints discovered)
- If the fix revealed a new architectural rule (a new exception, a new
  constraint, a new pattern), update the relevant file in
  `.claude/rules/`
- If the fix revealed something worth preserving across Claude.ai
  sessions, propose a memory update to Osho

## Anti-patterns

Things this skill exists to prevent:

### Symptom patching
Writing a fix that makes one specific wallet's numbers match without
understanding why other wallets are affected. The fix passes the immediate
test but breaks at scale.

### Guess-and-check iteration
Trying fixes without reading logs first, then iterating until something
appears to work. This burns tokens, doesn't reveal the root cause, and
often produces code that "works" for the wrong reasons.

### Silent tweaks after failed verification
When `route_summary` shows worse-than-expected numbers, quietly adjusting
parameters until the numbers look better. This hides architectural
mismatches that will resurface later.

### Skipping the plan-with-user step
Writing a Claude Code prompt without first explaining the plan in plain
language and getting confirmation. Loses Osho's chance to catch a
misunderstanding before tokens are spent.

## Reference: the original 3-week loop

Before this methodology was adopted, debugging followed this pattern:

1. Bug reported
2. Guess at cause based on the symptom
3. Write a fix based on the guess
4. Test, see the fix didn't help (or made things worse)
5. Repeat with a new guess
6. After many iterations, ship something that "kind of works"
7. Discover later that the root cause was never addressed

The investigate-first methodology replaces step 2 with "read evidence
from instrumentation" and step 3 with "diagnose root cause from evidence,
then plan with user." This is the single highest-leverage change in how
DefiDesh is developed.

## When to amend this skill

Amend this skill when:
- A new diagnostic pattern proves consistently useful and should be
  standardized
- A new category of bug (e.g., subscription-gating bugs, when those exist)
  requires its own investigation flow
- The 8-step methodology itself needs a step added or removed based on
  evidence from many sprints

Do not amend based on a single fix. The methodology is stable.
