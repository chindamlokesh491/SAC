BEGIN;

-- Migration 003 accidentally stored a double-escaped plus sign, rejecting valid
-- E.164 phone numbers. Replace the constraint in a forward-only migration so
-- databases that already applied migration 003 can be repaired safely.
ALTER TABLE otp_challenges
  DROP CONSTRAINT IF EXISTS otp_challenges_phone_e164_check;

ALTER TABLE otp_challenges
  ADD CONSTRAINT otp_challenges_phone_e164_check
  CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$');

COMMIT;
