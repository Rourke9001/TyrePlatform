-- ============================================================================
--  DR-013 audit columns: created_at / created_by everywhere, updated_at /
--  updated_by wherever a row can still change (TYRE-30)
--  Implements: DR-013, NFR-PRO-002, FR-AUT-003a (SRS v1.4 §5.2)
--
--  Every table in schema app as it stands after 000014 gets created_at and
--  created_by if it lacks them by that exact name; every table where app_rw
--  still holds UPDATE (i.e. not the append-only set) also gets updated_at,
--  updated_by and a trigger that stamps them. Tables that already carry
--  created_at/created_by (most of 000012's) are left alone — this migration
--  adds what is missing, never re-adds or alters what exists.
--
--  created_at/created_by are added BARE, then given a DEFAULT in a second
--  clause. `ADD COLUMN created_at timestamptz DEFAULT now()` would evaluate
--  now() once and backfill every existing row with the migration's own run
--  time — a fabricated creation time, exactly what NFR-PRO-002 forbids
--  ("absence is absence"). The same applies to created_by's
--  app.current_actor_id() default. Splitting the steps leaves every existing
--  row NULL, and every future INSERT that omits the column still gets a
--  value for free.
--
--  created_by is a composite FK to app.app_user (tenant_id, created_by) —
--  the 000004 house pattern (FR-AUT-003a): an FK check runs below RLS, so an
--  id-only reference would let a row cite a user in another tenant — the
--  TYRE-29 class 000004/000005 close everywhere else (004_tests.sql check 16
--  sweeps the catalog for exactly this regression). Three tables get NO
--  foreign key on created_by, for two different reasons. app.tenant and
--  app.jurisdiction_tread_minimum carry no tenant_id of their own — the
--  composite pattern is structurally impossible for them — and a plain
--  REFERENCES app.app_user(id) would reopen the very id-only, RLS-bypassing
--  reference check 16 exists to catch (app_user IS tenant-scoped even though
--  the referencing row is not), so the attribution stays an unenforced uuid
--  rather than a dangling-reference risk. app.audit_log gets no FK for an
--  unrelated reason: it is an impersonation trail (FR-ADM-004..007) that
--  must stay resolvable even when the actor row it names is later altered
--  or reassigned.
--
--  updated_at/updated_by are nullable with no default — only app.stamp_updated()
--  (the shared BEFORE UPDATE trigger) ever sets them — and updated_by carries
--  no FK: a platform-context update (a migration, a scheduled job with no
--  bound actor) must still be able to write the row, and the column is
--  attribution, not a relation.
--
--  Not added to the append-only set (reading, reading_measurement, tyre_event,
--  audit_log — CR-004/DR-011 — plus 000012's casing_valuation, tenant_consent,
--  vehicle_odometer_reading, and read-only app.jurisdiction_tread_minimum):
--  app_rw holds no UPDATE there, so a stamping trigger would never fire.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- The one trigger function every mutable table shares.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.stamp_updated() RETURNS trigger
LANGUAGE plpgsql SET search_path = app, pg_temp AS $$
BEGIN
  NEW.updated_at := now();
  NEW.updated_by := app.current_actor_id();
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- app.tenant — no tenant_id (it IS the isolation root). created_by carries
-- NO foreign key: app_user is tenant-scoped, so a plain id-only reference
-- from a row with no tenant_id of its own is exactly the dangling
-- cross-tenant reference check 16 forbids (see the file header).
-- ---------------------------------------------------------------------------
ALTER TABLE app.tenant
  ADD COLUMN created_by uuid,
  ALTER COLUMN created_by SET DEFAULT app.current_actor_id(),
  ADD COLUMN updated_at timestamptz,
  ADD COLUMN updated_by uuid;
CREATE TRIGGER tenant_stamps_updated BEFORE UPDATE ON app.tenant
FOR EACH ROW EXECUTE FUNCTION app.stamp_updated();

-- app.configuration already carries both columns (000001); only the FK on
-- created_by was ever missing.
ALTER TABLE app.configuration
  ADD CONSTRAINT configuration_created_by_fkey FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id),
  ADD COLUMN updated_at timestamptz,
  ADD COLUMN updated_by uuid;
CREATE TRIGGER configuration_stamps_updated BEFORE UPDATE ON app.configuration
FOR EACH ROW EXECUTE FUNCTION app.stamp_updated();

