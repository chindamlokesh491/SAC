'use client';

import { type OrderStatus, type PaymentMethod, type PaymentStatus } from '@sac/contracts';
import { newIdempotencyKey } from '@sac/api-client';
import { formatAddressLine, formatDateTime, formatPhone, formatRupees, ORDER_STATUS_LABELS, PAYMENT_METHOD_LABELS, PAYMENT_STATUS_LABELS } from '@sac/shared';
import { ArrowLeft, Check, FileText, Phone, X } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { adminError, useAdmin } from '@/components/admin/AdminProvider';
import { OrderStatusBadge } from '@/components/admin/ui';
import { DeliveryAssignmentPanel } from '@/components/admin/DeliveryAssignmentPanel';
import { Modal } from '@sac/ui-web';

type Detail = {
  id: string; display_number: string; status: OrderStatus; payment_status: PaymentStatus; payment_method: PaymentMethod | null; created_at: string;
  subtotal_paise: number; delivery_fee_paise: number; tax_paise: number; discount_paise: number; total_paise: number; delivery_mode: string | null;
  delivery_slot_start: string | null; delivery_slot_end: string | null; estimated_delivery_at: string | null; zone_name: string | null; fulfilment_provider: string | null;
  customer_id: string; customer_name: string | null; customer_phone: string; customer_email: string | null; checkout_email: string | null;
  cancellation_reason: string | null; return_reason: string | null; return_status: string | null;
  address: { recipient_name: string; phone_e164: string; line1: string; line2: string | null; locality: string; city: string; state: string; postal_code: string; delivery_instructions: string | null; label: string | null };
  items: { id: string; name: string; variant_label: string | null; sku: string; quantity: number; unit_price_paise: number; line_total_paise: number; gst_rate_basis_points: number; tax_paise: number; thumb_url: string | null }[];
  payments: { id: string; provider: string; payment_method: string | null; status: string; amount_paise: number; provider_transaction_id: string | null; provider_reference: string | null; verified_at: string | null }[];
  refunds: { id: string; amount_paise: number; reason: string; status: string; method: string; created_at: string }[];
  timeline: { status: OrderStatus; payment_status: PaymentStatus; created_at: string }[];
  actions: { next_status: string | null; awaiting_delivery_partner?: boolean; can_cancel: boolean; can_decide_return: boolean; can_refund: boolean; refundable_paise: number; collect_cash_on_delivery: boolean };
};

const NEXT_LABEL: Record<string, string> = { accepted: 'Accept Order', packed: 'Mark as Packed', dispatched: 'Mark Out for Delivery', delivered: 'Mark as Delivered' };

