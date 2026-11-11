# Pipeline models: each step runs on the model the owner chose

Date: 2026-11-10. Ticket: TYRE-476. Status: approved by the owner on
10 Nov 2026, with the two answers under Settled by the owner.
The mapping is owner ruling U205 (10 Nov 2026, on the ticket). Builds on
ADR-0018, ADR-0023 and
`docs/superpowers/specs/2026-11-09-autonomous-runs-design.md`.

## Intent

A `make pipeline` run uses several agents: a lead, a planner, a red team, an
implementer, reviewers, a verifier and fixers. Today each one's model comes
from where it happens to start. The launcher passes no model, so the lead
runs on the owner's default. The builder check, the verifier and every fixer
are dispatched "with no `model` override" (`.claude/commands/pipeline.md:317`,
`:375`) and the planner is spawned with no model
(`.claude/commands/pipeline.md:175`). `/code-review high` runs as a fork of
the lead, and a fork stays on the lead's model.

So a lead on Fable puts the code review on Fable, which the owner does not
want. U205 names a model for each step. This design sets each one in the
repo, so a run gets the same models whatever the owner's shell or user
settings hold.

## Goals

1. Every step in U205's table runs on its model, and the place that sets it
   is a file in the repo.
2. The code review runs on Opus and its result reaches the lead.
3. A review that failed, ran on the wrong model or was denied a tool is an
   error. It is never read as a clean review.
4. The lead runs at high effort whatever the owner's settings say.
5. The launcher test pins the launch shape, so a later edit that drops a
   flag or a variable fails `make test`.

## Non-goals

- The effort of any agent but the lead. Opus and Sonnet agents keep the
  effort the owner's user settings give each model.
- `/review-pr` in a separate session and `/code-review ultra`. Each runs on
  its session's model (ticket, Not in scope).
- `/ticket`'s own dispatches, apart from the red team, whose model lives in
  the agent file both paths share. The owner agreed to that side effect.
- `/design-audit` at the cap. It already names Fable for its research
  (`.claude/commands/design-audit.md:43`), and it is a design judgement on
  short text, which is where U205 puts Fable.
- The auditors. Their frontmatter already says `model: opus`.
- The close-out routine's model. It is a cloud setting outside the repo and
  is the owner's live step (see Owner's live step).
- Any change to `.claude/settings.json`, apart from the one allow rule
  the owner added (Settled by the owner).
- Token budgets or cost tracking.

## Anti-goals

- A review whose model nobody checked.
- `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`. It would put every agent on one model
  and undo the mapping.
- `CLAUDE_CODE_EFFORT_LEVEL`. It outranks every other effort setting and
  every child process would inherit it.
- A second copy of the mapping in CLAUDE.md. The values sit at each
  dispatch in the playbook, and ADR-0023 holds the table and the reasons.
- A test that greps the playbook's prose for model names.

## The mapping (U205)

| Step | Model | Where it is set |
| --- | --- | --- |
| Lead: triage, spec, orchestration | Fable, effort high | `scripts/pipeline.sh` |
| Spec builder check | Opus | `pipeline.md`, the builder check dispatch |
| Planner teammate | Opus | `pipeline.md`, the planner spawn line |
| Red team of the plan | Fable | `.claude/agents/plan-red-team.md` frontmatter |
| Implementer teammate | Sonnet, or Opus by the rule below | `pipeline.md`, the implementer spawn line |
| Code review | Opus | `scripts/pipeline-review.sh` |
| Auditors | Opus | unchanged frontmatter |
| Verifier | Opus | `pipeline.md`, the verifier dispatch |
| Fixers, every round | Opus | `pipeline.md`, every fixer dispatch |
| Anything the playbook does not name | Opus | `scripts/pipeline.sh`, the backstop variable |
| Close-out routine | Sonnet | the cloud routine, by the owner |

U205's reasons, which ADR-0023 records: Fable where the text is short and
the decision is big, Opus where much code is read or a mistake costs a fix
round, Sonnet for implementing a checked plan, Haiku only for file searches.
The lead writes the spec and orchestrates, and never implements or reviews
code.

## Constraints

- Claude Code resolves a subagent's model in this order: the model the
  dispatch names, the agent definition's `model`, `CLAUDE_CODE_SUBAGENT_MODEL`,
  then the main model. A teammate resolves the same way, with the spawn
  prompt's named model first. Before v2.1.251 the variable came first. The
  installed version is 2.1.322. Sources:
  https://code.claude.com/docs/en/sub-agents.md (Choose a model) and
  https://code.claude.com/docs/en/agent-teams.md (Specify teammates and
  models).
- A fork runs on the main model, even under
  `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`
  (https://code.claude.com/docs/en/sub-agents.md, Run every subagent on one
  model). So nothing the lead dispatches can move `/code-review` off Fable.
