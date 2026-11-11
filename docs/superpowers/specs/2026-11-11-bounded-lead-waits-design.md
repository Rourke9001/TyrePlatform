# Bounded waits: a pipeline lead never waits on something that cannot wake it

Date: 2026-11-11. Ticket: TYRE-478. Status: written by the lead, awaiting
the owner's approval. Builds on ADR-0018, ADR-0023 and
`docs/superpowers/specs/2026-11-09-autonomous-runs-design.md`. The ticket
cites no SRS requirement; this is pipeline tooling, no product code.

## Intent

The owner's words in TYRE-477's run: "why do i need to keep aksing for
updates, this whole pipleine flow should require no input from me". A
`make pipeline` run is meant to wait for the owner only at the stops in
CLAUDE.md. In that run it stopped three more times, at two kinds of wait
that nothing ends:

- **A teammate's shutdown confirmation.** The playbook says "ask it to
  shut down and wait for its confirmation" in four places
  (`.claude/commands/pipeline.md:192`, `:226`, `:280`, `:569`). The lead
  ended its turn to wait. The planner's approval reached it about 30
  minutes late and the implementer's had not come after 50, each time only
  once the owner typed (ticket, What happens).
- **A CI job that never ends.** No job in `.github/workflows/ci.yml` has a
  `timeout-minutes`, so a hung step runs to GitHub's six-hour default, and
  Hand-over step 4 watches "until `completed`" (`pipeline.md:541`) with no
  rule for a job that hangs. Browser smoke hung twice on PR #211, 30 and 23
  minutes, and the lead cancelled each by hand (ticket comment 14192).

This design gives every such wait a bound and something that ends it.

## What the spec-stage research and spike showed

The findings are in
`.superpowers/sdd/2026-11-11-pipeline-TYRE-478/state.md`. In short:

- **A teammate's message does not reach the lead during the lead's turn**
  (spike S2, Claude Code 2.1.322: a message sent at 20:16:02Z had not
  surfaced four tool rounds and 90 seconds later). It is delivered once
  the lead's turn ends, and when the lead is idle it can be delayed until
  something else advances the session (anthropics/claude-code issue 82687,
  https://github.com/anthropics/claude-code/issues/82687). The agent-teams
  docs do not say an idle lead is woken
  (https://code.claude.com/docs/en/agent-teams).
- **A teammate that approves a shutdown leaves the team listing in
  seconds** (spike S3: request 20:13:23Z, gone from the listing by
  20:13:27Z), whether or not its approval ever surfaces.
- **The team listing shows each teammate as idle or busy.** `ListAgents`
  printed `spike · general-purpose · idle` once the spike teammate had
  ended its turn, and the SendMessage tool's own description says a row
  "says whether it is busy or idle right now". A teammate that has gone is
  not listed.
- **A foreground wait with a time bound works** and the harness does not
  refuse it (spike S1).
- **A background command's exit reaches the lead** (spike S5), and has
  woken an idle lead in every real run: Review loop step 3 waits "to be
  woken when the script exits" (`pipeline.md`, Review loop step 3) and did
  so in TYRE-476's and TYRE-477's runs with no owner input. The docs do
  not promise this and issue 92563 reports it failing
  (https://github.com/anthropics/claude-code/issues/92563), so it is a
  proven practice here, not a contract.
- **A reusable-workflow caller job cannot carry `timeout-minutes`**
  (https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations,
  the supported keyword list). `deploy.yml`'s own jobs already carry one
  (`.github/workflows/deploy.yml:66`, `:204`).
- **A cancelled job ends its run `cancelled`, and
  `gh run rerun <id> --failed` re-runs it** (run 43050815288, attempts 1
  to 3). No run in this repo has ever timed out, so what a job stopped by
  `timeout-minutes` reports is not yet seen here.
- **Passing job times**, 36 runs: Browser smoke at most 8.6 minutes,
  Frontend 3.9, Go 3.3, Infrastructure and workflows 1.2, Schema 0.9,
  Comment style 0.2.

## Goals

1. After a shutdown request the lead knows within about three minutes
   whether the teammate has gone, without the approval message and without
   the owner.
2. The playbook says what counts as shut down, per teammate, in terms of
   the team listing and what is on disk.
3. Wherever the lead ends its turn to wait for a teammate's message, a
   timer wakes it, so a late message costs minutes, not the owner's
   attention.
4. A hung CI job ends red by itself, and the playbook says what the lead
   does with it.
5. A workflow job added later without a timeout fails `make lint`.
6. Every new stop for the owner is an existing row of CLAUDE.md, The
   stops. The table does not change.

## Non-goals

- Review loop step 3's wait for the review script. It is a background
  command whose exit has woken the lead in every run, and the ticket does
  not name it.
- A new channel for teammate reports (see Rejected).
- `.claude/settings.json`. The wait runs through `make`, which
  `Bash(make:*)` already allows (`.claude/settings.json:5`).
- `/ticket`, `/review-pr` and `/close-out`. Close-out's CI wait already
  has a 60 minute bound (`.claude/commands/close-out.md:99`).
- A step-level timeout or a retry on `playwright install`. The job-level
  timeout ends the hang; a flaky runner network is not this repo's to fix.
- `deploy.yml`'s two timeouts, which stay as they are.
- What happens to a dirty tree when a failed teammate is replaced. That
  rule is unchanged.

## Anti-goals

- Reading silence as an answer. A teammate is shut down on evidence: it
  is absent from the listing and its work on disk is settled.
- Treating the team config file under `~/.claude/teams/` as proof. Its
  format is not documented as a contract. The lead reads the listing with
  `ListAgents`.
- A wait that raises a permission prompt. That would swap one owner
  prompt for another.
- A test that greps the playbook's prose (the anti-goal of
  `docs/superpowers/specs/2026-11-10-pipeline-model-per-step-design.md`
  holds here too).
- A lead that polls in a tight loop. Every wait is one command with a
  stated length.

## The design

### 1. `make pipeline-wait S=<seconds>`

One new Makefile target that runs a new script,
`scripts/pipeline-wait.sh <seconds>`. The script waits that many seconds
and exits 0. It refuses a missing argument, a value that is not a whole
number, 0, and anything over 600, with exit 2 and a usage line, as
`scripts/pipeline.sh` refuses a bad key. `scripts/pipeline-wait.test.sh`
holds the cases (each refusal, and a 1 second wait that exits 0), and a
`pipeline-wait-test` target runs it from `make test` and from CI's
Infrastructure and workflows job, next to `pipeline-review-test`.

It is a make target because CLAUDE.md puts every command in the Makefile
and because `Bash(make:*)` is already allowed, so no run prompts the owner
for it. The playbook uses it two ways: in the foreground for a shutdown
wait, and in the background as the timer for a report wait.

### 2. The shutdown wait

A new subsection of `pipeline.md`, Teammates, named "Shutting a teammate
down". Each of the four places that say "wait for its confirmation" points
to it instead.

1. Before the request, record what the teammate left: for the planner,
   the plan file's path and modification time; for the implementer, HEAD
   and an empty `git status --porcelain`; for a teammate that failed
   (When something fails), HEAD and the `git status --porcelain` output as
   it stands.
2. Send the shutdown request.
3. Up to six times: run `make pipeline-wait S=30` in the foreground, then
   read the team listing. Stop at the first read that no longer lists the
   teammate.
4. **Shut down** means: the teammate is absent from the listing, and what
   step 1 recorded is unchanged. The approval message is recorded if it
   arrives and is never waited for. This is not reading silence as an
   answer (Teammates): the evidence is the listing and the disk.
5. If step 1's record has changed for an implementer that had reported
   ready (HEAD moved or the tree is dirty), the checkout is not in the
   state the run recorded: stop (The run cannot go on), as the playbook
   already does. If the planner's plan file changed, re-read it before the
   next stage; that is not a stop. A teammate that failed may finish a
   tool call while it shuts down, so for it there is no comparison: the
   lead records HEAD and the tree again once it has gone, and its
   replacement starts from that.
6. Still listed after the sixth read: stop the teammate with `TaskStop`
   and its name, wait once more, and read the listing. Its report is
   already in hand by then, so nothing is lost. Still listed: stop for the
   owner (The run cannot go on: an agent failed twice), and add this case
   to the list under When something fails.
7. Record in the state file the UTC time of the request and of the read
   that found the teammate gone.

Six reads of 30 seconds is three minutes. The spike's teammate left in 4
seconds and TYRE-477's planner stamped its approval about two minutes
after the request, because a teammate finishes its current tool call
first (agent-teams docs, Limitations: "Shutdown can be slow").

### 3. The report wait

A second new subsection of Teammates, "Waiting for a teammate's message".
It covers every place the lead ends its turn for a teammate: the planner's
plan, its replies to red-team findings and rulings, the implementer's
"ready for review" and its answer after a "not ready", and a report the
lead has asked for again.

1. Before ending the turn, start `make pipeline-wait S=300` in the
   background. Its exit wakes the lead.
2. Woken by the teammate's message: stop the timer with `TaskStop` and go
   on.
3. Woken by the timer with no message: read the team listing and the
   stage's output on disk, record the UTC time and what moved, and take
   the first case that fits. "Moved" means any of these differs from the
   last wake: the plan file's modification time, HEAD, the
   `git status --porcelain` output, or the modification time of the
   executing-plans ledger under `.superpowers/sdd/`.
   - **Not listed and no report:** it stopped early (A teammate errors or
     stops early).
   - **First quiet wake, or something moved:** start the timer again and
     end the turn. A message can be in transit at a timer wake, since it
     reaches the lead only once the lead's turn ends, so the lead never
     asks or fails a teammate on the first quiet wake.
   - **Listed as busy:** start the timer again and end the turn. A busy
     teammate is never asked and never failed on silence, because nothing
     shows it can read a message before its own turn ends, and a gate or
     a long read can run many minutes with nothing written. The one
     ceiling: busy with nothing moved over twelve wakes running (60
     minutes) is a hung teammate, and it has failed. A full gate takes
     about seven minutes here and TYRE-477's planner reported inside 20.
   - **Listed as idle and nothing moved over two wakes running:** its
     turn has ended without the report. Ask it once for the report, as
     When something fails already says, start the timer and end the turn.
     Nothing by the next wake: it has failed.
4. **Accepted risk.** A timer's exit waking an idle lead is proven here
   only by practice (Review loop step 3). `docs/lessons.md` (2026-10-01
   entry, the 24 Sep case) records the harness reaping a backgrounded
   `make check` for low host memory while a session sat idle, and nothing
   records whether a reaped command still sends its exit notice. If a
   timer is lost and the teammate's message is also late, the lead stalls
   as it does today. The state file shows it: each wake is recorded, so a
   gap well over 300 seconds between two records is a missed wake. One
   such gap in a real run reopens the design in Rejected.
5. The stops are untouched. At an owner stop the lead starts no timer and
   waits for the owner.

The two "When something fails" bullets about teammates keep their meaning
and point at these subsections: "goes idle without the report" at this
one, and "errors or stops early" at the shutdown wait, which ends its
loop: that bullet's own "wait for its confirmation" is one of the four.

### 4. CI

**Timeouts.** Each job in `.github/workflows/` that has `runs-on` gets a
job-level `timeout-minutes`, with a one-line comment in the style of
`deploy.yml:64-66`. The value is at least twice the slowest of the 36
passing runs measured, rounded up to 5 minutes:

| Workflow | Job | Slowest pass | `timeout-minutes` |
| --- | --- | --- | --- |
| `ci.yml` | Browser smoke (`e2e`) | 8.6 min | 20 |
| `ci.yml` | Frontend (`web`) | 3.9 min | 10 |
| `ci.yml` | Go (`api`) | 3.3 min | 10 |
| `ci.yml` | Infrastructure and workflows (`infra`) | 1.2 min | 5 |
| `ci.yml` | Schema, isolation and valuation (`database`) | 0.9 min | 5 |
| `ci.yml` | Comment style (`comments`) | 0.2 min | 5 |
| `close-main-prs.yml` | `close` | not measured | 5 |

`deploy-staging` and `deploy-prod` in `ci.yml` call a reusable workflow
and cannot carry the key; `deploy.yml`'s jobs carry it for them.

**The lint.** A new check, wired into `make infra-lint` so `make lint` and
CI's Infrastructure and workflows job both run it, fails when a job in
`.github/workflows/*.yml` has `runs-on` and no `timeout-minutes`, and
passes a job that has `uses`. It carries a self-test, as
`scripts/check-go-pins.mjs --self-test` does. The repo root has no YAML
library, so it reads the files by line, relying on the two-space job
indent every workflow here uses.

**Hand-over step 4.** Three changes to its text:

- Red is defined: the run for the pushed head is `completed` with any
  conclusion other than `success`. That covers `failure`, `cancelled` and
  `timed_out`, so the text does not depend on which one a timeout reports.
- A job that ended `cancelled` or `timed_out` is treated as a red that
  touches no file in the diff, whatever the diff holds: it is re-run once,
  and a second red is the Red gate stop, as now. After the re-run the lead
  reads the run's new attempt and checks the job is in it; if
  `--failed` re-ran nothing, it re-runs the whole run
  (`gh run rerun <id>`).
- The lead's own bound: if the run is not `completed` 60 minutes after
  the push or the re-run that started it, the lead cancels it
  (`gh run cancel <id> -R Rourke9001/TyrePlatform`), waits for
  `completed`, and treats it as the red above. Sixty minutes is
  close-out's bound for the same wait (`close-out.md:99`), and three times
  the longest job timeout.

Before anything step 5, which sends a resume to step 4, needs no change.

### 5. Documents the change makes false, and the lessons entry

- `docs/superpowers/specs/2026-10-11-pipeline-orchestration-design.md:313-314`
  says the lead "waits for the confirmation". Correct it to point at the
  shutdown wait, as TYRE-477 corrected the one spec line it made false.
- `docs/lessons.md` gets one dated entry: a lead that ended its turn
  waiting for a shutdown approval sat idle 30 and 50 minutes; a teammate's
  message does not surface during the lead's turn; the rule is the two
  waits above.
- ADR-0023 (`:119`) and the autonomous-runs spec (`:171`) say the
  implementer has shut down before the loop starts. Both stay true.
- CLAUDE.md does not change.

## Lead's calls

Engineering questions the lead settled, each with its source.

1. **Not a small fix.** Two defects in two mechanisms, a change to
   `ci.yml` for every PR, and a change to what the lead accepts as proof a
   writer has left the checkout (CLAUDE.md, Small fixes: when in doubt, it
   is not).
2. **The shutdown wait is a foreground wait and the listing, not the
   background timer the ticket proposed.** A foreground command with a
   bound is documented Bash tool behaviour and spike S1 and S3 proved the
   whole path in 4 seconds. It needs no wake at all. The ticket's proposal
   is "for whoever takes the ticket to confirm".
3. **The report wait keeps the lead ending its turn, with a background
   timer.** A teammate's message cannot reach a lead that holds its turn
   (spike S2), and the lead already relies on a background command's exit
   to wake it at Review loop step 3, in every run so far.
4. **Shut down is the listing plus settled disk, not the listing alone
   and not a clean tree alone.** The plan file is gitignored, so a clean
   tree says nothing about the planner, and a listing is a status
   (`pipeline.md:594`). A listing that lags keeps a teammate listed
   longer, which only lengthens the wait.
5. **`TaskStop` before the owner.** The tools reference says it "accepts
   an agent-team teammate ... by agent ID or name"
   (https://code.claude.com/docs/en/tools-reference). It is used only once
   the teammate's report is in hand or the teammate has already failed.
6. **A make target, not an allow rule.** `.claude/settings.json:5`.
7. **Timeout values** from 36 passing runs
   (`gh api repos/Rourke9001/TyrePlatform/actions/runs/<id>/jobs`), by the
   rule in the table. `deploy.yml:64-66` is the in-repo precedent for
   bounding a job "rather than leaving it to GitHub's six-hour default".
8. **A cancelled or timed-out job is re-run once whatever the diff.** The
   ticket comment proposes it. A hang the diff causes hangs again, and the
   second red stops for the owner.
9. **No ADR.** No stage, role or stop changes, and the lead still waits
   the way ADR-0018 and ADR-0023 describe; this bounds those waits.
10. **From the builder check** (three questions, all on the report wait,
    all settled here): the listing's idle or busy word is real and is
    what the cases read (What the research showed); a busy teammate is
    never asked or failed on silence, with one 60 minute ceiling; an
    uncommitted change counts as movement; a lost timer is an accepted
    risk with a visible trace (The report wait, step 4).

## Rejected

- **The lead holds its turn through every teammate wait, and teammates
  write their reports and questions to files in the state directory.** It
  would not depend on any wake. It changes how every teammate reports,
  needs an ADR, and solves a failure that has not been seen: no report
  wait has stalled. If a timer's exit ever fails to wake a lead, this is
  the next design.
- **Reading `~/.claude/teams/<team>/config.json` in the wait** so it ends
  the moment the teammate leaves. Undocumented format; it would save at
  most 30 seconds.
- **`ghalint` or another workflow linter** for the timeout rule. A new
  pinned image and a set of other rules, for one check.
- **Proving the timeout conclusion with a throwaway workflow on a pushed
  branch.** The text is written not to depend on it.

## Constraints

- The implementer is a teammate: it runs gates in the foreground, does
  not push, and dispatches no subagent (`pipeline.md`, Implementation).
- `make lint` and CI run the same checks in the same order (CLAUDE.md).
- Comments and user-facing strings follow `docs/comments.md`.
- This PR's diff touches `ci.yml`, so a red CI job on it cannot use the
  "touches no file in the diff" re-run unless it ended `cancelled` or
  `timed_out`.

## What is left to the builder

- The exact wording of the two new subsections and of each sentence that
  points to them, and where in Teammates they sit.
- Whether `scripts/pipeline-wait.sh` sleeps with `sleep` or another
  bounded command, as long as the cases pass on Git Bash and on CI's
  Linux.
- The timeout check's language and file name, and its self-test cases.
  They must cover: a job with `runs-on` and no timeout fails, one with
  both passes, a `uses` job passes, and a file with two jobs reports the
  right one.
- The comment on each `timeout-minutes` line.
- The lessons entry's wording, in that file's format.

## Acceptance

- Every "wait for its confirmation" in `.claude/commands/pipeline.md` is
  gone or points at the shutdown wait, which states what counts as shut
  down (ticket, definition of done, item 1).
- `make pipeline-wait S=1` exits 0; its refusals exit 2; the cases run in
  `make test` and in CI.
- Every `runs-on` job in `.github/workflows/` has `timeout-minutes`, and
  removing one makes `make lint` fail.
- Hand-over step 4 defines red, the re-run for a cancelled or timed-out
  job, and the 60 minute bound.
- `make check` is green.
- The ticket's second item, a run that needs no prompt outside the stops,
  "shown by the next run's state file timestamps", cannot be shown by this
  PR. This run uses the two waits by hand and records their times in its
  state file as first evidence; the item closes on the first run launched
  after the merge.
