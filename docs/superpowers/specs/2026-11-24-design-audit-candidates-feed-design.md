# Design audit candidates reach their ticket by themselves

Date: 2026-11-24. Ticket: TYRE-494. Status: written for the owner's
approval. Builds on
`docs/superpowers/specs/2026-11-14-loop-exit-and-cloud-close-out-design.md`
(the Minors left open feed, U212), ADR-0018 and ADR-0023. No SRS requirement
is cited: this is run tooling, and the project brief (Confluence 10321923)
covers the product, not how a ticket runs.

## Intent

A review's verifier recommends `/design-audit <mechanism>` when a finding
lands on a mechanism that an earlier fix round, or an earlier PR, already
fixed (`.claude/commands/review-pr.md:115-118`). A pipeline run acts on that
only at the cap (`.claude/commands/pipeline.md:616`). When no blocking
finding is open the run goes on, and the recommendation survives only as a
sentence the lead happens to write in the PR body's Set aside list.
TYRE-325's run (PR #248) made three. Two were carried to the ticket by
hand, and the third was dropped with no rule that said to drop it (What
the reading showed).

The owner wants every such recommendation on one standing ticket,
`Design audit candidates from pipeline runs` (TYRE-493), to judge together in
one pass before the pilot release. This design makes the playbooks feed that
ticket, the way the Minor batch feeds `Minors left open by pipeline runs`.

## What the reading showed

- `/design-audit` is named in five places: `review-pr.md:83`, `:117` and
  `:140`, `pipeline.md:616` and `docs/how-work-runs.md:192`. None says where
  a recommendation goes when the run does not stop for it.
- A report ends with the list of cited files outside the range and the line
  `Scope: <n> files cited, <m> outside the range`
  (`review-pr.md:118-121`). The pipeline lead reads the report itself and
  decides on its text (`pipeline.md:558-559`).
- The Minors left open feed has four links: a state file line
  (`pipeline.md:887`), a PR body heading
  (`.github/pull_request_template.md:43-48`), Hand-over step 2
  (`pipeline.md:720-729`) and a close-out paragraph
  (`.claude/commands/close-out.md:143-153`). The close-out paragraph already
  works in cloud mode, where a ticket's parent link cannot be written.
- The hand-filed comment on TYRE-493 (comment 14367) gives the shape the
  owner has seen: one comment per PR, each mechanism once, with its files,
  the finding IDs and how many times the run fixed it. It joins two
  recommendations the reports worded differently, review 1's on CR-A and
  the Minor batch re-review's on CR-M1 and CR-M2, into one candidate about
  focus after the Void button goes.
- That comment leaves one recommendation out. Review 0 of TYRE-325's run
  recommended an audit of "a query's error branch over cached data",
  because its finding CR-1 landed on a mechanism TYRE-334 had fixed on
  another screen. Fix round 1 fixed CR-1 and no later review came back to
  it, and neither the PR body nor the comment carries it. Whether such a
  recommendation is a candidate is the question under For the owner.
- No script reads these files. `rg` for the playbook names under `scripts/`
  and `.github/workflows/` finds only `scripts/pipeline-wait.sh`, which
  names `pipeline.md` in a comment. `make lint` checks their prose through
  `scripts/check-comment-style.mjs`, which reads every `.md`.

## Goals

