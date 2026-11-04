import type { Pool, PoolClient } from 'pg';
import { MAX_LINE_QUANTITY, thumbOf } from '../catalog/queries.js';
import type { StoreSettings } from '../settings/store-settings.js';

/** India Standard Time has no daylight saving: a fixed +05:30 offset is exact. */
const IST_OFFSET_MINUTES = 330;

export type PaymentMethod = 'upi' | 'card' | 'net_banking' | 'wallet' | 'cod';
export const ONLINE_METHODS: PaymentMethod[] = ['upi', 'card', 'net_banking', 'wallet'];

export type QuoteLine = {
  cart_item_id: string; product_id: string; variant_id: string | null; slug: string; name: string; variant_label: string | null;
  sku: string; image_url: string | null; thumb_url: string | null; unit_price_paise: number; mrp_paise: number; quantity: number;
  line_total_paise: number; gst_rate_basis_points: number; tax_paise: number; hsn_code: string | null;
  max_quantity: number; available: boolean; issue: null | 'unavailable' | 'insufficient_stock' | 'choose_variant';
};

export type ScheduledOption = { slot_id: string; date: string; label: string; starts_at: string; ends_at: string };

export type Quote = {
  lines: QuoteLine[];
  item_count: number;
  subtotal_paise: number;
  mrp_total_paise: number;
  savings_paise: number;
  tax_paise: number;
  delivery_fee_paise: number;
  discount_paise: number;
  total_paise: number;
  free_delivery_threshold_paise: number;
  amount_to_free_delivery_paise: number;
  zone: null | { id: string; name: string; estimated_minutes: number; minimum_order_paise: number };
  delivery: { express: { available: boolean; estimated_minutes: number | null; reason: string | null }; scheduled: ScheduledOption[] };
  payment_methods: Record<PaymentMethod, { available: boolean; reason: string | null }>;
  problems: string[];
};

/** GST contained in a tax-inclusive amount, rounded to the nearest paisa. */
export function includedGst(amountPaise: number, rateBasisPoints: number): number {
  if (rateBasisPoints <= 0 || amountPaise <= 0) return 0;
  return Math.round((amountPaise * rateBasisPoints) / (10_000 + rateBasisPoints));
}

export function istParts(date: Date) {
  const shifted = new Date(date.getTime() + IST_OFFSET_MINUTES * 60_000);
  return { y: shifted.getUTCFullYear(), m: shifted.getUTCMonth(), d: shifted.getUTCDate(), minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes() };
}

/** Converts an IST calendar date + "HH:MM[:SS]" into an absolute instant. */
export function istInstant(y: number, m: number, d: number, time: string): Date {
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, d, hh, mm) - IST_OFFSET_MINUTES * 60_000);
}

function timeToMinutes(time: string): number {
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  return hh * 60 + mm;
}

function formatSlotLabel(start: string, end: string): string {
  const fmt = (time: string) => {
    const [h, m] = time.split(':').map(Number) as [number, number];
    const suffix = h >= 12 ? 'PM' : 'AM';
    const hour = h % 12 === 0 ? 12 : h % 12;
    return m ? `${hour}:${String(m).padStart(2, '0')} ${suffix}` : `${hour} ${suffix}`;
  };
  return `${fmt(start)} – ${fmt(end)}`;
}

type CartRow = {
  cart_item_id: string; product_id: string; variant_id: string | null; quantity: number; name: string; slug: string; sku: string;
  price_paise: number; mrp_paise: number | null; gst_rate_basis_points: number; hsn_code: string | null; image_url: string | null;
  product_visible: boolean; variant_label: string | null; variant_sku: string | null; variant_price: number | null; variant_mrp: number | null;
  variant_active: boolean | null; has_active_variants: boolean; stock: number;
};

const CART_ROW_COLUMNS = `p.name, p.slug, p.sku, p.price_paise, p.mrp_paise, p.gst_rate_basis_points, p.hsn_code,
            COALESCE((SELECT pi.image_url FROM product_images pi WHERE pi.product_id = p.id ORDER BY pi.sort_order, pi.created_at LIMIT 1), p.image_url) AS image_url,
            (p.is_active AND p.archived_at IS NULL AND (c.id IS NULL OR c.is_active) AND (sub.id IS NULL OR sub.is_active)) AS product_visible,
            pv.label AS variant_label, pv.sku AS variant_sku, pv.price_paise AS variant_price, pv.mrp_paise AS variant_mrp, pv.is_active AS variant_active,
            EXISTS (SELECT 1 FROM product_variants x WHERE x.product_id = p.id AND x.is_active) AS has_active_variants`;

