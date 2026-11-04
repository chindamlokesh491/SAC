-- Durable background processing (apps/worker) and provider-neutral integration tables.
--
-- jobs            one unit of background work. Claimed with FOR UPDATE SKIP LOCKED, so any number of
--                 worker processes can run without two of them taking the same job. A job whose worker
--                 dies is reclaimed when its lease (locked_until) expires. Handlers must be idempotent:
--                 delivery is at-least-once.
-- job_attempts    one row per attempt (start, end, outcome, error) for monitoring and audits.
-- outbox_events   facts recorded by the API ("catalog.changed"). The worker turns each event into jobs
--                 exactly once (dedupe_key = 'outbox:<event id>:<kind>') and marks it published.
-- webhook_events  every inbound provider webhook (Razorpay, Shiprocket, SMS delivery reports), stored
--                 before it is processed. UNIQUE (provider, event_id) makes duplicates harmless.
-- notifications   outbound customer messages (SMS) with provider reference and delivery status.
--                 OTP codes are never stored here.
-- delivery_shipments / shipment_events
--                 external courier shipments, kept separate from internal order status. Unused until a
--                 delivery partner is configured (SHIPROCKET_ENABLED stays false).
BEGIN;

CREATE TABLE IF NOT EXISTS jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_.]{2,79}$'),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key text UNIQUE CHECK (dedupe_key IS NULL OR length(dedupe_key) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','dead')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 8 CHECK (max_attempts BETWEEN 1 AND 50),
  run_at timestamptz NOT NULL DEFAULT now(),
  locked_by text,
  locked_until timestamptz,
  last_error text CHECK (last_error IS NULL OR length(last_error) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CHECK ((status = 'running') = (locked_until IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS jobs_due_idx ON jobs (run_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS jobs_running_lease_idx ON jobs (locked_until) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS jobs_dead_idx ON jobs (updated_at DESC) WHERE status = 'dead';
CREATE INDEX IF NOT EXISTS jobs_finished_idx ON jobs (finished_at) WHERE status = 'succeeded';

CREATE TABLE IF NOT EXISTS job_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  attempt integer NOT NULL CHECK (attempt >= 1),
  worker text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  outcome text CHECK (outcome IN ('succeeded','retry','dead','lease_expired')),
  error text CHECK (error IS NULL OR length(error) <= 2000),
  UNIQUE (job_id, attempt)
);

CREATE TABLE IF NOT EXISTS outbox_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  topic text NOT NULL CHECK (topic ~ '^[a-z][a-z0-9_.]{2,79}$'),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX IF NOT EXISTS outbox_events_pending_idx ON outbox_events (id) WHERE published_at IS NULL;

CREATE TABLE IF NOT EXISTS webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider IN ('razorpay','shiprocket','smsgatewayhub')),
  event_id text NOT NULL CHECK (length(event_id) BETWEEN 1 AND 200),
  event_type text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 100),
  payload jsonb NOT NULL,
  signature_verified boolean NOT NULL,
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received','processed','ignored','failed')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text CHECK (last_error IS NULL OR length(last_error) <= 2000),
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (provider, event_id)
);
CREATE INDEX IF NOT EXISTS webhook_events_pending_idx ON webhook_events (received_at) WHERE status IN ('received','failed');

CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  order_id uuid REFERENCES orders(id) ON DELETE SET NULL,
  channel text NOT NULL CHECK (channel IN ('sms')),
  template_key text NOT NULL CHECK (template_key ~ '^[a-z][a-z0-9_]{2,59}$'),
  recipient text NOT NULL CHECK (recipient ~ '^\+91[6-9][0-9]{9}$'),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','delivered','failed','skipped')),
  provider text,
  provider_message_id text,
  attempts integer NOT NULL DEFAULT 0,
  last_error text CHECK (last_error IS NULL OR length(last_error) <= 2000),
  dedupe_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  delivered_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_order_idx ON notifications (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS notifications_provider_ref_idx ON notifications (provider, provider_message_id) WHERE provider_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS delivery_shipments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  provider text NOT NULL CHECK (provider IN ('shiprocket')),
  service_type text NOT NULL CHECK (service_type IN ('standard','hyperlocal')),
  external_order_id text,
  external_shipment_id text,
  awb_code text,
  courier_name text,
  external_status text,
  status text NOT NULL DEFAULT 'created' CHECK (status IN ('created','awb_assigned','pickup_scheduled','picked_up','in_transit','out_for_delivery','delivered','exception','rto_initiated','rto_delivered','cancelled')),
  tracking_url text CHECK (tracking_url IS NULL OR tracking_url ~ '^https://'),
  label_url text CHECK (label_url IS NULL OR label_url ~ '^https://'),
  last_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, external_shipment_id)
);
CREATE INDEX IF NOT EXISTS delivery_shipments_order_idx ON delivery_shipments (order_id);
CREATE UNIQUE INDEX IF NOT EXISTS delivery_shipments_awb_idx ON delivery_shipments (provider, awb_code) WHERE awb_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS shipment_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shipment_id uuid NOT NULL REFERENCES delivery_shipments(id) ON DELETE CASCADE,
  external_status text NOT NULL,
  status text NOT NULL,
  occurred_at timestamptz NOT NULL,
  webhook_event_id uuid REFERENCES webhook_events(id) ON DELETE SET NULL,
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shipment_id, external_status, occurred_at)
);

COMMIT;