ALTER TABLE app.depot
  ADD COLUMN created_by uuid,
  ALTER COLUMN created_by SET DEFAULT app.current_actor_id(),
  ADD CONSTRAINT depot_created_by_fkey FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id),
  ADD COLUMN updated_at timestamptz,
  ADD COLUMN updated_by uuid;
CREATE TRIGGER depot_stamps_updated BEFORE UPDATE ON app.depot
FOR EACH ROW EXECUTE FUNCTION app.stamp_updated();

-- app.app_user's created_by is self-referencing: an ORG_ADMIN invites another
-- app_user row into being (FR-AUT-010). Self-FKs are ordinary in Postgres.
ALTER TABLE app.app_user
  ADD COLUMN created_by uuid,
  ALTER COLUMN created_by SET DEFAULT app.current_actor_id(),
  ADD CONSTRAINT app_user_created_by_fkey FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id),
  ADD COLUMN updated_at timestamptz,
  ADD COLUMN updated_by uuid;
CREATE TRIGGER app_user_stamps_updated BEFORE UPDATE ON app.app_user
FOR EACH ROW EXECUTE FUNCTION app.stamp_updated();

ALTER TABLE app.user_depot
  ADD COLUMN created_by uuid,
  ALTER COLUMN created_by SET DEFAULT app.current_actor_id(),
  ADD CONSTRAINT user_depot_created_by_fkey FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id),
  ADD COLUMN updated_at timestamptz,
  ADD COLUMN updated_by uuid;
CREATE TRIGGER user_depot_stamps_updated BEFORE UPDATE ON app.user_depot
FOR EACH ROW EXECUTE FUNCTION app.stamp_updated();

ALTER TABLE app.axle_configuration
  ADD COLUMN created_by uuid,
  ALTER COLUMN created_by SET DEFAULT app.current_actor_id(),
  ADD CONSTRAINT axle_configuration_created_by_fkey FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id),
  ADD COLUMN updated_at timestamptz,
  ADD COLUMN updated_by uuid;
CREATE TRIGGER axle_configuration_stamps_updated BEFORE UPDATE ON app.axle_configuration
FOR EACH ROW EXECUTE FUNCTION app.stamp_updated();

ALTER TABLE app.position
  ADD COLUMN created_at timestamptz,
  ALTER COLUMN created_at SET DEFAULT now(),
  ADD COLUMN created_by uuid,
  ALTER COLUMN created_by SET DEFAULT app.current_actor_id(),
  ADD CONSTRAINT position_created_by_fkey FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id),
  ADD COLUMN updated_at timestamptz,
  ADD COLUMN updated_by uuid;
CREATE TRIGGER position_stamps_updated BEFORE UPDATE ON app.position
FOR EACH ROW EXECUTE FUNCTION app.stamp_updated();

ALTER TABLE app.vehicle
  ADD COLUMN created_by uuid,
  ALTER COLUMN created_by SET DEFAULT app.current_actor_id(),
  ADD CONSTRAINT vehicle_created_by_fkey FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id),
  ADD COLUMN updated_at timestamptz,
  ADD COLUMN updated_by uuid;
CREATE TRIGGER vehicle_stamps_updated BEFORE UPDATE ON app.vehicle
FOR EACH ROW EXECUTE FUNCTION app.stamp_updated();

ALTER TABLE app.vehicle_driver
  ADD COLUMN created_at timestamptz,
  ALTER COLUMN created_at SET DEFAULT now(),
  ADD COLUMN created_by uuid,
  ALTER COLUMN created_by SET DEFAULT app.current_actor_id(),
  ADD CONSTRAINT vehicle_driver_created_by_fkey FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id),
  ADD COLUMN updated_at timestamptz,
  ADD COLUMN updated_by uuid;
CREATE TRIGGER vehicle_driver_stamps_updated BEFORE UPDATE ON app.vehicle_driver
FOR EACH ROW EXECUTE FUNCTION app.stamp_updated();

ALTER TABLE app.combination
  ADD COLUMN created_at timestamptz,
  ALTER COLUMN created_at SET DEFAULT now(),
  ADD COLUMN created_by uuid,
  ALTER COLUMN created_by SET DEFAULT app.current_actor_id(),
  ADD CONSTRAINT combination_created_by_fkey FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id),
  ADD COLUMN updated_at timestamptz,
  ADD COLUMN updated_by uuid;
CREATE TRIGGER combination_stamps_updated BEFORE UPDATE ON app.combination
FOR EACH ROW EXECUTE FUNCTION app.stamp_updated();