- A teammate cannot collect a review or a subagent (ADR-0023). The lead
  collects every finder, verifier and fixer.
- The lead never edits code, a plan or a fix.
- The lead's foreground Bash call ends at ten minutes.
- Git Bash rewrites an argument that starts with `/` into a Windows path
  when it starts `claude.exe` (`scripts/pipeline.sh:17`).

## The design

### The launcher

`scripts/pipeline.sh` keeps its key check and gains four things.

1. It starts the lead with `--model fable --effort high`. The prompt
   `/pipeline <keys>` stays the last argument.
2. It exports `CLAUDE_CODE_SUBAGENT_MODEL=opus`. This is the backstop. A
   dispatch that names a model and an agent whose frontmatter names one
   still get that model.
3. It unsets `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`, so a value in the owner's
   shell cannot flatten the mapping.
4. It unsets `CLAUDE_CODE_EFFORT_LEVEL`, because that variable outranks
   `--effort`.

### The dispatch lines in the playbook

`.claude/commands/pipeline.md` names the model at each dispatch.

- The builder check, the verifier and every fixer are dispatched with
  `model: "opus"`. "Every fixer" covers a numbered round, a round outside
  the two (`owner-<n>`, `gate`, `ci`), a row A retry and a row F gate fixer.
  The phrase "with no `model` override" goes.
- The planner spawn line names Opus, in the form the implementer's line
  already uses for Sonnet.
- The red team's dispatch does not change. Its model comes from the agent
  file, which changes from `model: opus` to `model: fable`.

### The implementer's model

Sonnet is the default. The implementer runs on Opus when the plan's file
list meets the trigger of `rls-auditor`, `append-only-auditor` or
`valuation-verifier`. The lead reads the plan's file list before it spawns
the implementer and judges the triggers the way Review loop step 3 judges
them for a diff, from each agent's description. For a bundle the file list
is in `<state dir>/small-fix-plan.md`.

The lead records the choice in the state file before the spawn, on a new
line of the template:

```
- Implementer model: <sonnet | opus>, because <the files that met a trigger | no trigger met>
```

A respawn after a failed teammate, or a resume, uses the recorded model and
does not judge again.

### The code review

The lead proved the mechanism on 10 Nov 2026 before writing this spec, with
two spikes on Claude Code 2.1.322 (TYRE-476, comments 14181 and the one
after it). In each, `/code-review high` ran as a separate
`claude -p --model opus` process, started by the lead as a background Bash
call, with the range set through the branch's upstream.

| | Planted range | Real range |
| --- | --- | --- |
| Range | one new 24-line script with two planted bugs | the merged TYRE-471 branch, 32 files, 2,570 lines added |
| Wall clock | 53 s | 5 min 39 s |
| Exit, stderr | 0, empty | 0, empty |
| `modelUsage` keys | `claude-opus-5-5` only | `claude-opus-5-5` only |
| `permission_denials` | none | none |
| Subagents the review spawned | 0 | 0 |
| Findings | 9, the two planted bugs first | 10 |
| Files cited outside the range | none | none |

In both, `result` opened with a fenced `json` block holding an array of
findings, each with `file`, `line`, `summary` and `failure_scenario`. The
planted run's `result` went on with a short paragraph of prose after the
block, and the real run's ended at the closing fence, so the script
accepts both. The ticket's fallback, a subagent
that reviews without the skill, was not needed and is not built.

The review moves into `scripts/pipeline-review.sh`, because its checks are
mechanical and a script can be tested where a paragraph of the playbook
cannot.

**What the script does.** It takes the state directory and the review id
`<k>`. From the checkout, it runs:

```
claude -p --model opus --output-format json "/code-review high --max-findings default"
```

