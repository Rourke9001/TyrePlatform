-- GET /api/dashboard's read path (B7 spec B7.2), run as app_login bound to
-- Sandbox Fleet so RLS is in the plan (spec S3, U26). Not a test: db-explain
-- prints this for TYRE-247; dates anchor to gen_seed_volume.py so the window
-- reads the same rows on any day.
--
-- Three figures here are floors, not measurements: the generator writes
-- inspections directly, so the volume tenant has no tyre_event,
-- inspection_warning, composition_observation or inspection_task rows.
-- The overdue-task and pending-composition-report counts plan on empty
-- relations and say nothing about cost on a tenant that has them
-- (accepted risk, TYRE-258).
--
-- Nothing else may touch the database while this runs (docs/lessons.md, 2026-09-16).
\set ON_ERROR_STOP on
\timing on
SET search_path = app, public;
SET app.tenant_id = '33333333-3333-3333-3333-333333333333';

-- Refuse to measure an unloaded tenant: an empty Sandbox Fleet plans every
-- statement in microseconds and would print as comfortably inside U26's
-- budget (docs/lessons.md, 2026-09-16). The count runs under the same RLS
-- predicate as the plans below.
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM app.reading;
  IF n < 10000 THEN
    RAISE EXCEPTION 'this tenant holds % readings, which is not the volume tenant. Run `make db-volume` first', n;
  END IF;
END $$;

BEGIN;

\echo '== casing value at risk'
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM app.v_casing_value_at_risk;
\echo '== estate valuation'
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM app.v_estate_valuation;
\echo '== exceptions'
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM app.v_exception;
\echo '== tyres at risk'
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM app.v_tyre_at_risk;
\echo '== unit inspection status'
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM app.v_unit_inspection_status;
\echo '== inspection tasks (overdue)'
EXPLAIN (ANALYZE, BUFFERS) SELECT count(*) FROM app.v_inspection_task WHERE overdue;
\echo '== pending composition reports'
EXPLAIN (ANALYZE, BUFFERS)
SELECT count(*)
  FROM app.inspection_warning w
  JOIN app.inspection i ON i.id = w.inspection_id
 WHERE w.warning_code = 'FR-INS-063' AND w.source = 'SERVER' AND i.state <> 'VOIDED'
   AND NOT EXISTS (SELECT 1 FROM app.composition_observation o WHERE o.warning_id = w.id);
\echo '== inflation compliance, 30 days to the anchor'
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM app.inflation_compliance(DATE '2026-08-02', DATE '2026-09-01');
\echo '== tread distribution'
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM app.v_tread_distribution;
\echo '== removal forecast'
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM app.v_removal_forecast;
\echo '== irregular wear'
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM app.v_irregular_wear_ranking WHERE NOT is_spare;
\echo '== spares'
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM app.v_spare_tyre_age;

ROLLBACK;
