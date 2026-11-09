# CLAUDE.md

Fleet tyre management platform. Multi-tenant SaaS sold to logistics operators.
Drivers capture tread and pressure per tyre position on a phone; fleet managers
get a live dashboard of condition, value and cost-per-kilometre.

Read this file before doing anything.

**Jira is the current state of the work; Confluence is the authority.** The
SRS, POC scope and agreement, project brief, axle configuration reference and
capture sheet analysis live in Confluence, and `.mcp.json` ships the Atlassian
server. Read a ticket from Jira and the requirements it cites from Confluence,
never from a local copy: anything under `docs/spec/` is untracked and may be
stale. Read the project brief before substantive design work. Search the SRS;
do not read it end to end.

A requirement that does not fit, or a better approach than the SRS
describes, stops the work and is put to the owner. On a yes, the change is
recorded as a comment on the ticket being worked, and the SRS row is
prepared for the owner's Cowork agent. No new ticket is raised, and the SRS
is updated, never worked around (U194, owner, 9 Nov 2026).

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
test. It is never ticketed, and never merged open but for a Minor the owner
accepts at the cap (below). The PR's Decisions name
each fix, so the code review sees it.

An `unrelated` bug is not fixed here. Its evidence goes as a comment on an
open ticket found by a board search for the file or function name, with the
search used. Only when the search finds none is a new ticket raised, linked
to the parent, the ticket whose work found the issue. Decisions names the
bug and its ticket.

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
bug and counts toward the cap in The review loop.

A finding is open until it is fixed, handed to a ticket, set aside under the
schedule test (U130) or ruled by the owner to stay as it is. An owner answer
that orders or shapes a fix leaves the finding open, and the next fixer gets
it with that answer. An `introduced` bug is closed only by a fix, with one
exception: at the cap, the owner may accept an open Minor that is not
against rules 1 to 3. It goes as a comment on the working ticket and the
PR's Decisions name it (U198, owner, 9 Nov 2026).

A finding against rules 1 to 3 below is a bug at any severity. It is
verified even when Minor, and stops for the owner once per finding, whatever
its class. If the owner has an `unrelated` one fixed on this branch, that
fix gets a re-review of its own range and is not one of the two rounds in
The review loop. A fix that needs a live environment step or a decision the
branch cannot make also stops for the owner.

## The capture target

> A driver captures a vehicle in about three minutes, on a phone, in the sun,
> with gloves on.

This is the UX target capture is designed to, not a rule, an acceptance
criterion or a KPI (owner, 29 Sep 2026); web/CLAUDE.md carries the SRS figures.
A completed sheet carries **three tread readings per position**, so a superlink
is 108 numeric entries, not 52, and a change that adds taps or seconds per
position needs a reason that outweighs them. Adoption is the whole game.

## Non-negotiable rules

Carry these without being reminded. Violating one is a bug even if tests pass.

1. **Tenant isolation lives in the database.** Row-level security, never
   application code alone. Two traps, both covered by tests: the app must not
   connect as a superuser (`FORCE ROW LEVEL SECURITY` does not bind one), and
   every view needs `security_invoker = true` or it runs as its owner and
   returns every tenant's rows.
2. **All money is `DECIMAL`/`numeric`.** Never float. Never `float64`. The
   acceptance gate is cent-exact reproduction of a 2021 valuation.
3. **Readings and fitment events are immutable.** Enforced by revoking
   `UPDATE`/`DELETE` from the app role, not by convention. Do not add an
   endpoint that edits one; add a compensating event.
4. **Tread is never a scalar.** It is an ordered set of width-wise readings
   with a materialised `MIN()` as the governing value (CR-011).
5. **Every threshold, band and rate is tenant configuration.** Never a
   hard-coded constant. If you are about to type `4.0` for the removal
   threshold, stop.
6. **Timestamps stored UTC**, displayed in tenant timezone.
7. **Online-first, with a durable submit outbox** (ADR-0009). Reads are
   fetched live; the one thing protected on-device is the in-progress
   inspection, held durably until the server acknowledges it. Do not build an
   offline sync engine, and do not depend on background sync.
8. **`rand_per_mm` lives on the individual tyre**, not on the pattern or size.
   The same pattern appears at R205.71/mm and R284.38/mm in real data.

## Commands

Every command is in the Makefile. Use it rather than remembering flags.