export default function AdminOrderPage() {
  const { id } = useParams<{ id: string }>();
  const { request, toast, isAdmin, refreshNotifications } = useAdmin();
  const [order, setOrder] = useState<Detail | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<null | 'cancel' | 'refund'>(null);
  const [reason, setReason] = useState('');
  const [amount, setAmount] = useState('');
  const [refundKey, setRefundKey] = useState('');

  const load = useCallback(async () => {
    try { setOrder((await request<{ data: Detail }>(`/api/v1/admin/orders/${id}`)).data); }
    catch (error) { toast(adminError(error), 'error'); }
  }, [request, id, toast]);
  useEffect(() => { void load(); }, [load]);

  const act = async (work: () => Promise<unknown>, success: string) => {
    setBusy(true);
    try { await work(); toast(success, 'success'); setDialog(null); setReason(''); await load(); void refreshNotifications(); }
    catch (error) { toast(adminError(error), 'error'); }
    finally { setBusy(false); }
  };
  const advance = (status: string) => {
    if (status === 'delivered' && order?.actions.collect_cash_on_delivery && !window.confirm(`Confirm the order was delivered and ${formatRupees(order.total_paise)} cash was collected?`)) return;
    void act(() => request(`/api/v1/admin/orders/${id}/status`, { method: 'PATCH', body: { status } }), `Order marked ${ORDER_STATUS_LABELS[status as OrderStatus]}`);
  };
  const submitCancel = (event: FormEvent) => { event.preventDefault(); void act(() => request(`/api/v1/admin/orders/${id}/cancel`, { method: 'POST', body: { reason: reason.trim() } }), 'Order cancelled and stock restored'); };
  const submitRefund = (event: FormEvent) => {
    event.preventDefault();
    const paise = Math.round(Number(amount) * 100);
    if (!Number.isFinite(paise) || paise <= 0) { toast('Enter a valid refund amount', 'error'); return; }
    void act(() => request(`/api/v1/admin/orders/${id}/refunds`, { method: 'POST', body: { amount_paise: paise, reason: reason.trim() }, headers: { 'idempotency-key': refundKey } }), 'Refund recorded');
  };

  if (!order) return <div className="skeleton" style={{ height: 500 }} />;
  const a = order.actions;
  const payment = order.payments[0];
  return (
    <>
      <Link href="/admin/orders" className="link-red" style={{ marginBottom: 12 }}><ArrowLeft size={16} /> All orders</Link>
      <div className="admin-page-head">
        <div><h1>Order #{order.display_number}</h1><p>Placed {formatDateTime(order.created_at)} · {order.payment_method ? PAYMENT_METHOD_LABELS[order.payment_method] : '—'} · {PAYMENT_STATUS_LABELS[order.payment_status]}</p></div>
        <div className="admin-actions"><OrderStatusBadge status={order.status} /><Link href={`/admin/orders/${order.id}/invoice`} className="btn btn-ghost btn-sm"><FileText size={16} /> Invoice</Link></div>
      </div>
      <div className="form-layout">
        <div style={{ display: 'grid', gap: 16 }}>
          <section className="panel">
            <div className="panel-head"><h2 className="sans">Items ({order.items.reduce((sum, item) => sum + item.quantity, 0)})</h2></div>
            <div className="panel-body table-wrap">
              <table className="table">
                <thead><tr><th>Product</th><th>SKU</th><th className="num">Qty</th><th className="num">Price</th><th className="num">GST</th><th className="num">Total</th></tr></thead>
                <tbody>
                  {order.items.map(item => (
                    <tr key={item.id}>
                      <td><span className="prod">{item.thumb_url && <img src={item.thumb_url} alt="" width={36} height={36} />}<span>{item.name}{item.variant_label && <small>{item.variant_label}</small>}</span></span></td>
                      <td>{item.sku}</td><td className="num">{item.quantity}</td><td className="num">{formatRupees(item.unit_price_paise)}</td>
                      <td className="num">{item.gst_rate_basis_points / 100}% · {formatRupees(item.tax_paise)}</td><td className="num"><strong>{formatRupees(item.line_total_paise)}</strong></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ maxWidth: 320, marginLeft: 'auto', marginTop: 10 }}>
                <div className="kv"><span>Item total</span><span>{formatRupees(order.subtotal_paise)}</span></div>
                <div className="kv"><span>Delivery charge</span><span>{formatRupees(order.delivery_fee_paise)}</span></div>
                <div className="kv"><span>GST included</span><span>{formatRupees(order.tax_paise)}</span></div>
                {order.discount_paise > 0 && <div className="kv"><span>Discount</span><span>− {formatRupees(order.discount_paise)}</span></div>}
                <div className="kv total"><span>Total payable</span><span>{formatRupees(order.total_paise)}</span></div>
              </div>
            </div>
          </section>
          <div className="dash-grid cols-2" style={{ marginBottom: 0 }}>
            <section className="panel"><div className="panel-head"><h2 className="sans">Customer</h2></div><div className="panel-body">
              <dl className="kv-grid">
                <dt>Name</dt><dd><Link className="link-red" href={`/admin/customers/${order.customer_id}`}>{order.customer_name ?? order.address.recipient_name}</Link></dd>
                <dt>Mobile</dt><dd><a href={`tel:${order.customer_phone}`}><Phone size={14} /> {formatPhone(order.customer_phone)}</a></dd>
                {(order.customer_email ?? order.checkout_email) && <><dt>Email</dt><dd>{order.customer_email ?? order.checkout_email}</dd></>}
              </dl>
            </div></section>
            <section className="panel"><div className="panel-head"><h2 className="sans">Delivery</h2></div><div className="panel-body">
              <p style={{ margin: 0 }}><strong>{order.address.recipient_name}</strong> · {formatPhone(order.address.phone_e164)}</p>
              <p className="muted" style={{ margin: '4px 0' }}>{formatAddressLine(order.address)}</p>
              {order.address.delivery_instructions && <p style={{ margin: '4px 0', fontSize: 13.5 }}>Note: {order.address.delivery_instructions}</p>}
              <p style={{ margin: '8px 0 0', fontSize: 14 }}><strong>{order.delivery_mode === 'scheduled' ? 'Scheduled slot' : 'Deliver Now'}</strong>{order.delivery_slot_start ? `: ${formatDateTime(order.delivery_slot_start)} – ${order.delivery_slot_end ? formatDateTime(order.delivery_slot_end).split(', ')[1] : ''}` : order.estimated_delivery_at ? ` · ETA ${formatDateTime(order.estimated_delivery_at)}` : ''}{order.zone_name ? ` · ${order.zone_name}` : ''}</p>
            </div></section>
          </div>
          <DeliveryAssignmentPanel orderId={order.id} fulfilmentProvider={order.fulfilment_provider} orderStatus={order.status} />
          <section className="panel"><div className="panel-head"><h2 className="sans">Payment</h2></div><div className="panel-body">
            {payment ? (
              <dl className="kv-grid">
                <dt>Method</dt><dd>{payment.provider === 'cod' ? 'Cash on Delivery' : `${payment.payment_method ? PAYMENT_METHOD_LABELS[payment.payment_method as PaymentMethod] : 'Online'} via Razorpay`}</dd>
                <dt>Status</dt><dd>{payment.status}{payment.verified_at ? ` · ${payment.provider === 'cod' ? 'collected' : 'verified'} ${formatDateTime(payment.verified_at)}` : ''}</dd>
                <dt>Amount</dt><dd>{formatRupees(payment.amount_paise)}</dd>
                {payment.provider_transaction_id && <><dt>Transaction ID</dt><dd>{payment.provider_transaction_id}</dd></>}
                {payment.provider_reference && <><dt>Gateway reference</dt><dd>{payment.provider_reference}</dd></>}
              </dl>
            ) : <p className="muted">No payment record.</p>}
            {order.refunds.length > 0 && (
              <table className="table" style={{ marginTop: 14 }}>
                <thead><tr><th>Refund</th><th>Method</th><th>Status</th><th>Reason</th><th>Date</th></tr></thead>
                <tbody>{order.refunds.map(refund => <tr key={refund.id}><td>{formatRupees(refund.amount_paise)}</td><td>{refund.method}</td><td>{refund.status}</td><td className="wrap">{refund.reason}</td><td>{formatDateTime(refund.created_at)}</td></tr>)}</tbody>
              </table>
            )}
          </div></section>
        </div>
        <div className="sticky-actions">
          <section className="panel"><div className="panel-head"><h2 className="sans">Actions</h2></div><div className="panel-body order-actions">
            {a.next_status && <button type="button" className="btn btn-primary btn-block" disabled={busy} onClick={() => advance(a.next_status!)}><Check size={18} /> {a.next_status === 'delivered' && a.collect_cash_on_delivery ? `Delivered · Cash ${formatRupees(order.total_paise)} collected` : NEXT_LABEL[a.next_status]}</button>}
            {a.can_cancel && <button type="button" className="btn btn-outline btn-block" disabled={busy} onClick={() => setDialog('cancel')}><X size={18} /> {order.status === 'placed' ? 'Reject Order' : 'Cancel Order'}</button>}
            {a.can_decide_return && isAdmin && <Link href="/admin/returns" className="btn btn-outline btn-block">Review Return Request &amp; Evidence</Link>}
            {a.can_refund && isAdmin && (!order.return_reason || order.return_status === 'received') && <button type="button" className="btn btn-ghost btn-block" disabled={busy} onClick={() => { setAmount((a.refundable_paise / 100).toFixed(2)); setRefundKey(newIdempotencyKey()); setDialog('refund'); }}>Record Refund</button>}
            {a.awaiting_delivery_partner && <p className="alert alert-info" style={{ margin: 0 }} data-testid="awaiting-partner">{order.status === 'packed' ? 'Packed. The assigned delivery partner marks pickup in the partner app, which dispatches the order.' : 'Out for delivery. The delivery partner completes it with the delivery code from the customer and records any cash.'}</p>}
            {!a.next_status && !a.awaiting_delivery_partner && !a.can_cancel && !a.can_decide_return && !a.can_refund && <p className="muted" style={{ margin: 0 }}>No further actions for this order.</p>}
            {order.cancellation_reason && <p className="alert alert-danger" style={{ margin: 0 }}>Cancelled: {order.cancellation_reason}</p>}
            {order.return_reason && <p className="alert alert-warning" style={{ margin: 0 }}>Return reason: {order.return_reason}</p>}
          </div></section>
          <section className="panel"><div className="panel-head"><h2 className="sans">Timeline</h2></div><div className="panel-body">
            <ol className="timeline">{order.timeline.map((entry, index) => <li key={index}><span><strong>{ORDER_STATUS_LABELS[entry.status]}</strong><small>{formatDateTime(entry.created_at)} · payment {PAYMENT_STATUS_LABELS[entry.payment_status].toLowerCase()}</small></span></li>)}</ol>
          </div></section>
        </div>
      </div>

      {dialog === 'cancel' && (
        <Modal title={order.status === 'placed' ? 'Reject order' : 'Cancel order'} onClose={() => setDialog(null)}>
          <form onSubmit={submitCancel}>
            <div className="modal-body">
              <p className="muted" style={{ margin: 0 }}>Stock is returned to inventory automatically.{order.payment_status === 'paid' ? ' This order was paid — record a refund afterwards.' : ''}</p>
              <label className="field"><span>Reason (shared with the customer)</span><textarea className="textarea" value={reason} onChange={event => setReason(event.target.value)} minLength={3} maxLength={300} required /></label>
            </div>
            <div className="modal-foot"><button type="button" className="btn btn-ghost" onClick={() => setDialog(null)}>Keep order</button><button type="submit" className="btn btn-primary" disabled={busy || reason.trim().length < 3}>Confirm</button></div>
          </form>
        </Modal>
      )}
      {dialog === 'refund' && (
        <Modal title="Record refund" onClose={() => setDialog(null)}>
          <form onSubmit={submitRefund}>
            <div className="modal-body">
              <p className="muted" style={{ margin: 0 }}>{payment?.provider === 'cod' ? 'Cash-on-delivery refunds are paid manually (UPI / bank transfer). Mark the refund completed from Payments & Refunds once paid.' : 'Gateway refunds are submitted from Payments & Refunds after this record is created.'}</p>
              <label className="field"><span>Amount (₹) — up to {formatRupees(a.refundable_paise)}</span><input className="input" inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value.replace(/[^\d.]/g, ''))} required /></label>
              <label className="field"><span>Reason</span><textarea className="textarea" value={reason} onChange={event => setReason(event.target.value)} minLength={3} maxLength={300} required /></label>
            </div>
            <div className="modal-foot"><button type="button" className="btn btn-ghost" onClick={() => setDialog(null)}>Cancel</button><button type="submit" className="btn btn-primary" disabled={busy || reason.trim().length < 3}>Record refund</button></div>
          </form>
        </Modal>
      )}
    </>
  );
}
