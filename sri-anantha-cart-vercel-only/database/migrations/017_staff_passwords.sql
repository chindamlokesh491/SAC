-- Staff (admin / operator) sign in with mobile number + password instead of SMS OTP.
-- Only salted scrypt hashes are stored. Customers never have a password.
BEGIN;
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_hash TEXT,
  ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;

ALTER TABLE users
  ADD CONSTRAINT users_password_staff_only CHECK (password_hash IS NULL OR role IN ('admin', 'operator')),
  ADD CONSTRAINT users_password_hash_format CHECK (password_hash IS NULL OR password_hash LIKE 'scrypt$%'),
  ADD CONSTRAINT users_failed_login_attempts_check CHECK (failed_login_attempts >= 0);
COMMIT;
