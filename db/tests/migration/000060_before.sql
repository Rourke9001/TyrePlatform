-- The shape a database holds before 000060, planted as postgres at version
-- 59, for 000060_after.sql to read once the migration has run (TYRE-326,
-- scripts/provision-tenant.test.sh step 16). One tenant, mr; every row's id
-- is md5 of its label. The assignments cover each case the data step meets:
-- conflicts on a motive and for a driver, trailer rows, a future row, an
-- ended one, newer rows on a disposed and an inactive motive, and a row for a
-- deactivated driver. The tasks cover an assignee kept, one lost to a
-- conflict, ones that reach a trailer through the rig, escalated ones, closed
-- ones, one whose assignee is deactivated, and one on a trailer its
-- assignee's migrated trip towed for five days and let go.
DO $$
DECLARE
  mr    constant uuid := md5('mr')::uuid;
  tz    constant text := 'Africa/Johannesburg';
  today constant date := (now() AT TIME ZONE 'Africa/Johannesburg')::date;
  cfg   constant uuid := md5('mr-cfg')::uuid;
  rig   constant uuid := md5('mr-rig')::uuid;
  d1 constant uuid := md5('mr-d1')::uuid; d2 constant uuid := md5('mr-d2')::uuid;
  d3 constant uuid := md5('mr-d3')::uuid; d4 constant uuid := md5('mr-d4')::uuid;
  dg constant uuid := md5('mr-dg')::uuid; d5 constant uuid := md5('mr-d5')::uuid;
  c1 constant uuid := md5('mr-c1')::uuid;
  m1 constant uuid := md5('mr-m1')::uuid; m2 constant uuid := md5('mr-m2')::uuid;
  m3 constant uuid := md5('mr-m3')::uuid;
  md constant uuid := md5('mr-md')::uuid; mi constant uuid := md5('mr-mi')::uuid;
  m4 constant uuid := md5('mr-m4')::uuid; t3 constant uuid := md5('mr-t3')::uuid;
  rig4 constant uuid := md5('mr-rig4')::uuid;
  t1 constant uuid := md5('mr-t1')::uuid; t2 constant uuid := md5('mr-t2')::uuid;
  insp  constant uuid := md5('mr-insp')::uuid;
  open_at constant timestamptz := now() - interval '2 days';
  week    constant timestamptz := now() + interval '7 days';
