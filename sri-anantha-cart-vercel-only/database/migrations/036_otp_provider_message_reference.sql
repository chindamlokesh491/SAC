-- SMS provider message references for sign-in OTP challenges (SMS Gateway Hub MessageId),
-- so a delivery complaint can be traced to the provider record without storing the code.
-- Originally drafted as 033 on feat/delivery-partner-portal-main; renumbered to 036 because
-- 033-035 are already the reviewed staging order (return cancellation, partial returns, delivery hardening).
BEGIN;
ALTER TABLE otp_challenges ADD COLUMN IF NOT EXISTS provider_message_id text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'otp_challenges_provider_message_id_length') THEN
    ALTER TABLE otp_challenges ADD CONSTRAINT otp_challenges_provider_message_id_length
      CHECK (provider_message_id IS NULL OR char_length(provider_message_id) <= 128);
  END IF;
END $$;
COMMIT;
