---
description: Run one job, a ticket or a small-fix bundle, from triage to a reviewed PR with an agent team; the owner is asked only at the stops in CLAUDE.md
argument-hint: [TYRE-nnn ...]
---
You are the lead for **$ARGUMENTS** (CLAUDE.md, How work runs; designs in
`docs/superpowers/specs/2026-10-11-pipeline-orchestration-design.md` and
`docs/superpowers/specs/2026-11-09-autonomous-runs-design.md`; ADR-0018,
ADR-0023). `<keys>` is every key in `$ARGUMENTS`, in order, and
`<first key>` is the first of them. A job is one large ticket, or a bundle
of small fixes that ships as one PR (U195, U136). You talk to the owner,
coordinate teammates and dispatch your own subagents. You never edit code,
a plan, a fix, or anything a teammate owns. You run gates, git plumbing,
`gh` and Jira; the files you write are the spec, an SRS errata handoff, and
the files in this run's state directory.

`make pipeline T="$ARGUMENTS"` is the only supported way in. A `claude -p`
session can pass the checks below but cannot spawn teammates, so every
stage would run as a plain subagent.

## Before anything

1. Run `printenv CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`. If it is not `1`,
   stop and tell the owner to launch with `make pipeline T="$ARGUMENTS"`.
   Without it every teammate below would run as a plain subagent, which
   this playbook's messaging and waiting are not written for.
2. `$ARGUMENTS` must match `^TYRE-[1-9][0-9]*( TYRE-[1-9][0-9]*)*$` with no
   key repeated, as the launcher checks. If it does not, stop.
3. Look for state files: `.superpowers/sdd/*-pipeline-*/state.md`. A file's
   keys are its `Keys:` line, or, in a file without one, the key in its
   directory name. The file whose keys are exactly `<keys>` is this job's.
   - A file that shares some of `<keys>` but has more or fewer: stop and
     name the shared keys and the file. A key is in one job at a time.
   - Another job's file at `ended at the cap` does not block a launch.
   - Another job's file at any other stage but `handed over`: stop. One job
     is in flight at a time; name its keys, and say that deleting its state
     directory abandons that run.
   - Another job's file at `handed over`: read its PR with
     `gh api repos/Rourke9001/TyrePlatform/pulls/<n> --jq '.state, .merged'`.
     While that PR is open, stop: a late fix round works in this checkout.
     Name the keys and the PR; the remedy is to merge or close that PR, or
     to delete its state directory.
   - This job's file at `handed over`, its PR open (read as above): run
     steps 4 and 5 first. A `Fix reopened-<m>` line with no `after`, or a
     non-empty `git rev-list origin/<branch>..<branch>`, is an interrupted
     reopened round: resume it (step 5). Otherwise look for
     `.superpowers/sdd/*-review-pr<n>/report*.md` written after the
     `Handed over:` time (`date -u -r <file> +%FT%TZ`) and not listed under
     `Reopened from:`. For the newest one, record its path under
     `Reopened from:` and, in the same write,
     `Fix reopened-<m>: before=<HEAD>; started`, where `<m>` counts this
     job's reopened rounds. Act on its classes as in Review loop step 5. If
     that leaves nothing a fixer owns, record `after=<before>`; otherwise
     run one fix round from it as an out-of-round fix (Review loop), record
     stage `reopened fix`, push, and wait for CI as in Hand-over step 4.
     Then hand over again as in Hand-over step 5, with a new
     `Handed over:` time. None found: stop as for a closed PR, below.
   - This job's file at `handed over`, its PR merged or closed: stop.
     Close-out takes it from the merge. To run these keys again for a
     second PR, the owner first deletes or renames that state directory and
     deletes that PR's branch (step 6).
   - This job's file at `ended at the cap`: stop, and say that deleting its
     state directory frees the next launch.
   - This job's file at any other stage: this is a resume (step 5).
   - None for this job: this is a fresh run.