BEGIN
  INSERT INTO app.tenant (id, name, subdomain, timezone, state)
  VALUES (mr, 'Migration Replay', 'migration-replay', tz, 'ACTIVE');
  INSERT INTO app.axle_configuration (id, tenant_id, code, name, axle_count)
  VALUES (cfg, mr, 'MR', 'replay', 1);
  INSERT INTO app.app_user (id, tenant_id, email, display_name, role) VALUES
    (d1, mr, 'mr-d1@example.invalid', 'MR Driver One', 'DRIVER'),
    (d2, mr, 'mr-d2@example.invalid', 'MR Driver Two', 'DRIVER'),
    (d3, mr, 'mr-d3@example.invalid', 'MR Driver Three', 'DRIVER'),
    (d4, mr, 'mr-d4@example.invalid', 'MR Driver Four', 'DRIVER'),
    (d5, mr, 'mr-d5@example.invalid', 'MR Driver Five', 'DRIVER'),
    (c1, mr, 'mr-c1@example.invalid', 'MR Controller', 'CONTROLLER');
  INSERT INTO app.app_user (id, tenant_id, email, display_name, role, active)
  VALUES (dg, mr, 'mr-dg@example.invalid', 'MR Driver Gone', 'DRIVER', false);
  INSERT INTO app.vehicle (id, tenant_id, fleet_number, configuration_id, unit_kind, status) VALUES
    (m1, mr, 'MR-M1', cfg, 'HORSE', 'ACTIVE'),
    (m2, mr, 'MR-M2', cfg, 'HORSE', 'ACTIVE'),
    (m3, mr, 'MR-M3', cfg, 'RIGID', 'ACTIVE'),
    (t1, mr, 'MR-T1', cfg, 'TRAILER', 'ACTIVE'),
    (t2, mr, 'MR-T2', cfg, 'TRAILER', 'ACTIVE'),
    (md, mr, 'MR-MD', cfg, 'HORSE', 'DISPOSED'),
    (mi, mr, 'MR-MI', cfg, 'HORSE', 'INACTIVE'),
    (m4, mr, 'MR-M4', cfg, 'HORSE', 'ACTIVE'),
    (t3, mr, 'MR-T3', cfg, 'TRAILER', 'ACTIVE');
  INSERT INTO app.combination (id, tenant_id, motive_vehicle_id, effective_from)
  VALUES (rig, mr, m1, now() - interval '15 days');
  INSERT INTO app.combination_member (tenant_id, combination_id, vehicle_id, sequence)
  VALUES (mr, rig, m1, 1), (mr, rig, t1, 2);
  -- MR-T3 rode in MR-M4's rig from 45 to 40 days back. A member joins an
  -- open rig only (000037), so the rig ends after its members are in.
  INSERT INTO app.combination (id, tenant_id, motive_vehicle_id, effective_from)
  VALUES (rig4, mr, m4, now() - interval '45 days');
  INSERT INTO app.combination_member (tenant_id, combination_id, vehicle_id, sequence)
  VALUES (mr, rig4, m4, 1), (mr, rig4, t3, 2);
  UPDATE app.combination SET effective_to = now() - interval '40 days' WHERE id = rig4;

  INSERT INTO app.vehicle_driver (id, tenant_id, user_id, vehicle_id, from_date, to_date, created_by) VALUES
    (md5('mr-vdA')::uuid, mr, d1, m1, today - 30, NULL, c1),
    (md5('mr-vdB')::uuid, mr, d2, m1, today - 10, NULL, c1),
    (md5('mr-vdC')::uuid, mr, d1, m2, today - 20, NULL, NULL),
    (md5('mr-vdD')::uuid, mr, d3, t2, today - 5, NULL, NULL),
    (md5('mr-vdE')::uuid, mr, d4, m3, today + 3, NULL, NULL),
    (md5('mr-vdF')::uuid, mr, d3, m3, '2024-01-01', '2024-12-31', NULL),
    (md5('mr-vdG')::uuid, mr, d4, m2, today - 40, NULL, NULL),
    (md5('mr-vdH')::uuid, mr, d3, t1, today - 3, NULL, NULL),
    (md5('mr-vdI')::uuid, mr, d2, md, today - 5, NULL, NULL),
    (md5('mr-vdJ')::uuid, mr, d2, mi, today - 4, NULL, NULL),
    (md5('mr-vdK')::uuid, mr, dg, m3, today - 1, NULL, NULL),
    (md5('mr-vdL')::uuid, mr, d5, m4, today - 50, NULL, NULL);

  INSERT INTO app.inspection_task (id, tenant_id, vehicle_id, due_at, assigned_user_id, requested_by, state,
                                   escalated_at, created_at) VALUES
    (md5('mr-k1')::uuid,  mr, m1, week, d2,   c1, 'OPEN',      NULL,    open_at),
    (md5('mr-k2')::uuid,  mr, m2, week, d4,   c1, 'OPEN',      NULL,    open_at),
    (md5('mr-k3')::uuid,  mr, t1, week, d2,   c1, 'OPEN',      NULL,    open_at),
    (md5('mr-k4')::uuid,  mr, t2, week, d3,   c1, 'OPEN',      NULL,    open_at),
    (md5('mr-k5')::uuid,  mr, m3, week, NULL, c1, 'ESCALATED', open_at, open_at),
    (md5('mr-k6')::uuid,  mr, t1, week, NULL, c1, 'ESCALATED', open_at, open_at),
    (md5('mr-k9')::uuid,  mr, m1, week, NULL, c1, 'ESCALATED', open_at, open_at),
    (md5('mr-k10')::uuid, mr, t1, week, d3,   c1, 'OPEN',      NULL,    open_at),
    (md5('mr-k11')::uuid, mr, t2, week, dg,   c1, 'OPEN',      NULL,    open_at),
    (md5('mr-k12')::uuid, mr, t3, week, d5,   c1, 'OPEN',      NULL,    now() - interval '48 days');

  INSERT INTO app.inspection (id, tenant_id, vehicle_id, user_id, client_uuid, started_at, submitted_at)
  VALUES (insp, mr, m1, d1, md5('mr-cu')::uuid, '2026-09-02T07:50:00Z', '2026-09-02T08:00:00Z');
  INSERT INTO app.inspection_task (id, tenant_id, vehicle_id, due_at, requested_by, state,
                                   completed_inspection_id, cancelled_reason, created_at, updated_at) VALUES
    (md5('mr-k7')::uuid, mr, m1, '2026-09-03T21:59:59Z', c1, 'COMPLETED', insp, NULL,
     '2026-09-01T08:00:00Z', '2026-09-02T08:00:00Z'),
    (md5('mr-k8')::uuid, mr, m2, '2026-09-03T21:59:59Z', c1, 'CANCELLED', NULL, 'replay',
     '2026-09-01T08:00:00Z', '2026-09-02T08:00:00Z');
END $$;
