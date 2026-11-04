'use client';

import { type OrderStatus, type PaymentMethod, type PaymentStatus } from '@sac/contracts';
import { formatDateTime, formatRupees, paymentSummary } from '@sac/shared';
import { AlertTriangle, ArrowRight, BarChart3, Box, Clock, CheckCircle2, CircleX, ClipboardCheck, IndianRupee, Package, ShoppingCart, Truck, User, Ban, CalendarDays, ChevronDown } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { adminError, useAdmin } from '@/components/admin/AdminProvider';
import { SalesOrdersChart, StatusDonut } from '@/components/admin/Charts';
import { Kpi, LoadingRows, OrderStatusBadge, EmptyRow } from '@/components/admin/ui';

type Metric = { value: number; previous: number | null };
type Dashboard = {
  date: string;
  kpis: Record<'total_orders' | 'pending' | 'accepted' | 'packed' | 'out_for_delivery' | 'delivered_today' | 'sales_paise' | 'cancelled' | 'total_customers' | 'total_products' | 'low_stock' | 'out_of_stock', Metric> & { cancelled_total: number; return_requests: number };
  sales_7d: { day: string; sales_paise: number; orders: number }[];
  status_30d: { status: string; count: number }[];
  recent_orders: { id: string; display_number: string; customer_id: string | null; customer_name: string | null; item_count: number; total_paise: number; payment_method: PaymentMethod | null; payment_status: PaymentStatus; status: OrderStatus; created_at: string }[];
  low_stock: { product_id: string; name: string; variant_label: string | null; quantity: number; minimum_stock_level: number; thumb_url: string | null }[];
};

const todayIst = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const shiftDays = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
/** Dashboard status buckets → the order list's status filter. */
const BUCKET_STATUS: Record<string, string> = { pending: 'placed', out_for_delivery: 'dispatched', delivered: 'delivered' };

