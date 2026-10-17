-- What a provisioned tenant holds, read on tyre_provision after
-- scripts/provision-tenant.test.sh has run the generator (TYRE-374). Runs as
-- postgres; the history and isolation blocks drop to app_login so RLS binds
-- them. Each block raises FAIL <n>.
--
-- Variables: generated (G, from generated.json), free (F, from free.json),
-- absent (comma-separated ids of runs that must have left nothing).
\set ON_ERROR_STOP on
\o /dev/null
SELECT set_config('provision.generated', :'generated', false),
       set_config('provision.free', :'free', false),
       set_config('provision.absent', :'absent', false),
       set_config('provision.keys', 'tread_reading_count,capture_spares,width_spread_warn_mm,dual_mate_warn_mm,axle_divergence_warn_mm,tread_bands,removal_reasons,reading_staleness_days,wear_rate_min_distance_km,odometer_max_daily_km,duplicate_inspection_min_hours,submitted_at_future_skew_minutes,wear_rate_alert_multiple,forecast_horizon_days,inflation_compliance_window_days,tread_capture_granularity_mm', false);
\o

-- 1. Both tenants in PROVISIONING, as their files describe them. The name
-- carries an apostrophe, so it proves the generator's quoting round-trips.
DO $$
DECLARE
  g uuid := current_setting('provision.generated')::uuid;
  f uuid := current_setting('provision.free')::uuid;
  r record;
BEGIN
  SELECT * INTO r FROM app.tenant WHERE id = g;
  IF NOT FOUND THEN RAISE EXCEPTION 'FAIL 1: no tenant %', g; END IF;
  IF (r.state::text, r.name, r.display_code_policy::text, r.timezone, r.created_by)
     IS DISTINCT FROM ('PROVISIONING', 'Harbour''s Test Fleet', 'GENERATED', 'Pacific/Kiritimati', NULL::uuid) THEN
    RAISE EXCEPTION 'FAIL 1: generated tenant is %', row_to_json(r);
  END IF;
  SELECT * INTO r FROM app.tenant WHERE id = f;
  IF NOT FOUND THEN RAISE EXCEPTION 'FAIL 1: no tenant %', f; END IF;
  IF (r.state::text, r.display_code_policy::text, r.timezone, r.pressure_unit, r.distance_unit, r.created_by)
     IS DISTINCT FROM ('PROVISIONING', 'FREE', 'Pacific/Pago_Pago', 'PSI', 'MI', NULL::uuid) THEN
    RAISE EXCEPTION 'FAIL 1: free tenant is %', row_to_json(r);
  END IF;
END $$;

-- 2. History-ready: every baseline is in force years before either tenant
-- existed, resolved by the readers themselves under RLS. Before the literal
-- checks, so a row dated anything but -infinity fails here first.
BEGIN;
SET LOCAL ROLE app_login;
DO $$
DECLARE
  g uuid := current_setting('provision.generated')::uuid;
  f uuid := current_setting('provision.free')::uuid;
  keys text[] := string_to_array(current_setting('provision.keys'), ',');
  at timestamptz := '2015-01-01T00:00:00Z';
  t uuid;
  k text;
  tp app.threshold_policy;
  pr app.target_pressure;
