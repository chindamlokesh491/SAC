import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { requireRole } from '../../auth/session.js';
import { audit } from '../../lib/http.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function registerAdminDeliveryRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  // Delivery partner issue queue: operators can review; only admins can resolve or request reassignment.
  app.get('/api/v1/admin/delivery-issues', async (request, reply) => {
    const user = await requireRole(pool, request, reply, ['admin', 'operator']);
    if (!user) return;
    const query = z.object({ status: z.enum(['open', 'admin_review', 'resolved', 'reassignment_required']).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'INVALID_DELIVERY_ISSUE_FILTER' });
    const values: unknown[] = [];
    const filter = query.data.status ? (values.push(query.data.status), 'WHERE i.status = $1') : '';
    values.push(query.data.limit);
    const rows = await pool.query(
      `SELECT i.id, i.order_id, o.order_number, i.assignment_id, i.delivery_person_id,
              p.display_name AS partner_name, p.phone_e164 AS partner_phone,
              i.reason, i.description, i.status, i.resolution_note, i.created_at, i.updated_at
         FROM delivery_issues i JOIN orders o ON o.id = i.order_id JOIN users p ON p.id = i.delivery_person_id
         ${filter} ORDER BY CASE i.status WHEN 'open' THEN 0 WHEN 'admin_review' THEN 1 ELSE 2 END, i.created_at DESC
         LIMIT $${values.length}`, values,
    );
    return { data: rows.rows };
  });

  app.patch<{ Params: { issueId: string } }>('/api/v1/admin/delivery-issues/:issueId', async (request, reply) => {
    const user = await requireRole(pool, request, reply, ['admin']);
    if (!user) return;
    if (!uuid.test(request.params.issueId)) return reply.code(400).send({ error: 'INVALID_DELIVERY_ISSUE_ID' });
    const body = z.object({ status: z.enum(['admin_review', 'resolved', 'reassignment_required']), resolution_note: z.string().trim().max(1000).optional() }).strict().safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'INVALID_DELIVERY_ISSUE_UPDATE' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const updated = await client.query(
        `UPDATE delivery_issues SET status = $2, resolution_note = $3,
                resolved_by = CASE WHEN $2 = 'resolved' THEN $4 ELSE resolved_by END,
                resolved_at = CASE WHEN $2 = 'resolved' THEN now() ELSE NULL END, updated_at = now()
          WHERE id = $1 RETURNING id, order_id, assignment_id, status, resolution_note, resolved_at`,
        [request.params.issueId, body.data.status, body.data.resolution_note ?? null, user.id],
      );
      if (!updated.rows[0]) { await client.query('ROLLBACK'); return reply.code(404).send({ error: 'DELIVERY_ISSUE_NOT_FOUND' }); }
      const exception = body.data.status === 'resolved' ? null : body.data.status === 'reassignment_required' ? 'reassignment_required' : 'admin_review';
      await client.query('UPDATE orders SET delivery_exception = $2, updated_at = now() WHERE id = $1', [updated.rows[0].order_id, exception]);
      await audit(client, user.id, 'delivery_issue.updated', 'delivery_issue', request.params.issueId, { status: body.data.status, order_id: updated.rows[0].order_id });
      await client.query('COMMIT');
      return { data: updated.rows[0] };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  });
  app.get('/api/v1/admin/delivery-zones', async (request, reply) => {
    const user = await requireRole(pool, request, reply, ['admin', 'operator']);
    if (!user) return;
    const result = await pool.query(`SELECT id, name, postal_codes, delivery_fee_paise, minimum_order_paise, estimated_minutes, cod_enabled, cod_limit_paise, is_active, created_at FROM delivery_zones ORDER BY name`);
    return { data: result.rows };
  });

  app.post<{ Body: { name: string; postal_codes: string[]; delivery_fee_paise: number; minimum_order_paise?: number; estimated_minutes: number; cod_enabled?: boolean; cod_limit_paise?: number; is_active?: boolean } }>('/api/v1/admin/delivery-zones', async (request, reply) => {
    const user = await requireRole(pool, request, reply, ['admin']);
    if (!user) return;
    const body = request.body;
    const zoneCreateFields = ['name', 'postal_codes', 'delivery_fee_paise', 'minimum_order_paise', 'estimated_minutes', 'cod_enabled', 'cod_limit_paise', 'is_active'];
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !zoneCreateFields.includes(key))) {
      return reply.code(400).send({ error: 'UNKNOWN_DELIVERY_ZONE_CREATE_FIELD' });
    }
    if (typeof body.name !== 'string' || body.name.trim().length < 2 || body.name.trim().length > 120 || !Array.isArray(body.postal_codes) || body.postal_codes.length < 1 || body.postal_codes.length > 200 || !body.postal_codes.every((code) => typeof code === 'string' && /^[0-9]{6}$/.test(code)) || !Number.isSafeInteger(body.delivery_fee_paise) || body.delivery_fee_paise < 0 || !Number.isSafeInteger(body.minimum_order_paise ?? 0) || (body.minimum_order_paise ?? 0) < 0 || !Number.isInteger(body.estimated_minutes) || body.estimated_minutes < 1 || body.estimated_minutes > 240 || (body.is_active !== undefined && typeof body.is_active !== 'boolean') || (body.cod_enabled !== undefined && typeof body.cod_enabled !== 'boolean') || !Number.isSafeInteger(body.cod_limit_paise ?? 0) || (body.cod_limit_paise ?? 0) < 0) {
      return reply.code(400).send({ error: 'INVALID_DELIVERY_ZONE' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(`INSERT INTO delivery_zones (name, postal_codes, delivery_fee_paise, minimum_order_paise, estimated_minutes, cod_enabled, cod_limit_paise, is_active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, name, postal_codes, delivery_fee_paise, minimum_order_paise, estimated_minutes, cod_enabled, cod_limit_paise, is_active`, [body.name.trim(), [...new Set(body.postal_codes)], body.delivery_fee_paise, body.minimum_order_paise ?? 0, body.estimated_minutes, body.cod_enabled ?? false, body.cod_limit_paise ?? 0, body.is_active ?? false]);
      const zone = result.rows[0];
      await audit(client, user.id, 'delivery_zone.created', 'delivery_zone', zone.id, { name: zone.name, active: zone.is_active });
      await client.query('COMMIT');
      return reply.code(201).send({ data: zone });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  });

  app.patch<{ Params: { zoneId: string }; Body: { name?: string; postal_codes?: string[]; delivery_fee_paise?: number; minimum_order_paise?: number; estimated_minutes?: number; cod_enabled?: boolean; cod_limit_paise?: number; is_active?: boolean } }>('/api/v1/admin/delivery-zones/:zoneId', async (request, reply) => {
    const user = await requireRole(pool, request, reply, ['admin']);
    if (!user) return;
    const { zoneId } = request.params;
    const body = request.body ?? {};
    if (!uuid.test(zoneId) || Object.keys(body).length === 0) return reply.code(400).send({ error: 'INVALID_DELIVERY_ZONE_UPDATE' });
    const zoneUpdateFields = ['name', 'postal_codes', 'delivery_fee_paise', 'minimum_order_paise', 'estimated_minutes', 'cod_enabled', 'cod_limit_paise', 'is_active'];
    if (Object.keys(body).some((key) => !zoneUpdateFields.includes(key))) return reply.code(400).send({ error: 'UNKNOWN_DELIVERY_ZONE_UPDATE_FIELD' });
    if (body.name !== undefined && (typeof body.name !== 'string' || body.name.trim().length < 2 || body.name.trim().length > 120)) return reply.code(400).send({ error: 'INVALID_ZONE_NAME' });
    if (body.postal_codes !== undefined && (!Array.isArray(body.postal_codes) || body.postal_codes.length > 200 || !body.postal_codes.every((code) => typeof code === 'string' && /^[0-9]{6}$/.test(code)))) return reply.code(400).send({ error: 'INVALID_ZONE_POSTAL_CODES' });
    if (body.delivery_fee_paise !== undefined && (!Number.isSafeInteger(body.delivery_fee_paise) || body.delivery_fee_paise < 0)) return reply.code(400).send({ error: 'INVALID_DELIVERY_FEE' });
    if (body.minimum_order_paise !== undefined && (!Number.isSafeInteger(body.minimum_order_paise) || body.minimum_order_paise < 0)) return reply.code(400).send({ error: 'INVALID_MINIMUM_ORDER' });
    if (body.estimated_minutes !== undefined && (!Number.isInteger(body.estimated_minutes) || body.estimated_minutes < 1 || body.estimated_minutes > 240)) return reply.code(400).send({ error: 'INVALID_ESTIMATED_MINUTES' });
    if (body.is_active !== undefined && typeof body.is_active !== 'boolean') return reply.code(400).send({ error: 'INVALID_ACTIVE_FLAG' });
    if (body.cod_enabled !== undefined && typeof body.cod_enabled !== 'boolean') return reply.code(400).send({ error: 'INVALID_COD_FLAG' });
    if (body.cod_limit_paise !== undefined && (!Number.isSafeInteger(body.cod_limit_paise) || body.cod_limit_paise < 0)) return reply.code(400).send({ error: 'INVALID_COD_LIMIT' });
    const columns = ['name', 'postal_codes', 'delivery_fee_paise', 'minimum_order_paise', 'estimated_minutes', 'cod_enabled', 'cod_limit_paise', 'is_active'] as const;
    const values: unknown[] = [zoneId];
    const assignments: string[] = [];
    for (const key of columns) {
      if (body[key] === undefined) continue;
      values.push(key === 'name' ? (body.name as string).trim() : key === 'postal_codes' ? [...new Set(body.postal_codes)] : body[key]);
      assignments.push(`${key} = $${values.length}`);
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(`UPDATE delivery_zones SET ${assignments.join(', ')} WHERE id = $1 RETURNING id, name, postal_codes, delivery_fee_paise, minimum_order_paise, estimated_minutes, cod_enabled, cod_limit_paise, is_active`, values);
      if (!result.rows[0]) { await client.query('ROLLBACK'); return reply.code(404).send({ error: 'DELIVERY_ZONE_NOT_FOUND' }); }
      await audit(client, user.id, 'delivery_zone.updated', 'delivery_zone', zoneId, { fields: Object.keys(body) });
      await client.query('COMMIT');
      return { data: result.rows[0] };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  });


  // Scheduled delivery windows and tax reporting from the detailed Phase 1 scope.
  app.get<{ Querystring: { zone_id?: string } }>('/api/v1/admin/delivery-slots', async (request, reply) => {
    const user = await requireRole(pool, request, reply, ['admin', 'operator']);
    if (!user) return;
    if (request.query.zone_id && !uuid.test(request.query.zone_id)) return reply.code(400).send({ error: 'INVALID_ZONE_ID' });
    const values: unknown[] = [];
    const where = request.query.zone_id ? `WHERE s.zone_id = $1 OR s.zone_id IS NULL` : '';
    if (request.query.zone_id) values.push(request.query.zone_id);
    const result = await pool.query(`SELECT s.id, s.zone_id, z.name AS zone_name, s.name, s.starts_at, s.ends_at, s.is_scheduled, s.is_active FROM delivery_time_slots s LEFT JOIN delivery_zones z ON z.id = s.zone_id ${where} ORDER BY s.starts_at, s.name`, values);
    return { data: result.rows };
  });

  app.post<{ Body: { zone_id?: string | null; name: string; starts_at: string; ends_at: string; is_scheduled?: boolean; is_active?: boolean } }>('/api/v1/admin/delivery-slots', async (request, reply) => {
    const user = await requireRole(pool, request, reply, ['admin']);
    if (!user) return;
    const body = request.body;
    const allowed = ['zone_id', 'name', 'starts_at', 'ends_at', 'is_scheduled', 'is_active'];
    const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !allowed.includes(key))) return reply.code(400).send({ error: 'UNKNOWN_DELIVERY_SLOT_FIELD' });
    if (typeof body.name !== 'string' || body.name.trim().length < 2 || body.name.trim().length > 80 || !timePattern.test(body.starts_at) || !timePattern.test(body.ends_at) || body.ends_at <= body.starts_at || (body.zone_id != null && !uuid.test(body.zone_id)) || (body.is_scheduled !== undefined && typeof body.is_scheduled !== 'boolean') || (body.is_active !== undefined && typeof body.is_active !== 'boolean')) return reply.code(400).send({ error: 'INVALID_DELIVERY_SLOT' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (body.zone_id) {
        const zone = await client.query('SELECT id FROM delivery_zones WHERE id = $1', [body.zone_id]);
        if (!zone.rows[0]) { await client.query('ROLLBACK'); return reply.code(400).send({ error: 'DELIVERY_ZONE_NOT_FOUND' }); }
      }
      const result = await client.query(`INSERT INTO delivery_time_slots (zone_id, name, starts_at, ends_at, is_scheduled, is_active) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, zone_id, name, starts_at, ends_at, is_scheduled, is_active`, [body.zone_id ?? null, body.name.trim(), body.starts_at, body.ends_at, body.is_scheduled ?? true, body.is_active ?? false]);
      await audit(client, user.id, 'delivery_slot.created', 'delivery_time_slot', result.rows[0].id, { name: body.name.trim(), zone_id: body.zone_id ?? null });
      await client.query('COMMIT');
      return reply.code(201).send({ data: result.rows[0] });
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  });

  app.patch<{ Params: { slotId: string }; Body: { name?: string; starts_at?: string; ends_at?: string; is_scheduled?: boolean; is_active?: boolean } }>('/api/v1/admin/delivery-slots/:slotId', async (request, reply) => {
    const user = await requireRole(pool, request, reply, ['admin']);
    if (!user) return;
    const { slotId } = request.params;
    const body = request.body ?? {};
    const allowed = ['name', 'starts_at', 'ends_at', 'is_scheduled', 'is_active'];
    const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;
    if (!uuid.test(slotId) || Object.keys(body).length === 0 || Object.keys(body).some((key) => !allowed.includes(key))) return reply.code(400).send({ error: 'INVALID_DELIVERY_SLOT_UPDATE' });
    if (body.name !== undefined && (typeof body.name !== 'string' || body.name.trim().length < 2 || body.name.trim().length > 80)) return reply.code(400).send({ error: 'INVALID_DELIVERY_SLOT_NAME' });
    if (body.starts_at !== undefined && !timePattern.test(body.starts_at)) return reply.code(400).send({ error: 'INVALID_DELIVERY_SLOT_START' });
    if (body.ends_at !== undefined && !timePattern.test(body.ends_at)) return reply.code(400).send({ error: 'INVALID_DELIVERY_SLOT_END' });
    if (body.is_scheduled !== undefined && typeof body.is_scheduled !== 'boolean') return reply.code(400).send({ error: 'INVALID_DELIVERY_SLOT_MODE' });
    if (body.is_active !== undefined && typeof body.is_active !== 'boolean') return reply.code(400).send({ error: 'INVALID_DELIVERY_SLOT_ACTIVE' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query<{ starts_at: string; ends_at: string }>('SELECT starts_at::text, ends_at::text FROM delivery_time_slots WHERE id = $1 FOR UPDATE', [slotId]);
      if (!current.rows[0]) { await client.query('ROLLBACK'); return reply.code(404).send({ error: 'DELIVERY_SLOT_NOT_FOUND' }); }
      const starts = body.starts_at ?? current.rows[0].starts_at;
      const ends = body.ends_at ?? current.rows[0].ends_at;
      if (ends <= starts) { await client.query('ROLLBACK'); return reply.code(400).send({ error: 'INVALID_DELIVERY_SLOT_RANGE' }); }
      const values: unknown[] = [slotId];
      const assignments: string[] = [];
      for (const key of ['name', 'starts_at', 'ends_at', 'is_scheduled', 'is_active'] as const) {
        if (body[key] === undefined) continue;
        values.push(key === 'name' ? body.name!.trim() : body[key]);
        assignments.push(`${key} = $${values.length}`);
      }
      const result = await client.query(`UPDATE delivery_time_slots SET ${assignments.join(', ')} WHERE id = $1 RETURNING id, zone_id, name, starts_at, ends_at, is_scheduled, is_active`, values);
      await audit(client, user.id, 'delivery_slot.updated', 'delivery_time_slot', slotId, { fields: Object.keys(body) });
      await client.query('COMMIT');
      return { data: result.rows[0] };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  });


  // Delivery partners are assigned by staff explicitly; there is no automatic assignment.
  app.get('/api/v1/admin/delivery-partners', async (request, reply) => {
    const user = await requireRole(pool, request, reply, ['admin', 'operator']);
    if (!user) return;
    const result = await pool.query(
      `SELECT u.id, u.display_name, u.phone_e164,
              (SELECT COUNT(*)::integer FROM delivery_assignments da
                WHERE da.delivery_person_id = u.id AND da.status = 'assigned') AS active_assignments
         FROM users u
        WHERE u.role = 'delivery_partner' AND u.is_active = TRUE AND u.staff_removed_at IS NULL
        ORDER BY u.display_name NULLS LAST, u.phone_e164`,
    );
    return { data: result.rows };
  });

  app.get<{ Params: { orderId: string } }>('/api/v1/admin/orders/:orderId/delivery-assignment', async (request, reply) => {
    const user = await requireRole(pool, request, reply, ['admin', 'operator']);
    if (!user) return;
    if (!uuid.test(request.params.orderId)) return reply.code(400).send({ error: 'INVALID_ORDER_ID' });
    const order = await pool.query('SELECT id, fulfilment_provider FROM orders WHERE id = $1', [request.params.orderId]);
    if (!order.rows[0]) return reply.code(404).send({ error: 'ORDER_NOT_FOUND' });
    const [history, events] = await Promise.all([
      pool.query(
        `SELECT da.id, da.status, da.assigned_at, da.completed_at, da.created_at,
                da.delivery_person_id, da.assigned_by,
                partner.display_name AS partner_name, partner.phone_e164 AS partner_phone,
                actor.display_name AS assigned_by_name
           FROM delivery_assignments da
           JOIN users partner ON partner.id = da.delivery_person_id
           LEFT JOIN users actor ON actor.id = da.assigned_by
          WHERE da.order_id = $1 ORDER BY da.created_at DESC`,
        [request.params.orderId],
      ),
      pool.query(
        `SELECT e.id,e.assignment_id,e.event,e.from_status,e.to_status,e.actor_role,e.metadata,e.created_at,
                actor.display_name AS actor_name, partner.display_name AS partner_name
           FROM delivery_assignment_events e
           LEFT JOIN users actor ON actor.id=e.actor_user_id
           JOIN users partner ON partner.id=e.delivery_person_id
          WHERE e.order_id=$1 ORDER BY e.created_at,e.id`,
        [request.params.orderId],
      ),
    ]);
    return { data: { fulfilment_provider: order.rows[0].fulfilment_provider, history: history.rows, events: events.rows } };
  });

  app.post<{ Params: { orderId: string }; Body: { delivery_person_id: string } }>('/api/v1/admin/orders/:orderId/delivery-assignment', async (request, reply) => {
    const user = await requireRole(pool, request, reply, ['admin', 'operator']);
    if (!user) return;
    const { orderId } = request.params;
    const body = request.body;
    if (!uuid.test(orderId) || !body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).length !== 1 || !uuid.test(body.delivery_person_id)) {
      return reply.code(400).send({ error: 'INVALID_DELIVERY_ASSIGNMENT' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query(
        `SELECT id, status, payment_status, payment_method, fulfilment_provider, delivery_exception
           FROM orders WHERE id = $1 FOR UPDATE`, [orderId],
      );
      const order = found.rows[0];
      if (!order) { await client.query('ROLLBACK'); return reply.code(404).send({ error: 'ORDER_NOT_FOUND' }); }
      if (order.fulfilment_provider !== 'self_delivery') {
        await client.query('ROLLBACK');
        return reply.code(409).send({ error: 'NOT_SELF_DELIVERY', message: 'Manual partner assignment is only available for self-delivery orders.' });
      }
      if (['cancelled', 'delivered', 'return_requested', 'refund_initiated', 'refund_completed', 'refunded'].includes(order.status)) {
        await client.query('ROLLBACK');
        return reply.code(409).send({ error: 'ORDER_NOT_ASSIGNABLE', message: 'This order can no longer be assigned.' });
      }
      if (!(order.payment_status === 'paid' || (order.payment_method === 'cod' && order.payment_status === 'pending'))) {
        await client.query('ROLLBACK');
        return reply.code(409).send({ error: 'ORDER_NOT_PAID', message: 'Only paid or COD orders can be assigned.' });
      }
      const partner = await client.query(
        `SELECT id FROM users
          WHERE id = $1 AND role = 'delivery_partner' AND is_active = TRUE
            AND staff_removed_at IS NULL FOR UPDATE`, [body.delivery_person_id],
      );
      if (!partner.rows[0]) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ error: 'DELIVERY_PARTNER_NOT_AVAILABLE', message: 'Select an active delivery partner.' });
      }
      const active = await client.query(
        `SELECT id, delivery_person_id, out_for_delivery_at FROM delivery_assignments
          WHERE order_id = $1 AND status = 'assigned' FOR UPDATE`, [orderId],
      );
      // Once the goods have left the store, the partner holds them: reassignment is allowed only through
      // the exception workflow (a reported issue that an admin marked reassignment_required).
      const handedOver = order.status === 'dispatched' || Boolean(active.rows[0]?.out_for_delivery_at);
      if (handedOver && order.delivery_exception !== 'reassignment_required' && active.rows[0]?.delivery_person_id !== body.delivery_person_id) {
        await client.query('ROLLBACK');
        return reply.code(409).send({ error: 'DELIVERY_ALREADY_PICKED_UP', message: 'This order is already with a delivery partner. Mark the reported issue as "reassignment required" before reassigning.' });
      }
      if (active.rows[0]?.delivery_person_id === body.delivery_person_id) {
        await client.query('COMMIT');
        return { data: { id: active.rows[0].id, unchanged: true } };
      }
      if (active.rows[0]) {
        await client.query(
          `UPDATE delivery_assignments SET status = 'cancelled', updated_at = now()
            WHERE id = $1`, [active.rows[0].id],
        );
        await client.query(
          `INSERT INTO delivery_assignment_events(assignment_id,order_id,delivery_person_id,event,from_status,to_status,actor_user_id,actor_role,metadata)
           VALUES($1,$2,$3,'cancelled','assigned','cancelled',$4,$5,$6::jsonb)`,
          [active.rows[0].id, orderId, active.rows[0].delivery_person_id, user.id, user.role, JSON.stringify({ reason: 'reassigned' })],
        );
      }
      // A new partner resolves an outstanding rejection or reassignment request.
      await client.query(`UPDATE orders SET delivery_exception = NULL, updated_at = now() WHERE id = $1 AND delivery_exception = 'reassignment_required'`, [orderId]);
      const inserted = await client.query(
        `INSERT INTO delivery_assignments (order_id, delivery_person_id, status, assigned_by)
         VALUES ($1, $2, 'assigned', $3)
         RETURNING id, order_id, delivery_person_id, status, assigned_at`,
        [orderId, body.delivery_person_id, user.id],
      );
      await client.query(
        `INSERT INTO delivery_assignment_events(assignment_id,order_id,delivery_person_id,event,to_status,actor_user_id,actor_role,metadata)
         VALUES($1,$2,$3,'assigned','assigned',$4,$5,$6::jsonb)`,
        [inserted.rows[0].id,orderId,body.delivery_person_id,user.id,user.role,JSON.stringify({ previous_delivery_person_id: active.rows[0]?.delivery_person_id ?? null })],
      );
      await audit(client, user.id, active.rows[0] ? 'delivery_assignment.reassigned' : 'delivery_assignment.created',
        'order', orderId, { delivery_assignment_id: inserted.rows[0].id, delivery_person_id: body.delivery_person_id,
          previous_delivery_person_id: active.rows[0]?.delivery_person_id ?? null });
      await client.query('COMMIT');
      return reply.code(201).send({ data: inserted.rows[0] });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  });

}
