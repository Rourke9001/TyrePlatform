-- What 000067's up leaves of 000067_before.sql's two tenants, read as
-- postgres at 67 (TYRE-240, scripts/provision-tenant.test.sh step 17).
DO $$
DECLARE
  shipped constant jsonb := '{"worn_to_threshold": "Worn to threshold", "damage": "Damage", "irregular_wear": "Irregular wear", "casing_failure": "Casing failure", "vehicle_disposal": "Vehicle disposal", "rotation": "Rotation", "correction": "Correction", "puncture": "Puncture"}';
  got text;
BEGIN
  SELECT string_agg(c.effective_from || ' ' || (c.value = shipped), ', ') INTO got
    FROM app.configuration c
   WHERE c.tenant_id = md5('m67')::uuid AND c.key = 'removal_reason_labels';
  IF got IS DISTINCT FROM '-infinity true' THEN
    RAISE EXCEPTION 'FAIL M67: the tenant with reasons holds labels rows %, not one shipped row at -infinity',
      COALESCE(got, 'none');
  END IF;
  IF EXISTS (SELECT 1 FROM app.configuration c
              WHERE c.tenant_id = md5('m67-none')::uuid AND c.key = 'removal_reason_labels') THEN
    RAISE EXCEPTION 'FAIL M67: the tenant with no reasons was given labels';
  END IF;
  RAISE NOTICE 'PASS  M67 the up gives a tenant with reasons the shipped words, and one with none nothing';
END $$;