BEGIN
  FOREACH t IN ARRAY ARRAY[g, f] LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    FOREACH k IN ARRAY keys LOOP
      IF app.config_for(t, k, at) IS NULL THEN
        RAISE EXCEPTION 'FAIL 2: tenant % has no % in force at %', t, k, at;
      END IF;
    END LOOP;
  END LOOP;

  PERFORM set_config('app.tenant_id', g::text, true);
  tp := app.threshold_policy_for(g, NULL, NULL, at);
  IF (tp.retread_threshold_mm, tp.warning_threshold_mm) IS DISTINCT FROM (5.0, 7.0) THEN
    RAISE EXCEPTION 'FAIL 2: generated fleet-wide policy at % is %/%', at, tp.retread_threshold_mm, tp.warning_threshold_mm;
  END IF;
  tp := app.threshold_policy_in_force_at(g, NULL, NULL, at);
  IF (tp.retread_threshold_mm, tp.warning_threshold_mm) IS DISTINCT FROM (5.0, 7.0) THEN
    RAISE EXCEPTION 'FAIL 2: generated policy in force at % is %/%', at, tp.retread_threshold_mm, tp.warning_threshold_mm;
  END IF;
  -- The STEER row starts from the fleet-wide figures (Decision 4), so a
  -- changed fleet-wide threshold reaches steer positions.
  tp := app.threshold_policy_for(g, NULL, 'STEER', at);
  IF (tp.retread_threshold_mm, tp.warning_threshold_mm, tp.retreads_permitted) IS DISTINCT FROM (5.0, 7.0, false) THEN
    RAISE EXCEPTION 'FAIL 2: generated STEER policy is %/% permitted %', tp.retread_threshold_mm, tp.warning_threshold_mm, tp.retreads_permitted;
  END IF;
  tp := app.threshold_policy_for(g, NULL, 'DRIVE', at);
  IF (tp.retread_threshold_mm, tp.warning_threshold_mm, tp.max_retreads) IS DISTINCT FROM (5.0, 7.0, 1) THEN
    RAISE EXCEPTION 'FAIL 2: generated DRIVE policy is %/% cap %', tp.retread_threshold_mm, tp.warning_threshold_mm, tp.max_retreads;
  END IF;
  pr := app.target_pressure_for(g, NULL, 'STEER', at);
  IF pr.target_kpa IS DISTINCT FROM 820 THEN
    RAISE EXCEPTION 'FAIL 2: generated STEER target at % is %', at, pr.target_kpa;
  END IF;
  pr := app.target_pressure_for(g, NULL, 'DRIVE', at);
  IF pr.target_kpa IS DISTINCT FROM 750 THEN
    RAISE EXCEPTION 'FAIL 2: generated DRIVE target at % is %', at, pr.target_kpa;
  END IF;

  PERFORM set_config('app.tenant_id', f::text, true);
  tp := app.threshold_policy_for(f, NULL, NULL, at);
  IF (tp.retread_threshold_mm, tp.warning_threshold_mm) IS DISTINCT FROM (4.0, 6.0) THEN
    RAISE EXCEPTION 'FAIL 2: free fleet-wide policy at % is %/%', at, tp.retread_threshold_mm, tp.warning_threshold_mm;
  END IF;
  pr := app.target_pressure_for(f, NULL, 'STEER', at);
  IF pr.target_kpa IS DISTINCT FROM 800 THEN
    RAISE EXCEPTION 'FAIL 2: free STEER target at % is %', at, pr.target_kpa;
  END IF;
END $$;
ROLLBACK;

-- 3. Configuration: exactly the platform's keys, each a -infinity baseline;
-- the generated file's two overrides, and every other value the fixture's.
DO $$
DECLARE
  g uuid := current_setting('provision.generated')::uuid;
  f uuid := current_setting('provision.free')::uuid;
  bac uuid := '11111111-1111-1111-1111-111111111111';
  keys text[] := string_to_array(current_setting('provision.keys'), ',');
  t uuid;
  bad text;
