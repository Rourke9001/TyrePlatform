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
   this playbook's messaging and waiting are not written for. Then run
   `make guard-check` in the foreground; a non-zero exit stops the run, and
   the owner gets its output, each FAIL line naming the runbook step that
   fixes it (`docs/runbooks/github-access.md`, TYRE-473).
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
     first deletes that state directory, or moves it out of
     `.superpowers/sdd/`, and deletes that PR's branch (step 6).
   - This job's file at `ended at the cap`: stop. It never blocks a job that
     shares no key with it, but these keys launch again only once its state
     directory is deleted, or moved out of `.superpowers/sdd/`, and its
     branch deleted, or renamed to a name without the key (step 6); say so.
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
   teammates (an implementer on the model its `Implementer model:` line
   records), and in the loop never starts again at review 0. The last
   `Fix <id>:` line in the file places a resume inside the loop, whatever
   its round id. If it has `started` and no `after`, it is an open round:
   HEAD must descend from its `before`
   (`git merge-base --is-ancestor <before> HEAD`), or it is a mismatch;
   then run Close a round `<id>` on it. If it is closed, its `after`
   differs from `before` and it has no `Review <id>:` line, resume at
   Re-review `<id>` (Review loop step 8). Otherwise resume at step 6, which
   for a `Fix owner-<n>:`, `Fix gate:` or `Fix ci:` line is that round's
   own judge (A round outside the two). At stage `loop done`, go to
   Hand-over. At
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
(ADR-0023). Every auditor, verifier and fixer is your own unnamed subagent
instead, and the code review is a process you start (Review loop step 3), so
each result reaches you. How to wait for a teammate's message, and how to
shut a teammate down, are the two subsections below.

### Shutting a teammate down

Every shutdown in this playbook runs these steps. Never end your turn to
wait for the approval: a teammate's message reaches you only after your
turn ends, and can come long after (docs/lessons.md, 2026-11-11, shutdown
approval). Record the approval if it arrives; never wait for it.

1. Record under `Waits:` in the state file what the teammate leaves.
   Take the one case that fits, and keep it through step 5:
   - **`planner` that reported:** the plan file's path (for a bundle,
     `<state dir>/small-fix-plan.md`) and its time,
     `date -u -r <path> +%FT%T.%NZ`, or `absent`;
   - **`implementer` that reported ready:** `git rev-parse HEAD`, and
     `git status --porcelain`, which prints nothing once it is ready
     (Implementation);
   - **a teammate that failed, whichever it is** (When something fails):
     `git rev-parse HEAD`, and the `git status --porcelain` and
     `git diff HEAD --numstat` output as they stand, and for `planner` the
     plan file's time too.
2. If the listing already does not list the teammate, record `absent
   before the request` and go to step 5: a message to a name that has
   left can start it again. Otherwise send the shutdown request, and
   record its UTC time.
3. Up to six times: run `make pipeline-wait S=30` in the foreground, then
   read the team listing with `ListAgents`. Stop at the first read that
   does not list the teammate, and record its UTC time and its number.
4. **Shut down** means the teammate is absent from the listing and what
   step 1 recorded is unchanged. Neither alone is enough. The plan file is
   gitignored, so a clean tree says nothing about the planner, and the
   listing is a status, which can lag. This is evidence on the listing and
   the disk, not silence read as an answer (Teammates).
5. Once it has left, read step 1's record again, in step 1's case:
   - **`planner` that reported:** if the plan file's time changed, read
     the plan again before the next stage. That is not a stop.
   - **`implementer` that reported ready:** if HEAD moved or the tree is
     dirty, the checkout is not in the state the run recorded. Stop (The
     run cannot go on).
   - **a teammate that failed, whichever it is:** it may finish a tool
     call while it shuts down, and a command it started can outlive it
     (docs/lessons.md, 2026-10-01). Read what step 1 recorded, run
     `make pipeline-wait S=30`, and read it again, until two reads running
     match, six reads at most. The numstat is read because porcelain
     prints the same line for a file changed once or changed again. Spawn
     its replacement only then. No match after six reads: stop (The run
     cannot go on). Some writes are not seen: a command that writes
     nothing to the tree, such as an orphaned gate, a rewrite of an
     untracked file, and a second edit that leaves a file's line counts
     the same. That is an accepted risk, and the replacement's spawn
     prompt says a gate may still be running (When something fails).
