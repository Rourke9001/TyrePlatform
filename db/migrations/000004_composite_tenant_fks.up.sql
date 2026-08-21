-- ============================================================================
--  Composite tenant foreign keys (TYRE-29)
--  Implements: CR-001, DR-017; closes the FK-bypasses-RLS cross-tenant write.
--
--  Foreign-key checks run below row-level security by design, so an id-only
--  FK accepts a reference to a row the inserting session cannot see. Through
--  the governing-tread trigger that became a cross-tenant WRITE: a foreign
--  measurement drags the victim's materialised MIN down (BR-VAL-001 value
--  understated, false FR-EXC-020 exceptions). Every FK between tenant-scoped
--  tables therefore carries tenant_id, so the constraint itself cannot match
--  a row in another tenant. 004_tests.sql check 16 sweeps the catalog for
--  regressions.
-- ============================================================================

-- The composite FKs need (tenant_id, id) to be a declared key on each parent.
-- app_user: tenant_id is NULL for PLATFORM_ADMIN (FR-AUT-003); NULLS DISTINCT
-- keeps those rows from colliding, and a NULL parent key never matches a
-- child, so a tenant row cannot reference platform staff. Accepted for the
-- POC — platform staff do not act inside a tenant.
ALTER TABLE app.depot              ADD CONSTRAINT depot_tenant_id_id_key              UNIQUE (tenant_id, id);
ALTER TABLE app.app_user           ADD CONSTRAINT app_user_tenant_id_id_key           UNIQUE (tenant_id, id);
ALTER TABLE app.axle_configuration ADD CONSTRAINT axle_configuration_tenant_id_id_key UNIQUE (tenant_id, id);
ALTER TABLE app.position           ADD CONSTRAINT position_tenant_id_id_key           UNIQUE (tenant_id, id);
ALTER TABLE app.vehicle            ADD CONSTRAINT vehicle_tenant_id_id_key            UNIQUE (tenant_id, id);
ALTER TABLE app.combination        ADD CONSTRAINT combination_tenant_id_id_key        UNIQUE (tenant_id, id);
ALTER TABLE app.tyre_size          ADD CONSTRAINT tyre_size_tenant_id_id_key          UNIQUE (tenant_id, id);
ALTER TABLE app.tyre_brand         ADD CONSTRAINT tyre_brand_tenant_id_id_key         UNIQUE (tenant_id, id);
ALTER TABLE app.tyre_pattern       ADD CONSTRAINT tyre_pattern_tenant_id_id_key       UNIQUE (tenant_id, id);
ALTER TABLE app.tyre               ADD CONSTRAINT tyre_tenant_id_id_key               UNIQUE (tenant_id, id);
ALTER TABLE app.inspection         ADD CONSTRAINT inspection_tenant_id_id_key         UNIQUE (tenant_id, id);
ALTER TABLE app.reading            ADD CONSTRAINT reading_tenant_id_id_key            UNIQUE (tenant_id, id);
ALTER TABLE app.tyre_event         ADD CONSTRAINT tyre_event_tenant_id_id_key         UNIQUE (tenant_id, id);
ALTER TABLE app.exception_rule     ADD CONSTRAINT exception_rule_tenant_id_id_key     UNIQUE (tenant_id, id);
ALTER TABLE app.exception          ADD CONSTRAINT exception_tenant_id_id_key          UNIQUE (tenant_id, id);

-- Each FK keeps its name and ON DELETE action; only the column list widens.
-- Nullable references keep their optionality: MATCH SIMPLE skips the check
-- when the referencing id is NULL, exactly as the id-only form did.
ALTER TABLE app.user_depot
  DROP CONSTRAINT user_depot_user_id_fkey,
  ADD  CONSTRAINT user_depot_user_id_fkey  FOREIGN KEY (tenant_id, user_id)  REFERENCES app.app_user (tenant_id, id) ON DELETE CASCADE,
  DROP CONSTRAINT user_depot_depot_id_fkey,
  ADD  CONSTRAINT user_depot_depot_id_fkey FOREIGN KEY (tenant_id, depot_id) REFERENCES app.depot (tenant_id, id) ON DELETE CASCADE;

ALTER TABLE app.position
  DROP CONSTRAINT position_configuration_id_fkey,
  ADD  CONSTRAINT position_configuration_id_fkey FOREIGN KEY (tenant_id, configuration_id) REFERENCES app.axle_configuration (tenant_id, id) ON DELETE CASCADE;

ALTER TABLE app.vehicle
  DROP CONSTRAINT vehicle_configuration_id_fkey,
  ADD  CONSTRAINT vehicle_configuration_id_fkey FOREIGN KEY (tenant_id, configuration_id) REFERENCES app.axle_configuration (tenant_id, id),
  DROP CONSTRAINT vehicle_home_depot_id_fkey,
  ADD  CONSTRAINT vehicle_home_depot_id_fkey    FOREIGN KEY (tenant_id, home_depot_id)    REFERENCES app.depot (tenant_id, id);

