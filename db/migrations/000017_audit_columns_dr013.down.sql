-- Reverses 000017. Dropping a column drops any constraint defined solely on
-- it (the created_by FKs), so no separate DROP CONSTRAINT is needed. Triggers
-- are dropped before the shared function they call.

DROP TRIGGER tenant_stamps_updated ON app.tenant;
ALTER TABLE app.tenant DROP COLUMN created_by, DROP COLUMN updated_at, DROP COLUMN updated_by;

DROP TRIGGER configuration_stamps_updated ON app.configuration;
ALTER TABLE app.configuration
  DROP CONSTRAINT configuration_created_by_fkey,
  DROP COLUMN updated_at,
  DROP COLUMN updated_by;

DROP TRIGGER depot_stamps_updated ON app.depot;
ALTER TABLE app.depot DROP COLUMN created_by, DROP COLUMN updated_at, DROP COLUMN updated_by;

DROP TRIGGER app_user_stamps_updated ON app.app_user;
ALTER TABLE app.app_user DROP COLUMN created_by, DROP COLUMN updated_at, DROP COLUMN updated_by;

DROP TRIGGER user_depot_stamps_updated ON app.user_depot;
ALTER TABLE app.user_depot DROP COLUMN created_by, DROP COLUMN updated_at, DROP COLUMN updated_by;

DROP TRIGGER axle_configuration_stamps_updated ON app.axle_configuration;
ALTER TABLE app.axle_configuration DROP COLUMN created_by, DROP COLUMN updated_at, DROP COLUMN updated_by;

DROP TRIGGER position_stamps_updated ON app.position;
ALTER TABLE app.position
  DROP COLUMN created_at, DROP COLUMN created_by, DROP COLUMN updated_at, DROP COLUMN updated_by;

DROP TRIGGER vehicle_stamps_updated ON app.vehicle;
ALTER TABLE app.vehicle DROP COLUMN created_by, DROP COLUMN updated_at, DROP COLUMN updated_by;

DROP TRIGGER vehicle_driver_stamps_updated ON app.vehicle_driver;
ALTER TABLE app.vehicle_driver
  DROP COLUMN created_at, DROP COLUMN created_by, DROP COLUMN updated_at, DROP COLUMN updated_by;

DROP TRIGGER combination_stamps_updated ON app.combination;
ALTER TABLE app.combination
  DROP COLUMN created_at, DROP COLUMN created_by, DROP COLUMN updated_at, DROP COLUMN updated_by;

DROP TRIGGER combination_member_stamps_updated ON app.combination_member;
ALTER TABLE app.combination_member
  DROP COLUMN created_at, DROP COLUMN created_by, DROP COLUMN updated_at, DROP COLUMN updated_by;

DROP TRIGGER tyre_size_stamps_updated ON app.tyre_size;
ALTER TABLE app.tyre_size
  DROP COLUMN created_at, DROP COLUMN created_by, DROP COLUMN updated_at, DROP COLUMN updated_by;

DROP TRIGGER tyre_brand_stamps_updated ON app.tyre_brand;
ALTER TABLE app.tyre_brand
  DROP COLUMN created_at, DROP COLUMN created_by, DROP COLUMN updated_at, DROP COLUMN updated_by;

DROP TRIGGER tyre_pattern_stamps_updated ON app.tyre_pattern;
ALTER TABLE app.tyre_pattern
  DROP COLUMN created_at, DROP COLUMN created_by, DROP COLUMN updated_at, DROP COLUMN updated_by;

DROP TRIGGER tyre_stamps_updated ON app.tyre;
ALTER TABLE app.tyre DROP COLUMN created_by, DROP COLUMN updated_at, DROP COLUMN updated_by;

DROP TRIGGER fitment_stamps_updated ON app.fitment;
ALTER TABLE app.fitment DROP COLUMN created_by, DROP COLUMN updated_at, DROP COLUMN updated_by;

DROP TRIGGER inspection_stamps_updated ON app.inspection;
ALTER TABLE app.inspection
  DROP COLUMN created_at, DROP COLUMN created_by, DROP COLUMN updated_at, DROP COLUMN updated_by;

ALTER TABLE app.reading DROP COLUMN created_at, DROP COLUMN created_by;
ALTER TABLE app.reading_measurement DROP COLUMN created_at, DROP COLUMN created_by;