6. Still listed after the sixth read: stop it with `TaskStop`, giving its
   name, run `make pipeline-wait S=30` once more, and read the listing.
   Gone: step 5 applies. Still listed: stop (The run cannot go on). A
   teammate that had reported loses nothing, since its report is in hand,
   and one that failed is being replaced anyway.

### Waiting for a teammate's message

Wherever you end your turn for a teammate's message, a timer wakes you.
That is the planner's plan and its replies to red-team findings and
rulings, the implementer's "ready for review" and its answer after a "not
ready", and a report you have asked for again. A teammate's message reaches
you only after your turn ends, and an idle lead can be left unwoken
(docs/lessons.md, 2026-11-11, shutdown approval).

1. Before you end the turn, record a baseline under `Waits:`: the UTC
   time and five values. They are the plan file's
   `date -u -r <path> +%FT%T.%NZ` (for a bundle,
   `<state dir>/small-fix-plan.md`), `git rev-parse HEAD`,
   `git status --porcelain`, `git diff HEAD --numstat`, and the
   `date -u -r` time of the executing-plans ledger. The ledger is the
   `progress.md` under `.superpowers/sdd/` whose first line names the
   plan; `rg -l --no-ignore -F <plan file name> .superpowers/sdd -g progress.md`
   lists the candidates (`.superpowers/` is gitignored, so `rg` without
   `--no-ignore` skips it). On this host `rg` prints the path with
   backslashes, which Git Bash drops from an unquoted argument, so give
   `date -u -r` the path with forward slashes and in double quotes. Either
   time is `absent` when its file is; a "No such file" for a path `rg` has
   just listed is a typing error to fix, not `absent`. Then,
   unless a timer is already running, start `make pipeline-wait S=300` as
   a background Bash call, record its task id, and end the turn. Run one
   timer at a time.
2. Woken by the message the stage waits for: stop the timer with
   `TaskStop` and its task id, and go on. Woken by anything else, such as
   an idle notice or another teammate's message: deal with it, and end the
   turn again on the same timer. Never end a turn in this wait without a
   running timer: if the timer's exit has surfaced while you dealt with
   something, take step 3 before ending the turn.
3. Woken by the timer's exit without that message: read the listing with
   `ListAgents` and the five values step 1 records. Record the UTC time,
   the listing's word for the teammate (`running`, `idle` or absent) and
   what moved. A value moved when it differs from the last record; a
   ledger that appears or disappears has moved. A wake where nothing moved
   is quiet. Take the first case that fits:
   - **Not listed, and no report:** it stopped early (When something
     fails).
   - **Something moved, or this is the first quiet wake in a row:** start
     the timer again and end the turn. A message can still be in transit
     at a timer's wake, so the first quiet wake never asks or fails a
     teammate.
   - **Listed `running`:** start the timer again and end the turn. A busy
     teammate is never asked and never failed on silence, since a gate or
     a long read can run many minutes with nothing written. The one
     ceiling: twelve quiet wakes in a row while it is listed `running` (60
     minutes) is a hung teammate, and it has failed (When something
     fails).
   - **Listed `idle`, not yet asked in this wait:** its turn has ended
     without the report. Ask it once for the report, start the timer again
     and end the turn.
   - **Listed `idle`, already asked in this wait:** it has failed (When
     something fails).
4. A lost timer is an accepted risk. A background command's exit has
   woken an idle lead in every run so far (Review loop step 3), but
   nothing documents it, and anthropics/claude-code issue 92563 reports it
   failing. Each wake is recorded, so a gap well over 300 seconds between
   two `Waits:` records is a missed wake. One such gap in a real run
   reopens the design that spec rejected
   (`docs/superpowers/specs/2026-11-11-bounded-lead-waits-design.md`,
   Rejected).
5. At an owner stop, stop any running timer with `TaskStop`, start none,
   and wait for the owner.
