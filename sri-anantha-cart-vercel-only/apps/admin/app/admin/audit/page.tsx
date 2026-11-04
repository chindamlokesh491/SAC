'use client';

import { formatDateTime, formatPhone } from '@sac/shared';
import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { adminError, useAdmin } from '@/components/admin/AdminProvider';
import { EmptyRow, LoadingRows, Pager } from '@/components/admin/ui';

type Entry = {
  id: string; action: string; resource_type: string; resource_id: string | null; metadata: Record<string, unknown>; created_at: string;
  actor: { id: string; role: string; phone: string | null; name: string | null } | null;
  order_display_number: string | null;
};
const AREAS: [string, string][] = [
  ['', 'All activity'], ['order.', 'Orders'], ['delivery*', 'Delivery'], ['return.', 'Returns'], ['refund.', 'Refunds'],
  ['staff.', 'Staff'], ['product.', 'Products'], ['category.', 'Categories'], ['settings.', 'Settings'], ['customer.', 'Customers'],
];
const LIMIT = 50;

/** Compact, readable summary of an entry's metadata (keys and values are application-generated). */
function details(metadata: Record<string, unknown>): string {
  return Object.entries(metadata)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => `${key.replace(/_/g, ' ')}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
    .join(' · ');
}

export default function AuditLogPage() {
  const { request, toast, isAdmin } = useAdmin();
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [area, setArea] = useState('');
  const [resource, setResource] = useState('');
  const [applied, setApplied] = useState({ resource: '', from: '', to: '' });
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const load = useCallback(async () => {
    setEntries(null);
    try {
      // Prefix filters: "order." etc.; "delivery*" covers delivery.* and delivery_assignment.*.
      const result = await request<{ data: Entry[]; pagination: { total: number } }>('/api/v1/admin/audit-logs', { query: {
        action: area || undefined, resource: applied.resource || undefined, from: applied.from || undefined, to: applied.to || undefined, limit: LIMIT, offset,
      } });
      setEntries(result.data); setTotal(result.pagination.total);
    } catch (error) { toast(adminError(error), 'error'); setEntries([]); }
  }, [request, toast, area, applied, offset]);
  useEffect(() => { if (isAdmin) void load(); }, [load, isAdmin]);

  const search = (event: FormEvent) => { event.preventDefault(); setOffset(0); setApplied({ resource: resource.trim(), from, to }); };

  if (!isAdmin) return <div className="admin-page-head"><div><h1>Audit log</h1><p>Only administrators can view the audit log.</p></div></div>;
  return (
    <>
      <div className="admin-page-head"><div><h1>Audit log</h1><p>Every staff, delivery-partner and customer action that changes an order, refund, return or setting. Entries cannot be edited or deleted.</p></div></div>
      <form className="toolbar" onSubmit={search}>
        <input className="input grow" type="search" placeholder="Order (SA10001) or record ID" value={resource} onChange={event => setResource(event.target.value)} aria-label="Order or record" />
        <select className="select" value={area} onChange={event => { setArea(event.target.value); setOffset(0); }} aria-label="Activity area">
          {AREAS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <input className="input" type="date" value={from} onChange={event => setFrom(event.target.value)} aria-label="From date" />
        <input className="input" type="date" value={to} onChange={event => setTo(event.target.value)} aria-label="To date" />
        <button className="btn btn-primary" type="submit">Search</button>
      </form>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>When</th><th>Action</th><th>By</th><th>Record</th><th>Details</th></tr></thead>
          <tbody>{entries === null ? <LoadingRows colSpan={5} /> : entries.length === 0 ? <EmptyRow colSpan={5} text="No audit entries match" /> : entries.map(entry => (
            <tr key={entry.id}>
              <td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(entry.created_at)}</td>
              <td><code>{entry.action}</code></td>
              <td>{entry.actor ? <>{entry.actor.name || formatPhone(entry.actor.phone)}<br /><span className="muted" style={{ fontSize: 12 }}>{entry.actor.role.replace('_', ' ')}</span></> : <span className="muted">System</span>}</td>
              <td>{entry.order_display_number
                ? <Link className="row-link" href={`/admin/orders/${entry.resource_id}`}>#{entry.order_display_number}</Link>
                : <span className="muted">{entry.resource_type}{entry.resource_id ? ` · ${entry.resource_id.slice(0, 8)}` : ''}</span>}</td>
              <td className="wrap" style={{ maxWidth: 420, fontSize: 13 }}>{details(entry.metadata) || '—'}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <Pager offset={offset} limit={LIMIT} total={total} onChange={setOffset} />
    </>
  );
}
