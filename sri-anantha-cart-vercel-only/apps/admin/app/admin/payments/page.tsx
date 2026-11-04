'use client';

import { type PaymentMethod } from '@sac/contracts';
import { formatDateTime, formatRupees, PAYMENT_METHOD_LABELS } from '@sac/shared';
import { AlertTriangle, IndianRupee, RotateCcw, Wallet } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState, type FormEvent } from 'react';
import { adminError, useAdmin } from '@/components/admin/AdminProvider';
import { EmptyRow, Kpi, LoadingRows, Pager } from '@/components/admin/ui';
import { Modal } from '@sac/ui-web';

type Payment = { id: string; order_id: string; display_number: string; provider: string; payment_method: PaymentMethod | null; status: string; amount_paise: number; provider_transaction_id: string | null; provider_reference: string | null; verified_at: string | null; refund_amount_paise: number | null; created_at: string; customer_name: string | null };
type Refund = { id: string; order_id: string; display_number: string; amount_paise: number; reason: string; status: string; method: string; payment_method: string | null; provider_status: string | null; provider_refund_id: string | null; provider_transaction_id: string | null; created_at: string };
const STATUS_TONE: Record<string, string> = { succeeded: 'success', pending: 'warning', created: 'warning', failed: 'danger', cancelled: 'neutral', refund_pending: 'info', refunded: 'neutral', completed: 'success', initiated: 'warning', processing: 'info' };
const LIMIT = 20;

