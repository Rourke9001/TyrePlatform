# Capture bundle ceilings: a limit with headroom, and each PR's size change in CI

Date: 2026-11-12. Ticket: TYRE-474 (epic TYRE-443). Status: approved by
the owner on 12 Nov 2026. Owner ruling U200 (9 Nov 2026, in the ticket). Reverses
U45, a planner's default
(`docs/superpowers/specs/2026-09-10-b7-analytics-dashboard-design.md:129`).
The ticket cites no SRS requirement; this is build tooling, no product
code.

## Intent

The capture route must not pay for the manager app (TYRE-238, ADR-0015).
The gate that holds this records the entry's exact size in
`web/bundle-budget.json` and fails any rise, so a rise is re-recorded with
`--record` or `--record-css`. The 9 Nov 2026 design audit, section 4,
found what that produced (ticket, The problem): 83 commits on the budget
file, the JS figure moved 78 times with 71 rises, about 60 feature or fix
commits forced to carry a byte edit, rebase conflicts on the file in three
PRs, and no recorded refusal that caught a manager-app import. A rise of
one byte from a lazy chunk's new filename hash failed the gate (#146).

A limit that equals the last measurement is a recording, not a budget.
This design makes it a limit: three ceilings with 10% headroom (U200), a
check that fails only past a ceiling, and a CI report that puts each PR's
size change in front of the reviewer, which is how U84 ("the fix is the
import, never the budget") stays in force.

## What the spec-stage reading showed

- **Today's figures equal the recorded ones.** Built on this branch at
  `0555d046` on 12 Nov 2026: entry closure 168821 gzip bytes, entry CSS
  6607 gzip bytes, entry fonts 70188 bytes.
- **A pull request run builds the merge commit, and its first parent is
  the base branch's tip.** `GITHUB_SHA` for `pull_request` is the "Last
  merge commit on the `GITHUB_REF` branch", and the ref is
  `refs/pull/PULL_REQUEST_NUMBER/merge`
  (https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows#pull_request).
  Checked here on PR #182: merge commit `6531306a` has parents `1cf1c06a`
  (the PR's `base.sha`) then `9fff9a9b` (its `head.sha`).
- **`actions/checkout` fetches one commit by default, and its README
  shows `fetch-depth: 2` with `git checkout HEAD^`** under "Checkout
  HEAD^" (https://github.com/actions/checkout).
- **A job summary is markdown appended to `$GITHUB_STEP_SUMMARY`**, at
  most 1 MiB a step, and "Upload failures for job summaries do not affect
  the overall status of a step or a job"
  (https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/workflow-commands-for-github-actions#adding-a-job-summary).
- **size-limit**, the tool the ticket cites, "throws an error if the cost
  exceeds the limit" and tells a JS application to "Add 25% to the current
  total size and use that as the limit" (https://github.com/ai/size-limit).
  web.dev: "A performance budget is a set of limits imposed on metrics
  that affect site performance"
  (https://web.dev/articles/performance-budgets-101). U200 chose 10%.
- **One install, build and check of the web app takes 43 to 65 seconds on
  a runner** (`deploy.yml`'s "Build and check" step, the three develop
  runs of 10 and 11 Nov 2026).
- **`ci.yml`'s Frontend job checks `web/dist` after `bundle:check`**
  (`.github/workflows/ci.yml:269-272`), so nothing may rebuild that
  directory from another commit inside that job.

## Goals

1. `web/bundle-budget.json` holds three ceilings and their reasons, and
   nothing else. A PR that stays under them does not touch the file.
2. `npm run bundle:check` fails only when a figure is past its ceiling,
   and says what to do about it.
3. No flag writes the file. A ceiling moves by a hand edit, with its
   reason in the file and in the PR.
4. Every pull request's CI run shows the three figures for the base and
   for the PR, with the change, in the run's job summary and in its log.
5. The standing docs say what the gate does now. The "only ratchets down"
   lines are gone.

## Non-goals

- The U175 check (the sign-in library in the entry) and the lazy-driver
  check (ADR-0009, rule 7). Both keep their behaviour, and the U175 check
  keeps its self-test. The lazy-driver check has no self-test today: it
  is inline in the main flow (`scripts/check-capture-bundle.mjs:507-521`),
  which this branch rewrites. It becomes a function with self-test cases,
  so a rewrite that drops it fails (red team round 1, I2; the script's own
  rule at `:199`, TYRE-49).
- What is measured: the entry's static closure, JS and CSS in gzip bytes,
  fonts in raw bytes. Unchanged.
- `deploy.yml`. Its `npm run bundle:check` stays and now checks the
  ceilings. A rollback builds an old commit with that commit's own script
  and file, which agree with each other.
- A PR comment, which U200 ruled out, and any token permission beyond the
  workflow's `contents: read`.
- The size report on a push to `develop` or `main`. The change was seen on
  the PR.
- A size report in `make lint`. It needs a second build of another
  commit. `make lint` and CI still run the same checks in the same order
  (CLAUDE.md); the report is not a check.
- `.claude/commands/pipeline.md` and `/review-pr`. Whether the lead or the
  reviewer reads the report is put to the owner with this spec, and is not
  built here.
- An ADR. The gate's purpose and what it measures stand (ADR-0015); this
  changes how the limit is kept.

## Anti-goals

- A ceiling that moves by a command. That is `--record` under a new name.
- A report that can fail without anyone seeing. If the base cannot be
  built or measured, the job is red.
- A report that fails a PR for growing. Growth under the ceiling is the
  reviewer's call, not the gate's.
- Measuring the base with the base's script. On this PR the base's script
  and budget file are the old shape, and on a later PR they may differ
  again.
- A test that greps a doc's prose.

## The design

### 1. The budget file

`web/bundle-budget.json` becomes:

```json
{
  "entryClosureGzipBytes": { "ceiling": 185703, "reason": "..." },
  "entryCssGzipBytes": { "ceiling": 7267, "reason": "..." },
  "entryFontBytes": { "ceiling": 77206, "reason": "..." }
}
```

Each ceiling is today's figure plus 10%, rounded down, so no ceiling is
more than 10% above its figure: 168821 gives 185703, 6607 gives 7267 and
70188 gives 77206. Each reason is one line that names the figure, the date
and U200, for example "168821 on 12 Nov 2026 plus 10% (U200)". If the
implementer's build on the branch gives other figures, the ceilings are
worked out again by the same rule and the PR says so.

`recordedAt`, `cssRecordedAt` and `chunks` are deleted. The three key
names stay, so a search for them still finds the history.

### 2. The check

`scripts/check-capture-bundle.mjs`, run as `npm run bundle:check`:

- **Passes** when each figure is at or under its ceiling, and prints each
  figure, its ceiling and the room left.
- **Fails with exit 1** when a figure is past its ceiling. The message
  names the figure, the ceiling and the overshoot, and says: put the new
  import behind `React.lazy` (never oidc-client-ts, U175); if the growth
  is the capture route's own, raise the ceiling by hand in
  `web/bundle-budget.json` with its reason, and say why in the PR (U84,
  U200). It names no flag.
- **Refuses with exit 2** a budget file that is missing, does not parse,
  or lacks a numeric `ceiling` or a non-empty `reason` for any of the
  three keys. One message covers a file that does not parse; the
  conflict-marker branch and its self-test go. The old shape, a bare
  number under a key, is refused by the same rule, not read as a ceiling.
- **Refuses with exit 2** an argument it does not know, so a `--record`
  typed from habit or from an old doc is not taken for a passing check.
- Every finding still prints before the verdict, so a figure past its
  ceiling cannot hide a U175 or lazy-driver finding, or the other way
  round.

Deleted: `--record`, `--record-css`, `nextBudget`, the two dates and
their plumbing, the write to the file, and the self-tests for the flags,
the dates and the conflict marker (the ticket's Deletes list; its line
numbers are from 9 Nov and the builder works from the code). The script
no longer imports `writeFileSync`.

The self-test keeps the U175 cases and the CSS and font sums, gains two
lazy-driver cases (a `src/capture/` module reached only through a dynamic
import is a finding; one imported statically is not), and its
budget cases become: every figure at its ceiling passes; one byte past a
ceiling is one finding that names that figure and no flag; two figures
past are two findings; a key with no `ceiling`, a key with no `reason`
and a bare number under a key are each refused.

### 3. The size report

A figures mode of the same script reads a build directory it is given and
prints the three figures as JSON. It runs none of the three checks and
reads no budget file, so it can measure a base whose imports or budget
differ. The check and the figures mode share one measuring function; there
is one implementation of what counts as the entry's closure.

A report step takes the base's figures, the PR's figures and the budget
file, and writes one table, to standard output always and to
`$GITHUB_STEP_SUMMARY` when that variable is set:

| Figure | Base | This PR | Change | Ceiling | Room left |
| --- | --- | --- | --- | --- | --- |

One row each for entry JS (gzip), entry CSS (gzip) and entry fonts. Change
is signed bytes and a percentage of the base; a figure that did not move
reads "no change". Under the table, one line: a rise is a decision, so the
PR says which import grew the entry, and the fix for an unplanned rise is
the import (U84). The report exits 0 whatever the change; it exits
non-zero only when it cannot read its inputs or cannot write the summary
(Anti-goals: a report that fails must be seen).

The report's formatting has a self-test: a rise, a fall, no change, and a
figure past its ceiling (room left is negative and the row says so).

### 4. CI

A new job in `.github/workflows/ci.yml`, "Capture bundle size", runs only
on `pull_request`. It is its own job, not steps in Frontend, so the
Frontend job's `web/dist` is never rebuilt from another commit and its
timeout stays measured.

1. Check out with `fetch-depth: 2`. `HEAD` is the merge commit CI builds
   and `HEAD^` is the base branch's tip.
2. Set up Node and pin npm exactly as the Frontend job does.
3. Install and build the PR's tree, and take its figures.
4. Put `HEAD^` in a second directory, install and build it there, and
   take its figures with the PR's script.
5. Write the report.

The job compares the tree the gate checks with the base it would merge
into. The ticket says "the merge base's build"; for a branch rebased onto
`develop`, which is the rule here (CLAUDE.md, Repo etiquette), the two are
the same commit, and for a branch that is behind, the base tip is the
comparison that leaves out other PRs' growth (Lead's call 3).

The job is not in any `needs` list: a deploy runs on a push, where this
job does not run. It carries `timeout-minutes: 10` with a trailing comment
that cites TYRE-474 and this section: two installs and builds at 65
seconds each plus setup is about 2.5 minutes, and
`scripts/check-workflow-timeouts.mjs` asks for at least twice the slowest
pass. The builder measures the job's first passing run and the PR body
records it.

### 5. Docs

A standing instruction changes. A record of what a past branch did stays.

**Change:**

| Where | What |
| --- | --- |
| `web/CLAUDE.md`, The design system, the `bundle:check` bullet and the paragraph under it ("The budget only ratchets down") | The first finding reads "past its ceiling". The paragraph says: three ceilings at 10% headroom (U200); a rise under the ceiling shows in the PR's "Capture bundle size" job summary and the PR names the import; a ceiling is raised by hand with its reason; no flag writes the file. |
| `docs/implementation-order.md`, Constraints every branch carries, the budget paragraph | Rewritten to the same rule. "Each such PR re-records the budget" goes. |
| `docs/superpowers/specs/2026-10-26-tread-frontend-design.md`, The capture route, the budget bullet | Kept, with an amendment note in that file's own style (its `:233`): amended 12 Nov 2026 by U200 (TYRE-474), the budget is a ceiling, and this spec's path. |
| `docs/adr/0020-tread-design-system.md`, Consequences, "The budget only ratchets down, so a rise needs `--record`" | An inline amendment note as ADR-0023 carries (`docs/adr/0023-review-loop-inside-the-run.md:126`), and one sentence added to the Status line's list of amendments. |
| `docs/lessons.md`, "2026-10-21 - A capture entry a byte over budget can be filename noise (#146)" | Deleted. Its rule ends "run `--record`", which no longer exists, and 10% headroom ends the failure it describes. Nothing cites it. |
| `docs/lessons.md`, "2026-09-23 - A dev-only route written as `{x && <Route/>}` ...", the rule's last two sentences | Rewritten: prove a dev-only guard by the entry figure `bundle:check` prints, the same with and without the guarded code, never by a missing chunk and never by the check passing, since a leftover under the ceiling passes. |
| `scripts/check-capture-bundle.mjs`, its comments that name `--record` or a recorded budget | Rewritten with the code. |
| `web/.prettierignore`, the `bundle-budget.json` entry and its comment ("Written by `check-capture-bundle.mjs --record`; nobody hand-writes its layout") | Both deleted. The file is hand-written now, so prettier owns its layout and `format:check` checks it. |
| `scripts/check-workflow-timeouts.mjs`, its header's "the measurements are in docs/superpowers/specs/2026-11-11-bounded-lead-waits-design.md (CI)" | Reworded so it holds for the new job too: each value's measurement is in the design its trailing comment cites. |
| `Makefile`, the `web-bundle` help text | Only if a word of it is now false. |

**Stay, as history:** the b7 spec's U45 and U84 rows
(`2026-09-10-b7-analytics-dashboard-design.md:129`, `:142`); the b9
sign-in spec (`2026-09-30-b9-sign-in-design.md:983-985`); the staging
deploy spec (`2026-10-09-staging-deploy-path-design.md:364`, `:613`); the
library session store spec (`2026-11-10-library-session-store-design.md:686`);
ADR-0016's 4 Nov amendment and ADR-0020's Context, which quote figures
recorded on their dates; `docs/delivery-history.md:594`. Each says what a
branch did when it ran. ADR-0015's revisit trigger ("when the bundle gate
cannot hold the capture route flat without contortion") stays: a gate
that needs its ceiling raised again and again is that trigger.

## Lead's calls

1. **No product question went to the owner before this spec.** U200 and
   the ticket's Design settle the headroom, where the report goes and how
   a ceiling is raised (ticket TYRE-474, Design and Owner ruling U200).
2. **Ceilings are rounded down**, so "plus 10%" is never exceeded. The
   figures are this branch's own build, which equals the recorded file
   (What the spec-stage reading showed).
3. **The report compares the merge commit with its first parent, the base
   tip, not the literal merge base.** It is the tree CI builds
   (https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows#pull_request;
   PR #182's merge commit, above), and `HEAD^` at `fetch-depth: 2` is the
   checkout README's own example (https://github.com/actions/checkout).
   The literal merge base would need the branch's full history and would
   count `develop`'s growth since the branch was cut as the PR's.
4. **Both trees are built in one job, the base in a second directory.**
   The Frontend job's later steps read the PR's `web/dist`
   (`.github/workflows/ci.yml:269-272`).
5. **A separate job, not steps in Frontend.** Frontend's slowest pass is
   3.9 minutes against a 10 minute timeout set at twice that
   (`docs/superpowers/specs/2026-11-11-bounded-lead-waits-design.md`, CI);
   a second install and build there would break the rule the timeout was
   set by. The cost is one more build of the PR's tree, about a minute of
   runner time on a public repository.
6. **The base is measured by the PR's script** (Anti-goals), so the
   figures mode takes the build directory as an argument.
7. **A report that cannot run is a red job; a rise is not.** U84's
   visibility rests on the report existing (ticket, "U84 stays, through
   the delta report"); the ceiling is the only size that fails a PR
   (ticket, Design).
8. **An unknown argument is refused.** The script ignores one today
   (`scripts/check-capture-bundle.mjs:11-12` read two flags and nothing
   checks the rest), so a stale `--record` would run the check and print
   OK.
9. **A reason is required beside each ceiling**, checked by the script
   (ticket, Design: "with a one-line reason").
10. **The 2026-10-21 lesson is deleted, not rewritten**
    (`docs/lessons.md:1-5`: an entry that cannot be written as a rule is
    not a lesson). The 2026-09-23 lesson keeps its finding and gets a rule
    that still holds.
11. **No ADR and no amendment to ADR-0015.** Its decision and its revisit
    trigger read true as they stand (`docs/adr/0015-ui-substrate.md:130-133`).
12. **From the builder check** (one question and a rider, both settled
    here): the budget file leaves `web/.prettierignore`, since the reason
    for the entry was the flag that wrote it
    (`web/.prettierignore:17-20`); and the timeout lint's header is
    reworded, since the new job's measurement is in this spec, not the one
    it names (`scripts/check-workflow-timeouts.mjs:6-8`).

## Rejected

- **size-limit itself.** A new dependency and its plugins in the capture
  app's lockfile, to replace a measuring function that stays and already
  reads the Vite manifest's closure, which size-limit does not.
- **Caching the base's figures by commit, or reading them from the base's
  own CI run as an artifact.** Faster, but the artifact route needs
  `actions: read` and a base run that may have expired, and a cache adds a
  key to get wrong. A second build costs about a minute.
- **A PR comment or a check annotation.** U200: the job summary.
- **Keeping `--record` for the rare ceiling raise.** The ticket: "never by
  a flag". A flag made 71 rises routine.

## Constraints

- The report job first runs on this PR's own CI run. Before the push it
  is proved by the report's self-test and by running the figures mode
  against the local build; the lead reads the job's log at hand-over
  (`gh run view --log`) as the acceptance evidence. This branch changes no
  file under `web/src`, so that first report must show no change in all
  three rows.
- This PR's diff touches `ci.yml`, so a red CI job on it cannot use the
  "touches no file in the diff" re-run unless it ended `cancelled` or
  `timed_out` (`.claude/commands/pipeline.md`, Hand-over step 4).
- `scripts/check-workflow-timeouts.mjs` fails a `runs-on` job with no
  `timeout-minutes`, and `actionlint` runs over the workflow
  (`make infra-lint`).
- Actions are pinned to commit SHAs with the version in a trailing
  comment (`ci.yml:40-42`); the new job reuses the SHAs the file already
  pins.
- The implementer is a teammate: it runs gates in the foreground, does
  not push, and dispatches no subagent.
- Comments and user-facing strings follow `docs/comments.md`. The
  script's messages are user-facing strings.
- `web/.prettierignore:17-20` excludes `bundle-budget.json` today because
  `--record` wrote it. That entry goes (Docs), so the file is laid out as
  prettier leaves it (`printWidth: 100`) and `format:check` covers a hand
  edit. `.claude/hooks/format.sh` runs the same prettier on an edited
  `*.json`.

## What is left to the builder

- The names of the figures mode's flag and its directory argument, and
  whether the report is a mode of `check-capture-bundle.mjs` or a small
  script beside it with its own self-test. Either way the check's
  self-test and the report's run in `make lint` (through `web-bundle`) and
  in CI.
- How the base reaches a second directory (`git worktree add`, or
  `git archive` piped to `tar`), as long as the PR's checkout and its
  `web/dist` are untouched and the PR's script does the measuring.
- The job's id and its step layout, the exact table text and number
  formatting, and the wording of each message and reason line.
- The wording of each doc change in the table above.
- Whether the over-ceiling message prints the largest chunks. It prints
  the chunk list today and may keep doing so.

## Acceptance

- `web/bundle-budget.json` holds the three ceilings 185703, 7267 and
  77206, each with a reason, and no other key.
- `npm run bundle:check` passes on the branch and prints the room left.
  With a ceiling edited to one byte under its figure it exits 1 and names
  that figure; with the old-shape file, a file that does not parse, or no
  file, it exits 2; with `--record` it exits 2.
- `rg -n -e "--record" -e "nextBudget" -e "recordedAt" -e "chunks:" scripts/check-capture-bundle.mjs web/bundle-budget.json`
  finds nothing.
- `--self-test` passes and covers the cases in The check and The size
  report.
- The PR's CI run has a green "Capture bundle size" job whose summary and
  log show the table with "no change" in all three rows, and the job does
  not run on a push.
- Every row of the Docs table is done, and `rg -n -e "ratchets" -e "bundle-budget" web/CLAUDE.md docs/implementation-order.md web/.prettierignore`
  finds only `web/CLAUDE.md`'s mention of the file by name.
- `make check` is green.
