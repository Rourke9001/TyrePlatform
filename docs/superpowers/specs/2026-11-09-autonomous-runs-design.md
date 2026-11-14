# Autonomous runs: one lead takes a job to a reviewed PR

*Since TYRE-481 (14 Nov 2026) the CLAUDE.md sections How work runs, Which bugs a branch fixes, The review loop and The stops live in `docs/how-work-runs.md`, and a `CLAUDE.md` section or line number this record cites is as of its date.*

Date: 2026-11-09. Ticket: TYRE-470. Status: approved by the owner on
9 Nov 2026 (U191 to U195, on the ticket). Builds on ADR-0018
and `docs/superpowers/specs/2026-10-11-pipeline-orchestration-design.md`.

## Intent

The owner hands one job to one lead session. The lead runs it to a pull
request that has already been reviewed and fixed, and asks the owner only at
the stops listed below. The owner then merges.

Why now: PRs #166 and #167 were bundled small fixes run by hand through
`/ticket`. Each took about eight stage 5 rounds over a week, with the owner
carrying reports between a review session and a fix session. Two causes:

- Stage 5 sits outside any run, so the owner is the messenger.
- A full re-review each round, plus U146's "fix every bug found, whatever
  file and however old", gives the loop no reason to end.

`make pipeline` (ADR-0018) already runs triage to PR with a lead, a planner
and an implementer. This design extends it; it does not replace it.

## Goals

1. One entry point for both job sizes.
2. The review and fix loop runs inside the run, with no owner relay.
3. The loop converges: a scope rule for bugs, re-review of the fix delta
   only, and a cap on rounds.
4. The owner is asked only where the owner's answer is needed.
5. Every agent is Claude. No other vendor, no second subscription.

## Non-goals

- Paperclip or any tool with its own task tracker. Jira stays the only one.
- A web UI, an org chart, schedules, a manager tree or a control plane.
- Token budgets or spend tracking. A usage limit stops the run and the
  state file resumes it, as today.
- Notifications. The owner is at the terminal with Remote Control on.
- Several jobs at once, or worktree lanes. One job is in flight.
- The lead choosing the next job. The owner names it.
- Any agent merging. The owner merges every PR (U123).

## Anti-goals

- A review round that widens the PR.
- A stop that only collects a rubber stamp.
- The owner pasting one agent's report into another.
- The lead editing code, a plan or a fix.
- A second record of the work beside Jira and the PR.

## The job

A job is one of:

- **One large ticket.** Anything that is not a small fix by CLAUDE.md's
  definition. It gets a spec, a plan and a red team.
- **One bundle of small fixes** that ship as one PR. Each fix keeps its own
  commit, regression test and short plan in the PR body, and one review
  loop covers the bundle (U136). A single small fix is a bundle of one.

The owner launches with one key or several. The lead makes the small-fix
call per key, as the pipeline does today. It checks the grouping against
`docs/implementation-order.md` and the board, and says so if the keys are
not grouped there, without stopping (lead's call in this design: the owner
named the job). A bundle that contains a key which is not a small fix
stops: that key needs its own run.

## The stops

The run waits for the owner at these points and no others:

| Stop                      | When                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| Product questions         | Large ticket only. One batch, before the spec is written up.                               |
| Spec approval             | Large ticket only. The written spec, before planning.                                      |
| SRS change                | A requirement does not fit or the agent disagrees with it.                                 |
| Rules 1 to 3              | A verified finding against tenant isolation, money or immutable history, wherever it sits. |
| The cap                   | The branch's own bugs are still open after two fix rounds.                                 |
| A teammate's stop-and-ask | As today: a destructive step, a broken plan, failing baseline tests.                       |
| The merge                 | Always the owner's.                                                                        |

The push that opens the PR is no longer a stop (replaces U124). A blocked
ticket still ends the run at triage, as today.

## Spec stage (large tickets)

The lead writes the spec from the ticket, the SRS IDs it cites, the project
brief and the code. It sorts every open question into two piles:

- **Product.** What the app does, what a user sees, a taste call. These go
  to the owner in one message.
- **Engineering.** The lead answers these itself. It checks primary
  documentation and what established projects do for the same problem, picks
  one proven option, and records it in the spec under "Lead's calls" with
  the source (a URL or `file:line`; memory is not a source). The owner can
  overrule any of them when reading the spec.

The owner approves the written spec before the planner starts.

