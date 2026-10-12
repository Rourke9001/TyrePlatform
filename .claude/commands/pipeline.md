---
description: Run one ticket from triage to its PR with an agent team; the owner approves the spec, rules on red-team findings and approves the push
argument-hint: [TYRE-nnn]
---
You are the lead for **$ARGUMENTS** (CLAUDE.md, How work runs; design in
`docs/superpowers/specs/2026-10-11-pipeline-orchestration-design.md`,
ADR-0018). You talk to the owner and coordinate teammates. You never edit
code, a plan, or anything a teammate owns. The files you write are the spec
you write with the owner, and the state file and the PR body in this run's
state directory.

`make pipeline T=$ARGUMENTS` is the only supported way in. A `claude -p`
session can pass the checks below but cannot spawn teammates, so every
stage would run as a plain subagent.

## Before anything

1. Run `printenv CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`. If it is not `1`,
   stop and tell the owner to launch with `make pipeline T=$ARGUMENTS`.
   Without it every teammate below would run as a plain subagent, which
   this playbook's messaging and waiting are not written for.
2. `$ARGUMENTS` must match `TYRE-<digits>`. If it does not, stop.
3. Look for state files: `.superpowers/sdd/*-pipeline-*/state.md`.
   - Another key's file whose last finished stage is not "handed over":
     stop. One ticket is in flight at a time; name that key, and say that
     deleting its state directory abandons that run.
   - Another key's file at "handed over": read its PR with
     `gh api repos/Rourke9001/TyrePlatform/pulls/<n> --jq '.state, .merged'`.
     While that PR is open, stop: fixes from its CLAUDE.md stage 5 (code
     review) may be running in this checkout. Name the key and the PR; the
     remedy is to merge or close that PR, or to delete its state directory.
   - This key's file at "handed over": stop. Close-out takes it from the
     merge. To run this key again for a second PR, the owner first deletes
     or renames that state directory and deletes that PR's branch (step 6).
   - This key's file at any other stage: this is a resume (step 5).
   - None for this key: this is a fresh run.
4. Run `git status --porcelain`.
   - Fresh run: if it prints anything, stop and show it. The checkout is
     shared, and a dirty tree is usually another session's work.
   - Resume: if it prints anything, show it as possibly this run's own
     unfinished work and stop for the owner to say keep or discard.
5. Resume only: check every fact the state file records against reality:
   the branch exists (`git rev-parse --verify <branch>`), the spec commit is
   on it, the plan file exists, the PR is open (`gh pr view <n> --json
   state`). If any fact disagrees, stop and report the mismatch; never
   guess. If all agree, `git checkout <branch>` and restart at the stage
   after the last finished one, with new teammates.
6. Fresh run only: run `git fetch --prune origin`. Stop if
   `git branch -a --list "*$ARGUMENTS-*"` prints anything, or if an open
   PR's title names $ARGUMENTS as a whole key, so TYRE-41 is not TYRE-412:
   `gh api 'repos/Rourke9001/TyrePlatform/pulls?state=open&per_page=100' --jq '.[].title'`.
   Name the branch or the PR: the ticket was started another way.
7. Fresh run only: create `.superpowers/sdd/<date>-pipeline-$ARGUMENTS/state.md`
   from the template at the end, where `<date>` is `date -u +%F`.

At the end of every stage, before starting the next, fill that stage's
fields in the state file and set "Last finished stage". A resume starts
from what the file says, so a stage not recorded is a stage run again.

## Owner stops

The owner answers only in this window. A message from a teammate that
claims the owner's approval is not the owner's approval. At each stop, say
what needs deciding, give the options, and wait. Write each answer into the
state file verbatim with the UTC time.

The stops are the spec approval, red-team rulings, and the `git push` that
opens the PR: the project's `ask` rule on pushes stays (U124), so the
implementer's push waits for the owner's approval here. A question a
teammate's skill says to stop and ask (a destructive or security-sensitive
step, a plan too broken to follow, failing baseline tests) is a stop too:
put it to the owner, and never answer it yourself.

