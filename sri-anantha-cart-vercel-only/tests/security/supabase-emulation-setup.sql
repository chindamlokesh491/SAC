-- Reproduces the parts of Supabase's role model that matter for migrations 021/024, on a THROWAWAY
-- PostgreSQL cluster whose bootstrap superuser is "supabase_admin" (as on Supabase). Idempotent.
-- Facts taken from the real project (read-only queries on 2026-10-30):
--   postgres: NOSUPERUSER, CREATEROLE, BYPASSRLS, owns the database
--   anon / authenticated: NOLOGIN; service_role: NOLOGIN BYPASSRLS; authenticator: LOGIN NOINHERIT
--   database ACL keeps PUBLIC CONNECT/TEMP; default privileges give anon/authenticated/service_role ALL on new objects
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN CREATE ROLE postgres LOGIN CREATEROLE CREATEDB BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN CREATE ROLE authenticator LOGIN NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_storage_admin') THEN CREATE ROLE supabase_storage_admin LOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN CREATE ROLE supabase_auth_admin LOGIN; END IF;
END $$;
GRANT anon, authenticated, service_role TO authenticator;
DROP DATABASE IF EXISTS sac_emul;
DROP ROLE IF EXISTS sac_app_runtime;
DROP ROLE IF EXISTS sac_backend;
CREATE DATABASE sac_emul OWNER postgres;
\connect sac_emul
ALTER SCHEMA public OWNER TO pg_database_owner;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
