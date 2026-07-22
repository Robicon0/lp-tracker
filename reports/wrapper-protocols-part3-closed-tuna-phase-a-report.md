# Sprint WRAPPER-PROTOCOLS — Phase 2 Part 3 (Closed DefiTuna positions)

## Phase A investigation report

**Date:** 2026-07-22 · **Scope:** investigation only, NO implementation.
**Precondition resolved:** the accrued-interest blocker is closed —
`pricing-invariants.md` **Rule 4a** (commit `f52623a`) now governs it: interest is
**never** folded into Capital G/L; it is a **separate labeled line item**; Rule 4
(`withdrawal − deposit`) is untouched for all protocols, leveraged included.

This report answers the five questions posed for Part 3 and supersedes nothing in
the earlier `reports/wrapper-protocols-phase2-report.md` §1 — it deepens it with the
interest decision made and one **new live-verified infrastructure finding** that
materially de-risks the build.

---

## TL;DR

| # | Question | Verdict |
|---|---|---|
| 1 | Reconstruction approach | **Same `solanaClosedPositions.ts` Category-B pattern, on the SAME free-Alchemy tx-scan engine** (live-verified today). Two Tuna-specific deltas: (a) the "still-open" set comes from the **DefiTuna API**, not `getProgramAccounts`, so **Helius is NOT required**; (b) event legs match **Tuna's collateral/debt/residual flows**, not Orca pool vaults. |
| 2 | Debt & repayment | Deposit = **collateral legs** (not LP total). Withdrawal = **user-residual legs** at close (net of repayment) + `leftovers`. Interest = **separate line item** = Σ debt repaid − Σ debt borrowed, in token terms, valued historical. `RepayTunaLpPositionDebt` is separate/possibly-different-tx → accumulate across lifetime. |
| 3 | Liquidation state | Account is destroyed on close, so state is read from the **closing instruction name** (plaintext Anchor logs): `Close…` = Normal, `liquidate_tuna_lp_position_*` = **Liquidated**, limit-order close = **ClosedByLimitOrder**. Needs distinct **badges**, same withdrawal−deposit + interest line. `rebalance_*` must NOT be read as a close. |
| 4 | Effort | **Still LARGE.** Interest decision removed the *ambiguity/risk*, not the *engineering surface*. Now **buildable and unblocked**; recommend phasing (3a Normal/Orca → 3b Liquidated/LimitOrder → 3c Fusion → 3d event-decode precision). |
| 5 | Email / history endpoint | **No public closed/history endpoint exists (re-verified live today).** Item schema proves DefiTuna tracks it server-side. **I cannot see Osho's inbox** — email status needs Osho's confirmation. A "yes, here's the endpoint" collapses ~most of this build; chase it before committing to the LARGE path. |

---

## Q1 — Reconstruction approach

### It is the canonical Category-B pattern, and it runs on the existing engine

`app/lib/solanaClosedPositions.ts` (Orca + Raydium, Sprint 3-FREE/RAYDIUM) is the
right template. Its shape:

1. `getSignaturesForAddress(wallet)` → full signature history (paced, free Alchemy).
2. `getTransaction` (paced batches + backoff) for each signature.
3. Discover `everOpened` positions from Open instructions.
4. `closed = everOpened − currentlyOwned`.
5. Reconstruct per-position deposit/withdrawal/fee events by matching **inner SPL
   transfers against on-chain vault addresses**.
6. Value each event **historical-only** (Rule 1a), run through the shared
   `computePositionPnL()`, cache in a versioned immutable Redis key.

**LIVE FINDING (this session, on `ALCHEMY_SOLANA_RPC`, wallet
`2rr3SFuM8YNFcn9RUvqGNPki8rxaXjHDscQuy7wNJTpn`):**

