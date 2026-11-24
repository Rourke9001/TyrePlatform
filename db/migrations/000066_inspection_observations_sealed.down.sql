-- Reverses 000066: the two seals, and app.inspection_is_sealed as 000040
-- wrote it, verbatim.
DROP TRIGGER inspection_absent_spare_sealed ON app.inspection_absent_spare;
DROP TRIGGER inspection_warning_sealed ON app.inspection_warning;

CREATE OR REPLACE FUNCTION app.inspection_is_sealed() RETURNS trigger
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE v_insp uuid; v_created timestamptz;
BEGIN
  IF TG_TABLE_NAME = 'reading' THEN
    v_insp := NEW.inspection_id;
  ELSE
    SELECT r.inspection_id INTO v_insp FROM app.reading r WHERE r.id = NEW.reading_id;
  END IF;
  SELECT i.created_at INTO v_created FROM app.inspection i WHERE i.id = v_insp;
  -- a parent this session cannot see is the FK's and RLS's refusal, not this
  -- one. NOT FOUND is that case. A reading or measurement belongs to the
  -- transaction that created its inspection, and every writer in that
  -- transaction gets its inspection's created_at from the same now(), which
  -- equals transaction_timestamp() exactly (000023's own rows land this
  -- way). app_rw holds INSERT on app.inspection with created_at settable
  -- and no NOT NULL (000017), so any other instant is a claim nobody made:
  -- earlier (a prior transaction's row), later (a future-dated row that
  -- would otherwise stay appendable until that instant passes) or absent
  -- (NULL) are all refused alike. IS DISTINCT FROM is what makes NULL one
  -- more case of "not equal" instead of a silent pass.
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF v_created IS DISTINCT FROM transaction_timestamp() THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TY020',
      MESSAGE = format('inspection %s was submitted at %s and is sealed; a %s cannot be added to it',
                       v_insp, v_created, replace(TG_TABLE_NAME, '_', ' ')),
      HINT    = 'void the inspection and capture the unit again (FR-INS-012)';
  END IF;
  RETURN NEW;
END $$;
