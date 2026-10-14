-- 000054 down. Restores the state the up migration found (docs/lessons.md,
-- 2026-09-15): 000012's three columns with their CHECKs and its two
-- defaults, 000012's UPDATE grant to app_rw, and none of the triggers,
-- functions or constraints the up added. Re-added columns sit at the end of
-- the row; nothing reads the row by position.
DROP TRIGGER threshold_policy_not_backdated ON app.threshold_policy;
DROP FUNCTION app.threshold_policy_is_not_backdated();
DROP TRIGGER threshold_policy_written_once ON app.threshold_policy;
DROP FUNCTION app.threshold_policy_is_written_once();

GRANT UPDATE ON app.threshold_policy TO app_rw;

ALTER TABLE app.threshold_policy
  ALTER COLUMN retread_threshold_mm SET DEFAULT 4.0,
  ALTER COLUMN max_retreads SET DEFAULT 2,
  DROP CONSTRAINT warning_above_retread,
  DROP CONSTRAINT threshold_policy_one_row_per_instant;

-- Refilled from each row's own retread threshold, so the restored
-- retread_at_or_above_scrap holds on every row. A generated column fills it
-- in the table rewrite: an UPDATE would fire threshold_policy_stamps_updated
-- and rewrite every row's updated_at.
ALTER TABLE app.threshold_policy
  ADD COLUMN scrap_threshold_mm numeric(4,1) GENERATED ALWAYS AS (retread_threshold_mm) STORED;
ALTER TABLE app.threshold_policy ALTER COLUMN scrap_threshold_mm DROP EXPRESSION;
ALTER TABLE app.threshold_policy
  ALTER COLUMN scrap_threshold_mm SET DEFAULT 4.0,
  ALTER COLUMN scrap_threshold_mm SET NOT NULL,
  ADD CONSTRAINT threshold_policy_scrap_threshold_mm_check CHECK (scrap_threshold_mm > 0),
  ADD COLUMN insurance_minimum_mm numeric(4,1)
    CONSTRAINT threshold_policy_insurance_minimum_mm_check CHECK (insurance_minimum_mm > 0),
  ADD COLUMN insurance_note text,
  ADD CONSTRAINT retread_at_or_above_scrap CHECK (retread_threshold_mm >= scrap_threshold_mm);
