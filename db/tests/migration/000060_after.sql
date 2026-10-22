-- What 000060's data step leaves of 000060_before.sql's tenant, read as
-- postgres at head (TYRE-326, scripts/provision-tenant.test.sh step 16). The
-- tenant is bound because user_could_capture reads it, and a check against an
-- unbound tenant would read empty and pass (lesson 2026-09-19).
DO $$
DECLARE
  mr    constant uuid := md5('mr')::uuid;
  today constant date := (now() AT TIME ZONE 'Africa/Johannesburg')::date;
  c1 constant uuid := md5('mr-c1')::uuid;
  got text; want text; n int; mig timestamptz; tow_end timestamptz;
  r5_end timestamptz; r6_end timestamptz;
BEGIN
  PERFORM set_config('app.tenant_id', mr::text, true);

  -- Open rows on the tenant's today become trips, newest from_date first,
  -- each skipped when its motive or driver already holds one; trailer rows,
  -- a future row and an ended one do not (spec, vehicle_driver becomes
  -- history). Nor do rows on a retired motive or for a deactivated driver,
  -- which app.start_trip would refuse, so neither can win a conflict: MR
  -- Driver Two's newer rows on MR-MD and MR-MI leave them on MR-M1, and MR
  -- Driver Gone's row leaves MR-M3 with nobody.
  SELECT string_agg(concat_ws('/', u.display_name, v.fleet_number, vd.label,
                              CASE WHEN t.started_at = (src.from_date::timestamp AT TIME ZONE 'Africa/Johannesburg')
                                   THEN 'local midnight' ELSE t.started_at::text END,
                              COALESCE(sb.display_name, 'no starter'),
                              CASE WHEN t.combination_id = md5('mr-rig')::uuid THEN 'the m1 rig'
                                   WHEN t.combination_id IS NULL THEN 'no rig' ELSE t.combination_id::text END,
                              CASE WHEN t.ended_at IS NULL THEN 'open' ELSE 'ended' END),
                    ' | ' ORDER BY v.fleet_number) INTO got
    FROM app.trip t
    JOIN app.app_user u ON u.id = t.user_id
    JOIN app.vehicle v ON v.id = t.vehicle_id
    LEFT JOIN app.app_user sb ON sb.id = t.started_by
    LEFT JOIN app.vehicle_driver src ON src.id = t.migrated_from_assignment_id
    LEFT JOIN (VALUES (md5('mr-vdA')::uuid, 'vdA'), (md5('mr-vdB')::uuid, 'vdB'), (md5('mr-vdC')::uuid, 'vdC'),
                      (md5('mr-vdD')::uuid, 'vdD'), (md5('mr-vdE')::uuid, 'vdE'), (md5('mr-vdF')::uuid, 'vdF'),
                      (md5('mr-vdG')::uuid, 'vdG'), (md5('mr-vdH')::uuid, 'vdH'), (md5('mr-vdI')::uuid, 'vdI'),
                      (md5('mr-vdJ')::uuid, 'vdJ'), (md5('mr-vdK')::uuid, 'vdK'), (md5('mr-vdL')::uuid, 'vdL'),
                      (md5('mr-vdM')::uuid, 'vdM'), (md5('mr-vdN')::uuid, 'vdN')) vd(id, label)
      ON vd.id = t.migrated_from_assignment_id
   WHERE t.tenant_id = mr;
  want := 'MR Driver Two/MR-M1/vdB/local midnight/MR Controller/the m1 rig/open'
          || ' | MR Driver One/MR-M2/vdC/local midnight/no starter/no rig/open'
          || ' | MR Driver Five/MR-M4/vdL/local midnight/no starter/no rig/open'
          || ' | MR Driver Six/MR-M5/vdM/local midnight/no starter/no rig/open'
          || ' | MR Driver Seven/MR-M6/vdN/local midnight/no starter/no rig/open';
  IF got IS DISTINCT FROM want THEN
    RAISE EXCEPTION 'FAIL 1: the migrated trips read [%], not [%]', got, want;
  END IF;
  -- The two trips start at their own row's day: vdB's ten days back, vdC's
  -- twenty.
  IF NOT EXISTS (SELECT 1 FROM app.trip WHERE migrated_from_assignment_id = md5('mr-vdB')::uuid
                    AND started_at = ((today - 10)::timestamp AT TIME ZONE 'Africa/Johannesburg'))
     OR NOT EXISTS (SELECT 1 FROM app.trip WHERE migrated_from_assignment_id = md5('mr-vdC')::uuid
                    AND started_at = ((today - 20)::timestamp AT TIME ZONE 'Africa/Johannesburg')) THEN
    RAISE EXCEPTION 'FAIL 2: a migrated trip does not start at the tenant-local midnight of its row''s from_date';
  END IF;

  SELECT count(*) INTO n FROM app.vehicle_driver WHERE tenant_id = mr;
  IF n <> 14 THEN RAISE EXCEPTION 'FAIL 3: % of the 14 assignment rows remain as history', n; END IF;

  -- Each outstanding task's assignee is a nomination at its creation by
  -- whoever asked for it, and no other task has one. k11's assignee is
  -- deactivated, which app.nominate_for_task would refuse, so it has none.
  -- k12's trailer rode in MR-M4's rig and was free at the migration, so it
  -- gains a row where that tow ended, and k15's, towed twice, one where each
  -- tow ended; the others' units were never covered or are covered now, and
  -- gain none. k13 and k14 were created a
  -- day ahead, so each copy is dated at the migration, never ahead of it;
  -- k14's trailer is covered now and k13's never was. Part D's UPDATE of the
  -- escalated k05 stamped its updated_at with the migration's now().
  mig := (SELECT updated_at FROM app.inspection_task WHERE id = md5('mr-k5')::uuid);
  tow_end := (SELECT effective_to FROM app.combination WHERE id = md5('mr-rig4')::uuid);
  r5_end := (SELECT effective_to FROM app.combination WHERE id = md5('mr-rig5')::uuid);
  r6_end := (SELECT effective_to FROM app.combination WHERE id = md5('mr-rig6')::uuid);
  IF EXISTS (SELECT 1 FROM app.inspection_task
              WHERE id IN (md5('mr-k13')::uuid, md5('mr-k14')::uuid) AND created_at <= mig) THEN
    RAISE EXCEPTION 'FAIL 4: k13 or k14 was not created after the migration, so their case proves nothing';
  END IF;
  SELECT string_agg(k.label || ':' || u.display_name || ':'
                    || CASE WHEN nm.nominated_at = t.created_at THEN 'at creation'
                            WHEN nm.nominated_at = mig THEN 'at the migration'
                            WHEN nm.nominated_at = tow_end THEN 'at rig4''s end'
                            WHEN nm.nominated_at = r5_end THEN 'at rig5''s end'
                            WHEN nm.nominated_at = r6_end THEN 'at rig6''s end'
                            ELSE nm.nominated_at::text END,
                    ',' ORDER BY k.label, nm.nominated_at) INTO got
    FROM app.inspection_task_nomination nm
    JOIN app.inspection_task t ON t.id = nm.task_id
    JOIN app.app_user u ON u.id = nm.user_id
    JOIN (VALUES (md5('mr-k1')::uuid, 'k01'), (md5('mr-k2')::uuid, 'k02'), (md5('mr-k3')::uuid, 'k03'),
                 (md5('mr-k4')::uuid, 'k04'), (md5('mr-k5')::uuid, 'k05'), (md5('mr-k6')::uuid, 'k06'),
                 (md5('mr-k7')::uuid, 'k07'), (md5('mr-k8')::uuid, 'k08'), (md5('mr-k9')::uuid, 'k09'),
                 (md5('mr-k10')::uuid, 'k10'), (md5('mr-k11')::uuid, 'k11'), (md5('mr-k12')::uuid, 'k12'),
                 (md5('mr-k13')::uuid, 'k13'), (md5('mr-k14')::uuid, 'k14'), (md5('mr-k15')::uuid, 'k15')) k(id, label)
      ON k.id = nm.task_id
   WHERE nm.tenant_id = mr AND nm.nominated_by = c1;
  want := 'k01:MR Driver Two:at creation,k02:MR Driver Four:at creation,'
          || 'k03:MR Driver Two:at creation,k04:MR Driver Three:at creation,'
          || 'k10:MR Driver Three:at creation,k12:MR Driver Five:at creation,'
          || 'k12:MR Driver Five:at rig4''s end,k13:MR Driver One:at the migration,'
          || 'k14:MR Driver One:at the migration,k15:MR Driver Three:at creation,'
          || 'k15:MR Driver Three:at rig5''s end,k15:MR Driver Three:at rig6''s end';
  IF got IS DISTINCT FROM want THEN
    RAISE EXCEPTION 'FAIL 4: the nominations read [%], not [%]', got, want;
  END IF;
  SELECT count(*) INTO n FROM app.inspection_task_nomination WHERE tenant_id = mr;
  IF n <> 12 THEN RAISE EXCEPTION 'FAIL 4: the tenant holds % nominations, not the 12 above', n; END IF;

  IF EXISTS (SELECT 1 FROM app.inspection_task WHERE tenant_id = mr AND state = 'ESCALATED') THEN
    RAISE EXCEPTION 'FAIL 5: a task is still ESCALATED';
  END IF;

  -- A closed task closed at its last write; an open one has no close.
  SELECT count(*) INTO n FROM app.inspection_task
   WHERE tenant_id = mr
     AND closed_at IS DISTINCT FROM (CASE WHEN id IN (md5('mr-k7')::uuid, md5('mr-k8')::uuid)
                                          THEN timestamptz '2026-09-02T08:00:00Z' END);
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 6: % tasks carry the wrong closed_at', n; END IF;

  -- Who holds each outstanding task now. k2 changed hands, because its
  -- assignee lost the conflict on m2 (spec); k10 changed hands, because it
  -- reached t1, a trailer that now sits in another driver's rig (spec); k6
  -- and k9 gained a driver, on a trailer and on a motive, because the trip
  -- now covers their units (FR-INS-053's chain reaches them); k11 lost its
  -- deactivated assignee. k12 and k15 stay with their assignees, though
  -- trips towed their trailers and let them go after the tasks were made.
  -- Every other answer is the old assignee or nobody.
  SELECT string_agg(k.label || ':' || COALESCE(u.display_name, 'nobody'), ',' ORDER BY k.label) INTO got
    FROM (VALUES (md5('mr-k1')::uuid, 'k01'), (md5('mr-k2')::uuid, 'k02'), (md5('mr-k3')::uuid, 'k03'),
                 (md5('mr-k4')::uuid, 'k04'), (md5('mr-k5')::uuid, 'k05'), (md5('mr-k6')::uuid, 'k06'),
                 (md5('mr-k9')::uuid, 'k09'), (md5('mr-k10')::uuid, 'k10'), (md5('mr-k11')::uuid, 'k11'),
                 (md5('mr-k12')::uuid, 'k12'), (md5('mr-k15')::uuid, 'k15')) k(id, label)
    LEFT JOIN app.app_user u ON u.id = app.task_driver_at(k.id, now());
  want := 'k01:MR Driver Two,k02:MR Driver One,k03:MR Driver Two,k04:MR Driver Three,'
          || 'k05:nobody,k06:MR Driver Two,k09:MR Driver Two,k10:MR Driver Two,k11:nobody,k12:MR Driver Five,'
          || 'k15:MR Driver Three';
  IF got IS DISTINCT FROM want THEN
    RAISE EXCEPTION 'FAIL 7: the responsible drivers read [%], not [%]', got, want;
  END IF;
  -- k12 over its life: its assignee from its creation 48 days back until
  -- MR-T3 joined MR-M4's rig, the trip through the rig from 45 to 40 days
  -- back, and its assignee again from the instant the tow ended. The two
  -- '[)' spans meet there, so the last microsecond of the tow is the trip's.
  SELECT string_agg(COALESCE((SELECT u.display_name || '/' || r.via
                                FROM app.task_responsibility_at(md5('mr-k12')::uuid, x.at) r
                                JOIN app.app_user u ON u.id = r.user_id), 'nobody'),
                    ',' ORDER BY x.at) INTO got
    FROM (VALUES (now() - interval '46 days'), (now() - interval '42 days'),
                 (tow_end - interval '1 microsecond'), (tow_end),
                 (now() - interval '20 days'), (now())) x(at);
  want := 'MR Driver Five/NOMINATION,MR Driver Five/TRIP,MR Driver Five/TRIP,'
          || 'MR Driver Five/NOMINATION,MR Driver Five/NOMINATION,MR Driver Five/NOMINATION';
  IF got IS DISTINCT FROM want THEN
    RAISE EXCEPTION 'FAIL 7: k12 at 46 and 42 days back, either side of the tow''s end, 20 days back and now is held by [%], not [%]',
      got, want;
  END IF;
  -- A capture the assignee queued between the tow and the migration passes.
  IF NOT app.user_could_capture(md5('mr-d5')::uuid, md5('mr-t3')::uuid,
                                now() - interval '20 days', now() - interval '20 days') THEN
    RAISE EXCEPTION 'FAIL 7: k12''s assignee cannot capture MR-T3 between the tow and the migration';
  END IF;
  -- k15 over its life: its assignee until MR-T4 joined MR-M5's rig, Six's
  -- trip through it, its assignee in the gap, Seven's trip through MR-M6's
  -- rig, and its assignee again from that tow's end. Its assignee's
  -- captures in the gap and after both tows pass.
  SELECT string_agg(COALESCE((SELECT u.display_name || '/' || r.via
                                FROM app.task_responsibility_at(md5('mr-k15')::uuid, x.at) r
                                JOIN app.app_user u ON u.id = r.user_id), 'nobody'),
                    ',' ORDER BY x.at) INTO got
    FROM (VALUES (now() - interval '46 days'), (now() - interval '44 days'), (r5_end),
                 (now() - interval '42 days'), (now() - interval '40 days'), (r6_end),
                 (now() - interval '20 days')) x(at);
  want := 'MR Driver Three/NOMINATION,MR Driver Six/TRIP,MR Driver Three/NOMINATION,'
          || 'MR Driver Three/NOMINATION,MR Driver Seven/TRIP,MR Driver Three/NOMINATION,'
          || 'MR Driver Three/NOMINATION';
  IF got IS DISTINCT FROM want THEN
    RAISE EXCEPTION 'FAIL 7: k15 at 46 and 44 days back, rig5''s end, 42 and 40 days back, rig6''s end and 20 days back is held by [%], not [%]',
      got, want;
  END IF;
  IF NOT app.user_could_capture(md5('mr-d3')::uuid, md5('mr-t4')::uuid,
                                now() - interval '42 days', now() - interval '42 days')
     OR NOT app.user_could_capture(md5('mr-d3')::uuid, md5('mr-t4')::uuid,
                                   now() - interval '20 days', now() - interval '20 days') THEN
    RAISE EXCEPTION 'FAIL 7: k15''s assignee cannot capture MR-T4 between the tows or after them';
  END IF;

  -- The conflict's loser cannot capture the unit: a queued capture of theirs
  -- is refused (spec). The winner can, which is the control.
  IF app.user_could_capture(md5('mr-d4')::uuid, md5('mr-m2')::uuid, now() - interval '1 hour', now()) THEN
    RAISE EXCEPTION 'FAIL 8: the conflict''s loser can still capture MR-M2';
  END IF;
  IF NOT app.user_could_capture(md5('mr-d1')::uuid, md5('mr-m2')::uuid, now() - interval '1 hour', now()) THEN
    RAISE EXCEPTION 'FAIL 8: the conflict''s winner cannot capture MR-M2, so the check above proves nothing';
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'app' AND table_name = 'inspection_task'
                AND column_name IN ('assigned_user_id', 'escalated_at')) THEN
    RAISE EXCEPTION 'FAIL 9: inspection_task still carries assigned_user_id or escalated_at';
  END IF;
  IF has_table_privilege('app_rw', 'app.vehicle_driver', 'INSERT')
     OR has_any_column_privilege('app_rw', 'app.vehicle_driver', 'UPDATE') THEN
    RAISE EXCEPTION 'FAIL 10: app_rw can still write app.vehicle_driver';
  END IF;
  RAISE NOTICE 'trip migration replay: all checks passed';
END $$;
