'use client';

import { type OrderStatus, type PaymentMethod } from '@sac/contracts';
import { formatDate, formatRupees, ORDER_STATUS_LABELS, PAYMENT_METHOD_LABELS } from '@sac/shared';
import { Download, IndianRupee, Receipt, ShoppingCart, RotateCcw } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { adminError, useAdmin } from '@/components/admin/AdminProvider';
import { SalesOrdersChart } from '@/components/admin/Charts';
import { EmptyRow, Kpi } from '@/components/admin/ui';

type Summary = {
  totals: { orders: number; revenue_paise: number; tax_paise: number; average_order_paise: number; refunded_paise: number };
  daily: { day: string; orders: number; revenue_paise: number; tax_paise: number }[];
  orders_by_status: { status: OrderStatus; orders: number }[];
  payment_methods: { payment_method: PaymentMethod | 'unknown'; orders: number; revenue_paise: number }[];
  top_products: { name: string; units: number; revenue_paise: number }[];
};
type Tax = { by_rate: { gst_rate_basis_points: number; orders: number; gross_paise: number; tax_paise: number; taxable_paise: number }[]; total_tax_paise: number };
const iso = (offsetDays: number) => new Date(Date.now() + 330 * 60_000 - offsetDays * 86_400_000).toISOString().slice(0, 10);

