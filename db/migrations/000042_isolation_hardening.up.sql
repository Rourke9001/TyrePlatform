-- 000042: two isolation gaps the 6 Sep 2026 review sweep found (TYRE-143),
-- both closed in the schema rather than in Go (rule 1).
--
-- TYRE-158. app.tenant's UNIQUE (subdomain) is global — the table IS the
-- tenant, so no tenant_id can lead the key — and the app role held UPDATE
-- and INSERT on it. tenant_self restricts WHICH row a tenant may update,
-- but a unique violation fires before RLS does: setting one's own
-- subdomain to a guessed value answered 23505 when another tenant held it
-- and succeeded when none did, which is the cross-tenant existence oracle
-- TYRE-87 generalised. No route and no function callable by app_rw writes
-- the table; the seeds and the Go test fixtures write it as postgres.
REVOKE INSERT, UPDATE ON app.tenant FROM app_rw;

-- TYRE-172. vehicle.unit_kind was required by the API (createVehicle) and
-- refused as an edit (TY008) but never required by the schema, so a
-- pre-product row could still carry NULL and the capture context read, which
-- scans it as text, answered 500 for the driver. The backfill uses 000011's
-- two derivations (configuration code, then fleet-number convention), but
-- where 000011 let the first silently win, a row whose two derivations
-- disagree stops the migration exactly as a row neither resolves does,
-- rather than being guessed: the kind decides whether TY009 demands an
-- odometer of every fitment. vehicle_audited (000035) logs each backfilled
-- row as an UPDATE whose actor_id is NULL, because app.current_actor_id()
-- has nothing to read during a migration; an operator asking who set a
-- unit's kind finds that row and this migration.
CREATE TEMP TABLE tyre_172_kind AS
SELECT v.id, t.subdomain, v.fleet_number,
       (SELECT CASE WHEN c.code LIKE 'HORSE%' OR c.code = 'BAC_TRUCKS' THEN 'HORSE'
                    WHEN c.code LIKE 'TRAILER%' OR c.code LIKE 'DRAWBAR%' THEN 'TRAILER'
                    WHEN c.code LIKE 'RIGID%' THEN 'RIGID'
                    WHEN c.code LIKE 'LIGHT%' THEN 'LIGHT' END::app.unit_kind
          FROM app.axle_configuration c WHERE c.id = v.configuration_id) AS by_configuration,
       CASE WHEN v.fleet_number ILIKE 'HORSE%' THEN 'HORSE'
            WHEN v.fleet_number ILIKE 'LINK%'  THEN 'TRAILER' END::app.unit_kind AS by_fleet_number
  FROM app.vehicle v
  JOIN app.tenant t ON t.id = v.tenant_id
 WHERE v.unit_kind IS NULL;

DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(subdomain || '/' || fleet_number || ' (' || by_configuration || ' by configuration, '
                    || by_fleet_number || ' by fleet number)', ', ' ORDER BY subdomain, fleet_number)
    INTO bad FROM tyre_172_kind
   WHERE by_configuration IS NOT NULL AND by_fleet_number IS NOT NULL
     AND by_configuration <> by_fleet_number;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'TYRE-172: unit_kind derivations disagree for %; set it by hand before applying 000042', bad;
  END IF;
  SELECT string_agg(subdomain || '/' || fleet_number, ', ' ORDER BY subdomain, fleet_number)
    INTO bad FROM tyre_172_kind
   WHERE by_configuration IS NULL AND by_fleet_number IS NULL;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'TYRE-172: unit_kind is underivable for %; set it by hand before applying 000042', bad;
  END IF;
END $$;

UPDATE app.vehicle v
   SET unit_kind = COALESCE(k.by_configuration, k.by_fleet_number)
  FROM tyre_172_kind k
 WHERE k.id = v.id;

DROP TABLE tyre_172_kind;

ALTER TABLE app.vehicle ALTER COLUMN unit_kind SET NOT NULL;
-- 000028's reject_configuration_change_with_history keeps its
-- "OLD.unit_kind IS NULL may be backfilled" clause; it is unreachable from
-- here on and harmless, and that migration is frozen.
