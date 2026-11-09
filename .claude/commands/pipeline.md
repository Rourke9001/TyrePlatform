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
   - This job's file at `handed over`: stop. Close-out takes it from the
     merge, and a finding on its open PR is fixed outside the run
     (Hand-over step 5). To run these keys again for a second PR, the owner
     first deletes or renames that state directory and deletes that PR's
     branch (step 6).
   - This job's file at `ended at the cap`: stop. It never blocks a job that
     shares no key with it, but these keys launch again only once its state
     directory is deleted and its branch deleted or renamed (step 6); say so.
   - This job's file at any other stage: this is a resume (step 5).
   - None for this job: this is a fresh run.
4. Run `git status --porcelain`.
   - Fresh run: if it prints anything, stop and show it. The checkout is
     shared, and a dirty tree is usually another session's work.
   - Resume: if it prints anything, show it as possibly this run's own
     unfinished work and stop for the owner to say keep or discard.
5. Resume only: check each fact that the recorded stage implies against
   reality: the branch exists
   (`git rev-parse --verify <branch>`), the spec commit is on it, the plan
   file exists, and, from stage `PR opened` on, the PR is open
   (`gh pr view <n> --json state`). If any fact disagrees, stop and report
   the mismatch; never guess. If all agree, `git checkout <branch>`; a
   resume then restarts at the stage after the last finished one, with new
   teammates, and in the loop never starts again at review 0. The
   `Fix <id>:` lines place a resume inside the loop, for every round id. A
   line with `started` and no `after` is an open round: HEAD must descend
   from its `before` (`git merge-base --is-ancestor <before> HEAD`), or it
   is a mismatch; then run Close a round `<id>` on it. A closed line whose
   `after` differs from `before` and that has no `Review <id>:` line
   resumes at Re-review `<id>` (Review loop step 8); any other closed line
   resumes at step 6. At stage `loop done`, go to Hand-over. At
   `PR opened` or `CI fix`, once any open round is closed: if
   `git rev-list origin/<branch>..HEAD` is non-empty, run
   `git push -u origin <branch>`; then wait for CI on HEAD as in Hand-over
   step 4, and hand over as in Hand-over step 5 once `CI <result>` is
   recorded for that head.
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
UTC time, and with the ID of the finding it rules on, if any. A question a teammate's skill says to stop and ask is the row "A
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
make the small-fix call by CLAUDE.md's definition. Small-fix keys, one or
more, are a bundle, and so is any launch of more than one key; one key that
is not a small fix is a large ticket. Make every call before you touch Jira
or git. Differences from `/ticket`:

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
For a bundle, once it reports, ask `planner` to shut down and wait for its
confirmation.

## Red team. Skipped for a small fix.

For round r = 1, 2, 3:

1. Dispatch the `plan-red-team` agent as an ordinary subagent of yours,
   without a name, so its findings come back to you as its result: the path
   ADR-0023's lead spike proved, and the one `/ticket` uses. Give it the
   spec path, the plan path and `<keys>`, as `/ticket` does. From round 2
   on, add every earlier Critical and Important finding, each marked fixed
   (with what changed), ruled (with the owner ruling's U-number) or
   "lead's ruling (<source>)". A ruled finding is not a finding again
   unless the agent shows the ruling itself is wrong.
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
is not ready: tell it so and wait. A bug it sends up goes into review 0's
findings file (Review loop step 3), so the verifier verifies and classes it
before Review loop step 5 acts on it. Put each finding that is not a bug
through CLAUDE.md's schedule test: a ticket linked to its key for one that
passes, the PR's "Set aside" list for the rest (U130). Then ask
`implementer` to shut down, and wait for its confirmation before the review
loop, so two writers are never in the checkout together.

## Review loop (you)

It runs on the local branch before the push, so the PR opens already
reviewed (CLAUDE.md, The review loop, U192). A round's `<id>` is `1`, `2`,
`3`, `gate`, `ci` or `owner-<n>`, and review 0's is `0`. Its files in
`<state dir>`, one per dispatch, are an input file (`fix-<id>-input.md`
for a numbered round; `owner-fix-<n>.md`, `gate-fix.md` or `ci-fix.md` for
a round outside the two), `fixer-<id>-report.md`, a gate fixer's
`fix-<id>-gate-input.md` and `fixer-<id>-gate-report.md`,
`findings-<id>.md` and `review-<id>.md`. Its state line is `Fix <id>:`.
The classes
are CLAUDE.md's, Which bugs a branch fixes (U191); the flags `rule 1-3`
and `spec` are defined in `/review-pr` step 5. Run the gate,
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
   stop. Once the branch is on origin (for example a `ci` round), run
   `git branch --set-upstream-to=origin/<branch>` after the review, and
   every push is `git push -u origin <branch>`, never a bare `git push`,
   which would follow an upstream that may be the local
   `pipeline-review-base`.
3. **Review `<k>`.** Run `/code-review high` with no target, and each of
   `rls-auditor`, `append-only-auditor` and `valuation-verifier` whose
   trigger the range's file list meets, each unnamed and each given the
   range and that file list. `/code-review` returns as a background fork:
   wait for its result. Save the raw output of each to
   `<state dir>/findings-<k>.md`, and for review 0 add to it each bug the
   implementer sent up. Then dispatch one fresh unnamed
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
   Critical or Important item in `findings-<k>.md`, and every item an
   auditor or the implementer gave, must appear in the report as kept, or
   as dropped with a reason; if one is missing, dispatch the verifier again
   once. Compare the files the report cites with the range's file list yourself. If a review cites nothing inside the range while the list is not empty and the raw findings are not empty, it read the wrong diff: set the range again and run the review once more. A verified finding that arrives from outside the range is classified like any other and does not widen the next review.
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
   `Fix owner-<n>: before=<HEAD>; started`, and run it as a round outside
   the two (below).
6. **Judge** what is open across this loop's reports, input files and
   fixer reports, not only the last report. A finding a round's input file
   gave its fixers and that no commit of the round fixes is still open. A
   finding the owner ruled on is closed, unless it is `introduced`
   (CLAUDE.md, Which bugs a branch fixes). Nothing open that the fixer owns
   (`introduced`, `on-path`, or `spec` at Critical or Important): record
   stage `loop done` and leave the loop. Something open after review 0 is
   fix round 1, and after round 1 has closed, fix round 2. After round 2
   or round 3 has closed, by any row of Close a round, it is the cap
   (step 9, U196).
7. **Fix round `<k>`** (1, 2, or 3 when the owner chooses it at the cap):
   record `Fix <k>: before=<HEAD>; started`. Write
   `<state dir>/fix-<k>-input.md` holding every finding step 6 holds open,
   each copied with its `Class:` line and, under it, each owner answer
   recorded for it, verbatim with its time. Dispatch a fresh unnamed
   general-purpose subagent with no `model` override and the fixer brief
   below, that file being its `<report path>`. Then Close a round `<k>`.
8. **Re-review `<k>`** over `<before>...<after>` as in steps 2 to 5, when
   Close a round sends it here; then step 6.
9. **The cap:** run `/design-audit <mechanism>` (report only) on the
   mechanism the open findings sit in, passing this loop's review report
   paths, then STOP (The cap). Show what is open and the audit report path.
   The options: one more fix round (round 3 after round 2; the next
   `owner-<n>` round after a round outside the two, its `owner-fix-<n>.md`
   holding the open findings as step 7's input file does; after round 3,
   the same options minus this one), a different design, or end the run.
   Either of the last two is End the run. A different design is not built
   in this run; the ticket goes back through its spec. An `introduced` bug
   is never ticketed.

**End the run**, for a large ticket or a bundle: comment the stop or the
owner's choice, what is open and any audit report path on each key, record
`ended at the cap`, and leave the branch. If a PR is open, comment the same
on it and name it to the owner. For a bundle, tell the owner the other keys
can be relaunched as a new job once this run's state directory is deleted
and its branch deleted or renamed.

**A round outside the two** (`owner-<n>`, `gate`, `ci`): record its
`Fix <id>: before=<HEAD>; started` line if it is not there yet, dispatch
one fresh fixer as in step 7 with that round's input file, then Close a
round `<id>`. Its judge (step 6) reads only its own input file, fixer
reports and re-review. Nothing open: go on from the step that started the
round. Anything open: the cap (step 9). Once the PR is open, add the
round's Decisions lines and report paths to `pr-body.md` and run
`gh pr edit <n> --body-file <state dir>/pr-body.md`.

### Close a round `<id>`

Every round runs this once its fixer replies, and a resume runs it on an
open `Fix <id>:` line. Save each reply verbatim: the first fixer's to
`fixer-<id>-report.md`, a gate fixer's (row F) to
`fixer-<id>-gate-report.md`. The reply judged is the latest dispatch's: the
gate fixer's when `fix-<id>-gate-input.md` exists, else the first fixer's.
On a resume, a missing report file is no reply. Take the first row that
matches; each ends in one action.

| Row | The lead finds                                                                                     | Next                                                                                                                                                                                                                                                                                                                                       |
| --- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A   | No reply, no `STATUS:` line, or `STATUS: stopped` for a reason rows B and C do not name            | Dispatch that fixer again, once, with the same input file and `git log <before>..HEAD`, and close the round again. A second time is The run cannot go on.                                                                                                                                                                                  |
| B   | `STATUS: stopped`: a fix would break the small-fix definition                                      | Stop (Not a small fix). Once the owner is told, End the run, whatever answer is recorded.                                                                                                                                                                                                                                                  |
| C   | `STATUS: stopped`: a fix would contradict the spec                                                 | Stop (Live step or decision) on that finding, unless an answer for it is already recorded. Record the answer under the finding's ID; the next input file carries it (step 7). Then go on from row D.                                                                                                                                       |
| D   | `git status --porcelain` prints anything                                                           | Stop (The run cannot go on) for the owner's keep-or-discard call. The owner commits or discards the edits; once the tree is clean, close the round again from row D.                                                                                                                                                                        |
| E   | `git rev-list <before>..HEAD` prints nothing                                                       | Close with `after=<before>`, re-review `none`, and go to step 6. An empty range has nothing to re-review (U196).                                                                                                                                                                                                                            |
| F   | The gate (Review loop, above), run now, is red                                                     | In round 1, 2, 3 or `owner-<n>` with no `fix-<id>-gate-input.md` yet: write it, holding the gate's output as one finding marked `on-path (red gate, <UTC time>)`, dispatch one fresh fixer with it and `git log <before>..HEAD`, and close the round again. Otherwise it is a second red (a `gate` or `ci` round's first red is its second): stop (Red gate), and do what the owner answers. |
| G   | The gate is green                                                                                  | Close with `after=<HEAD>` and both exit codes, and go to Re-review `<id>` (step 8).                                                                                                                                                                                                                                                         |

