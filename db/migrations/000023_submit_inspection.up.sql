-- ============================================================================
--  submit_inspection — the platform's only write path for captured readings
--  Implements: FR-INS-020..041, FR-INS-060..065, FR-OFF-011, FR-OFF-016,
--              BR-INS-003, BR-VEH-003, DR-015..021, FR-VEH-016
-- ============================================================================

-- Invoker rights, deliberately: the suite allows exactly one SECURITY DEFINER
-- routine in this schema and this is not it. Everything below is written by
-- the calling driver, under their own tenant's policies.
CREATE FUNCTION app.submit_inspection(p_payload jsonb)
RETURNS TABLE (inspection_id uuid, created boolean)
LANGUAGE plpgsql SET search_path = app, pg_temp AS $$
DECLARE
  v_tenant     uuid := app.current_tenant_id();
  v_actor      uuid := app.current_actor_id();
  v_cu         uuid := (p_payload ->> 'client_uuid')::uuid;
  v_vehicle    uuid := (p_payload ->> 'vehicle_id')::uuid;
  v_task       uuid := (p_payload ->> 'task_id')::uuid;
  -- D5 / FR-INS-063: the composition the driver was offered. Recorded
  -- against the observed set, never used to create a combination itself.
  v_combination uuid := (p_payload ->> 'combination_id')::uuid;
  v_insp       uuid;
  v_found      uuid;
  v_reading    uuid;
  v_hours      int;
  v_want       int;
  v_side       app.side;
  v_spare      boolean;
  v_fitted     uuid;
  v_odo        bigint;
  v_ord        int;
  v_n          int;
  v_gran       numeric;
  v_rg         numeric;
  v_press      int;
  v_constraint text;
  r            jsonb;
  w            jsonb;
  t            jsonb;
