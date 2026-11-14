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
make test           # everything: db, api, web
make lint           # gofmt/prettier check, vet, staticcheck, Bicep lint, actionlint, eslint, tsc, comments, stylelint, Go pins, money paths, bundle
make check          # hooks-install + fmt + lint + test. Run before every commit.
make pipeline T=TYRE-123  # one job (a ticket, or T="TYRE-1 TYRE-2" for a small-fix bundle) to a reviewed PR
```

`make help` lists the rest.

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
(TYRE-250, TYRE-413, TYRE-473). `gate-not-piped.sh` blocks a gate piped into anything, since the
status you read back is the pipe's; `set -o pipefail` is the way through.
`migration-immutable.sh` blocks an edit to a migration already on
`origin/develop` — a migration on a feature branch stays editable, an applied
one is replaced by a new pair. `gh-token-required.sh` refuses a `gh` command in
a local session without the restricted token, which would run on `gh`'s full
stored login; in a cloud session it lets `gh` through, since GitHub sees the
cloud's own login there whatever the token. It does not judge `gh` run through
`timeout` or `env`, such as the playbooks' `timeout 540 gh run watch`, a read
each playbook reaches only after a plain `gh` call has passed the hook. `gate-not-piped.sh` and `migration-immutable.sh`
read the call with `jq` and let it through when `jq` is missing (TYRE-265), so
`jq` must be on `PATH`.

The merge and the push are held by the thing that knows the answer, not by
reading a command's text. In a local session that is the `develop` ruleset (a
pull request is required, U201), the restricted `gh` token and
`.githooks/pre-push`, and `make guard-check` proves them. In a cloud session
GitHub sees the cloud's own login: the ruleset, the cloud's proxy and the push
hook hold a push, and nothing refuses a merge of an open pull request (U213).
`docs/runbooks/github-access.md` says what holds each, what does not, and the
owner's steps.

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

Every ticket runs five stages in order: spec, plan, red team, implement,
code review. `make pipeline T=TYRE-nnn` runs them with an agent team, and
`/ticket` is the manual path. `docs/how-work-runs.md` is the authority for
the stages, small fixes, which bugs a branch fixes, severity, the review
loop and the owner's stops. Read it before you work a ticket, review a
branch, fix a finding or class a bug. Hold these without opening it:

- A bug the branch introduced, or one on its path, is fixed on the branch.
- Nothing that wrote the code reviews it.
- A finding against rules 1 to 3 stops for the owner.
- The owner merges, always.

## Repo etiquette

- Branches: `develop` is the integration branch and what staging runs;
  `main` is what production runs, and it only advances by fast-forwarding to
  a vetted `develop` commit (ADR-0004, ADR-0017). Do not commit to `main`
  directly. `develop` takes a change only through a pull request (ruleset
  21929055, U201).
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
