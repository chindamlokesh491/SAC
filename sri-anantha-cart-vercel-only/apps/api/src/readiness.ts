import type { Pool } from 'pg';

/** Required schema objects; a partially migrated database must not receive traffic. */
export const REQUIRED_TABLES = ['users', 'auth_sessions', 'otp_challenges', 'addresses', 'carts', 'orders', 'payments', 'order_inventory_reservations',
  'payment_reconciliation_jobs', 'product_images', 'product_variants', 'delivery_time_slots', 'refunds', 'delivery_zones', 'store_settings',
  'wishlist_items', 'order_status_history', 'media_assets', 'newsletter_subscribers', 'product_sales_summary', 'product_sales_daily', 'jobs', 'job_attempts', 'outbox_events', 'webhook_events', 'notifications', 'delivery_assignment_events', 'delivery_issues', 'delivery_notifications_outbox'];

export const REQUIRED_COLUMNS: [string, string][] = [['orders', 'idempotency_key'], ['orders', 'checkout_email'], ['orders', 'delivery_mode'], ['orders', 'tax_paise'],
  ['refunds', 'idempotency_key'], ['refunds', 'provider_token'], ['refunds', 'method'], ['payments', 'expires_at'], ['payment_reconciliation_jobs', 'lease_token'],
  ['products', 'gst_rate_basis_points'], ['products', 'minimum_stock_level'], ['products', 'highlights'], ['cart_items', 'variant_id'], ['delivery_zones', 'cod_enabled'],
  ['users', 'google_sub'], ['addresses', 'is_default'],
  ['users', 'password_hash'], ['users', 'must_change_password'], ['categories', 'is_featured'], ['users', 'staff_removed_at'], ['users', 'delivery_partner_code'], ['users', 'delivery_partner_online'], ['delivery_assignments', 'accepted_at'], ['delivery_assignments', 'picked_up_at'], ['delivery_assignments', 'out_for_delivery_at'], ['delivery_assignments', 'otp_verified_at'], ['delivery_assignments', 'delivered_at'], ['orders', 'delivery_exception'], ['orders', 'picked_up_at'], ['orders', 'out_for_delivery_at']];

export async function missingSchemaObjects(pool: Pool) {
  const tables = await pool.query<{ name: string }>(
    `SELECT unnest($1::text[]) AS name EXCEPT SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()`, [REQUIRED_TABLES],
  );
  const columns = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT t.table_name, t.column_name FROM unnest($1::text[], $2::text[]) AS t(table_name, column_name)
      WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema = current_schema() AND c.table_name = t.table_name AND c.column_name = t.column_name)`,
    [REQUIRED_COLUMNS.map(([table]) => table), REQUIRED_COLUMNS.map(([, column]) => column)],
  );
  return { tables: tables.rows.map(row => row.name), columns: columns.rows.map(row => `${row.table_name}.${row.column_name}`) };
}
