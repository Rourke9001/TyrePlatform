-- The read path GET /api/dashboard will take (B7 spec B7.2 route table),
-- one statement per relation, run as app_login bound to Sandbox Fleet so
-- RLS is in the plan exactly as it will be in production. Not a test: the
-- suite is db/tests; this is what `make db-explain` prints so TYRE-247's
-- decision rests on a plan, not on the 53-reading fixture (spec S3, U26).
-- Dates are the volume tenant's anchor (gen_seed_volume.py), so the
-- window statements read the same rows on any day this is run.
--
-- Three of these figures are floors, not measurements. The generator writes
-- inspections directly rather than through app.submit_inspection, so the
-- volume tenant carries no tyre_event rows (not even for its 345 removals),
-- no inspection_warning, no composition_observation and no inspection_task.
-- The overdue-task count and the pending-composition-report count therefore
-- plan on empty relations and return in microseconds, which says nothing
-- about their cost on a tenant that has them. TYRE-258 carries the gap.
--
-- Nothing else may touch the database while this runs. A concurrent
-- db-reset queues a DROP SCHEMA behind the load's transaction, blocks the
-- whole database, and destroys the load when it unblocks; a concurrent
-- suite run inflates every figure here (docs/lessons.md, 2026-09-16).
\set ON_ERROR_STOP on
\timing on
SET search_path = app, public;
SET app.tenant_id = '33333333-3333-3333-3333-333333333333';
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