function Payments() {
  const { request, toast, isAdmin, refreshNotifications } = useAdmin();
  const params = useSearchParams();
  const [tab, setTab] = useState(params.get('tab') === 'refunds' ? 'refunds' : 'payments');
  const [payments, setPayments] = useState<Payment[] | null>(null);
  const [summary, setSummary] = useState<{ collected_paise: number; cod_due_paise: number; failed_count: number; refunds_paise: number } | null>(null);
  const [capabilities, setCapabilities] = useState<{ online_payments_configured: boolean; razorpay_refunds_enabled: boolean } | null>(null);
  const [refunds, setRefunds] = useState<Refund[] | null>(null);
  const [filters, setFilters] = useState({ status: '', method: '', search: '' });
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [completing, setCompleting] = useState<Refund | null>(null);
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);

  const loadPayments = useCallback(async () => {
    setPayments(null);
    try {
      const result = await request<{ data: Payment[]; summary: typeof summary; pagination: { total: number }; capabilities: typeof capabilities }>('/api/v1/admin/payments', { query: { ...filters, search: filters.search.trim(), limit: LIMIT, offset } });
      setPayments(result.data); setSummary(result.summary); setTotal(result.pagination.total); setCapabilities(result.capabilities);
    } catch (error) { toast(adminError(error), 'error'); setPayments([]); }
  }, [request, toast, filters, offset]);
  const loadRefunds = useCallback(async () => {
    setRefunds(null);
    try { setRefunds((await request<{ data: Refund[] }>('/api/v1/admin/refunds', { query: { limit: 100 } })).data); }
    catch (error) { toast(adminError(error), 'error'); setRefunds([]); }
  }, [request, toast]);
  useEffect(() => { if (tab === 'payments') { const timer = window.setTimeout(() => void loadPayments(), filters.search ? 300 : 0); return () => window.clearTimeout(timer); } void loadRefunds(); return undefined; }, [tab, loadPayments, loadRefunds, filters.search]);

  const updateRefund = async (refund: Refund, status: 'processing' | 'completed' | 'failed', providerReference?: string) => {
    setBusy(true);
    try {
      await request(`/api/v1/admin/refunds/${refund.id}/status`, { method: 'PATCH', body: { status, ...(providerReference ? { provider_transaction_id: providerReference } : {}) } });
      toast(`Refund marked ${status}`, 'success'); setCompleting(null); setReference(''); await loadRefunds(); void refreshNotifications();
    } catch (error) { toast(adminError(error), 'error'); } finally { setBusy(false); }
  };
  const gatewayAction = async (refund: Refund, action: 'execute' | 'reconcile') => {
    setBusy(true);
    try { await request(`/api/v1/admin/refunds/${refund.id}/${action}`, { method: 'POST' }); toast(action === 'execute' ? 'Refund submitted to gateway' : 'Refund status refreshed', 'success'); await loadRefunds(); }
    catch (error) { toast(adminError(error), 'error'); } finally { setBusy(false); }
  };
  const complete = (event: FormEvent) => { event.preventDefault(); if (completing) void updateRefund(completing, 'completed', reference.trim()); };

  return (
    <>
      <div className="admin-page-head"><div><h1>Payments &amp; Refunds</h1><p>Payment tracking for every order, cash-on-delivery collections and refunds.</p></div></div>
      {capabilities && !capabilities.online_payments_configured && <div className="alert alert-info" style={{ marginBottom: 14 }}>Online payment gateway credentials are not configured yet — customers can currently pay by Cash on Delivery only.</div>}
      {summary && (
        <div className="kpi-grid cols-4">
          <Kpi icon={IndianRupee} tone="green" label="Collected" value={summary.collected_paise} format={formatRupees} note="Verified online + COD collected" />
          <Kpi icon={Wallet} tone="orange" label="COD to collect" value={summary.cod_due_paise} format={formatRupees} note="Open cash-on-delivery orders" />
          <Kpi icon={AlertTriangle} tone="red" label="Failed payments" value={summary.failed_count} note="All time" />
          <Kpi icon={RotateCcw} tone="blue" label="Refunds" value={summary.refunds_paise} format={formatRupees} note="Pending + completed" />
        </div>
      )}
      <section className="panel">
        <div className="status-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'payments'} onClick={() => setTab('payments')}>Payments</button>
          <button type="button" role="tab" aria-selected={tab === 'refunds'} onClick={() => setTab('refunds')}>Refunds</button>
        </div>
        {tab === 'payments' ? (
          <>
            <div className="toolbar">
              <input className="input grow" type="search" placeholder="Order ID or transaction ID" value={filters.search} onChange={event => { setFilters({ ...filters, search: event.target.value }); setOffset(0); }} aria-label="Search payments" />
              <select className="select" value={filters.status} onChange={event => { setFilters({ ...filters, status: event.target.value }); setOffset(0); }} aria-label="Payment status">
                <option value="">All statuses</option>{['pending', 'succeeded', 'failed', 'cancelled', 'refund_pending', 'refunded'].map(value => <option key={value} value={value}>{value.replace('_', ' ')}</option>)}
              </select>
              <select className="select" value={filters.method} onChange={event => { setFilters({ ...filters, method: event.target.value }); setOffset(0); }} aria-label="Payment method">
                <option value="">All methods</option>{(['cod', 'upi', 'card', 'net_banking', 'wallet'] as PaymentMethod[]).map(value => <option key={value} value={value}>{PAYMENT_METHOD_LABELS[value]}</option>)}
              </select>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Order</th><th>Customer</th><th>Method</th><th className="num">Amount</th><th>Status</th><th>Transaction ID</th><th>Gateway ref.</th><th>Date</th></tr></thead>
                <tbody>{payments === null ? <LoadingRows colSpan={8} /> : payments.length === 0 ? <EmptyRow colSpan={8} text="No payments found" /> : payments.map(payment => (
                  <tr key={payment.id}>
                    <td><Link className="row-link" href={`/admin/orders/${payment.order_id}`}>#{payment.display_number}</Link></td><td>{payment.customer_name ?? '—'}</td>
                    <td>{payment.payment_method ? PAYMENT_METHOD_LABELS[payment.payment_method] : '—'}{payment.provider === 'razorpay' ? ' · Razorpay' : ''}</td>
                    <td className="num">{formatRupees(payment.amount_paise)}</td>
                    <td><span className={`badge badge-${STATUS_TONE[payment.status] ?? 'neutral'}`}>{payment.provider === 'cod' && payment.status === 'pending' ? 'to collect' : payment.provider === 'cod' && payment.status === 'succeeded' ? 'collected' : payment.status.replace('_', ' ')}</span></td>
                    <td>{payment.provider_transaction_id ?? '—'}</td><td>{payment.provider_reference ?? '—'}</td><td>{formatDateTime(payment.created_at)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <Pager offset={offset} limit={LIMIT} total={total} onChange={setOffset} />
          </>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Order</th><th className="num">Amount</th><th>Method</th><th>Status</th><th>Reason</th><th>Reference</th><th>Created</th><th>Actions</th></tr></thead>
              <tbody>{refunds === null ? <LoadingRows colSpan={8} /> : refunds.length === 0 ? <EmptyRow colSpan={8} text="No refunds yet" /> : refunds.map(refund => {
                const open = ['initiated', 'processing'].includes(refund.status);
                const gateway = refund.method === 'gateway';
                return (
                  <tr key={refund.id}>
                    <td><Link className="row-link" href={`/admin/orders/${refund.order_id}`}>#{refund.display_number}</Link></td>
                    <td className="num">{formatRupees(refund.amount_paise)}</td>
                    <td>{gateway ? 'Gateway (Razorpay)' : 'Manual (UPI / bank)'}</td>
                    <td><span className={`badge badge-${STATUS_TONE[refund.status] ?? 'neutral'}`}>{refund.status}</span>{refund.provider_status ? <small className="muted"> · {refund.provider_status}</small> : null}</td>
                    <td className="wrap" style={{ maxWidth: 240 }}>{refund.reason}</td><td>{refund.provider_transaction_id ?? '—'}</td><td>{formatDateTime(refund.created_at)}</td>
                    <td style={{ display: 'flex', gap: 6 }}>
                      {isAdmin && open && !gateway && <><button type="button" className="btn-view" disabled={busy} onClick={() => { setCompleting(refund); setReference(''); }}>Mark paid</button><button type="button" className="btn-view" disabled={busy} onClick={() => void updateRefund(refund, 'failed')}>Failed</button></>}
                      {isAdmin && open && gateway && capabilities?.razorpay_refunds_enabled === true && (refund.provider_refund_id ? <button type="button" className="btn-view" disabled={busy} onClick={() => void gatewayAction(refund, 'reconcile')}>Refresh status</button> : <small className="muted">Provider confirmation required</small>)}
                    </td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        )}
      </section>
      {completing && (
        <Modal title="Mark refund as paid" onClose={() => setCompleting(null)}>
          <form onSubmit={complete}>
            <div className="modal-body">
              <p style={{ margin: 0 }}>Confirm you have paid <strong>{formatRupees(completing.amount_paise)}</strong> to the customer for order #{completing.display_number}.</p>
              <label className="field"><span>UPI / bank reference *</span><input className="input" value={reference} onChange={event => setReference(event.target.value)} maxLength={160} required /></label>
            </div>
            <div className="modal-foot"><button type="button" className="btn btn-ghost" onClick={() => setCompleting(null)}>Cancel</button><button type="submit" className="btn btn-primary" disabled={busy || !reference.trim()}>Mark completed</button></div>
          </form>
        </Modal>
      )}
    </>
  );
}

export default function PaymentsPage() { return <Suspense fallback={null}><Payments /></Suspense>; }
