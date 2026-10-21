# ADR-0021: The governing-tread definer runs as the migrating role

- **Status:** Accepted (owner, 21 Oct 2026, U147 A14)
- **Date:** 2026-10-21
- **Deciders:** Rourke
- **Related:** TYRE-350 (this record), TYRE-399, TYRE-305 comment 13834,
  TYRE-347, TYRE-256, TYRE-437 · migrations 000004, 000050, 000051 · suite
  sections 65 and 67, check 8c · CR-011 · CLAUDE.md rule 1

## Context

`app.refresh_governing_tread` is the one SECURITY DEFINER routine (check
8c). It materialises the MIN() across a reading's measurements (CR-011) and
reconciles valuation snapshots, so it writes rows its caller cannot. Its
owner is the role that ran the migrations: `postgres` locally and in CI
(rolsuper), `tyreadmin` on staging and production (rolsuper false,
rolbypassrls true; TYRE-305 comment 13834). FORCE ROW LEVEL SECURITY binds
neither, so everything the chain reaches runs with RLS off in every
environment.

Tenant scoping inside the chain is written by hand: 000050 names the tenant
in each lookup and suite section 65 pins those predicates as text; the
composite FKs of 000004 keep a reading and its measurements in one tenant;
000051 revokes EXECUTE so no caller can attach the definer to a table of its
own (section 67). TYRE-347 records two lookups that still lack a
tenant-leading index, which is a cost, not a leak.

## Options considered

### Option A: keep the migrating role as owner

No change to grants, checks or privileged controls, and the chain behaves
the same everywhere.

**Its real downside:** isolation inside the chain rests on each lookup
naming its tenant. A new lookup that forgets is caught by review, by
db/CLAUDE.md's "Adding a function" and by section 65, not by RLS.

### Option B: a dedicated NOLOGIN NOBYPASSRLS owner

RLS would add the tenant to every lookup in the chain.

**Its real downside:** the owner needs UPDATE (governing_tread_mm) on
`app.reading` and the valuation snapshot writes, and check 4 must admit
them. The backstop's cross-tenant read would return nothing, so
005_privileged's refusal becomes the cascade branch. A trigger fired with no
`app.tenant_id` (seed load, `make db-volume`, P11) would leave
governing_tread_mm NULL. RLS predicates in the chain risk the row-estimate
collapse TYRE-256 found, so the submit and the volume load would need
measuring again. The role would also have to be created on both Azure
servers before the migration that hands it ownership.

## Decision

We will keep `app.refresh_governing_tread` owned by the migrating role, with
its tenant predicates written in the text and pinned by section 65.

## Consequences

**Good:** nothing changes weeks before the BAC pilot, and the suite and the
deployed databases run the chain under the same rules, so section 65 and
005_privileged test what production runs.

**Bad:** a lookup added to the chain without a tenant predicate reads every
tenant's rows until review catches it. No suite check can assert a deployed
owner's attributes, because the suite never runs on a deployed database
(U92); if an environment's admin role ever stops bypassing RLS, governing
treads go NULL there, and TYRE-305's role query is how to tell.

**Revisit when:** a second SECURITY DEFINER routine is proposed, TYRE-347
is picked up after the pilot, a deployed owner reads rolbypassrls false, or
TYRE-437's follow-up narrows the admin role.
