# How a ticket runs

The process every ticket follows. CLAUDE.md points here and keeps the SRS
paragraph and the non-negotiable rules this file cites.

## Which bugs a branch fixes

A bug is behaviour that is wrong for an input or state the system can reach,
a raw call as the app role included; a refusal with the wrong code or
message; or a comment, runbook or doc line the code proves false. A missing
feature, an untested path that hides no bug, a nit and a rejected
alternative are not bugs.

Every finding takes one of four classes, whether the branch's own work, its
red team or its stage 5 review made it (U191, owner, 9 Nov 2026). A bug
takes one of these three:

- **`introduced`.** The wrong behaviour does not exist at the merge base.
- **`on-path`.** It is older, and the input that reaches it runs through
  code the branch adds or changes, or it makes the branch's own feature give
  a wrong result. A comment, doc or runbook line is `on-path` when the diff
  touches it or it describes code the branch changes.
- **`unrelated`.** It is older, and neither.

An `introduced` or `on-path` bug is fixed on the branch with a regression
test, and the PR's Decisions name each fix, so the code review sees it. A
blocking one (below) is never ticketed and never merged open. A Minor one is
fixed once, in a fix round or the Minor batch (The review loop); one the run
leaves open goes in the PR under Minors left open, the merge accepts it, and
close-out files it (U191, amended by U212).

An `unrelated` bug is not fixed here. Its evidence goes as a comment on an
open ticket found by a board search for the file or function name, with the
search used. Only when the search finds none is a new ticket raised, linked
to the parent, the ticket whose work found the issue. Decisions names the
bug and its ticket. An `unrelated` Minor, which the verifier does not verify,
has its one line commented on the ticket the search finds, marked unverified;
with none found it goes under Set aside, and no ticket is raised. A new ticket
is raised only for an `unrelated` bug that had the verifier's full pass
(U212).

A finding that is not a bug is `not a bug` and takes the schedule test
(U130), except a spec finding, below: would the owner schedule it before
the pilot? If so, one ticket linked to the parent; if not, one line under
"Set aside" in the PR body. A Minor that is not a bug never becomes a ticket
on its own. Search the board before raising any ticket, and add the evidence
to an open one rather than raise a second. A question for the owner is a
comment on the parent ticket, not a ticket.

A Critical or Important finding that the branch does not do what its own
spec, plan or definition of done requires is a spec finding. It is not a
bug by the definition, but it is fixed on the branch like an `introduced`
bug and is a blocking finding (below).

A finding is open until it is fixed, handed to a ticket, set aside under the
schedule test (U130) or ruled by the owner to stay as it is. An owner answer
that orders or shapes a fix leaves the finding open, and the next fixer gets
it with that answer. An `introduced` bug is closed only by a fix, with two
exceptions for a Minor: one a fixer could not show is true is closed as not
reproduced, with one line under Set aside; and one listed under Minors left
open is closed for the run, never enters a later fixer's input, and is handed
to a ticket by close-out (The Minor batch, U212).

A finding against rules 1 to 3 of CLAUDE.md's non-negotiable rules is a bug at any severity. It is
verified even when Minor, and stops for the owner once per finding, whatever
its class. If the owner has an `unrelated` one fixed on this branch, that
fix gets a re-review of its own range and is not one of the two rounds in
The review loop. A blocking finding whose fix needs a live environment step
or a decision the branch cannot make also stops for the owner; a Minor's goes
under Minors left open (The Minor batch).

### Severity

The verifier gives each code finding one of these, by its effect (U212). A plan
finding takes the red team's own scale (`.claude/agents/plan-red-team.md`).

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

### A blocking finding

A blocking finding is an open finding that is one of these:

- an `introduced` or `on-path` bug at Critical or Important;
- an `introduced` or `on-path` finding against rules 1 to 3, at any
  severity;
- a spec finding.

Only a blocking finding starts a fix round or keeps the loop going (The review
loop).

## How work runs

Every ticket runs these five stages in order, and no stage starts until the
one before it is done (owner, 5 Oct 2026, TYRE-394).
`make pipeline T=TYRE-nnn` runs all five for one job with an agent team, a
lead and teammates that plan and implement, and ends at a reviewed PR
(TYRE-412, ADR-0018). A job is one large ticket, or one bundle of one or
more small fixes (U195, owner, 9 Nov 2026; U136). `/ticket` is the manual
path and walks the stages by hand.