ALTER TABLE app.combination_member
  ADD COLUMN created_at timestamptz,
  ALTER COLUMN created_at SET DEFAULT now(),
  ADD COLUMN created_by uuid,
  ALTER COLUMN created_by SET DEFAULT app.current_actor_id(),
  ADD CONSTRAINT combination_member_created_by_fkey FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id),
  ADD COLUMN updated_at timestamptz,
  ADD COLUMN updated_by uuid;
CREATE TRIGGER combination_member_stamps_updated BEFORE UPDATE ON app.combination_member
FOR EACH ROW EXECUTE FUNCTION app.stamp_updated();

ALTER TABLE app.tyre_size
  ADD COLUMN created_at timestamptz,
  ALTER COLUMN created_at SET DEFAULT now(),
  ADD COLUMN created_by uuid,
  ALTER COLUMN created_by SET DEFAULT app.current_actor_id(),
  ADD CONSTRAINT tyre_size_created_by_fkey FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id),
  ADD COLUMN updated_at timestamptz,
  ADD COLUMN updated_by uuid;
CREATE TRIGGER tyre_size_stamps_updated BEFORE UPDATE ON app.tyre_size
FOR EACH ROW EXECUTE FUNCTION app.stamp_updated();

ALTER TABLE app.tyre_brand
  ADD COLUMN created_at timestamptz,
  ALTER COLUMN created_at SET DEFAULT now(),
  ADD COLUMN created_by uuid,
  ALTER COLUMN created_by SET DEFAULT app.current_actor_id(),
  ADD CONSTRAINT tyre_brand_created_by_fkey FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id),
  ADD COLUMN updated_at timestamptz,
  ADD COLUMN updated_by uuid;
CREATE TRIGGER tyre_brand_stamps_updated BEFORE UPDATE ON app.tyre_brand
FOR EACH ROW EXECUTE FUNCTION app.stamp_updated();

ALTER TABLE app.tyre_pattern
  ADD COLUMN created_at timestamptz,
  ALTER COLUMN created_at SET DEFAULT now(),
  ADD COLUMN created_by uuid,
  ALTER COLUMN created_by SET DEFAULT app.current_actor_id(),
  ADD CONSTRAINT tyre_pattern_created_by_fkey FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id),
  ADD COLUMN updated_at timestamptz,
  ADD COLUMN updated_by uuid;
CREATE TRIGGER tyre_pattern_stamps_updated BEFORE UPDATE ON app.tyre_pattern
FOR EACH ROW EXECUTE FUNCTION app.stamp_updated();

ALTER TABLE app.tyre
  ADD COLUMN created_by uuid,
  ALTER COLUMN created_by SET DEFAULT app.current_actor_id(),
  ADD CONSTRAINT tyre_created_by_fkey FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id),
  ADD COLUMN updated_at timestamptz,
  ADD COLUMN updated_by uuid;
CREATE TRIGGER tyre_stamps_updated BEFORE UPDATE ON app.tyre
FOR EACH ROW EXECUTE FUNCTION app.stamp_updated();

ALTER TABLE app.fitment
  ADD COLUMN created_by uuid,
  ALTER COLUMN created_by SET DEFAULT app.current_actor_id(),
  ADD CONSTRAINT fitment_created_by_fkey FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id),
  ADD COLUMN updated_at timestamptz,
  ADD COLUMN updated_by uuid;
CREATE TRIGGER fitment_stamps_updated BEFORE UPDATE ON app.fitment
FOR EACH ROW EXECUTE FUNCTION app.stamp_updated();

ALTER TABLE app.inspection
  ADD COLUMN created_at timestamptz,
  ALTER COLUMN created_at SET DEFAULT now(),
  ADD COLUMN created_by uuid,
  ALTER COLUMN created_by SET DEFAULT app.current_actor_id(),
  ADD CONSTRAINT inspection_created_by_fkey FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id),
  ADD COLUMN updated_at timestamptz,
  ADD COLUMN updated_by uuid;
CREATE TRIGGER inspection_stamps_updated BEFORE UPDATE ON app.inspection
FOR EACH ROW EXECUTE FUNCTION app.stamp_updated();