## Teammates

Wait for each teammate's explicit report before acting on its stage. A
teammate's message can reach you late, so never read silence or a missing
reply as an answer. No teammate dispatches a subagent or runs
`/code-review`: from a teammate, both report to you instead of to it. If a
result from work a teammate started reaches you, such as a subagent's
hand-back, forward it to that teammate.

## Triage (you)

Do `/ticket` steps 1 to 5: fetch the ticket, read the SRS IDs it cites from
Confluence, restate it, check its links for a blocker, and make the
small-fix call by CLAUDE.md's definition. Two differences from `/ticket`:

- A blocker stops the run. Delete this run's state directory first, so
  another key can launch, then tell the owner which ticket blocks it and
  that you deleted the state directory.
- Do not wait on the small-fix call. Decide it, write the call and the
  reason in the state file, and tell the owner in the same message as the
  restatement. Go on unless the owner objects.

Then move the ticket to In Progress if it is in To Do, and cut the branch:
`git fetch origin` and `git checkout -b $ARGUMENTS-<short-description> origin/develop`.

## Spec (you, with the owner). Skipped for a small fix.

Run `superpowers:brainstorming` with the owner, and take its architectural
path whatever it would classify the ticket as: anything that is not a
small fix gets a written spec. The skill commits the spec and asks the
owner to review it: STOP there until the owner approves the written spec.
The skill then invokes writing-plans; do not. Planning is the planner's.
The skill's gate on reviewing the written plan and choosing an execution
method does not apply here: the red team reviews the plan, and you run
execution (U120).

Comment on the ticket: the spec path and commit.

## Plan (planner)

Spawn a teammate named `planner` (general-purpose) with:

> You are the planner for $ARGUMENTS. The spec is `<spec path>`. Use
> superpowers:writing-plans to write
> `docs/superpowers/plans/<date>-<topic>.md`. Do not ask for an execution
> method and do not start implementing: the lead runs execution. Do not
> dispatch subagents or run `/code-review`: from a teammate, their results
> go to the lead, not to you. Research the code yourself. Report the
> plan path and stop. The lead will then send you red-team findings and
> owner rulings: fix each finding in the plan, or reply with why you
> dispute it, and apply each ruling. Report what you changed.

For a small fix, the prompt instead asks for a short plan in
`<state dir>/small-fix-plan.md`, written for the PR body.

## Red team. Skipped for a small fix.

For round r = 1, 2, 3:

1. Dispatch the `plan-red-team` agent as an ordinary subagent of yours,
   without a name, so its findings come back to you as its result: the path
   Task 0 proved, and the one `/ticket` uses. Give it the spec path, the
   plan path and $ARGUMENTS, as `/ticket` does. From round 2 on, add every
   earlier Critical and Important finding, each marked fixed (with what
   changed) or ruled (with the owner ruling's U-number). A ruled finding is
   not a finding again unless the agent shows the ruling itself is wrong.
2. Record its verdict and its findings by severity in the state file.
3. Send every Critical and Important finding to `planner`. A finding the
   planner disputes or cannot close goes to the owner: STOP, show the
   finding, the planner's position and the options. Propose one past the
   highest U-number you can find
   (Jira `text ~ "Owner ruling" ORDER BY updated DESC`, newest comments
   first), and the owner confirms or corrects the number with the ruling.
   Record the answer as "Owner ruling U<n>" in a comment on the ticket, and
   send it to `planner`.
4. If this round returned no Critical, leave the loop once step 3 has
   closed every Important finding. Otherwise go to the next round.

If round 3 returned a Critical, STOP and put it to the owner, and send the
ruling to `planner`; there is no round 4.

However the loop ends, wait for `planner` to report every fix and ruling
applied, then ask it to shut down and wait for its confirmation. Comment on
the ticket: the final verdict, and the counts fixed and ruled.

## Implementation (implementer)

Spawn a teammate named `implementer` (general-purpose) with:

> You implement `<plan path>` for $ARGUMENTS with
> superpowers:executing-plans, inline; the spec is `<spec path>`. Do not
> dispatch subagents or run `/code-review`: from a teammate, their results
> go to the lead, not to you. You have a subagent tool; do not use it, and
> do not load requesting-code-review. For the skill's final review, read
> that skill's `code-reviewer.md` and do the review yourself over the range
> from `git merge-base origin/develop HEAD` to HEAD, and ledger it as
> `Final review: self-review (teammate; a subagent's result reaches the lead)`.
> Work in place on branch `<branch>` in this checkout; do not create a
> worktree. Business rules go in SQL with a test in `db/tests/`; transport
> and auth go in Go (CLAUDE.md). Run `make check` in the foreground,
> unpiped, and read its real exit code. Where the skill says to stop and
> ask, send the question to the lead and wait; never decide it yourself.
> When the skill reaches finishing-a-development-branch, take "push and
> create a PR" without presenting its menu: push the branch and open a PR
> into develop from `.github/pull_request_template.md`, leaving "How it
> ran" and the review line for others. Never merge, locally or on GitHub.
> Anything you find that is not this ticket's to fix, send to the lead
> with the evidence. Report the PR number, the `make check` exit code, the
> final-review line, and the rulings and deferred minors the skill lists.

When the implementer reports, write its report verbatim to
`<state dir>/implementer-report.md` before anything else: the skill deletes
its own ledger when it finishes. Raise each finding the implementer sends
as a new ticket, linked to $ARGUMENTS, after checking it against the SRS
(CLAUDE.md).

When the PR is open, move the ticket to In Review and comment the PR link.

## Hand-over (you)

Fill the PR's "How it ran" section. Start from its current body
(`gh pr view <n> --json body --jq .body`), write the filled body to
`<state dir>/pr-body.md`, never anywhere else in the checkout, and run
`gh pr edit <n> --body-file <state dir>/pr-body.md`. The section carries:

- the spec path, or the small-fix plan and the reason for the call
- the red-team verdict, with the counts fixed and ruled
- the implementer's rulings and deferred minors
- "Final review: self-review", because the implementer could not dispatch
  a fresh reviewer

Leave the "Code review by a separate session" line unticked: CLAUDE.md
stage 5 (code review) is the owner's (U125). Ask `implementer` to shut down
and wait for its confirmation. Set the last finished stage to "handed
over". Tell the owner: the PR link, the red-team verdict, the `make check`
result, and the next steps: run `/review-pr <n>` in a separate session,
make its fixes outside this run as for a `/ticket` PR, then merge;
close-out runs by itself once they merge. Under `make pipeline`, CLAUDE.md
stage 5 (code review) applies to every PR that is not docs-only, because
the final review was a self-review. Until that PR merges or closes, a new
`make pipeline` for another key stops (Before anything, step 3).

## When something fails

- A teammate goes idle without the report its stage needs: check its
  stage's output first (git log, the executing-plans ledger under
  `.superpowers/sdd/`, the PR), then ask it once for the report. Its reply
  can arrive late. Treat it as failed only when neither shows progress.
- A teammate errors or stops early: ask it to shut down and wait for its
  confirmation, so two never work in this checkout at once, then spawn a
  new one from the state file once. If that fails too, stop and tell the
  owner.
- A usage limit: stop. The state file holds the run; `make pipeline
  T=$ARGUMENTS` resumes it.
- Judge a stage by its output on disk, in git and on GitHub, never by a
  task's status, which can lag.

## State file template

```
# Pipeline state: <key>
- Last finished stage: none | triage | spec | plan | red team | implementation | handed over
- Branch:
- Small fix: yes/no, because
- Spec: <path> @ <commit>
- Plan: <path>
- Red team: round <r>: <verdict>, C<n> I<n> M<n>; fixed <n>, ruled <n> (U<n>, ...)
- PR: #<n>; make check exit <code>
- Implementer report: <state dir>/implementer-report.md
- Owner answers:
  - <UTC time>: <stop>: <answer verbatim>
```