1. **Spec.** `superpowers:brainstorming` writes
   `docs/superpowers/specs/<date>-<topic>-design.md`, which is committed. It
   cites SRS IDs from Confluence and never copies the requirement text. A
   requirement that does not fit stops the stage, as the SRS paragraph at
   the top of CLAUDE.md says (U194). Under `make pipeline` the lead writes
   the spec. It asks the owner the product and preference questions in one
   batch, and settles the engineering ones from primary documentation and
   proven practice, with the source under "Lead's calls". The owner
   approves the written spec (U195).
2. **Plan.** `superpowers:writing-plans` writes
   `docs/superpowers/plans/<date>-<topic>.md`, which is gitignored.
3. **Red team.** Dispatch the `plan-red-team` agent on the spec and the plan.
   Each Critical or Important finding is either fixed in the plan or put to the
   owner, and the agent runs again until it returns no Critical. The verdict
   and the count of findings fixed and ruled on go in the PR body, because the
   plan itself is not committed. Under `make pipeline` the lead rules a
   disputed engineering finding itself, with a source; a product dispute, or
   a Critical still open after round 3, goes to the owner.
4. **Implement.** Use `superpowers:subagent-driven-development` against the
   plan. Under `make pipeline` the implementer uses
   `superpowers:executing-plans` instead, because a teammate cannot collect
   its subagents' results (ADR-0018, ADR-0023). Run `make check`. Under
   `/ticket` the PR opens now; under `make pipeline` it opens after the
   review loop.
5. **Code review.** Every PR that is not docs-only gets this stage. A diff
   is docs-only when every changed file is a `*.md` that is not a
   `CLAUDE.md`, not `docs/how-work-runs.md` and not under `.claude/`, `api/`,
   `db/`, `web/` or `infra/`; an empty diff is not docs-only. Nothing that wrote the code reviews it,
   because a reviewer that shares the author's context shares its blind
   spots (U192, owner, 9 Nov 2026). Under `make pipeline` the lead runs it,
   because the implementer's final review was a self-review. A teammate
   cannot collect a review; the lead can (ADR-0023). Under `/ticket` a
   separate Claude session, not a subagent of the one that wrote the code,
   runs `/review-pr <n>`. Both follow The review loop below.
   `/code-review ultra` is the owner's to launch. The owner merges only
   once no blocking finding is open and the Minor batch has run if one was
   due; the merge accepts each line under Minors left open (U191, amended by
   U212).

When a PR merges into `develop`, a Claude Code routine runs
`/close-out <n> cloud` (ADR-0018). Run `/close-out <n>` by hand only when
the routine did not run or stopped; its comment on the merged PR says which.
By hand it does the same with a local gate.

**Small fixes** skip stages 1 and 3 and keep a short plan in the PR body. A
small fix is one defect with a regression test, no migration, no new endpoint,
route or screen, and no change to a non-negotiable rule. When in doubt, it is
not a small fix. `/ticket` waits for the owner to confirm the small-fix call;
under `make pipeline` the lead makes it per key and states the reason in the
PR body. In a launch of more than one key, a key it calls not small stops,
because it needs its own run; a single such key is a large ticket.
A blocking `introduced` or `on-path` bug whose fix would break this definition stops
for the owner: the key becomes a full ticket (for a bundle, the run ends and
the owner relaunches the other keys). A Minor whose fix would break it goes
under Minors left open (The Minor batch). Related small fixes may share one PR,
each with its own commit, regression test and short plan in the PR body;
one stage 5 review covers them (U136, owner, 16 Oct 2026). A ticket titled
`Minors left open by pipeline runs` (The Minor batch) is a small-fix job of
one key: each of its lines is one defect with its own commit, regression test
and short plan, as the keys of a bundle are, and a line whose fix would break
this definition stops at the row Not a small fix (U212).

## The review loop

One full review of the branch, merge base to HEAD, then at most two fix
rounds (U192). A fresh fixer does each round, and the re-review that follows
reads only the commits that round added. A re-review does not look outside
that range, and a verified finding that arrives from outside it anyway is
classified like any other. Only a blocking finding (Which bugs a branch fixes)
starts a round. An `introduced` or `on-path` Minor never starts one, but every
open one rides in the input of a round that runs anyway. The loop ends as soon
as a review leaves no blocking finding open. If one is still open once the
second round has closed, however it closed, the loop is at its cap and stops
for the owner, who chooses one more fix round, a different design for the
mechanism (`/design-audit`), or ending the run. A round that commits nothing
gets no re-review, since an empty range has nothing to review (U196, owner,
9 Nov 2026; U212, 14 Nov 2026).