1. A report that recommends a design audit lists it as one line under a
   "Design audit candidates" heading, on both paths (`/review-pr` and the
   pipeline's verifier).
2. A pipeline run records each line in its state file and its PR body
   carries them under their own heading.
3. After the merge, close-out comments the PR's lines on the standing
   ticket, and raises that ticket when none is open.
4. `docs/how-work-runs.md` states the rule: what a candidate is, that it
   never blocks, and where it goes.

## Non-goals

- Changing when `/design-audit` runs. The cap still runs its own audit, and
  nothing else in a run starts one.
- Changing `/design-audit` itself. The owner's pass before the pilot names
  the mechanism to audit; the command does not read the ticket.
- Moving candidates that older PR bodies hold as Set aside sentences. PR
  #248's are on TYRE-493 already, and no pipeline PR is open today.
- What happens to TYRE-493 after the pilot pass. Its own definition of done
  says so.

## Anti-goals

- A candidate that blocks a merge, starts a fix round, or is counted as a
  finding with a class or a severity.
- A second standing ticket, or a ticket per candidate.
- A step the owner must take for a pipeline run's candidate to reach the
  ticket.
- A test that greps playbook prose
  (`docs/superpowers/specs/2026-11-10-pipeline-model-per-step-design.md:65`).

## Constraints

- A report uses the class words (`introduced`, `on-path`, `unrelated`,
  `not a bug`) only on `Class:` lines (`review-pr.md:105-106`), and the lead
  counts findings from them. A candidate line uses none of them.
- `Scope:` stays the last line of a report.
- Close-out in cloud mode never calls `executeWrite` and cannot read
  anything gitignored (`close-out.md:39-44`). The PR body is the only record
  it can read.
- `/review-pr` is report only (`review-pr.md:6-7`). It does not edit the PR
  body.
- The fixer brief and the verifier brief are given verbatim. A change to
  either is a change every later run carries.
- Prose follows `docs/comments.md`, Prose. `make lint` enforces part of it.

## Approaches

**A. The PR body carries the lines and close-out files them (chosen).** The
report lists them, the lead copies them to the state file and the PR body,
and close-out comments them after the merge. It is the Minors left open
feed again, so it needs no new mechanism, works on the manual path, and
works in the cloud because the PR body is public. Its cost is one more
heading in the template and one more paragraph in four playbooks.

**B. The lead comments on TYRE-493 at hand-over.** Fewer files. It files
before the merge, so a PR closed unmerged leaves a comment about code that
never landed, and the manual path is not covered.

**C. Close-out reads the run's review reports.** No PR body heading. The
reports are gitignored and local, so the cloud close-out cannot read them.

**D. No list: `/design-audit` scans the reports before the pilot.** It
already reads them as a signal. The owner asked for one ticket to read, and
a state directory deleted to relaunch a key takes its reports with it.

## For the owner

One question only the owner can answer, and the design below is written to
the answer the lead recommends.

**Is a recommendation still a candidate once a later round has fixed the
finding that raised it?** The recommended answer is yes: every
recommendation a report makes is a candidate. The signal is that a
mechanism drew a fix again, and a second fix does not take that back. An
earlier PR's fix followed by this PR's is the "recurred across runs" case
TYRE-493 names as a reason to audit. The other answer, only mechanisms with
a finding still open at hand-over, gives a shorter list and needs a rule
for removing a line. On a yes, the lead adds TYRE-325's third candidate to
TYRE-493 by hand.

## The design

### 1. The report (`.claude/commands/review-pr.md`, step 5)

Every report has a "Design audit candidates" list, placed after the set
aside and dropped lists and before the list of files outside the range, so
`Scope:` stays last. It holds one line for each `/design-audit`
recommendation the report makes, or the word `none`. The verifier form
writes it too, since it follows step 5.

A line reads:

```
- <the mechanism in plain words>; files: <path>[, <path>]; findings: <ID>[, <ID>]; fixed <n> times (<the rounds or PRs that fixed it>)
```

`<n>` counts the earlier fixes the reviewer can show: fix rounds of this
PR, from the previous report and the range's commits, and earlier PRs it
names. The recommendation stays in the finding as it does today. Files the
list cites count toward `Scope:` like any other cited file.

The reply paragraph gains one sentence: list the report's candidates for
the PR body's Design audit candidates heading, as it lists open Minors for
Minors left open.

### 2. The pipeline run (`.claude/commands/pipeline.md`)

- **Review loop step 4.** After the `Review <k>:` line, the lead records
  each recommendation as a `Design audit candidates:` line in the state
  file. It takes them from the report's list and from any finding that
  recommends an audit the list missed, since the lead decides on the
  report's text. A run holds one line per mechanism: a line for a mechanism
  already recorded replaces the earlier one and keeps the finding IDs of
  both. Two recommendations name the same mechanism when the report says
  the later one repeats or stands on the earlier, or when the later
  finding sits in code the earlier candidate's fix changed. The wording of
  the mechanism does not decide it. When the lead cannot tell, both lines
  stay: the owner reads the list once, and a duplicate costs less than two
  mechanisms joined. A line is never removed because a later round fixed
  its finding (For the owner). Recording a candidate is not an action of
  step 5 and changes nothing step 6 judges.
- **The cap (step 9).** Its text does not change.
- **Hand-over step 2.** The PR body gets a Design audit candidates section
  with each state line, and the heading is deleted when there are none. A
  candidate whose mechanism a cap audit of this run covered carries that
  audit's report path at the end of its line, so the owner's pass sees it
  is done. No candidate goes under Set aside.
- **A round outside the two, once the PR is open** (`pipeline.md:648-650`).
  New candidate lines go into `pr-body.md` with the round's other lines.
- **Hand-over step 5.** The message says how many candidates the PR body
  lists and that close-out files them after the merge. It is not a step the
  owner owes.
- **State file template.** One line:
  `- Design audit candidates: <mechanism>; files: <paths>; findings: <IDs>; fixed <n> times (<where>); report <path>`.

### 3. The PR template (`.github/pull_request_template.md`)

A `## Design audit candidates` heading between Minors left open and Set
aside, with a comment in the template's style: one line per mechanism a
review recommended `/design-audit` for; never a finding, never blocks the
merge; close-out files them; delete the heading when there are none.

### 4. Close-out (`.claude/commands/close-out.md`, step 6)

A paragraph beside Minors left open, of the same shape. Read the PR body's
Design audit candidates list. If it has lines, search for
`project = TYRE AND status = "To Do" AND summary ~ "Design audit candidates"`
and take the hit whose summary is exactly
`Design audit candidates from pipeline runs`, the lowest key if more than
one. If there is none, raise one: Task, that summary, Low, parent TYRE-10,
with the same cloud-mode form the Minors left open paragraph uses. Its
description says it is a standing list, one comment per PR, that the owner
judges in one pass, and cites `docs/how-work-runs.md`. Comment the lines on
the ticket in one comment, with the PR number.

The lines are not Set aside residuals, are not read for bugs, are not among
the items the step limits to two, and are not misses for the owner.

### 5. The manual path (`.claude/commands/ticket.md`, step 12)

The session that works a fix round or the Minor batch adds the candidate
lines of the report it was given to the PR body, with the Decisions lines
it already adds, one line per mechanism by the test in section 2.

A review that no such session follows leaves a gap. `/review-pr` is report
only, so its reply lists the candidates and says they reach the PR body
only if the owner tells that session to add them. That is the step the
Minor batch re-review's Minors already need on this path. It is written
down as a gap, not closed: the manual path is the fallback, every session
on it is one the owner starts, and an exception to report only would be a
second change to a rule for a path the owner rarely uses. The same holds
for a review the owner runs on a pipeline PR after hand-over.

### 6. The rule (`docs/how-work-runs.md`, The review loop)

A short subsection after The Minor batch, "Design audit candidates". It
says:

- A review that finds a new finding on a mechanism already fixed, in an
  earlier round or an earlier PR, recommends `/design-audit` on it. That
  recommendation is a design audit candidate.
- A candidate is not a finding. It takes no class and no severity, never
  starts a round, never blocks a merge and is not fixed in the run. The
  finding that raised it is handled by its own class and severity as
  before.
- The report lists it, the PR body carries it under Design audit
  candidates, and after the merge close-out comments it on the one To Do
  ticket `Design audit candidates from pipeline runs`, which it raises
  under TYRE-10 at Low priority when none exists.
- The owner judges the list in one pass before the pilot release
  (TYRE-493): audit now, after the POC, or drop.
- At the cap the run still runs its own audit (The review loop, above).

The rule cites the owner ruling that approves this spec, proposed as U252.

### 7. Tests

None is added. No script reads these files, and a test that greps playbook
prose is an anti-goal. The gate is `make check`, whose comment standard
reads every edited file. The definition of done is checked by reading.

### 8. This run

The lead of this run works from the playbook as it was at launch, so its
own reviews are not bound by the new text. If one of them recommends a
design audit, the lead puts the line under the new heading in the PR body
by hand. Close-out runs from `develop` after the merge, on the new text, so
it files that line itself. With no candidate in this run, the first live
proof is the next merged PR whose body has a line.

## Not covered

- A run that ends at the cap opens or merges no PR, so close-out never
  reads its candidates. They stay in the state file until the owner deletes
  that directory. The cap's own audit, and the owner's choice there, cover
  the mechanism that stopped the run.
- A close-out run twice on one PR comments twice, as it does for Minors
  left open.
- The candidates of a manual-path review that no session follows (section
  5).
- `/code-review ultra` and a review the owner runs outside the playbooks.

## Definition of done

- `review-pr.md` step 5 tells every report, the verifier's included, to
  list each recommendation under Design audit candidates, or `none`.
- `pipeline.md` records the lines in step 4, carries them in Hand-over
  step 2 and after a late round, and has the template line. Step 9 is
  unchanged.
- The PR template has the heading.
- `close-out.md` step 6 comments a merged PR's lines on the standing ticket
  and raises it when missing, in local and cloud mode.
- `ticket.md` step 12 carries the list on the manual path.
- `docs/how-work-runs.md` states the rule, and no playbook tells anyone to
  carry a candidate in Set aside.
- `make check` exits 0.

## Lead's calls

- **The list is always in a report, `none` when empty, and sits before the
  outside-the-range list.** A missing heading then reads as an omission,
  not as none, and `Scope:` stays the last line (`review-pr.md:118-121`).
- **The lead also records a recommendation the list missed.** It reads the
  whole report and decides on its text (`pipeline.md:558-559`), so a missed
  line costs no second verifier dispatch.
- **One line per mechanism per PR, the later line replacing the earlier.**
  This is the shape of the hand-filed comment the owner has read (TYRE-493,
  comment 14367).
- **A candidate the cap audited keeps its line, with the audit report's
  path.** TYRE-493's definition of done wants each candidate marked
  audited with its report path, and dropping the line would lose a Replace
  verdict the owner chose not to act on at the cap.
- **The cap-audit note is written at Hand-over step 2, not in step 9.** The
  ticket says the cap is unchanged.
- **No ADR.** The change repeats the Minors left open feed's pattern and
  makes no architectural choice (CLAUDE.md, Working with me).
- **No new test.** No script reads the six files (`rg` over `scripts/` and
  `.github/workflows/`), and the model-per-step spec rules out a prose grep
  (`2026-11-10-pipeline-model-per-step-design.md:65`).
- **Close-out's new paragraph copies the Minors left open paragraph's
  cloud-mode form** (`close-out.md:143-153`), which the cloud routine
  already runs.
- **A run that ends at the cap is not covered.** The ticket scopes the feed
  to a merged PR, and the cap's own audit covers the blocking mechanism.
- **The same-mechanism test is the report's own word or shared fixed
  code, and a doubt keeps both lines.** It gives comment 14367's joining
  of CR-A with CR-M1 and CR-M2, since review 1 says CR-A lands on CR-2's
  fix (`review-1.md:166` in TYRE-325's run directory).
- **The manual path's last review is a written gap.** The owner accepts a
  documented gap over a recurring hand step (TYRE-481), and `/review-pr`
  stays report only (`review-pr.md:6-7`).

## Left to the builder

- The exact wording of each edit, within `docs/comments.md`, Prose, and the
  one-constraint-per-sentence style the playbooks use.
- Whether the verifier brief in `pipeline.md` needs a clause. Step 5 of
  `review-pr.md` already binds the verifier; add one only if the brief's
  own overrides would otherwise read as excluding the list.
- The description text of a ticket close-out raises, within section 4.
- Where in step 12 of `ticket.md` the sentences sit.

## Rejected

- Approaches B, C and D, for the reasons under Approaches.
- Dropping a cap-audited candidate from the list (Lead's calls).
- Making `/design-audit` read the standing ticket as a signal. The owner's
  pass picks the mechanism; a second reader of the list is a second
  authority on what to audit.
- A `Design audit candidates:` count on the `Review <k>:` state line. The
  lines themselves are the record.