The same split applies to a red-team finding the planner disputes: the lead
rules an engineering dispute itself, with a source, and lists it in the PR
body. A product dispute, and a Critical still open after round 3, go to the
owner. (This is the design's call, not something the owner said; see "Calls
made in this design".)

## SRS changes

When a requirement does not fit, the run stops and asks. On the owner's yes,
the lead records the change as a comment on the ticket being worked,
prepares the SRS row for the owner's Cowork agent as today, and carries on.
No new ticket is raised. CLAUDE.md's "is always ticketed" is amended to say
this.

## Which bugs a branch fixes

This replaces U146's scope. The principle is the one in Google's code review
standard: a change merges once it clearly improves the code's health, and
never when it makes it worse.

| Class       | Test                                                                                                                                         | What happens                                                                                                                                                                      |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Introduced  | The wrong behaviour does not exist at the merge base.                                                                                        | Fixed on the branch. Never ticketed, never merged.                                                                                                                                |
| On the path | Older, and the input that reaches it runs through code the branch adds or changes, or it makes the branch's own feature give a wrong result. | Fixed on the branch, with a regression test.                                                                                                                                      |
| Unrelated   | Older, and neither of the above.                                                                                                             | Its evidence goes on the open ticket that already owns that code. A new ticket, linked to the parent, only when a board search finds none. Named under Decisions. Not fixed here. |

The definition of a bug in CLAUDE.md does not change. A finding that is not
a bug still takes the schedule test (U130). The old exception paragraph
(outside the branch's files and needing a migration or endpoint) goes: the
Unrelated class covers it.

Three clarifications from the plan's red team (9 Nov 2026):

- A comment, doc or runbook line has no input that reaches it. It is On
  the path when the diff touches it or it describes code the branch changes.
- A Critical or Important finding that the branch does not do what its own
  spec, plan or definition of done requires is fixed on the branch like an
  Introduced bug and counts toward the cap, though it is not a bug by the
  definition.
- A rule 1 to 3 finding is verified whatever its severity, and stops for
  the owner once per finding, not once per round.

## The review loop

Runs for every job that is not docs-only, because the implementer's own
final review is a self-review. It runs on the local branch, before the
push, so the PR opens already reviewed.

The range a review reads is set through the branch's upstream, the diff
`/code-review` documents as its default and the one the 9 Nov spike ran. The
lead checks the upstream ref before each review and the cited files after
it, because a review of the wrong diff would end the loop falsely.

**Who does what.** The reason behind U125 holds: nothing that wrote the code
reviews it. The lead never edits code, so the lead may collect a review.

- The finders are fresh contexts: `/code-review` at the level `/review-pr`
  uses, and the `rls-auditor`, `append-only-auditor` and `valuation-verifier`
  agents whose trigger the diff meets. The lead dispatches them and collects
  the results, the way it runs the red team today.
- Each Critical and Important finding is verified before it is kept:
  disproved against the code, the spec and the installed library source, or
  kept with `file:line` evidence (`/review-pr` step 4).
- The lead classifies each surviving finding by the table above and writes
  the round's report to the state directory.
- A fresh fixer, dispatched by the lead as a subagent, fixes the Introduced
  and On-the-path bugs. Its brief is the report's file path, not a
  paraphrase. It adds a regression test per bug, probes each fix beyond the
  report's own examples, writes the Decisions lines, runs `make check`, and
  never amends a commit it did not author. Each round gets a new fixer.
- The implementer teammate has shut down before the loop starts, so two
  writers are never in the checkout together.

**Rounds.**

1. Full review of the branch (merge base to HEAD).
2. Fix round 1, then a re-review of that fix's delta only
   (`<before>..<after>`), with the auditors the delta triggers.
3. Fix round 2, then a delta re-review.

The loop ends as soon as a review returns no Introduced or On-the-path bug.
A re-review does not go looking outside the delta. A verified finding that
arrives anyway is classified like any other.

**The cap.** If the second delta re-review still shows such a bug, the run
stops. Before stopping, the lead runs `/design-audit` on the mechanism the
open findings sit in, report only. The owner sees the open findings and that
report and chooses: one more fix round, a different design for the
mechanism, or end the run. A bug the branch introduced is never ticketed
and merged.

Clarified on 9 Nov 2026 (U196): the cap fires once the second fix round has
closed, however it closed. A fix round that commits nothing gets no delta
re-review, since an empty delta has nothing to review.

Cut on 9 Nov 2026 after the whole-branch review, where four reviews found
their gaps in it: taking one key out of a bundle at the cap. At the cap the
owner may also end the run; a bundle's other keys are then relaunched as a
new job.

**Rules 1 to 3.** A verified finding against a non-negotiable rule 1 to 3
stops the run once, whatever its class, with the evidence and the proposed
fix. It is never ticketed without the owner seeing it. If the owner has an
Unrelated one fixed on this branch, that fix gets its own delta re-review
and does not count as one of the two rounds.

## After the loop

The lead runs `make lint` and `make test` itself and reads the exit codes; a
fixer's "green" is not taken on trust. It pushes the branch, opens the PR
from the template with "How it ran" filled, and ticks the review line with
the report paths and the round count. It moves the tickets to In Review and
tells the owner: the PR, the rounds, what was fixed, tickets raised, and the
lead's calls.

The lead then waits for CI on the head commit. A red CI gets one fresh
fixer and a delta re-review; a second red stops for the owner.

`/review-pr` in a separate session and `/code-review ultra` stay available
to the owner as an extra check. Neither is required to merge a run's PR.
Reopening the run from such a report was cut on 9 Nov 2026 after the
whole-branch review; a late finding is fixed on the manual path. Close-out
runs from the merge as today.

A job stays in flight until its PR merges or closes, as today, because a
late fix round works in the same checkout.

## The manual path

`/ticket` stays for when agent teams break. Its PRs keep a separate-session
`/review-pr`, since no lead collects a review there. The bug scope table,
delta-only re-review and the two-round cap apply to it too: they live in
CLAUDE.md and `/review-pr`, not only in the pipeline.

## What changes in the repo

- `.claude/commands/pipeline.md`: several keys, the bundle path, the spec
  split, the review loop, the stops above, the lead pushing.
- `scripts/pipeline.sh`, `scripts/pipeline.test.sh`, the Makefile target:
  accept more than one key.
- `CLAUDE.md`: the bug paragraphs, the SRS line, "How work runs" (stage 1,
  stage 5, small fixes), the hooks paragraph where it cites the push stop.
- `.claude/commands/ticket.md` and `review-pr.md`: the bug scope wording.
  `/ticket` stays as the manual path for when agent teams break.
- `.github/pull_request_template.md`: the review line and the Set aside
  comment.
- `docs/implementation-order.md`: the U146 line under "Constraints every
  branch carries".
- A new ADR that supersedes ADR-0018's stage 5 decision. A new ADR, not an
  amendment to 0018.
- TYRE-395, a CI step that fails a code PR with no ticked separate-review
  line, was closed unbuilt into TYRE-470 on 9 Nov 2026. It is not built
  here; the review line stays a written rule.
- `make pipeline` passes `T` to the launcher as data. Today's recipe lets
  the shell run a backtick or `$(...)` inside `T` before the launcher's
  check sees it, which the red team reproduced.
- *TYRE-473 replaced `merge-push-guard.sh` with the `pre-push` hook, the
  `develop` ruleset and the restricted `gh` token.* `.claude/settings.json`
  already allows `git push`, and
  `merge-push-guard.sh` asks only for `develop` and `main`. The loop also
  runs `git branch`, `git checkout`, `git rev-parse` and `timeout`. The
  owner added allow rules for the forms the loop runs (f3aa3298, narrowed
  in 10020db8), so a prompting permission mode no longer asks at each.

This change itself ships through today's process: `/ticket` or the current
pipeline, then a separate-session `/review-pr` (U125 as it stands). The new
loop cannot review the PR that creates it.

- The owner rulings are on TYRE-470: U191 bug scope (replaces U146's),
  U192 review inside the run (amends U125), U193 no push stop (replaces
  U124), U194 an SRS change is recorded on the working ticket (amends the
  29 Sep ruling), U195 the lead-drafted spec and the job.

## Cost

Per job, at most: the lead, a planner, up to three red-team passes, an
implementer, one full review, two fixers and two delta reviews. Up to the
PR that matches today. After it, three review passes at most replace the
eight or nine that #166 and #167 took, and the two later passes read a fix
delta, not the whole branch. Agents hand over file paths, so the lead's
context holds reports by reference.

Model tiers: ADR-0023's amendment of 10 Nov 2026 (TYRE-476, U205) names the
model for each step. A reviewer on a different tier from the author stands
in for the cross-vendor review this setup does not have, and when the
implementer runs on Opus, the auditors its files trigger are the
independent check.

## Left to the builder

- The launch syntax for several keys, and the state file's new fields
  (keys, each round's range, counts by class, fixers' reports, lead's
  calls). A resume restarts the loop at the round after the last recorded.
- Whether the lead verifies findings itself or dispatches a fresh verifier.
- How `/review-pr`'s steps are reused for a branch that has no PR yet.
- `superpowers:brainstorming` asks one question per message. The playbook
  has to tell the lead to batch the product questions, or the skill's rule
  wins.
- One spike before the plan: on the installed Claude Code (2.1.319), can a
  teammate now collect its own subagents? ADR-0018's spike on 2.1.296 said
  no. If it can, ADR-0018's "Revisit when" fires and the implementer can
  get a fresh reviewer per task back.
- The briefs' exact wording.

## Calls made in this design

Not said by the owner; each can be overruled:

- Two fix rounds, and delta-only re-review.
- The review runs before the push, not on an open PR.
- The lead rules disputed engineering findings from the red team.
- `/design-audit` runs before the cap stop.
- The fixer is the lead's subagent, new each round, on the model ADR-0023's
  amendment names (TYRE-476).
- The lead reports a grouping mismatch with the implementation order and
  carries on.
- The wording of the "On the path" test.
- A new ADR, not an amendment.
- The lead waits for CI and gives a red run one fixer.
- A job stays in flight until its PR merges or closes.
- The manual path keeps a separate-session review but takes the same scope
  rule and cap.

## How we will know it worked

The next small-fix bundle from `docs/implementation-order.md` runs from one
launch to an open PR with the owner asked only at a listed stop, in three
review passes or fewer, and the owner merges it without opening a second
session.
