-- ============================================================================
--  Sponsor-answer enum extensions and new types (TYRE-42)
--  Implements: CHG-010, CHG-016, CHG-027, CHG-028, CHG-030, CHG-033, CHG-035,
--  CHG-036, CHG-037, CHG-042 (type layer only) — manifest v1.1 §4.2.
--
--  A migration of its own because golang-migrate applies each file as one
--  transaction and PostgreSQL forbids USING an enum value in the transaction
--  that added it. Everything that consumes these values starts at 000011.
-- ============================================================================

-- CHG-037: a tyre can leave the fleet by SALE, not only by scrapping. The sale
-- price is a real market valuation of a used casing (Q19) and is one of only
-- three money figures recoverable going forward — see CHG-036.
ALTER TYPE app.tyre_state     ADD VALUE IF NOT EXISTS 'SOLD';

-- CHG-028: a unit that is not moving is not wearing. Recurring inspection
-- schedules skip non-active units so the overdue list does not fill with
-- trailers nobody was ever going to inspect (Q21).
ALTER TYPE app.vehicle_status ADD VALUE IF NOT EXISTS 'PARKED';
ALTER TYPE app.vehicle_status ADD VALUE IF NOT EXISTS 'OUT_OF_SERVICE';

-- CHG-024: the odometer belongs to the vehicle timeline, not the inspection.
-- BAC's readings come from fuel records (Q8).
ALTER TYPE app.reading_source ADD VALUE IF NOT EXISTS 'FUEL_RECORD';
ALTER TYPE app.reading_source ADD VALUE IF NOT EXISTS 'LOGBOOK';
ALTER TYPE app.reading_source ADD VALUE IF NOT EXISTS 'SERVICE_SHEET';
ALTER TYPE app.reading_source ADD VALUE IF NOT EXISTS 'INSPECTION';
ALTER TYPE app.reading_source ADD VALUE IF NOT EXISTS 'TELEMATICS';

-- CHG-010 / CFL-007. Tread positions are defined relative to the VEHICLE
-- CENTRELINE, never to the observer. Outer = away from the centreline.
-- The driver never sees these words; the app maps by side from the wheel
-- position, because the code encodes which side of the vehicle it is on (Q1).
CREATE TYPE app.tread_position AS ENUM ('OUTER','CENTRE','INNER');

-- CHG-030. Modelled now, no behaviour built (ADR-0007 §9). BAC runs none of
-- these; other fleets do. A lifted axle is not touching the road and therefore
-- not wearing, so it must never be averaged with fixed axles (Q22).
CREATE TYPE app.axle_type AS ENUM ('FIXED','SELF_STEERING','LIFTING');

-- CHG-027. The unit is the modelled entity; a rig is a dated composition of
-- units (ADR-0007).
CREATE TYPE app.unit_kind AS ENUM ('HORSE','TRAILER','RIGID','LIGHT');

-- CHG-016. Casing value is established by the RETREADER at the point of
-- retread and does not exist before that (Q3). An admin estimate is a
-- different kind of number and is never blended with a retreader's figure.
CREATE TYPE app.valuation_source AS ENUM ('RETREADER','ADMIN_ESTIMATE');

-- CHG-036. No purchase price exists for any tyre already in the fleet (Q15).
CREATE TYPE app.cost_source AS ENUM ('INVOICE','PRICE_LIST_ESTIMATE','UNKNOWN');

-- CHG-042 / ADR-0010. Trailers have no odometer. Distance inferred from sparse
-- coupling observations has an error we cannot bound, and an unbounded error
-- presented as cost-per-km is worse than no figure (Q7).
CREATE TYPE app.distance_provenance AS ENUM ('MEASURED','INFERRED','UNAVAILABLE');

-- CHG-035. Manufacturer pressures are COLD figures. Inspections happen
-- mid-trip and at rest stops, when tyres are hot and read high — a hot 750
-- against a cold 750 target can conceal genuine under-inflation (Q12).
CREATE TYPE app.temperature_state AS ENUM ('COLD','HOT','UNKNOWN');

-- CHG-033.
CREATE TYPE app.task_state AS ENUM ('OPEN','COMPLETED','CANCELLED','ESCALATED');