export async function loadCartRows(db: Pool | PoolClient, userId: string, lockForUpdate = false): Promise<CartRow[]> {
  const result = await db.query<CartRow>(
    `SELECT ci.id AS cart_item_id, ci.product_id, ci.variant_id, ci.quantity, ${CART_ROW_COLUMNS},
            (CASE WHEN ci.variant_id IS NOT NULL THEN COALESCE(pv.quantity, 0) ELSE COALESCE(i.quantity, 0) END)::integer AS stock
       FROM carts cart
       JOIN cart_items ci ON ci.cart_id = cart.id
       JOIN products p ON p.id = ci.product_id
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN categories sub ON sub.id = p.subcategory_id
       LEFT JOIN product_variants pv ON pv.id = ci.variant_id
       LEFT JOIN inventory i ON i.product_id = p.id
      WHERE cart.user_id = $1
      ORDER BY ci.updated_at, ci.id ${lockForUpdate ? 'FOR UPDATE OF ci' : ''}`,
    [userId],
  );
  return result.rows;
}

export type GuestItem = { product_id: string; variant_id?: string | null | undefined; quantity: number };

/**
 * Prices a guest's device-stored cart with exactly the same rules as a saved cart. Nothing is written.
 * Lines whose product no longer exists are left out, so the client can drop them.
 */
export async function loadGuestRows(db: Pool | PoolClient, items: GuestItem[]): Promise<CartRow[]> {
  if (!items.length) return [];
  const result = await db.query<CartRow>(
    `SELECT 'guest-' || g.ord AS cart_item_id, g.product_id, g.variant_id, g.quantity, ${CART_ROW_COLUMNS},
            (CASE WHEN g.variant_id IS NOT NULL THEN COALESCE(pv.quantity, 0) ELSE COALESCE(i.quantity, 0) END)::integer AS stock
       FROM unnest($1::uuid[], $2::uuid[], $3::integer[]) WITH ORDINALITY AS g(product_id, variant_id, quantity, ord)
       JOIN products p ON p.id = g.product_id
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN categories sub ON sub.id = p.subcategory_id
       LEFT JOIN product_variants pv ON pv.id = g.variant_id AND pv.product_id = p.id
       LEFT JOIN inventory i ON i.product_id = p.id
      ORDER BY g.ord`,
    [items.map(item => item.product_id), items.map(item => item.variant_id ?? null), items.map(item => item.quantity)],
  );
  return result.rows;
}

export function priceLines(rows: CartRow[]): QuoteLine[] {
  return rows.map(row => {
    const unit = Number(row.variant_id ? row.variant_price : row.price_paise);
    const mrp = Math.max(Number(row.variant_id ? row.variant_mrp : row.mrp_paise ?? row.price_paise) || unit, unit);
    const quantity = Number(row.quantity);
    const stock = Number(row.stock);
    let issue: QuoteLine['issue'] = null;
    if (!row.product_visible || (row.variant_id && !row.variant_active)) issue = 'unavailable';
    else if (!row.variant_id && row.has_active_variants) issue = 'choose_variant';
    else if (stock < quantity) issue = 'insufficient_stock';
    const lineTotal = unit * quantity;
    return {
      cart_item_id: row.cart_item_id, product_id: row.product_id, variant_id: row.variant_id, slug: row.slug, name: row.name,
      variant_label: row.variant_label, sku: row.variant_sku ?? row.sku, image_url: row.image_url, thumb_url: thumbOf(row.image_url),
      unit_price_paise: unit, mrp_paise: mrp, quantity, line_total_paise: lineTotal,
      gst_rate_basis_points: Number(row.gst_rate_basis_points), tax_paise: includedGst(lineTotal, Number(row.gst_rate_basis_points)),
      hsn_code: row.hsn_code, max_quantity: Math.max(0, Math.min(stock, MAX_LINE_QUANTITY)), available: issue === null, issue,
    };
  });
}

type ZoneRow = { id: string; name: string; delivery_fee_paise: number; minimum_order_paise: number; estimated_minutes: number; cod_enabled: boolean; cod_limit_paise: number };
type SlotRow = { id: string; name: string; starts_at: string; ends_at: string; is_scheduled: boolean };

export async function findZone(db: Pool | PoolClient, postalCode: string): Promise<ZoneRow | null> {
  const result = await db.query<ZoneRow>(
    `SELECT id, name, delivery_fee_paise, minimum_order_paise, estimated_minutes, cod_enabled, cod_limit_paise
       FROM delivery_zones WHERE is_active AND $1 = ANY(postal_codes) ORDER BY delivery_fee_paise, name LIMIT 1`, [postalCode],
  );
  return result.rows[0] ?? null;
}