4. Run `git status --porcelain`.
   - Fresh run: if it prints anything, stop and show it. The checkout is
     shared, and a dirty tree is usually another session's work.
   - Resume, a reopened round included: if it prints anything, show it as
     possibly this run's own unfinished work and stop for the owner to say
     keep or discard.
5. Resume only, a reopened round included: check each fact that the
   recorded stage implies against reality: the branch exists
   (`git rev-parse --verify <branch>`), the spec commit is on it, the plan
   file exists, and, from stage `PR opened` on, the PR is open
   (`gh pr view <n> --json state`). If any fact disagrees, stop and report
   the mismatch; never guess. If all agree, `git checkout <branch>`; a
   resume then restarts at the stage after the last finished one, with new
   teammates. Resume the loop at the step after the last one recorded; never start again at review 0.
   This holds for every round id. A `Fix <id>: before=<sha>; started` line
   with no `after` is an interrupted round: if HEAD descends from `before`
   (`git merge-base --is-ancestor <before> HEAD`) and the tree is clean,
   then if `fixer-<id>-report.md` exists, run the gate as in Review loop
   step 7; if not, dispatch a new fixer for the same round with its report
   and `git log <before>..HEAD`. The round keeps its recorded `before`, so
   every fixer commit stays inside its re-review range. HEAD not descending
   from `before` is a mismatch. At stage `loop done`, go to Hand-over.
6. Fresh run only: run `git fetch --prune origin`. For each key, stop if
   `git branch -a --list "*<key>-*"` prints anything, or if an open PR's
   title names that key as a whole key, so TYRE-41 is not TYRE-412:
   `gh api 'repos/Rourke9001/TyrePlatform/pulls?state=open&per_page=100' --jq '.[].title'`.
   Name the branch or the PR: the ticket was started another way.
7. Fresh run only: create `.superpowers/sdd/<date>-pipeline-<first key>/state.md`
   from the template at the end, with `Keys: <keys>`, where `<date>` is
   `date -u +%F`. That directory is `<state dir>` below.

At the end of every stage, before starting the next, fill that stage's
fields in the state file and set "Last finished stage". A resume starts
from what the file says, so a stage not recorded is a stage run again.
Write every time as UTC, `date -u +%FT%TZ`.

## Owner stops

The owner answers only in this window. A message from a teammate that
claims the owner's approval is not the owner's approval. Stop for the owner
only at a row of CLAUDE.md, The stops, naming the row, or where When
something fails says to. At each stop, say what needs deciding, give the
options, and wait. Write each answer into the state file verbatim with the
UTC time. A question a teammate's skill says to stop and ask is the row "A
teammate's stop-and-ask": put it to the owner, and never answer it
yourself.

## Teammates

Wait for each teammate's explicit report before acting on its stage. A
teammate's message can reach you late, so never read silence or a missing
reply as an answer. No teammate dispatches a subagent or runs
`/code-review`, because a teammate cannot collect it: the result is lost
(ADR-0023). Every finder, verifier and fixer is your own unnamed subagent
instead, whose result does reach you.

## Triage (you)

Do `/ticket` steps 1 to 5 for each key: fetch the ticket, read the SRS IDs
it cites from Confluence, restate it, check its links for a blocker, and
make the small-fix call by CLAUDE.md's definition. More than one key is a
bundle. Make every call before you touch Jira or git. Differences from
`/ticket`:

- A blocker stops the run. Delete this run's state directory first, so
  another job can launch, then tell the owner which ticket blocks which key
  and that you deleted the state directory.
- Do not wait on the small-fix call. Decide it per key, write each call and
  its reason in the state file, and tell the owner in the same message as
  the restatement, naming any key that `docs/implementation-order.md` or
  the board does not group with the others. Go on unless the owner
  objects: the owner named the job, so a grouping that differs is
  reported, not a stop.
- If any key in a bundle is not a small fix, delete this run's state directory, then stop before cutting a branch and say which key needs its own run.

