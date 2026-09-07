-- 000043: search_path pinned on the three plpgsql routines that had none
-- (TYRE-181, from the 6 Sep 2026 review sweep, TYRE-143).
--
-- 000039's header reads "a pinned search_path throughout, like every
-- routine in app except app.refresh_governing_tread". That file is frozen,
-- so the rule it meant is stated here: invoker rights throughout, with
-- refresh_governing_tread the one definer (000004); a pinned search_path on
-- every plpgsql routine, because plpgsql resolves unqualified names when it
-- runs and would otherwise follow the caller's path; and no pin on a
-- LANGUAGE sql table function a view is built over, because the planner
-- inlines those and a SET clause blocks the inlining (000036). Suite check
-- 8d holds both halves.
--
-- ALTER rather than CREATE OR REPLACE: no body changes, so the down file
-- has nothing to restore and only RESETs the setting. Migrations CALL
-- app.enable_tenant_rls as postgres; every name it touches arrives as a
-- regclass, so the pin changes nothing it resolves.
ALTER FUNCTION app.check_measurement_ordinals() SET search_path = app, pg_temp;
ALTER PROCEDURE app.enable_tenant_rls(regclass) SET search_path = app, pg_temp;
ALTER FUNCTION app.predicted_threshold_range(uuid, numeric, numeric) SET search_path = app, pg_temp;
