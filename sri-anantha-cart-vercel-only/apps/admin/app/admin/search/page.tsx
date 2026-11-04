'use client';

import { type OrderStatus } from '@sac/contracts';
import { formatPhone, formatRupees } from '@sac/shared';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { adminError, useAdmin } from '@/components/admin/AdminProvider';
import { OrderStatusBadge } from '@/components/admin/ui';

type Results = { orders: { id: string; display_number: string; status: OrderStatus; total_paise: number; customer_name: string | null }[]; products: { id: string; name: string; sku: string }[]; customers: { id: string; display_name: string | null; phone_e164: string | null; email: string | null }[] };

function Search() {
  const q = useSearchParams().get('q') ?? '';
  const { request, toast } = useAdmin();
  const [results, setResults] = useState<Results | null>(null);
  useEffect(() => { setResults(null); request<{ data: Results }>('/api/v1/admin/search', { query: { q } }).then(result => setResults(result.data)).catch(error => toast(adminError(error), 'error')); }, [q, request, toast]);
  const empty = results && !results.orders.length && !results.products.length && !results.customers.length;
  return (
    <>
      <div className="admin-page-head"><div><h1>Search</h1><p>Results for “{q}”</p></div></div>
      {!results ? <div className="skeleton" style={{ height: 200 }} /> : empty ? <div className="empty">No orders, products or customers match.</div> : (
        <div className="dash-grid cols-3">
          <section className="panel"><div className="panel-head"><h2 className="sans">Orders</h2></div><div className="panel-body" style={{ display: 'grid', gap: 10 }}>
            {results.orders.map(order => <Link key={order.id} href={`/admin/orders/${order.id}`} className="box" style={{ padding: 12, display: 'flex', justifyContent: 'space-between', gap: 8 }}><span><strong>#{order.display_number}</strong><br /><small className="muted">{order.customer_name} · {formatRupees(order.total_paise)}</small></span><OrderStatusBadge status={order.status} /></Link>)}
            {!results.orders.length && <p className="muted">None</p>}
          </div></section>
          <section className="panel"><div className="panel-head"><h2 className="sans">Products</h2></div><div className="panel-body" style={{ display: 'grid', gap: 10 }}>
            {results.products.map(product => <Link key={product.id} href={`/admin/products/${product.id}`} className="box" style={{ padding: 12 }}><strong>{product.name}</strong><br /><small className="muted">{product.sku}</small></Link>)}
            {!results.products.length && <p className="muted">None</p>}
          </div></section>
          <section className="panel"><div className="panel-head"><h2 className="sans">Customers</h2></div><div className="panel-body" style={{ display: 'grid', gap: 10 }}>
            {results.customers.map(customer => <Link key={customer.id} href={`/admin/customers/${customer.id}`} className="box" style={{ padding: 12 }}><strong>{customer.display_name ?? 'Unnamed'}</strong><br /><small className="muted">{formatPhone(customer.phone_e164)} {customer.email ?? ''}</small></Link>)}
            {!results.customers.length && <p className="muted">None</p>}
          </div></section>
        </div>
      )}
    </>
  );
}

export default function SearchPage() { return <Suspense fallback={null}><Search /></Suspense>; }