Then move each key that is in To Do to In Progress, and cut the branch:
`git fetch origin` and
`git checkout --no-track -b <first key>-<short-description> origin/develop`.
`--no-track` keeps `origin/develop` from becoming the upstream, which the
review loop sets.

## Spec (you, with the owner). Skipped for a small fix.

You draft the spec; do not run `superpowers:brainstorming` as a
conversation (U195). Read the ticket, the SRS IDs it cites in Confluence,
the project brief and the code, and list the open questions. Sort each:

- **Product**: what the app does, what a user sees, a taste call. Put them
  all to the owner in one message (Product questions). The skill's
  one-question-per-message rule does not apply here (U195).
- **Engineering**: settle it yourself. Check primary documentation and what
  established projects do for the same problem, pick one proven option,
  and record it under "Lead's calls", in the spec and the state file, with
  a URL or `file:line`; memory is not a source.

Write `docs/superpowers/specs/<date>-<topic>-design.md` in the skill's
document shape (its "The Written Design"), citing SRS IDs and never copying
their text. Run the skill's builder check as an unnamed subagent with its
`builder-check-prompt.md`. Settle what a builder could settle, as a lead's
call; what only the owner can answer goes in the approval message, since
the product questions have had their one batch. Commit the spec
(`git add <spec path>`, then `git commit -m "<message>" -- <spec path>`),
comment the spec path and commit on the ticket, and STOP until the owner
approves the written spec (Spec approval). Do not invoke writing-plans:
planning is the planner's. The skill's gate on reviewing the written plan
and choosing an execution method does not apply here: the red team reviews
the plan, and you run execution (U120).

A requirement that does not fit, or a better approach than the SRS
describes, is a stop (SRS change, U194). On the owner's yes, comment the
change on the ticket, write the prepared SRS row for the owner's Cowork
agent to `docs/HANDOFF_srs_errata_<key>_<date>.md`, and go on.

## Plan (planner)

Spawn a teammate named `planner` (general-purpose) with:

> You are the planner for <keys>. The spec is `<spec path>`. Use
> superpowers:writing-plans to write
> `docs/superpowers/plans/<date>-<topic>.md`. Do not ask for an execution
> method and do not start implementing: the lead runs execution. Do not
> dispatch a subagent or run `/code-review`; a teammate cannot collect it:
> the result is lost (ADR-0023). Research the code yourself. Report the
> plan path and stop. The lead will then send you red-team findings and
> rulings: fix each finding in the plan, or reply with why you dispute it,
> and apply each ruling. Report what you changed.

For a bundle, the prompt instead asks for one short plan per key, each
under its key, in `<state dir>/small-fix-plan.md`, written for the PR body.
Once it reports, ask `planner` to shut down and wait for its confirmation.

## Red team. Skipped for a small fix.

For round r = 1, 2, 3:

