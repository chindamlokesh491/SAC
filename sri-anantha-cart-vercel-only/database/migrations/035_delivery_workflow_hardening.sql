-- Phase 1 delivery workflow hardening. Append-only: 032-034 are left byte-identical because
-- whether they were applied to any shared database has not been confirmed yet.
--
-- 1. Pin search_path on the two functions created by 032 (same rule as 027).
-- 2. Customer delivery OTP: 10-minute codes (decision 2026-11-03) with a bounded number of sends.
-- 3. Partners may reject an assignment before pickup; record when and why.
-- 4. New assignment event types: rejected, otp_sent.
BEGIN;

DO $migration$
DECLARE
  target_schema name := current_schema();
  routine record;
BEGIN
  IF target_schema IS NULL THEN
    RAISE EXCEPTION 'Cannot determine the current schema for delivery function hardening';
  END IF;
  FOR routine IN
    SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS identity_arguments
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = target_schema
       AND p.prokind = 'f'
       AND p.proname IN ('sac_next_delivery_partner_code', 'sac_assign_delivery_partner_code')
  LOOP
    EXECUTE format('ALTER FUNCTION %I.%I(%s) SET search_path = %I, pg_temp',
      target_schema, routine.proname, routine.identity_arguments, target_schema);
  END LOOP;
END
$migration$;

-- Every send (initial and resend) replaces the hash, so only the latest code can verify.
ALTER TABLE order_delivery_verifications
  ADD COLUMN IF NOT EXISTS send_count INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS last_sent_at TIMESTAMPTZ;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_delivery_verifications_send_count_check') THEN
    ALTER TABLE order_delivery_verifications
      ADD CONSTRAINT order_delivery_verifications_send_count_check CHECK (send_count BETWEEN 1 AND 20);
  END IF;
END $$;
UPDATE order_delivery_verifications SET last_sent_at = COALESCE(last_sent_at, updated_at);

ALTER TABLE delivery_assignments
  ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'delivery_assignments_rejection_reason_check') THEN
    ALTER TABLE delivery_assignments ADD CONSTRAINT delivery_assignments_rejection_reason_check
      CHECK (rejection_reason IS NULL OR rejection_reason IN ('vehicle_unavailable','too_far','shift_ending','personal_emergency','other'));
  END IF;
END $$;

ALTER TABLE delivery_assignment_events DROP CONSTRAINT IF EXISTS delivery_assignment_events_event_check;
ALTER TABLE delivery_assignment_events ADD CONSTRAINT delivery_assignment_events_event_check
  CHECK (event IN ('assigned','accepted','rejected','picked_up','out_for_delivery','otp_sent','otp_failed','otp_verified','cod_collected','delivered','issue_reported','cancelled'));

COMMIT;
