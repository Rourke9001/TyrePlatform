# ADR-0023: The lead runs the review and fix loop inside the run

- **Status:** Accepted (owner, 9 Nov 2026, with U191 to U195). Its PR is
  the TYRE-470 PR, number not yet known. It supersedes ADR-0018's stage 5
  decision and its push stop.
- **Date:** 2026-11-09
- **Deciders:** Rourke (owner)
- **Related:** ADR-0018 · TYRE-470, TYRE-395 · U123, U124, U125, U146,
  U191 to U195 · spec `docs/superpowers/specs/2026-11-09-autonomous-runs-design.md`

## Context

ADR-0018 kept stage 5 outside the agent team, in a session the owner
starts, because a teammate could not collect what `/review-pr` dispatches.
PRs #166 and #167 show what that costs. Both were bundles of small fixes run
by hand through `/ticket`. Each took about eight stage 5 rounds over a week,
and the owner carried every report from the review session to a fix
session.

The spec names two causes:

- Stage 5 sits outside any run, so the owner is the messenger.
- Every round re-reviewed the whole branch, and U146 said to fix every bug
  found, whatever file and however old. The loop had no reason to end.

The constraints on any design:

- Nothing that wrote the code reviews it. That is U125's reason, and it
  stands.
- Every agent is Claude. The owner runs no second vendor and no second
  subscription.
- The owner merges every PR (U123) and is asked only where the owner's
  answer is needed.
- Agent teams are still experimental, so a Claude Code release can change
  what a run can collect (ADR-0018).

Two spikes on 9 Nov 2026, on Claude Code 2.1.319, tested what a run can
collect:

- **The teammate spike.** One dispatch, not retried. The teammate's Agent
  call returned "The subagent ended without delivering a report through
  SubagentHandback, so no report was delivered", and the lead received
  nothing. On 2.1.296 ADR-0018 saw a teammate's subagent result rerouted to
  the lead; on 2.1.319 it was dropped. A teammate still cannot collect its
  subagents' results.
- **The lead spike.** All three checks passed. Three unnamed
  general-purpose subagents each committed, and each report reached the
  lead. An unnamed `rls-auditor` reply reached the lead. With the branch's
  upstream set to a scratch base at the first spike commit,
  `/code-review high` with no target ran as a background fork and returned
  nine findings to the lead. Every file they cited was in
  `git diff --name-only <base>...HEAD`, none cited the base commit's file,
  and a planted unguarded `rm -rf` was the top finding. A committing
  subagent also ran `/verify` before its commit, which reset the local
  database.

The lead spike's review check has a limit. The base commit held nothing to
flag, so the check shows the review stayed inside the range's files. Had
the review read a wider diff, nothing in that commit would have drawn a
finding, so the check could not have caught a superset diff. The installed
binary also accepts an `<a>...<b>` argument, which the spike did not test.

## Options considered

### Option A: keep stage 5 outside the run, and add only the cap and the scope rule

A separate session runs `/review-pr` as today, with U191's bug classes, a
re-review of each fix's commits only and a cap on rounds.

Why it is attractive: the smallest change, and the reviewer stays a whole
separate session. **Its downside:** the owner still carries every report
between two sessions, which is one of the two causes, and the run still
ends at an unreviewed PR.

### Option B: the lead collects the reviews and dispatches the fixers

The lead dispatches the finders as fresh contexts and collects their
results, then verifies and classifies each finding. Each round, it
dispatches a fresh fixer as its own subagent. The lead never edits code, so
it can collect a review without breaking U125's reason.

Why it is attractive: no owner relay, and the PR opens already reviewed.
The lead spike showed the lead collecting a committing subagent, an auditor
and a `/code-review` fork on 2.1.319. **Its downside:** the reviewer runs
inside the author's run and on the author's vendor, and the whole loop
rests on one spike on one version of an experimental feature.

### Option C: the reviewer and the fixer as teammates

Each would be a full, separate Claude instance, as the planner and the
implementer are, watched from the agent panel.

