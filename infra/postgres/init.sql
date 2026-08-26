-- DevGuard local/bootstrap PostgreSQL roles (C007 §23 step 8).
-- Idempotent: safe to re-run. Passwords are set externally by the operator
-- (e.g. `ALTER ROLE devguard_migrator PASSWORD '…'`); this file never embeds secrets.
--
-- Least privilege:
--   devguard_migrator — DDL: owns and alters schema (migration runner role).
--   devguard_app      — DML only: SELECT/INSERT/UPDATE/DELETE; cannot CREATE/ALTER/DROP.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'devguard_migrator') THEN
    CREATE ROLE devguard_migrator LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'devguard_app') THEN
    CREATE ROLE devguard_app LOGIN;
  END IF;
END
$$;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;

GRANT USAGE, CREATE ON SCHEMA public TO devguard_migrator;
GRANT USAGE ON SCHEMA public TO devguard_app;

-- Existing objects (migrator-owned after running migrations).
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO devguard_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO devguard_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO devguard_app;

-- Future tables created by devguard_migrator inherit the same grants.
ALTER DEFAULT PRIVILEGES FOR ROLE devguard_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO devguard_app;
ALTER DEFAULT PRIVILEGES FOR ROLE devguard_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO devguard_app;
ALTER DEFAULT PRIVILEGES FOR ROLE devguard_migrator IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO devguard_app;

-- The runtime role must never gain schema mutation on any object.
ALTER DEFAULT PRIVILEGES FOR ROLE devguard_migrator IN SCHEMA public
  REVOKE CREATE ON TABLES FROM devguard_app;