6. A resume (Before anything, step 5) starts every wait afresh. A timer
   id, a wake count or an ask that an earlier session recorded under
   `Waits:` is history: that session's timer is not running, and its
   teammates are gone.

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
their text. Run the skill's builder check as an unnamed subagent with
`model: "opus"` and its `builder-check-prompt.md`. Settle what a builder could settle, as a lead's
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

Spawn a teammate named `planner` (general-purpose, model `opus`: it reads
the code the plan touches, and a gap it leaves costs a fix round) with:

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
Wait for its report (Waiting for a teammate's message). For a bundle, once
it reports, shut `planner` down (Shutting a teammate down).

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
3. Send every Critical and Important finding to `planner`, and wait for its
   reply (Waiting for a teammate's message). Sort each one
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
applied (Waiting for a teammate's message; when its last report already
covers everything sent to it, that report is in hand and no timer starts),
then shut it down (Shutting a teammate down). Comment on
the ticket: the final verdict, and the counts fixed and ruled.

## Implementation (implementer)

Choose the implementer's model before the spawn. It is `sonnet`, since it
follows a red-teamed plan and the review loop reviews the result, unless the
plan's file list (for a bundle, `<state dir>/small-fix-plan.md`) meets the
trigger of `rls-auditor`, `append-only-auditor` or `valuation-verifier`,
judged from each agent's description as Review loop step 3 judges a diff.
Then it is `opus`. Record the choice in the state file before the spawn, as
`Implementer model: <sonnet | opus>, because <the files that met a trigger |
no trigger met>`. A respawn or a resume that finds that line spawns on its
model and does not judge again.

Spawn a teammate named `implementer` (general-purpose, on the model the
`Implementer model:` line records) with:

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
> reaches finishing-a-development-branch, do not present its menu: end with
> an empty `git status --porcelain`, send the lead "ready for review
> <branch>" with the `make check` exit code, then stop; do not push or open
> a PR.

Wait for its report (Waiting for a teammate's message). When the
implementer reports, write its report verbatim to
`<state dir>/implementer-report.md` before anything else: the skill deletes
its own ledger when it finishes. "Ready" with a non-zero `make check` exit,
or with anything in `git status --porcelain`, is not ready: tell it so and
wait. A bug it sends up goes into review 0's
findings file (Review loop step 3), so the verifier verifies and classes it
before Review loop step 5 acts on it. Put each finding that is not a bug
through CLAUDE.md's schedule test: a ticket linked to its key for one that
passes, the PR's "Set aside" list for the rest (U130). Then shut
`implementer` down (Shutting a teammate down) before the review loop, so
two writers are never in the checkout together.

## Review loop (you)

It runs on the local branch before the push, so the PR opens already
reviewed (CLAUDE.md, The review loop, U192). A round's `<id>` is `1`, `2`,
`3`, `gate`, `ci` or `owner-<n>`, and review 0's is `0`. Its files in
`<state dir>`, one per dispatch, are an input file (`fix-<id>-input.md`
for a numbered round; `owner-fix-<n>.md`, `gate-fix.md` or `ci-fix.md` for
a round outside the two), `fixer-<id>-report.md`, a gate fixer's
`fix-<id>-gate-input.md` and `fixer-<id>-gate-report.md`, a row A retry's
`fixer-<id>-retry-report.md` or `fixer-<id>-gate-retry-report.md`,
`findings-<id>.md`, `review-<id>.md`, `code-review-<id>.json` (the review
script's stdout), `code-review-<id>.err` (its stderr), `code-review-<id>.md`
(the review's result, written only when it passed its checks), their
copies `code-review-<id>-first.json`, `-first.err` and `-first.md` (the
first attempt that returned nothing, kept before step 3 runs the script
again) and
`auditor-<id>-<agent>.md` (one auditor's raw output, `<agent>` being
`rls-auditor`, `append-only-auditor` or `valuation-verifier`). Its state
line is `Fix <id>:`.
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
3. **Review `<k>`.** Start the code review as a background Bash call, in
   exactly the form the allow rule in `.claude/settings.json` matches, with
   no `cd`, variable or wrapper in front:
   `bash scripts/pipeline-review.sh <state dir> <k>`. It runs
   `/code-review high` with no target in its own Opus process (ADR-0023,
   amended 10 Nov 2026). Dispatch each of `rls-auditor`,
   `append-only-auditor` and `valuation-verifier` whose trigger the range's
   file list meets, each unnamed and each given the range and that file
   list. The auditors return long before the script, so save each one's raw
   output on arrival to `<state dir>/auditor-<k>-<agent>.md`. Wait to be
   woken when the script exits. Gate on its exit code and its last line,
   never on a file existing. A review is exit 0, a last line `REVIEW: ok`
   and, when that line ends `findings 0`, a reply that reviewed. At
   `findings 0`, and only once the line passes, read
   `<state dir>/code-review-<k>.md` yourself before anything else below,
   because the script passes an empty array whatever the prose around it
   says (TYRE-477). An empty array is a clean review unless that prose asks
   a question, says the review could not or did not run, or stops short (it
   ends mid-sentence or names files it did not read). Anything that is not
   a review is a finder that returned nothing, so run the script once more.
   A review id gets one such rerun, whichever way it returned nothing, and
   a wrong-diff rerun (step 4) does not spend it. Before the rerun, copy
   each of `code-review-<k>.json`, `.err` and `.md` that exists to
   `code-review-<k>-first.json`, `-first.err` and `-first.md`, since the
   rerun deletes or overwrites all three. A second finder that returned
   nothing for the same id stops for the owner (The run cannot go on) with
   both `REVIEW:` lines and the `-first` files. Once the reply is a review,
   build `<state dir>/findings-<k>.md`: copy the result with
   `cp "<state dir>/code-review-<k>.md" "<state dir>/findings-<k>.md"`, so
   the verifier reads the review's findings byte for byte, then append each
   `auditor-<k>-<agent>.md`, and for review 0 each bug the implementer sent
   up. Then dispatch one fresh unnamed general-purpose subagent, the
   verifier, with `model: "opus"`:

   > You verify review findings for <keys>; you fix nothing. Follow
   > `.claude/commands/review-pr.md` steps 1, 4 and 5 in their verifier
   > form. Spec: `<spec path>`; plan: `<plan path>` (a bundle has only
   > `<state dir>/small-fix-plan.md`). `Review base: <base sha>`. Range:
   > `<from>...<HEAD sha>`; its files: <file list>. Raw findings:
   > `<state dir>/findings-<k>.md`. The code review's own count is <n,
   > from its `REVIEW: ok` line>; at 0 the lead has read its whole reply
   > as a clean review (Review loop step 3), so say that after the report's
   > first line. Previous report: `<path>`, or none.
   > Owner answers so far: <from the state file>. Account for every raw
   > item, whatever its severity: kept with its severity and class, dropped
   > with why, or set aside with why; step 5's limit of five Minors does not
   > apply to you. Write the report to
   > `<state dir>/review-<k>.md`; if the write fails, reply with the whole
   > report. End your reply with one line:
   > `VERDICT: <merge | merge after fixes | do not merge>`.

   `Review base` is the merge base, which decides `introduced`; it is not
   the range's start. Serialise anything that resets or loads the
   database, since every agent here shares one local database. Step 3
   writes no `Review <k>:` line: a resume reads that line as a finished
   review (Before anything, step 5), so it is written only in step 4, after
   the verifier.
4. **Read `review-<k>.md` yourself.** You decide on its text, never on a
   count the verifier reports; take the counts from its class words. Every
   item in `findings-<k>.md`, whatever its severity and whoever gave it
   (`/code-review`, an auditor or the implementer), must appear in the
   report as kept with its severity and class, as dropped with a reason,
   or as set aside with a reason: `/code-review` gives no severity, so the
   verifier assigns it. Count the raw items against the report's entries;
   if one is missing, dispatch the verifier again once. Compare the files the report cites with the range's file list yourself. If a review cites nothing inside the range while the list is not empty and the raw findings are not empty, it read the wrong diff: set the range again and run step 3 again from the script: the script, the read at `findings 0`, the copy, the auditors' saved files and a fresh verifier. A code review at `findings 0` cites nothing, so this check cannot judge it, and your read of its reply in step 3 stands in. A verified finding that arrives from outside the range is classified like any other and does not widen the next review.
   Record the `Review <k>:` line, with the code review's model keys and
   finding count from the `REVIEW: ok` line, or, if that line has left your
   context, from `<state dir>/code-review-<k>.json` (its `modelUsage` keys)
   and `<state dir>/code-review-<k>.md` (the length of its fenced array),
   and, for a numbered review, stage `review <k>`.
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
   gave its fixers and that no commit of the round fixes is still open. An
   owner answer closes a finding only as CLAUDE.md's meaning of open allows
   (Which bugs a branch fixes): one that orders or shapes a fix does not.
   Nothing open that the fixer owns
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
   general-purpose subagent with `model: "opus"` and the fixer brief
   below, that file being its `<report path>`. Then Close a round `<k>`.
8. **Re-review `<k>`** over `<before>...<after>` as in steps 2 to 5, when
   Close a round sends it here; then step 6.
9. **The cap:** run `/design-audit <mechanism>` (report only) on the
   mechanism the open findings sit in, passing this loop's review report
   paths, then STOP (The cap). Show what is open and the audit report path.
   The options: one more fix round (round 3 after round 2; the next
   `owner-<n>` round after a round outside the two, its `owner-fix-<n>.md`
   holding the open findings as step 7's input file does; after round 3,
   the same options minus this one), a different design, end the run, or
   accept each open Minor that is not against rules 1 to 3 (CLAUDE.md,
   Which bugs a branch fixes, U198). A different design or end the run is
   End the run. A different design is not built in this run; the ticket
   goes back through its spec. On accept, comment the findings and the
   owner's answer on each key and record them closed under the owner's
   answers as accepted (U198). With nothing else open, go to step 6;
   otherwise the owner chooses among the other options for the rest.
   Hand-over step 2 puts the accepted findings in Decisions; once the PR
   is open, add them to `pr-body.md` and run
   `gh pr edit <n> --body-file <state dir>/pr-body.md`. An `introduced`
   bug is never ticketed.

**End the run**, for a large ticket or a bundle: comment the stop or the
owner's choice, what is open and any audit report path on each key, record
`ended at the cap`, and leave the branch. If a PR is open, comment the same
on it and name it to the owner. For a bundle, tell the owner the other keys
can be relaunched as a new job once this run's state directory is deleted,
or moved out of `.superpowers/sdd/`, and its branch deleted, or renamed to
a name without the key.

**A round outside the two** (`owner-<n>`, `gate`, `ci`): record its
`Fix <id>: before=<HEAD>; started` line if it is not there yet, dispatch
one fresh fixer as in step 7 with that round's input file, then Close a
round `<id>`. Its judge (step 6) reads only its own input file, fixer
reports and re-review, and step 6's stage and next-round sentences do not
apply to it. Nothing open: go on from the step that started the round. Anything open: the cap (step 9). Once the PR is open, add the
round's Decisions lines and report paths to `pr-body.md` and run
`gh pr edit <n> --body-file <state dir>/pr-body.md`.

### Close a round `<id>`

Every round runs this once its fixer replies, and a resume runs it on an
open `Fix <id>:` line. Save each reply verbatim: the first fixer's to
`fixer-<id>-report.md`, a gate fixer's (row F) to
`fixer-<id>-gate-report.md`, and a row A retry of either to
`fixer-<id>-retry-report.md` or `fixer-<id>-gate-retry-report.md`. The
reply judged is the latest dispatch's: the gate fixer's when
`fix-<id>-gate-input.md` exists, else the first fixer's, and its retry's
when that retry file exists. A missing report file, or a retry file that
holds only its `dispatched` line, is no reply. Take the first row that
matches; each ends in one action.

| Row | The lead finds                                                                                                           | Next                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | No reply, no `STATUS:` line, or `STATUS: stopped` for a reason rows B and C do not name                                  | If the judged reply is already a retry's, stop (The run cannot go on). Otherwise write that fixer's retry file holding `dispatched <UTC time>`, which records the retry, dispatch it again with the same input file and `git log <before>..HEAD`, save its reply over that line, and close the round again.                                                                                  |
| B   | `STATUS: stopped`: a fix would break the small-fix definition                                                            | Stop (Not a small fix). Once the owner is told, End the run, whatever answer is recorded.                                                                                                                                                                                                                                                                                                    |
| C   | `STATUS: stopped`: a fix would contradict the spec, or needs a live environment step or a decision the fixer cannot make | Stop (Live step or decision) on that finding, unless an answer for it is already recorded. Record the answer under the finding's ID. An answer that orders or shapes a fix keeps the finding open, so the next input file carries it with the answer (step 7); one that leaves the finding as it is closes it (step 6). Then go on from row D.                                               |
| D   | `git status --porcelain` prints anything                                                                                 | Stop (The run cannot go on) for the owner's keep-or-discard call. The owner commits or discards the edits; once the tree is clean, close the round again from row D.                                                                                                                                                                                                                         |
| E   | `git rev-list <before>..HEAD` prints nothing                                                                             | Close with `after=<before>`, re-review `none`, and go to step 6. An empty range has nothing to re-review (U196).                                                                                                                                                                                                                                                                             |
| F   | The gate (Review loop, above), run now, is red                                                                           | In round 1, 2, 3 or `owner-<n>` with no `fix-<id>-gate-input.md` yet: write it, holding the gate's output as one finding marked `on-path (red gate, <UTC time>)`, dispatch one fresh fixer with it and `git log <before>..HEAD`, and close the round again. Otherwise it is a second red (a `gate` or `ci` round's first red is its second): stop (Red gate), and do what the owner answers. |
| G   | The gate is green                                                                                                        | Close with `after=<HEAD>` and both exit codes, and go to Re-review `<id>` (step 8).                                                                                                                                                                                                                                                                                                          |

Closing (rows E and G) fills the same fields on every `Fix <id>:` line:
`after`, the lint and test exit codes (`n/a` in row E), the fixer report
paths and the re-review path or `none`; and the stage: `fix <k>` for a
numbered round, `gate fix` for `gate`, and for `ci` stage `CI fix` after
its push (Hand-over step 4). Every fixer, in every round, a row A retry and
a row F gate fixer included, is dispatched with `model: "opus"` and gets the
brief below; a fixer dispatched again (row A) or a gate fixer (row F) also gets
`git log <before>..HEAD` as the commits this round already holds. The
round keeps its recorded `before` throughout, so every fixer commit stays
inside its re-review range.

### The fixer brief

Give each fixer this brief verbatim, its placeholders filled:

> You fix review findings for <keys> on branch `<branch>`, in place, in this checkout. The job is <a large ticket, spec `<spec path>` | a small-fix bundle>. The report is `<report path>`; read it yourself, it is the brief. Fix every finding it marks `introduced` or `on-path`, and every Critical or Important finding it flags `spec`, and nothing else. An owner answer under a finding is the owner's ruling on it: follow it. For each: write a regression test that fails first, then the fix. Then probe your fix on inputs the report does not list, the NULL or empty case included, and say which you tried. One commit per finding, naming its key. Never amend, rebase or revert a commit you did not author. Do not dispatch subagents. Do not push. Business rules go in SQL with a test in `db/tests/`; transport and auth go in Go (CLAUDE.md). Run `make fmt lint`, then `VITEST_MAX_WORKERS=4 make test`, each in the foreground, unpiped, with the Bash timeout up to 600000 ms, and read each exit code; the tests reset the local database, which is expected. If the formatter changed files, commit them, and end with an empty `git status --porcelain`. If the job is a small-fix bundle and a fix would break CLAUDE.md's small-fix definition, or if a fix would contradict the spec, or needs a live environment step or a decision you cannot make, stop and report that instead of fixing. Report: each finding with its commit, its test, the probes you ran, both exit codes, and one Decisions line per fix for the PR body. End your reply with one line: `STATUS: done` or `STATUS: stopped, <why>`.

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
   Decisions lines, each finding the owner accepted at the cap (U198) and
   each `unrelated` bug with its ticket; "Set aside"
   with the deferred minors and the findings from the schedule test that
   are not bugs. An `introduced` or `on-path` bug never goes there (U191).
3. `git push -u origin <branch>`. Run `gh pr list --head <branch> --json number`
   and use an existing PR; otherwise
   `gh pr create --base develop --head <branch> --title "<type>(<scope>): <every key in full> <summary>" --body-file <state dir>/pr-body.md`.
   Record the PR number at once, and stage `PR opened`.
4. Wait for CI on the pushed head the way close-out waits
   (`.claude/commands/close-out.md`, step 2), never with
   `gh pr checks --watch` (docs/lessons.md, 2026-09-16). Record the push's
   UTC time under `Waits:` as `push <sha>`. The 60 minute clock below runs
   from it, or from a later `rerun` record for this head, or, on a resume
   with neither recorded for this head, from the resume; read it with
   `date -u` before each wait. Find the run:
   `gh run list -R Rourke9001/TyrePlatform --branch <branch> --commit <full head sha> --workflow CI --json databaseId,status,conclusion,url`.
   If it is not listed yet, run `make pipeline-wait S=30` and list again.
   Still not listed 60 minutes after the push: stop (The run cannot go
   on). Watch in the foreground, unpiped, Bash timeout 600000 ms:
   `timeout 540 gh run watch <id> -R Rourke9001/TyrePlatform --interval 30 > /dev/null 2>&1`,
   then read
   `gh api repos/Rourke9001/TyrePlatform/actions/runs/<id> --jq '.status, .conclusion, .run_attempt, .run_started_at'`,
   and repeat until `completed`. Past 60 minutes and still not
   `completed`: cancel it (`gh run cancel <id> -R Rourke9001/TyrePlatform`),
   record `cancel <id>`, and watch it at most twice. Still not `completed`
   after the second watch: stop (The run cannot go on). A run you
   cancelled is judged by the conclusion it ends with, like any other, so
   one that finished `success` before the cancel took is green. Sixty
   minutes is close-out's bound for the same wait, and three times the
   longest job timeout in `ci.yml`. Then read plain `gh pr checks <n>`
   once and require every row to be terminal.
   The run is red when it is `completed` with any conclusion but
   `success`. Read the attempt's jobs:
   `gh api repos/Rourke9001/TyrePlatform/actions/runs/<id>/attempts/<run_attempt>/jobs --jq '.jobs[] | [.name, .status, .conclusion, .started_at] | @tsv'`.
   A job is red when its conclusion is anything but `success` or
   `skipped`. A job that ended `cancelled` or `timed_out` touches no file
   in the diff, whatever the diff holds, and so does a red run with no red
   job when the run itself ended `cancelled` or `timed_out`. For a red
   run, take the first case that fits:
   - **The head the `ci` round pushed:** stop (Red gate), with no re-run,
     whatever its jobs ended (CLAUDE.md, The review loop: a second red
     stops for the owner).
   - **The one re-run is spent:** a `rerun` is recorded under `Waits:` for
     this head, and the run's `run_attempt` is above 1. Stop (Red gate).
     A recorded `rerun` with `run_attempt` still 1 did not happen, and is
     not spent.
   - **No red job's failure touches a file in the diff, and the run has a
     red job or itself ended `cancelled` or `timed_out`:** re-run it once.
     Run `gh run rerun <id> --failed -R Rourke9001/TyrePlatform`, and once
     it returns, record `rerun <id>` with the UTC time. Then check that it
     took, reading the run and its new attempt's jobs up to three times,
     each after `make pipeline-wait S=30`: `run_attempt` has risen, and in
     the new attempt each job that was red is not `completed`, or has a
     `started_at` later than the new attempt's `run_started_at`. Compare
     GitHub's times with each other, never with `date -u`. Every attempt
     lists every job, with the old result carried over for a job that did
     not run again, so a job being listed proves nothing. Taken: wait as
     above. Not taken by the third read: wait as above until the run is
     `completed`, run `gh run rerun <id> -R Rourke9001/TyrePlatform`, which
     re-runs every job, and check it the same way. Not taken either: stop
     (The run cannot go on).
   - **Any other red run** is the CI fix (round `ci`): save the failing
     job's log with
     `gh run view <id> -R Rourke9001/TyrePlatform --log-failed > <state dir>/ci-<id>.log 2>&1`,
     write `<state dir>/ci-fix.md` naming that path as one finding marked
     `on-path (red CI, <UTC time>)`, run it as a round outside the two
     (Review loop), push, record stage `CI fix` after that push, and wait
     again.

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

- A teammate goes idle without the report its stage needs: Waiting for a
  teammate's message says when to ask it once and when it has failed. It
  reads the stage's output first (git log, the executing-plans ledger under
  `.superpowers/sdd/`), since a reply can arrive late.
- A teammate errors, stops early, or has failed by Waiting for a teammate's
  message: shut it down (Shutting a teammate down), so two never work in
  this checkout at once, then spawn a new one from the state file once, on
  the model its spawn line names, or for the implementer the model its
  `Implementer model:` line records. End its spawn prompt with: "A gate the
  teammate before you started may still be running, so run a failing
  baseline once more before you stop and ask." If that fails too, stop and
  tell the owner.
- A finder, verifier or fixer that returns nothing, or whose hand-back
  does not end with its terminal line (`VERDICT:` for the verifier,
  `STATUS:` for a fixer, and exit 0 with a last line `REVIEW: ok` for the
  review script, whose reply at `findings 0` must also have reviewed, by
  Review loop step 3), is dispatched again once, on the same model, then
  the owner. Gate
  on that line, never on a file existing (docs/lessons.md, 2026-09-03 and
  2026-11-09). A verifier whose line is there but whose `review-<k>.md` is
  missing: write its hand-back to that path yourself before going on.
- These stop for the owner under the row "The run cannot go on": the
  range assertion or an empty file list (Review loop step 2);
  `git branch --show-current` not printing the run's branch; a verifier
  that still misses a raw finding after its second dispatch, or a review
  that reads the wrong diff twice (step 4); a dirty tree after a fixer
  (Close a round, row D); a finder (the review script included), verifier
  or fixer that returns nothing twice (above, and row A). Shutting a
  teammate down adds three: a teammate still listed after `TaskStop`, a
  failed teammate's checkout that has not settled in six reads, and an
  implementer whose HEAD moved or tree went dirty while it shut down. Hand-over
  step 4 adds three: no CI run listed for the pushed head 60 minutes after
  the push, a run you cancelled at 60 minutes still not `completed` after
  two watches, and a whole-run re-run that did not take. A second red gate is the row "Red gate"
  (row F), and a round outside the two that leaves something open is "The
  cap".
- A usage limit: stop. The state file holds the run;
  `make pipeline T="$ARGUMENTS"` resumes it.
- Judge a stage by its output on disk, in git and on GitHub, never by a
  task's status, which can lag. The team listing is read only where the two
  Teammates subsections say, and always beside what is on disk.

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
- Implementer model: <sonnet | opus>, because <the files that met a trigger | no trigger met>
- Implementer report: <state dir>/implementer-report.md; make check exit <code>
- Review base: <sha>
- Review <k>: <from>...<to>; code review <model keys>, <n> findings; introduced <n>, on-path <n>, spec <n>, unrelated <n>, not a bug <n>; rule 1-3 <n>; scope <m> outside; report <path>
- Unrelated: <finding>: <ticket>, commented | raised
- Fix <id>: before=<sha>; started | after=<sha>; lint exit <code | n/a>, test exit <code | n/a>; reports <path>[, <retry path>][, <gate report path>][, <gate retry path>]; re-review <path | none>
- PR: #<n>; CI <result> @ <head sha>
- Waits:
  - <UTC time>: <teammate | CI>: <baseline <values> | timer <task id> | wake: <running | idle | absent>, <moved <what> | quiet <n> in a row>[, asked] | shutdown request | absent before the request | gone at read <n> | TaskStop | settled at read <n> | push <sha> | rerun <run id> | cancel <run id>>
- Owner answers:
  - <UTC time>: <stop>[, <finding ID>]: <answer verbatim>
```
