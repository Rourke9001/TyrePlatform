# Design: pipeline orchestration (TYRE-412)

- **Date:** 2026-10-11
- **Ticket:** TYRE-412, under epic TYRE-10.
- **Decisions it rests on:**
  - Owner rulings U120 to U124 (11 Oct 2026, on TYRE-412): before the PR
    the owner is stopped only for the spec, red-team rulings and pushes
    (U120, U124); the lead makes the small-fix call (U121); close-out runs
    as a cloud routine, and the owner reviews and merges every PR (U123).
  - Owner ruling U125 (12 Oct 2026, on TYRE-412), after the Task 0 spike
    showed that a teammate cannot collect a `/code-review` fork or a
    subagent's result: stage 5 stays a separate session the owner starts,
    and the pipeline ends when the PR opens. It supersedes U122, which had
    capped a pipeline review loop at two rounds.
  - U126 (12 Oct 2026, on TYRE-412): the owner moved `git push` from the
    project's `ask` list to `allow`. The pipeline's push stop (U124) stays,
    held by the playbook: the implementer asks the lead before it pushes.
  - TYRE-394 (PR #99): the five stages and the PR #99 exemptions.
  - ADR-0018, written in this ticket: agent teams for the run, a routine for
    close-out.
- **Requirements:** none. No SRS requirement governs how the work runs;
  CLAUDE.md "How work runs" is the authority this changes.
- **Evidence:** Claude Code docs on agent teams
  (code.claude.com/docs/en/agent-teams) and routines
  (code.claude.com/docs/en/routines), read on 11 Oct 2026, cited inline.
  Claude Code 2.1.296 on the owner's machine.

## Why this exists

The five stages run today as separate chats the owner opens and switches
between: `/ticket` for spec, plan, red team and implementation, a new session
for `/review-pr`, and `/close-out` by hand after the merge. Each handoff
waits for the owner to notice the last stage finished and to start the next.

This design gives each ticket one launch from triage to its PR. A lead
session runs stages 1 to 4 through dedicated agents, the owner watches any
of them from one window, and the run stops only where the owner's judgement
is the point. Stage 5 stays a separate session the owner starts, as today
(U125). The owner merges the PR, and the merge starts close-out.

## Out of scope

- More than one ticket in flight at a time. The main checkout, the database
  container and port 5433 are shared, and stage 5 fixes run in that
  checkout after the run hands over, so a ticket is in flight from launch
  until its PR merges or closes.
- A second work tracker. Jira stays the state and Confluence the authority
  (CLAUDE.md). Paperclip was rejected for this reason among others (ADR-0018).
- Automating the merge or the promotion of `main`. Both stay with the owner.
- Stage 5 code review. A teammate cannot collect `/code-review` (Task 0), so
  `/review-pr` stays a separate session the owner starts (U125).
- Changing what a stage does. Brainstorming, writing-plans, `plan-red-team`,
  `/review-pr` and `/close-out` keep their content; this design changes who
  starts them and how results move between them.
- Split-pane display. It needs tmux or iTerm2, and split panes are not
  supported in Windows Terminal (agent-teams docs, Limitations).

## The flow

```
make pipeline T=TYRE-123        (agent teams on for this launch only)

lead (the owner's session; never writes code)
  1  triage: Jira, cited SRS IDs, blocked check, small-fix call
  2  spec with the owner (brainstorming), committed ...... STOP: approve
  3  planner: writing-plans -> plan path
  4  red-team (plan-red-team): attack -> planner fixes -> new red-team,
     until no Critical; what the planner cannot close ..... STOP: rule
  5  implementer: executing-plans inline, make check, push ... STOP: approve
     push, PR
  6  lead: PR body complete, Jira -> In Review, tells the owner; run ends

owner: /review-pr <n> in a separate session (stage 5, as today), then
       merges in the GitHub web UI

close-out routine (cloud, on a PR merged into develop)
  /close-out <n> in cloud mode -> board reconciled, docs PR if needed
```

A small fix skips steps 2 and 4, as CLAUDE.md already allows, and runs to
the PR with no stop but the push approval (U124). The lead records the small-fix call and its reason in
the PR body, where the owner sees it at review. This replaces the PR #99
pause for that call under `/pipeline`; `/ticket` keeps the pause.

## Components

### 1. The launcher

A Makefile target, because every command lives in the Makefile:

```
make pipeline T=TYRE-123
```

It refuses an empty or malformed `T`, then runs
`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 claude "/pipeline $(T)"`. The flag is
set for that process only and never in a settings file: while it is on, any
subagent the lead names launches as a teammate (agent-teams docs, "Enable
agent teams"), which would change how plain sessions and `/ticket` dispatch.

### 2. `/pipeline`, the lead's playbook

`.claude/commands/pipeline.md`. The lead:

- Refuses to start unless `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` is `1`.
  Without it the named agents would run as ordinary subagents, which the
  playbook's messaging and waiting are not written for.
- Waits for each teammate's explicit report and never reads silence as an
  answer. In Task 0 a teammate's reply had not reached the lead when the
  lead moved on, and the lead recorded it as unanswered.
- Never edits code, plans or specs other than the spec it writes with the
  owner. The agent-teams docs warn that a lead sometimes starts the work
  itself instead of waiting; the playbook forbids it.
- Owns the run state file, every Jira update and every owner stop.
- Spawns teammates with predictable names and gives each the key and the
  paths it needs, because the lead's history does not carry over to a
  teammate (agent-teams docs, "Context and communication").
- Reads `.superpowers/sdd/<date>-pipeline-<key>/state.md` at start. If it
  exists, the run is a resume (see Failure and recovery).

### 3. The teammates

| Name | Type | Input | Output | Lifetime |
| :- | :- | :- | :- | :- |
| `planner` | general-purpose | key, spec path | plan path | until red team passes, so it fixes findings with its context loaded |
| `implementer` | general-purpose | key, spec path, plan path, branch | PR number, `make check` exit code, its report | until the PR opens |

The red team is not a teammate. The lead dispatches `plan-red-team` as its
own unnamed subagent each round, so its findings come back to the lead as
its result: the path Task 0 proved, and the one `/ticket` uses.

Every teammate ends its turn with a short report to the lead: done or
blocked, what it produced, and any open finding. A teammate loads the
project's MCP servers and hooks (Task 0: a teammate read Jira, and
`gate-not-piped.sh` refused its piped gate). The agent-teams docs say it
loads CLAUDE.md and skills too; the first real run checks that.

No teammate dispatches a subagent or launches `/code-review`. In Task 0 a
teammate's subagent could not hand its result back to the teammate, and a
teammate's `/code-review` fork reported to the lead instead. So the planner
researches the code itself, and the implementer works through the plan
inline with `superpowers:executing-plans` and does that skill's final
review itself, a self-review. The auditor agents run in stage 5, where
`/review-pr` dispatches them; because the final review was a self-review,
stage 5 applies to every pipeline PR that is not docs-only. Where the
implementer's skill says to stop and ask, the question goes to the owner
through the lead.

Red-team loop: a round is planner fixes plus a new red-team subagent. A finding the
planner disputes or cannot close goes to the owner. After three rounds with
a Critical still open, the run stops for the owner rather than looping.

### 4. The run state file

`.superpowers/sdd/<date>-pipeline-<key>/state.md`, ignored by a root
`.gitignore` entry for `.superpowers/`. At the end of every stage, before
the next starts, the lead fills that stage's fields and sets the last stage
finished:

- key, branch, small-fix call and reason
- spec path and commit, plan path
- red-team rounds: verdict, counts, findings fixed and ruled on
- each owner answer at a stop, verbatim, with the time
- PR number, `make check` result
- the implementer's report, saved beside the state file, because
  executing-plans deletes its own ledger when it finishes
- the last stage finished

It is the only handoff a new lead needs after a crash.

### 5. Jira at each stage

The lead moves the ticket to In Progress at the start and to In Review when
the PR opens. It comments on the ticket when the spec is committed, when the
plan clears red team (with the verdict and counts), and when the PR opens.
An owner ruling at a red-team stop is
also recorded as a comment on the ticket, in the house form for rulings.
Anything found that is not this ticket's to fix is raised as a new ticket,
linked, as `/ticket` step 11 already says.

### 6. The PR body

The lead fills `.github/pull_request_template.md`. "How it ran" carries the
spec path, the red-team verdict with the counts fixed and ruled on, or the
small-fix plan, plus the implementer's rulings and deferred minors and the
line "Final review: self-review". The lead leaves the "Code review by a
separate session" line unticked: the owner's stage 5 session ticks it with
the report path, as today. The template does not change, and neither does TYRE-395's CI check.

### 7. `/close-out` cloud mode

`.claude/commands/close-out.md` gains a second argument, `cloud`, which the
routine passes. Cloud sessions are different in three ways that shape it
(code.claude.com/docs/en/cloud-environments):

- The GitHub proxy rejects GraphQL, so `gh pr` and `gh issue` fail. Every
  GitHub call in cloud mode uses the REST API through `gh api`, with the
  repository named literally, except `gh run list` and `gh run watch`,
  which use REST themselves.
- A run triggered by a PR event starts from the PR's head commit, not from
  `develop` (routines docs, "Repositories and branch permissions"). Cloud
  mode checks out `origin/develop` before it reads or edits anything.
- A foreground command waits at most 10 minutes before it moves to the
  background, where a result can arrive after the turn has ended. Cloud
  sessions do have Docker, but CI's develop run has already run the gates
  on the merge commit, so a cloud `make check` would only repeat it, slower.

So in cloud mode:

- **Step 2.** The gate is CI's push run on `develop` for the merge commit.
  The foreground refuses `sleep`, so close-out waits on the run with a
  bounded `gh run watch` in the foreground, and cites its URL when it
  finishes. A run cancelled by a later push is replaced by the oldest later
  develop run whose head contains the merge commit, waited on the same way,
  with a 60-minute ceiling. If the run is red, including a failed staging
  deploy, or nothing completes within that ceiling, close-out comments that
  on each ticket the PR names, transitions nothing, and stops.
- **Step 7.** Never runs. Promoting `main` stays with the owner.
- **Doc edits.** Changes to `docs/implementation-order.md` or
  `docs/lessons.md`, if there are any, go on a `<first key>-pr<n>-close-out`
  branch cut from `develop`, as a PR with the `close-out` label. It is
  docs-only, so stage 5 does not apply.
- **Report.** The board changes, what it left alone and the decisions
  waiting on the owner go in a comment on the merged PR, on every path past
  the guards (First step). The routine acts as the owner, and neither GitHub
  nor Jira notifies the owner of their own comment, so a push notification
  goes to the owner when the run stops early or leaves a decision waiting.
- **First step.** If the merged PR's branch ends in `-close-out` or it
  carries the `close-out` label, exit without changes. This is the loop
  guard: merging a close-out PR must not start another close-out. A merged
  PR that names no `TYRE-<n>` in its title or body, such as a Renovate
  bump, gets a comment saying so and nothing else.

Run by hand on the owner's machine, `/close-out` behaves as it does today,
apart from the guards and one stop: it refuses while a pipeline that has not
handed over is working in the checkout.

### 8. The close-out routine

Created in the owner's claude.ai account (claude.ai/code/routines or
`/schedule`). It is not in the repo, so it holds nothing worth reviewing:

