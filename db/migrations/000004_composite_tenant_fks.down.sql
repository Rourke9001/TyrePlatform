-- Reverses 000004 to the schema exactly as 000003 left it — id-only foreign
-- keys, the 000001 trigger function, no (tenant_id, id) keys — so the
-- migration chain replays cleanly. This state carries the cross-tenant write
-- path 000004 closes (TYRE-29); 004_tests.sql check 16 fails on it by design.

-- 000001's definition. CREATE OR REPLACE resets attributes it does not
-- restate: SECURITY DEFINER must be repeated (the trigger updates
-- app.reading, which app_rw cannot), and omitting the SET clause clears the
-- pinned search_path.
CREATE OR REPLACE FUNCTION app.refresh_governing_tread() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE target uuid;
BEGIN
  target := COALESCE(NEW.reading_id, OLD.reading_id);
  UPDATE app.reading r
     SET governing_tread_mm = (SELECT min(m.tread_mm)
                                 FROM app.reading_measurement m
                                WHERE m.reading_id = target)
   WHERE r.id = target;
  RETURN NULL;
END $$;

ALTER TABLE app.user_depot
  DROP CONSTRAINT user_depot_user_id_fkey,
  ADD  CONSTRAINT user_depot_user_id_fkey  FOREIGN KEY (user_id)  REFERENCES app.app_user (id) ON DELETE CASCADE,
  DROP CONSTRAINT user_depot_depot_id_fkey,
  ADD  CONSTRAINT user_depot_depot_id_fkey FOREIGN KEY (depot_id) REFERENCES app.depot (id) ON DELETE CASCADE;

ALTER TABLE app.position
  DROP CONSTRAINT position_configuration_id_fkey,
  ADD  CONSTRAINT position_configuration_id_fkey FOREIGN KEY (configuration_id) REFERENCES app.axle_configuration (id) ON DELETE CASCADE;

ALTER TABLE app.vehicle
  DROP CONSTRAINT vehicle_configuration_id_fkey,
  ADD  CONSTRAINT vehicle_configuration_id_fkey FOREIGN KEY (configuration_id) REFERENCES app.axle_configuration (id),
  DROP CONSTRAINT vehicle_home_depot_id_fkey,
  ADD  CONSTRAINT vehicle_home_depot_id_fkey    FOREIGN KEY (home_depot_id)    REFERENCES app.depot (id);

ALTER TABLE app.vehicle_driver
  DROP CONSTRAINT vehicle_driver_vehicle_id_fkey,
  ADD  CONSTRAINT vehicle_driver_vehicle_id_fkey FOREIGN KEY (vehicle_id) REFERENCES app.vehicle (id) ON DELETE CASCADE,
  DROP CONSTRAINT vehicle_driver_user_id_fkey,
  ADD  CONSTRAINT vehicle_driver_user_id_fkey    FOREIGN KEY (user_id)    REFERENCES app.app_user (id);

ALTER TABLE app.combination
  DROP CONSTRAINT combination_motive_vehicle_id_fkey,
  ADD  CONSTRAINT combination_motive_vehicle_id_fkey FOREIGN KEY (motive_vehicle_id) REFERENCES app.vehicle (id),
  DROP CONSTRAINT combination_configuration_id_fkey,
  ADD  CONSTRAINT combination_configuration_id_fkey  FOREIGN KEY (configuration_id)  REFERENCES app.axle_configuration (id);

ALTER TABLE app.combination_member
  DROP CONSTRAINT combination_member_combination_id_fkey,
  ADD  CONSTRAINT combination_member_combination_id_fkey FOREIGN KEY (combination_id) REFERENCES app.combination (id) ON DELETE CASCADE,
  DROP CONSTRAINT combination_member_vehicle_id_fkey,
  ADD  CONSTRAINT combination_member_vehicle_id_fkey     FOREIGN KEY (vehicle_id)     REFERENCES app.vehicle (id);