```
getSignaturesForAddress OK: 80 sigs (err=None)      ← free Alchemy, no throttle
of first 40 txs: 24 touch the Tuna program
Tuna instruction names in plaintext logs:
   9  OpenAndIncreaseTunaLpPositionOrca
   5  IncreaseTunaLpPositionOrca
   3  DecreaseTunaLpPositionOrca
   3  CloseTunaLpPositionOrca            ← close detectable in wallet history
   3  SetTunaLpPositionFlags
   2  RepayTunaLpPositionDebt            ← repayment detectable in wallet history
```

This proves the **user's wallet is the signer/fee-payer** on Tuna instructions, so
they land in the wallet's own signature history — the exact input the free-Alchemy
scan consumes. Anchor instruction names are **plaintext** (`Program log: Instruction:
…`), so no discriminator matching is needed to classify them.

### The one thing Phase A flagged as needing Helius does NOT apply to Part 3

Phase A's warning — "`getProgramAccounts` 429s on free Alchemy, must use Helius" —
was about **trustless discovery of the currently-OWNED set** (`getProgramAccounts`
memcmp on `authority`). **Part 3 does not need that call at all:**

- The **still-open** set is already served by the **DefiTuna public API** (Phase 1's
  `/users/{w}/tuna-positions`, open-only) — the route already fetches it.
- So `closed = everOpened (from the free-Alchemy tx scan) − apiOpenSet`.
- `getProgramAccounts` → **not used** → **Helius → not required.** Part 3 runs
  entirely on the same `ALCHEMY_SOLANA_RPC` engine Orca/Raydium use.

