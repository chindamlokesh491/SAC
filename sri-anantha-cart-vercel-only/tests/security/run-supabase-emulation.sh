#!/usr/bin/env bash
# Database security check on a Supabase-like THROWAWAY cluster (bootstrap superuser "supabase_admin").
#   EMUL_HOST=localhost EMUL_PORT=5434 tests/security/run-supabase-emulation.sh
# 1. recreate roles + database, 2. run every migration as the non-superuser owner, 3. create the runtime
# role, 4. privilege checks (db-permissions.mjs), 5. the whole API test suite connected as the runtime role.
set -euo pipefail
HOST=${EMUL_HOST:-localhost}; PORT=${EMUL_PORT:-5434}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
psql -h "$HOST" -p "$PORT" -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q -f "$ROOT/tests/security/supabase-emulation-setup.sql"
DATABASE_URL="postgres://postgres@$HOST:$PORT/sac_emul" node "$ROOT/apps/api/scripts/migrate.mjs" | tail -1
psql -h "$HOST" -p "$PORT" -U postgres -d sac_emul -v ON_ERROR_STOP=1 -q -v runtime_password="'emul-$(openssl rand -hex 12)'" -f "$ROOT/database/roles/app_runtime_role.sql" 2>&1 | grep -v NOTICE || true
# The throwaway cluster uses trust authentication; drop the random password so tests can connect.
psql -h "$HOST" -p "$PORT" -U supabase_admin -d sac_emul -q -c "ALTER ROLE sac_app_runtime PASSWORD NULL"
OWNER_URL="postgres://postgres@$HOST:$PORT/sac_emul" RUNTIME_URL="postgres://sac_app_runtime@$HOST:$PORT/sac_emul" \
AUTHENTICATOR_URL="postgres://authenticator@$HOST:$PORT/sac_emul" STORAGE_URL="postgres://supabase_storage_admin@$HOST:$PORT/sac_emul" \
  node "$ROOT/tests/security/db-permissions.mjs"
cd "$ROOT/apps/api"
TEST_DATABASE_URL="postgres://postgres@$HOST:$PORT/sac_emul" TEST_RUNTIME_DATABASE_URL="postgres://sac_app_runtime@$HOST:$PORT/sac_emul" \
  npx tsx --test --test-concurrency=1 test/*.test.ts 2>&1 | grep -E "^# (tests|pass|fail)|^not ok|    not ok|^ℹ (tests|pass|fail)|^✖"
# (Node 22 prints TAP "# tests"; Node 24+ prints the spec reporter's "ℹ tests" and "✖" lines.)
