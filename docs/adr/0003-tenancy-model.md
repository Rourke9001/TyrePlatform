# ADR-0003: Tenancy model

- **Status:** Accepted, 29 Sep 2026: Option A for the POC
- **Date:** 2026-08-20, decided 2026-09-29
- **Deciders:** Rourke (owner)

## Context

Isolation is settled: shared database, shared schema, row-level security keyed
on `tenant_id`, enforced in Postgres and verified by an automated suite that
runs on every build. That part is not in question.

What is unresolved is **what a tenant is**. The original product idea included
a marketplace where tyre sellers promote to fleets. That implies a second party
type on the platform with fundamentally different data visibility: a seller
sees demand signals across fleets; a fleet must see nothing of another fleet.

This is not a feature to add later. Retrofitting a second party type onto a
tenant table that assumes "tenant = fleet" is a data migration plus a rewrite
of every policy. Adding a `party_type` column now costs almost nothing.

## Options considered

### Option A — Tenant is a fleet. Sellers are a future, separate product.
Simplest. The schema stays exactly as written.
**Downside:** if the marketplace happens, it is a migration.

### Option B — Tenant carries `party_type` from day one.
One column, one CHECK constraint, and the policies are unchanged for the POC
because there are no seller tenants yet.
**Downside:** it invites design speculation about a product nobody has
committed to, and an unused column is a standing question in every schema
review.

### Option C — Design the marketplace properly now.
**Downside:** explicitly out of POC scope, and the POC hypothesis says nothing
about sellers. This would be scope creep of exactly the kind the working
agreement's change-control clause exists to prevent.

## Decision

**Option A for the POC: a tenant is a fleet.** The marketplace is post-POC
(owner, 29 Sep 2026), so no seller party exists while the POC runs.

The recommendation was Option B. It was not taken: the P1 schema shipped
without a `party_type` column, and adding one now for a product that starts
after the POC would be the unused column Option B's own downside describes.

## Consequences

Every policy and view assumes a tenant is a fleet, which is true for the whole
POC. A marketplace after it is the migration Option A's downside names: a party
type on `app.tenant` and a review of every policy for cross-tenant seller
visibility (ADR-0006).

**Revisit when:** the marketplace is taken up after the POC, before any seller
tenant exists.