-- app.reading is append-only (CR-004): created_at/created_by land, but no
-- updated_at/updated_by and no trigger — app_rw holds no UPDATE here to stamp.
ALTER TABLE app.reading
  ADD COLUMN created_at timestamptz,
  ALTER COLUMN created_at SET DEFAULT now(),
  ADD COLUMN created_by uuid,
  ALTER COLUMN created_by SET DEFAULT app.current_actor_id(),
  ADD CONSTRAINT reading_created_by_fkey FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id);

ALTER TABLE app.reading_measurement
  ADD COLUMN created_at timestamptz,
  ALTER COLUMN created_at SET DEFAULT now(),
  ADD COLUMN created_by uuid,
  ALTER COLUMN created_by SET DEFAULT app.current_actor_id(),
  ADD CONSTRAINT reading_measurement_created_by_fkey FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id);

ALTER TABLE app.photo
  ADD COLUMN created_at timestamptz,
  ALTER COLUMN created_at SET DEFAULT now(),
  ADD COLUMN created_by uuid,
  ALTER COLUMN created_by SET DEFAULT app.current_actor_id(),
  ADD CONSTRAINT photo_created_by_fkey FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id),
  ADD COLUMN updated_at timestamptz,
  ADD COLUMN updated_by uuid;
CREATE TRIGGER photo_stamps_updated BEFORE UPDATE ON app.photo
FOR EACH ROW EXECUTE FUNCTION app.stamp_updated();

-- app.tyre_event is append-only (CR-004): same shape as app.reading above.
ALTER TABLE app.tyre_event
  ADD COLUMN created_at timestamptz,
  ALTER COLUMN created_at SET DEFAULT now(),
  ADD COLUMN created_by uuid,
  ALTER COLUMN created_by SET DEFAULT app.current_actor_id(),
  ADD CONSTRAINT tyre_event_created_by_fkey FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id);

-- app.valuation_snapshot is a cache (000008/000009), not append-only: app_rw
-- still holds UPDATE (the reconcile function's ON CONFLICT DO UPDATE), so it
-- gets the full audit shape.
ALTER TABLE app.valuation_snapshot
  ADD COLUMN created_at timestamptz,
  ALTER COLUMN created_at SET DEFAULT now(),
  ADD COLUMN created_by uuid,
  ALTER COLUMN created_by SET DEFAULT app.current_actor_id(),
  ADD CONSTRAINT valuation_snapshot_created_by_fkey FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id),
  ADD COLUMN updated_at timestamptz,
  ADD COLUMN updated_by uuid;
CREATE TRIGGER valuation_snapshot_stamps_updated BEFORE UPDATE ON app.valuation_snapshot
FOR EACH ROW EXECUTE FUNCTION app.stamp_updated();

ALTER TABLE app.exception_rule
  ADD COLUMN created_at timestamptz,
  ALTER COLUMN created_at SET DEFAULT now(),
  ADD COLUMN created_by uuid,
  ALTER COLUMN created_by SET DEFAULT app.current_actor_id(),
  ADD CONSTRAINT exception_rule_created_by_fkey FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id),
  ADD COLUMN updated_at timestamptz,
  ADD COLUMN updated_by uuid;
CREATE TRIGGER exception_rule_stamps_updated BEFORE UPDATE ON app.exception_rule
FOR EACH ROW EXECUTE FUNCTION app.stamp_updated();

ALTER TABLE app.exception
  ADD COLUMN created_at timestamptz,
  ALTER COLUMN created_at SET DEFAULT now(),
  ADD COLUMN created_by uuid,
  ALTER COLUMN created_by SET DEFAULT app.current_actor_id(),
  ADD CONSTRAINT exception_created_by_fkey FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id),
  ADD COLUMN updated_at timestamptz,
  ADD COLUMN updated_by uuid;
CREATE TRIGGER exception_stamps_updated BEFORE UPDATE ON app.exception
FOR EACH ROW EXECUTE FUNCTION app.stamp_updated();

ALTER TABLE app.notification
  ADD COLUMN created_at timestamptz,
  ALTER COLUMN created_at SET DEFAULT now(),
  ADD COLUMN created_by uuid,
  ALTER COLUMN created_by SET DEFAULT app.current_actor_id(),
  ADD CONSTRAINT notification_created_by_fkey FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id),
  ADD COLUMN updated_at timestamptz,
  ADD COLUMN updated_by uuid;
CREATE TRIGGER notification_stamps_updated BEFORE UPDATE ON app.notification
FOR EACH ROW EXECUTE FUNCTION app.stamp_updated();

