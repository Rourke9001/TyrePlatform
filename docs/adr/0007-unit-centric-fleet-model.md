# ADR-0007: The unit-centric fleet model

- **Status:** Accepted
- **Date:** 2026-08-22
- **Deciders:** Rourke (engineer) · Sponsor (domain authority) — answered directly, 22 August 2026
- **Closes:** OI-24(a) · OI-24(b) · OI-27 · OI-30 · **Unblocks:** P1 schema freeze, configuration seed library
- **Related:** ADR-0003 (tenancy) · SRS §4.2 VEH, FR-VEH-010..032, BR-VEH-001..004 · Axle Configuration Reference v0.1

## Context

The v0.1 configuration library modelled **fourteen whole-combination configurations** — `BAC_LINKS`, `COMB_TRIAXLE`, `COMB_SIDETIP_IL` and so on — each carrying a flat list of 4 to 30 positions numbered straight through, and a `combination_position_map` table translating combination position `11` to "second unit, own position `1`".

That shape came from the BAC paper capture sheet, which numbers a superlink 1–26 across the whole rig. The sheet is a **capture artefact**, not a description of the fleet.

The sponsor was asked how a trailer's positions should be numbered when it is inspected on its own (OI-24(b)). The answer settles the model:

> _"Trailers and horses should be viewed independently. We can have horse 1 with trailer 2 and 3, but then next trip we can have horse 2 with trailer 2 and 4. So we would need some way to set a configuration of trailers and horses — each trailer and horse should start from 1, not their current number in the configuration."_

Three further answers bear on the same model:

* **OI-27** — whether a parked trailer is inspected is _per tenant_, decided by the fleet controller.
* **OI-30** — BAC runs no self-steering or lifting axles, but other fleets do.
* **OI-24(a)** — beyond the four configurations BAC actually runs, the sponsor has no knowledge to give.

## Decision

**The unit is the modelled entity. A rig is a dated composition of units, not a configuration.**

1. A **unit** is a horse, a trailer, a rigid or a light vehicle. It owns its wheel positions and numbers them **1..n within itself**, permanently, irrespective of what it is coupled to.
2. A **composition** records which units ran together and when. It is dated, sparse, and optional.
3. The 1–26 sequence is a **display projection** computed at render time from the composition and each unit's own ordering. It is never stored, and `combination_position_map` is **dropped**.
4. Every reading attaches to `unit + own position`. It cannot be misfiled when a composition changes.
5. **Body type is an attribute of the unit, not a configuration.** A side tipper and a fuel tanker share TA/TA interlink geometry with a flat deck; only the body differs. This collapses six of the fourteen entries on its own.
6. The position numbering convention is the **plan view** — nose up, foremost axle first, then left to right across each axle, so a dual axle reads left-outer, left-inner, right-inner, right-outer. This is deliberately the **same spatial frame** as the tread-position convention in the tyre-identity ADR's sibling decision (OI-28), so the app has one diagram and drivers have one thing to learn.
7. Units carry a **state** — `ACTIVE` / `PARKED` / `OUT_OF_SERVICE`. Recurring inspection schedules skip non-active units.
8. **Spares are per unit and variable in number.** The configuration supplies a default; the actual count is whatever inspections find.
9. Every axle carries an `axle_type` — `FIXED` / `SELF_STEERING` / `LIFTING` — modelled now, with no behaviour built for it beyond one analytics rule: cohort by axle type, never blend.

The library therefore goes from **14 combination configurations to 6 unit types**:

| Unit type | Axles | Running positions | Evidential status |
| --- | --- | --- | --- |
| Horse 4×2 (truck tractor) | 2 | 6 | **Confirmed** |
| Horse 6×4 (truck tractor) | 3 | 10 | **Confirmed** |
| Trailer, 2-axle | 2 | 8 | **Confirmed** |
| Trailer, 3-axle | 3 | 12 | Unverified |
| Rigid truck 4×2 | 2 | 6 | Unverified |
| Light vehicle 4×2 | 2 | 4 | Unverified |