ALTER TABLE app.combination_position_map
  DROP CONSTRAINT combination_position_map_configuration_id_fkey,
  ADD  CONSTRAINT combination_position_map_configuration_id_fkey FOREIGN KEY (configuration_id) REFERENCES app.axle_configuration (id) ON DELETE CASCADE;

ALTER TABLE app.tyre_pattern
  DROP CONSTRAINT tyre_pattern_brand_id_fkey,
  ADD  CONSTRAINT tyre_pattern_brand_id_fkey FOREIGN KEY (brand_id) REFERENCES app.tyre_brand (id);

ALTER TABLE app.tyre
  DROP CONSTRAINT tyre_size_id_fkey,
  ADD  CONSTRAINT tyre_size_id_fkey          FOREIGN KEY (size_id)          REFERENCES app.tyre_size (id),
  DROP CONSTRAINT tyre_brand_id_fkey,
  ADD  CONSTRAINT tyre_brand_id_fkey         FOREIGN KEY (brand_id)         REFERENCES app.tyre_brand (id),
  DROP CONSTRAINT tyre_pattern_id_fkey,
  ADD  CONSTRAINT tyre_pattern_id_fkey       FOREIGN KEY (pattern_id)       REFERENCES app.tyre_pattern (id),
  DROP CONSTRAINT tyre_current_depot_id_fkey,
  ADD  CONSTRAINT tyre_current_depot_id_fkey FOREIGN KEY (current_depot_id) REFERENCES app.depot (id);

ALTER TABLE app.fitment
  DROP CONSTRAINT fitment_tyre_id_fkey,
  ADD  CONSTRAINT fitment_tyre_id_fkey     FOREIGN KEY (tyre_id)     REFERENCES app.tyre (id),
  DROP CONSTRAINT fitment_vehicle_id_fkey,
  ADD  CONSTRAINT fitment_vehicle_id_fkey  FOREIGN KEY (vehicle_id)  REFERENCES app.vehicle (id),
  DROP CONSTRAINT fitment_position_id_fkey,
  ADD  CONSTRAINT fitment_position_id_fkey FOREIGN KEY (position_id) REFERENCES app.position (id);

ALTER TABLE app.inspection
  DROP CONSTRAINT inspection_vehicle_id_fkey,
  ADD  CONSTRAINT inspection_vehicle_id_fkey     FOREIGN KEY (vehicle_id)     REFERENCES app.vehicle (id),
  DROP CONSTRAINT inspection_combination_id_fkey,
  ADD  CONSTRAINT inspection_combination_id_fkey FOREIGN KEY (combination_id) REFERENCES app.combination (id),
  DROP CONSTRAINT inspection_user_id_fkey,
  ADD  CONSTRAINT inspection_user_id_fkey        FOREIGN KEY (user_id)        REFERENCES app.app_user (id);

ALTER TABLE app.reading
  DROP CONSTRAINT reading_inspection_id_fkey,
  ADD  CONSTRAINT reading_inspection_id_fkey FOREIGN KEY (inspection_id) REFERENCES app.inspection (id) ON DELETE CASCADE,
  DROP CONSTRAINT reading_vehicle_id_fkey,
  ADD  CONSTRAINT reading_vehicle_id_fkey    FOREIGN KEY (vehicle_id)    REFERENCES app.vehicle (id),
  DROP CONSTRAINT reading_position_id_fkey,
  ADD  CONSTRAINT reading_position_id_fkey   FOREIGN KEY (position_id)   REFERENCES app.position (id),
  DROP CONSTRAINT reading_tyre_id_fkey,
  ADD  CONSTRAINT reading_tyre_id_fkey       FOREIGN KEY (tyre_id)       REFERENCES app.tyre (id);

ALTER TABLE app.reading_measurement
  DROP CONSTRAINT reading_measurement_reading_id_fkey,
  ADD  CONSTRAINT reading_measurement_reading_id_fkey FOREIGN KEY (reading_id) REFERENCES app.reading (id) ON DELETE CASCADE;