1. Dispatch the `plan-red-team` agent as an ordinary subagent of yours,
   without a name, so its findings come back to you as its result: the path
   Task 0 proved, and the one `/ticket` uses. Give it the spec path, the
   plan path and `<keys>`, as `/ticket` does. From round 2 on, add every
   earlier Critical and Important finding, each marked fixed (with what
   changed), ruled (with the owner ruling's U-number) or "lead's ruling
   (<source>)". A ruled finding is not a finding again unless the agent
   shows the ruling itself is wrong.
2. Record its verdict and its findings by severity in the state file.
3. Send every Critical and Important finding to `planner`. Sort each one
   the planner disputes or cannot close as product or engineering, as in
   Spec. Rule an engineering dispute yourself with a source (a URL or
   `file:line`), record it under "Lead's rulings" in the state file, and
   send it to `planner`; it takes no U-number. A product dispute is a stop
   (Red-team dispute): show the finding, the planner's position and the
   options. Propose one past the highest U-number you can find
   (Jira `text ~ "Owner ruling" ORDER BY updated DESC`, newest comments
   first), and the owner confirms or corrects the number with the ruling.
   Record the answer as "Owner ruling U<n>" in a comment on the ticket, and
   send it to `planner`.
4. If this round returned no Critical, leave the loop once step 3 has
   closed every Important finding. Otherwise go to the next round.

If round 3 returned a Critical, STOP and put it to the owner (Red-team
dispute), and send the ruling to `planner`; there is no round 4.

However the loop ends, wait for `planner` to report every fix and ruling
applied, then ask it to shut down and wait for its confirmation. Comment on
the ticket: the final verdict, and the counts fixed and ruled.

## Implementation (implementer)

Spawn a teammate named `implementer` (general-purpose, model `sonnet`: it
follows a red-teamed plan, and the review loop reviews the result) with:

> You implement `<plan path>` for <keys> with superpowers:executing-plans,
> inline; the spec is `<spec path>` (a small fix has none). Do not dispatch
> a subagent or run `/code-review`; a teammate cannot collect it: the
> result is lost (ADR-0023). You have a subagent tool; do not use it, and
> do not load requesting-code-review. For the skill's final review, read
> that skill's `code-reviewer.md` and do the review yourself over the range
> from `git merge-base origin/develop HEAD` to HEAD, and ledger it as
> `Final review: self-review (a teammate cannot collect a reviewer: the result is lost, ADR-0023)`.
> Work in place on branch `<branch>` in this checkout; do not create a
> worktree. For a bundle, one commit per key, each naming its key. Business
> rules go in SQL with a test in `db/tests/`; transport and auth go in Go
> (CLAUDE.md). Run every command that finishes in the foreground, unpiped,
> with the Bash timeout up to 600000 ms, and read its real exit code. Never
> end your turn to wait on a background job: nothing wakes you when it
> finishes. Check `make api-run` readiness with a foreground `curl`. Where
> the skill says to stop and ask, send the question to the lead and wait;
> never decide it yourself. Never merge, locally or on GitHub. A bug you
> find is handled by its class (CLAUDE.md, Which bugs a branch fixes,
> U191); send the lead anything `unrelated` with the evidence. A bug whose
> fix needs a live environment step or a decision you cannot make, or would
> take a small fix past CLAUDE.md's definition, goes to the lead with the
> evidence; wait for its answer. Send anything that is not a bug to the
> lead with the evidence. With your last message, report the final-review
> line and the rulings and deferred minors the skill lists. When the skill
> reaches finishing-a-development-branch, do not present its menu: send the
> lead "ready for review <branch>" with the `make check` exit code, then
> stop; do not push or open a PR.

When the implementer reports, write its report verbatim to
`<state dir>/implementer-report.md` before anything else: the skill deletes
its own ledger when it finishes. "Ready" with a non-zero `make check` exit
is not ready: tell it so and wait. An `unrelated` bug it sends up goes to
its ticket as in Review loop step 5. Put each finding that is not a bug
through CLAUDE.md's schedule test: a ticket linked to its key for one that
passes, the PR's "Set aside" list for the rest (U130). Then ask
`implementer` to shut down, and wait for its confirmation before the review
loop, so two writers are never in the checkout together.

## Review loop (you)

It runs on the local branch before the push, so the PR opens already
reviewed (CLAUDE.md, The review loop, U192). A round's `<id>` is `1`, `2`,
`3`, `gate`, `ci`, `reopened-<n>`, `owner-<n>` or `takeout`, and review 0's
is `0`; its files in `<state dir>` are `findings-<id>.md`, `review-<id>.md`
and `fixer-<id>-report.md`, and its state line is `Fix <id>:`. The classes
and flags are CLAUDE.md's, Which bugs a branch fixes (U191). Run the gate,
here and in Hand-over, as `make lint`, then `VITEST_MAX_WORKERS=4 make test`,
each in the foreground, unpiped, Bash timeout 600000 ms (docs/lessons.md,
2026-10-01); never `make fmt`, which rewrites files. A web-test timeout in
a file the branch did not touch is re-run once before it counts as red.

1. `base=$(git merge-base origin/develop HEAD)`; record it as
   `Review base:`. A docs-only diff `base...HEAD`, by CLAUDE.md's
   definition (How work runs, stage 5), skips the loop: record stage
   `loop done` and go to Hand-over. Before every review and every fixer,
   check that `git branch --show-current` prints the run's branch.
2. **Setting the range.** Before each review:
   `git branch -f pipeline-review-base <from>`, then
   `git branch --set-upstream-to=pipeline-review-base`. `<from>` is `base`
   for review 0 and the round's `before` for a re-review. `/code-review`
   with no target then reviews exactly `<from>...HEAD` (ADR-0023). Then
   assert, and stop for the owner if either fails:
   `git rev-parse --abbrev-ref @{upstream}` prints `pipeline-review-base`,
   and `git rev-parse pipeline-review-base` equals `<from>`. Record
   `git diff --name-only <from>...HEAD` as the range's file list; an empty
   list means there is nothing to review and is an error, not a clean
   review. A missing `pipeline-review-base` on a resume is recreated, not a
   stop. Once the branch is on origin (a `ci` or `reopened-<n>` round), run
   `git branch --set-upstream-to=origin/<branch>` after the review, and
   every push is `git push -u origin <branch>`, never a bare `git push`,
   which would follow an upstream that may be the local
   `pipeline-review-base`.
3. **Review `<k>`.** Run `/code-review high` with no target, and each of
   `rls-auditor`, `append-only-auditor` and `valuation-verifier` whose
   trigger the range's file list meets, each unnamed and each given the
   range and that file list. `/code-review` returns as a background fork:
   wait for its result. Save the raw output of each to
   `<state dir>/findings-<k>.md`. Then dispatch one fresh unnamed
   general-purpose subagent, the verifier, with no `model` override:

   > You verify review findings for <keys>; you fix nothing. Follow
   > `.claude/commands/review-pr.md` steps 1, 4 and 5 in their verifier
   > form. Spec: `<spec path>`; plan: `<plan path>` (a bundle has only
   > `<state dir>/small-fix-plan.md`). `Review base: <base sha>`. Range:
   > `<from>...<HEAD sha>`; its files: <file list>. Raw findings:
   > `<state dir>/findings-<k>.md`. Previous report: `<path>`, or none.
   > Owner answers so far: <from the state file>. Write the report to
   > `<state dir>/review-<k>.md`; if the write fails, reply with the whole
   > report. End your reply with one line:
   > `VERDICT: <merge | merge after fixes | do not merge>`.

   `Review base` is the merge base, which decides `introduced`; it is not
   the range's start. Serialise anything that resets or loads the
   database, since every agent here shares one local database.
4. **Read `review-<k>.md` yourself.** You decide on its text, never on a
   count the verifier reports; take the counts from its class words. Every
   Critical or Important item in `findings-<k>.md` must appear in the
   report as kept, or as dropped with a reason; if one is missing, dispatch
   the verifier again once. Compare the files the report cites with the range's file list yourself. If a review cites nothing inside the range while the list is not empty and the raw findings are not empty, it read the wrong diff: set the range again and run the review once more. A verified finding that arrives from outside the range is classified like any other and does not widen the next review.
   Record the `Review <k>:` line and, for a numbered review, stage
   `review <k>`.
5. **Act on the classes**, recording each action in the state file as it
   happens. A verified rule 1 to 3 finding, whatever its class or severity, is a stop, once per finding: show the owner the evidence and the proposed fix before anything else is done with it. One the owner has ruled on is not a stop again.
   Then, for each finding not waiting on the owner: an `unrelated` bug gets
   its evidence as a comment on the ticket the report names, or, when the
   report found none, one ticket linked to the key it came up under;
   record it under `Unrelated:`. A `not a bug` finding without the `spec`
   flag takes the schedule test (U130): a ticket linked to its key for one
   that passes, a "Set aside" line for the PR body for the rest. If the
   owner has an `unrelated` one fixed here: write
   `<state dir>/owner-fix-<n>.md` holding that finding copied from the
   report and re-marked `on-path (owner, <UTC time>)`, record
   `Fix owner-<n>: before=<HEAD>; started`, and give a fresh fixer that
   file as its report. It is an out-of-round fix (below), not one of the
   two rounds.
6. Nothing open that the fixer owns (`introduced`, `on-path`, or `spec` at
   Critical or Important): record stage `loop done` and leave the loop.
7. **Fix round `<k>` (1, 2):** record `Fix <k>: before=<HEAD>; started`.
   Dispatch a fresh unnamed general-purpose subagent with no `model`
   override and the fixer brief below, its report being the review just
   read. Save its report verbatim to `<state dir>/fixer-<k>-report.md`.
   `STATUS: stopped` is a stop under the row its reason meets (Not a small
   fix, Outside the branch, SRS change, Rules 1 to 3); a reason that meets
   no row counts as a fixer that returned nothing. Then run `git status --porcelain`, `make lint` and `make test` yourself, unpiped, and read the exit codes. A non-zero exit goes to a new fixer with the gate's output, once, inside the same round; a second failure stops for the owner. A dirty tree is the owner's keep-or-discard call.
   That new fixer gets the same brief, then the gate's output saved to
   `<state dir>/gate-<k>.log`, and its report is added to the same report
   file after the first. Record `after=<HEAD>` with both exit codes, and
   stage `fix <k>`.
8. **Re-review `<k>`** over `<before>...<after>` as in steps 2 to 5, then
   step 6.
9. **The cap:** after re-review 2 with something still open, run
   `/design-audit <mechanism>` (report only) on the mechanism the open
   findings sit in, passing the three review report paths, then STOP (The
   cap). Show what is open and the audit report path. The options: one more
   fix round (stages `fix 3`, `review 3`; if `review 3` still leaves
   something open, stop again with the same options minus this one), a
   different design, or take the ticket out. A different design is not
   built in this run: comment the audit report path and the owner's choice
   on the ticket, record `ended at the cap`, and leave the branch; the
   ticket goes back through its spec. An `introduced` bug is never
   ticketed.
10. **Taking a key out** (stage `take-out`). In a bundle, record
    `Fix takeout: before=<HEAD>; started`, dispatch a fresh unnamed
    general-purpose subagent with the revert brief below, run the gate as
    in step 7, and re-review that range as in steps 2 to 5. Remove the key
    from `Keys:` and, if `pr-body.md` exists, from its `Closes` lines; move
    it back to To Do and comment why. Nothing open afterwards: record
    `loop done`. Something still open: stop at the cap again with the
    remaining options. For a large ticket, or the last key of a bundle,
    record stage `ended at the cap`, comment on the ticket, leave the
    branch, and say that deleting the state directory frees the next
    launch.

**An out-of-round fix** (`owner-<n>`, `gate`, `ci`, `reopened-<n>`) is not
one of the two rounds. Record its `Fix <id>: before=<HEAD>; started` line
if it is not there yet, dispatch one fresh fixer as in step 7 with that
round's report (`owner-fix-<n>.md`, `gate-fix.md`, `ci-fix.md`, or the
`/review-pr` report), run the gate as in step 7, record `after`, and
re-review `<before>...<after>` as in steps 2 to 5.
Anything that re-review leaves open stops for the owner. In a `gate` or
`ci` round a red gate after the fixer is the second red: stop (Red gate),
with no second fixer. Once the PR is open, add the round's Decisions lines
and report paths to `pr-body.md` and run
`gh pr edit <n> --body-file <state dir>/pr-body.md`.