export async function deliveryOptions(db: Pool | PoolClient, zone: ZoneRow, settings: StoreSettings, now = new Date()) {
  const slots = await db.query<SlotRow>(
    `SELECT id, name, starts_at::text, ends_at::text, is_scheduled FROM delivery_time_slots
      WHERE is_active AND (zone_id = $1 OR zone_id IS NULL) ORDER BY sort_order, starts_at, name`, [zone.id],
  );
  const today = istParts(now);
  const expressWindows = slots.rows.filter(slot => !slot.is_scheduled);
  const withinWindow = expressWindows.length === 0 || expressWindows.some(slot => today.minutes >= timeToMinutes(slot.starts_at) && today.minutes < timeToMinutes(slot.ends_at));
  const express = !settings.delivery.express_enabled
    ? { available: false, estimated_minutes: null, reason: 'Express delivery is currently paused' }
    : withinWindow
      ? { available: true, estimated_minutes: zone.estimated_minutes, reason: null }
      : { available: false, estimated_minutes: null, reason: 'Deliver Now is available during store hours only' };

  const scheduled: ScheduledOption[] = [];
  const earliest = now.getTime() + settings.delivery.scheduled_lead_minutes * 60_000;
  for (let offset = 0; offset <= settings.delivery.scheduled_days_ahead; offset++) {
    const day = new Date(Date.UTC(today.y, today.m, today.d + offset));
    const [y, m, d] = [day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()];
    for (const slot of slots.rows.filter(row => row.is_scheduled)) {
      const start = istInstant(y, m, d, slot.starts_at);
      if (start.getTime() < earliest) continue;
      scheduled.push({
        slot_id: slot.id,
        date: `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
        label: `${slot.name} · ${formatSlotLabel(slot.starts_at, slot.ends_at)}`,
        starts_at: start.toISOString(),
        ends_at: istInstant(y, m, d, slot.ends_at).toISOString(),
      });
    }
  }
  return { express, scheduled };
}

export async function buildQuote(
  db: Pool | PoolClient,
  options: { userId: string | null; settings: StoreSettings; postalCode: string | null; onlinePaymentsAvailable: boolean; lock?: boolean; now?: Date; rows?: CartRow[] },
): Promise<Quote & { _zone: ZoneRow | null }> {
  const { settings } = options;
  const rows = options.rows ?? (options.userId ? await loadCartRows(db, options.userId, options.lock) : []);
  const lines = priceLines(rows);
  const available = lines.filter(line => line.available);
  const subtotal = available.reduce((sum, line) => sum + line.line_total_paise, 0);
  const mrpTotal = available.reduce((sum, line) => sum + line.mrp_paise * line.quantity, 0);
  const tax = available.reduce((sum, line) => sum + line.tax_paise, 0);
  const threshold = settings.delivery.free_delivery_threshold_paise;
  const problems: string[] = [];
  if (!lines.length) problems.push('CART_EMPTY');
  if (lines.some(line => !line.available)) problems.push('CART_HAS_UNAVAILABLE_ITEMS');

  const zone = options.postalCode ? await findZone(db, options.postalCode) : null;
  if (options.postalCode && !zone) problems.push('DELIVERY_UNAVAILABLE');
  const baseFee = zone ? Number(zone.delivery_fee_paise) : 0;
  const deliveryFee = subtotal > 0 && threshold > 0 && subtotal >= threshold ? 0 : baseFee;
  if (zone && subtotal < Number(zone.minimum_order_paise)) problems.push('MINIMUM_ORDER_NOT_MET');
  const total = subtotal + deliveryFee;

  const delivery = zone ? await deliveryOptions(db, zone, settings, options.now) : { express: { available: false, estimated_minutes: null, reason: 'Choose a delivery address' }, scheduled: [] };
  if (zone && !delivery.express.available && delivery.scheduled.length === 0) problems.push('NO_DELIVERY_SLOTS');

  const online = (enabled: boolean) => !options.onlinePaymentsAvailable
    ? { available: false, reason: 'Online payment is being set up. Please choose Cash on Delivery.' }
    : enabled ? { available: true, reason: null } : { available: false, reason: 'Not accepted at the moment' };
  const codLimit = Math.min(
    settings.payments.cod_limit_paise > 0 ? settings.payments.cod_limit_paise : Number.MAX_SAFE_INTEGER,
    zone && Number(zone.cod_limit_paise) > 0 ? Number(zone.cod_limit_paise) : Number.MAX_SAFE_INTEGER,
  );
  const cod = !settings.payments.cod ? { available: false, reason: 'Cash on Delivery is not available right now' }
    : zone && !zone.cod_enabled ? { available: false, reason: 'Cash on Delivery is not available for this PIN code' }
      : total > codLimit ? { available: false, reason: `Cash on Delivery is available for orders up to ₹${Math.floor(codLimit / 100)}` }
        : { available: true, reason: null };

  return {
    lines,
    item_count: lines.reduce((sum, line) => sum + line.quantity, 0),
    subtotal_paise: subtotal,
    mrp_total_paise: mrpTotal,
    savings_paise: Math.max(0, mrpTotal - subtotal),
    tax_paise: tax,
    delivery_fee_paise: deliveryFee,
    discount_paise: 0,
    total_paise: total,
    free_delivery_threshold_paise: threshold,
    amount_to_free_delivery_paise: threshold > 0 && subtotal < threshold ? threshold - subtotal : 0,
    zone: zone ? { id: zone.id, name: zone.name, estimated_minutes: Number(zone.estimated_minutes), minimum_order_paise: Number(zone.minimum_order_paise) } : null,
    delivery,
    payment_methods: {
      upi: online(settings.payments.upi),
      card: online(settings.payments.card),
      net_banking: online(settings.payments.net_banking),
      wallet: online(settings.payments.wallet),
      cod,
    },
    problems,
    _zone: zone,
  };
}

export function publicQuote(quote: Quote & { _zone?: unknown }): Quote {
  const { _zone, ...rest } = quote;
  void _zone;
  return rest;
}
