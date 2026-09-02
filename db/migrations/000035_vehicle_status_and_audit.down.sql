-- Reverses 000035: drops the status writer, detaches and drops the audit
-- mechanism, and puts app.vehicle_tag_map back under 000018's DELETE revoke.
--
-- The audit rows the trigger wrote stay. They are the fleet's record of who
-- changed what, and a migration that deleted them would be destroying facts
-- rather than changing a schema (rule 3, CR-004) — the same reason 000034
-- leaves the events and valuations it wrote in place.
DROP TRIGGER vehicle_audited ON app.vehicle;
DROP FUNCTION app.audit_row_change();
DROP FUNCTION app.set_vehicle_status(uuid, app.vehicle_status, text);
REVOKE DELETE ON app.vehicle_tag_map FROM app_rw;