After the loop, and after the Minor batch if one ran, a red gate (the lead's
own `make lint` and `make test` before the push, or CI on the pushed head) gets
one fresh fixer and a re-review of that fix's range, outside the two rounds;
inside a fix round, the Minor batch included, a red gate gets one more fresh
fixer in that round. A second red stops for the owner. The lead gates each head
once: a head whose gate passed is not gated again. An out-of-round fix (an
owner-ordered fix, a gate fix or a CI fix) that leaves a blocking finding open
stops for the owner.

### The Minor batch

When the loop has ended with an `introduced` or `on-path` Minor still open, one
fresh fixer gets every such Minor in one round outside the two, the Minor
batch, with the gate. It runs once per run. Its commits get a re-review like
any round's, and nothing that re-review finds is fixed in the run. First, each
`introduced` or `on-path` Minor the re-review found, and each Minor a fixer
reported `not fixed` or otherwise left unfixed, other than one it reported not
reproduced, goes in the PR body under **Minors left open**, one line each with
`file:line`, and is closed for the run. An `unrelated` bug and a finding that
is not a bug go where Which bugs a branch fixes sends them. Then a blocking
finding stops for the owner at The cap; a round the owner orders there that
closes with no blocking finding open ends the loop. A Minor that a re-review
finds once the loop has ended, after a red gate, red CI or an owner-ordered
fix, is listed the same way and not fixed, whether or not a batch ran; one
found before the loop ends rides in the next round or the batch.

A Minor reaches its fixer unverified, since the verifier writes one line for
it. A fixer that cannot show a Minor is true says so, with what it tried, and
leaves it alone: for code, the test that should fail does not; for a comment,
doc or playbook line, the line turns out true when read against the code or
file it describes. That Minor is closed as not reproduced, with one line under
Set aside, and is not filed. A false line is fixed, and the fixer's report says
no test can fail first for a prose line. A Minor whose fix would break the
small-fix definition, contradict the spec, or need a live environment step or a
decision goes under Minors left open, and the run goes on. A blocking finding
has had the verifier's full pass, and those reasons stop the run for it.

After the merge, close-out comments the lines under Minors left open, with the
PR, on the one To Do ticket `Minors left open by pipeline runs`, which it
raises under TYRE-10 at Low priority when none exists. The owner launches that
ticket like any other (Small fixes). On the manual path (`/ticket`), a blocking
finding gets a fix session and `/review-pr <n> <level> from <sha>`; open Minors
alone get one Minor batch session and one such re-review, and the session lists
that re-review's Minors under Minors left open (U212).

## The stops

A `make pipeline` run waits for the owner at these points and no others:

| Stop                      | When                                                                                                                                                                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product questions         | Large ticket only. One batch, before the spec is written up.                                                                                                                                                                             |
| Spec approval             | Large ticket only. The written spec, before planning.                                                                                                                                                                                    |
| Red-team dispute          | Large ticket only. A product dispute, or a Critical open after round 3.                                                                                                                                                                  |
| SRS change                | A requirement does not fit, or a better approach exists.                                                                                                                                                                                 |
| Rules 1 to 3              | A verified finding against rule 1, 2 or 3, once per finding.                                                                                                                                                                             |
| Live step or decision     | A blocking finding's fix needs a live environment step or a decision the branch cannot make.                                                                                                                                             |
| Not a small fix           | A key the lead calls not small in a launch of more than one key (a single such key is a large ticket), or a blocking `introduced` or `on-path` fix, or a line of the Minors left open ticket, that would break the small-fix definition. |
| The cap                   | The review loop reaches its cap, or a round outside the two, the Minor batch included, leaves a blocking finding open.                                                                                                                   |
| Red gate                  | A gate is red a second time, inside a fix round or after the loop (The review loop).                                                                                                                                                     |
| A teammate's stop-and-ask | A destructive step, a broken plan, failing baseline tests.                                                                                                                                                                               |
| The run cannot go on      | A check, a review or an agent fails twice, or the checkout is not in the state the run recorded (wrong branch, dirty tree, a ref that moved). `/pipeline`, When something fails, lists each.                                             |
| The merge                 | Always the owner's.                                                                                                                                                                                                                      |

The push that opens the PR is not a stop (U193, owner, 9 Nov 2026).
