-- ============================================================================
--  Threshold policy rows are written once and never back-dated (TYRE-299)
--  Implements: FR-CFG-051, FR-CFG-010, FR-CFG-012, FR-CFG-044, FR-EXC-021,
--  FR-VAL-006, FR-VAL-020; U68, U69, U70 item 3, TYRE-189 F5
-- ============================================================================
-- New SQLSTATE TY023, raised by the two triggers below and reached by no
-- route (api/internal/httpapi/refusal_codes.json). Every routine here runs
-- with invoker rights (db/CLAUDE.md, "Adding a function"). The design and the
-- owner's rulings: docs/superpowers/specs/2026-10-14-threshold-policy-integrity-design.md.
--
-- Every stored rand_per_mm divides by a threshold resolved from this table,
-- so a past row that moves moves a past valuation (FR-VAL-020), and
-- FR-VAL-006's reproduction rests on it staying put. A change is a new row
-- dated now or later (FR-CFG-051).

-- Both resolvers order by group, class, then effective_from DESC, so two rows
-- sharing all three would resolve by heap order. NULLS NOT DISTINCT because
-- the tenant-wide scope is a NULL group and a NULL class.
ALTER TABLE app.threshold_policy
  ADD CONSTRAINT threshold_policy_one_row_per_instant
  UNIQUE NULLS NOT DISTINCT (tenant_id, operating_group_id, axle_class, effective_from);

-- U68: nothing reads these. TYRE-299 comment 13723 carries the SRS change
-- for FR-CFG-010's scrap and insurance figures.
ALTER TABLE app.threshold_policy
  DROP CONSTRAINT retread_at_or_above_scrap,
  DROP COLUMN scrap_threshold_mm,
  DROP COLUMN insurance_minimum_mm,
  DROP COLUMN insurance_note;

-- FR-EXC-021's warning band lies between the two thresholds, so a warning at
-- or below the retread threshold is a band nothing can fall in (S1). A NULL
-- warning passes.
ALTER TABLE app.threshold_policy
  ADD CONSTRAINT warning_above_retread CHECK (warning_threshold_mm > retread_threshold_mm);

-- Rule 5, TYRE-189 F5: every row states its own threshold and cap. A new
-- tenant's 4 mm (FR-CFG-011) is the baseline row provisioning writes.
ALTER TABLE app.threshold_policy
  ALTER COLUMN retread_threshold_mm DROP DEFAULT,
  ALTER COLUMN max_retreads DROP DEFAULT;

-- U69. The grant stops app_rw; the trigger stops the owner and a superuser,
-- which no grant binds, on 000024's pattern. threshold_policy_stamps_updated
-- (000017) stays, unreachable.
REVOKE UPDATE ON app.threshold_policy FROM app_rw;

CREATE FUNCTION app.threshold_policy_is_written_once() RETURNS trigger
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'TY023',
    MESSAGE = 'a threshold policy row is history and is never edited; a change is a new row with a later effective_from (FR-CFG-051)';
END $$;

CREATE TRIGGER threshold_policy_written_once
BEFORE UPDATE ON app.threshold_policy
FOR EACH ROW EXECUTE FUNCTION app.threshold_policy_is_written_once();

-- U70 item 3. now() is the transaction's start, so a row taking its DEFAULT
-- now() passes, as does any later instant. The one earlier instant is a
-- scope's first row at -infinity, the baseline FR-CFG-051 applies
-- prospectively from (SRS §5.1, errata E1).
CREATE FUNCTION app.threshold_policy_is_not_backdated() RETURNS trigger
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
BEGIN
  -- A class or group scope's first baseline reaches back over all its
  -- history. That is safe only while U5 holds: no as-at reader names a class
  -- or a group, so no past figure moves.
  IF NEW.effective_from = '-infinity' THEN
    -- Under RLS this sees only the caller's tenant, the only rows it needs.
    -- Two sessions planting one empty scope at once can both pass it; no
    -- route writes this table and provisioning writes a scope's baseline
    -- once, so the spec accepts that race.
    IF EXISTS (SELECT 1 FROM app.threshold_policy p
                WHERE p.tenant_id = NEW.tenant_id
                  AND p.operating_group_id IS NOT DISTINCT FROM NEW.operating_group_id
                  AND p.axle_class IS NOT DISTINCT FROM NEW.axle_class) THEN
      RAISE EXCEPTION USING ERRCODE = 'TY023',
        MESSAGE = 'this scope already has a threshold policy; only its first row may be the -infinity baseline (SRS 5.1, errata E1)';
    END IF;
  ELSIF NEW.effective_from < now() THEN
    RAISE EXCEPTION USING ERRCODE = 'TY023',
      MESSAGE = 'a threshold policy row takes effect when it is written or later, never earlier (FR-CFG-051)';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER threshold_policy_not_backdated
BEFORE INSERT ON app.threshold_policy
FOR EACH ROW EXECUTE FUNCTION app.threshold_policy_is_not_backdated();
