# ADR-0002: Azure region and POPIA data residency

- **Status:** Accepted — verification passed 2026-08-20
- **Date:** 2026-08-20
- **Deciders:** Rourke

## Context

The platform stores personal information about South African drivers: names,
staff numbers, and GPS coordinates and timestamps of where an individual was
at a given moment. POPIA compliance is risk R8 in the POC agreement, and
"where does our data live" is a question every prospect will ask.

## Options considered

### Option A — South Africa North (Johannesburg)
Lowest latency for the pilot fleet, and the simplest possible answer on data
residency: it never leaves the country.

**Downside:** smaller regions do not carry every Azure service, and service
availability changes. **This must be verified before it is chosen, not
assumed.** Fewer availability zones and occasionally later feature rollout.

### Option B — West Europe / North Europe
Full service catalogue, cheapest, everything available.

**Downside:** ~150-180ms additional latency to Johannesburg, and cross-border
transfer of personal information, which POPIA §72 permits under conditions but
which requires an actual documented position rather than silence.

## Decision

We will use **South Africa North** for everything that stores data.

Verification ran 2026-08-20 against the live subscription (the commands below,
per TYRE-20) and passed:

```bash
az account list-locations -o table | grep -i "south africa"
az provider show -n Microsoft.App        --query "resourceTypes[?resourceType=='containerApps'].locations" -o tsv
az provider show -n Microsoft.DBforPostgreSQL --query "resourceTypes[?resourceType=='flexibleServers'].locations" -o tsv
```

- Container Apps: available in South Africa North. ✓
- PostgreSQL Flexible Server: available in South Africa North. ✓
- Static Web Apps: **no South Africa region exists** (management region will be
  West Europe; content is served from a global CDN). Acceptable, because the
  SWA holds only the compiled frontend — no personal information is at rest
  there. The POPIA answer stays one sentence: *driver data lives in
  Johannesburg.*

One item is deferred to identity setup, not to chance: the Entra External ID
tenant's geography is fixed at tenant creation and must be chosen deliberately
then. Record the choice here when the tenant is created.

## Consequences

**Good (Option A):** the data-residency answer is one sentence, which is worth
something commercially.

**Bad:** if any service is missing we discover it during provisioning rather
than now, which is why this ADR is blocked rather than accepted.

**Revisit when:** a customer outside South Africa is signed, at which point
multi-region becomes a product decision rather than an infrastructure one.
