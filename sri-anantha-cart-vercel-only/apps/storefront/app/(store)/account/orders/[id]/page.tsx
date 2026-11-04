'use client';

import { type OrderDetail } from '@sac/contracts';
import { formatAddressLine, formatDateTime, formatPhone, formatRupees, PAYMENT_METHOD_LABELS, PAYMENT_STATUS_LABELS } from '@sac/shared';
import { ArrowLeft, FileText } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Modal } from '@sac/ui-web';
import { DeliveryCodeCard } from '@/components/store/DeliveryCodeCard';
import { StatusBadge } from '@/components/store/StatusBadge';
import { errorMessage, useStore } from '@/components/store/StoreProvider';
import { Tracker } from '@/components/store/Tracker';
import { api } from '@/lib/api';

export default function OrderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useStore();
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [returning, setReturning] = useState(false);
  const [reason, setReason] = useState('');
  const [selectedReturnItems, setSelectedReturnItems] = useState<Record<string, number>>({});
  const [evidenceFiles, setEvidenceFiles] = useState<File[]>([]);
  const [returnCarrier, setReturnCarrier] = useState('India Post');
  const [returnTracking, setReturnTracking] = useState('');
  const [returnParcelDescription, setReturnParcelDescription] = useState('');
  const [returnDetails, setReturnDetails] = useState<Awaited<ReturnType<typeof api.returnDetails>> | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const detail = await api.order(id);
      setOrder(detail);
      if (detail.return_reason) setReturnDetails(await api.returnDetails(id).catch(() => null));
      else setReturnDetails(null);
    } catch { setMissing(true); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  const uploadPendingEvidence = async () => {
    if (!evidenceFiles.length) return;
    setBusy(true);
    const failed: File[] = [];
    for (const file of evidenceFiles) {
      try { await api.uploadReturnEvidence(id, file); } catch { failed.push(file); }
    }
    setEvidenceFiles(failed);
    toast(failed.length
      ? failed.length + ' photo upload(s) still need attention.'
      : 'Return photos uploaded securely.', failed.length ? 'error' : 'success');
    await load();
    setBusy(false);
  };

  const cancelReturn = async () => {
    if (!window.confirm('Cancel this return request?')) return;
    setBusy(true);
    try {
      await api.cancelReturn(id);
      toast('Return request cancelled.', 'success');
      await load();
    } catch (error) { toast(errorMessage(error), 'error'); }
    finally { setBusy(false); }
  };

  const submitReturnShipment = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await api.submitReturnShipment(id, {
        carrier: returnCarrier.trim(),
        tracking_reference: returnTracking.trim(),
        parcel_description: returnParcelDescription.trim(),
      });
      toast('Courier return details submitted. Our team will confirm receipt.', 'success');
      setReturnTracking('');
      setReturnParcelDescription('');
      await load();
    } catch (error) { toast(errorMessage(error), 'error'); }
    finally { setBusy(false); }
  };

  const submitReturn = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const selectedItems = Object.entries(selectedReturnItems).filter(([, quantity]) => quantity > 0).map(([order_item_id, quantity]) => ({ order_item_id, quantity }));
      if (!selectedItems.length) { toast('Select at least one item to return.', 'error'); setBusy(false); return; }
      await api.requestReturn(id, reason.trim(), selectedItems);
      const failedFiles: File[] = [];
      for (const file of evidenceFiles.slice(0, 5)) {
        try { await api.uploadReturnEvidence(id, file); } catch { failedFiles.push(file); }
      }
      const failedUploads = failedFiles.length;
      setEvidenceFiles(failedFiles);
      toast(failedUploads
        ? 'Return requested. ' + failedUploads + ' photo upload(s) failed; you can retry while the request is awaiting review.'
        : 'Return requested. Our team will review your evidence and contact you.', failedUploads ? 'error' : 'success');
      setReturning(false);
      setReason('');
      await load();
    } catch (error) { toast(errorMessage(error), 'error'); }
    finally { setBusy(false); }
  };

  if (missing) return <div className="empty"><h2>Order not found</h2><Link href="/account/orders" className="btn btn-primary">My Orders</Link></div>;
  if (!order) return <div className="skeleton" style={{ height: 400 }} />;
  return (
    <>
      <Link href="/account/orders" className="link-red" style={{ marginBottom: 10 }}><ArrowLeft size={16} /> All orders</Link>
      <div className="account-head">
        <div><h1>Order #{order.display_number}</h1><p className="muted" style={{ margin: '4px 0 0' }}>Placed on {formatDateTime(order.created_at)}</p></div>
        <StatusBadge status={order.status} />
      </div>
      <div className="box" style={{ marginBottom: 16 }}><Tracker order={order} /></div>
      {order.status === 'dispatched' && <div style={{ marginBottom: 16 }}><DeliveryCodeCard orderId={order.id} onFinished={() => void load()} /></div>}
      <div className="detail-grid">
        <div style={{ display: 'grid', gap: 16 }}>
          <div className="box">
            <h2>Items</h2>
            {order.items.map((item, index) => (
              <div key={item.order_item_id || index} className="item-line">
                {item.thumb_url ? <img src={item.thumb_url} alt="" width={56} height={56} /> : <span />}
                <div>
                  {item.slug ? <Link href={`/products/${item.slug}`}><strong>{item.name}</strong></Link> : <strong>{item.name}</strong>}
                  <p className="muted" style={{ margin: '2px 0 0', fontSize: 13.5 }}>{item.variant_label ? `${item.variant_label} · ` : ''}{item.quantity} × {formatRupees(item.unit_price_paise)}</p>
                </div>
                <strong>{formatRupees(item.line_total_paise)}</strong>
              </div>
            ))}
          </div>
          <div className="box">
            <h2>Delivery Address</h2>
            <p style={{ margin: 0 }}><strong>{order.address.recipient_name}</strong> · {formatPhone(order.address.phone_e164)}</p>
            <p className="muted" style={{ margin: '4px 0 0' }}>{formatAddressLine(order.address)}</p>
            <p className="muted" style={{ margin: '8px 0 0' }}>{order.delivery_mode === 'express' ? 'Deliver Now (15-30 minutes)' : order.delivery_slot_start ? `Scheduled: ${formatDateTime(order.delivery_slot_start)}` : ''}</p>
          </div>
          {order.cancellation_reason && <div className="alert alert-danger">Cancelled: {order.cancellation_reason}</div>}
          {order.return_reason && (
            <div className="box">
              <h2>Return request</h2>
              <p className="muted" style={{ margin: '0 0 8px' }}>Reason: {order.return_reason}</p>
              {returnDetails ? (
                <>
                  <p><strong>Status:</strong> {returnDetails.status.replaceAll('_', ' ')}</p>
                  {returnDetails.decision_reason && <p className="muted">Review note: {returnDetails.decision_reason}</p>}
                  {returnDetails.pickup_method && <p className="muted">Return method: {returnDetails.pickup_method.replaceAll('_', ' ')}</p>}
                  {returnDetails.return_carrier && <p className="muted">Courier: {returnDetails.return_carrier} · Tracking: {returnDetails.pickup_reference}</p>}
                  {returnDetails.parcel_description && <p className="muted">Parcel details: {returnDetails.parcel_description}</p>}
                  {returnDetails.status === 'pickup_scheduled' && returnDetails.pickup_method === 'courier' && (
                    <form onSubmit={submitReturnShipment} style={{ display: 'grid', gap: 8, marginTop: 12 }}>
                      <h3>Submit courier tracking details</h3>
                      <label className="field"><span>Courier / postal service</span><input className="input" value={returnCarrier} onChange={event => setReturnCarrier(event.target.value)} minLength={2} maxLength={80} required /></label>
                      <label className="field"><span>Tracking / consignment number</span><input className="input" value={returnTracking} onChange={event => setReturnTracking(event.target.value)} minLength={2} maxLength={160} required /></label>
                      <label className="field"><span>Parcel details</span><textarea className="textarea" value={returnParcelDescription} onChange={event => setReturnParcelDescription(event.target.value)} minLength={3} maxLength={500} required /></label>
                      <button type="submit" className="btn btn-primary btn-sm" disabled={busy || returnCarrier.trim().length < 2 || returnTracking.trim().length < 2 || returnParcelDescription.trim().length < 3}>Submit tracking details</button>
                    </form>
                  )}
                  {returnDetails.evidence.length > 0 && (
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '10px 0' }}>
                      {returnDetails.evidence.map(image => <a key={image.id} href={api.returnEvidenceUrl(id, image.id)} target="_blank" rel="noreferrer"><img src={api.returnEvidenceUrl(id, image.id)} alt="Return evidence" width={84} height={84} style={{ objectFit: 'cover', borderRadius: 8 }} /></a>)}
                    </div>
                  )}
                  {['requested', 'accepted'].includes(returnDetails.status) && <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void cancelReturn()}>Cancel return request</button>}
                  {returnDetails.status === 'requested' && (
                    <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
                      <label className="field"><span>Add return photos (up to five total)</span><input type="file" accept="image/jpeg,image/png,image/webp,image/avif" multiple onChange={event => setEvidenceFiles(current => [...current, ...Array.from(event.target.files ?? [])].slice(0, 5 - returnDetails.evidence.length))} /></label>
                      {evidenceFiles.length > 0 && <p className="muted" style={{ margin: 0 }}>{evidenceFiles.map(file => file.name).join(', ')}</p>}
                      <button type="button" className="btn btn-outline btn-sm" disabled={busy || evidenceFiles.length === 0} onClick={() => void uploadPendingEvidence()}>Upload selected photos</button>
                    </div>
                  )}
                  <ol className="muted" style={{ paddingLeft: 20, margin: '8px 0 0' }}>
                    {returnDetails.timeline.map((event, index) => <li key={index}>{event.to_status.replaceAll('_', ' ')} · {formatDateTime(event.created_at)}</li>)}
                  </ol>
                </>
              ) : <p className="muted">Loading return status…</p>}
            </div>
          )}
        </div>
        <div style={{ display: 'grid', gap: 16 }}>
          <div className="box">
            <h2>Payment Summary</h2>
            <div className="kv"><span>Item Total</span><span>{formatRupees(order.subtotal_paise)}</span></div>
            <div className="kv"><span>Delivery Fee</span><span>{order.delivery_fee_paise ? formatRupees(order.delivery_fee_paise) : <span className="off">FREE</span>}</span></div>
            {order.tax_paise > 0 && <div className="kv"><span className="muted">Includes GST</span><span className="muted">{formatRupees(order.tax_paise)}</span></div>}
            <div className="kv total"><span>Total</span><span className="price">{formatRupees(order.total_paise)}</span></div>
            <div className="kv"><span>Payment</span><span>{order.payment_method ? PAYMENT_METHOD_LABELS[order.payment_method] : '—'} · {PAYMENT_STATUS_LABELS[order.payment_status]}</span></div>
            {order.refunds.map((refund, index) => <div key={index} className="kv"><span>Refund</span><span>{formatRupees(refund.amount_paise)} · {refund.status}</span></div>)}
          </div>
          {order.status !== 'cancelled' && <Link href={`/account/orders/${order.id}/invoice`} className="btn btn-ghost"><FileText size={18} /> View Invoice</Link>}
          {order.can_request_return && <button type="button" className="btn btn-outline" onClick={() => { setSelectedReturnItems(Object.fromEntries(order.items.map(item => [item.order_item_id, item.quantity]))); setReturning(true); }}>Request Return</button>}
          <Link href="/contact" className="btn btn-ghost">Need help?</Link>
        </div>
      </div>
      {returning && (
        <Modal title="Request a return" onClose={() => setReturning(false)}>
          <form onSubmit={submitReturn}>
            <div className="modal-body">
              <p className="muted" style={{ margin: 0 }}>Tell us what went wrong. Returns can be requested within 48 hours of delivery.</p>
              <textarea className="textarea" value={reason} onChange={event => setReason(event.target.value)} maxLength={500} required minLength={3} aria-label="Reason for return" />
              <div style={{ display: 'grid', gap: 10 }}>
                <strong>Select items and quantities to return</strong>
                {order.items.map(item => {
                  const quantity = selectedReturnItems[item.order_item_id] ?? 0;
                  return <div key={item.order_item_id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--line, #eee)' }}>
                    <input type="checkbox" aria-label={`Return ${item.name}`} checked={quantity > 0} onChange={event => setSelectedReturnItems(current => {
                      const next = { ...current };
                      if (event.target.checked) next[item.order_item_id] = item.quantity;
                      else delete next[item.order_item_id];
                      return next;
                    })} />
                    <span style={{ flex: 1 }}>{item.name}{item.variant_label ? ` · ${item.variant_label}` : ''}</span>
                    {quantity > 0 && <input className="input" aria-label={`Quantity of ${item.name} to return`} type="number" min={1} max={item.quantity} value={quantity} style={{ width: 76 }} onChange={event => setSelectedReturnItems(current => ({ ...current, [item.order_item_id]: Math.max(1, Math.min(item.quantity, Number(event.target.value) || 1)) }))} />}
                    <span className="muted">of {item.quantity}</span>
                  </div>;
                })}
              </div>
              
              <label style={{ display: 'grid', gap: 6, marginTop: 12 }}>
                <strong>Photos of the item (optional, up to 5)</strong>
                <span className="muted" style={{ fontSize: 13 }}>JPG, PNG, WebP or AVIF. Maximum 5 MB per image. Photos are visible only to you and authorized staff.</span>
                <input type="file" accept="image/jpeg,image/png,image/webp,image/avif" multiple onChange={event => setEvidenceFiles(Array.from(event.target.files ?? []).slice(0, 5))} />
              </label>
              {evidenceFiles.length > 0 && <p className="muted" style={{ margin: '6px 0 0' }}>{evidenceFiles.map(file => file.name).join(', ')}</p>}
            </div>
            <div className="modal-foot">
              <button type="button" className="btn btn-ghost" onClick={() => setReturning(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={busy || reason.trim().length < 3 || Object.values(selectedReturnItems).every(quantity => quantity < 1)}>Submit Request</button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