- **Trigger:** GitHub event `pull_request.closed`, filters "is merged" equals
  true, "base branch" equals `develop`, and "title" matches
  `.*TYRE-[0-9]+.*`, which saves a run per Renovate merge. Needs the Claude
  GitHub App on the repository (routines docs, "Add a GitHub trigger").
- **Prompt:** run `/close-out` in cloud mode for the merged PR named in this
  event. The prompt opts in to reading the PR number from the event; it acts
  on nothing else in the payload.
- **Connectors:** Atlassian and GitHub only. A routine can use every tool of
  an included connector without asking (routines docs, "Review connectors").
- **Branches:** never push to `develop` or `main`. Only the prompt enforces
  this: the cloud proxy does not limit which branches a push updates, and
  the `develop` ruleset only blocks deletion. A ruleset requiring PRs on
  `develop` would close the gap and also block the owner's direct docs
  pushes, so it is the owner's call (ADR-0018).
- **Identity:** commits, PRs and Jira comments appear as the owner (routines
  docs, "Create a routine").

The filters cannot exclude a branch by pattern, which is why the loop guard
lives in `/close-out` itself.

### 9. Process documents

- **CLAUDE.md, "How work runs":** `make pipeline` runs a ticket to its PR
  and `/ticket` walks the stages by hand. Under `/pipeline` the
  implementer uses `superpowers:executing-plans`, because a teammate's
  subagents do not report back to it. Stage 5 is unchanged, except that it
  applies to every pipeline PR that is not docs-only, and neither a
  subagent nor the pipeline's lead or teammates may be the reviewer (U125).
  Close-out runs on merge by routine, and `/close-out` runs by hand only
  when the routine did not run or stopped. Under `/pipeline` the lead makes
  the small-fix call and records it in the PR body.
