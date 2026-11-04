'use client';

import { type OrderStatus, type PaymentMethod, type PaymentStatus } from '@sac/contracts';
import { formatAddressLine, formatDateTime, formatPhone, formatRupees, paymentSummary } from '@sac/shared';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { adminError, useAdmin } from '@/components/admin/AdminProvider';
import { EmptyRow, OrderStatusBadge } from '@/components/admin/ui';
import { Modal } from '@sac/ui-web';

type Customer = {
  id: string; phone_e164: string | null; display_name: string | null; email: string | null; email_verified: boolean; google_linked: boolean; is_active: boolean; blocked_at: string | null; created_at: string;
  addresses: { id: string; label: string | null; recipient_name: string; phone_e164: string; line1: string; line2: string | null; locality: string; city: string; state: string; postal_code: string; is_default: boolean }[];
  orders: { id: string; display_number: string; status: OrderStatus; payment_status: PaymentStatus; payment_method: PaymentMethod | null; total_paise: number; created_at: string }[];
  account_events: { action: string; reason: string | null; created_at: string }[];
};

export default function CustomerPage() {
  const { id } = useParams<{ id: string }>();
  const { request, toast, isAdmin } = useAdmin();
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { setCustomer((await request<{ data: Customer }>(`/api/v1/admin/customers/${id}`)).data); } catch (error) { toast(adminError(error), 'error'); }
  }, [request, id, toast]);
  useEffect(() => { void load(); }, [load]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!customer) return;
    setBusy(true);
    try {
      await request(`/api/v1/admin/customers/${id}/status`, { method: 'PATCH', body: { blocked: customer.is_active, ...(reason.trim() ? { reason: reason.trim() } : {}) } });
      toast(customer.is_active ? 'Customer blocked and signed out' : 'Customer unblocked', 'success'); setConfirming(false); setReason(''); await load();
    } catch (error) { toast(adminError(error), 'error'); } finally { setBusy(false); }
  };

  if (!customer) return <div className="skeleton" style={{ height: 400 }} />;
  const spent = customer.orders.filter(order => order.payment_status === 'paid').reduce((sum, order) => sum + order.total_paise, 0);
  return (
    <>
      <Link href="/admin/customers" className="link-red" style={{ marginBottom: 12 }}><ArrowLeft size={16} /> All customers</Link>
      <div className="admin-page-head">
        <div><h1>{customer.display_name ?? 'Unnamed customer'}</h1><p>Customer since {formatDateTime(customer.created_at)}</p></div>
        <div className="admin-actions">
          {customer.is_active ? <span className="badge badge-success">Active</span> : <span className="badge badge-danger">Blocked</span>}
          {isAdmin && <button type="button" className={`btn ${customer.is_active ? 'btn-outline' : 'btn-primary'} btn-sm`} onClick={() => setConfirming(true)}>{customer.is_active ? 'Block customer' : 'Unblock customer'}</button>}
        </div>
      </div>
      <div className="form-layout">
        <div style={{ display: 'grid', gap: 16 }}>
          <section className="panel"><div className="panel-head"><h2 className="sans">Order history ({customer.orders.length})</h2></div><div className="panel-body table-wrap">
            <table className="table"><thead><tr><th>Order</th><th>Date</th><th className="num">Amount</th><th>Payment</th><th>Status</th></tr></thead>
              <tbody>{customer.orders.length === 0 ? <EmptyRow colSpan={5} text="No orders yet" /> : customer.orders.map(order => (
                <tr key={order.id}><td><Link className="row-link" href={`/admin/orders/${order.id}`}>#{order.display_number}</Link></td><td>{formatDateTime(order.created_at)}</td><td className="num">{formatRupees(order.total_paise)}</td><td>{paymentSummary(order.payment_method, order.payment_status)}</td><td><OrderStatusBadge status={order.status} /></td></tr>
              ))}</tbody></table>
          </div></section>
          <section className="panel"><div className="panel-head"><h2 className="sans">Saved addresses ({customer.addresses.length})</h2></div><div className="panel-body" style={{ display: 'grid', gap: 10 }}>
            {customer.addresses.length === 0 ? <p className="muted">No saved addresses.</p> : customer.addresses.map(address => (
              <div key={address.id} className="box" style={{ padding: 12 }}><strong>{address.label ? `${address.label} · ` : ''}{address.recipient_name}</strong>{address.is_default && <span className="badge badge-success" style={{ marginLeft: 8 }}>Default</span>}<p className="muted" style={{ margin: '4px 0 0' }}>{formatAddressLine(address)} · {formatPhone(address.phone_e164)}</p></div>
            ))}
          </div></section>
        </div>
        <div className="sticky-actions">
          <section className="panel"><div className="panel-head"><h2 className="sans">Profile</h2></div><div className="panel-body">
            <dl className="kv-grid">
              <dt>Phone</dt><dd>{customer.phone_e164 ? formatPhone(customer.phone_e164) : '—'}</dd>
              <dt>Email</dt><dd>{customer.email ?? '—'}{customer.email && (customer.email_verified ? ' ✓' : ' (unverified)')}</dd>
              <dt>Google</dt><dd>{customer.google_linked ? 'Linked' : 'Not linked'}</dd>
              <dt>Orders</dt><dd>{customer.orders.length}</dd>
              <dt>Total spent</dt><dd>{formatRupees(spent)}</dd>
            </dl>
          </div></section>
          {customer.account_events.length > 0 && <section className="panel"><div className="panel-head"><h2 className="sans">Account history</h2></div><div className="panel-body"><ol className="timeline">{customer.account_events.map((event, index) => <li key={index}><span><strong>{event.action}</strong><small>{formatDateTime(event.created_at)}{event.reason ? ` · ${event.reason}` : ''}</small></span></li>)}</ol></div></section>}
        </div>
      </div>
      {confirming && (
        <Modal title={customer.is_active ? 'Block customer' : 'Unblock customer'} onClose={() => setConfirming(false)}>
          <form onSubmit={submit}>
            <div className="modal-body">
              <p className="muted" style={{ margin: 0 }}>{customer.is_active ? 'Blocking signs the customer out everywhere and prevents new sign-ins and orders.' : 'The customer will be able to sign in and order again.'}</p>
              <label className="field"><span>Reason (internal)</span><textarea className="textarea" value={reason} onChange={event => setReason(event.target.value)} maxLength={300} /></label>
            </div>
            <div className="modal-foot"><button type="button" className="btn btn-ghost" onClick={() => setConfirming(false)}>Cancel</button><button type="submit" className="btn btn-primary" disabled={busy}>{customer.is_active ? 'Block' : 'Unblock'}</button></div>
          </form>
        </Modal>
      )}
    </>
  );
}