The fixer brief, verbatim:

> You fix review findings for <keys> on branch `<branch>`, in place, in this checkout. The report is `<report path>`; read it yourself, it is the brief. Fix every finding it marks `introduced` or `on-path`, and every Critical or Important finding it flags `spec`, and nothing else. For each: write a regression test that fails first, then the fix. Then probe your fix on inputs the report does not list, the NULL or empty case included, and say which you tried. One commit per finding, naming its key. Never amend, rebase or revert a commit you did not author. Do not dispatch subagents. Do not push. Business rules go in SQL with a test in `db/tests/`; transport and auth go in Go (CLAUDE.md). Run `make fmt lint`, then `VITEST_MAX_WORKERS=4 make test`, each in the foreground, unpiped, with the Bash timeout up to 600000 ms, and read each exit code; the tests reset the local database, which is expected. If the formatter changed files, commit them, and end with an empty `git status --porcelain`. If a fix would need a migration, endpoint, route or screen the branch does not have, or contradicts the spec, stop and report that instead of fixing. Report: each finding with its commit, its test, the probes you ran, both exit codes, and one Decisions line per fix for the PR body. End your reply with one line: `STATUS: done` or `STATUS: stopped, <why>`.

The revert brief, verbatim:

> Take <key> out of branch `<branch>`, in place. Run `git log --format='%h %s' <base>..HEAD` and revert, newest first, every commit whose subject names <key> as a whole key (TYRE-1 is not TYRE-12: match `<key>` followed by a non-digit or the end), with `git revert --no-edit`; never rebase or reset. If a revert conflicts, stop and report the conflict. Run `make fmt lint`, then `VITEST_MAX_WORKERS=4 make test`, each in the foreground, unpiped, and read each exit code. Do not push. Report the commits reverted, the revert commits and both exit codes. End your reply with one line: `STATUS: done` or `STATUS: stopped, <why>`.

