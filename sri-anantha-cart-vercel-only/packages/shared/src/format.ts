import type { OrderStatus, PaymentMethod, PaymentStatus, StockStatus, TimelineEntry } from '@sac/contracts';

const TIME_ZONE = 'Asia/Kolkata';
const rupeeFormatter = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 0 });

/** "₹ 199", "₹ 1,249.50" — the spacing used throughout the client designs. */
export function formatRupees(paise: number | string | null | undefined): string {
  const value = Number(paise ?? 0) / 100;
  const hasFraction = Math.round(value * 100) % 100 !== 0;
  return `₹ ${hasFraction ? value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : rupeeFormatter.format(value)}`;
}

export function discountPercent(pricePaise: number, mrpPaise: number): number {
  if (!mrpPaise || mrpPaise <= pricePaise) return 0;
  return Math.round(((mrpPaise - pricePaise) / mrpPaise) * 100);
}

export function formatDate(value: string | Date): string {
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: TIME_ZONE }).format(new Date(value));
}

export function formatTime(value: string | Date): string {
  return new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: TIME_ZONE }).format(new Date(value)).toUpperCase();
}

/** "12 Oct 2026, 10:30 AM" as shown on order cards. */
export function formatDateTime(value: string | Date): string {
  return `${formatDate(value)}, ${formatTime(value)}`;
}

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  pending_payment: 'Awaiting Payment',
  placed: 'Pending',
  accepted: 'Accepted',
  packed: 'Packed',
  dispatched: 'Out for Delivery',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
  return_requested: 'Return Requested',
  refund_initiated: 'Refund Initiated',
  refund_completed: 'Refunded',
  refunded: 'Refunded',
};

/** Customer-facing wording differs slightly from the operations wording. */
export const CUSTOMER_STATUS_LABELS: Record<OrderStatus, string> = {
  ...ORDER_STATUS_LABELS,
  placed: 'Confirmed',
  accepted: 'Processing',
  packed: 'Processing',
};

export type StatusTone = 'success' | 'warning' | 'info' | 'danger' | 'neutral' | 'purple';
export const ORDER_STATUS_TONES: Record<OrderStatus, StatusTone> = {
  pending_payment: 'neutral', placed: 'warning', accepted: 'info', packed: 'purple', dispatched: 'warning', delivered: 'success',
  cancelled: 'danger', return_requested: 'warning', refund_initiated: 'info', refund_completed: 'neutral', refunded: 'neutral',
};

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  upi: 'UPI', card: 'Card', net_banking: 'Net Banking', wallet: 'Wallet', cod: 'Cash on Delivery',
};

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  pending: 'Pending', paid: 'Paid', failed: 'Failed', cancelled: 'Cancelled', refund_pending: 'Refund Pending', refunded: 'Refunded',
};

/** "Paid (UPI)", "COD", "Paid (Card)" as in the admin recent-orders table. */
export function paymentSummary(method: PaymentMethod | null, status: PaymentStatus): string {
  if (method === 'cod') return status === 'paid' ? 'COD (Collected)' : 'COD';
  const label = method ? PAYMENT_METHOD_LABELS[method] : 'Online';
  return `${PAYMENT_STATUS_LABELS[status]} (${label})`;
}

export const STOCK_LABELS: Record<StockStatus, string> = { in_stock: 'In Stock', low_stock: 'Only a few left', out_of_stock: 'Out of Stock' };

export type TrackingStep = { key: 'confirmed' | 'preparing' | 'out_for_delivery' | 'delivered'; label: string; state: 'done' | 'current' | 'upcoming'; at: string | null; expected: string | null };

/** Four-step customer timeline used on confirmation and tracking screens. */
export function trackingSteps(status: OrderStatus, timeline: TimelineEntry[], estimatedDeliveryAt: string | null): TrackingStep[] {
  const firstAt = (statuses: OrderStatus[]) => timeline.find(entry => statuses.includes(entry.status))?.created_at ?? null;
  const reached = {
    confirmed: firstAt(['placed', 'accepted', 'packed', 'dispatched', 'delivered']),
    preparing: firstAt(['accepted', 'packed', 'dispatched', 'delivered']),
    out_for_delivery: firstAt(['dispatched', 'delivered']),
    delivered: firstAt(['delivered']),
  };
  const order: TrackingStep['key'][] = ['confirmed', 'preparing', 'out_for_delivery', 'delivered'];
  const labels = { confirmed: 'Order Confirmed', preparing: 'Preparing Items', out_for_delivery: 'Out for Delivery', delivered: 'Delivered' };
  const lastDone = order.reduce((index, key, i) => (reached[key] ? i : index), -1);
  const finished = ['delivered', 'return_requested', 'refund_initiated', 'refund_completed', 'refunded'].includes(status);
  return order.map((key, index) => ({
    key,
    label: labels[key],
    at: reached[key],
    state: index <= lastDone ? 'done' : index === lastDone + 1 && !finished && status !== 'cancelled' ? 'current' : 'upcoming',
    expected: !reached[key] && (key === 'delivered' || key === 'out_for_delivery') && estimatedDeliveryAt ? estimatedDeliveryAt : null,
  }));
}

/** Normalises a 10-digit Indian mobile number to E.164, or returns null. */
export function normalizeIndianMobile(input: string): string | null {
  const digits = input.replace(/[\s()-]/g, '').replace(/^\+91/, '').replace(/^91(?=\d{10}$)/, '').replace(/^0(?=\d{10}$)/, '');
  return /^[6-9]\d{9}$/.test(digits) ? `+91${digits}` : null;
}

export function formatPhone(e164: string | null | undefined): string {
  if (!e164) return '';
  const match = /^\+91(\d{5})(\d{5})$/.exec(e164);
  return match ? `+91 ${match[1]} ${match[2]}` : e164;
}

export const isValidPostalCode = (value: string) => /^[1-9][0-9]{5}$/.test(value.trim());

export function formatAddressLine(address: { line1: string; line2?: string | null; locality: string; city: string; postal_code: string; state?: string }): string {
  return [address.line1, address.line2, address.locality, `${address.city} - ${address.postal_code}`, address.state].filter(Boolean).join(', ');
}
