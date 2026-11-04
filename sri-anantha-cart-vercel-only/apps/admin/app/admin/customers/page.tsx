'use client';

import { formatDate, formatPhone, formatRupees } from '@sac/shared';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { adminError, useAdmin } from '@/components/admin/AdminProvider';
import { EmptyRow, LoadingRows, Pager } from '@/components/admin/ui';

type Row = { id: string; phone_e164: string | null; display_name: string | null; email: string | null; is_active: boolean; created_at: string; order_count: number; total_spent_paise: number; last_order_at: string | null };
const LIMIT = 25;

export default function CustomersPage() {
  const { request, toast } = useAdmin();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const load = useCallback(async () => {
    setRows(null);
    try {
      const result = await request<{ data: Row[] }>('/api/v1/admin/customers', { query: { search: search.trim(), limit: LIMIT + 1, offset } });
      setHasMore(result.data.length > LIMIT); setRows(result.data.slice(0, LIMIT));
    } catch (error) { toast(adminError(error), 'error'); setRows([]); }
  }, [request, toast, search, offset]);
  useEffect(() => { const timer = window.setTimeout(() => void load(), search ? 300 : 0); return () => window.clearTimeout(timer); }, [load, search]);
  return (
    <>
      <div className="admin-page-head"><div><h1>Customers</h1><p>Registered customers, their orders and account status.</p></div></div>
      <section className="panel">
        <div className="toolbar"><input className="input grow" type="search" placeholder="Search by name, phone or email" value={search} onChange={event => { setSearch(event.target.value); setOffset(0); }} aria-label="Search customers" /></div>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Customer</th><th>Phone</th><th>Email</th><th className="num">Orders</th><th className="num">Total spent</th><th>Last order</th><th>Joined</th><th>Status</th><th /></tr></thead>
            <tbody>
              {rows === null ? <LoadingRows colSpan={9} /> : rows.length === 0 ? <EmptyRow colSpan={9} text="No customers found" /> : rows.map(row => (
                <tr key={row.id}>
                  <td><Link className="row-link" href={`/admin/customers/${row.id}`}>{row.display_name ?? 'Unnamed customer'}</Link></td>
                  <td>{formatPhone(row.phone_e164)}</td><td>{row.email ?? '—'}</td><td className="num">{row.order_count}</td>
                  <td className="num">{formatRupees(row.total_spent_paise)}</td><td>{row.last_order_at ? formatDate(row.last_order_at) : '—'}</td><td>{formatDate(row.created_at)}</td>
                  <td>{row.is_active ? <span className="badge badge-success">Active</span> : <span className="badge badge-danger">Blocked</span>}</td>
                  <td><Link href={`/admin/customers/${row.id}`} className="btn-view">View</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="pager"><span /><div className="pager-buttons">
          <button type="button" className="btn btn-ghost btn-sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - LIMIT))}>Previous</button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={!hasMore} onClick={() => setOffset(offset + LIMIT)}>Next</button>
        </div></div>
      </section>
    </>
  );
}
