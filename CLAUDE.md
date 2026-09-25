# CLAUDE.md

Fleet tyre management platform. Multi-tenant SaaS sold to logistics operators.
Drivers capture tread and pressure per tyre position on a phone; fleet managers
get a live dashboard of condition, value and cost-per-kilometre.

Read this file before doing anything.

**The specification is not in this repo.** The SRS, POC scope and agreement,
project brief, axle configuration reference and capture sheet analysis live in
Confluence. `.mcp.json` ships the Atlassian server, so fetch them from there —
`docs/spec/` may hold an untracked local mirror for grepping, but it is a
cache, never the authority. Read the project brief before substantive design
work. Search the SRS; do not read it end to end.

## The one constraint everything is subordinate to

> A driver must capture a full vehicle in under three minutes, on a phone, in
> the sun, with gloves on.

A completed sheet carries **three tread readings per position**, so a superlink
is 108 numeric entries, not 52. If a change makes capture slower it is wrong,
however good it looks on the dashboard. Adoption is the whole game.

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
make lint           # gofmt/prettier check, vet, staticcheck, eslint, tsc, comments
make check          # fmt + lint + test. Run before every commit.
```

`make db-test` is the important one. It asserts tenant isolation, append-only
grants, `security_invoker` on every view, all 15 Appendix E valuations to the
cent, and the Appendix J exception set. **If it fails, nothing else matters.**
`make db-test-privileged` runs the one file that runs as `postgres`, and `make
test` and CI both run it after the suite; it is not the suite and proves
nothing about isolation, for the reason its own header gives
(`db/tests/005_privileged.sql`).

## Architecture

See `docs/architecture.md` and the ADRs in `docs/adr/`. In short:

- `db/` — PostgreSQL 16. The business rules live here: valuation functions,
  exception views, RLS policies. This is deliberate, not laziness.
- `api/` — Go. Thin. Auth, tenant context, transport, sync reconciliation.
- `web/` — React + Vite. Two apps: the driver capture PWA and the manager
  dashboard.
- `infra/` — Bicep. Azure.

**Where logic belongs:** if it is a business rule about tyres, it goes in SQL
and gets a test in `db/tests/`. If it is about HTTP, auth, or moving bytes, it
goes in Go. Do not reimplement a valuation rule in Go "for speed" — the whole
acceptance gate rests on there being exactly one implementation.

## Code style

**Go**
- stdlib `net/http` plus `chi` for routing. No web framework.
- `pgx` directly. **No ORM.** RLS requires explicit control of the connection
  and transaction so `SET LOCAL app.tenant_id` binds correctly; an ORM with a
  connection pool will silently leak context between tenants.
- Errors are values. Wrap with `fmt.Errorf("...: %w", err)`. Never `panic` in
  request handling.
- Accept interfaces, return structs. Keep interfaces at the consumer.
- `context.Context` is the first parameter, always.

**TypeScript / React**
- Function components, hooks. No class components, with one named
  exception: `web/src/shell/RouteErrorBoundary.tsx`, because React catches
  a render error only in a class (U54). eslint refuses any other.
- `strict: true`. No `any` — if you reach for it, the type is wrong.
  `@typescript-eslint/no-explicit-any` is an error, not a warning.
- Tanstack Query for server state, plain `useState`/`useReducer` for local.
  No Redux.
- Dexie over IndexedDB for the durable submit outbox (ADR-0009).
- Prettier owns layout — do not hand-format, and do not argue with it in
  review. eslint runs the type-aware recommended and stylistic tiers with
  `eslint-config-prettier` last, so exactly one tool has an opinion about any
  given line.

**UI design skills advise; this file and ADR-0015 decide.** `ui-ux-pro-max`
(project plugin) is for design direction: palette, type, layout, UX rules.
`web-design-guidelines` (`.claude/skills/`) is a `file:line` audit for
accessibility, forms, focus and motion; run it over changed UI files before a
PR. Where either one contradicts the repo, the repo wins:

- ADR-0015 is the one styling system: `tokens.ts` and plain CSS, Radix for the
  hard controls, inline SVG charts. No Tailwind, shadcn, GSAP or component
  library, whatever a search result recommends. Fonts stay self-hosted
  (`web/src/theme/fonts.ts`), never a CDN.
- Never run `ui-ux-pro-max` with `--persist`. The token file is the design
  authority, and a `design-system/MASTER.md` would be a second one.
- Copy stays straight-quoted and sentence case (`/unslop`), not curly quotes
  or Title Case.
- Dates render through `web/src/time/tenantTime.ts` (rule 6) and money through
  `formatRand` in `web/src/api/money.ts` (rule 2), never through `Intl`
  directly.
- The capture route answers to the three-minute rule and its bundle budget
  first. NFR-USE-004 floors its targets at 44px, and the keypad and tiles sit
  at 56 to 64px for gloves. A skill's 44px is that floor, not a size to
  shrink to.

The same precedence holds for `frontend-design` and `dataviz`.
- The dashboard and exceptions mockups accepted at the TYRE-238 gate are
  fixed. The rest of the web app is redesigned in B7.4 (TYRE-240).

**Formatting and linting are not advisory.** Every command in `make lint`
can fail the build, and `make lint` runs the same set as CI in the same
order. If a gate cannot run, fix the gate — do not let it pass silently.

Two hooks in `.claude/hooks/` refuse the edit or command rather than warn
after it, because both rules had already been written down and neither held
(TYRE-250). `gate-not-piped.sh` blocks a gate piped into anything, since the
status you read back is the pipe's; `set -o pipefail` is the way through.
`migration-immutable.sh` blocks an edit to a migration already on
`origin/develop` — a migration on a feature branch stays editable, an applied
one is replaced by a new pair.

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
  position sets. The API will relay that view (B7.2) and the dashboard's e2e
  will assert the rendered counts against it (B7.3), once both land. The
  capture app's leg never reads the view and, being online-first, never
  will: it warns per vehicle at entry from its own independent
  implementation of the same thresholds (`web/src/capture/warnings.ts`).
  "Three tiers agree" means each checks the same pinned expectation
  independently, so a change that moves one without the others is what
  makes a drift visible.
- Go: table-driven tests, `testify/require`. Integration tests hit a real
  Postgres, not a mock.
- Do not weaken a test to make it pass. If a test is wrong, say so and explain
  why before changing it.

## Repo etiquette

- Branches: `develop` is the integration branch; `main` mirrors what
  production/staging runs and only advances by fast-forwarding to a vetted
  `develop` commit (ADR-0004). Do not commit to `main` directly.
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
- **Not a marketplace.** The tyre-seller marketplace is out of scope pending
  OI-29. It implies a second customer type, which is a tenancy decision, not a
  feature. Do not build toward it without an explicit decision.
- Out of scope: telematics/TPMS, native apps (PWA only), ML tread reading from
  photos, procurement and accounting integration.

## Open questions that block work

`docs/open-issues.md` is the live register, mirrored in Jira under TYRE-11.
Nothing blocks code today: the sponsor's 22 Aug 2026 answers closed the old
blockers (OI-28's answer — tread positions are outer/centre/inner relative to
the vehicle centreline — is CHG-010, and pre-convention captures carry
`orientation_known = false`). The open items that shape upcoming work are
OI-29 (tenancy, sponsor acceptance of ADR-0003) and OI-31/32/33.

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