BEGIN
  IF v_tenant IS NULL OR v_actor IS NULL THEN
    RAISE EXCEPTION 'submit_inspection called with no tenant or actor bound'
      USING ERRCODE = 'TY010';
  END IF;

  -- Preconditions, refused by name before anything reads them. Each of the
  -- three is a body that can only ever fail, and ADR-0009's outbox retries a
  -- 5xx to a 30-minute ceiling and never gives up — so a shape that reached
  -- its column's own not-null violation instead would be retried forever
  -- (FR-OFF-013 needs a permanent refusal it can surface to the driver).
  -- Both keys are also load-bearing for the guards immediately below: the
  -- FR-OFF-011 replay lookup keys on client_uuid and the FR-INS-038 window
  -- compares against submitted_at, so an absent key does not fail there, it
  -- silently stands the guard down.
  IF v_cu IS NULL THEN
    RAISE EXCEPTION 'the payload carries no client_uuid' USING ERRCODE = 'TY005';
  END IF;
  IF (p_payload ->> 'submitted_at') IS NULL THEN
    RAISE EXCEPTION 'the payload carries no submitted_at' USING ERRCODE = 'TY005';
  END IF;

  -- FR-INS-020: an inspection is its readings. jsonb_array_elements over an
  -- absent key yields the empty set rather than an error, so without this an
  -- empty submit lands a SYNCED inspection at the default 100% completeness
  -- (see completeness_pct below) recording nothing, closes the driver's task,
  -- and never arms FR-INS-038 — whose window keys on readings[].vehicle_id,
  -- not on the header. jsonb_typeof screens the missing key, the JSON null
  -- and the non-array in one: only the last two would otherwise reach
  -- jsonb_array_elements, and they reach it as "cannot extract elements from
  -- a scalar" rather than as anything a client could act on.
  IF jsonb_typeof(p_payload -> 'readings') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'the payload carries no readings array' USING ERRCODE = 'TY005';
  END IF;
  IF jsonb_array_length(p_payload -> 'readings') = 0 THEN
    RAISE EXCEPTION 'the payload carries an empty readings array' USING ERRCODE = 'TY005';
  END IF;

  -- FR-OFF-011. A lookup, never an upsert: readings are append-only, so a
  -- replay that "corrected" the first submit would be an edit by another name.
  SELECT i.id INTO v_found FROM app.inspection i
   WHERE i.tenant_id = v_tenant AND i.client_uuid = v_cu;
  IF FOUND THEN
    inspection_id := v_found; created := false; RETURN NEXT; RETURN;
  END IF;

  -- FR-INS-038, per UNIT rather than per rig, so a superlink's member units
  -- are each protected. Reached only past the replay check above: resubmitting
  -- one capture is not a second inspection and must never trip this.
  -- FR-INS-038 states the default in the requirement itself — "a
  -- configurable minimum interval, defaulting to four hours" — so a tenant
  -- with no configured row still gets the window. Failing open here would
  -- stand a Must down silently, which is not the same trade DR-020's
  -- configurable ceiling makes (migration 000021: there, no configured
  -- policy means no claim to test).
  v_hours := COALESCE(
    (app.config_for(v_tenant, 'duplicate_inspection_min_hours', now()) #>> '{}')::int, 4);
  -- The window compares capture-clock against capture-clock, not
  -- capture-clock against the server's now(). ADR-0009's outbox means a
  -- capture can queue offline for hours before it syncs: a driver who
  -- genuinely double-captures unit X at 08:00 and 09:00, both draining from
  -- the outbox at 18:00, must still be caught at submit time regardless of
  -- when the sync happened to land. Anchoring on real now() would silently
  -- stand the window down for every queued submit — exactly the case
  -- FR-INS-038 exists to catch — because the device-claimed submitted_at
  -- drifts further from the server clock the longer the outbox held it. The
  -- rest of this function already trusts the device's own clock for
  -- everything else it stores (duration_seconds, the odometer's reading_date,
  -- NFR-OBS-007's capture_seconds), so trusting it here too is consistent,
  -- not a new risk. This is deliberately not bounded against real now() to
  -- guard a lying device clock — no requirement asks for that.
  IF EXISTS (
    SELECT 1 FROM app.reading rd
      JOIN app.inspection i ON i.id = rd.inspection_id
     WHERE rd.tenant_id = v_tenant
       AND i.state <> 'VOIDED'
       AND i.submitted_at > (p_payload ->> 'submitted_at')::timestamptz - make_interval(hours => v_hours)
       AND rd.vehicle_id IN (
             SELECT DISTINCT (e ->> 'vehicle_id')::uuid
               FROM jsonb_array_elements(p_payload -> 'readings') e))
  THEN
    RAISE EXCEPTION 'a unit in this submit was already inspected within % hours', v_hours
      USING ERRCODE = 'TY003';
  END IF;

  -- TY007 exists because the alternative is a 500. Without it an unknown or
  -- cross-tenant vehicle_id reaches the composite FK
  -- inspection_vehicle_id_fkey (tenant_id, vehicle_id) and arrives as
  -- SQLSTATE 23503, which is not in submitStatus and therefore surfaces as a
  -- server fault — telling the outbox to retry forever something that will
  -- never succeed.
  --
  -- RLS-scoped, so this answers "visible to this tenant" and not "exists".
  -- FR-AUT-005's own-units narrowing is the HTTP handler's, because the Scope
  -- table lives in auth and role names do not belong in SQL.
  PERFORM 1 FROM app.vehicle WHERE id = v_vehicle;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'vehicle not visible' USING ERRCODE = 'TY007';
  END IF;

  -- FR-OFF-011 under concurrency. Two drains of the same outbox entry can
  -- both pass the lookup above before either commits; the loser then blocks
  -- on inspection_tenant_id_client_uuid_key and surfaces as a 23505. That is
  -- still a replay, not a conflict, so it must answer the replay contract —
  -- reporting it as an error would have the outbox raise FR-OFF-013 over an
  -- inspection that is already safely stored. The re-read is correct because
  -- the transaction is READ COMMITTED: this statement takes a fresh snapshot
  -- and therefore sees the winner's now-committed row.
  BEGIN
    INSERT INTO app.inspection (
      tenant_id, vehicle_id, combination_id, user_id, client_uuid,
      started_at, submitted_at, odometer, duration_seconds,
      comment, defect_report, device_id, app_version, completeness_pct, state)
    VALUES (
      v_tenant, v_vehicle, v_combination, v_actor, v_cu,
      (p_payload ->> 'started_at')::timestamptz, (p_payload ->> 'submitted_at')::timestamptz,
      (p_payload ->> 'odometer_km')::bigint, (p_payload ->> 'duration_seconds')::int,
      p_payload ->> 'comment', p_payload ->> 'defect_report',
      p_payload ->> 'device_id', p_payload ->> 'app_version',
      COALESCE((p_payload ->> 'completeness_pct')::numeric, 100), 'SYNCED')
    RETURNING id INTO v_insp;
  EXCEPTION WHEN unique_violation THEN
    -- Narrowed to the one index that means "already submitted". Any other
    -- unique violation is a different fault and must not be dressed up as a
    -- successful replay.
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint IS DISTINCT FROM 'inspection_tenant_id_client_uuid_key' THEN
      RAISE;
    END IF;
    SELECT i.id INTO v_found FROM app.inspection i
     WHERE i.tenant_id = v_tenant AND i.client_uuid = v_cu;
    IF NOT FOUND THEN
      RAISE;
    END IF;
    inspection_id := v_found; created := false; RETURN NEXT; RETURN;
  END;

  -- FR-INS-063: the composition the driver confirmed, against the one they
  -- were offered. Recorded, never enforced and never used to create a
  -- combination: a queued submit can arrive days late, and writing fleet
  -- state from stale evidence would rewrite coupling history. The
  -- reconciliation surface is TYRE-55's.
  IF v_combination IS NOT NULL AND jsonb_array_length(
       COALESCE(p_payload -> 'observed_member_vehicle_ids', '[]'::jsonb)) > 0 THEN
    -- The members of THIS combination, narrowed before the join. Joining the
    -- whole table and filtering afterwards makes every other combination's
    -- rows look like unmatched members, so a tenant with two rigs would get a
    -- spurious FR-INS-063 warning on every submit — and the fixture, which
    -- has exactly one combination, could never reveal it.
    IF EXISTS (
      SELECT 1
        FROM (SELECT jsonb_array_elements_text(p_payload -> 'observed_member_vehicle_ids')::uuid AS id) obs
        FULL JOIN (SELECT vehicle_id FROM app.combination_member
                    WHERE combination_id = v_combination) cm
               ON cm.vehicle_id = obs.id
       WHERE obs.id IS NULL OR cm.vehicle_id IS NULL)
    THEN
      INSERT INTO app.inspection_warning (
        tenant_id, inspection_id, warning_code, entered_value, response, source)
      VALUES (v_tenant, v_insp, 'FR-INS-063',
              (p_payload ->> 'observed_member_vehicle_ids'), NULL, 'SERVER');
    END IF;
  END IF;

  -- Rule 5, read once for the whole submit: both the width of a capture and
  -- the gauge precision it claims are tenant configuration, never a literal.
  v_want := (app.config_for(v_tenant, 'tread_reading_count', now()) #>> '{}')::int;
  v_gran := (app.config_for(v_tenant, 'tread_capture_granularity_mm', now()) #>> '{}')::numeric;

  -- CR-011's screen-order-to-anatomy map below is total only for 1 or 3
  -- readings, and neither app.configuration nor anything above constrains the
  -- key. 4 subscripts past the end of the width array and lands a NOT NULL
  -- violation on position, so every submit that tenant makes fails with no
  -- client bug involved; 2 raises nothing at all and records the far edge of
  -- the tread as the CENTRE — permanently, because DR-014a revokes UPDATE, so
  -- it is compensable but never correctable. Refusing the configuration is
  -- smaller and safer than inventing a width convention the SRS has not
  -- settled. The IS NULL half is load-bearing: NULL NOT IN (1,3) is NULL, not
  -- true, so a guard without it would still admit an unconfigured tenant and
  -- land readings carrying no tread at all, which is rule 4 inverted. No
  -- configured width means no capture — unlike the FR-INS-038 window above,
  -- whose default the requirement itself states, nothing states this one.
  IF v_want IS NULL OR v_want NOT IN (1, 3) THEN
    RAISE EXCEPTION 'the tenant configures tread_reading_count = %, which is neither 1 nor 3',
      COALESCE(v_want::text, 'nothing') USING ERRCODE = 'TY005';
  END IF;

  FOR r IN SELECT * FROM jsonb_array_elements(p_payload -> 'readings') LOOP
    IF r ? 'governing_tread_mm' THEN
      -- CR-011/DR-017: the MIN is derived. Refusing rather than ignoring the
      -- field is what stops a client believing it was honoured.
      RAISE EXCEPTION 'governing_tread_mm is derived and must not be submitted'
        USING ERRCODE = 'TY006';
    END IF;

    -- FR-VEH-016 versions configurations so amending one does not alter the
    -- position meaning of historical inspections. A completed capture can wait
    -- days in the outbox, so validate against the whole lineage: refusing it
    -- because an admin revised the configuration meanwhile would throw away a
    -- finished walk-around, which is the adoption wound ADR-0009 exists to
    -- prevent.
    SELECT p.side, p.is_spare INTO v_side, v_spare
      FROM app.position p
      JOIN app.axle_configuration ac ON ac.id = p.configuration_id
     WHERE p.id = (r ->> 'position_id')::uuid
       AND p.tenant_id = v_tenant
       AND (ac.tenant_id, ac.code) = (
             SELECT a2.tenant_id, a2.code
               FROM app.vehicle v JOIN app.axle_configuration a2 ON a2.id = v.configuration_id
              WHERE v.id = (r ->> 'vehicle_id')::uuid AND v.tenant_id = v_tenant);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'position % is not on any version of vehicle %''s configuration',
        r ->> 'position_id', r ->> 'vehicle_id' USING ERRCODE = 'TY004';
    END IF;

    -- jsonb_array_length(NULL) is NULL, not an error, so an absent treads key
    -- or an explicit JSON null would otherwise slide past "v_n <> v_want"
    -- (NULL <> 3 is NULL, not true) and land a reading with zero measurements
    -- and a NULL governing_tread_mm. jsonb_typeof catches both: it returns
    -- NULL for a missing key and 'null' for a JSON null, neither of which is
    -- 'array'.
    IF jsonb_typeof(r -> 'treads') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'position % is missing its tread readings', r ->> 'position_id'
        USING ERRCODE = 'TY005';
    END IF;

    SELECT jsonb_array_length(r -> 'treads') INTO v_n;
    IF v_n <> v_want THEN
      RAISE EXCEPTION 'position % carried % tread readings, the tenant configures %',
        r ->> 'position_id', v_n, v_want USING ERRCODE = 'TY005';
    END IF;
    -- Belt to the configuration guard's braces. The width map subscripts its
    -- array with v_ord, so a count of zero would make CR-011's "ordered set
    -- of width-wise readings" an empty one and leave governing_tread_mm null.
    IF v_n < 1 THEN
      RAISE EXCEPTION 'position % carried no tread readings', r ->> 'position_id'
        USING ERRCODE = 'TY005';
    END IF;

    -- FR-INS-031's hard range. reading_pressure_kpa_check (000001) stays the
    -- authority for the numbers; echoing it here is what turns a generic
    -- 23514 into a refusal naming the position, which is what FR-OFF-013
    -- gives the driver to act on. NULL stays legal on purpose: an unclassified
    -- spare pressure is recorded as absent, never as a zero (BR-RPT-001,
    -- NFR-PRO-003).
    v_press := (r ->> 'pressure_kpa')::int;
    IF v_press IS NOT NULL AND (v_press < 0 OR v_press > 1200) THEN
      RAISE EXCEPTION 'position %''s pressure of % kPa is outside the accepted range',
        r ->> 'position_id', v_press USING ERRCODE = 'TY005';
    END IF;

    -- ADR-0010 provenance: granularity_mm is a claim about the gauge that
    -- produced the reading, on an append-only table, so a wrong one is
    -- permanent and silently degrades every later analysis that trusts it.
    -- The payload's value if it sent one, else the tenant's configured
    -- capture granularity — a literal fallback here would stamp 1.0 mm
    -- precision on a tenant capturing at 0.1 the moment a client omitted the
    -- field, which is easy to omit because it is session reference data
    -- rather than per-reading input. reading_measurement_granularity_mm_check
    -- (000011) is the authority for the accepted set; refusing here names the
    -- value and also catches a tenant whose configured granularity is not in
    -- it, which is otherwise the same unmapped-500 hole as the width count.
    v_rg := COALESCE((r ->> 'granularity_mm')::numeric, v_gran);
    IF v_rg IS NULL OR v_rg NOT IN (1.0, 0.5, 0.1) THEN
      RAISE EXCEPTION 'position % claims a gauge granularity of %, which is not 1.0, 0.5 or 0.1',
        r ->> 'position_id', COALESCE(v_rg::text, 'nothing') USING ERRCODE = 'TY005';
    END IF;

    INSERT INTO app.reading (
      tenant_id, inspection_id, vehicle_id, position_id, tyre_id,
      pressure_kpa, pressure_temperature, damage_flag, damage_type,
      wear_pattern, note, source, capture_seconds)
    VALUES (
      v_tenant, v_insp, (r ->> 'vehicle_id')::uuid, (r ->> 'position_id')::uuid,
      (r ->> 'tyre_id')::uuid, (r ->> 'pressure_kpa')::int,
      COALESCE((r ->> 'pressure_temperature')::app.temperature_state, 'UNKNOWN'),
      COALESCE((r ->> 'damage_flag')::boolean, false),
      r ->> 'damage_type', r ->> 'wear_pattern', r ->> 'note', 'MANUAL',
      -- NFR-OBS-007. Nullable, so an absent value is absent rather than a
      -- zero that would drag the median down (NFR-PRO-002).
      (r ->> 'seconds')::int)
    RETURNING id INTO v_reading;

    -- FR-OFF-016: fitment can move between capture and submit. The driver's
    -- eyes are the record of what was on the vehicle, so accept and flag —
    -- rejecting the inspection is the one response the requirement forbids.
    IF (r ->> 'tyre_id') IS NOT NULL THEN
      SELECT f.tyre_id INTO v_fitted FROM app.fitment f
       WHERE f.tenant_id = v_tenant
         AND f.vehicle_id = (r ->> 'vehicle_id')::uuid
         AND f.position_id = (r ->> 'position_id')::uuid
         AND f.removed_at IS NULL
       LIMIT 1;
      IF FOUND AND v_fitted IS DISTINCT FROM (r ->> 'tyre_id')::uuid THEN
        INSERT INTO app.inspection_warning (
          tenant_id, inspection_id, reading_id, warning_code, entered_value, response, source)
        VALUES (v_tenant, v_insp, v_reading, 'FR-OFF-016', (r ->> 'tyre_id'), NULL, 'SERVER');
      END IF;
    END IF;

    -- FR-INS-029a. The driver enters left to right in the plan view — the
    -- frame BR-VEH-001 numbers positions in — and never sees these words;
    -- OUTER is away from the centreline (CHG-010), so the order reverses
    -- between sides. A spare has no vehicle-relative geometry,
    -- so its orientation is recorded as unknown rather than invented — such
    -- rows still count toward MIN but are excluded from directional diagnosis.
    v_ord := 0;
    FOR t IN SELECT * FROM jsonb_array_elements(r -> 'treads') LOOP
      v_ord := v_ord + 1;
      -- FR-INS-030's hard range, plus the null element the count check cannot
      -- see: jsonb_array_length counts a JSON null as an entry, so
      -- [7.0, null, 7.0] is three readings by that measure and reaches
      -- tread_mm NOT NULL instead. reading_measurement_tread_mm_check (000011)
      -- stays the authority for the numbers, as for pressure above.
      IF jsonb_typeof(t) <> 'number' THEN
        RAISE EXCEPTION 'position %, tread reading %, is not a number',
          r ->> 'position_id', v_ord USING ERRCODE = 'TY005';
      END IF;
      IF (t #>> '{}')::numeric < 0 OR (t #>> '{}')::numeric > 35 THEN
        RAISE EXCEPTION 'position %, tread reading % of % mm, is outside the accepted range',
          r ->> 'position_id', v_ord, (t #>> '{}')::numeric USING ERRCODE = 'TY005';
      END IF;
      INSERT INTO app.reading_measurement (
        tenant_id, reading_id, ordinal, tread_mm, position, orientation_known, granularity_mm)
      VALUES (
        v_tenant, v_reading, v_ord, (t #>> '{}')::numeric,
        CASE
          WHEN v_n = 1 THEN 'CENTRE'::app.tread_position
          WHEN v_side = 'RIGHT' THEN (ARRAY['INNER','CENTRE','OUTER']::app.tread_position[])[v_ord]
          ELSE (ARRAY['OUTER','CENTRE','INNER']::app.tread_position[])[v_ord]
        END,
        NOT v_spare,
        v_rg);
    END LOOP;

    FOR w IN SELECT * FROM jsonb_array_elements(COALESCE(r -> 'warnings', '[]'::jsonb)) LOOP
      INSERT INTO app.inspection_warning (
        tenant_id, inspection_id, reading_id, warning_code, entered_value, response, source)
      VALUES (v_tenant, v_insp, v_reading, w ->> 'code', w ->> 'entered_value',
              w ->> 'response', 'CLIENT');
    END LOOP;
  END LOOP;

  -- DR-016's contiguity guard is DEFERRABLE INITIALLY DEFERRED, so left alone
  -- it fires at COMMIT — after the handler has returned, where the API can
  -- only call it a 500. Forcing it here makes a malformed position a refusal
  -- the client can act on.
  SET CONSTRAINTS ALL IMMEDIATE;

  FOR w IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload -> 'warnings', '[]'::jsonb)) LOOP
    INSERT INTO app.inspection_warning (
      tenant_id, inspection_id, warning_code, entered_value, response, source)
    VALUES (v_tenant, v_insp, w ->> 'code', w ->> 'entered_value', w ->> 'response', 'CLIENT');
  END LOOP;

  -- FR-INS-020: the odometer never blocks the inspection, and FR-INS-064 puts
  -- only the motive unit's reading on a timeline. DR-020 still refuses a value
  -- that would corrupt the vehicle's rates, and DR-018 makes that refusal the
  -- only safe answer — the timeline is append-only, so an accepted implausible
  -- reading is permanent. Containing it here is what lets both hold at once.
  --
  -- Only the timeline's own SQLSTATEs are trapped. A generic WHEN OTHERS would
  -- turn an FK violation or a serialisation failure into a quiet "warning".
  v_odo := (p_payload ->> 'odometer_km')::bigint;
  IF v_odo IS NOT NULL THEN
    BEGIN
      INSERT INTO app.vehicle_odometer_reading (
        tenant_id, vehicle_id, reading_date, odometer_km, source, inspection_id)
      VALUES (
        v_tenant, v_vehicle,
        ((p_payload ->> 'submitted_at')::timestamptz AT TIME ZONE 'UTC')::date,
        v_odo, 'INSPECTION', v_insp);
    EXCEPTION
      WHEN SQLSTATE 'TY001' OR SQLSTATE 'TY002' OR unique_violation THEN
        -- FR-OFF-014's standard: the number is not discarded. A controller who
        -- checks it against the fuel records can re-enter it (FR-IMP-015).
        INSERT INTO app.inspection_warning (
          tenant_id, inspection_id, warning_code, entered_value, response, source)
        VALUES (v_tenant, v_insp, 'DR-020', v_odo::text, NULL, 'SERVER');
    END;
  END IF;

  -- FR-INS-052: a completed task cites the inspection that completed it. The
  -- driver launched from a specific task (FR-INS-048 shows them) and a unit can
  -- carry several at once (FR-INS-051), so the payload names which. Absent one,
  -- close nothing rather than guess at the driver's intent.
  --
  -- vehicle_id is what stops the citation being a lie. Without it a task_id
  -- naming unit C is closed by an inspection of unit B, and the row then
  -- asserts C was inspected when it was not: the schedule stands its next
  -- task down and C leaves the controller's outstanding-work view. A driver
  -- holding several open tasks plus one client-side index slip is enough, and
  -- GET /api/my/tasks hands the client every id needed to make it. A task the
  -- submit does not cover closes nothing, silently — the same trade made for
  -- an absent task_id above and for one belonging to another tenant.
  IF v_task IS NOT NULL THEN
    UPDATE app.inspection_task
       SET state = 'COMPLETED', completed_inspection_id = v_insp
     WHERE tenant_id = v_tenant AND id = v_task AND vehicle_id = v_vehicle
       AND state IN ('OPEN','ESCALATED');
  END IF;

  inspection_id := v_insp; created := true; RETURN NEXT;
END $$;

REVOKE ALL ON FUNCTION app.submit_inspection(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.submit_inspection(jsonb) TO app_rw;
