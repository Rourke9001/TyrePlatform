# Handoff — execute B5 slice 2 (the fitment surface)

Paste everything below the line into a fresh Claude Code session opened at
the repository root. Orchestrator model: **Fable** (see "Who runs what").

---

You are the orchestrator for B5 slice 2 of TyrePlatform, at
`C:\Users\Rourke Amiss\Documents\Personal\Projects\TyrePlatform`. The work is
already designed and planned; your job is to execute the plan task by task
with subagents, review between tasks, and hand back a pull request. You do
not redesign.

## Read first, in this order

1. `CLAUDE.md` — the non-negotiable rules. Rule 1 (tenant isolation in the
   database), rule 2 (money is numeric), rule 3 (fitment events immutable),
   rule 5 (thresholds are tenant configuration) all bind this slice directly.
2. `docs/superpowers/specs/2026-09-01-b5-fitment-surface-design.md` — the
   design. Its first table, "Decisions taken without the owner" (U1–U11),
   is settled input: **the owner has reviewed it**. Where the owner reversed
   an item, that reversal is recorded at the bottom of this file under
   "Owner rulings"; apply it. Where no ruling is recorded, the spec stands.
3. `docs/superpowers/plans/2026-09-01-b5-fitment-surface.md` — 17 tasks.
   Its Global Constraints section applies to every task.
4. `docs/lessons.md`, the entries dated 2026-08-27 onward. Every one was
   paid for by a prior branch on this codebase. Two are load-bearing here:
   "a flow narrated in a plan is a claim about UI, not a fact" (Task 16), and
   "two refusal branches sharing a SQLSTATE make a cross-tenant probe
   vacuous" (Tasks 3–6).
5. `docs/superpowers/plans/2026-09-01-b5-tyre-register.md` and the PR #39
   body (`gh pr view 39`) — slice 1's plan and its rulings, which this slice
   inherits. Note in particular Task 10b's insertion and why.
6. `docs/adr/0012-api-error-envelope.md`, `0013-write-surface-contract.md`.

Then run `make db-reset && make db-test` and `make check` on the branch
before touching anything, and record the baseline counts (suite PASS lines,
Go packages, web tests). Slice 1's baseline was 108 / 4 / 338; TYRE-97 kept
them. If they differ, stop and say so.

## Branch and state

- Branch `TYRE-92-fitment-surface` exists locally, cut from `develop` @
  `ff1744e`, with one commit (`6324c4b`): the spec and the plan. Work on it.
  Never commit to `develop` or `main`. Rebase, never merge.
- Conventional commits with the task's ticket key (TYRE-92, TYRE-93,
  TYRE-94). One task, one commit, exactly as the plan's final step of each
  task says. Amend only your own unpushed commit.
- The branch is unpushed. Push it when Task 17 opens the PR, not before.
  The owner merges in the browser; you never merge.

## How to execute

Use the `superpowers:subagent-driven-development` skill. Per task:

1. Write the implementer a **handoff packet** containing only: the repo
   path, the branch, the task's full text pasted verbatim from the plan, the
   spec sections it cites (pasted, not referenced), the relevant lessons
   entries (pasted), the exact verification commands, and the stop
   conditions below. Assume the implementer has no chat context and cannot
   see your conversation.
2. Implementer works TDD as the task's steps prescribe: failing test, run
   it, implement, run it, `make check`, commit.
