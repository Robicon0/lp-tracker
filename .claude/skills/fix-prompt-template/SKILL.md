---
name: fix-prompt-template
description: Use this skill when writing a Claude Code prompt to ship a fix for DefiDesh. Invoke after the investigate-first skill has produced a diagnosis and root cause, and after the user has explicitly approved the plan. This skill enforces the three-phase prompt structure (Investigation / Implementation / Verification), strict rules around instrumentation and additive-only changes, and the verification-before-commit discipline. Triggers include phrases like "write the prompt", "Claude Code prompt", "fix prompt", "draft a prompt for", "ready to write the prompt", or any moment when the diagnosis is complete and we're about to hand work off to Claude Code.
allowed-tools: Read, Bash
---

# Fix Prompt Template

This skill produces Claude Code prompts that land fixes in one pass.
Every section is mandatory. Skipping sections is how prompts produce
half-fixes, missed edge cases, or symptom patches.

## When to use this skill

Invoke this skill when:

- The `investigate-first` skill has produced a verified diagnosis
- The plan has been explained to Osho and explicitly approved
- We are about to write the actual Claude Code prompt

Do not invoke this skill for:
- Initial investigation (use `investigate-first` instead)
- Sprint kickoff (use `sprint-start` instead)
- Documentation updates or small UI changes that don't need the full
  three-phase structure

## Prompt structure

Every Claude Code prompt follows this exact structure. Sections marked
**required** are non-negotiable. Sections marked *optional* can be
omitted when not relevant.

### Section 1: Context (required)

