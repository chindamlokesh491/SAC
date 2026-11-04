import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;

test('PostgreSQL inventory reservations are atomic and release/consume idempotently', {
  skip: !databaseUrl ? 'Set TEST_DATABASE_URL to a disposable PostgreSQL database to run integration tests' : false,
}, async () => {
  if (!databaseUrl) return;

  // Load database-only dependencies inside the test body. This lets the unit-test
  // suite run in minimal environments without pg installed; CI still executes the
  // integration test because it provides TEST_DATABASE_URL and installs workspace deps.
  const [{ default: pg }, { consumeOrderInventory, releaseOrderInventory, reserveOrderInventory }, { issueOtpChallenge }] = await Promise.all([
    import('pg'),
    import('../src/inventory/reservations.js'),
    import('../src/auth/otp-challenges.js'),
  ]);
  const { Pool: PgPool } = pg;
  const schema = `sac_test_${randomUUID().replaceAll('-', '')}`;
  const admin: Pool = new PgPool({ connectionString: databaseUrl, max: 2 });
  let isolated: Pool | undefined;

  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    isolated = new PgPool({
      connectionString: databaseUrl,
      max: 8,
      options: `-c search_path=${schema},public`,
    });

    const migrationDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../database/migrations');
    const migrations = (await readdir(migrationDir))
      .filter(file => /^\d{3}_.+\.sql$/.test(file))
      .sort();
    assert.ok(migrations.length >= 7, 'expected all seven numbered migrations');
    for (const migration of migrations) {
      await isolated.query(await readFile(join(migrationDir, migration), 'utf8'));
    }

    // Concurrent OTP requests for the same phone must serialize: exactly one
    // challenge is created and the competing request observes the resend cooldown.
    const otpPhone = `+1${String(Date.now()).slice(-10)}`;
    const otpResults = await Promise.all([
      issueOtpChallenge(isolated, otpPhone, 'a'.repeat(64), 300, 60),
      issueOtpChallenge(isolated, otpPhone, 'b'.repeat(64), 300, 60),
    ]);
    assert.equal(otpResults.filter(result => result.kind === 'created').length, 1,
      'only one concurrent OTP request should create a challenge');
    assert.equal(otpResults.filter(result => result.kind === 'cooldown').length, 1,
      'the competing OTP request should be rate limited by the phone cooldown');
    const activeOtpChallenges = await isolated.query(
      `SELECT id FROM otp_challenges WHERE phone_e164 = $1 AND consumed_at IS NULL`, [otpPhone],
    );
    assert.equal(activeOtpChallenges.rowCount, 1, 'there must be exactly one active OTP challenge per concurrent issuance race');

    const product = await isolated.query<{ id: string }>(
      `SELECT id FROM products WHERE sku = 'SAMPLE-DIYA-001' LIMIT 1`,
    );
    assert.ok(product.rows[0], 'development fixture product must exist in the isolated test schema');
    const productId = product.rows[0].id;
    await isolated.query('UPDATE inventory SET quantity = 1 WHERE product_id = $1', [productId]);

    const user = await isolated.query<{ id: string }>(
      `INSERT INTO users (phone_e164, display_name) VALUES ($1, 'Inventory Test') RETURNING id`,
      [`+1${String(Date.now()).slice(-10)}`],
    );
    const userId = user.rows[0]!.id;

    async function createOrder(key: string): Promise<string> {
      const result = await isolated!.query<{ id: string }>(
        `INSERT INTO orders (user_id, idempotency_key, subtotal_paise, delivery_fee_paise, total_paise, delivery_address_snapshot)
         VALUES ($1, $2, 2500, 0, 2500, '{}'::jsonb) RETURNING id`, [userId, key],
      );
      const orderId = result.rows[0]!.id;
      await isolated!.query(
        `INSERT INTO order_items (order_id, product_id, product_name_snapshot, sku_snapshot, unit_price_paise, quantity, line_total_paise)
         VALUES ($1, $2, 'Sample Clay Diya', 'SAMPLE-DIYA-001', 2500, 1, 2500)`, [orderId, productId],
      );
      return orderId;
    }

    const [orderA, orderB] = await Promise.all([createOrder('inventory-test-a'), createOrder('inventory-test-b')]);
    const expiry = new Date(Date.now() + 60_000);

    async function reserveInTransaction(orderId: string) {
      const client: PoolClient = await isolated!.connect();
      try {
        await client.query('BEGIN');
        const result = await reserveOrderInventory(client, orderId, expiry);
        if (result.ok) await client.query('COMMIT');
        else await client.query('ROLLBACK');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    }

    const reservationResults = await Promise.all([reserveInTransaction(orderA), reserveInTransaction(orderB)]);
    assert.equal(reservationResults.filter(result => result.ok).length, 1, 'only one order can reserve the single available unit');
    assert.equal(reservationResults.filter(result => !result.ok && result.reason === 'insufficient_stock').length, 1);
    const stockAfterRace = await isolated.query<{ quantity: number }>('SELECT quantity FROM inventory WHERE product_id = $1', [productId]);
    assert.equal(Number(stockAfterRace.rows[0]?.quantity), 0, 'stock must never become negative or be double-reserved');

    const winningOrder = reservationResults[0]!.ok ? orderA : orderB;
    const client = await isolated.connect();
    try {
      await client.query('BEGIN');
      const firstRelease = await releaseOrderInventory(client, winningOrder, 'payment_failed');
      const secondRelease = await releaseOrderInventory(client, winningOrder, 'payment_failed');
      assert.equal(firstRelease.units, 1);
      assert.equal(secondRelease.units, 0, 'a repeated release must not restore stock twice');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    const orderForConsume = winningOrder === orderA ? orderB : orderA;
    const reserveAgain = await reserveInTransaction(orderForConsume);
    assert.equal(reserveAgain.ok, true, 'released stock should be available for a later order');
    const consumeClient = await isolated.connect();
    try {
      await consumeClient.query('BEGIN');
      assert.equal(await consumeOrderInventory(consumeClient, orderForConsume), true);
      assert.equal(await consumeOrderInventory(consumeClient, orderForConsume), false, 'a consumed reservation must not be consumed twice');
      await consumeClient.query('COMMIT');
    } catch (error) {
      await consumeClient.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      consumeClient.release();
    }

    const finalStock = await isolated.query<{ quantity: number }>('SELECT quantity FROM inventory WHERE product_id = $1', [productId]);
    assert.equal(Number(finalStock.rows[0]?.quantity), 0, 'consumption must not restore sellable stock');

    // A multi-line order must roll back earlier stock decrements if a later line
    // cannot be reserved. This verifies the caller's transaction contract, not just
    // the helper's return value.
    const secondProduct = await isolated.query<{ id: string }>(
      `SELECT id FROM products WHERE sku = 'SAMPLE-INCENSE-001' LIMIT 1`,
    );
    assert.ok(secondProduct.rows[0], 'second development fixture product must exist');
    const orderedProductIds = [productId, secondProduct.rows[0].id].sort();
    const availableProductId = orderedProductIds[0]!;
    const unavailableProductId = orderedProductIds[1]!;
    await isolated.query('UPDATE inventory SET quantity = 1 WHERE product_id = $1', [availableProductId]);
    await isolated.query('UPDATE inventory SET quantity = 0 WHERE product_id = $1', [unavailableProductId]);
    const partialOrderResult = await isolated.query<{ id: string }>(
      `INSERT INTO orders (user_id, idempotency_key, subtotal_paise, delivery_fee_paise, total_paise, delivery_address_snapshot)
       VALUES ($1, 'inventory-test-partial-rollback', 6000, 0, 6000, '{}'::jsonb) RETURNING id`, [userId],
    );
    const partialOrder = partialOrderResult.rows[0]!.id;
    await isolated.query(
      `INSERT INTO order_items (order_id, product_id, product_name_snapshot, sku_snapshot, unit_price_paise, quantity, line_total_paise)
       VALUES ($1, $2, 'Available First', 'SAMPLE-FIRST', 2500, 1, 2500),
              ($1, $3, 'Unavailable Second', 'SAMPLE-SECOND', 3500, 1, 3500)`,
      [partialOrder, availableProductId, unavailableProductId],
    );
    const partialClient = await isolated.connect();
    try {
      await partialClient.query('BEGIN');
      const partialResult = await reserveOrderInventory(partialClient, partialOrder, expiry);
      assert.deepEqual(partialResult, { ok: false, reason: 'insufficient_stock' });
      await partialClient.query('ROLLBACK');
    } finally {
      partialClient.release();
    }
    const rolledBackStock = await isolated.query<{ product_id: string; quantity: number }>(
      `SELECT product_id, quantity FROM inventory WHERE product_id = ANY($1::uuid[]) ORDER BY product_id`,
      [[productId, secondProduct.rows[0].id]],
    );
    assert.equal(rolledBackStock.rows.reduce((sum, row) => sum + Number(row.quantity), 0), 1,
      'failed multi-line reservation must restore earlier decrements through transaction rollback');
    const partialReservations = await isolated.query(
      `SELECT 1 FROM order_inventory_reservations WHERE order_id = $1`, [partialOrder],
    );
    assert.equal(partialReservations.rowCount, 0, 'failed multi-line reservation must not leave partial reservation rows');
  } finally {
    await isolated?.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    await admin.end();
  }
});
