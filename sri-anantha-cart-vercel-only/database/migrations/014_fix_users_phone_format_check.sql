BEGIN;

-- Migration 001 double-escaped the leading plus in the phone regex. Replace the
-- original check in a forward-only migration so valid E.164 phone numbers pass.
ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_phone_format;

ALTER TABLE users
  ADD CONSTRAINT users_phone_format
  CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{7,14}$');

COMMIT;