Closing (rows E and G) fills the same fields on every `Fix <id>:` line:
`after`, the lint and test exit codes (`n/a` in row E), the fixer report
paths and the re-review path or `none`; and the stage: `fix <k>` for a
numbered round, `gate fix` for `gate`, and for `ci` stage `CI fix` after
its push (Hand-over step 4). Every fixer gets the brief below; a fixer
dispatched again (row A) or a gate fixer (row F) also gets
`git log <before>..HEAD` as the commits this round already holds. The
round keeps its recorded `before` throughout, so every fixer commit stays
inside its re-review range.

### The fixer brief

Give each fixer this brief verbatim, its placeholders filled:

> You fix review findings for <keys> on branch `<branch>`, in place, in this checkout. The job is <a large ticket, spec `<spec path>` | a small-fix bundle>. The report is `<report path>`; read it yourself, it is the brief. Fix every finding it marks `introduced` or `on-path`, and every Critical or Important finding it flags `spec`, and nothing else. An owner answer under a finding is the owner's ruling on it: follow it. For each: write a regression test that fails first, then the fix. Then probe your fix on inputs the report does not list, the NULL or empty case included, and say which you tried. One commit per finding, naming its key. Never amend, rebase or revert a commit you did not author. Do not dispatch subagents. Do not push. Business rules go in SQL with a test in `db/tests/`; transport and auth go in Go (CLAUDE.md). Run `make fmt lint`, then `VITEST_MAX_WORKERS=4 make test`, each in the foreground, unpiped, with the Bash timeout up to 600000 ms, and read each exit code; the tests reset the local database, which is expected. If the formatter changed files, commit them, and end with an empty `git status --porcelain`. If the job is a small-fix bundle and a fix would break CLAUDE.md's small-fix definition, or if a fix would contradict the spec, stop and report that instead of fixing. Report: each finding with its commit, its test, the probes you ran, both exit codes, and one Decisions line per fix for the PR body. End your reply with one line: `STATUS: done` or `STATUS: stopped, <why>`.