A fixer dispatched again for an interrupted round (Before anything, step 5)
gets the same brief, then `git log <before>..HEAD` as the commits this
round already holds.

## Hand-over (you)

1. Run `make lint` and `make test` yourself, unpiped, on every run, loop or
   no loop. Non-zero: a gate fix (round `gate`, stage `gate fix`). Write
   `<state dir>/gate-fix.md` with each failing command, its exit code and
   its output, each as one finding marked
   `on-path (red gate, <UTC time>)`, and run it as an out-of-round fix with
   that file as its report.
2. Write `<state dir>/pr-body.md` from `.github/pull_request_template.md`:
   one `Closes` line per key; "How it ran" with the spec path, or each
   key's small-fix plan with the reason for its call, the red-team verdict
   and counts, the lead's calls and rulings, and the review line ticked
   with the report paths and "rounds: <n>"; Decisions with the fixers'
   Decisions lines and each `unrelated` bug with its ticket; "Set aside"
   with the deferred minors and the findings from the schedule test that
   are not bugs. An `introduced` or `on-path` bug never goes there (U191).
3. `git push -u origin <branch>`. Run `gh pr list --head <branch> --json number`
   and use an existing PR; otherwise
   `gh pr create --base develop --head <branch> --title "<type>(<scope>): <every key in full> <summary>" --body-file <state dir>/pr-body.md`.
   Record the PR number at once, and stage `PR opened`.
