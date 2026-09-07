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
-- scans it as text, answered 500 for the driver. The backfill is 000011's
-- own derivation (configuration code, then fleet-number convention); a row
-- neither resolves stops the migration rather than being guessed, because
-- the kind decides whether TY009 demands an odometer of every fitment.
-- vehicle_audited (000035) logs each backfilled row as an UPDATE whose
-- actor_id is NULL, because app.current_actor_id() has nothing to read
-- during a migration; an operator asking who set a unit's kind finds that
-- row and this migration.
UPDATE app.vehicle v
   SET unit_kind = COALESCE(
       (SELECT CASE WHEN c.code LIKE 'HORSE%' OR c.code = 'BAC_TRUCKS' THEN 'HORSE'
                    WHEN c.code LIKE 'TRAILER%' OR c.code LIKE 'DRAWBAR%' THEN 'TRAILER'
                    WHEN c.code LIKE 'RIGID%' THEN 'RIGID'
                    WHEN c.code LIKE 'LIGHT%' THEN 'LIGHT' END::app.unit_kind
          FROM app.axle_configuration c WHERE c.id = v.configuration_id),
       CASE WHEN v.fleet_number ILIKE 'HORSE%' THEN 'HORSE'
            WHEN v.fleet_number ILIKE 'LINK%'  THEN 'TRAILER' END::app.unit_kind)
 WHERE v.unit_kind IS NULL;

DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(t.subdomain || '/' || v.fleet_number, ', ' ORDER BY t.subdomain, v.fleet_number)
    INTO bad FROM app.vehicle v JOIN app.tenant t ON t.id = v.tenant_id WHERE v.unit_kind IS NULL;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'TYRE-172: unit_kind is underivable for %; set it by hand before applying 000042', bad;
  END IF;
END $$;

ALTER TABLE app.vehicle ALTER COLUMN unit_kind SET NOT NULL;
-- 000028's reject_configuration_change_with_history keeps its
-- "OLD.unit_kind IS NULL may be backfilled" clause; it is unreachable from
-- here on and harmless, and that migration is frozen.
