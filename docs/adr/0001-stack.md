# ADR-0001: Platform stack — Azure, Go API, React PWA, PostgreSQL

- **Status:** Proposed
- **Date:** 2026-08-20
- **Deciders:** Rourke (Delivery)

## Context

The database already exists and is proven: `001_schema.sql` applies cleanly to
PostgreSQL 16, enforces tenant isolation with row-level security, revokes
`UPDATE`/`DELETE` from the app role to make readings immutable, and reproduces
all fifteen SRS Appendix E valuations to the cent. Sixteen verification checks
pass against it as a non-superuser role. **This is the fixed point.** Every
other choice bends around not breaking it.

The forces:

- **Azure is a hard constraint.** There is an active subscription with
  Microsoft Partner Network benefits. This rules out Supabase, Neon, Fly,
  Vercel and the rest of the usual single-engineer stack.
- **One engineer, 328 estimated hours.** Anything requiring a platform team is
  out. Operational surface area is a first-class cost.
- **R3,500/month infrastructure cap** without written approval. The system is
  idle most of the day — a POC fleet of 25 vehicles inspected once daily is a
  few hundred requests. Scale-to-zero is worth real money here.
- **RLS demands explicit connection control.** Tenant context is set per
  transaction with `SET LOCAL app.tenant_id`. Get this wrong with a connection
  pool and one tenant's context carries into the next request — the one
  existential risk in the product (R3).
- **Money must be exact.** The primary acceptance gate is cent-exact
  reproduction of a 2021 valuation.
- **The engineer knows React and Vite, has worked in most languages, and wants
  to explore Go but is not yet proficient in it.**

## Options considered

### Option A — Go API on Azure Container Apps

`net/http` + `chi` + `pgx`, no ORM. Single static binary in a scratch
container.

Attractive because the API is genuinely thin: the business logic lives in SQL
already (valuation functions, exception views, RLS policies), so the Go layer
is auth, tenant context, transport and sync reconciliation. That is Go's
sweet spot. `pgx` gives direct control of the connection and transaction, which
is exactly what `SET LOCAL` needs — no ORM fighting to hide the pool. And a Go
binary cold-starts in milliseconds, so scale-to-zero on Container Apps is a
real option rather than a first-request timeout.

**Downside: the engineer is not proficient in Go.** There will be a learning
period, and idiomatic mistakes will be made in the first few weeks. Mitigated
by keeping the Go surface deliberately small and boring — stdlib plus one
router, no framework, no code generation, no clever generics — which also
happens to make it the easiest code in this list to *review* while learning.

### Option B — C# / .NET on Azure App Service

The Azure-native answer. Best tooling, best MPN alignment, EF Core, and the
engineer would be productive immediately.

**Downside:** EF Core plus RLS plus connection pooling is a known-fiddly
combination — the ORM's unit-of-work model actively obscures which connection
a query lands on, which is precisely the thing that must stay visible.
Sidestepping that means using Dapper or raw ADO.NET, at which point the main
argument for .NET (the ecosystem) is largely spent. Heavier containers and
slower cold starts also weaken scale-to-zero.

### Option C — TypeScript everywhere (Node API + React PWA)

One language, one toolchain, and — the real argument — **shared validation
between the offline client and the server.** An offline-first capture app
re-implements validation on the client by necessity; sharing a Zod schema means
it cannot drift.

**Downside:** JavaScript has no decimal type. Every monetary value crossing the
API is an IEEE double unless deliberately handled as a string, and the
acceptance gate is cent-exactness. Survivable — all the arithmetic is in
Postgres `numeric` and the API only transports the result — but it makes the
most dangerous mistake in this product a one-character oversight rather than a
compile error.

### Option D — Python / FastAPI

The engineer already wrote the seed generators in Python, and Python has a
native `Decimal`.

**Downside:** the weakest static guarantees of the four, and async SQLAlchemy
plus RLS session state has the same pooling hazard as EF Core with less
tooling to catch it.

## Decision

We will build the API in **Go** (`net/http` + `chi` + `pgx`, no ORM) on
**Azure Container Apps**, with a **React + Vite** PWA on **Azure Static Web
Apps**, against **Azure Database for PostgreSQL Flexible Server 16**.

Supporting services: **Azure Blob Storage** for inspection photos,
**Microsoft Entra External ID** as the external identity provider required by
FR-AUT-001, **Azure Container Registry**, **Bicep** for infrastructure, and
**GitHub Actions with OIDC federated credentials** so no long-lived Azure
secret is ever stored in the repo.

## Consequences

**Good**

- `pgx` makes the tenant-context binding explicit and reviewable. `SET LOCAL`
  inside an explicit transaction is a visible line of code, not ORM behaviour
  to be inferred.
- Container Apps scales to zero. An idle POC costs close to nothing, which
  matters against the R3,500/month cap.
- Money never leaves `numeric`: Postgres computes it, Go carries it as a
  string or `decimal.Decimal`, and the JSON contract uses strings. The
  arithmetic has exactly one implementation, which is what makes FR-VAL-006
  defensible.
- A static binary in a scratch image is a small attack surface and a fast
  deploy.
- Go is a good language to learn on a project like this: explicit, small, and
  unusually easy to review when you are still learning it.

**Bad**

- The engineer is learning Go while shipping. Expect the first two weeks to be
  slower than Option B and expect some non-idiomatic code to need revisiting.
- No shared validation types between the PWA and the API. The offline client
  duplicates validation rules that the server also enforces. **Mitigation:**
  generate the TypeScript client from an OpenAPI spec that is itself generated
  from the Go handlers, so the contract cannot silently drift even though the
  logic is written twice.
- Container Apps is less turnkey than App Service on Azure. Slightly more
  Bicep to write once.
- Entra External ID is more ceremony than a password table for a two-tenant
  POC — but FR-AUT-001 requires an external identity provider and rolling our
  own auth for a product that will hold other companies' data is not a
  trade worth making.

**Revisit when**

- Go proves to be a genuine drag after ~3 weeks of real work. The API is thin
  by design, so a rewrite to .NET at P2 would be days, not weeks. That is the
  insurance policy that makes this choice safe to take.
- The offline sync reconciliation turns out to need substantial shared logic
  with the client, which would strengthen the TypeScript case considerably.
- Cold-start behaviour on Container Apps proves unacceptable for the capture
  app's first request of the morning — the fix is a minimum replica count of
  one, at a known monthly cost.
