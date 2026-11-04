BEGIN;

-- Additive adaptation of the supplied delivery-partner module to the live SAC schema.
-- Partner identity is the existing users row; assignments remain the existing source of truth.
ALTER TABLE users ADD COLUMN IF NOT EXISTS delivery_partner_code text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS delivery_partner_online boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS delivery_partner_availability_changed_at timestamptz;
CREATE SEQUENCE IF NOT EXISTS delivery_partner_code_seq START 1;
CREATE OR REPLACE FUNCTION sac_next_delivery_partner_code() RETURNS text LANGUAGE plpgsql AS $$
DECLARE n bigint;
BEGIN n := nextval('delivery_partner_code_seq'); RETURN 'SAC-DP-' || CASE WHEN n < 10000 THEN lpad(n::text,4,'0') ELSE n::text END; END $$;
UPDATE users SET delivery_partner_code = sac_next_delivery_partner_code()
 WHERE role = 'delivery_partner' AND delivery_partner_code IS NULL;

-- Assign stable identifiers to newly-created partner accounts as well.
CREATE OR REPLACE FUNCTION sac_assign_delivery_partner_code() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.role = 'delivery_partner' AND NEW.delivery_partner_code IS NULL THEN
    NEW.delivery_partner_code := sac_next_delivery_partner_code();
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS users_delivery_partner_code_trg ON users;
CREATE TRIGGER users_delivery_partner_code_trg
BEFORE INSERT OR UPDATE OF role ON users
FOR EACH ROW EXECUTE FUNCTION sac_assign_delivery_partner_code();
CREATE UNIQUE INDEX IF NOT EXISTS users_delivery_partner_code_uq
 ON users(delivery_partner_code) WHERE delivery_partner_code IS NOT NULL;
ALTER TABLE delivery_assignments ADD COLUMN IF NOT EXISTS accepted_at timestamptz;
ALTER TABLE delivery_assignments ADD COLUMN IF NOT EXISTS picked_up_at timestamptz;
ALTER TABLE delivery_assignments ADD COLUMN IF NOT EXISTS out_for_delivery_at timestamptz;
ALTER TABLE delivery_assignments ADD COLUMN IF NOT EXISTS otp_verified_at timestamptz;
ALTER TABLE delivery_assignments ADD COLUMN IF NOT EXISTS delivered_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS picked_up_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS out_for_delivery_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_exception text;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='orders_delivery_exception_check') THEN
  ALTER TABLE orders ADD CONSTRAINT orders_delivery_exception_check CHECK (delivery_exception IS NULL OR delivery_exception IN ('issue_reported','admin_review','reassignment_required'));
 END IF;
END $$;
CREATE TABLE IF NOT EXISTS delivery_assignment_events (
 id bigserial PRIMARY KEY, assignment_id uuid NOT NULL REFERENCES delivery_assignments(id),
 order_id uuid NOT NULL REFERENCES orders(id), delivery_person_id uuid NOT NULL REFERENCES users(id),
 event text NOT NULL CHECK(event IN ('assigned','accepted','picked_up','out_for_delivery','otp_failed','otp_verified','cod_collected','delivered','issue_reported','cancelled')),
 from_status text, to_status text, actor_user_id uuid REFERENCES users(id), actor_role text,
 metadata jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS delivery_assignment_events_order_idx ON delivery_assignment_events(order_id,created_at,id);
CREATE TABLE IF NOT EXISTS delivery_issues (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES orders(id),
 assignment_id uuid NOT NULL REFERENCES delivery_assignments(id), delivery_person_id uuid NOT NULL REFERENCES users(id),
 reported_by uuid NOT NULL REFERENCES users(id), reason text NOT NULL CHECK(reason IN ('customer_not_available','customer_phone_unreachable','incorrect_address','customer_refused','payment_issue','other')),
 description text CHECK(description IS NULL OR char_length(description)<=1000),
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','admin_review','resolved','reassignment_required')),
 resolution_note text, resolved_by uuid REFERENCES users(id), resolved_at timestamptz,
 client_request_id uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(reason <> 'other' OR (description IS NOT NULL AND char_length(btrim(description))>0))
);
CREATE UNIQUE INDEX IF NOT EXISTS delivery_issues_request_uq ON delivery_issues(assignment_id,client_request_id) WHERE client_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS delivery_issues_status_idx ON delivery_issues(status,created_at DESC);
CREATE TABLE IF NOT EXISTS delivery_notifications_outbox (
 id bigserial PRIMARY KEY, audience text NOT NULL CHECK(audience IN ('admin','customer','delivery_partner')),
 recipient_id uuid REFERENCES users(id), event_type text NOT NULL, order_id uuid REFERENCES orders(id),
 payload jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz
);
CREATE INDEX IF NOT EXISTS delivery_notifications_pending_idx ON delivery_notifications_outbox(created_at) WHERE processed_at IS NULL;
SELECT enable_backend_rls('delivery_assignment_events');
SELECT enable_backend_rls('delivery_issues');
SELECT enable_backend_rls('delivery_notifications_outbox');
COMMIT;