```
make db-up          # Postgres 16 in docker, port 5433
make db-reset       # drop, apply schema, regenerate and load seeds
make db-test        # the verification suite, as a non-superuser
make db-test-privileged  # negative controls that need a superuser to stage
make test           # everything: db, api, web
make fmt            # gofmt + prettier, in place
make lint           # gofmt/prettier check, vet, staticcheck, Bicep lint, actionlint, eslint, tsc, comments, colour literals, Go pins, money paths, bundle
make check          # fmt + lint + test. Run before every commit.
make pipeline T=TYRE-123  # one job (a ticket, or T="TYRE-1 TYRE-2" for a small-fix bundle) to a reviewed PR
```

`make db-test` is the important one. It asserts tenant isolation, append-only
grants, `security_invoker` on every view, all 15 Appendix E valuations to the
cent, and the Appendix J exception set. **If it fails, nothing else matters.**
`make db-test-privileged` runs the one file that runs as `postgres`, and `make
test` and CI both run it after the suite; it is not the suite and proves
nothing about isolation, for the reason its own header gives
(`db/tests/005_privileged.sql`).

## Architecture

See `docs/architecture.md` and the ADRs in `docs/adr/`.

**Where logic belongs:** if it is a business rule about tyres, it goes in SQL
and gets a test in `db/tests/`. If it is about HTTP, auth, or moving bytes, it
goes in Go. Do not reimplement a valuation rule in Go "for speed" — the whole
acceptance gate rests on there being exactly one implementation.

## Code style

Go conventions are in `api/CLAUDE.md` and TypeScript/React ones in
`web/CLAUDE.md`; each loads when you work in that folder.

**UI design skills advise; this file, ADR-0015 and ADR-0020 decide.** `ui-ux-pro-max`
(project plugin) is for design direction: palette, type, layout, UX rules.
`web-design-guidelines` (`.claude/skills/`) is a `file:line` audit for
accessibility, forms, focus and motion; run it over changed UI files before a
PR. Where either one contradicts the repo, the repo wins:

- ADR-0015 is the one styling substrate: `tokens.ts` and plain CSS, Radix for
  the hard controls, inline SVG charts. ADR-0020's Tread design system is
  built on it. No Tailwind, shadcn, GSAP or component library, whatever a
  search result recommends. Fonts stay self-hosted
  (`web/src/theme/fonts.ts`), never a CDN.
- Never run `ui-ux-pro-max` with `--persist`. The token file is the design
  authority, and a `design-system/MASTER.md` would be a second one.
- ADR-0020's Tread design system replaces the TYRE-238 kit and its accepted
  mockups on every route, capture included (epic TYRE-443).

The same precedence holds for `frontend-design`, `dataviz` and `impeccable`.

**Formatting and linting are not advisory.** Every command in `make lint`
can fail the build, and `make lint` runs the same set as CI in the same
order. If a gate cannot run, fix the gate — do not let it pass silently.

Three hooks in `.claude/hooks/` refuse the edit or command rather than warn
after it, because each rule had already been written down and did not hold
(TYRE-250, TYRE-413). `gate-not-piped.sh` blocks a gate piped into anything, since the
status you read back is the pipe's; `set -o pipefail` is the way through.
`migration-immutable.sh` blocks an edit to a migration already on
`origin/develop` — a migration on a feature branch stays editable, an applied
one is replaced by a new pair. `merge-push-guard.sh` refuses a merge through
`gh pr merge` or `gh api`, since the owner merges every PR (U123), and asks
before a push, a ref write or a contents write that lands on `develop` or
`main`, since both deploy (U167). It judges the command's text, so a command
built to evade it can pass; the hook's header names the gaps.

**Comments**
`docs/comments.md` is the full standard; these are the operative rules.
Comment *why*, never *what*. `// increment i` is noise. Never narrate a
change or compare to the old code — git holds the history. One rationale
lives in one place; other files cite it. **One constraint per comment, in
a few lines, with its ID.** Measurements, rejected alternatives and
cross-file storytelling go to `docs/lessons.md`, the ADR or the spec, and
the comment cites the path. A header that needs a page is a doc not yet
written (TYRE-260). `TODO` needs a ticket ID on the same line. Comments and user-facing strings follow `/unslop`: no em dashes,
straight quotes, plain words (the `Prose` section of `docs/comments.md`).
A hook, `make lint` and CI all run `scripts/check-comment-style.mjs`; run
`/comment-audit` when closing out a branch. The comments worth writing here
explain a constraint that is not visible in the code:

```go
// SET LOCAL, not SET: this binds to the transaction so a pooled connection
// cannot carry one tenant's context into the next request.
```

Every non-obvious rule should cite its requirement ID (`FR-VAL-006`,
`CR-011`, `BR-INS-003`) so the code and the spec stay findable from each other.
`db/migrations/000001_init.up.sql` is the reference for the house comment style.

## Testing

- Business rules are tested in SQL, against the golden fixture, not mocked.
- The Appendix J fixture produces exactly **19 exceptions, 11 urgent, 9 running
  positions below the removal threshold**. The database computes them through
  one view, `app.v_exception` (migration 000045), judged at each unit's latest
  inspection; `db/tests/004_tests.sql` §59 pins the numbers and §8 the
  position sets. The API relays that view (B7.2, `GET /api/exceptions`), and the
  dashboard's e2e asserts the rendered counts against it
  (`web/e2e/dashboard.spec.ts`, in the `bac-readonly` project). The
  capture app's leg never reads the view and, being online-first, never
  will: it warns per vehicle at entry from its own independent
  implementation of the same thresholds (`web/src/capture/warnings.ts`).
  "Three tiers agree" means each checks the same pinned expectation
  independently, so a change that moves one without the others is what
  makes a drift visible.
- Do not weaken a test to make it pass. If a test is wrong, say so and explain
  why before changing it.

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
   the top of this file says (U194). Under `make pipeline` the lead writes
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
   `CLAUDE.md` and not under `.claude/`, `api/`, `db/`, `web/` or `infra/`;
   an empty diff is not docs-only. Nothing that wrote the code reviews it,
   because a reviewer that shares the author's context shares its blind
   spots (U192, owner, 9 Nov 2026). Under `make pipeline` the lead runs it,
   because the implementer's final review was a self-review. A teammate
   cannot collect a review; the lead can (ADR-0023). Under `/ticket` a
   separate Claude session, not a subagent of the one that wrote the code,
   runs `/review-pr <n>`. Both follow The review loop below.
   `/code-review ultra` is the owner's to launch. The owner merges only
   once no Critical or Important finding and no `introduced` or `on-path`
   bug is open (U191).

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
An `introduced` or `on-path` bug whose fix would break this definition stops
for the owner: the key becomes a full ticket (for a bundle, the run ends and
the owner relaunches the other keys). Related small fixes may share one PR,
each with its own commit, regression test and short plan in the PR body;
one stage 5 review covers them (U136, owner, 16 Oct 2026).

### The review loop

One full review of the branch, merge base to HEAD, then at most two fix
rounds (U192). A fresh fixer does each round, and the re-review that follows
reads only the commits that round added. A re-review does not look outside
that range, and a verified finding that arrives from outside it anyway is
classified like any other. The loop ends as soon as a review leaves no open
`introduced` or `on-path` bug and no open spec finding (Which bugs a branch
fixes). If one is still open once the second round has closed, however it
closed, the loop is at its cap and stops for the owner, who chooses one more
fix round, a different design for the mechanism (`/design-audit`), ending
the run, or accepting what is open when all of it is Minor (U198). A round that commits nothing gets no re-review, since an empty
range has nothing to review (U196, owner, 9 Nov 2026).

After the loop, a red gate (the lead's own `make lint` and `make test` before
the push, or CI on the pushed head) gets one fresh fixer and a re-review of
that fix's range, outside the two rounds; inside a fix round, a red gate
gets one more fresh fixer in that round. A second red stops for the owner.
An out-of-round fix (an owner-ordered fix, a gate fix or a CI fix) that
leaves something open stops for the owner.

### The stops

A `make pipeline` run waits for the owner at these points and no others:

| Stop                      | When                                                                                                                                                                                         |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product questions         | Large ticket only. One batch, before the spec is written up.                                                                                                                                 |
| Spec approval             | Large ticket only. The written spec, before planning.                                                                                                                                        |
| Red-team dispute          | Large ticket only. A product dispute, or a Critical open after round 3.                                                                                                                      |
| SRS change                | A requirement does not fit, or a better approach exists.                                                                                                                                     |
| Rules 1 to 3              | A verified finding against rule 1, 2 or 3, once per finding.                                                                                                                                 |
| Live step or decision     | A fix needs a live environment step or a decision the branch cannot make.                                                                                                                    |
| Not a small fix           | A key the lead calls not small in a launch of more than one key (a single such key is a large ticket), or an `introduced` or `on-path` fix that would break the small-fix definition.        |
| The cap                   | The review loop reaches its cap, or an out-of-round fix leaves something open.                                                                                                               |
| Red gate                  | A gate is red a second time, inside a fix round or after the loop (The review loop).                                                                                                         |
| A teammate's stop-and-ask | A destructive step, a broken plan, failing baseline tests.                                                                                                                                   |
| The run cannot go on      | A check, a review or an agent fails twice, or the checkout is not in the state the run recorded (wrong branch, dirty tree, a ref that moved). `/pipeline`, When something fails, lists each. |
| The merge                 | Always the owner's.                                                                                                                                                                          |

The push that opens the PR is not a stop (U193, owner, 9 Nov 2026).

## Repo etiquette

- Branches: `develop` is the integration branch and what staging runs;
  `main` is what production runs, and it only advances by fast-forwarding to
  a vetted `develop` commit (ADR-0004, ADR-0017). Do not commit to `main`
  directly.
- Branch: `TYRE-123-short-description`, cut from `develop`. The Jira key is
  what links the branch, the commits and the PR back to the ticket.
- Commits: conventional commits with the key — `feat(capture): TYRE-42 add
  thumb keypad auto-advance`.
- Rebase, do not merge, onto `develop`.
- Run `make check` before committing. CI runs the same thing.

## What this project is NOT

Do not drift into any of these. They come up repeatedly.

- **Not an audit of anyone's fleet.** The sample readings and photographed
  sheets are specification input and test data. Never present them as findings
  about real vehicles.
- **Not the full SRS.** We build the POC subset in SRS Appendix H. The SRS
  marks ~250 requirements Must; Appendix H is the real list.
- **Not a compliance system.** The platform reports the tenant's *configured
  policy* thresholds. It does not determine roadworthiness or legal minimums
  and must never be described as doing so.
- **Not a marketplace.** The tyre-seller marketplace is post-POC (ADR-0003).
  It implies a second customer type, which is a tenancy decision, not a
  feature. Do not build toward it without an explicit decision.
- Out of scope: telematics/TPMS, native apps (PWA only), ML tread reading from
  photos, procurement and accounting integration.

## Questions outside the codebase

Sponsor, commercial, IP and legal questions are handled by the team outside
the project, and Jira carries codebase and infrastructure work only (owner,
29 Sep 2026). The answers already given are recorded in Confluence. One shapes
the schema throughout: tread positions are outer/centre/inner relative to the
vehicle centreline (CHG-010), and pre-convention captures carry
`orientation_known = false`.

## Working with me

- **`docs/lessons.md` is the register of things that did not work.** You may
  edit it without asking: when an approach, tool or command fails in a way
  that would fool the next session too, append an entry in the file's format
  (dated, with the imperative rule) in the same session. Before retrying
  anything that feels like it may have been tried before, check the register —
  an entry there means **do not try it again**; do what the rule says instead.
  It is curated, not a diary: only failures that change how the next attempt
  should behave, never one-off typos or transient errors.
- **Do not force code to work.** A change has to own its place. If a fix
  causes more problems than the one it solves, or only stands up with
  workarounds propped against it, delete it and say so rather than patching
  around it (owner, 6 Sep 2026).
- Prefer `rg` over `grep`, `fd` over `find`.
- Do not create files unless they are needed. No README per directory.
- When you finish a task, run `make check`, not just the test you were working on.
- If you are about to make an architectural decision, write an ADR first —
  `docs/adr/0000-template.md`, and `/adr` scaffolds one.
- If a requirement in the SRS conflicts with the project brief, flag the
  conflict. Do not silently pick one.
- Documentation split: anything ABOUT the code (ADRs, architecture, runbooks)
  belongs in `docs/` and is committed. Anything about the PRODUCT (requirements,
  scope, agreements, domain analysis) belongs in Confluence and is gitignored.
  Do not commit a copy of a spec document "for convenience" — a second copy
  becomes a stale second authority. Process artefacts are a third category:
  design specs (`docs/superpowers/specs/`) are committed because code comments
  cite them; implementation plans and session handoff prompts are gitignored
  (`docs/superpowers/plans/`, `docs/HANDOFF_*.md`) because they describe how a
  batch was run, not how the code works (TYRE-128, 3 Sep 2026).
