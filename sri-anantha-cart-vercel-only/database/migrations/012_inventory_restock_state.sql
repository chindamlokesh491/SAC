BEGIN;

-- A consumed reservation may be restored once when an order is cancelled before dispatch.
-- Distinguish that operation from payment-failure release so repeated cancellation requests
-- cannot increment sellable inventory twice.
ALTER TABLE order_inventory_reservations
  DROP CONSTRAINT IF EXISTS order_inventory_reservations_status_check;
ALTER TABLE order_inventory_reservations
  ADD CONSTRAINT order_inventory_reservations_status_check
  CHECK (status IN ('reserved', 'consumed', 'released', 'restocked')) NOT VALID;
ALTER TABLE order_inventory_reservations
  VALIDATE CONSTRAINT order_inventory_reservations_status_check;

COMMIT;