DROP TRIGGER photo_stamps_updated ON app.photo;
ALTER TABLE app.photo
  DROP COLUMN created_at, DROP COLUMN created_by, DROP COLUMN updated_at, DROP COLUMN updated_by;

ALTER TABLE app.tyre_event DROP COLUMN created_at, DROP COLUMN created_by;

DROP TRIGGER valuation_snapshot_stamps_updated ON app.valuation_snapshot;
ALTER TABLE app.valuation_snapshot
  DROP COLUMN created_at, DROP COLUMN created_by, DROP COLUMN updated_at, DROP COLUMN updated_by;

DROP TRIGGER exception_rule_stamps_updated ON app.exception_rule;
ALTER TABLE app.exception_rule
  DROP COLUMN created_at, DROP COLUMN created_by, DROP COLUMN updated_at, DROP COLUMN updated_by;

DROP TRIGGER exception_stamps_updated ON app.exception;
ALTER TABLE app.exception
  DROP COLUMN created_at, DROP COLUMN created_by, DROP COLUMN updated_at, DROP COLUMN updated_by;

DROP TRIGGER notification_stamps_updated ON app.notification;
ALTER TABLE app.notification
  DROP COLUMN created_at, DROP COLUMN created_by, DROP COLUMN updated_at, DROP COLUMN updated_by;

ALTER TABLE app.audit_log DROP COLUMN created_at, DROP COLUMN created_by;

DROP TRIGGER operating_group_stamps_updated ON app.operating_group;
ALTER TABLE app.operating_group DROP COLUMN created_by, DROP COLUMN updated_at, DROP COLUMN updated_by;

DROP TRIGGER vehicle_tag_stamps_updated ON app.vehicle_tag;
ALTER TABLE app.vehicle_tag
  DROP COLUMN created_at, DROP COLUMN created_by, DROP COLUMN updated_at, DROP COLUMN updated_by;

DROP TRIGGER vehicle_tag_map_stamps_updated ON app.vehicle_tag_map;
ALTER TABLE app.vehicle_tag_map
  DROP COLUMN created_at, DROP COLUMN created_by, DROP COLUMN updated_at, DROP COLUMN updated_by;

ALTER TABLE app.jurisdiction_tread_minimum DROP COLUMN created_at, DROP COLUMN created_by;

DROP TRIGGER threshold_policy_stamps_updated ON app.threshold_policy;
ALTER TABLE app.threshold_policy
  DROP COLUMN created_at, DROP COLUMN updated_at, DROP COLUMN updated_by;

ALTER TABLE app.vehicle_odometer_reading DROP COLUMN created_by;

DROP TRIGGER retread_job_stamps_updated ON app.retread_job;
ALTER TABLE app.retread_job DROP COLUMN created_by, DROP COLUMN updated_at, DROP COLUMN updated_by;

ALTER TABLE app.casing_valuation DROP COLUMN created_at, DROP COLUMN created_by;

DROP TRIGGER casing_estimate_by_size_stamps_updated ON app.casing_estimate_by_size;
ALTER TABLE app.casing_estimate_by_size
  DROP COLUMN created_at, DROP COLUMN updated_at, DROP COLUMN updated_by;

DROP TRIGGER tyre_price_list_stamps_updated ON app.tyre_price_list;
ALTER TABLE app.tyre_price_list
  DROP COLUMN created_at, DROP COLUMN updated_at, DROP COLUMN updated_by;

DROP TRIGGER target_pressure_stamps_updated ON app.target_pressure;
ALTER TABLE app.target_pressure
  DROP COLUMN created_at, DROP COLUMN updated_at, DROP COLUMN updated_by;

DROP TRIGGER inspection_schedule_stamps_updated ON app.inspection_schedule;
ALTER TABLE app.inspection_schedule DROP COLUMN updated_at, DROP COLUMN updated_by;

DROP TRIGGER inspection_task_stamps_updated ON app.inspection_task;
ALTER TABLE app.inspection_task DROP COLUMN created_by, DROP COLUMN updated_at, DROP COLUMN updated_by;

ALTER TABLE app.tenant_consent DROP COLUMN created_at, DROP COLUMN created_by;

DROP FUNCTION app.stamp_updated();