## Hand-over (you)

1. Run the gate (Review loop) yourself on every run, loop or no loop.
   Non-zero: a gate fix (round `gate`, stage `gate fix`). Write
   `<state dir>/gate-fix.md` with each failing command, its exit code and
   its output, each as one finding marked
   `on-path (red gate, <UTC time>)`, and run it as a round outside the two
   (Review loop), that file being its input file.
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
   red run is the CI fix (round `ci`): save the failing job's log with
   `gh run view <id> -R Rourke9001/TyrePlatform --log-failed > <state dir>/ci-<id>.log 2>&1`,
   write `<state dir>/ci-fix.md` naming that path as one finding
   marked `on-path (red CI, <UTC time>)`, run it as a round outside the
   two (Review loop), push, record stage `CI fix` after that push, and
   wait again. A second
   red, or a red after the job's `ci` round is spent, is a stop (Red gate).
   Record `CI <result> @ <head sha>` on the `PR:` line.
5. Move every key to In Review, comment the PR link on each, delete
   `pipeline-review-base` (`git branch -D pipeline-review-base`), set
   stage `handed over`, and tell the owner: the PR, the rounds, what was
   fixed, the tickets touched, and the lead's calls. The owner merges, and
   close-out runs by itself from the merge. `/review-pr <n>` in a separate
   session and `/code-review ultra` are optional; a finding from either is
   fixed outside the run, as on the manual path (`/ticket` step 12). Until
   that PR merges or closes, a new `make pipeline` for another job stops,
   because a late fix round works in this checkout.

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
- These stop for the owner under the row "The run cannot go on": the
  range assertion or an empty file list (Review loop step 2);
  `git branch --show-current` not printing the run's branch; a verifier
  that still misses a raw finding after its second dispatch, or a review
  that reads the wrong diff twice (step 4); a dirty tree after a fixer
  (Close a round, row D); a finder, verifier or fixer that returns nothing
  twice (above, and row A). A second red gate is the row "Red gate"
  (row F), and a round outside the two that leaves something open is "The
  cap".
- A usage limit: stop. The state file holds the run;
  `make pipeline T="$ARGUMENTS"` resumes it.
- Judge a stage by its output on disk, in git and on GitHub, never by a
  task's status, which can lag.

## State file template

```
# Pipeline state: <keys>
- Keys:
- Last finished stage: none | triage | spec | plan | red team | implementation | review 0 | fix 1 | review 1 | fix 2 | review 2 | fix 3 | review 3 | loop done | gate fix | PR opened | CI fix | handed over | ended at the cap
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
- Fix <id>: before=<sha>; started | after=<sha>; lint exit <code | n/a>, test exit <code | n/a>; reports <path>[, <gate report path>]; re-review <path | none>
- PR: #<n>; CI <result> @ <head sha>
- Owner answers:
  - <UTC time>: <stop>[, <finding ID>]: <answer verbatim>
```