BEGIN
  FOREACH t IN ARRAY ARRAY[g, f] LOOP
    SELECT string_agg(d.k, ', ') INTO bad
      FROM ((SELECT key FROM app.configuration WHERE tenant_id = t EXCEPT SELECT unnest(keys))
            UNION ALL
            (SELECT unnest(keys) EXCEPT SELECT key FROM app.configuration WHERE tenant_id = t)) d(k);
    IF bad IS NOT NULL THEN
      RAISE EXCEPTION 'FAIL 3: tenant % configuration keys differ on %', t, bad;
    END IF;
    IF (SELECT count(*) FROM app.configuration WHERE tenant_id = t) <> cardinality(keys) THEN
      RAISE EXCEPTION 'FAIL 3: tenant % holds a key twice', t;
    END IF;
    IF EXISTS (SELECT 1 FROM app.configuration WHERE tenant_id = t AND effective_from <> '-infinity') THEN
      RAISE EXCEPTION 'FAIL 3: tenant % has a configuration row not dated -infinity', t;
    END IF;
  END LOOP;

  IF (SELECT value FROM app.configuration WHERE tenant_id = g AND key = 'reading_staleness_days') IS DISTINCT FROM '21'::jsonb
     OR (SELECT value FROM app.configuration WHERE tenant_id = g AND key = 'capture_spares') IS DISTINCT FROM 'false'::jsonb THEN
    RAISE EXCEPTION 'FAIL 3: the generated file''s configuration overrides did not land';
  END IF;
  SELECT string_agg(d.key, ', ') INTO bad
    FROM ((SELECT key, value FROM app.configuration
            WHERE tenant_id = g AND key <> ALL (ARRAY['reading_staleness_days', 'capture_spares'])
           EXCEPT
           SELECT key, value FROM app.configuration
            WHERE tenant_id = bac AND key = ANY (keys) AND key <> ALL (ARRAY['reading_staleness_days', 'capture_spares']))
          UNION ALL
          (SELECT key, value FROM app.configuration WHERE tenant_id = f
           EXCEPT
           SELECT key, value FROM app.configuration WHERE tenant_id = bac AND key = ANY (keys))) d;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 3: values differ from the fixture''s defaults on %', bad;
  END IF;
END $$;

-- 4. The unit-type library and the exception rule catalogue match the
-- fixture tenants', from the one module both read.
DO $$
DECLARE
  g uuid := current_setting('provision.generated')::uuid;
  f uuid := current_setting('provision.free')::uuid;
  bac uuid := '11111111-1111-1111-1111-111111111111';
  t uuid;
BEGIN
  FOREACH t IN ARRAY ARRAY[g, f] LOOP
    IF EXISTS ((SELECT code, name, axle_count, evidential_status, default_spare_count FROM app.axle_configuration WHERE tenant_id = t
                EXCEPT SELECT code, name, axle_count, evidential_status, default_spare_count FROM app.axle_configuration WHERE tenant_id = bac)
               UNION ALL
               (SELECT code, name, axle_count, evidential_status, default_spare_count FROM app.axle_configuration WHERE tenant_id = bac
                EXCEPT SELECT code, name, axle_count, evidential_status, default_spare_count FROM app.axle_configuration WHERE tenant_id = t))
       OR NOT EXISTS (SELECT 1 FROM app.axle_configuration WHERE tenant_id = t) THEN
      RAISE EXCEPTION 'FAIL 4: tenant % axle configurations differ from the fixture''s', t;
    END IF;
    IF EXISTS ((SELECT c.code, p.code, p.sequence, p.axle_number, p.axle_class, p.side, p.slot, p.is_spare, p.axle_type, p.spare_ordinal, p.unit_label
                  FROM app.position p JOIN app.axle_configuration c ON c.tenant_id = p.tenant_id AND c.id = p.configuration_id WHERE p.tenant_id = t
                EXCEPT
                SELECT c.code, p.code, p.sequence, p.axle_number, p.axle_class, p.side, p.slot, p.is_spare, p.axle_type, p.spare_ordinal, p.unit_label
                  FROM app.position p JOIN app.axle_configuration c ON c.tenant_id = p.tenant_id AND c.id = p.configuration_id WHERE p.tenant_id = bac)
               UNION ALL
               (SELECT c.code, p.code, p.sequence, p.axle_number, p.axle_class, p.side, p.slot, p.is_spare, p.axle_type, p.spare_ordinal, p.unit_label
                  FROM app.position p JOIN app.axle_configuration c ON c.tenant_id = p.tenant_id AND c.id = p.configuration_id WHERE p.tenant_id = bac
                EXCEPT
                SELECT c.code, p.code, p.sequence, p.axle_number, p.axle_class, p.side, p.slot, p.is_spare, p.axle_type, p.spare_ordinal, p.unit_label
                  FROM app.position p JOIN app.axle_configuration c ON c.tenant_id = p.tenant_id AND c.id = p.configuration_id WHERE p.tenant_id = t))
       OR NOT EXISTS (SELECT 1 FROM app.position WHERE tenant_id = t) THEN
      RAISE EXCEPTION 'FAIL 4: tenant % positions differ from the fixture''s', t;
    END IF;
    IF EXISTS ((SELECT code, name, enabled, severity FROM app.exception_rule WHERE tenant_id = t
                EXCEPT SELECT code, name, enabled, severity FROM app.exception_rule WHERE tenant_id = bac)
               UNION ALL
               (SELECT code, name, enabled, severity FROM app.exception_rule WHERE tenant_id = bac
                EXCEPT SELECT code, name, enabled, severity FROM app.exception_rule WHERE tenant_id = t))
       OR NOT EXISTS (SELECT 1 FROM app.exception_rule WHERE tenant_id = t) THEN
      RAISE EXCEPTION 'FAIL 4: tenant % exception rules differ from the fixture''s', t;
    END IF;
  END LOOP;
