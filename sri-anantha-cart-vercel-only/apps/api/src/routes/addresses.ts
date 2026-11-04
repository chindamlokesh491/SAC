import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { requireAuth } from '../auth/session.js';
import { normalizeIndianPhone } from '../auth/security.js';
import { HttpError, parseOrReply, postalCodeSchema, sendHttpError, uuidPattern, withTransaction } from '../lib/http.js';

const MAX_ADDRESSES = 20;
const optionalText = (max: number) => z.union([z.string().trim().max(max), z.null()]).optional().transform(value => (value ? value : null));
const phoneField = z.string().max(20).transform((value, ctx) => {
  const normalized = normalizeIndianPhone(value);
  if (!normalized) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter a valid mobile number' }); return z.NEVER; }
  return normalized;
});

const addressFields = {
  label: optionalText(40),
  recipient_name: z.string().trim().min(2, 'Enter the recipient name').max(100),
  phone_e164: phoneField,
  line1: z.string().trim().min(3, 'Enter house / street details').max(200),
  line2: optionalText(200),
  locality: z.string().trim().min(2, 'Enter the locality').max(120),
  city: z.string().trim().min(2).max(100).default('Tirupati'),
  state: z.string().trim().min(2).max(100).default('Andhra Pradesh'),
  postal_code: postalCodeSchema,
  delivery_instructions: optionalText(300),
  is_default: z.boolean().optional(),
};
const createSchema = z.object(addressFields).strict();
const updateSchema = z.object(addressFields).partial().strict().refine(value => Object.keys(value).length > 0, 'Nothing to update');
const columns = 'id, label, recipient_name, phone_e164, line1, line2, locality, city, state, postal_code, delivery_instructions, is_default, created_at';

export async function registerAddressRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  app.get('/api/v1/addresses', async (request, reply) => {
    const user = await requireAuth(pool, request, reply);
    if (!user) return;
    const result = await pool.query(`SELECT ${columns} FROM addresses WHERE user_id = $1 ORDER BY is_default DESC, created_at DESC`, [user.id]);
    return { data: result.rows };
  });

  app.post('/api/v1/addresses', async (request, reply) => {
    const user = await requireAuth(pool, request, reply);
    if (!user) return;
    const body = parseOrReply(createSchema, request.body, reply);
    if (!body) return;
    try {
      const address = await withTransaction(pool, async client => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`addresses:${user.id}`]);
        const count = await client.query<{ count: number }>('SELECT COUNT(*)::integer AS count FROM addresses WHERE user_id = $1', [user.id]);
        const existing = Number(count.rows[0]?.count ?? 0);
        if (existing >= MAX_ADDRESSES) throw new HttpError(409, 'ADDRESS_LIMIT', `You can save up to ${MAX_ADDRESSES} addresses`);
        const makeDefault = body.is_default === true || existing === 0;
        if (makeDefault) await client.query('UPDATE addresses SET is_default = FALSE WHERE user_id = $1 AND is_default', [user.id]);
        const result = await client.query(
          `INSERT INTO addresses(user_id, label, recipient_name, phone_e164, line1, line2, locality, city, state, postal_code, delivery_instructions, is_default)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING ${columns}`,
          [user.id, body.label, body.recipient_name, body.phone_e164, body.line1, body.line2, body.locality, body.city, body.state, body.postal_code, body.delivery_instructions, makeDefault],
        );
        return result.rows[0];
      });
      return reply.code(201).send({ data: address });
    } catch (error) {
      if (error instanceof HttpError) return sendHttpError(reply, error);
      throw error;
    }
  });

  app.patch<{ Params: { addressId: string } }>('/api/v1/addresses/:addressId', async (request, reply) => {
    const user = await requireAuth(pool, request, reply);
    if (!user) return;
    if (!uuidPattern.test(request.params.addressId)) return reply.code(400).send({ error: 'INVALID_ADDRESS_ID', message: 'Invalid address ID' });
    const body = parseOrReply(updateSchema, request.body, reply);
    if (!body) return;
    const updated = await withTransaction(pool, async client => {
      const found = await client.query('SELECT id FROM addresses WHERE id = $1 AND user_id = $2 FOR UPDATE', [request.params.addressId, user.id]);
      if (!found.rowCount) return null;
      if (body.is_default === true) await client.query('UPDATE addresses SET is_default = FALSE WHERE user_id = $1 AND is_default AND id <> $2', [user.id, request.params.addressId]);
      const values: unknown[] = [request.params.addressId, user.id];
      const assignments: string[] = [];
      for (const key of ['label', 'recipient_name', 'phone_e164', 'line1', 'line2', 'locality', 'city', 'state', 'postal_code', 'delivery_instructions', 'is_default'] as const) {
        if (body[key] === undefined) continue;
        // Only an explicit "make default" is honoured; unsetting would leave no default.
        if (key === 'is_default' && body.is_default === false) continue;
        values.push(body[key]);
        assignments.push(`${key} = $${values.length}`);
      }
      assignments.push('updated_at = now()');
      const result = await client.query(`UPDATE addresses SET ${assignments.join(', ')} WHERE id = $1 AND user_id = $2 RETURNING ${columns}`, values);
      return result.rows[0];
    });
    if (!updated) return reply.code(404).send({ error: 'ADDRESS_NOT_FOUND', message: 'Address not found' });
    return { data: updated };
  });

  app.delete<{ Params: { addressId: string } }>('/api/v1/addresses/:addressId', async (request, reply) => {
    const user = await requireAuth(pool, request, reply);
    if (!user) return;
    if (!uuidPattern.test(request.params.addressId)) return reply.code(400).send({ error: 'INVALID_ADDRESS_ID', message: 'Invalid address ID' });
    const deleted = await withTransaction(pool, async client => {
      const result = await client.query<{ is_default: boolean }>('DELETE FROM addresses WHERE id = $1 AND user_id = $2 RETURNING is_default', [request.params.addressId, user.id]);
      if (!result.rowCount) return false;
      if (result.rows[0]!.is_default) {
        await client.query(
          `UPDATE addresses SET is_default = TRUE WHERE id = (SELECT id FROM addresses WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1)`, [user.id],
        );
      }
      return true;
    });
    if (!deleted) return reply.code(404).send({ error: 'ADDRESS_NOT_FOUND', message: 'Address not found' });
    return reply.code(204).send();
  });
}