- **`/ticket`:** one line pointing to `/pipeline`; the steps are unchanged.
- **ADR-0018:** agent teams for the run and a routine for close-out. Rejected:
  Paperclip (no Jira, its own task model as the unit of work, headless runs
  only), a `claude -p` runner (needs a viewer built for it), and the Workflow
  tool (no stop for the owner mid-run). Costs: agent teams are
  experimental, a team cannot be resumed, each teammate draws on the
  owner's usage separately, a teammate cannot collect a subagent or a
  `/code-review` fork, so stage 5 stays a chat the owner opens (U125), and
  one ticket is in flight until its PR merges or closes.

## Owner stops

Every stop happens in the lead's window, which is the session the owner
launched. Under auto mode, an approval relayed from another agent is treated
as untrusted (agent-teams docs, "Messages between agents"), so an owner
answer only counts when typed in the lead.

- **Spec approval.** The lead runs brainstorming with the owner on its
  architectural path, commits the spec as that skill does, and waits for
  the owner to approve the written spec before any planning starts.
- **Red-team ruling.** The lead puts each open finding with the planner's
  position and the options. The answer goes in the state file and on the
  ticket, and the planner applies it.
- **Push approval.** The implementer's push that opens the PR waits for
  the owner's approval in the lead (U124). No `ask` rule has backed it
  since U126, so the implementer asks the lead before it pushes.
