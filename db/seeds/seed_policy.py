# The policy values the seeded tenants start from, in one place so the three
# generators cannot disagree about them (CLAUDE.md rule 5: a threshold is
# configuration, never a constant in a rule). These are the seeded rows'
# values; the rows themselves are the authority once loaded, and
# app.threshold_policy_for and app.target_pressure_for are the only readers
# in SQL.
#
# Both retread and scrap sit at 4.0mm: BAC runs a single pull point today,
# and 4mm is its policy figure, never a legal claim (CFL-012). The warning
# band edge is threshold + 2 (B7 spec U3).
#
# RETREAD_THRESHOLD_MM is not a tunable default. BAC's seeded rows are the
# acceptance fixture, so gen_seed_fixture.py derives every fixture tyre's
# rand_per_mm from this same name rather than a literal of its own: SRS
# Appendix E checks 4319.91 / (25 - 4) = R205.7100/mm exactly. Moving it
# moves the tenant's policy row and the fixture's rate together and fails
# the Appendix E sections of `make db-test` by design, because that gate is
# cent-exact against a fixed 4mm pull point (FR-VAL-006).
RETREAD_THRESHOLD_MM = 4.0
SCRAP_THRESHOLD_MM = 4.0
WARNING_THRESHOLD_MM = 6.0

# Target pressures per axle class (CHG-112, FR-CFG-013). No SPARE entry on
# purpose: a spare's pressure is unclassifiable, never silently compliant.
# Insertion order is the order the rows are emitted, so it is part of the
# generator's byte-for-byte determinism.
TARGET_KPA = {'STEER': 800, 'DRIVE': 750, 'TRAILER': 750, 'TAG': 750}
