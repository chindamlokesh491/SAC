'use client';

import { type OrderStatus, type PaymentMethod, type PaymentStatus } from '@sac/contracts';
import { formatDateTime, formatRupees, paymentSummary } from '@sac/shared';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { adminError, useAdmin } from '@/components/admin/AdminProvider';
import { EmptyRow, LoadingRows, OrderStatusBadge, Pager } from '@/components/admin/ui';

type Row = { id: string; display_number: string; customer_name: string | null; phone_e164: string; item_count: number; total_paise: number; payment_method: PaymentMethod | null; payment_status: PaymentStatus; status: OrderStatus; created_at: string; delivery_mode: string | null; delivery_slot_start: string | null };
const TABS: [string, string][] = [['', 'All'], ['placed', 'Pending'], ['accepted', 'Accepted'], ['packed', 'Packed'], ['dispatched', 'Out for Delivery'], ['delivered', 'Delivered'], ['return_requested', 'Returns'], ['cancelled', 'Cancelled']];
const LIMIT = 20;

function Orders() {
  const { request, toast } = useAdmin();
  const params = useSearchParams();
  const router = useRouter();
  const [status, setStatus] = useState(params.get('status') ?? '');
  const [search, setSearch] = useState('');
  const [method, setMethod] = useState('');
  const [paymentStatus, setPaymentStatus] = useState('');
  const [from, setFrom] = useState(params.get('from') ?? '');
  const [to, setTo] = useState(params.get('to') ?? '');
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<Record<string, number>>({});

  const load = useCallback(async () => {
    setRows(null);
    try {
      const result = await request<{ data: Row[]; pagination: { total: number }; status_counts: Record<string, number> }>('/api/v1/admin/orders', {
        query: { status, search: search.trim(), payment_method: method, payment_status: paymentStatus, from, to, limit: LIMIT, offset },
      });
      setRows(result.data); setTotal(result.pagination.total); setCounts(result.status_counts);
    } catch (error) { toast(adminError(error), 'error'); setRows([]); }
  }, [request, toast, status, search, method, paymentStatus, from, to, offset]);
  useEffect(() => { const timer = window.setTimeout(() => void load(), search ? 300 : 0); return () => window.clearTimeout(timer); }, [load, search]);

  const all = Object.values(counts).reduce((sum, value) => sum + value, 0);
  return (
    <>
      <div className="admin-page-head"><div><h1>Orders</h1><p>Accept, pack, dispatch and deliver orders. Filter by status, date or payment.</p></div></div>
      <section className="panel">
        <div className="status-tabs" role="tablist">
          {TABS.map(([value, label]) => (
            <button key={label} type="button" role="tab" aria-selected={status === value} onClick={() => { setStatus(value); setOffset(0); router.replace(value ? `/admin/orders?status=${value}` : '/admin/orders'); }}>
              {label}<span className="n">{value ? counts[value] ?? 0 : all}</span>
            </button>
          ))}
        </div>
        <div className="toolbar">
          <input className="input grow" type="search" placeholder="Search order ID, customer name or phone" value={search} onChange={event => { setSearch(event.target.value); setOffset(0); }} aria-label="Search orders" />
          <select className="select" value={method} onChange={event => { setMethod(event.target.value); setOffset(0); }} aria-label="Payment method">
            <option value="">All payment methods</option><option value="cod">Cash on Delivery</option><option value="upi">UPI</option><option value="card">Card</option><option value="net_banking">Net Banking</option><option value="wallet">Wallet</option>
          </select>
          <select className="select" value={paymentStatus} onChange={event => { setPaymentStatus(event.target.value); setOffset(0); }} aria-label="Payment status">
            <option value="">All payment statuses</option><option value="pending">Pending</option><option value="paid">Paid</option><option value="failed">Failed</option><option value="refund_pending">Refund pending</option><option value="refunded">Refunded</option>
          </select>
          <input className="input" type="date" value={from} onChange={event => { setFrom(event.target.value); setOffset(0); }} aria-label="From date" />
          <input className="input" type="date" value={to} onChange={event => { setTo(event.target.value); setOffset(0); }} aria-label="To date" />
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Order ID</th><th>Customer</th><th>Items</th><th className="num">Amount</th><th>Payment</th><th>Delivery</th><th>Status</th><th>Date &amp; Time</th><th>Action</th></tr></thead>
            <tbody>
              {rows === null ? <LoadingRows colSpan={9} /> : rows.length === 0 ? <EmptyRow colSpan={9} text="No orders match these filters" /> : rows.map(order => (
                <tr key={order.id}>
                  <td><Link className="row-link" href={`/admin/orders/${order.id}`}>#{order.display_number}</Link></td>
                  <td>{order.customer_name ?? '—'}<br /><small className="muted">{order.phone_e164}</small></td>
                  <td>{order.item_count}</td>
                  <td className="num">{formatRupees(order.total_paise)}</td>
                  <td>{paymentSummary(order.payment_method, order.payment_status)}</td>
                  <td>{order.delivery_mode === 'scheduled' && order.delivery_slot_start ? formatDateTime(order.delivery_slot_start) : 'Deliver Now'}</td>
                  <td><OrderStatusBadge status={order.status} /></td>
                  <td>{formatDateTime(order.created_at)}</td>
                  <td><Link href={`/admin/orders/${order.id}`} className="btn-view">View</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Pager offset={offset} limit={LIMIT} total={total} onChange={setOffset} />
      </section>
    </>
  );
}

export default function OrdersPage() { return <Suspense fallback={null}><Orders /></Suspense>; }
