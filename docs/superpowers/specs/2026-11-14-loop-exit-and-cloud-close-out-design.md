# The pipeline's review loop ends on severity, the process text leaves CLAUDE.md, and the cloud close-out runs without a token

Date: 2026-11-14. Ticket: TYRE-481 (epic TYRE-10), with its comment 14219
as Part 6. Status: draft, waiting for the owner's approval. The ticket
cites no SRS requirement: this is pipeline tooling and instruction files,
no product code.

It amends U191 (an `introduced` or `on-path` bug is never merged open and
never ticketed), U192 (what keeps the review loop going) and U198 (a Minor
accepted at the cap). U196 (the cap fires when round 2 closes), U193 (the
push is not a stop), U194, U195 and U123 (the owner merges) stand. It
reverses the cloud half of TYRE-473's spec
(`docs/superpowers/specs/2026-11-13-branch-write-controls-design.md`,
section 2 and lead's call 16).

The owner answered the product questions on 14 Nov 2026 at 10:01Z. The
cloud routine keeps running close-out as it did before PR #215, because a
hand-run close-out is input the owner does not want. The lead holds the
rulings in this run and takes the recommended loop rule; the owner asked
what a Minor is and what net catches one. This run's own review loop uses
the new rule. The answers are verbatim in the run's state file.

This spec departs from the ticket in four places:

1. Part 2 gains a definition of severity for a code finding, which the
   repo does not have, and a net for the Minor batch (section 2).
2. Part 6 does not find a control that holds a merge in the cloud. The
   probe and the docs show there is none the owner can set. The spec says
   so, the owner accepts it, and the repo stops claiming otherwise
   (section 6).
3. Part 5 leaves dated specs and ADR bodies unedited and marks them
   (section 5).
4. The docs-only rule gains the new process file, which would otherwise
   skip its own code review (section 5).

## Intent

A large ticket takes most of a working day and the feature is the small
part. TYRE-473's review loop ran 4h20m. Every finding its three fix rounds
worked was Minor, most were sentences in docs and comments, and each round
wrote new prose in which the next review found 2 to 5 new Minors. Four of
the seven runs from 10 to 14 Nov went to round 3 and three ended on
accepted Minors (the ticket's table).

The owner wants a ticket to run from launch to a reviewed PR, and from the
merge to a reconciled board, with as little of the owner's input as the
work allows. Three things stand in the way today. The loop treats a loose
sentence like a broken feature. The cloud close-out has stopped at its
first check since #215 merged. And the red team cannot read Jira, because
its tool list names a connector that is gone.

## What the spec-stage reading showed

- **No file defines severity for a code finding.** `rg` finds
  definitions only for plan findings (`.claude/agents/plan-red-team.md:47-48`).
  `/code-review` gives none, and the verifier assigns it
  (`.claude/commands/pipeline.md`, Review loop step 4). The new exit test
  rests on a word the repo never defined.
- **The verifier's disproof pass already covers only Critical, Important
  and rule 1 to 3 findings** (`.claude/commands/review-pr.md:70-74`). Its
  16 to 23 minutes go on classing and writing up every Minor in full.
- **The four process sections are 1828 of CLAUDE.md's 4121 words**
  (lines 23-80 and 247-355). 53 citations in 15 tracked files name them,
  29 of those in `.claude/commands/`. Five dated specs and two ADRs are
  among the 15. No script, lint or workflow reads CLAUDE.md.
- **The docs-only rule would misjudge the new file.** A diff is docs-only
  when every changed file is a `*.md` outside a short list
  (`CLAUDE.md:281-284`). A process file under `docs/` is such a file, so a
  PR that rewrote the loop's rules would skip stage 5.
- **In the cloud GitHub sees the cloud's own login, not a set token.**
  The owner's probe of 14 Nov in session `cse_0157iMkHfr6VsWT98RzeKMi3`
  (TYRE-473 comment 14220): `gh api -i user` reported a credential that
  expires the same day; a REST merge call on the already merged #215
  answered 200; the ref write got the proxy's own 403. In that run rows 1
  to 4 of `make guard-check CLOUD=1` were OK and row 5 UNCHECKED (comment
  14218). Row 3 reads the ruleset with the cloud's login, so GitHub's
  pull request rule on `develop` binds that login.
- **The docs name no setting that limits a cloud session on GitHub.**
  code.claude.com/docs/en/cloud-environments: the proxy "rejects branch
  deletions and pushes of anything other than a branch" and "doesn't limit
  which branches a push can update. To do that, use branch protection
  rules or rulesets on GitHub." It is silent on merging a pull request.
  code.claude.com/docs/en/routines: "Anything a scheduled task does
  through your connected GitHub identity or connectors appears as you."
  GitHub cannot tell the owner's merge from one made as the owner.
- **A cloud session is marked.** code.claude.com/docs/en/env-vars:
  `CLAUDE_CODE_REMOTE` is "Set automatically to `true` when Claude Code is
  running as a cloud session... Read this from a hook or setup script to
  detect whether you are in a cloud session". The docs do not say it for a
  routine's run by name, so the probe below reads it.
- **Before #215 the cloud's merge was held by text too.**
  `merge-push-guard.sh` read the command's text, the design audit's
  verdict on it was Replace, and #215 deleted it. Keeping the routine
  returns to a merge held by instructions, with one fewer layer.

## Goals

1. A fix round and its re-review run only for a finding that should block
   a merge. Minor bugs are still fixed, once, and never keep the loop
   going.
2. A Minor the run leaves open is written down where the owner and
   close-out both read it, and close-out files it.
3. The lead gates each head once.
4. The verifier writes one line for a Minor.
5. CLAUDE.md loses the process text, and every session that needs it is
   told to read it.
6. The cloud close-out runs again with no token, and every line in the
   repo says what holds a cloud session and what does not.
7. The red team and the allow rules name tools the connector has.

## Non-goals

- A control that stops a cloud session merging a pull request. None
  exists that the owner can set (above). Section 6 records the gap.
- A change to who merges, to the red team's rounds, or to the spec stage.
- A lint that checks citations. Definition of done item 6 is one `rg`.
- The `atlassian` server in `.mcp.json`, which still names the v1
  endpoint. Sessions use the claude.ai connector, and v1 goes on
  1 Mar 2027, after the pilot. It fails the schedule test and goes under
  Set aside.
- TYRE-473's five Minors accepted under U211. They stay closed.

## Anti-goals

- A Minor batch that can start a second batch. The loop would be back.
- A process file CLAUDE.md imports with `@`. The import loads on every
  request and the saving is gone.
- A cloud check that passes by asking for a token that does nothing.
- A rule that lets a Critical or Important bug, or a rule 1 to 3 finding,
  merge open.

## Constraints

- **This run edits its own rules.** The lead follows the playbook it was
  launched with. Section 8 lists the three places where this run departs
  from it.
- **The red team runs before its tool list is fixed.** The lead pastes
  the ticket and comment 14219 into this run's red-team dispatch. A
  running session does pick up an edited agent file
  (code.claude.com/docs/en/sub-agents: "the next delegation uses the
  updated definition, with no restart needed"), so after implementation
  the lead can prove the fix with one dispatch.
- **The cloud proves itself only after the merge.** The first cloud
  close-out, this PR's own, is the proof, and it fails closed. The owner
  removes the token before merging, so that run has none. The owner's
  probe before approval (section 6) reads the facts the design rests on
  in a cloud session, so a wrong one is found now. The docs call a
  routine's run a cloud session and do not say by name that the variable
  is set in one, which only that first close-out can show.
- Rule numbers in `docs/runbooks/github-access.md` and row numbers in
  `scripts/guard-check.sh` are cited by the script's messages, its tests
  and the 473 spec. Neither is renumbered.
- Dated specs are records
  (`docs/superpowers/specs/2026-11-13-branch-write-controls-design.md:779-781`
  leaves a deleted mechanism named "only in dated records"). Their bodies
  are not rewritten.

## Approaches

**The loop.** Three were weighed.

- *Keep fixing every bug in rounds, with a higher cap.* The runs show
  the loop does not converge on prose, so a higher cap costs more hours.
- *List Minors and fix none.* Fastest, and most Minors would reach
  `develop` unfixed. The owner asked for a net, not a list.
- *Block on what should block; fix Minors once; review that one batch
  and list what is left.* Chosen. It is the common practice: Google's
  review guide has reviewers "favor approving a CL once it is in a state
  where it definitely improves the overall code health", and marks a
  minor comment "Nit: This is a minor thing. Technically you should do
  it, but it won't hugely impact things"
  (google.github.io/eng-practices/review/reviewer/standard.html and
  /comments.html). Conventional Comments separates a blocking comment
  from a non-blocking one the same way (conventionalcomments.org).

**The cloud.** Three were put to the owner.

- *Close-out runs locally by hand.* The restricted token holds a merge
  there. The owner rejected it: it is input after every merge.
- *A GitHub rule that tells the owner's merge from the cloud's.* The
  cloud acts as the owner, so a rule cannot tell them apart. The shapes
  left are an approval from a second GitHub account on every PR, or a
  cloud login that cannot push close-out's docs branch. Each costs more
  than it saves.
- *Keep the routine, drop the token, say what is not held.* Chosen, on
  the owner's answer.

**The process text.** A plain file under `docs/` with a pointer in
CLAUDE.md, against an `@` import (loads every request) and against
`.claude/rules/` with `paths:` (process text belongs to no path).

## The design

### 1. The connector's names

`.claude/agents/plan-red-team.md`, `tools:` becomes `Read, Grep, Glob,
Bash` and four connector tools: `mcp__claude_ai_Atlassian_MCP__getJiraIssue`,
`...__listJiraIssueComments`, `...__searchConfluence` and
`...__getConfluenceContent`. Its body says to read the ticket and its
comments.

`.claude/settings.json`, the 12 `Atlassian_Rovo` allow rules become these
12, all `mcp__claude_ai_Atlassian_MCP__`: `getJiraIssue`,
`listJiraIssueComments`, `searchJiraIssuesUsingJql`, `getConfluenceContent`,
`searchConfluence`, `getAccessibleAtlassianResources`, `search`,
`addOrEditJiraIssueComment`, `transitionJiraIssue`, `createJiraIssue`,
`discover` and `executeRead`.

`executeWrite` is not allowed ahead. It runs any write the connector has,
Confluence pages included, and the old list allowed no Confluence write.
An issue link now goes through it and asks once.

`.claude/commands/ticket.md` step 1 names `listJiraIssueComments` beside
`getJiraIssue`: the v2 `getJiraIssue` returns a comment count, not the
comments, and this ticket's Part 6 was a comment.

### 2. The loop ends on severity (owner ruling U212)

**Severity of a code finding.** The verifier assigns it, by these
definitions, which go in the process file under Which bugs a branch
fixes:

- **Critical.** On an input or state the system can reach, it loses or
  corrupts data, shows one tenant another's rows, gets money wrong, lets
  through an action a control is there to hold, or leaves the branch's
  own feature not working.
- **Important.** A user, an operator or a later session meets wrong
  behaviour in normal use that is not Critical: a wrong result on an
  ordinary input, a refusal with the wrong code, a check that reports the
  wrong state, or a doc, runbook or playbook line that sends its reader
  to a wrong action.
- **Minor.** Any other bug: wrong only at an edge that fails safe, a
  message or explanation that is loose while the action it leads to is
  right, a comment or doc sentence the code proves false that nobody acts
  on.

When the verifier cannot choose between Minor and Important, it is
Important.

**A blocking finding** is an open finding that is one of these:

- an `introduced` or `on-path` bug at Critical or Important;
- an `introduced` or `on-path` finding against rules 1 to 3, at any
  severity;
- a spec finding.

**The rule.**

1. The loop is one full review, then at most two fix rounds, each with a
   re-review of its own commits, as today. It ends as soon as a review
   leaves no blocking finding open. The cap is unchanged (U196), and its
   options are one more fix round, a different design, or ending the run.
   Accepting a Minor at the cap goes, because a Minor no longer reaches
   the cap.
2. An `introduced` or `on-path` Minor is still fixed on the branch. While
   a fix round is still to run, every open one rides in that round's
   input beside the blocking findings. It never causes a round.
3. When the loop has ended with any such Minor open, the lead runs **the
   Minor batch**: one fresh fixer, given every open one, then Close a
   round as for any round. It is a round outside the two, with the id
   `minor`. A red gate on it gets one gate fixer, and a second red stops
   (Red gate).
4. **The net.** The batch gets a re-review of its own commits, like any
   round that commits. Nothing that review finds is fixed in the run:
   - a blocking finding stops for the owner at the row The cap, as for
     any round outside the two that leaves something open;
   - an `introduced` or `on-path` Minor, and any Minor the batch's fixer
     could not fix, goes in the PR body under a new heading, **Minors
     left open**, one line each with `file:line`;
   - an `unrelated` bug and a finding that is not a bug go where they go
     today.
5. The owner merges once no blocking finding is open and the Minor batch
   has run if one was due. The merge accepts each line under Minors left
   open. This replaces U198's acceptance at the cap.
6. **Close-out files them.** For a merged PR with lines under Minors left
   open, close-out comments them, with the PR, on the ticket found by
   `project = TYRE AND status = "To Do" AND summary ~ "Minors left open"`.
   When the search finds none it raises one Task, "Minors left open by
   pipeline runs", under TYRE-10 at Low priority, and comments there.
   The search takes only a ticket nobody has started, so a ticket being
   worked gets no new lines, and the lines its own PR leaves open start
   the next one. This amends U191's "never ticketed" for these lines
   only.

   The owner launches that ticket like any other. Small fixes gains one
   sentence so it runs as a small-fix job: each of its lines is one
   defect with its own commit, regression test and short plan, as the
   keys of a bundle are. A line whose fix would break the small-fix
   definition stops at the row Not a small fix, as today.
7. A finding against rules 1 to 3 still stops for the owner once, at any
   severity and in any class, before anything else is done with it.

On the manual path `/review-pr` reports by the same rule. A blocking
finding gets a fix session and `/review-pr <n> <level> from <sha>`. Open
Minors alone get one Minor batch session and one such re-review, whose
Minors the caller lists in the PR body.

**What it costs.** The batch's edits are reviewed once and what that
review finds waits for a later bundle. A Minor can sit on `develop` for
days. That is the trade the owner asked for.

### 3. One gate per head

- The lead records each gate it runs in the state file as
  `Gate: <full sha>; lint exit <code>, test exit <code>; <UTC time>`.
- The lead runs the gate on a head only when no `Gate:` line records
  lint exit 0 and test exit 0 for that sha. Close a round and Hand-over
  step 1 both read the line first. On TYRE-473 that skips the 9 minute
  hand-over gate on `7b22738b`.
- The fixer brief drops the full gate. A fixer runs `make fmt`, then the
  tests its fixes touch, and reports each command with its exit code.
  The lead's gate is the one that counts, and a red one gets a gate fixer
  as today.
- On the manual path no lead follows a fixer, so the session that
  dispatched it runs `make lint` and `make test` before it pushes.
  `ticket.md` step 12 says so.

### 4. The verifier writes one line for a Minor

The verifier brief in `pipeline.md` and the verifier's form in
`review-pr.md` change together:

- Every raw item first gets a severity by section 2's definitions.
- An item that could be Critical or Important, any item against rules 1
  to 3 and any spec finding gets the full pass: the disproof against the
  code and the spec, and the full report entry.
- Every other item gets one line: its ID, `file:line`, what is wrong in
  a clause, and its `Class:` line, read from the diff against the review
  base without reproducing the bug. A dropped item keeps a one-clause
  reason.
- The count check stays: every raw item appears in the report.

A Minor is therefore unverified when a fixer gets it. The fixer brief
says so: where the failing test cannot be made to fail, the fixer says
that, with what it tried, and leaves the code alone. The lead closes that
Minor as not reproduced and gives it one line under the PR's Set aside.
It is not listed under Minors left open and not filed. This holds for a
Minor only. A blocking finding has had the verifier's full pass, and a
fixer that cannot reproduce one stops and reports, as the brief has it
today.

### 5. The process text moves to `docs/how-work-runs.md`

**The file.** `docs/how-work-runs.md` takes the four sections in their
present order and wording, with sections 2 and 3 of this spec applied:
Which bugs a branch fixes (with Severity and the blocking finding), How
work runs (the five stages and Small fixes), The review loop, The stops.
Their cross-references ("below", "the SRS paragraph at the top of this
file") are fixed for the new file.

**What CLAUDE.md keeps.** One short section, How work runs, in about 120
words:

- the five stages by name, and that `make pipeline` or `/ticket` runs
  them;
- that `docs/how-work-runs.md` is the authority for the stages, small
  fixes, which bugs a branch fixes, severity, the review loop and the
  owner's stops, written as a plain path with no `@`;
- that a session reads it before it works a ticket, reviews, fixes a
  finding or classes a bug;
- the lines a session must hold without opening it: a bug the branch
  introduced or that sits on its path is fixed on the branch; nothing
  that wrote the code reviews it; a finding against rules 1 to 3 stops
  for the owner; the owner merges, always.

The SRS paragraph at the top, the non-negotiable rules and every other
section stay.

**Smaller cuts in CLAUDE.md.** The Commands block keeps `make db-up`,
`db-reset`, `db-test`, `test`, `lint`, `check` and `pipeline`, says
`make help` lists the rest, and keeps the paragraph on `make db-test`.
The paragraph on the merge and the push shrinks to what holds them and a
citation of `docs/runbooks/github-access.md`, corrected for the cloud
(section 6).

**The docs-only rule** gains the file: a diff that changes
`docs/how-work-runs.md` is not docs-only.

**Citations.**

- Live files are repointed to "`docs/how-work-runs.md`, <section>":
  `.claude/commands/pipeline.md`, `ticket.md`, `review-pr.md`,
  `close-out.md`, `design-audit.md`, `.claude/agents/plan-red-team.md`,
  `.github/pull_request_template.md` and `docs/implementation-order.md`.
  The briefs inside `pipeline.md` count.
- Each command and agent that tells its reader to read CLAUDE.md first
  names the process file beside it.
- The five dated specs that cite a section get one italic line under
  their title and no other edit: the CLAUDE.md sections this spec cites
  have lived in `docs/how-work-runs.md` since TYRE-481, and its
  `CLAUDE.md:<line>` citations are as of its date. The colour gate spec
  cites only a line number and gets the line too.
- ADR-0018 and ADR-0023 get a dated amendment at the end, as TYRE-473
  amended ADR-0018, and their bodies stay.

### 6. The cloud close-out runs without a token (owner ruling U213)

**What holds a cloud session, stated once**, in the runbook:

| A cloud session tries | What answers |
| --- | --- |
| A push to `develop` | GitHub refuses: ruleset 21929055 requires a pull request, and the cloud's login cannot bypass it (row 3, read in the cloud) |
| A REST ref write, a branch delete, a push of a tag | The cloud's proxy refuses |
| A merge of an open pull request | Nothing refuses. `/close-out`'s cloud paragraph says never, and the routine's prompt only points at `/close-out` (ADR-0018). The owner accepts this (U213) |
| A fast-forward of `main` | `.githooks/pre-push`, which cloud mode installs, refuses without `TYRE_PROMOTE=1`; a production deploy waits for the owner's approval |

**`scripts/guard-check.sh --cloud`** runs rows 1, 2 and 3 and no other.
Rows 4 and 5 read a token that GitHub never sees there, and row 6 was
already local only. The row numbers stay. The Makefile's help line and
the script's header say which rows cloud mode runs.

**`.claude/hooks/gh-token-required.sh`** exits 0 when
`CLAUDE_CODE_REMOTE` is `true`, before it looks for the token: in the
cloud `gh` runs on the cloud's login whatever token is set. Its refusal
message loses "step 4 in the cloud". A local session that sets the
variable itself skips the hook, which joins `env -u GH_TOKEN` under What
this does not hold.

**`docs/runbooks/github-access.md`.**

- The opening says the three controls hold a local session, and points
  to the table above for the cloud.
- Step 4 keeps its number and becomes "The cloud close-out needs no
  token": what the probe showed, the table, and the owner's one clean-up,
  which is to remove `GH_TOKEN` from the routine's environment and revoke
  `tyre-claude-cloud`. The owner does it just before merging this PR, as
  a box on the PR, so the first close-out runs with no token and proves
  the routine works without one. Its check is that close-out's usual
  report.
- Step 6 loses "or step 4".
- What this does not hold gains the merge in the cloud, and the hook's
  variable.

**`.claude/commands/close-out.md`**, cloud mode: the paragraph keeps
`make hooks-install` and `make guard-check CLOUD=1`, says a refused `gh`
call still stops the run with the push notification, and gains one line:
never merge a pull request and never call a merge endpoint, because in
the cloud only this line holds it.

**Other lines the probe proved false.**

- CLAUDE.md's merge and push paragraph, and its hooks paragraph on
  `gh-token-required.sh`.
- ADR-0018: a dated amendment that withdraws the 13 Nov amendment's
  sentence on the routine's restricted token and gives the table.
- The 473 spec: one italic line above section 2, above the cloud
  sentence of section 6 and above lead's call 16, each pointing here.
- `docs/lessons.md`, the entry of 14 Nov: its last sentence, "Until
  TYRE-481 lands...", becomes what TYRE-481 did. Its rule already says a
  cloud control is probed in the cloud, which the ticket's definition of
  done asks for.

**The owner's probe, before approval.** In a cloud session on the
routine's environment, with nothing changed:

```
printenv CLAUDE_CODE_REMOTE
env -u GH_TOKEN gh api user --jq '.login, .type'
env -u GH_TOKEN gh api repos/Rourke9001/TyrePlatform/rulesets/21929055 --jq .current_user_can_bypass
```

The design needs `true`, the owner's login, and `never`. Their output
goes here before the status line says approved. A different answer
changes this section, not the others.

*Probe result:* pending.

### 7. Tests

- `scripts/guard-check.test.sh`: cloud mode prints rows 1 to 3 and exits
  0 with no token and with any answer to the ref write; it makes no ref
  write and no dry run; a missing ruleset still fails row 3 in cloud
  mode. The cases that named step 4 for rows 4 and 5 in cloud mode go.
- `scripts/hooks.test.sh`: the `gh` hook passes with
  `CLAUDE_CODE_REMOTE=true` and no token, and still refuses with the
  variable unset, empty or `false`.
- `scripts/hooks.test.sh` already reads `.claude/settings.json` with
  `jq`; one case asserts no allow rule names `Atlassian_Rovo`.
- The playbooks are prose and have no test. Definition of done items 2
  to 6 are read against the files.

### 8. This run

The lead follows the playbook it was launched with, and departs from it
in three places, on the owner's answer of 14 Nov:

1. Review loop step 6 judges by section 2: only a blocking finding
   starts a fix round, and open `introduced` and `on-path` Minors ride in
   it.
2. After the loop the lead runs the Minor batch and its re-review as
   section 2 has them, with the launch playbook's fixer brief and Close a
   round.
3. The verifier and the fixers read the branch's own `review-pr.md` and
   process file, so they work by the new text. Each dispatch says so.

Sections 3 and 4 otherwise first apply to the next run.

## Not covered

- A cloud session the owner starts outside the routine can also merge.
  The runbook's list says so.
- Whether a routine's run honours the repo's `permissions.deny` and
  `PreToolUse` hooks. The docs say a one-repository cloud session does
  and do not name routines. The `gh` hook now passes in the cloud either
  way, so the design does not depend on it.
- A Minor batch whose fixer is wrong in a way the gate and one review
  both miss reaches `develop`. So does any bug every review misses.
- The time a product ticket's loop takes. All seven measured runs were
  tooling.

## Definition of done

1. `plan-red-team.md` and the allow rules name tools the connector has,
   and after implementation the lead dispatches `plan-red-team` once to
   read TYRE-481 with its comments and one Confluence page, and records
   what it read on the ticket. If that dispatch still has the old tools,
   the next run's red team is the proof, recorded on this ticket.
2. U212 and U213 are comments on TYRE-481, and the process file,
   `pipeline.md` and `review-pr.md` state section 2's rule with the same
   definitions.
3. Hand-over step 1, Close a round and the fixer brief say when the full
   gate runs, and the state file template has the `Gate:` line.
4. The verifier brief and `review-pr.md` say which raw items get the
   full pass.
5. `docs/how-work-runs.md` holds the four sections, and CLAUDE.md holds
   the pointer, with no `@` before the path.
6. Two searches hit only the dated specs that carry the italic line,
   the two ADRs that carry the amendment, this spec, and CLAUDE.md's own
   pointer:
   `rg --hidden -g '!.git/' -U -P 'CLAUDE\.md\W{1,4}(\w+\W+){0,3}?(How\s+work\s+runs|Which\s+bugs|The\s+review\s+loop|The\s+stops|Small\s+fixes)'`
   and
   `rg --hidden -g '!.git/' -U -P "CLAUDE\.md's\s+(small-fix\s+)?(definition|meaning\s+of\s+open|schedule\s+test|stops\s+table|row)"`.
   ADR-0023's bullets name the sections under one "lives in CLAUDE.md"
   line, which its amendment answers.
7. `make guard-check CLOUD=1` runs rows 1 to 3, with its cases in
   `scripts/guard-check.test.sh`, and the `gh` hook's cloud cases are in
   `scripts/hooks.test.sh`. `make check` is green.
8. Each line section 6 lists is corrected.
9. Owner, just before the merge: remove `GH_TOKEN` from the routine's
   environment and revoke `tyre-claude-cloud`. It is a box on the PR.
10. After the merge: the first cloud close-out, this PR's own, runs with
    no token and posts its usual report. TYRE-473's definition of done
    item 7 closes on it. If its `gh` calls are refused, the owner gets
    the push notification and section 6 is wrong about the routine.
11. The next large ticket's state file shows its review loop's time, for
    comparison with 4h20m. That run records it on this ticket.

Items 9 to 11 are the owner's, the close-out's and the next run's to
record. The run that builds this cannot.

## Lead's calls

1. **Severity is defined in the process file, by effect.** Nothing
   defined it for code (`.claude/agents/plan-red-team.md:47-48` covers
   plans only). The split into blocking and not follows
   google.github.io/eng-practices/review/reviewer/comments.html and
   conventionalcomments.org.
2. **Minors ride in a round that runs anyway.** The round's re-review
   then covers their fixes at no extra pass.
3. **The Minor batch is a round outside the two.** Close a round, the
   gate fixer and the re-review already exist for one
   (`.claude/commands/pipeline.md`, A round outside the two), so the
   batch adds a judge rule and no new mechanism.
4. **One unstarted ticket takes the Minors left open, and it runs as a
   small-fix job.** It is the `unrelated` bug's path, a comment on a
   ticket found by a board search (CLAUDE.md, Which bugs a branch
   fixes), so it cannot repeat the 29 tickets in 10 days that U130
   answered. The search reads `status = "To Do"` so a ticket being worked
   is never added to, and never closed over lines nobody worked (the
   builder check's question 2).
5. **The fixer runs `make fmt` and its own tests, with no lint.** The
   PostToolUse hooks already format and check comment style on each edit
   (`.claude/settings.json:94-107`), and the lead's gate follows.
6. **`executeWrite` is not allowed ahead.** It is one tool for every
   write the connector has (the connector's own description: "non-destructive
   creates/updates"), and the old list allowed no Confluence write
   (`.claude/settings.json:41-52`).
7. **A plain path in backticks, not an `@` import.**
   code.claude.com/docs/en/memory: "Imports help you organize a long file
   but don't reduce its context cost, because imported files load
   together with the CLAUDE.md that imports them." The same page keeps
   `.claude/rules/` files without `paths` "loaded at launch", and one
   with `paths` loads "when Claude works with matching files", which
   process text has none of.
8. **Dated specs get one line, ADRs an amendment.** Specs are records
   (`docs/superpowers/specs/2026-11-13-branch-write-controls-design.md:779-781`);
   ADR-0018's amendment of 13 Nov is the pattern
   (`docs/adr/0018-ticket-orchestration.md:106`).
9. **No new ADR.** ADR-0023 says the loop's rules live outside it
   (`docs/adr/0023-review-loop-inside-the-run.md:135-136`), and ADR-0018
   already decides that a routine runs close-out. Both are amended.
10. **The hook reads `CLAUDE_CODE_REMOTE`.** code.claude.com/docs/en/env-vars
    documents it for hooks. Keeping an unused token so a prefix check
    passes would be a prop against the design (CLAUDE.md, Do not force
    code to work).
11. **Runbook step numbers and check row numbers stay.** The script's
    messages and its tests cite them
    (`scripts/guard-check.sh:72-122`, `scripts/guard-check.test.sh:145-157`).
12. **The token goes before the merge, not after.** Then this PR's own
    close-out is the first run with no token, and proves it (the builder
    check's question 1). Until the merge the cloud close-out stops at its
    first check either way (`docs/lessons.md:52-53`).
13. **A Minor a fixer cannot reproduce is closed, not filed.** Nobody
    verified it, so filing it would put an unproved bug on the board.
14. **Part 6 stays in this run.** With the owner's answer it has no
    design question left and one probe, so it is not split out.
15. **This run pastes the ticket into its red-team dispatch.** The
    agent's tool list is stale until this merges.

## Left to the builder

- The wording of every moved and changed line, in the repo's prose
  standard (`docs/comments.md`).
- The file names and state lines for the `minor` round, in the pattern
  of the other rounds outside the two, and the stage name the state file
  records for it.
- How `guard-check.test.sh` restructures its cloud cases.
- Whether `createJiraIssue` can carry a parent and a link in one call,
  read with `discover`, for close-out's standing ticket.
- How the red team gets the connector's `cloudId`, which all four tools
  need: the site's hostname in the agent's body, or
  `getAccessibleAtlassianResources` as a fifth tool.
- The exact italic line for the dated specs, the same in each.

## Rejected

- **Dropping the cap's design audit.** It still fits a blocking finding
  that two rounds did not close.
- **A re-review whose Minors start a second batch.** The loop again.
- **Fixing Minors before the blocking rounds.** Their fixes would be
  reviewed twice.
- **Close-out reviewing the batch after the merge.** The review needs the
  Opus review process in the checkout, and the routine runs on Sonnet in
  the cloud (ADR-0023's table). Close-out files what the run's review
  found.
- **Moving the non-negotiable rules too.** Every session needs them.
- **Rewriting the dated specs' citations.** They are records.
- **A deny rule for the merge endpoint.** It reads command text, the
  mechanism TYRE-473 deleted
  (`docs/superpowers/specs/2026-11-13-branch-write-controls-design.md:876-878`).
- **Keeping `tyre-claude-cloud` as a marker.** A credential that does
  nothing and can leak.