Why it is attractive: the same shape as the rest of the team. **Its
downside:** a reviewer teammate runs `/code-review`, which dispatches a
background fork, and a teammate cannot collect what it dispatches.
ADR-0018's spike on 2.1.296 saw a teammate's fork report to the lead, and
the teammate spike saw a teammate's subagent result dropped on 2.1.319.
Rejected on the teammate spike.

### Option D: a second vendor as the reviewer

A model from another vendor reviews the branch the run built.

Why it is attractive: a reviewer from another vendor does not share the
author's model, so it does not share its blind spots. **Its downside:** a
second account and a second subscription. Rejected because the owner runs
Claude only.

## Decision

We will run the code review and its fix loop inside the `make pipeline`
run, before the push, with the lead dispatching and collecting the finders
and a fresh fixer each round (Option B).

- The finders are fresh contexts: `/code-review` and the auditors the diff
  triggers. The lead collects their results, as it collects the red team's.
- A fixer is the lead's own subagent, new each round, briefed with the
  round's report path. The implementer teammate has shut down before the
  loop starts, so one writer is in the checkout at a time.
- No teammate dispatches a review or a fixer. A teammate cannot collect its
  subagents' results (the teammate spike) or a `/code-review` fork
  (ADR-0018's spike). The lead can collect a review. The lead spike showed
  a `/code-review` fork returning to it, and since the lead writes no code,
  U125's reason holds.
- A review reads the range set through the branch's upstream. The upstream
  form is the `/code-review` skill's documented default and the one the
  lead spike ran. The lead checks the upstream ref before each review and
  the files the findings cite after it, because the spike's check could not
  have caught a superset diff, and a review of the wrong diff would end the
  loop falsely.

The owner's rulings of 9 Nov 2026 set the loop's rules. Each lives in
CLAUDE.md, not here:

- U191, the bug classes, replacing U146's scope (Which bugs a branch
  fixes).
- U192, the review inside the run and its cap, amending U125 (How work
  runs, stage 5, and The review loop).
- U193, the push that opens the PR is not an owner stop, replacing U124
  (The stops).
- U194, an SRS change is recorded on the working ticket with no new ticket,
  amending the 29 Sep 2026 ruling (the SRS paragraph at the top).
- U195, the lead drafts the spec, and a job is one large ticket or a bundle
  of small fixes (How work runs).

The lead's steps are in `.claude/commands/pipeline.md`. `/ticket` stays the
manual path and keeps a separate-session `/review-pr`, since no lead
collects a review there.

## Consequences

**Good:**

- One launch takes a job to a reviewed PR, and no report passes through the
  owner.
- The loop ends. It makes at most three review passes before the cap, where
  #166 and #167 took about eight, and the two later passes read a fix's
  commits, not the whole branch.
- The push is not a stop, so the owner is asked only where an answer is
  needed.

**Bad:**

- A same-vendor reviewer is weaker than a cross-vendor one. The implementer
  runs on Sonnet and the finders and the fixer on the session's top model,
  so the reviewer is on a different tier from the author. That offsets part
  of the gap, not all of it.
- An `unrelated` bug is deferred to a ticket, which is what U146 was
  written to stop. It holds only if the ticket that owns the code really
  gets the evidence.
- Two fix rounds can stop a run that a third would have closed.
- The loop depends on the lead's subagents returning, which only the lead
  spike proves, on one version. A Claude Code release can break it, and
  `/ticket` with a separate-session `/review-pr` is the fallback.
- A fixer that commits can run `/verify` and reset the local database, as a
  spike subagent did.
- A run cannot take one key out of a bundle or reopen after hand-over; both
  were cut on 9 Nov 2026, so at the cap the run ends and the owner relaunches
  the other keys, and a late finding is fixed on the manual path.
- TYRE-395, a CI step that fails a code PR with no ticked review line, was
  closed unbuilt into TYRE-470. The review line in the PR template is still
  a written rule that nothing checks.

**Revisit when:** a teammate can collect its own subagents; or the first
three runs under this loop hit the cap.