- **Other permission prompts.** Teammate prompts surface in the lead
  (agent-teams docs, "Permissions").
- **A skill's own stop.** Where the implementer's skill says to stop and
  ask (a destructive or security-sensitive step, a plan too broken to
  follow, failing baseline tests), the question comes to the lead, which
  puts it to the owner and never answers it itself.
- **PR ready.** The lead says the PR is ready, with the red-team verdict and
  the `make check` result, and names stage 5 as the owner's next step. The
  run ends there. Fixes from the stage 5 review are made outside the run,
  as for a `/ticket` PR.

## Failure and recovery

- **A teammate errors or stops early.** The lead asks it to shut down and
  waits for the confirmation, so two never work in the checkout at once,
  then respawns it once from the state file. A second failure stops the run
  and asks the owner.
- **The lead's session dies.** `/resume` does not restore in-process
  teammates (agent-teams docs, Limitations). The owner runs
  `make pipeline T=<key>` again; the new lead reads the state file, checks it
  against reality (the branch exists, the spec is committed, the plan file
  exists, the PR is open), and restarts at the first unfinished stage with
  new teammates. Where the file and reality disagree, it stops and reports
  rather than guessing.
- **Usage limit.** The run stops with the state saved, and a relaunch after
  the window resets resumes it.
- **A teammate's task status lags.** Known limitation (agent-teams docs).
  The lead judges a stage by its output on disk and in git, never by task
  status.
