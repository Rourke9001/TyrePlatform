-- Reverses 000060. Data is one-way: trips and nominations are gone.

-- G.
DROP FUNCTION app.task_driver_at(uuid, timestamptz);
DROP FUNCTION app.task_responsibility_at(uuid, timestamptz);
DROP VIEW app.v_nomination_span;
DROP VIEW app.v_unit_coverage;

-- D.
DROP TRIGGER inspection_task_closes_once ON app.inspection_task;
DROP FUNCTION app.inspection_task_closes_once();
ALTER TABLE app.inspection_task DROP CONSTRAINT task_closed_when_not_open;
ALTER TABLE app.inspection_task DROP COLUMN closed_at;

-- C.
DROP TABLE app.inspection_task_nomination;

-- B.
DROP TABLE app.trip;
DROP FUNCTION app.trip_is_ended_once();

-- A.
DROP INDEX app.combination_by_motive;
DROP INDEX app.combination_member_by_vehicle;
ALTER TABLE app.vehicle_driver DROP CONSTRAINT vehicle_driver_tenant_id_id_key;
ALTER TABLE app.inspection_task DROP CONSTRAINT inspection_task_tenant_id_id_key;