END $$;

-- 5. The platform catalogue, seeded whole into each tenant.
DO $$
DECLARE
  g uuid := current_setting('provision.generated')::uuid;
  f uuid := current_setting('provision.free')::uuid;
  t uuid;
  tbl text;
  want bigint;
  n bigint;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['tyre_size', 'tyre_brand', 'tyre_pattern'] LOOP
    EXECUTE format('SELECT count(*) FROM app.platform_%I', tbl) INTO want;
    IF want = 0 THEN
      RAISE EXCEPTION 'FAIL 5: app.platform_% is empty, so its seed proves nothing', tbl;
    END IF;
    FOREACH t IN ARRAY ARRAY[g, f] LOOP
      EXECUTE format('SELECT count(*) FROM app.%I WHERE tenant_id = $1 AND platform_catalogue_id IS NOT NULL', tbl)
        INTO n USING t;
      IF n <> want THEN
        RAISE EXCEPTION 'FAIL 5: tenant % holds % of % platform %', t, n, want, tbl;
      END IF;
    END LOOP;
  END LOOP;
END $$;

-- 6. A counter for the GENERATED tenant only.
DO $$
DECLARE
  g uuid := current_setting('provision.generated')::uuid;
  f uuid := current_setting('provision.free')::uuid;
BEGIN
  IF (SELECT array_agg((prefix, next_number)::text) FROM app.display_code_counter WHERE tenant_id = g)
     IS DISTINCT FROM ARRAY['(PTF,1)'] THEN
    RAISE EXCEPTION 'FAIL 6: the generated tenant''s counter is not one PTF row at 1';
  END IF;
  IF EXISTS (SELECT 1 FROM app.display_code_counter WHERE tenant_id = f) THEN
    RAISE EXCEPTION 'FAIL 6: the FREE tenant has a counter';
  END IF;
END $$;

-- 7. Depots as the file names them. The non-ASCII name is spelled by code
-- point, so the check holds whatever encoding this file is read in.
DO $$
DECLARE
  g uuid := current_setting('provision.generated')::uuid;
BEGIN
  IF EXISTS ((SELECT name, type::text, address FROM app.depot WHERE tenant_id = g
              EXCEPT
              VALUES ('Harbour''s main yard', 'DEPOT', '1 Test Road'),
                     ('Test Retreaders', 'RETREADER', NULL),
                     ('D' || chr(233) || 'p' || chr(244) || 't Sud', 'STORE', NULL))
             UNION ALL
             (VALUES ('Harbour''s main yard', 'DEPOT', '1 Test Road'),
                     ('Test Retreaders', 'RETREADER', NULL),
                     ('D' || chr(233) || 'p' || chr(244) || 't Sud', 'STORE', NULL)
              EXCEPT
              SELECT name, type::text, address FROM app.depot WHERE tenant_id = g)) THEN
    RAISE EXCEPTION 'FAIL 7: the generated tenant''s depots are not the file''s three';
  END IF;
END $$;

-- 8. Consent as the client file states it, written with no actor; none for
-- the platform-owned tenant (U138).
DO $$
DECLARE
  g uuid := current_setting('provision.generated')::uuid;
  f uuid := current_setting('provision.free')::uuid;