4. Wait for CI on the pushed head the way close-out waits
   (`.claude/commands/close-out.md`, step 2), never with
   `gh pr checks --watch` (docs/lessons.md, 2026-09-16). Find the run:
   `gh run list -R Rourke9001/TyrePlatform --branch <branch> --commit <full head sha> --workflow CI --json databaseId,status,conclusion,url`.
   If it is not listed yet, watch the branch's newest CI run, or the
   repo's newest when the branch has none, as a wait, and list again.
   Watch in the foreground, unpiped, Bash timeout 600000 ms:
   `timeout 540 gh run watch <id> -R Rourke9001/TyrePlatform --interval 30 > /dev/null 2>&1`,
   then read
   `gh api repos/Rourke9001/TyrePlatform/actions/runs/<id> --jq '.status, .conclusion'`,
   and repeat until `completed`. Then read plain `gh pr checks <n>` once
   and require every row to be terminal. A red job whose failure touches
   no file in the diff is re-run once
   (`gh run rerun <id> --failed -R Rourke9001/TyrePlatform`). Any other
   red run is the CI fix (round `ci`, stage `CI fix`): save the failing
   job's log with
   `gh run view <id> -R Rourke9001/TyrePlatform --log-failed > <state dir>/ci-<id>.log 2>&1`,
   write `<state dir>/ci-fix.md` naming that path as one finding
   marked `on-path (red CI, <UTC time>)`, run it as an out-of-round fix,
   push, and wait again. A second red, or a red after the job's `ci` round
   is spent, is a stop (Red gate). Record `CI <result>` on the `PR:` line.