ALTER TABLE app.photo
  DROP CONSTRAINT photo_reading_id_fkey,
  ADD  CONSTRAINT photo_reading_id_fkey FOREIGN KEY (reading_id) REFERENCES app.reading (id) ON DELETE CASCADE;

ALTER TABLE app.tyre_event
  DROP CONSTRAINT tyre_event_tyre_id_fkey,
  ADD  CONSTRAINT tyre_event_tyre_id_fkey              FOREIGN KEY (tyre_id)              REFERENCES app.tyre (id),
  DROP CONSTRAINT tyre_event_actor_id_fkey,
  ADD  CONSTRAINT tyre_event_actor_id_fkey             FOREIGN KEY (actor_id)             REFERENCES app.app_user (id),
  DROP CONSTRAINT tyre_event_compensates_event_id_fkey,
  ADD  CONSTRAINT tyre_event_compensates_event_id_fkey FOREIGN KEY (compensates_event_id) REFERENCES app.tyre_event (id);

ALTER TABLE app.valuation_snapshot
  DROP CONSTRAINT valuation_snapshot_tyre_id_fkey,
  ADD  CONSTRAINT valuation_snapshot_tyre_id_fkey FOREIGN KEY (tyre_id) REFERENCES app.tyre (id);

ALTER TABLE app.exception
  DROP CONSTRAINT exception_rule_id_fkey,
  ADD  CONSTRAINT exception_rule_id_fkey            FOREIGN KEY (rule_id)            REFERENCES app.exception_rule (id),
  DROP CONSTRAINT exception_assignee_id_fkey,
  ADD  CONSTRAINT exception_assignee_id_fkey        FOREIGN KEY (assignee_id)        REFERENCES app.app_user (id),
  DROP CONSTRAINT exception_resolving_event_id_fkey,
  ADD  CONSTRAINT exception_resolving_event_id_fkey FOREIGN KEY (resolving_event_id) REFERENCES app.tyre_event (id);

ALTER TABLE app.notification
  DROP CONSTRAINT notification_user_id_fkey,
  ADD  CONSTRAINT notification_user_id_fkey      FOREIGN KEY (user_id)      REFERENCES app.app_user (id),
  DROP CONSTRAINT notification_exception_id_fkey,
  ADD  CONSTRAINT notification_exception_id_fkey FOREIGN KEY (exception_id) REFERENCES app.exception (id);

ALTER TABLE app.depot              DROP CONSTRAINT depot_tenant_id_id_key;
ALTER TABLE app.app_user           DROP CONSTRAINT app_user_tenant_id_id_key;
ALTER TABLE app.axle_configuration DROP CONSTRAINT axle_configuration_tenant_id_id_key;
ALTER TABLE app.position           DROP CONSTRAINT position_tenant_id_id_key;
ALTER TABLE app.vehicle            DROP CONSTRAINT vehicle_tenant_id_id_key;
ALTER TABLE app.combination        DROP CONSTRAINT combination_tenant_id_id_key;
ALTER TABLE app.tyre_size          DROP CONSTRAINT tyre_size_tenant_id_id_key;
ALTER TABLE app.tyre_brand         DROP CONSTRAINT tyre_brand_tenant_id_id_key;
ALTER TABLE app.tyre_pattern       DROP CONSTRAINT tyre_pattern_tenant_id_id_key;
ALTER TABLE app.tyre               DROP CONSTRAINT tyre_tenant_id_id_key;
ALTER TABLE app.inspection         DROP CONSTRAINT inspection_tenant_id_id_key;
ALTER TABLE app.reading            DROP CONSTRAINT reading_tenant_id_id_key;
ALTER TABLE app.tyre_event         DROP CONSTRAINT tyre_event_tenant_id_id_key;
ALTER TABLE app.exception_rule     DROP CONSTRAINT exception_rule_tenant_id_id_key;
ALTER TABLE app.exception          DROP CONSTRAINT exception_tenant_id_id_key;
