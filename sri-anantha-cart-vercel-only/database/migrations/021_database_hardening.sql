-- Database-level protections that hold even if application code is bypassed.
BEGIN;

-- Only the owner (the application) may connect or create objects; nobody else on the server.
-- Not on Supabase: its own services (Auth, Storage, Data API, connection pooler) log in through
-- PUBLIC's CONNECT privilege, so revoking it would take them down. There, access is limited by the
-- platform's network and password controls plus migration 024 (no table privileges for API roles, RLS).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN
    EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  END IF;
END $$;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- The admin audit log is append-only: entries can never be edited or deleted.
-- (The one allowed change is clearing actor_user_id if a user row is ever removed.)
CREATE OR REPLACE FUNCTION protect_audit_log() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.actor_user_id IS NULL AND OLD.actor_user_id IS NOT NULL
     AND (NEW.id, NEW.action, NEW.resource_type, NEW.resource_id, NEW.metadata, NEW.created_at)
         IS NOT DISTINCT FROM (OLD.id, OLD.action, OLD.resource_type, OLD.resource_id, OLD.metadata, OLD.created_at) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'The admin audit log is append-only' USING ERRCODE = 'insufficient_privilege';
END;
$$;
DROP TRIGGER IF EXISTS admin_audit_logs_append_only ON admin_audit_logs;
CREATE TRIGGER admin_audit_logs_append_only BEFORE UPDATE OR DELETE ON admin_audit_logs
  FOR EACH ROW EXECUTE FUNCTION protect_audit_log();

-- Order history keeps its money fields: once an order exists its amounts cannot be rewritten.
CREATE OR REPLACE FUNCTION protect_order_amounts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.subtotal_paise, NEW.delivery_fee_paise, NEW.tax_paise, NEW.discount_paise, NEW.total_paise, NEW.user_id)
     IS DISTINCT FROM (OLD.subtotal_paise, OLD.delivery_fee_paise, OLD.tax_paise, OLD.discount_paise, OLD.total_paise, OLD.user_id) THEN
    RAISE EXCEPTION 'Order amounts and owner cannot be changed after the order is placed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS orders_amounts_immutable ON orders;
CREATE TRIGGER orders_amounts_immutable BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION protect_order_amounts();

CREATE OR REPLACE FUNCTION protect_order_items() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Allowed only as part of deleting the whole order (never done by the application).
    IF EXISTS (SELECT 1 FROM orders WHERE id = OLD.order_id) THEN
      RAISE EXCEPTION 'Order lines cannot be removed from an existing order' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;
  -- Deleting a product clears its link (product_id / variant_id); the snapshot itself never changes.
  IF (NEW.order_id, NEW.product_name_snapshot, NEW.unit_price_paise, NEW.quantity, NEW.line_total_paise, NEW.tax_paise)
     IS DISTINCT FROM (OLD.order_id, OLD.product_name_snapshot, OLD.unit_price_paise, OLD.quantity, OLD.line_total_paise, OLD.tax_paise) THEN
    RAISE EXCEPTION 'Order lines cannot be changed after the order is placed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS order_items_immutable ON order_items;
CREATE TRIGGER order_items_immutable BEFORE UPDATE OR DELETE ON order_items FOR EACH ROW EXECUTE FUNCTION protect_order_items();
COMMIT;
