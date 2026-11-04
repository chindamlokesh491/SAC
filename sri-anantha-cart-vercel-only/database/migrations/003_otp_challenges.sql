BEGIN;

CREATE TABLE otp_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164 TEXT NOT NULL CHECK (phone_e164 ~ '^\\+[1-9][0-9]{7,14}$'),
  code_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX otp_challenges_phone_created_idx ON otp_challenges(phone_e164, created_at DESC);
CREATE INDEX otp_challenges_expiry_idx ON otp_challenges(expires_at);

COMMIT;
