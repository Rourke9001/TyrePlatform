# The policy values the seeded tenants start from, in one place so the
# configuration generator and the volume generator cannot disagree about
# them (CLAUDE.md rule 5: a threshold is configuration, never a constant in
# a rule). These are the seeded rows' values; the rows themselves are the
# authority once loaded, and app.threshold_policy_for and
# app.target_pressure_for are the only readers in SQL.
#
# Both retread and scrap sit at 4.0mm: BAC runs a single pull point today,
# and 4mm is its policy figure, never a legal claim (CFL-012). The warning
# band edge is threshold + 2 (B7 spec U3).
RETREAD_THRESHOLD_MM = 4.0
SCRAP_THRESHOLD_MM = 4.0
WARNING_THRESHOLD_MM = 6.0

# Target pressures per axle class (CHG-112, FR-CFG-013). No SPARE entry on
# purpose: a spare's pressure is unclassifiable, never silently compliant.
# Insertion order is the order the rows are emitted, so it is part of the
# generator's byte-for-byte determinism.
TARGET_KPA = {'STEER': 800, 'DRIVE': 750, 'TRAILER': 750, 'TAG': 750}
