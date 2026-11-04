BEGIN;

-- Customer cancellation is permitted only before pickup is scheduled.
-- Keep the return record and event history; do not delete customer evidence/audit history.
ALTER TABLE order_returns DROP CONSTRAINT IF EXISTS order_returns_status_check;
ALTER TABLE order_returns
  ADD CONSTRAINT order_returns_status_check
  CHECK (status IN ('requested','accepted','rejected','pickup_scheduled','picked_up','in_transit','received','refund_pending','refunded','closed','cancelled'));

ALTER TABLE return_events DROP CONSTRAINT IF EXISTS return_events_to_status_check;
ALTER TABLE return_events
  ADD CONSTRAINT return_events_to_status_check
  CHECK (to_status IN ('requested','accepted','rejected','pickup_scheduled','picked_up','in_transit','received','refund_pending','refunded','closed','cancelled'));

CREATE INDEX IF NOT EXISTS order_returns_cancelled_created_idx
  ON order_returns(updated_at DESC) WHERE status = 'cancelled';

COMMIT;
