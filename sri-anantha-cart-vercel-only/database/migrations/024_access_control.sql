-- Database access control, written for Supabase and plain PostgreSQL alike.
--
-- Who may touch application data:
--   * the migration owner (Supabase: "postgres"), which owns every table;
--   * the API and worker, through the NOLOGIN group role "sac_backend". The login role they use
--     (sac_app_runtime, see database/roles/app_runtime_role.sql) is a member of it.
-- Nobody else. In particular Supabase's Data API roles (anon, authenticated, service_role) get no
-- privileges on any table, sequence or function here, so the publishable ("anon") key and even the
-- service-role key cannot read or change shop data through Supabase's REST/GraphQL endpoints.
--
-- Row Level Security is enabled on every table as a second, independent barrier: with RLS on and the
-- only policy granted to sac_backend, any other non-owner role sees zero rows even if a privilege is
-- granted by mistake later. The owner bypasses RLS (it must run migrations and maintenance).
--
-- Everything is applied to current_schema(), so the integration tests (one schema per run) get the
-- same rules as production's "public" schema.
BEGIN;

-- Roles are shared by the whole server; tolerate another session creating it at the same moment.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sac_backend') THEN
    CREATE ROLE sac_backend NOLOGIN NOCREATEDB NOCREATEROLE;
  END IF;
EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
END $$;

DO $$
DECLARE
  s text := current_schema();
  api_role text;
  t record;
BEGIN
  -- Backend: row access only. No TRUNCATE, no DDL, no access to migration bookkeeping.
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO sac_backend', s);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO sac_backend', s);
  EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO sac_backend', s);
  EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA %I TO sac_backend', s);
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO sac_backend', s);
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO sac_backend', s);
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT EXECUTE ON FUNCTIONS TO sac_backend', s);
  IF to_regclass(format('%I.schema_migrations', s)) IS NOT NULL THEN
    EXECUTE format('REVOKE ALL ON TABLE %I.schema_migrations FROM sac_backend', s);
  END IF;

  -- Functions are executable by PUBLIC by default; only the backend needs them.
  EXECUTE format('REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA %I FROM PUBLIC', s);

  -- Supabase API roles (absent on plain PostgreSQL): remove every privilege, now and for future objects.
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM %I', s, api_role);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %I FROM %I', s, api_role);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA %I FROM %I', s, api_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON TABLES FROM %I', s, api_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON SEQUENCES FROM %I', s, api_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON FUNCTIONS FROM %I', s, api_role);
    END IF;
  END LOOP;

  -- Deny-by-default RLS with one explicit policy for the backend role.
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = s AND tablename <> 'schema_migrations' LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', s, t.tablename);
    EXECUTE format('DROP POLICY IF EXISTS sac_backend_all ON %I.%I', s, t.tablename);
    EXECUTE format('CREATE POLICY sac_backend_all ON %I.%I TO sac_backend USING (true) WITH CHECK (true)', s, t.tablename);
  END LOOP;
  IF to_regclass(format('%I.schema_migrations', s)) IS NOT NULL THEN
    EXECUTE format('ALTER TABLE %I.schema_migrations ENABLE ROW LEVEL SECURITY', s);
  END IF;
END $$;

-- New functions created by the migration owner are not executable by PUBLIC either.
-- (PostgreSQL only allows revoking PUBLIC's default at the global level, not per schema.)
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- Tables created by later migrations must call enable_backend_rls() so they get the same protection.
CREATE OR REPLACE FUNCTION enable_backend_rls(table_name regclass) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', table_name);
  EXECUTE format('DROP POLICY IF EXISTS sac_backend_all ON %s', table_name);
  EXECUTE format('CREATE POLICY sac_backend_all ON %s TO sac_backend USING (true) WITH CHECK (true)', table_name);
END;
$$;
REVOKE EXECUTE ON FUNCTION enable_backend_rls(regclass) FROM PUBLIC, sac_backend;

COMMIT;