export default function DashboardPage() {
  const { request, toast } = useAdmin();
  const router = useRouter();
  const [date, setDate] = useState(todayIst());
  const [data, setData] = useState<Dashboard | null>(null);
  useEffect(() => {
    setData(null);
    request<{ data: Dashboard }>('/api/v1/admin/dashboard', { query: { date } }).then(result => setData(result.data)).catch(error => toast(adminError(error), 'error'));
  }, [date, request, toast]);
  const k = data?.kpis;
  const isToday = date === todayIst();
  const dayLabel = new Date(`${date}T12:00:00+05:30`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

  return (
    <>
      <div className="admin-page-head">
        <div><h1>Dashboard</h1><p>Here&apos;s what&apos;s happening with your store {isToday ? 'today' : `on ${dayLabel}`}.</p></div>
        <label className="date-pill"><CalendarDays size={18} /> {isToday ? 'Today, ' : ''}{dayLabel} <ChevronDown size={16} /><input type="date" value={date} max={todayIst()} onChange={event => event.target.value && setDate(event.target.value)} aria-label="Dashboard date" /></label>
      </div>
      {!k ? <div className="skeleton" style={{ height: 230, marginBottom: 16 }} /> : (
        <>
          <div className="kpi-grid">
            <Kpi icon={ShoppingCart} tone="red" label={isToday ? 'Total Orders Today' : 'Total Orders'} value={k.total_orders.value} previous={k.total_orders.previous} href={`/admin/orders?from=${date}&to=${date}`} />
            <Kpi icon={Clock} tone="orange" label="Pending Orders" value={k.pending.value} note="Awaiting acceptance" href="/admin/orders?status=placed" />
            <Kpi icon={ClipboardCheck} tone="blue" label="Accepted Orders" value={k.accepted.value} note="Being prepared" href="/admin/orders?status=accepted" />
            <Kpi icon={Box} tone="orange" label="Packed Orders" value={k.packed.value} note="Ready to dispatch" href="/admin/orders?status=packed" />
            <Kpi icon={Truck} tone="blue" label="Out for Delivery" value={k.out_for_delivery.value} note="On the way" href="/admin/orders?status=dispatched" />
            <Kpi icon={CheckCircle2} tone="green" label={isToday ? 'Delivered Today' : 'Delivered'} value={k.delivered_today.value} previous={k.delivered_today.previous} href={`/admin/orders?status=delivered&from=${date}&to=${date}`} />
          </div>
          <div className="kpi-grid">
            <Kpi icon={IndianRupee} tone="green" label={isToday ? "Today's Sales" : 'Sales'} value={k.sales_paise.value} previous={k.sales_paise.previous} format={value => formatRupees(value)} href={`/admin/reports?from=${date}&to=${date}`} />
            <Kpi icon={Ban} tone="gray" label={isToday ? 'Cancelled Today' : 'Cancelled'} value={k.cancelled.value} previous={k.cancelled.previous} note={`${k.cancelled_total} cancelled in total`} href={`/admin/orders?status=cancelled&from=${date}&to=${date}`} />
            <Kpi icon={User} tone="red" label="Total Customers" value={k.total_customers.value} previous={k.total_customers.previous} href="/admin/customers" />
            <Kpi icon={Package} tone="orange" label="Total Products" value={k.total_products.value} previous={k.total_products.previous} href="/admin/products" />
            <Kpi icon={AlertTriangle} tone="red" label="Low Stock Items" value={k.low_stock.value} note="At or below minimum" href="/admin/inventory?stock=low" />
            <Kpi icon={CircleX} tone="red" label="Out of Stock Items" value={k.out_of_stock.value} note="Zero stock" href="/admin/inventory?stock=out" />
          </div>
        </>
      )}
      <div className="dash-grid">
        <section className="panel">
          <div className="panel-head"><h2 className="sans"><BarChart3 size={22} color="var(--saffron)" /> Sales &amp; Orders Overview</h2><Link href="/admin/reports" className="link-red">Open Reports <ArrowRight size={16} /></Link></div>
          <div className="panel-body">{data ? <SalesOrdersChart data={data.sales_7d} hrefFor={day => `/admin/reports?from=${day}&to=${day}`} /> : <div className="skeleton" style={{ height: 230 }} />}</div>
        </section>
        <section className="panel">
          <div className="panel-head"><h2>Orders by Status</h2><Link href={`/admin/orders?from=${shiftDays(date, -29)}&to=${date}`} className="link-red">Last 30 Days <ArrowRight size={16} /></Link></div>
          {data ? <StatusDonut data={data.status_30d} hrefFor={status => `/admin/orders?status=${BUCKET_STATUS[status] ?? status}&from=${shiftDays(date, -29)}&to=${date}`} /> : <div className="skeleton" style={{ height: 200, margin: 20 }} />}
        </section>
      </div>
      <div className="dash-grid">
        <section className="panel">
          <div className="panel-head"><h2>Recent Orders</h2><Link href="/admin/orders" className="link-red">View All <ArrowRight size={16} /></Link></div>
          <div className="panel-body table-wrap">
            <table className="table">
              <thead><tr><th>Order ID</th><th>Customer</th><th>Items</th><th>Amount</th><th>Payment</th><th>Status</th><th>Date &amp; Time</th><th>Action</th></tr></thead>
              <tbody>
                {!data ? <LoadingRows colSpan={8} /> : data.recent_orders.length === 0 ? <EmptyRow colSpan={8} text="No orders yet" /> : data.recent_orders.map(order => (
                  <tr key={order.id} className="row-click" onClick={event => { if (!(event.target as HTMLElement).closest('a')) router.push(`/admin/orders/${order.id}`); }}>
                    <td><Link href={`/admin/orders/${order.id}`} className="row-link"><strong>#{order.display_number}</strong></Link></td><td>{order.customer_id ? <Link href={`/admin/customers/${order.customer_id}`} className="row-link">{order.customer_name ?? 'Customer'}</Link> : order.customer_name ?? '—'}</td>
                    <td>{order.item_count} {order.item_count === 1 ? 'item' : 'items'}</td><td>{formatRupees(order.total_paise)}</td>
                    <td>{paymentSummary(order.payment_method, order.payment_status)}</td><td><OrderStatusBadge status={order.status} /></td>
                    <td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(order.created_at)}</td>
                    <td><Link href={`/admin/orders/${order.id}`} className="btn-view">View</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section className="panel">
          <div className="panel-head"><h2 style={{ color: 'var(--primary)' }}><Clock size={22} /> Low Stock Alerts</h2><Link href="/admin/inventory?stock=low" className="link-red">View All <ArrowRight size={16} /></Link></div>
          <div className="panel-body table-wrap">
            <table className="table">
              <thead><tr><th>Product</th><th className="num">Current Stock</th><th className="num">Min. Stock</th><th>Status</th><th>Action</th></tr></thead>
              <tbody>
                {!data ? <LoadingRows colSpan={5} /> : data.low_stock.length === 0 ? <EmptyRow colSpan={5} text="All products are well stocked" /> : data.low_stock.map(item => (
                  <tr key={`${item.product_id}-${item.variant_label ?? ''}`} className="row-click" onClick={event => { if (!(event.target as HTMLElement).closest('a')) router.push(`/admin/inventory?product=${item.product_id}`); }}>
                    <td><span className="prod">{item.thumb_url && <img src={item.thumb_url} alt="" width={36} height={36} />}<span><Link href={`/admin/products/${item.product_id}`} className="row-link">{item.name}</Link>{item.variant_label && <small>{item.variant_label}</small>}</span></span></td>
                    <td className="num stock-low">{item.quantity}</td><td className="num">{item.minimum_stock_level}</td>
                    <td>{item.quantity <= 0 ? <span className="badge badge-danger">Out of Stock</span> : <span className="badge badge-warning">Low Stock</span>}</td>
                    <td><Link href={`/admin/inventory?product=${item.product_id}`} className="btn-view">Update</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </>
  );
}
