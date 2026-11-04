-- Staff accounts removed from the admin panel keep their row (the audit log refers to it)
-- but lose all access. The marker lets an admin add the same number again later.
BEGIN;
ALTER TABLE users ADD COLUMN IF NOT EXISTS staff_removed_at TIMESTAMPTZ;
COMMIT;
