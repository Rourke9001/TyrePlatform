# ADR-0002: Azure region and POPIA data residency

- **Status:** Proposed — blocked on verification
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

**Pending.** South Africa North if verification passes; West Europe with a
written transfer justification if it does not.

Verify before accepting, per TYRE-20:

```bash
az account list-locations -o table | grep -i "south africa"
az provider show -n Microsoft.App        --query "resourceTypes[?resourceType=='containerApps'].locations" -o tsv
az provider show -n Microsoft.DBforPostgreSQL --query "resourceTypes[?resourceType=='flexibleServers'].locations" -o tsv
```

Also confirm where the Entra External ID tenant itself can be located — the
identity store is separate from the application region and may not be
co-locatable.

## Consequences

**Good (Option A):** the data-residency answer is one sentence, which is worth
something commercially.

**Bad:** if any service is missing we discover it during provisioning rather
than now, which is why this ADR is blocked rather than accepted.

**Revisit when:** a customer outside South Africa is signed, at which point
multi-region becomes a product decision rather than an infrastructure one.
