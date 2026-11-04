import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import sharp from 'sharp';
import { requireAuth } from '../auth/session.js';
import { HttpError, audit, parseOrReply, sendHttpError, uuidPattern, withTransaction } from '../lib/http.js';
import { RETURN_WINDOW_HOURS } from '../lib/orders.js';
import type { MediaStore } from '../media/store.js';

const MAX_EVIDENCE_BYTES = 5 * 1024 * 1024;
const MAX_EVIDENCE_COUNT = 5;
const ACCEPTED_FORMATS = new Set(['jpeg', 'png', 'webp', 'avif']);

export async function registerReturnRoutes(app: FastifyInstance, pool: Pool, media: MediaStore): Promise<void> {
  app.post<{ Params: { orderId: string } }>('/api/v1/orders/:orderId/return-request', { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async (request, reply) => {
    const user = await requireAuth(pool, request, reply);
    if (!user) return;
    const body = parseOrReply(z.object({
      reason: z.string().trim().min(3).max(500),
      items: z.array(z.object({ order_item_id: z.string().regex(uuidPattern), quantity: z.number().int().min(1).max(99) }).strict()).min(1).max(50).optional(),
    }).strict().superRefine((value, ctx) => {
      if (value.items && new Set(value.items.map(item => item.order_item_id)).size !== value.items.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Each order item can appear only once' });
      }
    }), request.body, reply);
    if (!body) return;
    if (!uuidPattern.test(request.params.orderId)) return reply.code(400).send({ error: 'INVALID_ORDER_ID' });
    try {
      const result = await withTransaction(pool, async client => {
        const found = await client.query<{ status: string; payment_status: string; delivered_at: Date | null }>(
          'SELECT status, payment_status, delivered_at FROM orders WHERE id = $1 AND user_id = $2 FOR UPDATE',
          [request.params.orderId, user.id],
        );
        const order = found.rows[0];
        if (!order) throw new HttpError(404, 'ORDER_NOT_FOUND', 'Order not found');
        // One return record per order (UNIQUE order_id, migration 028), including a cancelled one.
        // Check it before the status gate: after a request the order is return_requested, and the
        // customer should be told a return already exists rather than that the order is not returnable.
        const existingReturn = await client.query<{ status: string }>('SELECT status FROM order_returns WHERE order_id = $1', [request.params.orderId]);
        if (existingReturn.rows[0]) {
          throw new HttpError(409, 'RETURN_ALREADY_EXISTS', existingReturn.rows[0].status === 'cancelled'
            ? 'A return for this order was cancelled and cannot be reopened. Contact support for help.'
            : 'A return request already exists for this order');
        }
        if (order.status !== 'delivered') throw new HttpError(409, 'ORDER_NOT_RETURNABLE', 'Only delivered orders can be returned');
        if (order.payment_status !== 'paid') throw new HttpError(409, 'ORDER_PAYMENT_NOT_SETTLED', 'The order payment must be fully settled before a return can be requested');
        if (!order.delivered_at || Date.now() - new Date(order.delivered_at).getTime() > RETURN_WINDOW_HOURS * 3_600_000) {
          throw new HttpError(409, 'RETURN_WINDOW_CLOSED', 'Returns can be requested within ' + RETURN_WINDOW_HOURS + ' hours of delivery');
        }

        const orderItems = await client.query<{
          id: string; product_name_snapshot: string; variant_label_snapshot: string | null; sku_snapshot: string;
          unit_price_paise: number; quantity: number; line_total_paise: number; tax_paise: number | null;
        }>(
          'SELECT id, product_name_snapshot, variant_label_snapshot, sku_snapshot, unit_price_paise, quantity, line_total_paise, tax_paise FROM order_items WHERE order_id = $1 ORDER BY id',
          [request.params.orderId],
        );
        const requested = body.items
          ? body.items.map(item => {
              const line = orderItems.rows.find(row => row.id === item.order_item_id);
              if (!line) throw new HttpError(400, 'INVALID_RETURN_ITEM', 'A selected item does not belong to this order');
              if (item.quantity > line.quantity) throw new HttpError(400, 'INVALID_RETURN_QUANTITY', 'Return quantity cannot exceed the purchased quantity');
              return { line, quantity: item.quantity };
            })
          : orderItems.rows.map(line => ({ line, quantity: line.quantity }));
        if (!requested.length) throw new HttpError(409, 'ORDER_HAS_NO_RETURNABLE_ITEMS', 'This order has no returnable items');

        const inserted = await client.query<{ id: string }>(
          'INSERT INTO order_returns (order_id, customer_id, reason) VALUES ($1,$2,$3) RETURNING id',
          [request.params.orderId, user.id, body.reason],
        );
        let requestedRefundPaise = 0;
        for (const { line, quantity } of requested) {
          // Use the immutable order-line totals; proportional rounding keeps partial quantities within the charged amount.
          const refundAmount = quantity === line.quantity
            ? Number(line.line_total_paise)
            : Math.round(Number(line.line_total_paise) * quantity / Number(line.quantity));
          const taxAmount = quantity === line.quantity
            ? Number(line.tax_paise ?? 0)
            : Math.round(Number(line.tax_paise ?? 0) * quantity / Number(line.quantity));
          requestedRefundPaise += refundAmount;
          await client.query(
            'INSERT INTO order_return_items (return_id, order_item_id, product_name_snapshot, variant_label_snapshot, sku_snapshot, quantity, unit_price_paise, refund_amount_paise, tax_amount_paise) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
            [inserted.rows[0]!.id, line.id, line.product_name_snapshot, line.variant_label_snapshot, line.sku_snapshot, quantity, line.unit_price_paise, refundAmount, taxAmount],
          );
        }
        await client.query(
          "UPDATE orders SET status = 'return_requested', return_reason = $3, return_requested_at = now(), updated_at = now() WHERE id = $1 AND user_id = $2",
          [request.params.orderId, user.id, body.reason],
        );
        await client.query(
          "INSERT INTO return_events (return_id, from_status, to_status, note, actor_user_id) VALUES ($1,NULL,'requested',$2,$3)",
          [inserted.rows[0]!.id, body.reason, user.id],
        );
        await audit(client, user.id, 'return.requested', 'order', request.params.orderId, {
          return_id: inserted.rows[0]!.id, item_count: requested.length, requested_refund_paise: requestedRefundPaise,
        });
        return { return_id: inserted.rows[0]!.id, order_id: request.params.orderId, status: 'requested', items: requested.length, requested_refund_paise: requestedRefundPaise };
      });
      return reply.code(201).send({ data: result });
    } catch (error) {
      if (error instanceof HttpError) return sendHttpError(reply, error);
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
        return reply.code(409).send({ error: 'RETURN_ALREADY_EXISTS', message: 'A return request already exists for this order' });
      }
      throw error;
    }
  });

  app.post<{ Params: { orderId: string } }>('/api/v1/orders/:orderId/return-cancel', { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async (request, reply) => {
    const user = await requireAuth(pool, request, reply);
    if (!user) return;
    if (!uuidPattern.test(request.params.orderId)) return reply.code(400).send({ error: 'INVALID_ORDER_ID' });
    try {
      const result = await withTransaction(pool, async client => {
        const found = await client.query<{ id: string; status: string; order_status: string }>(
          'SELECT r.id, r.status, o.status AS order_status FROM order_returns r JOIN orders o ON o.id = r.order_id WHERE r.order_id = $1 AND o.user_id = $2 FOR UPDATE OF r, o',
          [request.params.orderId, user.id],
        );
        const current = found.rows[0];
        if (!current) throw new HttpError(404, 'RETURN_NOT_FOUND', 'Return request not found');
        if (!['requested', 'accepted'].includes(current.status) || current.order_status !== 'return_requested') {
          throw new HttpError(409, 'RETURN_CANNOT_BE_CANCELLED', 'A return can only be cancelled before pickup is scheduled');
        }
        await client.query("UPDATE order_returns SET status = 'cancelled', updated_at = now() WHERE id = $1", [current.id]);
        await client.query("UPDATE orders SET status = 'delivered', updated_at = now() WHERE id = $1 AND status = 'return_requested'", [request.params.orderId]);
        await client.query(
          "INSERT INTO return_events (return_id, from_status, to_status, note, actor_user_id) VALUES ($1,$2,'cancelled','Cancelled by customer',$3)",
          [current.id, current.status, user.id],
        );
        await audit(client, user.id, 'return.cancelled', 'order', request.params.orderId, { return_id: current.id });
        return { order_id: request.params.orderId, return_id: current.id, status: 'cancelled' };
      });
      return { data: result };
    } catch (error) {
      if (error instanceof HttpError) return sendHttpError(reply, error);
      throw error;
    }
  });

  app.post<{ Params: { orderId: string } }>('/api/v1/orders/:orderId/return-evidence', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (request, reply) => {
    const user = await requireAuth(pool, request, reply);
    if (!user) return;
    if (!uuidPattern.test(request.params.orderId)) return reply.code(400).send({ error: 'INVALID_ORDER_ID' });
    if (!request.isMultipart()) return reply.code(415).send({ error: 'MULTIPART_REQUIRED', message: 'Upload the evidence image as multipart/form-data' });
    const found = await pool.query<{ id: string; status: string }>(
      'SELECT r.id, r.status FROM order_returns r JOIN orders o ON o.id = r.order_id WHERE r.order_id = $1 AND o.user_id = $2',
      [request.params.orderId, user.id],
    );
    const returnRow = found.rows[0];
    if (!returnRow) return reply.code(404).send({ error: 'RETURN_NOT_FOUND', message: 'Create a return request before uploading evidence' });
    if (returnRow.status !== 'requested') return reply.code(409).send({ error: 'RETURN_EVIDENCE_CLOSED', message: 'Evidence uploads are closed after the return is reviewed' });
    let file;
    try { file = await request.file({ limits: { fileSize: MAX_EVIDENCE_BYTES, files: 1 } }); }
    catch { return reply.code(400).send({ error: 'INVALID_UPLOAD', message: 'Could not read the uploaded image' }); }
    if (!file) return reply.code(400).send({ error: 'FILE_REQUIRED', message: 'Choose an image to upload' });
    const input = await file.toBuffer().catch(() => null);
    if (!input || file.file.truncated || input.length > MAX_EVIDENCE_BYTES) {
      return reply.code(413).send({ error: 'FILE_TOO_LARGE', message: 'Return images must be 5 MB or smaller' });
    }

    let output: Buffer;
    try {
      const metadata = await sharp(input, { limitInputPixels: 25_000_000, failOn: 'error' }).metadata();
      if (!metadata.format || !ACCEPTED_FORMATS.has(metadata.format)) throw new Error('UNSUPPORTED_IMAGE');
      output = await sharp(input, { limitInputPixels: 25_000_000, failOn: 'error' })
        .rotate()
        .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82, effort: 4 })
        .toBuffer();
      if (output.length > MAX_EVIDENCE_BYTES) throw new Error('FILE_TOO_LARGE');
    } catch (error) {
      const tooLarge = error instanceof Error && error.message === 'FILE_TOO_LARGE';
      return reply.code(tooLarge ? 413 : 400).send({
        error: tooLarge ? 'FILE_TOO_LARGE' : 'UNSUPPORTED_IMAGE',
        message: tooLarge ? 'Processed return images must be 5 MB or smaller' : 'Upload a genuine JPG, PNG, WebP or AVIF image',
      });
    }

    const storageKey = randomUUID() + '.webp';
    try {
      const saved = await withTransaction(pool, async client => {
        const locked = await client.query<{ id: string; status: string }>(
          'SELECT r.id, r.status FROM order_returns r JOIN orders o ON o.id = r.order_id WHERE r.order_id = $1 AND o.user_id = $2 FOR UPDATE OF r',
          [request.params.orderId, user.id],
        );
        const current = locked.rows[0];
        if (!current) throw new HttpError(404, 'RETURN_NOT_FOUND', 'Return request not found');
        if (current.status !== 'requested') throw new HttpError(409, 'RETURN_EVIDENCE_CLOSED', 'Evidence uploads are closed after the return is reviewed');
        const count = await client.query<{ count: number }>(
          'SELECT count(*)::integer AS count FROM return_evidence WHERE return_id = $1', [current.id],
        );
        if (Number(count.rows[0]?.count ?? 0) >= MAX_EVIDENCE_COUNT) {
          throw new HttpError(409, 'EVIDENCE_LIMIT_REACHED', 'You can upload up to five images for a return');
        }
        await media.putPrivate(storageKey, output, 'image/webp');
        const inserted = await client.query<{ id: string; created_at: Date }>(
          'INSERT INTO return_evidence (return_id, storage_key, byte_size, uploaded_by) VALUES ($1,$2,$3,$4) RETURNING id, created_at',
          [current.id, storageKey, output.length, user.id],
        );
        await audit(client, user.id, 'return.evidence_uploaded', 'order', request.params.orderId, { evidence_id: inserted.rows[0]!.id, byte_size: output.length });
        return inserted.rows[0]!;
      });
      return reply.code(201).send({ data: { id: saved.id, content_type: 'image/webp', byte_size: output.length, created_at: saved.created_at } });
    } catch (error) {
      await media.removePrivate([storageKey]).catch(() => undefined);
      if (error instanceof HttpError) return sendHttpError(reply, error);
      throw error;
    }
  });

  app.get<{ Params: { orderId: string; evidenceId: string } }>('/api/v1/orders/:orderId/return-evidence/:evidenceId', async (request, reply) => {
    const user = await requireAuth(pool, request, reply);
    if (!user) return;
    if (!uuidPattern.test(request.params.orderId) || !uuidPattern.test(request.params.evidenceId)) return reply.code(400).send({ error: 'INVALID_EVIDENCE_ID' });
    const found = await pool.query<{ storage_key: string; byte_size: number }>(
      "SELECT e.storage_key, e.byte_size FROM return_evidence e JOIN order_returns r ON r.id = e.return_id JOIN orders o ON o.id = r.order_id WHERE o.id = $1 AND e.id = $2 AND (o.user_id = $3 OR EXISTS (SELECT 1 FROM users staff WHERE staff.id = $3 AND staff.is_active AND staff.staff_removed_at IS NULL AND staff.must_change_password = FALSE AND staff.role IN ('admin','operator')))",
      [request.params.orderId, request.params.evidenceId, user.id],
    );
    const evidence = found.rows[0];
    if (!evidence) return reply.code(404).send({ error: 'EVIDENCE_NOT_FOUND', message: 'Evidence not found' });
    const bytes = await media.getPrivate(evidence.storage_key);
    if (!bytes) return reply.code(404).send({ error: 'EVIDENCE_FILE_NOT_FOUND', message: 'Evidence file is unavailable' });
    return reply.type('image/webp')
      .header('content-length', bytes.length)
      .header('cache-control', 'private, no-store, max-age=0')
      .header('pragma', 'no-cache')
      .header('x-content-type-options', 'nosniff')
      .send(bytes);
  });

  app.patch<{ Params: { orderId: string } }>('/api/v1/orders/:orderId/return-shipment', { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async (request, reply) => {
    const user = await requireAuth(pool, request, reply);
    if (!user) return;
    if (!uuidPattern.test(request.params.orderId)) return reply.code(400).send({ error: 'INVALID_ORDER_ID' });
    const parsed = z.object({
      carrier: z.string().trim().min(2).max(80),
      tracking_reference: z.string().trim().min(2).max(160),
      parcel_description: z.string().trim().min(3).max(500),
    }).strict().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_RETURN_SHIPMENT', message: parsed.error.issues[0]?.message });
    try {
      const result = await withTransaction(pool, async client => {
        const found = await client.query<{ id: string; status: string; pickup_method: string | null }>(
          'SELECT r.id, r.status, r.pickup_method FROM order_returns r JOIN orders o ON o.id = r.order_id WHERE r.order_id = $1 AND o.user_id = $2 FOR UPDATE OF r',
          [request.params.orderId, user.id],
        );
        const current = found.rows[0];
        if (!current) throw new HttpError(404, 'RETURN_NOT_FOUND', 'Return request not found');
        if (current.status !== 'pickup_scheduled' || current.pickup_method !== 'courier') {
          throw new HttpError(409, 'RETURN_COURIER_DETAILS_NOT_ALLOWED', 'Courier details can be submitted only after courier return has been selected');
        }
        await client.query(
          "UPDATE order_returns SET status = 'in_transit', return_carrier = $2, pickup_reference = $3, parcel_description = $4, updated_at = now() WHERE id = $1",
          [current.id, parsed.data.carrier, parsed.data.tracking_reference, parsed.data.parcel_description],
        );
        await client.query(
          "INSERT INTO return_events (return_id, from_status, to_status, note, actor_user_id) VALUES ($1,'pickup_scheduled','in_transit',$2,$3)",
          [current.id, parsed.data.carrier + ' · ' + parsed.data.tracking_reference, user.id],
        );
        await audit(client, user.id, 'return.courier_details_submitted', 'order', request.params.orderId, {
          return_id: current.id, carrier: parsed.data.carrier, tracking_reference: parsed.data.tracking_reference,
        });
        return { order_id: request.params.orderId, return_id: current.id, status: 'in_transit' };
      });
      return { data: result };
    } catch (error) {
      if (error instanceof HttpError) return sendHttpError(reply, error);
      throw error;
    }
  });

  app.get<{ Params: { orderId: string } }>('/api/v1/orders/:orderId/return', async (request, reply) => {
    const user = await requireAuth(pool, request, reply);
    if (!user) return;
    if (!uuidPattern.test(request.params.orderId)) return reply.code(400).send({ error: 'INVALID_ORDER_ID' });
    const result = await pool.query(
      "SELECT r.id, r.reason, r.status, r.decision_reason, r.pickup_method, r.return_carrier, r.pickup_reference, r.parcel_description, r.decided_at, r.received_at, r.created_at, r.updated_at, COALESCE((SELECT json_agg(json_build_object('id', e.id, 'content_type', e.content_type, 'byte_size', e.byte_size, 'created_at', e.created_at) ORDER BY e.created_at) FROM return_evidence e WHERE e.return_id = r.id), '[]'::json) AS evidence, COALESCE((SELECT json_agg(json_build_object('from_status', ev.from_status, 'to_status', ev.to_status, 'note', ev.note, 'created_at', ev.created_at) ORDER BY ev.created_at) FROM return_events ev WHERE ev.return_id = r.id), '[]'::json) AS timeline, COALESCE((SELECT json_agg(json_build_object('order_item_id', ri.order_item_id, 'name', ri.product_name_snapshot, 'variant_label', ri.variant_label_snapshot, 'sku', ri.sku_snapshot, 'quantity', ri.quantity, 'unit_price_paise', ri.unit_price_paise, 'refund_amount_paise', ri.refund_amount_paise, 'tax_amount_paise', ri.tax_amount_paise) ORDER BY ri.created_at) FROM order_return_items ri WHERE ri.return_id = r.id), '[]'::json) AS items FROM order_returns r JOIN orders o ON o.id = r.order_id WHERE r.order_id = $1 AND o.user_id = $2",
      [request.params.orderId, user.id],
    );
    if (!result.rows[0]) return reply.code(404).send({ error: 'RETURN_NOT_FOUND' });
    return { data: result.rows[0] };
  });
}
