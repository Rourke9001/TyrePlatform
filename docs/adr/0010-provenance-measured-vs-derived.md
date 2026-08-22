# ADR-0010: Provenance — measured versus derived values

- **Status:** Accepted
- **Date:** 2026-08-22
- **Deciders:** Rourke (engineer)
- **Related:** the unit-model, tyre-identity and client-platform ADRs · OI-01/03/04/05/07/08/10/13/15/23/26/30
- **Closes:** nothing directly — establishes a constraint the other decisions all rely on

## Context

This ADR was not planned. It is written because the same problem appeared in eight of the twenty-three sponsor answers, each time wearing different clothes, and solving it eight separate times would have produced eight inconsistent solutions.

| Question | The measured thing | The derived or absent thing |
| --- | --- | --- |
| OI-28 (Q1) | tread readings with a known orientation | 2021 readings whose orientation is unrecoverable |
| OI-03 (Q3) | casing value from a retreader's report | an admin's estimate, or no value at all |
| OI-26 (Q6) | vehicles with odometer readings | vehicles without |
| OI-24(b) (Q7) | trailer distance from a hubodometer | trailer distance inferred from coupling |
| OI-10 (Q12) | a cold pressure reading | a hot pressure reading compared against a cold target |
| OI-23 (Q15) | a tyre cost from an invoice | a price-list estimate, or unknown |
| OI-13 (Q18) | a wear rate from many readings | a wear rate from two rounded readings |
| OI-30 (Q22) | wear on a fixed axle | wear on a lifting axle that may not have been touching the road |

In every case the tempting move is the same: fill the gap with something plausible so the report has no holes. Default the casing to zero. Average the cost-per-km over whatever vehicles have odometers. Split the horse's kilometres across its trailers. Compare the hot reading to the cold target. Give the prediction a date instead of a range.

Every one of those produces a number that **looks exactly like a measurement and is not one**.

### Why this matters more here than in most systems

The product's entire commercial proposition, per OI-15, is that _no logistics company knows what its tyres are worth_ and this system tells them. It is sold on the credibility of its numbers. There is no incumbent report to be compared against and no existing baseline — which means the **first** time a fleet manager checks one of our figures against something he knows, that check decides whether the product is trusted.

A number that is wrong in a plausible-looking direction is worse than a gap, because a gap invites a question and a plausible wrong number invites a purchasing decision.

There is also a specific, already-realised instance: `tyre.casing_value NOT NULL DEFAULT 0` in the current schema. It was written to avoid nulls. Its effect is to assert that every never-retreaded casing in the fleet is worth nothing — silently, with no evidence, against roughly half the tyre asset value.

## Decision

> **The system never presents a measured value and a derived or estimated value in the same figure without labelling which is which.**

Four rules implement it.

1. **Provenance is a property of the value, not of the tenant or the report.** It is stored on the row that holds the value, because the same field carries different provenance for different rows and for the same row at different times. `casing_value` is `RETREADER` for one tyre and `ADMIN_ESTIMATE` for another; a reading captured in 2021 has a different orientation certainty from one captured next week.
2. **Absence is represented as absence.** `NULL` and an explicit _unknown_ provenance, never a zero, never a default, never an imputed value. A zero is a claim.
3. **Coverage is disclosed wherever a figure aggregates over a subset.** _"Cost per km available for 47 of 60 vehicles"_, not a silent average over the 47.
4. **Derived quantities carry their uncertainty.** Threshold predictions are ranges with the number of underlying readings exposed, not point dates. Inferred distances are marked `INFERRED`, and where the error is unbounded — trailer distance inferred from sparse coupling observations — that is stated rather than presented as a figure.

### The degradation rule

Where a measurement is missing, the system **degrades to a weaker metric rather than to a fabricated one**. Without kilometres, wear is reported in mm per month: it needs no odometer, still ranks brands, still detects bad axles, still forecasts replacement, and merely loses normalisation for how hard a vehicle is worked. That is an honest weaker answer, and it is available for every tyre in every fleet.

## Options considered

### Option A — Impute and present a single clean number

Fill gaps with defaults and estimates; present one figure.

**Pros:** every report is complete; nothing looks broken; no UI needs to explain anything.
**Cons:** the figures are unfalsifiable from outside and wrong from inside. The first customer who checks one against reality discovers the product invents numbers, and there is no second chance at that.
**Rejected.**

### Option B — Refuse to report anything not fully measured

Show only figures backed end-to-end by measurements.

**Pros:** unimpeachable.
**Cons:** given OI-23 (no purchase prices exist) and OI-24(b) (trailers have no odometers), this suppresses most money reporting for most of the first year, including the value-at-risk figure the POC depends on. Correctness that reports nothing is not useful.
**Rejected.**

### Option C — Report with provenance _(chosen)_

**Pros:** reports are complete _and_ honest; the fleet can see exactly which figures to trust and how far; it creates a visible, non-preachy incentive for the fleet to improve its own data — a fleet capturing half millimetres gets tighter forecasts, and can see that it does.
**Cons:** every value-carrying table gains a provenance column; every report gains a labelling obligation; the UI is more complex than a single clean number. Accepted.

## Consequences

**Easier**

* Eight recurring problems have one answer instead of eight
* CFL-002 (casing default zero) and CFL-010 (valuation completeness) have a principled resolution rather than a patch
* The POC can produce the value-at-risk figure from a single inspection sweep while being explicit about what is estimated within it
* Sales conversations are more defensible: the product shows its working

**Harder**

* Schema surface grows — provenance columns and enums on several tables
* Dashboard design is harder: three-way splits and coverage statements instead of single figures. This is a real cost and it lands on the least technical users
* Some reports will look emptier than a competitor's. That is the intended trade

**To revisit**

* Whether provenance should be exposed to drivers at all, or only to controllers and admins. Current lean: drivers see none of it — they produce measurements, they do not consume derived figures

## Action items

1. Add as an SRS non-functional requirement (CHG-062)
2. Provenance columns per the change manifest: CHG-011, 016, 018, 036, 042, 043
3. Fix CFL-002 and CFL-010
4. Add the coverage-disclosure rule to every aggregate in the dashboard prototype
5. Add an `mm/month` wear rate that requires no odometer
6. Add a verification check: any unlabelled blended figure is a failure against this ADR
