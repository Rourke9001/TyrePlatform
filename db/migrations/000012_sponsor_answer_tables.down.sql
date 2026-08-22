-- Reverses 000012. Drop order is children before parents; the RLS policies,
-- triggers and grants fall with their tables.
DROP VIEW app.v_tyre_awaiting_cost;
DROP VIEW app.v_pressure_uniformity_anomaly;
DROP VIEW app.v_distance_coverage;
DROP VIEW app.v_spare_tyre_age;

ALTER TABLE app.tyre_pattern DROP COLUMN platform_catalogue_id;
ALTER TABLE app.tyre_brand   DROP COLUMN platform_catalogue_id;
ALTER TABLE app.tyre_size    DROP COLUMN platform_catalogue_id;
DROP TABLE app.tenant_consent;

DROP FUNCTION app.generate_inspection_tasks(date);
DROP TABLE app.inspection_task;
DROP TABLE app.inspection_schedule;

ALTER TABLE app.reading DROP COLUMN pressure_temperature;
DROP TABLE app.target_pressure;

DROP TABLE app.tyre_price_list;
DROP TABLE app.casing_estimate_by_size;
DROP TABLE app.casing_valuation;
DROP TABLE app.retread_job;

ALTER TABLE app.tenant DROP COLUMN history_horizon;
DROP TABLE app.vehicle_odometer_reading;
DROP FUNCTION app.check_odometer_plausible();

DROP TABLE app.threshold_policy;
DROP TABLE app.jurisdiction_tread_minimum;

DROP TABLE app.vehicle_tag_map;
DROP TABLE app.vehicle_tag;
ALTER TABLE app.vehicle DROP COLUMN operating_group_id;
DROP TABLE app.operating_group;