-- app.audit_log: columns like everyone, but NO foreign key (FR-ADM-004..007).
-- The audit trail is an impersonation record and must stay resolvable even
-- when the actor it names is later renamed, deactivated or deleted from
-- another tenant's view of the world; a live FK would tie its integrity to
-- app_user rows it has no business depending on. Append-only (CR-004): no
-- updated_at/updated_by, no trigger.
ALTER TABLE app.audit_log
  ADD COLUMN created_at timestamptz,
  ALTER COLUMN created_at SET DEFAULT now(),
  ADD COLUMN created_by uuid,
  ALTER COLUMN created_by SET DEFAULT app.current_actor_id();

-- ---------------------------------------------------------------------------
-- 000012 tables.
-- ---------------------------------------------------------------------------
ALTER TABLE app.operating_group
  ADD COLUMN created_by uuid,
  ALTER COLUMN created_by SET DEFAULT app.current_actor_id(),
  ADD CONSTRAINT operating_group_created_by_fkey FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id),
  ADD COLUMN updated_at timestamptz,
  ADD COLUMN updated_by uuid;
CREATE TRIGGER operating_group_stamps_updated BEFORE UPDATE ON app.operating_group
FOR EACH ROW EXECUTE FUNCTION app.stamp_updated();

ALTER TABLE app.vehicle_tag
  ADD COLUMN created_at timestamptz,
  ALTER COLUMN created_at SET DEFAULT now(),
  ADD COLUMN created_by uuid,
  ALTER COLUMN created_by SET DEFAULT app.current_actor_id(),
  ADD CONSTRAINT vehicle_tag_created_by_fkey FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id),
  ADD COLUMN updated_at timestamptz,
  ADD COLUMN updated_by uuid;
CREATE TRIGGER vehicle_tag_stamps_updated BEFORE UPDATE ON app.vehicle_tag
FOR EACH ROW EXECUTE FUNCTION app.stamp_updated();

ALTER TABLE app.vehicle_tag_map
  ADD COLUMN created_at timestamptz,
  ALTER COLUMN created_at SET DEFAULT now(),
  ADD COLUMN created_by uuid,
  ALTER COLUMN created_by SET DEFAULT app.current_actor_id(),
  ADD CONSTRAINT vehicle_tag_map_created_by_fkey FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id),
  ADD COLUMN updated_at timestamptz,
  ADD COLUMN updated_by uuid;
CREATE TRIGGER vehicle_tag_map_stamps_updated BEFORE UPDATE ON app.vehicle_tag_map
FOR EACH ROW EXECUTE FUNCTION app.stamp_updated();

-- app.jurisdiction_tread_minimum carries no tenant_id (public law, identical
-- for every tenant — 000012): no FK on created_by, as app.tenant above.
-- app_rw holds no write privilege here at all (000012's REVOKE INSERT,
-- UPDATE, DELETE), so no trigger either.
ALTER TABLE app.jurisdiction_tread_minimum
  ADD COLUMN created_at timestamptz,
  ALTER COLUMN created_at SET DEFAULT now(),
  ADD COLUMN created_by uuid,
  ALTER COLUMN created_by SET DEFAULT app.current_actor_id();

-- app.threshold_policy already carries created_by with its FK (000012); only
-- created_at was missing.
ALTER TABLE app.threshold_policy
  ADD COLUMN created_at timestamptz,
  ALTER COLUMN created_at SET DEFAULT now(),
  ADD COLUMN updated_at timestamptz,
  ADD COLUMN updated_by uuid;
CREATE TRIGGER threshold_policy_stamps_updated BEFORE UPDATE ON app.threshold_policy
FOR EACH ROW EXECUTE FUNCTION app.stamp_updated();

-- app.vehicle_odometer_reading is a record of fact (000012 REVOKE UPDATE,
-- DELETE): created_at already exists; created_by was missing. No trigger.
ALTER TABLE app.vehicle_odometer_reading
  ADD COLUMN created_by uuid,
  ALTER COLUMN created_by SET DEFAULT app.current_actor_id(),
  ADD CONSTRAINT vehicle_odometer_reading_created_by_fkey FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id);

ALTER TABLE app.retread_job
  ADD COLUMN created_by uuid,
  ALTER COLUMN created_by SET DEFAULT app.current_actor_id(),
  ADD CONSTRAINT retread_job_created_by_fkey FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id),
  ADD COLUMN updated_at timestamptz,
  ADD COLUMN updated_by uuid;