ALTER TABLE app.vehicle_driver
  DROP CONSTRAINT vehicle_driver_vehicle_id_fkey,
  ADD  CONSTRAINT vehicle_driver_vehicle_id_fkey FOREIGN KEY (tenant_id, vehicle_id) REFERENCES app.vehicle (tenant_id, id) ON DELETE CASCADE,
  DROP CONSTRAINT vehicle_driver_user_id_fkey,
  ADD  CONSTRAINT vehicle_driver_user_id_fkey    FOREIGN KEY (tenant_id, user_id)    REFERENCES app.app_user (tenant_id, id);

ALTER TABLE app.combination
  DROP CONSTRAINT combination_motive_vehicle_id_fkey,
  ADD  CONSTRAINT combination_motive_vehicle_id_fkey FOREIGN KEY (tenant_id, motive_vehicle_id) REFERENCES app.vehicle (tenant_id, id),
  DROP CONSTRAINT combination_configuration_id_fkey,
  ADD  CONSTRAINT combination_configuration_id_fkey  FOREIGN KEY (tenant_id, configuration_id)  REFERENCES app.axle_configuration (tenant_id, id);

ALTER TABLE app.combination_member
  DROP CONSTRAINT combination_member_combination_id_fkey,
  ADD  CONSTRAINT combination_member_combination_id_fkey FOREIGN KEY (tenant_id, combination_id) REFERENCES app.combination (tenant_id, id) ON DELETE CASCADE,
  DROP CONSTRAINT combination_member_vehicle_id_fkey,
  ADD  CONSTRAINT combination_member_vehicle_id_fkey     FOREIGN KEY (tenant_id, vehicle_id)     REFERENCES app.vehicle (tenant_id, id);

ALTER TABLE app.combination_position_map
  DROP CONSTRAINT combination_position_map_configuration_id_fkey,
  ADD  CONSTRAINT combination_position_map_configuration_id_fkey FOREIGN KEY (tenant_id, configuration_id) REFERENCES app.axle_configuration (tenant_id, id) ON DELETE CASCADE;

ALTER TABLE app.tyre_pattern
  DROP CONSTRAINT tyre_pattern_brand_id_fkey,
  ADD  CONSTRAINT tyre_pattern_brand_id_fkey FOREIGN KEY (tenant_id, brand_id) REFERENCES app.tyre_brand (tenant_id, id);

ALTER TABLE app.tyre
  DROP CONSTRAINT tyre_size_id_fkey,
  ADD  CONSTRAINT tyre_size_id_fkey          FOREIGN KEY (tenant_id, size_id)          REFERENCES app.tyre_size (tenant_id, id),
  DROP CONSTRAINT tyre_brand_id_fkey,
  ADD  CONSTRAINT tyre_brand_id_fkey         FOREIGN KEY (tenant_id, brand_id)         REFERENCES app.tyre_brand (tenant_id, id),
  DROP CONSTRAINT tyre_pattern_id_fkey,
  ADD  CONSTRAINT tyre_pattern_id_fkey       FOREIGN KEY (tenant_id, pattern_id)       REFERENCES app.tyre_pattern (tenant_id, id),
  DROP CONSTRAINT tyre_current_depot_id_fkey,
  ADD  CONSTRAINT tyre_current_depot_id_fkey FOREIGN KEY (tenant_id, current_depot_id) REFERENCES app.depot (tenant_id, id);

ALTER TABLE app.fitment
  DROP CONSTRAINT fitment_tyre_id_fkey,
  ADD  CONSTRAINT fitment_tyre_id_fkey     FOREIGN KEY (tenant_id, tyre_id)     REFERENCES app.tyre (tenant_id, id),
  DROP CONSTRAINT fitment_vehicle_id_fkey,
  ADD  CONSTRAINT fitment_vehicle_id_fkey  FOREIGN KEY (tenant_id, vehicle_id)  REFERENCES app.vehicle (tenant_id, id),
  DROP CONSTRAINT fitment_position_id_fkey,
  ADD  CONSTRAINT fitment_position_id_fkey FOREIGN KEY (tenant_id, position_id) REFERENCES app.position (tenant_id, id);

ALTER TABLE app.inspection
  DROP CONSTRAINT inspection_vehicle_id_fkey,
  ADD  CONSTRAINT inspection_vehicle_id_fkey     FOREIGN KEY (tenant_id, vehicle_id)     REFERENCES app.vehicle (tenant_id, id),
  DROP CONSTRAINT inspection_combination_id_fkey,
  ADD  CONSTRAINT inspection_combination_id_fkey FOREIGN KEY (tenant_id, combination_id) REFERENCES app.combination (tenant_id, id),
  DROP CONSTRAINT inspection_user_id_fkey,
  ADD  CONSTRAINT inspection_user_id_fkey        FOREIGN KEY (tenant_id, user_id)        REFERENCES app.app_user (tenant_id, id);

