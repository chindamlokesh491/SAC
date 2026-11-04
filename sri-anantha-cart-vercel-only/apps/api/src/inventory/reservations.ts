import type { Pool, PoolClient } from 'pg';

export type ReservationResult = { ok: true } | { ok: false; reason: 'missing_order_items' | 'insufficient_stock' | 'already_reserved' };

type StockLine = { product_id: string; variant_id: string | null; quantity: number };

/**
 * Adjusts sellable stock for a product or one of its variants and records the movement.
 * Decrements are conditional, so stock can never go negative under concurrency.
 */
async function adjustStock(client: PoolClient, line: StockLine, delta: number, reason: string, orderId: string): Promise<boolean> {
  const result = line.variant_id
    ? await client.query(
      `UPDATE product_variants SET quantity = quantity + $2, updated_at = now()
        WHERE id = $1 AND quantity + $2 >= 0 RETURNING id`, [line.variant_id, delta])
    : await client.query(
      `UPDATE inventory SET quantity = quantity + $2, updated_at = now()
        WHERE product_id = $1 AND quantity + $2 >= 0 RETURNING product_id`, [line.product_id, delta]);
  if (result.rowCount !== 1) return false;
  await client.query(
    `INSERT INTO inventory_movements (product_id, variant_id, quantity_delta, reason, reference_id)
     VALUES ($1, $2, $3, $4, $5)`, [line.product_id, line.variant_id, delta, reason, orderId],
  );
  return true;
}

/** Reserve each order line inside the caller's transaction. Roll back the transaction on failure. */
export async function reserveOrderInventory(
  client: PoolClient,
  orderId: string,
  expiresAt: Date,
): Promise<ReservationResult> {
  const lines = await client.query<StockLine>(
    `SELECT product_id, variant_id, SUM(quantity)::integer AS quantity
       FROM order_items WHERE order_id = $1 AND product_id IS NOT NULL
      GROUP BY product_id, variant_id ORDER BY product_id, variant_id NULLS FIRST`, [orderId],
  );
  if (lines.rowCount === 0) return { ok: false, reason: 'missing_order_items' };

  const missingProducts = await client.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM order_items WHERE order_id = $1 AND product_id IS NULL', [orderId],
  );
  if (Number(missingProducts.rows[0]?.count) > 0) return { ok: false, reason: 'missing_order_items' };

  const existing = await client.query('SELECT 1 FROM order_inventory_reservations WHERE order_id = $1 LIMIT 1', [orderId]);
  if (existing.rowCount) return { ok: false, reason: 'already_reserved' };

  for (const line of lines.rows) {
    if (!(await adjustStock(client, line, -line.quantity, 'order_reservation', orderId))) return { ok: false, reason: 'insufficient_stock' };
    await client.query(
      `INSERT INTO order_inventory_reservations (order_id, product_id, variant_id, quantity, expires_at)
       VALUES ($1, $2, $3, $4, $5)`, [orderId, line.product_id, line.variant_id, line.quantity, expiresAt],
    );
  }
  return { ok: true };
}

/** Mark reservations consumed after verified payment. No stock adjustment is made here. */
export async function consumeOrderInventory(client: PoolClient, orderId: string): Promise<boolean> {
  const result = await client.query(
    `UPDATE order_inventory_reservations SET status = 'consumed', updated_at = now()
      WHERE order_id = $1 AND status = 'reserved' RETURNING id`, [orderId],
  );
  const total = await client.query('SELECT COUNT(*)::text AS count FROM order_inventory_reservations WHERE order_id = $1', [orderId]);
  return Number(total.rows[0]?.count) > 0 && result.rowCount === Number(total.rows[0]?.count);
}

/** Release only active reservations; conditional update makes repeated calls idempotent. */
export async function releaseOrderInventory(client: PoolClient, orderId: string, reason: 'payment_failed' | 'payment_expired'): Promise<{ reservations: number; units: number }> {
  const reservations = await client.query<StockLine>(
    `UPDATE order_inventory_reservations SET status = 'released', updated_at = now()
      WHERE order_id = $1 AND status = 'reserved' RETURNING product_id, variant_id, quantity`, [orderId],
  );
  for (const reservation of reservations.rows) {
    if (!(await adjustStock(client, reservation, reservation.quantity, reason, orderId))) throw new Error('INVENTORY_ROW_MISSING_DURING_RELEASE');
  }
  return { reservations: reservations.rowCount ?? 0, units: reservations.rows.reduce((sum, row) => sum + Number(row.quantity), 0) };
}


