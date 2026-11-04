import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { requireAuth } from '../auth/session.js';
import { reserveOrderInventory, consumeOrderInventory } from '../inventory/reservations.js';
import { emailSchema, HttpError, parseOrReply, sendHttpError, uuidPattern, uuidSchema, withTransaction } from '../lib/http.js';
import { displayOrderNumber, parseOrderReference, RETURN_WINDOW_HOURS, STATUS_GROUPS } from '../lib/orders.js';
import { buildQuote, ONLINE_METHODS, publicQuote, type PaymentMethod } from '../orders/pricing.js';
import { createRazorpayOrder, fetchRazorpayPayment, razorpayConfig, verifyRazorpayCheckoutSignature } from '../payments/razorpay.js';
import { isCheckoutSessionExpired, isReusablePaymentStatus } from '../payments/checkout-session.js';
import { enqueuePaymentReconciliation } from '../payments/reconciliation.js';
import { loadSettings } from '../settings/store-settings.js';
import { thumbOf } from '../catalog/queries.js';

const idempotency = /^[A-Za-z0-9._:-]{8,128}$/;
const ONLINE_RESERVATION_MINUTES = 15;


export type OrderDeps = { checkoutEnabled: () => boolean; onlinePaymentsAvailable: () => boolean };

const checkoutSchema = z.object({
  address_id: uuidSchema,
  delivery: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('express') }).strict(),
    z.object({ mode: z.literal('scheduled'), slot_id: uuidSchema, date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict(),
  ]),
  payment_method: z.enum(['upi', 'card', 'net_banking', 'wallet', 'cod']),
  email: emailSchema.optional(),
  expected_total_paise: z.number().int().min(0),
}).strict();

/** Online payments require server-side Razorpay credentials and an explicit feature flag. */
export function onlinePaymentsReady(enabled: boolean): boolean {
  return enabled && razorpayConfig() !== null;
}