function Reports() {
  const { request, toast } = useAdmin();
  const params = useSearchParams();
  const dateParam = (key: string) => { const value = params.get(key); return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null; };
  const [from, setFrom] = useState(dateParam('from') ?? iso(29));
  const [to, setTo] = useState(dateParam('to') ?? iso(0));
  const [summary, setSummary] = useState<Summary | null>(null);
  const [tax, setTax] = useState<Tax | null>(null);
  const load = useCallback(async () => {
    setSummary(null); setTax(null);
    try {
      const [s, t] = await Promise.all([
        request<{ data: Summary }>('/api/v1/admin/reports/summary', { query: { from, to } }),
        request<{ data: Tax }>('/api/v1/admin/reports/tax', { query: { from, to } }),
      ]);
      setSummary(s.data); setTax(t.data);
    } catch (error) { toast(adminError(error), 'error'); }
  }, [request, toast, from, to]);
  useEffect(() => { void load(); }, [load]);
  const preset = (days: number) => { setFrom(iso(days - 1)); setTo(iso(0)); };

  return (
    <>
      <div className="admin-page-head">
        <div><h1>Reports</h1><p>Daily sales, order status, payment split, GST collected and top-selling products.</p></div>
        <div className="admin-actions">
          {[7, 30, 90].map(days => <button key={days} type="button" className="btn btn-ghost btn-sm" onClick={() => preset(days)}>Last {days} days</button>)}
          <input className="input" type="date" value={from} max={to} onChange={event => event.target.value && setFrom(event.target.value)} aria-label="From" style={{ width: 'auto', minHeight: 34 }} />
          <input className="input" type="date" value={to} min={from} max={iso(0)} onChange={event => event.target.value && setTo(event.target.value)} aria-label="To" style={{ width: 'auto', minHeight: 34 }} />
          <a className="btn btn-primary btn-sm" href={`/api/v1/admin/reports/summary?from=${from}&to=${to}&format=csv`}><Download size={16} /> CSV</a>
        </div>
      </div>
      {!summary ? <div className="skeleton" style={{ height: 300 }} /> : (
        <>
          <div className="kpi-grid cols-4">
            <Kpi icon={IndianRupee} tone="green" label="Sales (order value)" value={summary.totals.revenue_paise} format={formatRupees} note={`${formatDate(from)} – ${formatDate(to)}`} />
            <Kpi icon={ShoppingCart} tone="red" label="Orders" value={summary.totals.orders} note={`Avg ${formatRupees(summary.totals.average_order_paise)}`} />
            <Kpi icon={Receipt} tone="orange" label="GST collected (incl.)" value={summary.totals.tax_paise} format={formatRupees} note="Included in prices" />
            <Kpi icon={RotateCcw} tone="blue" label="Refunded" value={summary.totals.refunded_paise} format={formatRupees} note="Completed refunds" />
          </div>
          <section className="panel" style={{ marginBottom: 16 }}>
            <div className="panel-head"><h2 className="sans">Daily sales</h2></div>
            <div className="panel-body"><SalesOrdersChart data={summary.daily.map(day => ({ day: day.day, sales_paise: Number(day.revenue_paise), orders: day.orders }))} /></div>
          </section>
          <div className="dash-grid cols-2">
            <section className="panel"><div className="panel-head"><h2 className="sans">Top-selling products</h2></div><div className="panel-body table-wrap">
              <table className="table"><thead><tr><th>Product</th><th className="num">Units</th><th className="num">Revenue</th></tr></thead>
                <tbody>{summary.top_products.length === 0 ? <EmptyRow colSpan={3} text="No sales in this period" /> : summary.top_products.map(item => <tr key={item.name}><td className="wrap">{item.name}</td><td className="num">{item.units}</td><td className="num">{formatRupees(item.revenue_paise)}</td></tr>)}</tbody></table>
            </div></section>
            <section className="panel"><div className="panel-head"><h2 className="sans">Payment method split</h2></div><div className="panel-body table-wrap">
              <table className="table"><thead><tr><th>Method</th><th className="num">Orders</th><th className="num">Revenue</th><th className="num">Share</th></tr></thead>
                <tbody>{summary.payment_methods.length === 0 ? <EmptyRow colSpan={4} text="No payments in this period" /> : summary.payment_methods.map(item => (
                  <tr key={item.payment_method}><td>{item.payment_method === 'unknown' ? 'Unknown' : PAYMENT_METHOD_LABELS[item.payment_method]}</td><td className="num">{item.orders}</td><td className="num">{formatRupees(item.revenue_paise)}</td><td className="num">{summary.totals.revenue_paise ? ((Number(item.revenue_paise) / Number(summary.totals.revenue_paise)) * 100).toFixed(1) : '0'}%</td></tr>
                ))}</tbody></table>
            </div></section>
            <section className="panel"><div className="panel-head"><h2 className="sans">Orders by status</h2></div><div className="panel-body table-wrap">
              <table className="table"><thead><tr><th>Status</th><th className="num">Orders</th></tr></thead>
                <tbody>{summary.orders_by_status.length === 0 ? <EmptyRow colSpan={2} text="No orders" /> : summary.orders_by_status.map(item => <tr key={item.status}><td>{ORDER_STATUS_LABELS[item.status]}</td><td className="num">{item.orders}</td></tr>)}</tbody></table>
            </div></section>
            <section className="panel"><div className="panel-head"><h2 className="sans">GST collected by rate</h2></div><div className="panel-body table-wrap">
              <table className="table"><thead><tr><th>Rate</th><th className="num">Taxable value</th><th className="num">GST</th><th className="num">Gross</th></tr></thead>
                <tbody>{!tax || tax.by_rate.length === 0 ? <EmptyRow colSpan={4} text="No taxable sales" /> : tax.by_rate.map(row => <tr key={row.gst_rate_basis_points}><td>{row.gst_rate_basis_points / 100}%</td><td className="num">{formatRupees(row.taxable_paise)}</td><td className="num">{formatRupees(row.tax_paise)}</td><td className="num">{formatRupees(row.gross_paise)}</td></tr>)}
                  {tax && tax.by_rate.length > 0 && <tr><td><strong>Total</strong></td><td /><td className="num"><strong>{formatRupees(tax.total_tax_paise)}</strong></td><td /></tr>}</tbody></table>
              <p className="field-hint">Basic summary for bookkeeping — confirm GST filing figures with your accountant.</p>
            </div></section>
          </div>
        </>
      )}
    </>
  );
}

export default function ReportsPage() { return <Suspense fallback={null}><Reports /></Suspense>; }