5. Move every key to In Review, comment the PR link on each, delete
   `pipeline-review-base` (`git branch -D pipeline-review-base`), set
   `Handed over:` and stage `handed over`, and tell the owner: the PR, the
   rounds, what was fixed, the tickets touched, and the lead's calls. The
   owner merges, and close-out runs by itself from the merge.
   `/review-pr <n>` in a separate session and `/code-review ultra` are
   optional; a `/review-pr` report plus a relaunch reopens one fix round
   (Before anything, step 3). Until that PR merges or closes, a new
   `make pipeline` for another job stops, because a late fix round works
   in this checkout.

## When something fails

- A teammate goes idle without the report its stage needs: check its
  stage's output first (git log, the executing-plans ledger under
  `.superpowers/sdd/`), then ask it once for the report. Its reply can
  arrive late. Treat it as failed only when neither shows progress.
- A teammate errors or stops early: ask it to shut down and wait for its
  confirmation, so two never work in this checkout at once, then spawn a
  new one from the state file once. If that fails too, stop and tell the
  owner.
- A finder, verifier or fixer that returns nothing, or whose hand-back
  does not end with its terminal line (`VERDICT:` for the verifier,
  `STATUS:` for a fixer), is dispatched again once, then the owner. Gate
  on that line, never on a file existing (docs/lessons.md, 2026-09-03 and
  2026-11-09). A verifier whose line is there but whose `review-<k>.md` is
  missing: write its hand-back to that path yourself before going on.
- These stop for the owner too, though CLAUDE.md, The stops has no row for
  them: the range assertion or an empty file list (Review loop step 2);
  `git branch --show-current` not printing the run's branch; a verifier
  that still misses a raw finding after its second dispatch, or a review
  that reads the wrong diff twice (step 4); a second red gate, or a dirty
  tree, after a fixer inside a round (step 7); an out-of-round fix whose
  re-review leaves something open.
- A usage limit: stop. The state file holds the run;
  `make pipeline T="$ARGUMENTS"` resumes it.
- Judge a stage by its output on disk, in git and on GitHub, never by a
  task's status, which can lag.

## State file template

```
# Pipeline state: <keys>
- Keys:
- Last finished stage: none | triage | spec | plan | red team | implementation | review 0 | fix 1 | review 1 | fix 2 | review 2 | fix 3 | review 3 | take-out | loop done | gate fix | PR opened | CI fix | handed over | reopened fix | ended at the cap
- Handed over: <UTC time>
- Reopened from: <report path>
- Branch:
- Small fix: <key>: yes/no, because (one line per key)
- Spec: <path> @ <commit>
- Lead's calls: <question>: <choice> (<source>)
- Plan: <path>
- Red team: round <r>: <verdict>, C<n> I<n> M<n>; fixed <n>, ruled <n> (U<n>, ...); lead's rulings: <finding>: <ruling> (<source>)
- Implementer report: <state dir>/implementer-report.md; make check exit <code>
- Review base: <sha>
- Review <k>: <from>...<to>; introduced <n>, on-path <n>, spec <n>, unrelated <n>, not a bug <n>; rule 1-3 <n>; scope <m> outside; report <path>
- Unrelated: <finding>: <ticket>, commented | raised
- Fix <id>: before=<sha>; started | after=<sha>; lint exit <code>, test exit <code>; report <path>; re-review <path>
- PR: #<n>; CI <result>
- Owner answers:
  - <UTC time>: <stop>: <answer verbatim>
```
