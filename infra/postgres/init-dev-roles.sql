-- C098 §13 — local-only application role bootstrap.
--
-- Runs once at first volume creation inside the devguard-local project.
-- The migration/seed tooling connects as devguard_admin (database owner);
-- the long-lived API/worker runtime would connect as the least-privileged
-- devguard_app role once application roles are wired by later components.
--
-- These credentials are fixed local dev values bound to loopback; they are
-- not secrets and must never be reused outside this Compose project.
\set app_password 'devguard_app_local'

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'devguard_app') THEN
    EXECUTE format('CREATE ROLE devguard_app LOGIN PASSWORD %L', :'app_password');
  ELSE
    EXECUTE format('ALTER ROLE devguard_app LOGIN PASSWORD %L', :'app_password');
  END IF;
END
$$;

GRANT CONNECT ON DATABASE devguard TO devguard_app;
-- Schema-level privileges follow migrations ownership for now; application
-- least-privilege grants land with the components that own those tables.
GRANT USAGE ON SCHEMA public TO devguard_app;