One paragraph stating:
- What the bug is, in platform-level terms ("X% of users with Y positions
  on Z chain see wrong values for W")
- What the diagnosis showed (root cause from `investigate-first` Step 4)
- What sprint or fix this belongs to

Never describe the bug as wallet-specific. Always platform-level framing.

### Section 2: Goal (required)

A single sentence stating what success looks like.

Example:
> "After this fix, the `/api/activity/cetus` route resolves 81/81
> positions on Account 1 with all CETUS reward token fees valued via
> cg-spot, not cg-historical."

### Section 3: Strict rules (required)

The non-negotiable constraints, listed as bullets:

```
STRICT RULES:
- Preserve all [PRICE_LOG] instrumentation in app/lib/priceLogger.ts
- All changes must be additive unless explicitly replacing broken logic
- No per-chain branches in client code (capability detection or helper
  modules only)
- Build must pass clean before commit
- Commit and push automatically when work is verified — never ask for
  permission
- If verification numbers are off by significant margin (20%+), stop
  and report — do not iterate silently
```

These rules come directly from `.claude/rules/`. They are repeated in
every prompt because Claude Code reads them as part of the prompt
context, not just from the rules files.

### Section 4: Investigation phase (required)

Tell Claude Code exactly what to read before writing any code:

```
INVESTIGATION:
1. Read .claude/rules/pricing-invariants.md, architecture-principles.md,
   and instrumentation.md.
2. Read [specific files relevant to the fix, named explicitly]
3. Run [specific grep or log analysis commands to verify current state]
4. Report findings in plain language before proceeding to implementation.
```

Naming files explicitly prevents Claude Code from guessing at file paths.
Running explicit commands prevents Claude Code from assuming current
state without checking.

### Section 5: Implementation phase (required)

The actual change, described at the level of "what" not "how":

```
IMPLEMENTATION:
1. [Step 1 in concrete terms]
2. [Step 2 in concrete terms]
3. ...
```

For each step:
- State the file being modified
- State what the change accomplishes (not the literal code)
- State what edge cases must be handled
- State which existing logic must be preserved (additive-only principle)

If a step requires Claude Code to make a design decision, state the
decision in the prompt rather than letting Claude Code choose. Example:

> "Step 3: In `app/api/activity/cetus/route.ts`, add a sticky LKG cache
> for CETUS reward token spot prices. Cache the last successful cg-spot
> price in module scope. If a fresh cg-spot fetch fails or returns null,
> fall back to the LKG cache. If LKG is empty and fresh fetch fails,
> log the failure via priceLogger as source: 'unknown' and continue with
> other positions."

### Section 6: Verification phase (required)

The verification metric and how to check it:

```
VERIFICATION:
1. Build with `npm run build` — must complete clean.
2. Start dev server with log capture:
   `npm run dev 2>&1 | tee /tmp/devserver.log`
3. Load [specific wallet] on localhost, visit [specific route]
4. After route completes, check route_summary:
   `grep '"event":"route_summary"' /tmp/devserver.log | tail -5`
5. Expected: [specific number, e.g., "resolved: 81, total: 81"]
6. If verification passes: commit with message
   "[specific commit message format]" and push to main.
7. If verification fails with significant margin (20%+ off): stop and
   report findings to user. Do not iterate silently.
8. Update CLAUDE.md with completed fix, commit hash, and any new
   constraints discovered.
```

The verification numbers are the same ones identified in Step 5 of the
`investigate-first` methodology. They are not invented at prompt-writing
time.

### Section 7: Edge cases (optional but recommended)

A bullet list of specific edge cases Claude Code must handle:

```
EDGE CASES TO HANDLE:
- Wallets with zero Cetus positions (route should return empty, not error)
- Cetus reward token with zero balance (should not be flagged as failed)
- Concurrent requests from multiple wallets (cache must be safe for
  parallel access)
- Cold-start scenarios where CG-spot fetch times out
```

Omit this section only when the fix is genuinely simple and has no
non-obvious edge cases.

### Section 8: Closing instruction (required)

Every prompt ends with this exact paragraph:

```
Build, test on localhost, confirm visually that it works, then push to
GitHub. Do not mark it done until the output is verified. Update
CLAUDE.md when done. If anything is unclear or the file paths don't
match what's expected, stop and report — do not improvise.
```

The "stop and report" clause prevents Claude Code from improvising file
paths or assumptions when the prompt and reality diverge.

## Anti-patterns

### Vague problem statements
> "Fix the Cetus bug."

Wrong. The prompt does not say what's broken, what the target is, or how
to verify the fix. Claude Code will guess and probably guess wrong.

### Implementation details in the problem statement
> "Change line 47 of cetus/route.ts to use cgSpot instead of cgHistorical."

Wrong direction. The prompt should describe what the fix accomplishes, not
literal code edits. Claude Code is better at code than we are. We provide
intent; it provides implementation.

### Missing verification step
> "...implement the fix and commit when done."

Wrong. Without an explicit verification step, "done" means "Claude Code
thinks it's done," which is not the same as "the bug is actually fixed."

### Forgetting strict rules
Omitting the strict rules section because "Claude Code should already
know." It doesn't know across sessions. The strict rules are repeated
every time on purpose.

### One giant block of text
A prompt that's a wall of paragraphs without section headers. Claude Code
parses structured prompts better than unstructured ones. Section
headers in bold (Context, Goal, Strict Rules, etc.) are signals that get
attended to.

## Template

When generating a prompt, start from this skeleton:

```
**Context**
[One paragraph: platform-level bug, diagnosis, sprint]

**Goal**
[One sentence: what success looks like]

**STRICT RULES:**
- Preserve all [PRICE_LOG] instrumentation in app/lib/priceLogger.ts
- All changes must be additive unless explicitly replacing broken logic
- No per-chain branches in client code
- Build must pass clean before commit
- Commit and push automatically when work is verified — never ask
  permission
- If verification numbers are off by significant margin (20%+), stop
  and report

**INVESTIGATION:**
1. Read .claude/rules/pricing-invariants.md, architecture-principles.md,
   and instrumentation.md
2. Read [specific files]
3. Run [specific verification commands]
4. Report findings before implementing

**IMPLEMENTATION:**
1. [Step 1 with file path and accomplishment]
2. [Step 2 with file path and accomplishment]
...

**VERIFICATION:**
1. Build clean
2. Capture logs: npm run dev 2>&1 | tee /tmp/devserver.log
3. Load [specific wallet], visit [specific route]
4. Check route_summary: grep '"event":"route_summary"'
   /tmp/devserver.log | tail -5
5. Expected: [specific numbers]
6. If passes: commit with message "[message]" and push
7. If fails with significant margin: stop and report
8. Update CLAUDE.md

**EDGE CASES TO HANDLE:**
- [edge case 1]
- [edge case 2]

Build, test on localhost, confirm visually that it works, then push to
GitHub. Do not mark it done until the output is verified. Update
CLAUDE.md when done. If anything is unclear or the file paths don't
match what's expected, stop and report — do not improvise.
```

## When to amend this skill

Amend this skill when:
- A new section type proves consistently useful across multiple sprints
- The three-phase structure is shown by evidence to be incomplete
- New strict rules emerge that should be in every prompt
- The closing instruction needs refinement based on misinterpretations
  Claude Code has made

Do not amend based on a single failed prompt. Iterate on the prompt
content, not on the template.
