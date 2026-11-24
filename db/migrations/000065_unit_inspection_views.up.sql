-- ============================================================================
--  A unit's inspections, the warnings that concern it and an inspection's
--  readings, for the manager's screens (TYRE-325)
--  Implements: FR-INS-012 as amended, FR-RPT-015, FR-RPT-031 (tread and
--  pressure per position), CR-011, FR-INS-020, FR-INS-064; U248, U249.
--  Design: docs/superpowers/specs/2026-11-24-manager-inspection-view-and-void-design.md
-- ============================================================================
-- Read views only: no grant, no write, no state filter (rule 3; U248 keeps a
-- voided inspection visible). Each is an invoker view carrying tenant_id
-- (db/CLAUDE.md, Adding a view), and suite section 82 pins them.

-- One row per warning, against the unit it concerns: its reading's unit, or,
-- for one on no reading, the unit the capture was addressed to (spec section
-- 1), so a refused odometer and a rig report land on the addressed unit alone.
CREATE VIEW app.v_unit_inspection_warning WITH (security_invoker = true) AS
SELECT w.tenant_id, w.inspection_id,
       COALESCE(r.vehicle_id, i.vehicle_id) AS vehicle_id,
       w.id AS warning_id, w.warning_code, w.source,
       -- FR-INS-063's value is a list of unit ids; a depot manager may not learn
       -- another depot's (TYRE-325 Anti-goals). The Rigs screen reads the report.
       CASE WHEN w.warning_code <> 'FR-INS-063' THEN w.entered_value END AS entered_value,
       w.response, w.raised_at, w.reading_id, p.code AS position_code
  FROM app.inspection_warning w
  JOIN app.inspection i ON i.id = w.inspection_id
  LEFT JOIN app.reading r ON r.id = w.reading_id
  LEFT JOIN app.position p ON p.id = r.position_id;

-- "Latest" is app.v_latest_unit_inspection's, joined, never a second DISTINCT
-- ON (000045); a voided inspection and one that read nothing of the unit are
-- never latest by that view's own population.
CREATE VIEW app.v_unit_inspection WITH (security_invoker = true) AS
SELECT u.tenant_id, u.vehicle_id, uv.fleet_number, i.id AS inspection_id, i.state,
       -- The row's own stamps. A row the void reached is frozen (000040), so
       -- they are the void's (000017); a raw insert can plant a row already
       -- VOIDED with stamps of its own, and no route does (submit writes
       -- SYNCED, 000060).
       CASE WHEN i.state = 'VOIDED' THEN i.void_reason END AS void_reason,
       CASE WHEN i.state = 'VOIDED' THEN vb.display_name END AS voided_by_name,
       CASE WHEN i.state = 'VOIDED' THEN i.updated_at END AS voided_at,
       i.started_at, i.submitted_at, i.received_at,
       i.user_id AS driver_id, d.display_name AS driver_name,
       (u.vehicle_id = i.vehicle_id) AS addressed_here,
       -- The odometer is the addressed unit's, shown on a towed unit's row as
       -- the unit it was read with, and never a distance (FR-INS-064, U249;
       -- a trailer's distance is TYRE-455's).
       i.vehicle_id AS addressed_vehicle_id, av.fleet_number AS addressed_fleet_number,
       i.odometer,
       -- Whether the timeline took it: submit keeps the inspection and warns
       -- when DR-020 refuses the reading (000060), and submit files it on the
       -- addressed unit alone, so the lookup names that unit.
       CASE WHEN i.odometer IS NOT NULL THEN EXISTS (
         SELECT 1 FROM app.vehicle_odometer_reading o
          WHERE o.tenant_id = i.tenant_id AND o.vehicle_id = i.vehicle_id AND o.inspection_id = i.id)
       END AS odometer_on_record,
       i.comment, i.defect_report,
       (SELECT count(*) FROM app.reading r
         WHERE r.tenant_id = u.tenant_id AND r.vehicle_id = u.vehicle_id AND r.inspection_id = i.id)::int AS positions_read,
       (SELECT count(*) FROM app.v_unit_inspection_warning w
         WHERE w.inspection_id = i.id AND w.vehicle_id = u.vehicle_id)::int AS warning_count,
       (l.inspection_id IS NOT NULL) AS is_latest
  -- app.inspection_read_unit's two arms, addressed or read (000060), as a
  -- top-level set so a filter on either key reaches both arms' indexes.
  -- Suite section 82f pins the pairs to the function both ways.
  FROM (SELECT i0.tenant_id, i0.id AS inspection_id, i0.vehicle_id FROM app.inspection i0
        UNION
        SELECT r0.tenant_id, r0.inspection_id, r0.vehicle_id FROM app.reading r0) u
  JOIN app.inspection i ON i.id = u.inspection_id
  JOIN app.vehicle uv ON uv.id = u.vehicle_id
  JOIN app.vehicle av ON av.id = i.vehicle_id
  JOIN app.app_user d ON d.id = i.user_id
  LEFT JOIN app.app_user vb ON vb.id = i.updated_by
  LEFT JOIN app.v_latest_unit_inspection l
    ON l.tenant_id = u.tenant_id AND l.vehicle_id = u.vehicle_id AND l.inspection_id = i.id;

-- Every reading, voided inspections' included: app.v_reading_detail drops
-- them and the analytics views read it, so it is not widened.
CREATE VIEW app.v_inspection_reading WITH (security_invoker = true) AS
SELECT r.tenant_id, r.inspection_id, r.vehicle_id, r.id AS reading_id,
       p.id AS position_id, p.code AS position_code, p.sequence, p.axle_number, p.axle_class,
       p.side, p.slot, p.is_spare,
       r.tyre_id, t.display_code,
       r.governing_tread_mm, m.measurements, m.anatomy, m.orientation_known,
       -- Locates the stored minimum among the measurements; it computes none
       -- (rule 4, CR-011). The first of equal readings is the one marked.
       m.governing_ordinal,
       r.pressure_kpa, r.pressure_temperature,
       -- The resolver and instant app.v_exception judges by (000045), so the
       -- two agree on a latest inspection. Referenced once, so it needs no
       -- OFFSET 0 fence, and the view carries the target and nothing derived
       -- from it (TYRE-325 Lead's call 11).
       (app.target_pressure_for(r.tenant_id, t.size_id, p.axle_class, i.submitted_at)).target_kpa AS target_kpa,
       r.damage_flag, r.damage_type, r.wear_pattern, r.note
  FROM app.reading r
  JOIN app.inspection i ON i.id = r.inspection_id
  JOIN app.position p ON p.id = r.position_id
  LEFT JOIN app.tyre t ON t.id = r.tyre_id
  CROSS JOIN LATERAL (
       SELECT array_agg(rm.tread_mm ORDER BY rm.ordinal) AS measurements,
              array_agg(rm.position ORDER BY rm.ordinal) AS anatomy,
              bool_and(rm.orientation_known) AS orientation_known,
              min(rm.ordinal) FILTER (WHERE rm.tread_mm = r.governing_tread_mm) AS governing_ordinal
         FROM app.reading_measurement rm
        WHERE rm.reading_id = r.id) m;