ALTER TABLE app.reading
  DROP CONSTRAINT reading_inspection_id_fkey,
  ADD  CONSTRAINT reading_inspection_id_fkey FOREIGN KEY (tenant_id, inspection_id) REFERENCES app.inspection (tenant_id, id) ON DELETE CASCADE,
  DROP CONSTRAINT reading_vehicle_id_fkey,
  ADD  CONSTRAINT reading_vehicle_id_fkey    FOREIGN KEY (tenant_id, vehicle_id)    REFERENCES app.vehicle (tenant_id, id),
  DROP CONSTRAINT reading_position_id_fkey,
  ADD  CONSTRAINT reading_position_id_fkey   FOREIGN KEY (tenant_id, position_id)   REFERENCES app.position (tenant_id, id),
  DROP CONSTRAINT reading_tyre_id_fkey,
  ADD  CONSTRAINT reading_tyre_id_fkey       FOREIGN KEY (tenant_id, tyre_id)       REFERENCES app.tyre (tenant_id, id);

ALTER TABLE app.reading_measurement
  DROP CONSTRAINT reading_measurement_reading_id_fkey,
  ADD  CONSTRAINT reading_measurement_reading_id_fkey FOREIGN KEY (tenant_id, reading_id) REFERENCES app.reading (tenant_id, id) ON DELETE CASCADE;

ALTER TABLE app.photo
  DROP CONSTRAINT photo_reading_id_fkey,
  ADD  CONSTRAINT photo_reading_id_fkey FOREIGN KEY (tenant_id, reading_id) REFERENCES app.reading (tenant_id, id) ON DELETE CASCADE;

ALTER TABLE app.tyre_event
  DROP CONSTRAINT tyre_event_tyre_id_fkey,
  ADD  CONSTRAINT tyre_event_tyre_id_fkey              FOREIGN KEY (tenant_id, tyre_id)              REFERENCES app.tyre (tenant_id, id),
  DROP CONSTRAINT tyre_event_actor_id_fkey,
  ADD  CONSTRAINT tyre_event_actor_id_fkey             FOREIGN KEY (tenant_id, actor_id)             REFERENCES app.app_user (tenant_id, id),
  DROP CONSTRAINT tyre_event_compensates_event_id_fkey,
  ADD  CONSTRAINT tyre_event_compensates_event_id_fkey FOREIGN KEY (tenant_id, compensates_event_id) REFERENCES app.tyre_event (tenant_id, id);

ALTER TABLE app.valuation_snapshot
  DROP CONSTRAINT valuation_snapshot_tyre_id_fkey,
  ADD  CONSTRAINT valuation_snapshot_tyre_id_fkey FOREIGN KEY (tenant_id, tyre_id) REFERENCES app.tyre (tenant_id, id);

ALTER TABLE app.exception
  DROP CONSTRAINT exception_rule_id_fkey,
  ADD  CONSTRAINT exception_rule_id_fkey            FOREIGN KEY (tenant_id, rule_id)            REFERENCES app.exception_rule (tenant_id, id),
  DROP CONSTRAINT exception_assignee_id_fkey,
  ADD  CONSTRAINT exception_assignee_id_fkey        FOREIGN KEY (tenant_id, assignee_id)        REFERENCES app.app_user (tenant_id, id),
  DROP CONSTRAINT exception_resolving_event_id_fkey,
  ADD  CONSTRAINT exception_resolving_event_id_fkey FOREIGN KEY (tenant_id, resolving_event_id) REFERENCES app.tyre_event (tenant_id, id);

ALTER TABLE app.notification
  DROP CONSTRAINT notification_user_id_fkey,
  ADD  CONSTRAINT notification_user_id_fkey      FOREIGN KEY (tenant_id, user_id)      REFERENCES app.app_user (tenant_id, id),
  DROP CONSTRAINT notification_exception_id_fkey,
  ADD  CONSTRAINT notification_exception_id_fkey FOREIGN KEY (tenant_id, exception_id) REFERENCES app.exception (tenant_id, id);

-- DR-017: governing depth is always MIN of that reading's measurements.
-- The composite FK above is the enforcement for the cross-tenant case; the
-- tenant check here is a backstop, because this function runs as its DEFINER
-- and RLS never binds it — any future FK regression would otherwise reopen
-- the silent cross-tenant write (CR-001). search_path is pinned for the
-- separate definer-hijack vector: an attacker-created operator or function
-- earlier on the caller's path would also run with the definer's rights.
CREATE OR REPLACE FUNCTION app.refresh_governing_tread() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp AS $$
DECLARE target uuid; row_tenant uuid; target_tenant uuid;
BEGIN
  target     := COALESCE(NEW.reading_id, OLD.reading_id);
  row_tenant := COALESCE(NEW.tenant_id,  OLD.tenant_id);
  SELECT r.tenant_id INTO target_tenant FROM app.reading r WHERE r.id = target;
  -- No reading left means this measurement is being cascade-deleted with its
  -- reading: nothing to guard, nothing to refresh.
  IF target_tenant IS NULL THEN
    RETURN NULL;
  END IF;
  IF target_tenant <> row_tenant THEN
    RAISE EXCEPTION 'reading_measurement tenant does not match reading tenant'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE app.reading r
     SET governing_tread_mm = (SELECT min(m.tread_mm)
                                 FROM app.reading_measurement m
                                WHERE m.reading_id = target)
   WHERE r.id = target;
  RETURN NULL;
END $$;
