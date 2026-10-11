# Design: pipeline orchestration (TYRE-412)

- **Date:** 2026-10-11
- **Ticket:** TYRE-412, under epic TYRE-10.
- **Decisions it rests on:**
  - Owner rulings of 11 Oct 2026, recorded on TYRE-412: the spec approval
    and red-team rulings are the only stops before the PR; the lead makes
    the small-fix call; the review fix loop is capped at two rounds; close-out
    runs as a cloud routine; the owner reviews and merges every PR.
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

This design gives each ticket one launch. A lead session runs every stage
through dedicated agents, the owner watches any of them from one window, and
the run stops only where the owner's judgement is the point. The owner
reviews and merges the PR, and the merge starts close-out.

## Out of scope

- More than one pipeline at a time. The database container and port 5433 are
  shared, so runs are serial.
- A second work tracker. Jira stays the state and Confluence the authority
  (CLAUDE.md). Paperclip was rejected for this reason among others (ADR-0018).
- Automating the merge or the promotion of `main`. Both stay with the owner.
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
  5  implementer: subagent-driven-development, make check, PR
  6  reviewer: /review-pr <n> -> implementer fixes -> scoped re-review,
     at most two fix rounds; open findings go in the PR body
  7  lead: PR body complete, Jira -> In Review, tells the owner

owner: reviews and merges in the GitHub web UI

close-out routine (cloud, on a PR merged into develop)
  /close-out <n> in cloud mode -> board reconciled, docs PR if needed
