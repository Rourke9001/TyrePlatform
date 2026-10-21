# ADR-0018: An agent team runs each ticket to its PR; a routine runs close-out

- **Status:** Accepted. Its PR, #107, merged on 12 Oct 2026.
- **Date:** 2026-10-12
- **Deciders:** Rourke
- **Related:** TYRE-412, TYRE-394 (the five stages), TYRE-395 (the stage 5
  CI check) · spec `docs/superpowers/specs/2026-10-11-pipeline-orchestration-design.md`

## Context

Each ticket runs five stages (CLAUDE.md, How work runs). Stage 5 must come
from a session that did not write the code, and close-out follows the
merge. Run by hand, that is three or more chats the owner opens and
switches between, and each handoff waits for the owner to notice.

The constraints on any orchestration:

- Jira is the state and Confluence the authority. A tool with its own task
  tracker becomes a second record of the work, the reason OpenSpec was
  rejected (TYRE-394).
- The owner decides the spec, rules on red-team findings and merges. The
  orchestration has to stop for the owner and wait.
- Stage 5 cannot be a subagent of the author.
- One engineer, on Windows, on a Claude subscription. Whatever runs has to
  survive a lost session and spend usage carefully.

## Options considered

### Option A: Paperclip
An open-source control plane for agent teams with an org chart, budgets,
approvals and a web UI. **Its downside:** its issue is the unit of work and
the trigger that wakes an agent, so it cannot run without its own tracker;
Jira support is an unbuilt roadmap item. Every run is headless
(`claude --print`, permission prompts off by default), so the spec
conversation becomes comment ping-pong. Its docs assume a Mac.

### Option B: a `claude -p` runner script
Each stage as a new headless process, handing over through files.
**Its downside:** nothing to watch. Seeing the agents work means building a
viewer, and the spec conversation does not fit a headless run.

### Option C: the Workflow tool
Deterministic orchestration of subagents from one session.
**Its downside:** a running workflow cannot stop to ask the owner, and the
spec, the red-team rulings and the push are all owner stops.

### Option D: Claude Code agent teams, and a routine for close-out
The owner's session is the lead and writes the spec with the owner; the
planner and the implementer are teammates, each a full and separate Claude
instance that loads the project's MCP servers and hooks, and the red team
runs as the lead's own subagent. Teammates are watched from the agent
panel. A routine fires
on a merged PR and runs close-out in the cloud. **Its downside:** agent
teams are experimental, a team cannot be resumed after its session dies,
every teammate draws on the owner's usage, and on Windows only one teammate
is visible at a time. A teammate also cannot collect work it starts: in a
spike on 12 Oct 2026 (Claude Code 2.1.296), a teammate's subagent and its
`/code-review` fork both reported to the lead instead.

## Decision

We will run each ticket from triage to its PR with a Claude Code agent team
launched by `make pipeline`, and close it out with a Claude Code routine
triggered by a PR merged into `develop`. Stage 5 stays a separate session
the owner starts (owner ruling U125), because a teammate cannot collect
what `/review-pr` dispatches.

## Consequences

**Good:** one launch per ticket up to the PR; the owner is asked only for
the spec, for red-team rulings and for the push (U124; since U126 the
playbook, not a permission rule, holds that stop). Stage 5 runs as today,
and under `make pipeline` applies to every PR that is not docs-only. Jira stays the only tracker. The board is
reconciled after a merge without anyone opening a chat.

**Bad:**

- Stage 5 is still a chat the owner opens, and its fixes are made outside
  the run, in the same checkout. So one ticket is in flight from launch
  until its PR merges or closes, and a second launch waits.
- The implementer works inline with `superpowers:executing-plans`, so the
  pipeline gives up subagent-driven development's fresh reviewer per task;
  its final review is a self-review. Stage 5 is the independent one, so
  under `make pipeline` it applies to every PR that is not docs-only.
- An experimental feature carries the process; a change in Claude Code can
  break a run. `/ticket` stays as the manual path for that case.
- A state file has to carry every handoff, because nothing else survives a
  dead lead.
- The routine lives in the owner's claude.ai account, outside the repo and
  outside review, so its prompt only points at `/close-out`.
- Only the routine's prompt keeps it off `develop` and `main`: the cloud
  proxy does not limit which branches a push updates, and the `develop`
  ruleset only blocks deletion. A ruleset requiring PRs on `develop` would
  close that gap and also block the owner's direct docs pushes; that is the
  owner's call.
- Usage per ticket rises with the number of teammates.

**Revisit when:** agent teams leave experimental or are removed; a
teammate can collect its own subagents and `/code-review` forks, which
would let subagent-driven development move into the team, and stage 5 too
if the owner revisits U125;
Paperclip or a similar tool can use Jira as its tracker; or a second
engineer needs pipelines to run at the same time.
