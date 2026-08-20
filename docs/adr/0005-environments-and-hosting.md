# ADR-0005: Environments — staging is production for the pilot

- **Status:** Accepted
- **Date:** 2026-08-20
- **Deciders:** Rourke (Delivery)

## Context

ADR-0004 established the branches (`develop` integrates, `main` is promoted)
and deliberately deferred the environment mapping until Azure was real. It now
is: the subscription is the BAC Azure Sponsorship (offer `Sponsored_2016-01-01`,
$2,400/year credit, $2,388 remaining as of 2026-08-20, billed in USD), and
ADR-0002's region verification has passed for South Africa North.

The pilot has one tenant — BAC Logistics — and one engineer. The POC agreement
caps infrastructure at R3,500/month (§16); the verified running cost of a full
environment is ~R400–450/month, almost all of it the database, because
Container Apps scales to zero. The forces: every additional environment is
mostly database cost; the sponsorship credit is finite and shared with BAC's
other workloads; and a pilot with one tenant gains nothing from a
staging/production split it cannot yet exercise.

## Options considered

### Option A — One environment now; call it staging, treat it as production

`main` deploys to `staging`. For the pilot period, staging **is** production.
A true `prod` environment is stamped from the same Bicep only when the first
external tenant signs. **Its real downside:** during the pilot there is no
pre-production environment, so a bad deploy lands in front of the pilot users.
Mitigated by the promotion gate (CI must be green on `develop` before `main`
fast-forwards) and by the pilot's tolerance for brief interruption.

### Option B — Staging and production from day one

The "proper" shape, immediately. **Downside:** doubles the always-on database
cost to serve zero external tenants, burns sponsorship credit that has to last
the year, and adds a promotion ceremony between two environments whose contents
would be identical.

## Decision

Option A. One environment, `staging`, in South Africa North, deployed from
`main`. When the first paying tenant signs, a `prod` environment is created
from the same Bicep modules, `main` switches to deploying prod, and staging
reverts to being a true pre-production environment.

**Hosting placement:** the pilot runs in BAC's sponsorship subscription
(`5a61b832-e331-4529-95ed-ae7b07a9697d`, BAC tenant). This is pragmatic, not
final — it is the "infrastructure borne by whom" blank in §16 of the POC
agreement and touches Q15 (IP/equity). Moving the platform to its own
subscription/tenant is expected before any external tenant is onboarded, and
everything is Bicep precisely so that move is a redeploy, not a rebuild.

**Budget guardrail:** a monthly budget of **USD 50** scoped to the project's
resource group, with alert emails at 50%, 80% and 100% actual and 100%
forecasted spend. $50/month ≈ R900 — comfortably above the expected ~R450 run
rate, comfortably below both the §16 cap and the credit burn rate that would
threaten the $2,400/year pool.

**Naming** (Cloud Adoption Framework style, `<type>-tyre-<env>`):

| Resource | Name |
| --- | --- |
| Resource group | `rg-tyre-staging` |
| Container registry | `crtyrestaging` (alphanumeric only) |
| Log Analytics | `log-tyre-staging` |
| PostgreSQL Flexible Server | `psql-tyre-staging` |
| Container Apps environment / API app | `cae-tyre-staging` / `ca-api-staging` |
| Static Web App | `stapp-tyre-staging` |
| Storage (photos) | `sttyrestaging` |
| Key Vault | `kv-tyre-staging` |

## Consequences

**Good:** one database bill during the pilot; the branch model stays exactly
ADR-0004; prod is a parameter change away when it is needed; the budget alert
fires long before the agreement cap is in sight.

**Bad:** no pre-production environment during the pilot — a bad deploy is
visible to pilot users until rolled back. The platform lives in the sponsor's
tenant, which must be unwound before external tenants arrive; deferring that
is a known debt, recorded here so it cannot be forgotten.

**Revisit when:** the first external tenant signs (create prod, revisit
placement), or the sponsorship credit's annual renewal changes the cost basis.