with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` unset for that process, since
the review needs no teammate, and with `MSYS2_ARG_CONV_EXCL` covering
`/code-review`. It gives `/code-review` no target, so the review reads the
range the lead set through the branch's upstream (Review loop step 2,
unchanged). `--max-findings` is pinned because the skill keeps the last
value typed, so without it a cap the owner once set in another session
would limit every pipeline review unseen. The value is the owner's choice
(see Settled by the owner). The script passes no permission mode, so the
child takes the owner's. It saves the process's stdout and stderr in the
state directory, one file each, named by `<k>`.

**What it checks.** The review counts only if all of these hold:

- the process exited 0 inside the script's time bound;
- stdout parses as one JSON object with `type` `"result"`, `is_error`
  `false` and `subtype` `"success"`;
- `permission_denials` is empty;
- `modelUsage` has a key that starts with `claude-opus`, and every other
  key starts with `claude-haiku`, which U205 allows for file searches;
- `result` holds a fenced `json` block that parses as an array, and every
  element has a `file`. An empty array is a clean review. A `result` with
  no such block is a failed review, whatever its prose says. The block is
  the reply's only fenced block, and any other line that starts with a
  fence marker fails the review. The block opens with a line that is
  `` ```json `` at the margin and closes at the next line that is `` ``` ``
  at the margin. A fence marker is three or more backticks or tildes after
  any spaces, tabs, `>` and list markers, and the failure names its line.

The last check rests on an output shape that Claude Code does not document.
If a release changes the shape, the check fails and the run stops for the
owner, which is the safe direction: a reply that asks a question, or stops
short, must not end the loop as a clean review (goal 3).

On success it writes `result` to a file in the state directory, prints one
last line `REVIEW: ok` with that file's path, the model keys and the number
of findings, and exits 0. On any failed check it prints
`REVIEW: failed, <the check and what it saw>` and exits non-zero. It never
writes a findings file for a failed review.

`jq` on Windows writes CRLF line ends, so the script strips `\r` from
anything it compares or prints from `jq`, as `scripts/hooks.test.sh:62`
does.

**How the lead uses it.** Review loop step 3 changes in one place. Where it
ran `/code-review high` and waited for a fork, the lead runs the script as
a background Bash call and is woken when it exits. The lead gates on the
exit code and the `REVIEW:` line, never on a file existing
(`docs/lessons.md`, 2026-11-09). It copies the result file into
`findings-<k>.md` beside the auditors' output, as today, and records the
model keys and the finding count on the `Review <k>:` line of the state
file. The auditors, the
verifier and steps 4 to 9 do not change. The lead still compares the files
the report cites with the range's file list, because neither spike could
have caught a review that read a wider diff.

**When it fails.** A non-zero exit or a `REVIEW: failed` line is a finder
that returned nothing. The lead runs the script once more, and a second
failure stops for the owner under "The run cannot go on". CLAUDE.md's row
already covers a review that fails twice.

### The tests

`scripts/pipeline.test.sh` has a stub `claude` that records `$#`, `$1` and
two variables. It must record every argument and the variables below, and
the launch cases pin:

- the arguments are exactly `--model fable --effort high` and then the
  prompt, with the prompt last and intact;
- `CLAUDE_CODE_SUBAGENT_MODEL` is `opus`;
- `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` and `CLAUDE_CODE_EFFORT_LEVEL` are
  unset in the stub even when the caller's environment sets them;
- the agent-teams flag and the path exclusion, as today.

The review script gets its own cases with a stub `claude` that prints a
canned result. Two cases pass: a result with findings, and a result whose
array is empty, which reports a count of 0. One case fails for each check:
a non-zero exit, output that is not JSON, `is_error` true, a permission
denial, a `claude-fable` key in `modelUsage`, no Opus key, a `result` that
is prose with no fenced array, and an array element with no `file`. A case
with a Haiku key beside the Opus key passes. The cases also pin the child's
arguments and that the agent-teams flag is unset for it. They run in
`make test` and in CI, as the launcher's do.

### The documents this makes false

Each of these describes code the branch changes, so the branch corrects it
(CLAUDE.md, Which bugs a branch fixes, `on-path`).

- **ADR-0023.** The "Bad" bullet at line 166 says the finders and the fixer
  run on the session's top model. The Decision says a `/code-review` fork
  returns to the lead. Both get an amendment in the form ADR-0012 uses
  ("Amended <date> (<ticket>, <ruling>)"), with a pointer at each amended
  line. The amendment holds the mapping table, U205's reasons, the review
  as a separate process with its spike (citing TYRE-476 comment 14181), and
  one new consequence: when the implementer runs on Opus, the reviewer is
  on the author's tier, and the auditors that the same files trigger are
  the independent check for that work.
- **`docs/superpowers/specs/2026-11-09-autonomous-runs-design.md`.** Lines
  281 to 283 and line 309 say the finders and the fixer run on the top
  model. Each is corrected to point at ADR-0023's amendment.
- **`.claude/commands/pipeline.md`.** Besides the dispatch lines, the
  sentence "`/code-review` returns as a background fork: wait for its
  result" and the state file template change. The rule that no teammate
  runs `/code-review` stays true and stays.
- **`docs/lessons.md`.** No entry becomes false. The 2026-10-12 and
  2026-11-09 entries describe what a teammate and a lead can collect, which
  holds.

## Settled by the owner

The builder check raised two points only the owner could settle. The owner
answered both with the approval on 10 Nov 2026.

1. **How many findings a review reports.** `--max-findings default`, which
   is what the review loop has run on since ADR-0023. The real-range spike
   returned exactly 10 findings and the planted one 9, so the default cap
   is probably 10. The other choice was `all`. The value may also become
   the saved choice for the owner's own `/code-review` sessions, because
   the skill keeps the last one typed.
