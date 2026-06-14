---
name: sprint-start
description: Use this skill at the beginning of every new Claude Code session for DefiDesh. It loads context (CLAUDE.md, active sprint, rules, recent commits), confirms methodology (investigate-first, additive-only, stop-and-report), and waits for the specific task before doing any work. Triggers include phrases like "starting a new session", "let's begin", "new Claude Code session", "starting Sprint X", "start the session", "begin work", or any first message in a fresh Claude Code session.
allowed-tools: Read, Bash, Glob
---

# Sprint Start

This skill runs at the beginning of every Claude Code session for DefiDesh.
It exists because sessions that start without context produce work that
guesses at state, repeats fixed bugs, or misses recent architectural
decisions. The first 30 seconds matter.

## When to use this skill

Invoke this skill:

- At the start of every new Claude Code session for DefiDesh
- After a session compaction (when context has been compressed and state
  may have been lost)
- After switching from one major task category to another (e.g., from
  documentation work to bug fixing)

Do not invoke this skill:

- Mid-task within an active session (it would reset context unnecessarily)
- During Claude.ai conversations (this skill is Claude Code specific)

## The startup sequence

Six steps, in order. Complete all six before doing any actual work.

### Step 1: Read CLAUDE.md

Always read CLAUDE.md first. It contains:

- Current sprint (active, not historical)
- Recent fixes with commit hashes
- Sprint queue (what's next)
- Any new constraints discovered in recent sessions

If CLAUDE.md does not exist, stop and report. Do not proceed without it.

### Step 2: Scan the rules directory

Read the file headers (first 20 lines or so) of each file in
`.claude/rules/`:

- `pricing-invariants.md`
- `architecture-principles.md`
- `cache-versioning.md`
- `wallet-security.md`
- `commit-protocol.md`
- `instrumentation.md`

You do not need to read each file in full. The goal is to know what
rules exist so you can deep-read the right one when needed during the
session.

### Step 3: Check recent commits

Run:

```bash
git log --oneline -10
```

This shows the last 10 commits. You're looking for:

- Recent fixes that may have changed cache versions or pricing rules
- Recent fixes that touched files you're about to modify
- Anything labeled "REVERT" or "WIP" that indicates an in-flight problem

### Step 4: Confirm the active sprint

CLAUDE.md has a section labeled "Active Sprint" or equivalent. Read it.
State to the user:

> "Active sprint is Sprint X: [name]. Goal: [one sentence]. Pending:
> [what's not done yet]."

If the active sprint is unclear, ask the user before continuing.

### Step 5: State the methodology

In your first response, briefly state:

> "Following investigate-first methodology. No code or prompts until we
> agree on the plan. Build clean before commit. Stop and report on
> significant verification gaps."

This is not boilerplate. It's a commitment that Osho can hold you to
later in the session. If you skip this step and start writing code,
Osho cannot point back to a commitment you made.

### Step 6: Wait for the specific task

Do not assume what the session is about based on the active sprint. The
sprint says what category of work is queued. The specific task within
that sprint comes from Osho in the next message.

Ask:

> "What's the specific task for this session?"

Then wait for the answer before doing anything else.

## Anti-patterns

### Diving straight into code
The fresh-session equivalent of skipping investigate-first. Without
reading CLAUDE.md and recent commits, you'll repeat fixed bugs or miss
the actual current state.

### Assuming the sprint == the task
Sprint 1 is "HyperEVM cold-start hardening." That is the category. The
specific task in this session might be "investigate why Vercel KV setup
is producing 401 errors." Don't conflate them.

### Skipping the methodology statement
The verbal commitment in Step 5 is what gives Osho leverage to correct
you mid-session. Without it, course-correction becomes a debate instead
of pointing to a previously-stated rule.

### Reading every rules file in full
Step 2 is a scan, not a deep read. Reading all six rules files in full
at startup burns tokens and front-loads context that may not be needed.
Deep-read the rules you actually need during the task.

### Starting work before the user answers
Step 6 ends with "wait for the answer." If Osho is slow to respond, do
not preemptively start work to "be helpful." Wait.

## Example session start

A clean session start looks like this:

**Claude Code:**
> Reading CLAUDE.md... Done. Active sprint is Sprint 1: HyperEVM
> cold-start hardening. Goal: server-side price cache so the second
> user inherits warm CoinGecko data, resolving the Account 2 ProjectX
> exclusion regression. Pending: implementation not started; design
> approved (Vercel KV free tier or in-memory module cache).
>
> Scanning .claude/rules/... Done. Six rules files present and current.
>
> Recent commits:
> - 751743b: Client data layer architectural pass
> - be94edf: HyperEVM/ProjectX claim-time pricing
> - 26fd213: Cetus token resolution + Sui spot fallback
> - 90faaf9: Aerodrome burned-NFT recovery
>
> Following investigate-first methodology. No code or prompts until we
> agree on the plan. Build clean before commit. Stop and report on
> significant verification gaps.
>
> What's the specific task for this session?

**Osho:**
> Let's investigate the Vercel KV setup. The free tier configuration is
> unclear and I want to confirm the approach before committing to it.

**Claude Code:**
> Understood. This is an investigation task, not an implementation task.
> I'll start by reading Vercel KV documentation and checking what's
> already in our Vercel project. No code changes this session.
> [proceeds with investigation]

## When to amend this skill

Amend this skill when:

- A new file is added to `.claude/rules/` (update Step 2 to scan it)
- A new startup step proves consistently necessary
- The methodology statement in Step 5 needs to evolve with new rules

Do not amend based on a single forgotten step. The sequence is stable.
