'use client';

import { formatDateTime } from '@sac/shared';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { adminError, useAdmin } from '@/components/admin/AdminProvider';

type ReturnRow = {
  id: string; order_id: string; display_number: string; customer_id: string; customer_name: string | null;
  phone_e164: string; reason: string; status: string; pickup_method: string | null;
  pickup_reference: string | null; evidence_count: number; created_at: string;
};
type ReturnDetail = {
  id: string; order_id: string; reason: string; status: string; decision_reason: string | null;
  pickup_method: string | null; return_carrier: string | null; pickup_reference: string | null; parcel_description: string | null;
  evidence: { id: string; content_type: string; byte_size: number; created_at: string }[];
  items: { order_item_id: string; name: string; variant_label: string | null; sku: string; quantity: number; unit_price_paise: number; refund_amount_paise: number; tax_amount_paise: number }[];
  timeline: { from_status: string | null; to_status: string; note: string | null; created_at: string }[];
};

const STATUSES = ['requested', 'accepted', 'rejected', 'pickup_scheduled', 'picked_up', 'in_transit', 'received', 'refund_pending', 'refunded', 'cancelled'];

export default function ReturnsPage() {
  const { request, toast, refreshNotifications } = useAdmin();
  const [status, setStatus] = useState('requested');
  const [rows, setRows] = useState<ReturnRow[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<ReturnDetail | null>(null);
  const [note, setNote] = useState('');
  const [pickupMethod, setPickupMethod] = useState<'self_dropoff' | 'courier'>('courier');
  const [pickupReference, setPickupReference] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setRows(null);
    try {
      const result = await request<{ data: ReturnRow[] }>('/api/v1/admin/returns', { query: { status, limit: 100 } });
      setRows(result.data);
    } catch (error) { toast(adminError(error), 'error'); setRows([]); }
  }, [request, toast, status, selected]);

  const loadDetail = useCallback(async () => {
    if (!selected) { setDetail(null); return; }
    try { setDetail((await request<{ data: ReturnDetail }>('/api/v1/admin/orders/' + selected + '/return')).data); }
    catch (error) { toast(adminError(error), 'error'); setDetail(null); }
  }, [request, selected, toast]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadDetail(); }, [loadDetail]);

  const act = async (path: string, body: unknown, success: string) => {
    setBusy(true);
    try {
      await request(path, { method: 'PATCH', body });
      toast(success, 'success');
      await Promise.all([load(), loadDetail(), refreshNotifications()]);
    } catch (error) { toast(adminError(error), 'error'); }
    finally { setBusy(false); }
  };

  const selectedRow = rows?.find(row => row.order_id === selected);
  return (
    <>
      <div className="admin-page-head">
        <div><h1>Return Management</h1><p>Review customer evidence, coordinate return pickup and confirm receipt before recording refunds.</p></div>
      </div>
      <section className="panel">
        <div className="toolbar">
          <label className="field" style={{ maxWidth: 240 }}>
            <span>Return status</span>
            <select className="select" value={status} onChange={event => { setStatus(event.target.value); setSelected(null); }}>
              {STATUSES.map(value => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}
            </select>
          </label>
          <button type="button" className="btn btn-ghost" onClick={() => { void load(); void loadDetail(); }}>Refresh</button>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Order</th><th>Customer</th><th>Reason</th><th>Evidence</th><th>Status</th><th>Requested</th><th /></tr></thead>
            <tbody>
              {rows === null ? <tr><td colSpan={7}>Loading returns…</td></tr>
                : rows.length === 0 ? <tr><td colSpan={7}>No returns in this status.</td></tr>
                : rows.map(row => (
                  <tr key={row.id}>
                    <td><strong>#{row.display_number}</strong></td>
                    <td>{row.customer_name ?? 'Customer'}<br /><small>{row.phone_e164}</small></td>
                    <td>{row.reason}</td>
                    <td>{row.evidence_count} photo(s)</td>
                    <td>{row.status.replaceAll('_', ' ')}</td>
                    <td>{formatDateTime(row.created_at)}</td>
                    <td><button type="button" className="btn btn-outline btn-sm" onClick={() => setSelected(row.order_id)}>Review</button></td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </section>

      {selected && (
        <section className="panel" style={{ marginTop: 18 }}>
          <div className="panel-head">
            <div><h2 className="sans">Return review {selectedRow ? '· #' + selectedRow.display_number : ''}</h2><p className="muted">Review the photos and advance only after each physical step is complete.</p></div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSelected(null)}>Close</button>
          </div>
          {!detail ? <div className="panel-body">Loading return details…</div> : (
            <div className="panel-body" style={{ display: 'grid', gap: 18 }}>
              <div><strong>Reason:</strong> {detail.reason}<p><strong>Current status:</strong> {detail.status.replaceAll('_', ' ')}</p>{detail.decision_reason && <p className="muted">Review note: {detail.decision_reason}</p>}
                {detail.return_carrier && <p className="muted">Customer courier: {detail.return_carrier} · Tracking: {detail.pickup_reference}</p>}
                {detail.parcel_description && <p className="muted">Parcel details: {detail.parcel_description}</p>}
              </div>
              <div>
                <h3>Items requested for return</h3>
                <div className="table-wrap"><table className="table"><thead><tr><th>Item</th><th>SKU</th><th>Qty</th><th>Requested value</th></tr></thead>
                  <tbody>{detail.items.map(item => <tr key={item.order_item_id}><td>{item.name}{item.variant_label ? ' · ' + item.variant_label : ''}</td><td>{item.sku}</td><td>{item.quantity}</td><td>₹{(item.refund_amount_paise / 100).toFixed(2)}</td></tr>)}</tbody>
                </table></div>
                <p className="muted">Maximum return refund: ₹{(detail.items.reduce((sum, item) => sum + item.refund_amount_paise, 0) / 100).toFixed(2)}. Final amount remains subject to inspection and admin approval.</p>
              </div>
              <div>
                <h3>Customer evidence ({detail.evidence.length})</h3>
                {detail.evidence.length ? <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                  {detail.evidence.map(image => <a key={image.id} href={'/api/v1/orders/' + selected + '/return-evidence/' + image.id} target="_blank" rel="noreferrer">
                    <img src={'/api/v1/orders/' + selected + '/return-evidence/' + image.id} alt="Customer return evidence" width={150} height={150} style={{ objectFit: 'cover', borderRadius: 8 }} />
                    <small>{Math.ceil(image.byte_size / 1024)} KB</small>
                  </a>)}
                </div> : <p className="muted">No photos were uploaded.</p>}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {detail.status === 'requested' && <>
                  <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void act('/api/v1/admin/orders/' + selected + '/return-decision', { decision: 'approve', reason: note.trim() || undefined }, 'Return accepted')}>Accept return</button>
                  <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void act('/api/v1/admin/orders/' + selected + '/return-decision', { decision: 'reject', reason: note.trim() || 'Return request rejected' }, 'Return rejected')}>Reject return</button>
                </>}
                {detail.status === 'accepted' && <>
                  <select className="select" value={pickupMethod} onChange={event => setPickupMethod(event.target.value as 'self_dropoff' | 'courier')} aria-label="Return pickup method">
                    <option value="courier">Courier pickup</option><option value="self_dropoff">Customer drop-off</option>
                  </select>
                  <input className="input" value={pickupReference} onChange={event => setPickupReference(event.target.value)} placeholder="Pickup / courier reference (optional)" maxLength={160} />
                  <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void act('/api/v1/admin/orders/' + selected + '/return-status', { status: 'pickup_scheduled', pickup_method: pickupMethod, pickup_reference: pickupReference.trim() || undefined, note: note.trim() || undefined }, 'Return pickup scheduled')}>Schedule pickup</button>
                </>}
                {detail.status === 'pickup_scheduled' && detail.pickup_method === 'self_dropoff' && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void act('/api/v1/admin/orders/' + selected + '/return-status', { status: 'picked_up', pickup_reference: pickupReference.trim() || undefined, note: note.trim() || undefined }, 'Return marked picked up')}>Mark customer drop-off received</button>}
                {detail.status === 'pickup_scheduled' && detail.pickup_method === 'courier' && <p className="alert alert-info">Waiting for the customer to submit courier tracking details.</p>}
                {['picked_up', 'in_transit'].includes(detail.status) && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void act('/api/v1/admin/orders/' + selected + '/return-status', { status: 'received', note: note.trim() || 'Returned item received and checked' }, 'Item received. Refund can now be recorded.')}>Confirm item received</button>}
                {detail.status === 'received' && <div className="alert alert-info">Item received. <Link className="link-red" href={'/admin/orders/' + selected}>Open order to record the refund</Link>.</div>}
                {['refund_pending', 'refunded'].includes(detail.status) && <p className="alert alert-info">Refund status: {detail.status.replaceAll('_', ' ')}.</p>}
              </div>
              {['requested', 'accepted', 'pickup_scheduled', 'picked_up'].includes(detail.status) && (
                <label className="field"><span>Internal note / decision note</span><textarea className="textarea" value={note} onChange={event => setNote(event.target.value)} maxLength={300} rows={2} /></label>
              )}
              <div><h3>Return history</h3><ol className="muted" style={{ paddingLeft: 20 }}>
                {detail.timeline.map((event, index) => <li key={index}>{event.to_status.replaceAll('_', ' ')} · {formatDateTime(event.created_at)}{event.note ? ' — ' + event.note : ''}</li>)}
              </ol></div>
            </div>
          )}
        </section>
      )}
    </>
  );
}
