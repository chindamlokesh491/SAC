-- Least-privilege login for the running API and worker (run once as the database owner, after migrations).
--
-- Migrations run as the owner. The API and worker connect as "sac_app_runtime", a member of the
-- "sac_backend" group role from migration 024: it can read and write rows (RLS policy sac_backend_all)
-- but cannot create, alter, drop or truncate tables, read migration history, or bypass RLS.
--
--   psql "$OWNER_DATABASE_URL" -v runtime_password="'<long random password>'" -f database/roles/app_runtime_role.sql
-- Supabase: connect through the pooler as user "sac_app_runtime.<project-ref>" with that password.
-- Keep the owner URL only for `migrate`.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sac_backend') THEN
    RAISE EXCEPTION 'Run the migrations first: role sac_backend comes from migration 024';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sac_app_runtime') THEN
    CREATE ROLE sac_app_runtime LOGIN;
  END IF;
END $$;
-- SUPERUSER / REPLICATION / BYPASSRLS are not set here: new roles never have them, and on Supabase the
-- owner (not a superuser) may not even mention them. The check below proves the role is unprivileged.
ALTER ROLE sac_app_runtime WITH LOGIN INHERIT NOCREATEDB NOCREATEROLE CONNECTION LIMIT 30 PASSWORD :runtime_password;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sac_app_runtime' AND (rolsuper OR rolreplication OR rolbypassrls OR rolcreaterole OR rolcreatedb)) THEN
    RAISE EXCEPTION 'sac_app_runtime must not be superuser, replication, BYPASSRLS, CREATEROLE or CREATEDB';
  END IF;
END $$;
GRANT sac_backend TO sac_app_runtime;
DO $$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO sac_app_runtime', current_database()); END $$;
-- Queries never need longer than this; a runaway statement is cancelled instead of holding locks.
ALTER ROLE sac_app_runtime SET statement_timeout = '15s';
ALTER ROLE sac_app_runtime SET idle_in_transaction_session_timeout = '30s';