- **A teammate goes idle without its report.** Its message may not have
  reached the lead yet (Task 0). The lead checks the stage's output on disk
  and in git, then asks it once for the report, and treats it as failed
  only when neither shows progress. A result that reaches the lead from work a
  teammate started, such as a subagent's hand-back, is forwarded to that
  teammate.

## Spikes before the build (plan Task 0)

Throwaway; nothing from them is kept. Each has a fallback if it fails.
All seven ran on 12 Oct 2026 on Claude Code 2.1.296: spikes 1 to 4, 6 and
7 with a lead and one teammate, spike 5 as a routine run. The results are
on TYRE-412 (comments 13580 and 13581).

1. **`/code-review` in a teammate.** Failed. The lead's control run returned
   a report. The teammate's run launched, but its result reported to the
   lead and never reached the teammate. Resolution: U125, stage 5 stays
   outside the pipeline.
2. **Jira from a teammate.** Passed: `getJiraIssue` returned the status.
3. **Subagents from a teammate.** Failed. The subagent ran, but its
   hand-back was refused with "the agent that spawned you is no longer
   running" while the teammate was still waiting on it, and its later
   hand-back went to the lead. Fallback taken: the implementer uses
   `superpowers:executing-plans` inline.
4. **The launcher.** Passed for the argument. Through `make` in Git Bash, an
   unexcluded `"/pipeline TYRE-0"` reached a native program as
   `C:/Program Files/Git/pipeline TYRE-0`, and with `MSYS2_ARG_CONV_EXCL`
   set to `/pipeline ` it arrived intact, with the flag in the environment.
   That an interactive `claude` runs its first argument as a slash command
   is shown by the first real launch.
5. **The routine.** Passed. A report-only Run now read PR #106 through
   `gh api`, found CI's run for its merge commit with `gh run list`,
   fetched `develop`, and read the ticket through the Atlassian connector.
   The clone is shallow, so cloud mode's `--unshallow` applies, and the
   repo's `.mcp.json` Atlassian server cannot connect in the cloud, so the
   connector is the one used.
6. **Hooks in a teammate.** Passed: `gate-not-piped.sh` refused the
   teammate's piped `make lint`.
7. **A second message to an idle teammate.** Passed: the teammate answered.
   Its reply had not reached the lead when the lead summarised, which is
   why the lead waits for an explicit report (component 2).

## Acceptance

- The spikes pass or their fallbacks are in the plan.
- `/pipeline`, the launcher, `/close-out` cloud mode, the CLAUDE.md change
  and ADR-0018 are merged, and `make check` is green.
- The routine exists with its filters, and the loop guard is shown on a
  close-out PR merge.
- The first real ticket runs through `make pipeline` to its PR, the owner
  reviews it with `/review-pr` in a separate session and merges it, and the
  routine closes it out. TYRE-394 closes on that run.

## Risks

- **Agent teams are experimental.** Behaviour can change between Claude Code
  releases. The state file and the unchanged `/ticket` path mean a broken
  team degrades to today's manual process, not to a stuck ticket.
- **Usage.** Each teammate is a separate instance with its own context. A
  long run can use the five-hour window; the run stops with state saved
  rather than losing work.
- **A wrong turn goes further before the owner sees it.** The spec stop and
  the red-team stops are where the owner's judgement lands, and the owner
  still reviews every PR before it merges.