The `evidential_status` vocabulary changes from `CONFIRMED / PROPOSED / VARIANT` to `CONFIRMED / UNVERIFIED`. "Proposed" implied someone had proposed it; nobody had. Nothing is deleted — unverified configurations ship so the platform can serve other fleets, flagged as requiring operator confirmation before onboarding.

## Options considered

### Option A — Keep combination configurations, add standalone variants

Model each rig shape as now, and add a standalone configuration for every unit that can be inspected alone.

| Dimension | Assessment |
| --- | --- |
| Complexity | High and growing — every new trailer type multiplies against every horse type |
| Reversibility | Poor — readings are stored against combination positions |

**Rejected.** A trailer inspected alone and the same trailer inspected in a rig would carry readings under two different position identities. Reconciling them is exactly the silent misfiling OI-24(b) was raised to prevent, and the sponsor's answer says the units genuinely are independent.

### Option B — Unit-centric, composition as projection _(chosen)_

| Dimension | Assessment |
| --- | --- |
| Complexity | Low — six unit types replace fourteen combinations |
| Scalability | Good — a new trailer type is one row, not a cross-product |
| Reversibility | Good — compositions are derived, so changing how rigs render costs nothing |

**Cost:** the printed report must reconstruct the 1–26 numbering the fleet is used to seeing. That is a view, and `v_combination_reading` already does the work; it simply computes the mapping instead of looking it up.

### Option C — Unit-centric with no composition at all

Track units only; never record what ran with what.

**Rejected**, but narrowly. It is tempting because coupling data is sparse and unreliable (see the provenance ADR). It is rejected because the inspection itself observes a composition for free, and because the printed report parity in P5 requires rig-level rendering.

## Trade-off analysis

The decisive argument is that **the alternative is not reversible.** Position identity is stamped onto every reading at capture. If readings accumulate for six months under combination numbering and the model then has to change, every historical reading must be re-mapped through a table that was only ever correct for the composition in force on the day — information which, per the provenance ADR, is not reliably recorded.

Against that, the cost of choosing wrongly in the other direction is a view. This is asymmetric enough that it does not need a close analysis of the alternatives.

The secondary benefit is the one the sponsor cared about: **a tyre is never locked to a unit.** Fitment is a dated relationship between a tyre and a `unit + position`, so rotation is closing one fitment and opening another, and a tyre may be fitted to nothing at all while it sits in the store or at the retreader.

## Consequences

**Easier**

* Six unit types to seed and maintain instead of fourteen combinations
* A new customer's fleet is described by counting units, not by matching rig shapes
* Trailers moving between horses is the normal case rather than an exception
* `combination_position_map` and its seed data disappear
* OI-24(a), OI-24(b), OI-27 and OI-30 all close on one decision

**Harder**

* Report parity (P5) must compute the 1–26 projection rather than read it
* The Axle Configuration Reference and both seed generators need rewriting, not amending
* Existing 2021 fixture readings are keyed 1–26 and must be re-mapped onto unit-local positions on import

**To revisit**

* Whether compositions should be capturable outside an inspection, once OI-32 (driver-to-unit assignment) is answered
* Lifting-axle analytics, if and when a customer with lifting axles onboards

## Action items

1. Rewrite `Axle_Configuration_Reference` to v1.0 — unit types, new status vocabulary, variable spares
2. Rewrite `gen_seed_configurations.py` to emit unit types
3. Schema: add `unit_kind`, `axle_type`, unit states, variable spares; drop `combination_position_map`
4. Amend **FR-VEH-014** — position count range is now **per unit** (4 to 12), not per combination
5. Resolve **BR-VEH-002** — spares are per unit and variable; the single spare box on the capture sheet was a limitation of the paper, not a property of the rigs
6. Re-map the Appendix J fixture from combination positions onto unit-local positions
7. Close OI-24(a), OI-24(b), OI-27, OI-30 in `docs/open-issues.md` and TYRE-11