3. **Two-stage review after every task**, each by a fresh reviewer given the
   diff *and* the task brief *and* the spec sections: (a) spec review — does
   the diff do what the task says and nothing else; (b) code review —
   correctness, the CLAUDE.md rules, comment standard, test honesty. Any
   **Important** finding enters the fix loop regardless of the reviewer's
   own softer framing (slice 1's standing rule). Critical findings stop the
   branch until fixed.
4. You, the orchestrator, **reopen the cited files** for any finding a
   reviewer calls Critical, for any test that was asserted to fail-then-pass,
   and for every money or event-time line, before accepting the task.
   Reviewer reports are leads, not facts.

Dispatch the two repository agents where the plan names them:
`rls-auditor` in Task 6 and `valuation-verifier` in Task 4 step 5. Their
findings are fixed in place before the task's commit.

## Who runs what

- **Orchestrator: Fable** — you. Rulings, reviews of reviews, the
  plan-versus-reality calls, the PR body. Slice 1 needed three
  advisor-consulted rulings mid-branch; that judgment is the expensive part.
- **Implementers:**
  - **Opus** for Tasks 3, 4, 5, 9, 10, 11 and 16 — the SQL lifecycle
    functions, the money arithmetic, the audit trigger, the Go write
    handlers with their cross-tenant probes, and the e2e proof. These carry
    rules whose failure modes are subtle (rounding order, trigger firing
    order, vacuous probes) and a cheaper model's plausible-looking code is
    exactly the risk.
  - **Sonnet** for Tasks 1, 2, 7, 8, 12, 13, 14, 15 and 17's mechanical
    steps — the ADR from a template, the immutability trigger and seeds
    (fully specified in the plan), Go plumbing and reads, web plumbing and
    screens, routes and nav, docs updates.
- **Reviewers: Opus** for every task's two reviews. Never Sonnet on a review
  of money, event time or a cross-tenant probe.
- **Whole-branch review (Task 17 step 2): Opus, five parallel reviewers**
  on the model slice 1's post-merge pass used (see memory note
  `b5-slice1-review-pr39`: a second five-reviewer pass found four real
  defects after the branch's own review said zero Critical). Hand each the
  PR body draft alongside the diff.

## Rulings protocol

Slice 1's plan met reality three times and each time the implementer
escalated rather than guessed. Keep that behaviour:

- If a task's brief describes a control, function or row that does not
  exist in the landed code, the implementer reports `NEEDS_CONTEXT` with
  the exact gap. You rule: build it as an inserted task (as 10b was), reframe
  the assertion, or reword the brief. Record every ruling in the PR body
  under "Rulings made this session", in slice 1's format.
- If a spec decision (D1–D8, U1–U11) proves wrong against the code — a
  constraint that does not exist, a column the spec misnamed, a trigger
  order that does not hold — do not bend the code to the spec. Stop, state
  the conflict, consult the advisor if you have one, rule, and record it.
  The spec is edited on the branch only for a factual correction, never to
  widen scope.
- Migration numbers 000032–000035, sections 40–43, SQLSTATEs TY014–TY016
  are committed. If a task finds it needs a number outside that range, that
  is a ruling, not a renumber.

## Stop conditions

Stop and report rather than improvise when:

- `make db-test` section 7 (Appendix E), 8 (Appendix J: 19 / 11 / 9), 17 or
  18 changes a single figure. Nothing in this slice may move them.
- a cross-tenant probe passes with RLS bypassed (Task 6 proves each one
  fails under bypass; if one does not, the probe is vacuous).
- a test has to be weakened to pass. Say which test, why it is wrong, and
  wait.
- a reviewer and an implementer disagree on a money or event-time line
  after one fix round.
- the e2e brief (Task 16) needs a control no task built.
- anything requires touching `db/migrations/0000[0-3][0-9]_*` below 000032,
  BAC's fixture rows, or a merged migration.

## Deliverables

1. The branch, one commit per task, `make check` and `make e2e` green on the
   final commit with output read, not inferred.
2. A PR to `develop` with the body the plan's Task 17 step 6 specifies:
   what landed by task, the U1–U11 table with any owner rulings applied,
   the RLS probe result, the valuation-verifier verdict, rulings made,
   deleted-rather-than-bent, follow-up ticket keys.
3. `docs/implementation-order.md` updated (B5 delivered, B6 next).
4. Jira: TYRE-92/93/94/48 to *In Review* with the PR link; the follow-up
   tickets raised and cited in ADR-0014 and the PR body.
5. `docs/lessons.md` entries only for failures that change how the next
   attempt behaves — curated, not a diary.

Report at the end with: baseline versus final counts, every ruling, every
Important-or-worse finding and its fix commit, and what you left out and
why. Do not report a task done that is not committed.

## Owner rulings on U1–U11

_(The owner fills this in before the session starts. Blank means the spec
stands as written.)_

| Item | Ruling |
|---|---|
| U1 | |
| U2 | |
| U3 | |
| U4 | |
| U5 | |
| U6 | |
| U7 | |
| U8 | |
| U9 | |
| U10 | |
| U11 | |
