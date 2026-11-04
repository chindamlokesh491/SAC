import test from 'node:test';
import assert from 'node:assert/strict';
import { restockConsumedOrderInventory } from '../src/inventory/reservations.js';

type QueryCall = { sql: string; values: unknown[] };
function fakeClient(total: number, consumed: number) {
  const calls: QueryCall[] = [];
  const client = {
    async query(sql: string, values: unknown[] = []) {
      calls.push({ sql, values });
      if (sql.includes('SELECT COUNT(*)::text AS total')) {
        return { rows: [{ total: String(total), consumed: String(consumed) }], rowCount: 1 };
      }
      if (sql.includes('UPDATE order_inventory_reservations')) {
        const rows = Array.from({ length: total }, (_, index) => ({ product_id: `product-${index + 1}`, quantity: index + 1 }));
        return { rows, rowCount: rows.length };
      }
      if (sql.includes('UPDATE inventory')) return { rows: [{ product_id: values[0] }], rowCount: 1 };
      if (sql.includes('SELECT id FROM order_inventory_reservations')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    },
  };
  return { client, calls };
}

test('restocks consumed reservations and records one inventory movement per reservation', async () => {
  const { client, calls } = fakeClient(2, 2);
  const result = await restockConsumedOrderInventory(client as never, 'order-1');
  assert.deepEqual(result, { ok: true, reservations: 2, units: 3 });
  assert.equal(calls.filter(call => call.sql.includes('UPDATE inventory')).length, 2);
  assert.equal(calls.filter(call => call.sql.includes('INSERT INTO inventory_movements')).length, 2);
  assert.ok(calls.some(call => call.sql.includes("status = 'restocked'")));
});

test('does not change inventory when there are no reservations', async () => {
  const { client, calls } = fakeClient(0, 0);
  const result = await restockConsumedOrderInventory(client as never, 'order-1');
  assert.deepEqual(result, { ok: false, reason: 'missing_reservations' });
  assert.equal(calls.filter(call => call.sql.includes('UPDATE inventory')).length, 0);
});

test('does not partially restock if reservations are not all consumed', async () => {
  const { client, calls } = fakeClient(2, 1);
  const result = await restockConsumedOrderInventory(client as never, 'order-1');
  assert.deepEqual(result, { ok: false, reason: 'reservations_not_consumed' });
  assert.equal(calls.filter(call => call.sql.includes('UPDATE inventory')).length, 0);
  assert.equal(calls.filter(call => call.sql.includes('UPDATE order_inventory_reservations')).length, 0);
});