BEGIN
  IF EXISTS ((SELECT purpose_code, granted, notice_version FROM app.tenant_consent WHERE tenant_id = g
              EXCEPT
              VALUES ('SERVICE_DELIVERY', true, 'test-notice-1'), ('ANONYMISED_BENCHMARKING', false, 'test-notice-1'))
             UNION ALL
             (VALUES ('SERVICE_DELIVERY', true, 'test-notice-1'), ('ANONYMISED_BENCHMARKING', false, 'test-notice-1')
              EXCEPT
              SELECT purpose_code, granted, notice_version FROM app.tenant_consent WHERE tenant_id = g)) THEN
    RAISE EXCEPTION 'FAIL 8: the generated tenant''s consent is not the file''s two records';
  END IF;
  IF EXISTS (SELECT 1 FROM app.tenant_consent WHERE tenant_id = g AND (actor_id IS NOT NULL OR created_by IS NOT NULL)) THEN
    RAISE EXCEPTION 'FAIL 8: a consent row names an actor, and none is bound at provisioning';
  END IF;
  IF EXISTS (SELECT 1 FROM app.tenant_consent WHERE tenant_id = f) THEN
    RAISE EXCEPTION 'FAIL 8: the platform-owned tenant has a consent row';
  END IF;
END $$;

-- 9. A refused run leaves no row anywhere under its id.
DO $$
DECLARE
  t uuid;
  rel text;
  n bigint;
BEGIN
  FOREACH t IN ARRAY string_to_array(current_setting('provision.absent'), ',')::uuid[] LOOP
    IF EXISTS (SELECT 1 FROM app.tenant WHERE id = t) THEN
      RAISE EXCEPTION 'FAIL 9: refused run % left a tenant row', t;
    END IF;
    FOR rel IN
      SELECT c.relname FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
       WHERE ns.nspname = 'app' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
         AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
    LOOP
      EXECUTE format('SELECT count(*) FROM app.%I WHERE tenant_id = $1', rel) INTO n USING t;
      IF n <> 0 THEN
        RAISE EXCEPTION 'FAIL 9: refused run % left % rows in app.%', t, n, rel;
      END IF;
    END LOOP;
  END LOOP;
END $$;

-- 10. Isolation under app_login: bound to each tenant, every table the
-- suite's sweep enrols shows only that tenant's rows. Under RLS the absence
-- half holds by construction; what can fail is the positive control, and
-- with the fixture-count diff and section 9 it is the isolation evidence.
BEGIN;
SET LOCAL ROLE app_login;
DO $$
DECLARE
  g uuid := current_setting('provision.generated')::uuid;
  f uuid := current_setting('provision.free')::uuid;
  t uuid;
  rel text;
  n bigint;
BEGIN
  FOREACH t IN ARRAY ARRAY[g, f, '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
                           '33333333-3333-3333-3333-333333333333']::uuid[] LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    FOR rel IN
      SELECT c.relname FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
       WHERE ns.nspname = 'app' AND c.relkind IN ('r', 'p') AND c.relrowsecurity
         AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
    LOOP
      EXECUTE format('SELECT count(*) FROM app.%I WHERE tenant_id IS DISTINCT FROM $1', rel) INTO n USING t;
      IF n <> 0 THEN
        RAISE EXCEPTION 'FAIL 10: bound to %, app.% shows % rows of another tenant', t, rel, n;
      END IF;
    END LOOP;
    IF (SELECT array_agg(id) FROM app.tenant) IS DISTINCT FROM ARRAY[t] THEN
      RAISE EXCEPTION 'FAIL 10: bound to %, app.tenant shows %', t, (SELECT array_agg(id) FROM app.tenant);
    END IF;
  END LOOP;
  PERFORM set_config('app.tenant_id', g::text, true);
  SELECT count(*) INTO n FROM app.configuration;
  IF n <> 16 THEN
    RAISE EXCEPTION 'FAIL 10: bound to the generated tenant, app.configuration shows % rows, not 16', n;
  END IF;
END $$;
ROLLBACK;

\echo 'provisioned: all checks passed'
