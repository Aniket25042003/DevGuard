-- 001_init (C007): shared conventions only.
-- Aggregate tables arrive with C009–C012; this migration installs the common
-- updated_at trigger helper every mutable table uses.

CREATE OR REPLACE FUNCTION devguard_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
