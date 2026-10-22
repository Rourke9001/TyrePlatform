# The policy values every tenant starts from, in one place so the generators
# and the provisioning path cannot disagree about them (CLAUDE.md rule 5: a
# threshold is configuration, never a constant in a rule). A provisioned
# tenant takes these unless its file overrides them; the rows themselves are
# the authority once loaded, and app.threshold_policy_for,
# app.threshold_policy_in_force_at and app.target_pressure_for are the only
# readers in SQL.
#
# BAC runs a single pull point today, and 4mm is its policy figure, never a
# legal claim (CFL-012). The warning band edge is threshold + 2 (B7 spec U3).
#
# RETREAD_THRESHOLD_MM is not a tunable default. BAC's seeded rows are the
# acceptance fixture, so gen_seed_fixture.py derives every fixture tyre's
# rand_per_mm from this same name rather than a literal of its own: SRS
# Appendix E checks 4319.91 / (25 - 4) = R205.7100/mm exactly. Moving it
# moves the tenant's policy row and the fixture's rate together and fails
# the Appendix E sections of `make db-test` by design, because that gate is
# cent-exact against a fixed 4mm pull point (FR-VAL-006).
RETREAD_THRESHOLD_MM = 4.0
WARNING_THRESHOLD_MM = 6.0

# The seeded tenants' retread cap (FR-CFG-044). The column has no default
# (rule 5), so every seeded row states it.
MAX_RETREADS = 2

# Class-scoped threshold rows a tenant starts with, as deltas on the
# fleet-wide row. CHG-038: retreads are not fitted to steer axles. Fleet
# practice, not a legal claim (CHG-107 tracks the sign-off question).
CLASS_THRESHOLDS = {"STEER": {"retreads_permitted": False}}

# Target pressures per axle class (CHG-112, FR-CFG-013). No SPARE entry on
# purpose: a spare's pressure is unclassifiable, never silently compliant.
# Insertion order is the order the rows are emitted, so it is part of the
# generator's byte-for-byte determinism.
TARGET_KPA = {"STEER": 800, "DRIVE": 750, "TRAILER": 750, "TAG": 750}

# FR-CFG-016's band edges, 10/20% each side of every class's target. Order is
# the column order the rows are written in.
PRESSURE_TOLERANCE_PCT = {
    "warn_under_pct": 10.0,
    "critical_under_pct": 20.0,
    "warn_over_pct": 10.0,
    "critical_over_pct": 20.0,
}

# Every configuration key a tenant starts with, in emission order. Values keep
# their Python types, because the provisioning path checks a file's override
# against the default's type.
CONFIG_DEFAULTS = [
    ("tread_reading_count", 3),
    # TYRE-155 (owner, 6 Sep 2026): whether the capture app puts a
    # spare cell on the sheet at all. Default yes, as FR-INS-066 is
    # a Must, but the right answer for a real fleet is unknown, so
    # it is a key, not a constant (rule 5).
    ("capture_spares", True),
    ("width_spread_warn_mm", 4),
    ("dual_mate_warn_mm", 3),
    ("axle_divergence_warn_mm", 3),
    ("tread_bands", [[0, 4], [5, 7], [8, 10], [11, 13], [14, None]]),
    # FR-FIT-008's minimum plus the two this platform writes itself
    # (rotation closes a fitment; a correction is FR-FIT-015's
    # compensating close). Tenant configuration, never a constant.
    (
        "removal_reasons",
        [
            "worn_to_threshold",
            "damage",
            "irregular_wear",
            "casing_failure",
            "vehicle_disposal",
            "rotation",
            "correction",
            "puncture",
        ],
    ),
    # FR-VAL-021 staleness indication. 28 = 4 x the configured
    # inspection interval (FR-CFG-017, default 7 days), not a
    # free-standing constant: a reading older than four missed
    # inspections is ~2mm of drive-axle wear, which against a 4mm
    # policy threshold is the whole margin. Feeds both FR-VAL-021
    # and the FR-EXC-027 CRITICAL exception; if BAC's real cadence
    # is worse than weekly, split the key (TYRE-59), never loosen.
    ("reading_staleness_days", 28),
    # FR-ANL-002 minimum separation between the pair a wear rate
    # is computed over. Below it the readings are dominated by
    # gauge and operator variation rather than by wear.
    ("wear_rate_min_distance_km", 1000),
    ("odometer_max_daily_km", 1600),  # DR-020's configurable ceiling
    (
        "duplicate_inspection_min_hours",
        4,
    ),  # FR-INS-038's window, read by app.submit_inspection
    (
        "submitted_at_future_skew_minutes",
        5,
    ),  # TYRE-166: how far ahead of the server clock a device may stamp a submit
    # TYRE-326, U148: how much of a capture's end is judged for who held
    # the unit; a capture is never refused for its length.
    ("inspection_max_duration_hours", 12),
    # U148: a trip cannot start while a unit it would cover has an
    # inspection due today or earlier and not done. BAC's rule, so the
    # default.
    ("due_inspection_blocks_trip", True),
    (
        "wear_rate_alert_multiple",
        3,
    ),  # FR-INS-035, served to the device in the capture context
    # FR-DSH-009's "within 30 days" is tenant configuration, never
    # a constant (rule 5); the dashboard tile and
    # /api/analytics/removal-forecast default to it (B7 spec D7).
    ("forecast_horizon_days", 30),
    # FR-DSH-007's inflation compliance period is tenant
    # configuration too (rule 5; B7 spec U28): a tenant with no
    # row reads "not configured", never a Go default.
    ("inflation_compliance_window_days", 30),
    ("tread_capture_granularity_mm", 1.0),
]