```

A small fix skips steps 2 and 4, as CLAUDE.md already allows, and runs to
the PR without a stop. The lead records the small-fix call and its reason in
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
  Without it the lead would run every stage as ordinary subagents, which
  breaks the stage 5 separation silently.
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
| `red-team-<round>` | `plan-red-team` | key, spec path, plan path | findings and verdict | one round; a new one each round, as CLAUDE.md stage 3 dispatches it again |
| `implementer` | general-purpose | key, spec path, plan path, branch | PR number, `make check` exit code | until review ends, so it fixes findings with its context loaded |
| `reviewer` | general-purpose | PR number | report path, counts by severity, verdict | until review ends, so its re-review is scoped |

Every teammate ends its turn with a short report to the lead: done or
blocked, what it produced, and any open finding. A teammate loads CLAUDE.md,
skills, MCP servers and the project hooks like any session (agent-teams
docs, "Context and communication"), so `gate-not-piped.sh` and
`migration-immutable.sh` bind it.

The reviewer runs `/review-pr` unchanged. Its check that "this session wrote
none of the PR's code" holds, because the implementer wrote the code. Its
report-only rule holds too: the lead routes findings to the implementer.

Red-team loop: a round is planner fixes plus a new red-team. A finding the
planner disputes or cannot close goes to the owner. After three rounds with
a Critical still open, the run stops for the owner rather than looping.

Review loop: after the first review, at most two rounds of implementer fixes
plus scoped re-review. What is still open after that goes in the PR body
under the review line, and the owner decides at merge.

### 4. The run state file

`.superpowers/sdd/<date>-pipeline-<key>/state.md`, gitignored with the other
run artefacts there. The lead rewrites it after every stage:

- key, branch, small-fix call and reason
- spec path and commit, plan path
- red-team rounds: verdict, counts, findings fixed and ruled on
- each owner answer at a stop, verbatim, with the time
- PR number, `make check` result
- review rounds: report path, counts, verdict
- the stage reached

It is the only handoff a new lead needs after a crash.

### 5. Jira at each stage

The lead moves the ticket to In Progress at the start and to In Review when
the PR opens. It comments on the ticket when the spec is committed, when the
plan clears red team (with the verdict and counts), when the PR opens, and
when review ends (with the verdict). An owner ruling at a red-team stop is
also recorded as a comment on the ticket, in the house form for rulings.
Anything found that is not this ticket's to fix is raised as a new ticket,
linked, as `/ticket` step 11 already says.

### 6. The PR body

The lead fills `.github/pull_request_template.md`. "How it ran" carries the
spec path, the red-team verdict with the counts fixed and ruled on, or the
small-fix plan, and the ticked "Code review by a separate session" line with
the report path. That line is what TYRE-395's CI check will read, so
TYRE-395 needs no change.

### 7. `/close-out` cloud mode

`.claude/commands/close-out.md` gains one switch, taken when Docker is not
available, which is how it runs in a cloud routine:

- **Step 2.** The gate is CI's push run on `develop` for the merge commit,
  which runs the same gates as `make check`. Close-out waits for it to finish
  and cites its URL. If it is red, it comments that on the ticket,
  transitions nothing, and stops.
- **Step 7.** Never runs. Promoting `main` stays with the owner.
- **Doc edits.** Changes to `docs/implementation-order.md` or
  `docs/lessons.md` go on a `TYRE-nnn-close-out` branch cut from `develop`,
  as a PR with the `close-out` label. It is docs-only, so stage 5 does not
  apply.
- **Report.** The board changes, what it left alone and the decisions
  waiting on the owner go in a comment on the merged PR, so GitHub notifies
  the owner.
- **First step.** If the merged PR's branch ends in `-close-out` or it
  carries the `close-out` label, exit without changes. This is the loop
  guard: merging a close-out PR must not start another close-out.

Run by hand on the owner's machine, `/close-out` behaves as it does today.

### 8. The close-out routine

Created in the owner's claude.ai account (claude.ai/code/routines or
`/schedule`). It is not in the repo, so it holds nothing worth reviewing:

- **Trigger:** GitHub event `pull_request.closed`, filters "is merged" equals
  true and "base branch" equals `develop`. Needs the Claude GitHub App on the
  repository (routines docs, "Add a GitHub trigger").
- **Prompt:** run `/close-out` in cloud mode for the merged PR named in this
  event. The prompt opts in to reading the PR number from the event; it acts
  on nothing else in the payload.
- **Connectors:** Atlassian and GitHub only. A routine can use every tool of
  an included connector without asking (routines docs, "Review connectors").
- **Branches:** never push to `develop` or `main`.
- **Identity:** commits, PRs and Jira comments appear as the owner (routines
  docs, "Create a routine").

The filters cannot exclude a branch by pattern, which is why the loop guard
lives in `/close-out` itself.

### 9. Process documents

- **CLAUDE.md, "How work runs":** `/pipeline` is the default way to run a
  ticket and `/ticket` the manual path. A stage 5 reviewer can be a pipeline
  teammate: a separate Claude instance that wrote none of the code. The owner
  reviews and merges every PR. Close-out runs on merge by routine, and
  `/close-out` still runs by hand. Under `/pipeline` the lead makes the
  small-fix call and records it in the PR body.
- **`/ticket`:** one line pointing to `/pipeline`; the steps are unchanged.
- **ADR-0018:** agent teams for the run and a routine for close-out. Rejected:
  Paperclip (no Jira, its own task model as the unit of work, headless runs
  only), a `claude -p` runner (needs a viewer built for it), and the Workflow
  tool (subagents only, no stop for the owner mid-run). Costs: agent teams are
  experimental, a team cannot be resumed, and each teammate draws on the
  owner's usage separately.

## Owner stops

Every stop happens in the lead's window, which is the session the owner
launched. Under auto mode, an approval relayed from another agent is treated
as untrusted (agent-teams docs, "Messages between agents"), so an owner
answer only counts when typed in the lead.

- **Spec approval.** The lead runs brainstorming with the owner and commits
  the spec only after the owner approves it.
- **Red-team ruling.** The lead puts each open finding with the planner's
  position and the options. The answer goes in the state file and on the
  ticket, and the planner applies it.
- **Permission prompts.** Teammate prompts surface in the lead (agent-teams
  docs, "Permissions").
- **PR ready.** The lead says the PR is ready, with the counts and the
  verdict. The run ends there.

## Failure and recovery

- **A teammate errors or stops early.** The lead respawns it once from the
  state file. A second failure stops the run and asks the owner.
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

## Spikes before the build (plan Task 0)

Throwaway; nothing from them is kept. Each has a fallback if it fails.

1. **`/code-review` in a teammate.** It launches as a background fork, and an
   in-process teammate cannot run background work (agent-teams docs,
   Limitations). Run it on merged PR #105. Pass: a report comes back.
   Fallback: `/review-pr` gains a foreground path that reviews the diff
   in-session with the auditors.
2. **Jira from a teammate.** A teammate calls `getJiraIssue` on TYRE-412.
   Fallback: the lead fetches Jira and passes the text in the spawn prompt.
3. **Subagents from a teammate.** The implementer runs
   subagent-driven-development, which dispatches subagents. Pass: one task
   dispatches and returns. Fallback: the implementer uses
   `superpowers:executing-plans` inline.
4. **The launcher.** `make pipeline` starts an interactive `claude` from Git
   Bash on Windows with the flag set. Fallback: a PowerShell function
   documented in the command's header.
5. **The routine.** Run now against a merged PR in report-only mode. Pass:
   it reads the PR number from the event, reads CI's run for the merge
   commit, and reads the ticket from Jira. Fallback for the CI read: the
   GitHub connector instead of `gh`.

## Acceptance

- The spikes pass or their fallbacks are in the plan.
- `/pipeline`, the launcher, `/close-out` cloud mode, the CLAUDE.md change
  and ADR-0018 are merged, and `make check` is green.
- The routine exists with its filters, and the loop guard is shown on a
  close-out PR merge.
- The first real ticket runs through `make pipeline` to its PR, the owner
  merges it, and the routine closes it out. TYRE-394 closes on that run.

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
