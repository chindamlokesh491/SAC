-- Admin audit-log viewer: look up the trail of one order, refund or user by resource ID.
-- (001 indexed admin_audit_logs by time only.) Index-only change; the table stays append-only (021).
BEGIN;
CREATE INDEX IF NOT EXISTS admin_audit_resource_idx ON admin_audit_logs (resource_id, created_at DESC) WHERE resource_id IS NOT NULL;
COMMIT;
