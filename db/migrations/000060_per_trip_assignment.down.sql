-- Reverses 000060. Data is one-way: trips and nominations are gone.

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