2. **An allow rule for the new script.** The owner added
   `Bash(bash scripts/pipeline-review.sh:*)` to `.claude/settings.json`
   and the branch carries that edit as its own commit. A review then never
   waits on a prompt in the middle of the loop. The builder invokes the
   script in exactly that form, `bash scripts/pipeline-review.sh <args>`,
   or the rule does not match.

## Owner's live step

The close-out routine runs in the cloud, and its model is set on the
routine, not in the repo. After this merges, the owner sets it to Sonnet.
The PR body lists the step.

## How we know it worked

- `make test` runs the launcher cases and the review script cases, and
  both pass.
- The next pipeline run (TYRE-474 by the owner's queue) shows, in its state
  file, an `Implementer model:` line and a `Review 0:` line whose model
  keys are Opus.
- The stage 5 review of this branch reads the playbook's prose, which no
  test covers.

This run itself follows the playbook as it was when the run started, so its
own review still runs as a fork on Fable.

## Lead's calls

1. **The backstop behaves as the ticket says.** A named model and an
   agent's frontmatter outrank `CLAUDE_CODE_SUBAGENT_MODEL` on 2.1.322, for
   subagents and teammates
   (https://code.claude.com/docs/en/sub-agents.md, Choose a model;
   https://code.claude.com/docs/en/agent-teams.md, Specify teammates and
   models).
2. **The launcher clears `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`.** With it set,
   Claude Code ignores every named and frontmatter model
   (https://code.claude.com/docs/en/sub-agents.md, Run every subagent on one
   model).
3. **Effort is `--effort high` on the launch, and the launcher clears
   `CLAUDE_CODE_EFFORT_LEVEL`.** The flag sets one session. The variable
   comes first in the precedence list, above the flag and above an agent's
   own effort (https://code.claude.com/docs/en/model-config.md, Adjust
   effort level). The owner's user settings already give
   `claude-fable-5-2` high effort, so today the flag changes nothing. It
   makes the run independent of those settings.
4. **The review is a separate `claude -p` process, not a subagent.** A fork
   cannot leave the lead's model, and print mode expands a `/skill` prompt
   and waits for its result (https://code.claude.com/docs/en/headless.md).
   Proved by both spikes (TYRE-476 comment 14181 and the one after it).
5. **The lead ran the spikes before the spec, not as the first plan task.**
   The implementer is a teammate that may not wait on a background job, and
   the lead is the caller in a real run. A spec with two possible mechanisms
   would have sent both through the plan and the red team.
6. **The review's checks live in a script with tests.** The JSON result
   carries `is_error`, `permission_denials` and `modelUsage` (spike output,
   `<state dir>/spike-review.json`), and `jq` is already a test dependency
   (`scripts/hooks.test.sh:29`).
7. **The child process runs without the agent-teams flag.** The launcher's
   own comment says the flag turns every named subagent into a teammate
   (`scripts/pipeline.sh:15`), and the spike passed with it unset.
8. **Haiku keys pass the model check.** U205 allows Haiku for file searches,
   and Claude Code's built-in Explore agent keeps its own model whatever
   `CLAUDE_CODE_SUBAGENT_MODEL` says
   (https://code.claude.com/docs/en/sub-agents.md, Choose a model).
9. **No test greps the playbook.** A prose check fails on rewording and
   passes on a wrong model named in the right words. The stage 5 review and
   the next run's state file cover the prose.
10. **`/design-audit` at the cap is unchanged.** It names its own model
    (`.claude/commands/design-audit.md:43`), and a named model outranks the
    backstop.
11. **The script checks that `result` holds a findings array.** Both spikes
    returned one (`<state dir>/spike-review.json`,
    `<state dir>/spike-real.json`). Without the check, a reply that reviews
    nothing passes every other check and reads as a clean review. Raised by
    the builder check.
12. **The child takes the owner's permission mode.** Neither spike was
    denied a tool, and a denial fails the review with its name in the
    `REVIEW: failed` line, so a stricter mode shows itself on the first
    run. Print mode's rules are at
    https://code.claude.com/docs/en/headless.md.
13. **No third spike in the plan.** The builder check asked for a
    real-sized spike before the checks were fixed. The lead ran it, and the
    table above holds its result.

## Left to the builder

- File names inside the state directory for the review's stdout, stderr
  and result, and the exact wording after `REVIEW:`.
- The script's time bound. The real-range spike took 5 min 39 s for 32
  files. The bound must leave a large branch several times that and still
  end a hung process within the hour. The tests need a way to set it low.
- Whether the review script's cases sit in `scripts/pipeline.test.sh` or a
  new test file with its own make target. Either way they run in
  `make test`.
- The wording of each playbook edit and of the ADR amendment, within
  `docs/comments.md` and `/unslop`.