CREATE TRIGGER retread_job_stamps_updated BEFORE UPDATE ON app.retread_job
FOR EACH ROW EXECUTE FUNCTION app.stamp_updated();

-- app.casing_valuation is append-only (000012 REVOKE UPDATE, DELETE) and
-- already carries its own event attribution (recorded_at / actor_id, with
-- actor_id's own FK from 000012). created_at/created_by are added anyway,
-- literally, for the same reason every other table gets them: a structural
-- sweep for DR-013 checks the column names, not whether an equivalent column
-- exists under a different one. No trigger — no UPDATE grant to stamp.
ALTER TABLE app.casing_valuation
  ADD COLUMN created_at timestamptz,
  ALTER COLUMN created_at SET DEFAULT now(),
  ADD COLUMN created_by uuid,
  ALTER COLUMN created_by SET DEFAULT app.current_actor_id(),
  ADD CONSTRAINT casing_valuation_created_by_fkey FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id);

-- app.casing_estimate_by_size already carries created_by with its FK
-- (000012); only created_at was missing.
ALTER TABLE app.casing_estimate_by_size
  ADD COLUMN created_at timestamptz,
  ALTER COLUMN created_at SET DEFAULT now(),
  ADD COLUMN updated_at timestamptz,
  ADD COLUMN updated_by uuid;
CREATE TRIGGER casing_estimate_by_size_stamps_updated BEFORE UPDATE ON app.casing_estimate_by_size
FOR EACH ROW EXECUTE FUNCTION app.stamp_updated();

-- app.tyre_price_list already carries created_by with its FK (000012); only
-- created_at was missing.
ALTER TABLE app.tyre_price_list
  ADD COLUMN created_at timestamptz,
  ALTER COLUMN created_at SET DEFAULT now(),
  ADD COLUMN updated_at timestamptz,
  ADD COLUMN updated_by uuid;
CREATE TRIGGER tyre_price_list_stamps_updated BEFORE UPDATE ON app.tyre_price_list
FOR EACH ROW EXECUTE FUNCTION app.stamp_updated();

-- app.target_pressure already carries created_by with its FK (000012); only
-- created_at was missing.
ALTER TABLE app.target_pressure
  ADD COLUMN created_at timestamptz,
  ALTER COLUMN created_at SET DEFAULT now(),
  ADD COLUMN updated_at timestamptz,
  ADD COLUMN updated_by uuid;
CREATE TRIGGER target_pressure_stamps_updated BEFORE UPDATE ON app.target_pressure
FOR EACH ROW EXECUTE FUNCTION app.stamp_updated();

-- app.inspection_schedule already carries both created_at and created_by,
-- with its FK (000012). Nothing to add there; it still gets the update stamp.
ALTER TABLE app.inspection_schedule
  ADD COLUMN updated_at timestamptz,
  ADD COLUMN updated_by uuid;
CREATE TRIGGER inspection_schedule_stamps_updated BEFORE UPDATE ON app.inspection_schedule
FOR EACH ROW EXECUTE FUNCTION app.stamp_updated();

-- app.inspection_task already carries created_at (000012); created_by was
-- missing. requested_by/assigned_user_id are distinct roles (who asked for
-- the inspection, who must perform it) and neither substitutes for who
-- created the task ROW itself.
ALTER TABLE app.inspection_task
  ADD COLUMN created_by uuid,
  ALTER COLUMN created_by SET DEFAULT app.current_actor_id(),
  ADD CONSTRAINT inspection_task_created_by_fkey FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id),
  ADD COLUMN updated_at timestamptz,
  ADD COLUMN updated_by uuid;
CREATE TRIGGER inspection_task_stamps_updated BEFORE UPDATE ON app.inspection_task
FOR EACH ROW EXECUTE FUNCTION app.stamp_updated();

-- app.tenant_consent is append-only (000012 REVOKE UPDATE, DELETE) and
-- already carries its own event attribution (occurred_at / actor_id, with
-- actor_id's own FK from 000012). Same literal-name reasoning as
-- casing_valuation above. No trigger — no UPDATE grant to stamp.
ALTER TABLE app.tenant_consent
  ADD COLUMN created_at timestamptz,
  ALTER COLUMN created_at SET DEFAULT now(),
  ADD COLUMN created_by uuid,
  ALTER COLUMN created_by SET DEFAULT app.current_actor_id(),
  ADD CONSTRAINT tenant_consent_created_by_fkey FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id);