export type RestockResult = { ok: true; reservations: number; units: number } | { ok: false; reason: 'missing_reservations' | 'reservations_not_consumed' };

/** Restore consumed stock for a paid order cancelled before dispatch. The status transition
 * and stock movement are in the caller's transaction, so a retry cannot restock twice. */
export async function restockConsumedOrderInventory(client: PoolClient, orderId: string): Promise<RestockResult> {
  // Lock the individual rows first; PostgreSQL does not permit FOR UPDATE on an aggregate.
  await client.query('SELECT id FROM order_inventory_reservations WHERE order_id = $1 ORDER BY product_id, variant_id NULLS FIRST FOR UPDATE', [orderId]);
  const counts = await client.query<{ total: string; consumed: string }>(
    `SELECT COUNT(*)::text AS total,
            COUNT(*) FILTER (WHERE status = 'consumed')::text AS consumed
       FROM order_inventory_reservations WHERE order_id = $1`, [orderId],
  );
  const row = counts.rows[0];
  if (!row || Number(row.total) === 0) return { ok: false, reason: 'missing_reservations' };
  if (Number(row.total) !== Number(row.consumed)) return { ok: false, reason: 'reservations_not_consumed' };

  const reservations = await client.query<StockLine>(
    `UPDATE order_inventory_reservations SET status = 'restocked', updated_at = now()
      WHERE order_id = $1 AND status = 'consumed' RETURNING product_id, variant_id, quantity`, [orderId],
  );
  if (reservations.rowCount !== Number(row.total)) throw new Error('INVENTORY_RESTOCK_STATE_CHANGED');
  for (const reservation of reservations.rows) {
    if (!(await adjustStock(client, reservation, reservation.quantity, 'order_cancellation_restock', orderId))) throw new Error('INVENTORY_ROW_MISSING_DURING_RESTOCK');
  }
  return {
    ok: true,
    reservations: reservations.rowCount ?? 0,
    units: reservations.rows.reduce((sum, row) => sum + Number(row.quantity), 0),
  };
}

/** Batch expiry reconciliation. Each order is released atomically; safe to rerun. */
export async function reconcileExpiredInventoryReservations(pool: Pool, batchSize = 100): Promise<{ ordersReleased: number; unitsReleased: number }> {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new Error('batchSize must be between 1 and 1000');
  // For expired reservations with a known gateway order, enqueue provider-side
  // reconciliation instead of releasing stock on a local timeout alone. A delayed
  // successful payment must never become a paid order without stock.
  await pool.query(
    `INSERT INTO payment_reconciliation_jobs (payment_id, status, last_error_code)
       SELECT p.id, 'queued', 'RESERVATION_EXPIRED_REQUIRES_PROVIDER_CHECK'
         FROM payments p JOIN order_inventory_reservations r ON r.order_id = p.order_id
        WHERE r.status = 'reserved' AND r.expires_at <= now()
          AND p.status IN ('created','pending') AND p.provider_transaction_id IS NOT NULL
       GROUP BY p.id
       ON CONFLICT (payment_id) DO NOTHING`,
  );
  const candidates = await pool.query<{ order_id: string }>(
    `SELECT DISTINCT r.order_id FROM order_inventory_reservations r
      JOIN payments p ON p.order_id = r.order_id
     WHERE r.status = 'reserved' AND r.expires_at <= now() AND p.status IN ('created','pending')
       AND p.provider_transaction_id IS NULL
     ORDER BY r.order_id LIMIT $1`, [batchSize],
  );
  let ordersReleased = 0;
  let unitsReleased = 0;
  for (const candidate of candidates.rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const order = await client.query(
        `SELECT o.id FROM orders o JOIN payments p ON p.order_id = o.id
          WHERE o.id = $1 AND o.status = 'pending_payment' AND p.status IN ('created','pending')
            AND p.provider_transaction_id IS NULL
          FOR UPDATE OF o, p`, [candidate.order_id],
      );
      if (!order.rowCount) { await client.query('ROLLBACK'); continue; }
      const released = await releaseOrderInventory(client, candidate.order_id, 'payment_expired');
      if (released.reservations > 0) {
        await client.query(
          `UPDATE payments SET status = 'cancelled', updated_at = now()
            WHERE order_id = $1 AND status IN ('created','pending')`, [candidate.order_id],
        );
        await client.query(
          `UPDATE orders SET status = 'cancelled', payment_status = 'cancelled', updated_at = now()
            WHERE id = $1 AND status = 'pending_payment' AND payment_status = 'pending'`, [candidate.order_id],
        );
        unitsReleased += released.units;
        ordersReleased++;
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  return { ordersReleased, unitsReleased };
}