> **Robustness upgrade over pure set-subtraction:** Tuna emits an **explicit close
> instruction** in plaintext (`CloseTunaLpPositionOrca` / `liquidate_*` / limit-order
> close). Prefer **instruction-driven close detection** (a position is closed iff we
> observed a close-family instruction for it) **cross-checked against** "absent from
> the API open set." This is strictly safer than Orca's set-subtraction because:
> (a) it is immune to a transient API miss briefly misclassifying a still-open
> position as closed (Rule 11 — degrade, don't drop); (b) it naturally ignores
> `rebalance_*` (see Q3). If the API is unreachable during a scan, do **not** finalize
> closed classification from a partial open set — treat as incomplete (don't cache).

### The Tuna-specific delta: event legs are NOT Orca pool vaults

This is the real added complexity vs Orca. Orca matches inner transfers against the
**Whirlpool pool vaults** (in=deposit, out=withdrawal/fee). A leveraged Tuna position
has **three distinct money flows**, and the Orca pool vault sees only one of them:

- **Collateral legs:** user wallet ↔ Tuna collateral/vault (the user's real basis).
- **Debt legs:** Tuna lending `Vault` → Orca pool (borrow) and Orca pool → Tuna
  `Vault` (repay). These are borrowed funds, **not** the user's capital.
- **Residual legs:** at close, funds returned to the **user's wallet** after debt is
  settled (+ `leftovers_a/b`).

So the reconstruction must resolve **Tuna's vault/lending-`Vault` addresses** (the
IDL has a `Vault` account type; addresses derivable from the on-chain IDL at
`EooDyoDKbettJ6dvuuikga95ZLxKa2FifjrCicVm8HmP`, or from the API `/vaults`, 141
entries) and classify each inner transfer by **counterparty**, not just pool-vault
direction. The cleanest measurables:

- **Deposit (basis)** = tokens leaving the **user wallet** into Tuna at open/increase
  (= collateral), NOT LP total.
- **Withdrawal** = tokens landing in the **user wallet** at close (= net residual +
  leftovers). Measuring the user-bound legs directly is cleaner and less error-prone
  than "gross LP out − Σ repayments."

**Precision upgrade (optional, 3d):** the IDL publishes `events: []` and the sampled
event discriminator matched no guessed name, so Anchor event decoding is not yet
possible. Use the proven inner-SPL-transfer approach first; treat exact-amount event
logs as a later precision upgrade if/when the event schema is recovered.

---

## Q2 — Debt, repayment, and the interest line item

Per **Rule 4a**, Capital G/L stays `withdrawal − deposit`; interest is a separate
labeled line. Concretely for a closed leveraged Tuna position:

**(a) What was originally deposited — COLLATERAL, not LP total.**
Sum the collateral legs (user wallet → Tuna) across `OpenAndIncrease…` and
`Increase…` instructions, valued historical at each deposit's block time. The LP
total = collateral + borrowed principal; using LP total would overstate the user's
basis by the borrowed amount. Cross-check available: API `deposited_collateral_a/b`
(for still-derivable positions) and, per Rule 4a wording, the protocol's own tracked
debt data "where available."

**(b) What was withdrawn — NET of debt repayment.**
Measure the **user-residual legs** (tokens dest = user wallet) at close, plus
`leftovers_a/b`, valued historical at close time. Do **not** count gross LP
withdrawal — the portion that immediately repays the loan is not the user's.
`RepayTunaLpPositionDebt` is a **separate instruction, sometimes in a different
transaction** from the close (live-confirmed: 2 repay txs distinct from the 3 close
txs in the sample) — so the lifecycle accumulator must span the **whole position
lifetime**, never assume close-and-repay are atomic.

**(c) Total interest accrued — the separate line item.**
Interest = **(total debt repaid over life) − (total debt borrowed over life)**, in
**token terms per debt token**, then valued historical (repayment timestamps).
Rationale for token-terms-first: debt is denominated in the borrowed token, so
`repaid_tokens − borrowed_tokens` is the pure interest quantity, insulated from price
moves between borrow and repay. API cross-check: `initial_debt_a/b` vs
`current_debt_a/b` exist precisely to express accrued interest, and
`compounded_yield_a/b` is in the schema. Present as **"Interest accrued: −$X.XX"**
alongside the position. This is a genuine open sub-decision (token-terms vs
USD-delta), but per Rule 4a it is **not a blocker** — it only affects the separate
line, never Capital G/L.

---

## Q3 — Liquidated / ClosedByLimitOrder detection & representation

`TunaPositionState = Normal | Liquidated | ClosedByLimitOrder`. **The account is
rent-reclaimed on close** (Category B — confirmed: 12 `Close…` in a wallet's history,
0 surviving accounts), so the final `state` **cannot** be read from the account.
Detection comes from the **closing instruction** (plaintext Anchor logs, live-verified
readable):

| Closing instruction observed | State | UI label |
|---|---|---|
| `CloseTunaLpPositionOrca` / `…Fusion` | Normal | **Closed** |
| `liquidate_tuna_lp_position_{orca,fusion}[_jupiter]` (4 IDL instrs) | Liquidated | **Liquidated** (distinct badge) |
| limit-order close path (flags / `*_limit_order_price`) | ClosedByLimitOrder | **Closed (limit order)** |

**Economics & representation.** A liquidation can wipe collateral and takes a
liquidation fee — so `withdrawal − deposit` will legitimately show a large loss (the
residual legs are small/zero). Rule 4 still applies unchanged (the fee is embedded in
the reduced withdrawal). **The UX requirement is honesty about *why*:** a −$X result
must carry a **"Liquidated" badge**, never a bare "Closed", so the user understands
it was a forced close, not an ordinary exit. The interest line still applies. (A
liquidation-fee line could be added later; not required by Rule 4a.)

**Rebalance is not a close.** `rebalance_tuna_lp_position_*` closes/reopens the
**underlying Orca** position while the **Tuna** position persists (same account
survives). Instruction-driven close detection (Q1) ignores it by construction, and
the API-open-set cross-check confirms a rebalanced position is still open. A naive
"any Orca close instruction = closed Tuna position" reader would corrupt this — hence
classify on **Tuna** close-family instructions only.

---

## Q4 — Scope & effort estimate (updated)

**Still LARGE.** The interest decision removed the *design paralysis* (Part 3 can now
start), and the free-Alchemy finding removed an *infra risk* (no Helius), but the
**engineering surface is essentially unchanged**. The hard parts remain:

1. Tuna vault/lending-`Vault` flow reconstruction (collateral vs debt vs residual
   leg classification) — the genuinely new work vs Orca's single-pool-vault match.
2. Three close paths (Normal / Liquidated / ClosedByLimitOrder) with detection +
   distinct labels, and rebalance disambiguation.
3. Separate interest line-item computation + a **new UI element** on the row/detail.
4. Fusion backend in parallel (every `*_orca` instruction has a `*_fusion` twin;
   Fusion is 30.3% of live Tuna LP / 50.6% of borrowed capital — Part 2 finding).

**Recommended phasing** (each independently shippable):

- **3a** — Normal closes, **Orca backend only**, interest line item + badge
  scaffolding. Validates against the 12-close test wallet. *Medium slice.*
- **3b** — Liquidated + ClosedByLimitOrder paths (distinct economics + badges).
- **3c** — Fusion backend (parallel instruction set; same engine).
- **3d** — Anchor event decoding as a precision upgrade (optional; blocked on event
  schema recovery — IDL currently publishes none).

Net: **Large overall, now unblocked and lower-risk; ship 3a first for a real
increment** rather than attempting the whole surface at once.

---

## Q5 — DefiTuna history endpoint / email status

**Live re-verification today (2026-07-22, browser UA):**

```
200  items=6 states=['open']   users/{w}/tuna-positions              ← control
200  items=6 states=['open']   users/{w}/tuna-positions?state=closed ← SILENTLY IGNORED (identical 6)
400                            users/{w}/tuna-positions/closed
400                            users/{w}/tuna-positions/history
404                            users/{w}/closed-positions
404                            users/{w}/history
400                            users/{w}/tuna-positions/events
?state=closed identical to base: True (base=6, closed=6)
```

- **No public closed/history endpoint exists as of today.** `?state=closed` returns
  a byte-identical open set (silently-ignored param, not honoured-and-empty) —
  re-confirming the Phase A trap. So full on-chain reconstruction **is** still the
  only public path right now.
- **BUT the data exists server-side.** The item schema carries **`closed_at`,
  `initial_debt_a/b`, `leftovers_a/b`, `pnl_a/b`, `pnl_usd`, `compounded_yield_a/b`,
  `entry_price`, `state`** — DefiTuna tracks the exact quantities Part 3 needs; they
  just aren't served. This is a **strong basis to request a history endpoint**, and a
  "yes" would collapse most of the LARGE build into a mapping exercise.
- **Email status: I cannot verify it.** I have no access to Osho's inbox, and there
  is no record in the repo that the email was sent or answered. **Action for Osho:**
  confirm whether the history-endpoint email was sent and whether DefiTuna replied.
  **Recommendation:** chase/send it **before** committing to the LARGE on-chain build
  — it is a free option with high upside, and the schema evidence above makes the ask
  concrete.

---

## Recommendation

1. **Osho confirms the DefiTuna email status** (Q5) — this gates everything. A history
   endpoint moots most of Part 3.
2. If no endpoint is forthcoming, build **Phase 3a** (Normal closes, Orca, on the
   existing free-Alchemy engine, no Helius) with the interest line item + Liquidated
   badge scaffolding, verified against the 12-close regression wallet
   `2rr3SFuM…`, then 3b/3c/3d in sequence.
3. One open sub-decision to settle before 3a codes the interest line: **interest in
   token-terms (`repaid − borrowed`) vs USD-delta**. Not a blocker (Rule 4a keeps it
   out of Capital G/L), but pick one for consistency.

**No implementation performed. Awaiting confirmation before any Part 3 build.**

### Verification appendix (commands run this session)
- DefiTuna API endpoint probes: `python3 urllib` with browser UA against
  `api.defituna.com/api/v1` (control + 7 candidate closed/history paths + `?state`
  item-identity diff).
- Free-Alchemy tx-history proof: `getSignaturesForAddress` + `getTransaction`
  (jsonParsed) via `ALCHEMY_SOLANA_RPC` from `.env.local`, wallet `2rr3SFuM…`,
  first 40 of 80 sigs, plaintext-log instruction census.