async function placeOrder(client: PoolClient, userId: string, key: string, body: z.infer<typeof checkoutSchema>, deps: OrderDeps) {
  const address = await client.query<Record<string, unknown> & { id: string; recipient_name: string; phone_e164: string; postal_code: string }>(
    `SELECT id, label, recipient_name, phone_e164, line1, line2, locality, city, state, postal_code, delivery_instructions
       FROM addresses WHERE id = $1 AND user_id = $2 FOR SHARE`, [body.address_id, userId],
  );
  const addr = address.rows[0];
  if (!addr) throw new HttpError(400, 'INVALID_ADDRESS', 'Choose one of your saved addresses');

  const settings = await loadSettings(client);
  const online = deps.onlinePaymentsAvailable();
  const quote = await buildQuote(client, { userId, settings, postalCode: addr.postal_code, onlinePaymentsAvailable: online, lock: true });
  const fail = (code: string, message: string): never => { throw new HttpError(409, code, message, { quote: publicQuote(quote) }); };
  if (quote.problems.includes('CART_EMPTY')) fail('CART_EMPTY', 'Your cart is empty');
  if (quote.problems.includes('CART_HAS_UNAVAILABLE_ITEMS')) fail('CART_HAS_UNAVAILABLE_ITEMS', 'Some items in your cart are no longer available. Please review your cart.');
  if (quote.problems.includes('DELIVERY_UNAVAILABLE')) fail('DELIVERY_UNAVAILABLE', 'We do not deliver to this PIN code yet');
  if (quote.problems.includes('MINIMUM_ORDER_NOT_MET')) fail('MINIMUM_ORDER_NOT_MET', `Minimum order for this area is ₹${Math.ceil((quote.zone?.minimum_order_paise ?? 0) / 100)}`);
  const method = body.payment_method as PaymentMethod;
  if (!quote.payment_methods[method].available) fail('PAYMENT_METHOD_UNAVAILABLE', quote.payment_methods[method].reason ?? 'This payment method is unavailable');
  if (quote.total_paise !== body.expected_total_paise) fail('PRICE_CHANGED', 'Prices or delivery charges changed. Please review the updated total.');

  let slotStart: string | null = null; let slotEnd: string | null = null; let slotId: string | null = null; let eta: Date;
  if (body.delivery.mode === 'express') {
    if (!quote.delivery.express.available) fail('DELIVERY_OPTION_UNAVAILABLE', quote.delivery.express.reason ?? 'Deliver Now is unavailable');
    eta = new Date(Date.now() + (quote.delivery.express.estimated_minutes ?? 30) * 60_000);
  } else {
    const { slot_id: requestedSlot, date } = body.delivery;
    const option = quote.delivery.scheduled.find(item => item.slot_id === requestedSlot && item.date === date);
    if (!option) return fail('DELIVERY_OPTION_UNAVAILABLE', 'The selected delivery slot is no longer available');
    slotId = option.slot_id; slotStart = option.starts_at; slotEnd = option.ends_at; eta = new Date(option.ends_at);
  }

  const isCod = method === 'cod';
  let email = body.email ?? null;
  if (!isCod && !email) {
    const profile = await client.query<{ email: string | null }>('SELECT email FROM users WHERE id = $1', [userId]);
    email = profile.rows[0]?.email ?? null;
    if (!email) throw new HttpError(400, 'VALID_EMAIL_REQUIRED', 'An email address is required for online payment receipts');
  }

  const order = await client.query<{ id: string; order_number: string }>(
    `INSERT INTO orders (user_id, address_id, idempotency_key, checkout_email, status, payment_status, payment_method,
                         subtotal_paise, delivery_fee_paise, tax_paise, discount_paise, total_paise, mrp_total_paise,
                         delivery_mode, delivery_slot_id, delivery_slot_start, delivery_slot_end, delivery_zone_id, estimated_delivery_at,
                         delivery_address_snapshot)
     VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$8,$9,0,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb)
     RETURNING id, order_number`,
    [userId, addr.id, key, email, isCod ? 'placed' : 'pending_payment', method,
      quote.subtotal_paise, quote.delivery_fee_paise, quote.tax_paise, quote.total_paise, quote.mrp_total_paise,
      body.delivery.mode, slotId, slotStart, slotEnd, quote.zone!.id, eta.toISOString(), JSON.stringify(addr)],
  );
  const created = order.rows[0]!;
  for (const line of quote.lines) {
    await client.query(
      `INSERT INTO order_items (order_id, product_id, variant_id, product_name_snapshot, variant_label_snapshot, sku_snapshot, image_url_snapshot,
                                unit_price_paise, mrp_paise, quantity, line_total_paise, gst_rate_basis_points, tax_paise, hsn_code_snapshot)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [created.id, line.product_id, line.variant_id, line.name, line.variant_label, line.sku, line.image_url,
        line.unit_price_paise, line.mrp_paise, line.quantity, line.line_total_paise, line.gst_rate_basis_points, line.tax_paise, line.hsn_code],
    );
  }
  const reservationExpiry = new Date(Date.now() + (isCod ? 7 * 24 * 60 : ONLINE_RESERVATION_MINUTES) * 60_000);
  const reservation = await reserveOrderInventory(client, created.id, reservationExpiry);
  if (!reservation.ok) throw new HttpError(409, 'INSUFFICIENT_STOCK', 'Some items just went out of stock. Please review your cart.');
  await client.query('DELETE FROM cart_items WHERE cart_id = (SELECT id FROM carts WHERE user_id = $1)', [userId]);

  if (isCod) {
    // Stock is committed immediately for COD; cash is collected on delivery.
    if (!(await consumeOrderInventory(client, created.id))) throw new Error('COD_INVENTORY_CONSUMPTION_FAILED');
    await client.query(
      `INSERT INTO payments (order_id, provider, status, amount_paise, payment_method) VALUES ($1, 'cod', 'pending', $2, 'cod')`,
      [created.id, quote.total_paise],
    );
    return { kind: 'cod' as const, order: created, total: quote.total_paise, eta };
  }

  const config = razorpayConfig();
  if (!config || !deps.onlinePaymentsAvailable()) throw new HttpError(503, 'PAYMENTS_NOT_CONFIGURED', 'Online payment is not available yet');
  const gatewayOrder = await createRazorpayOrder(config, {
    amountPaise: quote.total_paise,
    receipt: `SAC-${created.order_number}`.slice(0, 40),
    notes: { order_id: created.id, order_number: String(created.order_number) },
  });
  if (gatewayOrder.currency !== 'INR' || gatewayOrder.amount !== quote.total_paise || gatewayOrder.status !== 'created') {
    throw new HttpError(502, 'PAYMENT_ORDER_INVALID', 'The payment provider returned an invalid order. Please retry.');
  }
  await client.query(
    `INSERT INTO payments (order_id, provider, provider_transaction_id, status, amount_paise, expires_at, payment_method)
     VALUES ($1,'razorpay',$2,'pending',$3,$4,$5)`, [created.id, gatewayOrder.id, quote.total_paise, reservationExpiry, method],
  );
  const checkout = { key_id: config.keyId, razorpay_order_id: gatewayOrder.id, amount: gatewayOrder.amount, currency: gatewayOrder.currency,
    name: 'Sri Anantha Cart', description: `Order ${displayOrderNumber(created.order_number)}`, prefill: { name: addr.recipient_name, email: email!, contact: addr.phone_e164 } };
  return { kind: 'online' as const, order: created, total: quote.total_paise, eta, checkout, expiresAt: reservationExpiry };
}

function checkoutResponse(reply: FastifyReply, status: number, result: { order: { id: string; order_number: string }; total: number; eta?: Date | undefined; checkout?: unknown; expiresAt?: Date | undefined }, method: string) {
  return reply.code(status).send({
    data: {
      order_id: result.order.id,
      order_number: displayOrderNumber(result.order.order_number),
      amount_paise: result.total,
      payment_method: method,
      estimated_delivery_at: result.eta?.toISOString() ?? null,
      ...(result.checkout ? { checkout: result.checkout, expires_at: result.expiresAt?.toISOString() } : {}),
    },
  });
}

export async function registerOrderRoutes(app: FastifyInstance, pool: Pool, deps: OrderDeps = { checkoutEnabled: () => false, onlinePaymentsAvailable: () => false }): Promise<void> {
  app.get<{ Querystring: { status?: string; limit?: string } }>('/api/v1/orders', async (request, reply) => {
    const user = await requireAuth(pool, request, reply);
    if (!user) return;
    const group = request.query.status && STATUS_GROUPS[request.query.status] ? STATUS_GROUPS[request.query.status]! : null;
    const result = await pool.query(
      `SELECT o.id, o.order_number, o.status, o.payment_status, o.payment_method, o.total_paise, o.created_at, o.estimated_delivery_at,
              (SELECT COALESCE(SUM(quantity), 0)::integer FROM order_items WHERE order_id = o.id) AS item_count,
              (SELECT COALESCE(json_agg(t.image_url_snapshot), '[]'::json) FROM (
                 SELECT image_url_snapshot FROM order_items WHERE order_id = o.id AND image_url_snapshot IS NOT NULL ORDER BY id LIMIT 3) t) AS images
         FROM orders o
        WHERE o.user_id = $1 AND ($2::text[] IS NULL OR o.status = ANY($2)) AND o.status <> 'pending_payment'
        ORDER BY o.created_at DESC LIMIT 100`, [user.id, group],
    );
    return {
      data: result.rows.map(row => ({
        ...row, display_number: displayOrderNumber(row.order_number),
        thumbs: (row.images as string[]).map(url => thumbOf(url)),
      })),
    };
  });

  /** Track by reference — only the signed-in customer's own orders are searchable. */
  app.get<{ Querystring: { reference?: string } }>('/api/v1/orders/track', async (request, reply) => {
    const user = await requireAuth(pool, request, reply);
    if (!user) return;
    const number = parseOrderReference(request.query.reference ?? '');
    if (!number) return reply.code(400).send({ error: 'INVALID_ORDER_REFERENCE', message: 'Enter an order ID such as SA12345' });
    const found = await pool.query<{ id: string }>('SELECT id FROM orders WHERE order_number = $1 AND user_id = $2', [number, user.id]);
    if (!found.rows[0]) return reply.code(404).send({ error: 'ORDER_NOT_FOUND', message: 'We could not find that order in your account' });
    return { data: { order_id: found.rows[0].id } };
  });

  app.get<{ Params: { orderId: string } }>('/api/v1/orders/:orderId', async (request, reply) => {
    const user = await requireAuth(pool, request, reply);
    if (!user) return;
    if (!uuidPattern.test(request.params.orderId)) return reply.code(400).send({ error: 'INVALID_ORDER_ID', message: 'Invalid order ID' });
    const order = await pool.query(
      `SELECT id, order_number, status, payment_status, payment_method, subtotal_paise, delivery_fee_paise, tax_paise, discount_paise,
              total_paise, mrp_total_paise, delivery_mode, delivery_slot_start, delivery_slot_end, estimated_delivery_at, delivered_at,
              delivery_address_snapshot, cancellation_reason, return_reason, return_requested_at, created_at
         FROM orders WHERE id = $1 AND user_id = $2`, [request.params.orderId, user.id],
    );
    const row = order.rows[0];
    if (!row) return reply.code(404).send({ error: 'ORDER_NOT_FOUND', message: 'Order not found' });
    const [items, history, refunds, returnRows] = await Promise.all([
      pool.query(
        `SELECT oi.id AS order_item_id, oi.product_name_snapshot AS name, oi.variant_label_snapshot AS variant_label, oi.sku_snapshot AS sku, oi.unit_price_paise,
                oi.mrp_paise, oi.quantity, oi.line_total_paise, oi.gst_rate_basis_points, oi.tax_paise, oi.hsn_code_snapshot AS hsn_code,
                oi.image_url_snapshot AS image_url, p.slug
           FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = $1 ORDER BY oi.id`, [row.id]),
      pool.query(`SELECT status, payment_status, created_at FROM order_status_history WHERE order_id = $1 ORDER BY created_at, id`, [row.id]),
      pool.query(`SELECT amount_paise, status, created_at, updated_at FROM refunds WHERE order_id = $1 ORDER BY created_at`, [row.id]),
      pool.query(`SELECT id, status FROM order_returns WHERE order_id = $1 LIMIT 1`, [row.id]),
    ]);
    const deliveredAt = row.delivered_at ? new Date(row.delivered_at).getTime() : null;
    const { delivery_address_snapshot: address, ...rest } = row;
    return {
      data: {
        ...rest,
        display_number: displayOrderNumber(row.order_number),
        address: {
          label: address.label ?? null, recipient_name: address.recipient_name, phone_e164: address.phone_e164, line1: address.line1,
          line2: address.line2, locality: address.locality, city: address.city, state: address.state, postal_code: address.postal_code,
        },
        items: items.rows.map(item => ({ ...item, thumb_url: thumbOf(item.image_url) })),
        timeline: history.rows,
        refunds: refunds.rows,
        can_request_return: row.status === 'delivered' && row.payment_status === 'paid' && deliveredAt !== null && Date.now() - deliveredAt <= RETURN_WINDOW_HOURS * 3_600_000 && !returnRows.rows.length,
      },
    };
  });

  app.get<{ Params: { orderId: string } }>('/api/v1/orders/:orderId/invoice', async (request, reply) => {
    const user = await requireAuth(pool, request, reply);
    if (!user) return;
    if (!uuidPattern.test(request.params.orderId)) return reply.code(400).send({ error: 'INVALID_ORDER_ID', message: 'Invalid order ID' });
    const invoice = await buildInvoice(pool, request.params.orderId, user.id);
    if (!invoice) return reply.code(404).send({ error: 'INVOICE_NOT_AVAILABLE', message: 'An invoice is available once the order is confirmed' });
    return { data: invoice };
  });

  app.post('/api/v1/payments/razorpay/verify', async (request, reply) => {
    const user = await requireAuth(pool, request, reply);
    if (!user) return;
    const body = parseOrReply(z.object({ order_id: uuidSchema, razorpay_payment_id: z.string().regex(/^pay_[A-Za-z0-9]+$/), razorpay_signature: z.string().regex(/^[a-f0-9]{64}$/i) }).strict(), request.body, reply);
    if (!body) return;
    const config = razorpayConfig();
    if (!config) return reply.code(503).send({ error: 'PAYMENTS_NOT_CONFIGURED', message: 'Payment verification is unavailable' });
    const record = await pool.query<{ id: string; provider_transaction_id: string; amount_paise: number; status: string; provider_reference: string | null; order_status: string; payment_status: string }>(
      `SELECT p.id, p.provider_transaction_id, p.amount_paise, p.status, p.provider_reference, o.status AS order_status, o.payment_status
         FROM payments p JOIN orders o ON o.id = p.order_id
        WHERE p.order_id = $1 AND o.user_id = $2 AND p.provider = 'razorpay' FOR UPDATE OF p, o`, [body.order_id, user.id],
    );
    const payment = record.rows[0];
    if (!payment) return reply.code(404).send({ error: 'PAYMENT_NOT_FOUND', message: 'Payment not found' });
    if (!verifyRazorpayCheckoutSignature({ orderId: payment.provider_transaction_id, paymentId: body.razorpay_payment_id, signature: body.razorpay_signature, keySecret: config.keySecret })) {
      return reply.code(400).send({ error: 'PAYMENT_SIGNATURE_INVALID', message: 'Payment could not be verified' });
    }
    const gatewayPayment = await fetchRazorpayPayment(config, body.razorpay_payment_id);
    if (gatewayPayment.order_id !== payment.provider_transaction_id || gatewayPayment.amount !== Number(payment.amount_paise) || gatewayPayment.currency !== 'INR' || gatewayPayment.status !== 'captured' || gatewayPayment.captured !== true) {
      return reply.code(409).send({ error: 'PAYMENT_NOT_CAPTURED', message: 'Payment has not been confirmed by the payment provider yet' });
    }
    await withTransaction(pool, async client => {
      const locked = await client.query<{ status: string; payment_status: string }>(
        `SELECT o.status, o.payment_status FROM orders o WHERE o.id = $1 AND o.user_id = $2 FOR UPDATE`, [body.order_id, user.id],
      );
      const current = locked.rows[0];
      if (!current) throw new HttpError(404, 'ORDER_NOT_FOUND', 'Order not found');
      if (current.payment_status === 'paid') {
        if (payment.provider_reference !== gatewayPayment.id) throw new HttpError(409, 'DUPLICATE_CAPTURE_REQUIRES_REVIEW', 'A different payment was already confirmed for this order. Contact support before retrying.');
        return;
      }
      if (current.status !== 'pending_payment' || current.payment_status !== 'pending') throw new HttpError(409, 'ORDER_STATE_MISMATCH', 'This order cannot be confirmed automatically');
      if (!(await consumeOrderInventory(client, body.order_id))) throw new HttpError(409, 'INVENTORY_RESERVATION_EXPIRED', 'The stock reservation expired. Contact support before retrying payment.');
      await client.query(`UPDATE payments SET status = 'succeeded', provider_reference = $2, verified_at = now(), updated_at = now() WHERE id = $1 AND status IN ('created','pending')`, [payment.id, gatewayPayment.id]);
      await client.query(`UPDATE orders SET payment_status = 'paid', status = 'placed', updated_at = now() WHERE id = $1`, [body.order_id]);
    });
    return { data: { verified: true, order_id: body.order_id, payment_status: 'paid' } };
  });

  app.post('/api/v1/orders/checkout', {
    config: { rateLimit: { max: 20, timeWindow: '10 minutes' } },
  }, async (request, reply) => {
    const user = await requireAuth(pool, request, reply);
    if (!user) return;
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || !idempotency.test(key)) {
      return reply.code(400).send({ error: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Send an Idempotency-Key header (8–128 safe characters)' });
    }
    const body = parseOrReply(checkoutSchema, request.body, reply);
    if (!body) return;
    if (!deps.checkoutEnabled()) return reply.code(503).send({ error: 'CHECKOUT_DISABLED', message: 'Ordering is paused at the moment. Please try again shortly.' });
    if (ONLINE_METHODS.includes(body.payment_method as PaymentMethod) && !deps.onlinePaymentsAvailable()) {
      return reply.code(409).send({ error: 'PAYMENT_METHOD_UNAVAILABLE', message: 'Online payment is being set up. Please choose Cash on Delivery.' });
    }

    try {
      const outcome = await withTransaction(pool, async client => {
        // Serialise retries of the same checkout; the unique index is the final guard.
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`checkout:${user.id}:${key}`]);
        const existing = await client.query<{ id: string; order_number: string; total_paise: number; status: string; payment_status: string; payment_method: string; address_id: string; checkout_email: string | null; payment_id: string; payment_record_status: string; provider_transaction_id: string | null; expires_at: Date | null; estimated_delivery_at: Date | null }>(
          `SELECT o.id, o.order_number, o.total_paise, o.status, o.payment_status, o.payment_method, o.address_id, o.checkout_email, o.estimated_delivery_at,
                  p.id AS payment_id, p.status AS payment_record_status, p.provider_transaction_id, p.expires_at
             FROM orders o LEFT JOIN payments p ON p.order_id = o.id
            WHERE o.user_id = $1 AND o.idempotency_key = $2 FOR UPDATE OF o`, [user.id, key],
        );
        const prior = existing.rows[0];
        if (prior) return { kind: 'replay' as const, prior };
        return { kind: 'new' as const, result: await placeOrder(client, user.id, key, body, deps) };
      });

      if (outcome.kind === 'new') return checkoutResponse(reply, 201, outcome.result, body.payment_method);

      const prior = outcome.prior;
      if (prior.address_id !== body.address_id || prior.payment_method !== body.payment_method) {
        return reply.code(409).send({ error: 'IDEMPOTENCY_KEY_REQUEST_MISMATCH', message: 'This checkout was already submitted with different details. Refresh and try again.' });
      }
      if (prior.payment_method === 'cod') {
        return checkoutResponse(reply, 200, { order: prior, total: Number(prior.total_paise), eta: prior.estimated_delivery_at ? new Date(prior.estimated_delivery_at) : undefined }, 'cod');
      }
      // Online replay: reuse the original Razorpay order while the payment session is live.
      if (prior.status !== 'pending_payment' || prior.payment_status !== 'pending' || !isReusablePaymentStatus(prior.payment_record_status) || !prior.provider_transaction_id) {
        return reply.code(409).send({ error: 'IDEMPOTENCY_KEY_ALREADY_USED', message: 'This checkout key was already used for a completed or cancelled order' });
      }
      if (isCheckoutSessionExpired(prior.expires_at)) {
        await enqueuePaymentReconciliation(pool, prior.payment_id, 'IDEMPOTENT_RETRY_AFTER_CHECKOUT_EXPIRY');
        return reply.code(409).send({ error: 'CHECKOUT_SESSION_EXPIRED', message: 'This checkout session expired. Start a new checkout to continue.' });
      }
      const config = razorpayConfig();
      if (!config || (body.email && prior.checkout_email !== body.email)) {
        return reply.code(409).send({ error: 'IDEMPOTENCY_KEY_REQUEST_MISMATCH', message: 'Use the original details with this checkout key, or start again' });
      }
      const checkout = { key_id: config.keyId, razorpay_order_id: prior.provider_transaction_id,
        amount: Number(prior.total_paise), currency: 'INR', name: 'Sri Anantha Cart', description: `Order ${displayOrderNumber(prior.order_number)}` };
      return checkoutResponse(reply, 200, { order: prior, total: Number(prior.total_paise), checkout, expiresAt: prior.expires_at ? new Date(prior.expires_at) : undefined }, prior.payment_method);
    } catch (error) {
      if (error instanceof HttpError) return sendHttpError(reply, error);
      request.log.error({ err: error }, 'Checkout failed');
      return reply.code(500).send({ error: 'CHECKOUT_FAILED', message: 'We could not place your order. Nothing was charged. Please try again.' });
    }
  });
}

const STATE_NAMES: Record<string, string> = { '37': 'andhra pradesh', '36': 'telangana', '33': 'tamil nadu', '29': 'karnataka' };

/** Tax invoice data. GST is included in prices; split CGST/SGST for intra-state supply, else IGST. */
export async function buildInvoice(pool: Pool, orderId: string, userId: string | null) {
  const order = await pool.query(
    `SELECT id, order_number, status, payment_method, payment_status, subtotal_paise, delivery_fee_paise, tax_paise, discount_paise, total_paise,
            delivery_address_snapshot, created_at, delivered_at
       FROM orders
      WHERE id = $1 AND ($2::uuid IS NULL OR user_id = $2)
        AND status NOT IN ('pending_payment')
        AND (payment_method <> 'cod' OR payment_status = 'paid')`, [orderId, userId],
  );
  const row = order.rows[0];
  if (!row) return null;
  const settings = await loadSettings(pool);
  const items = await pool.query(
    `SELECT product_name_snapshot AS name, variant_label_snapshot AS variant_label, hsn_code_snapshot AS hsn_code, quantity, unit_price_paise,
            line_total_paise, gst_rate_basis_points, tax_paise
       FROM order_items WHERE order_id = $1 ORDER BY id`, [orderId],
  );
  const customerState = String(row.delivery_address_snapshot?.state ?? '').trim().toLowerCase();
  const intraState = customerState === (STATE_NAMES[settings.store.state_code] ?? 'andhra pradesh');
  return {
    invoice_number: `INV-${displayOrderNumber(row.order_number)}`,
    order_number: displayOrderNumber(row.order_number),
    issued_at: row.payment_method === 'cod' ? (row.delivered_at ?? row.created_at) : row.created_at,
    status: row.status,
    payment_method: row.payment_method,
    payment_status: row.payment_status,
    seller: { name: settings.store.legal_name || settings.store.name, gstin: settings.store.gstin || null, address: settings.store.address, state_code: settings.store.state_code },
    buyer: row.delivery_address_snapshot,
    supply_type: intraState ? 'intra_state' : 'inter_state',
    show_tax_breakup: settings.tax.show_breakup_on_invoice,
    lines: items.rows.map(item => {
      const tax = Number(item.tax_paise);
      return {
        ...item,
        taxable_value_paise: Number(item.line_total_paise) - tax,
        cgst_paise: intraState ? Math.floor(tax / 2) : 0,
        sgst_paise: intraState ? tax - Math.floor(tax / 2) : 0,
        igst_paise: intraState ? 0 : tax,
      };
    }),
    totals: {
      items_paise: Number(row.subtotal_paise), tax_included_paise: Number(row.tax_paise), delivery_fee_paise: Number(row.delivery_fee_paise),
      discount_paise: Number(row.discount_paise), total_paise: Number(row.total_paise),
    },
  };
}
