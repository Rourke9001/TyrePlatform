# Tyre Platform

Multi-tenant tyre management for road transport operators. Drivers capture
tread and pressure per tyre position during a walk-around; fleet managers get a
live view of condition, estate value and cost-per-kilometre.

**Status:** proof of concept. Nothing here is deployed.

## Quick start

```bash
make db-up        # Postgres 16 in docker on :5433
make db-reset     # schema + regenerated seeds
make db-test      # the verification suite — start here
```

`make db-test` should end with `ALL CHECKS PASSED`. It asserts tenant
isolation, append-only grants, `security_invoker` on every view, all fifteen
reference valuations to the cent, and the golden fixture's exact exception set:
**19 exceptions, 11 urgent, 9 running positions below the removal threshold.**

If it passes as `postgres` rather than `app_login`, it has proved nothing —
superusers bypass row-level security. Check 0 inside the suite catches this.

## Layout

```
db/          PostgreSQL 16. The business rules live here, deliberately.
  migrations/  schema, RLS policies, roles, valuation functions, views
  seeds/       generators — the source of truth for the axle configuration library
  tests/       the verification suite, run in CI on every build
api/         Go. Thin: auth, tenant context, transport, sync reconciliation.
web/         React + Vite. Driver capture PWA and manager dashboard.
infra/       Bicep. Azure.
docs/adr/    Architecture decision records.
```

## Where things are

| | |
|---|---|
| Tracker | Jira `TYRE` — https://rourke9001.atlassian.net/jira/software/projects/TYRE |
| Specification | Confluence space `TYRE` — SRS v1.3, POC scope, project brief |
| Architecture | `docs/architecture.md` and `docs/adr/` |
| Working agreement | Confluence → Specification → POC Scope & Working Agreement |

The specification is not in this repository on purpose. See `.gitignore`.

## Read first

`CLAUDE.md` — the constraints, the commands, and the seven rules that are not
negotiable. It is written for an agent but it is the fastest orientation for a
human too.
