'use client';

import { formatDateTime } from '@sac/shared';
import { AlertTriangle, Boxes, CheckCircle2, CircleX } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState, type FormEvent } from 'react';
import { adminError, useAdmin } from '@/components/admin/AdminProvider';
import { EmptyRow, Kpi, LoadingRows, Pager } from '@/components/admin/ui';
import { Modal } from '@sac/ui-web';

type Row = { product_id: string; variant_id: string | null; name: string; variant_label: string | null; sku: string; minimum_stock_level: number; quantity: number; is_active: boolean; thumb_url: string | null; category_name: string | null; stock_status: string; updated_at: string | null };
type Summary = { total_skus: number; in_stock: number; low_stock: number; out_of_stock: number; total_units: number };
type Movement = { id: string; variant_label: string | null; quantity_delta: number; reason: string; created_at: string; actor: string | null };
const REASONS = [['stock_in', 'Stock in (received goods)'], ['damaged', 'Damaged'], ['lost', 'Lost'], ['expired', 'Expired'], ['returned', 'Customer return (back to stock)'], ['correction', 'Stock count correction']] as const;
const LIMIT = 25;

function Inventory() {
  const { request, toast, isAdmin, refreshNotifications } = useAdmin();
  const params = useSearchParams();
  const [stock, setStock] = useState(params.get('stock') ?? '');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [total, setTotal] = useState(0);
  const [adjusting, setAdjusting] = useState<Row | null>(null);
  const [history, setHistory] = useState<{ row: Row; items: Movement[] } | null>(null);
  const [form, setForm] = useState({ reason: 'stock_in', quantity: '', note: '', minimum: '' });
  const [busy, setBusy] = useState(false);
  const focusProduct = params.get('product');

  const load = useCallback(async () => {
    setRows(null);
    try {
      const result = await request<{ data: Row[]; summary: Summary; pagination: { total: number } }>('/api/v1/admin/inventory', { query: { stock, search: search.trim(), limit: LIMIT, offset } });
      setRows(result.data); setSummary(result.summary); setTotal(result.pagination.total);
    } catch (error) { toast(adminError(error), 'error'); setRows([]); }
  }, [request, toast, stock, search, offset]);
  useEffect(() => { const timer = window.setTimeout(() => void load(), search ? 300 : 0); return () => window.clearTimeout(timer); }, [load, search]);
  useEffect(() => { if (focusProduct && rows) { const match = rows.find(row => row.product_id === focusProduct); if (match && isAdmin) openAdjust(match); } }, [focusProduct, rows, isAdmin]);

  function openAdjust(row: Row) { setForm({ reason: 'stock_in', quantity: '', note: '', minimum: String(row.minimum_stock_level) }); setAdjusting(row); }
  const showHistory = async (row: Row) => {
    try { setHistory({ row, items: (await request<{ data: Movement[] }>(`/api/v1/admin/inventory/${row.product_id}/movements`)).data }); }
    catch (error) { toast(adminError(error), 'error'); }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!adjusting) return;
    const amount = Number(form.quantity);
    if (!Number.isInteger(amount) || amount === 0) { toast('Enter a whole number of units', 'error'); return; }
    const removes = ['damaged', 'lost', 'expired'].includes(form.reason);
    const delta = form.reason === 'correction' ? amount : removes ? -Math.abs(amount) : Math.abs(amount);
    setBusy(true);
    try {
      await request('/api/v1/admin/inventory/adjustments', { method: 'POST', body: { product_id: adjusting.product_id, variant_id: adjusting.variant_id, quantity_delta: delta, reason: form.reason, ...(form.note.trim() ? { note: form.note.trim() } : {}) } });
      if (Number(form.minimum) !== adjusting.minimum_stock_level && form.minimum !== '') {
        await request(`/api/v1/admin/inventory/${adjusting.product_id}/minimum`, { method: 'PATCH', body: { minimum_stock_level: Number(form.minimum) } });
      }
      toast('Stock updated', 'success'); setAdjusting(null); await load(); void refreshNotifications();
    } catch (error) { toast(adminError(error), 'error'); } finally { setBusy(false); }
  };

  return (
    <>
      <div className="admin-page-head"><div><h1>Inventory</h1><p>Stock levels, manual stock-in / stock-out with reasons, and minimum-stock alerts.</p></div></div>
      {summary && (
        <div className="kpi-grid cols-4">
          <Kpi icon={Boxes} tone="blue" label="Total SKUs" value={summary.total_skus} note={`${summary.total_units.toLocaleString('en-IN')} units in stock`} />
          <Kpi icon={CheckCircle2} tone="green" label="In-stock items" value={summary.in_stock} note="Stock above zero" />
          <Kpi icon={AlertTriangle} tone="orange" label="Low-stock items" value={summary.low_stock} note="At or below minimum" />
          <Kpi icon={CircleX} tone="red" label="Out-of-stock items" value={summary.out_of_stock} note="Zero stock" />
        </div>
      )}
      <section className="panel">
        <div className="toolbar">
          <input className="input grow" type="search" placeholder="Search product or SKU" value={search} onChange={event => { setSearch(event.target.value); setOffset(0); }} aria-label="Search inventory" />
          <select className="select" value={stock} onChange={event => { setStock(event.target.value); setOffset(0); }} aria-label="Stock filter">
            <option value="">All items</option><option value="in">In stock</option><option value="low">Low stock</option><option value="out">Out of stock</option>
          </select>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Product</th><th>SKU</th><th>Category</th><th className="num">Current Stock</th><th className="num">Min. Stock</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {rows === null ? <LoadingRows colSpan={7} /> : rows.length === 0 ? <EmptyRow colSpan={7} text="No items match" /> : rows.map(row => (
                <tr key={`${row.product_id}-${row.variant_id ?? ''}`}>
                  <td><span className="prod">{row.thumb_url && <img src={row.thumb_url} alt="" width={36} height={36} />}<span>{row.name}{row.variant_label && <small>{row.variant_label}</small>}{!row.is_active && <small>Hidden from store</small>}</span></span></td>
                  <td>{row.sku}</td><td>{row.category_name ?? '—'}</td>
                  <td className={`num${row.quantity <= row.minimum_stock_level ? ' stock-low' : ''}`}>{row.quantity}</td><td className="num">{row.minimum_stock_level}</td>
                  <td>{row.stock_status === 'out_of_stock' ? <span className="badge badge-danger">Out of Stock</span> : row.stock_status === 'low_stock' ? <span className="badge badge-warning">Low Stock</span> : <span className="badge badge-success">In Stock</span>}</td>
                  <td style={{ display: 'flex', gap: 6 }}>{isAdmin && <button type="button" className="btn-view" onClick={() => openAdjust(row)}>Update</button>}<button type="button" className="btn-view" onClick={() => void showHistory(row)}>History</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Pager offset={offset} limit={LIMIT} total={total} onChange={setOffset} />
      </section>
      {adjusting && (
        <Modal title={`Update stock — ${adjusting.name}${adjusting.variant_label ? ` (${adjusting.variant_label})` : ''}`} onClose={() => setAdjusting(null)}>
          <form onSubmit={submit}>
            <div className="modal-body">
              <p style={{ margin: 0 }}>Current stock: <strong>{adjusting.quantity}</strong></p>
              <label className="field"><span>Reason</span><select className="select" value={form.reason} onChange={event => setForm({ ...form, reason: event.target.value })}>{REASONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <label className="field"><span>{form.reason === 'correction' ? 'Change in units (use − to reduce)' : ['damaged', 'lost', 'expired'].includes(form.reason) ? 'Units to remove' : 'Units to add'}</span>
                <input className="input" inputMode="numeric" value={form.quantity} onChange={event => setForm({ ...form, quantity: event.target.value.replace(form.reason === 'correction' ? /[^\d-]/g : /\D/g, '') })} autoFocus /></label>
              <label className="field"><span>Note (optional)</span><input className="input" value={form.note} maxLength={200} onChange={event => setForm({ ...form, note: event.target.value })} placeholder="Supplier invoice no., damage details…" /></label>
              {!adjusting.variant_id && <label className="field"><span>Minimum stock level (low-stock alert)</span><input className="input" inputMode="numeric" value={form.minimum} onChange={event => setForm({ ...form, minimum: event.target.value.replace(/\D/g, '') })} /></label>}
            </div>
            <div className="modal-foot"><button type="button" className="btn btn-ghost" onClick={() => setAdjusting(null)}>Cancel</button><button type="submit" className="btn btn-primary" disabled={busy}>Save</button></div>
          </form>
        </Modal>
      )}
      {history && (
        <Modal title={`Stock history — ${history.row.name}`} onClose={() => setHistory(null)}>
          <div className="modal-body table-wrap">
            <table className="table"><thead><tr><th>When</th><th>Change</th><th>Reason</th><th>By</th></tr></thead>
              <tbody>{history.items.length === 0 ? <EmptyRow colSpan={4} text="No movements yet" /> : history.items.map(item => (
                <tr key={item.id}><td>{formatDateTime(item.created_at)}</td><td style={{ color: item.quantity_delta < 0 ? 'var(--red)' : 'var(--green)', fontWeight: 600 }}>{item.quantity_delta > 0 ? '+' : ''}{item.quantity_delta}{item.variant_label ? ` (${item.variant_label})` : ''}</td><td className="wrap">{item.reason.replace(/_/g, ' ')}</td><td>{item.actor ?? 'System'}</td></tr>
              ))}</tbody></table>
          </div>
        </Modal>
      )}
    </>
  );
}

export default function InventoryPage() { return <Suspense fallback={null}><Inventory /></Suspense>; }
