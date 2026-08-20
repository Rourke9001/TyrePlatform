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
7. **Offline-first**, designed in, never retrofitted.
8. **`rand_per_mm` lives on the individual tyre**, not on the pattern or size.
   The same pattern appears at R205.71/mm and R284.38/mm in real data.

## Commands

Every command is in the Makefile. Use it rather than remembering flags.

```
make db-up          # Postgres 16 in docker, port 5433
make db-reset       # drop, apply schema, regenerate and load seeds
make db-test        # the 16-check verification suite, as a non-superuser
make test           # everything: db, api, web
make fmt            # format all languages
make lint           # vet + staticcheck + eslint + tsc
make check          # fmt + lint + test. Run before every commit.
```

`make db-test` is the important one. It asserts tenant isolation, append-only
grants, `security_invoker` on every view, all 15 Appendix E valuations to the
cent, and the Appendix J exception set. **If it fails, nothing else matters.**

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
- Function components, hooks. No class components.
- `strict: true`. No `any` — if you reach for it, the type is wrong.
- Tanstack Query for server state, plain `useState`/`useReducer` for local.
  No Redux.
- Dexie over IndexedDB for the offline queue.

**Comments**
Comment *why*, never *what*. `// increment i` is noise. The comments worth
writing here explain a constraint that is not visible in the code:

```go
// SET LOCAL, not SET: this binds to the transaction so a pooled connection
// cannot carry one tenant's context into the next request.
```

Every non-obvious rule should cite its requirement ID (`FR-VAL-006`,
`CR-011`, `BR-INS-003`) so the code and the spec stay findable from each other.
`db/migrations/001_schema.sql` is the reference for the house comment style.

## Testing

- Business rules are tested in SQL, against the golden fixture, not mocked.
- The Appendix J fixture produces exactly **19 exceptions, 11 urgent, 9 running
  positions below the removal threshold**. The database, the capture app and
  the dashboard each compute this independently. Keep all three agreeing — a
  change that breaks one and not the others is then visible immediately.
- Go: table-driven tests, `testify/require`. Integration tests hit a real
  Postgres, not a mock.
- Do not weaken a test to make it pass. If a test is wrong, say so and explain
  why before changing it.

## Repo etiquette

- Branch: `TYRE-123-short-description`. The Jira key is what links the branch,
  the commits and the PR back to the ticket.
- Commits: conventional commits with the key — `feat(capture): TYRE-42 add
  thumb keypad auto-advance`.
- Rebase, do not merge, onto `main`.
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
The one that blocks code today: **OI-28 — which of the three tread boxes is
outer, centre and inner.** It blocks the capture screen layout and the
interpretation of every historical sheet.

## Working with me

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
  becomes a stale second authority.
