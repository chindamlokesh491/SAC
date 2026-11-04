'use client';

import type { DeliveryIssueReason, DeliveryRejectReason, PartnerOrderDetail } from '@sac/contracts';
import { ArrowLeft, MapPin, Phone } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { partnerError, usePartner } from '@/components/partner/PartnerProvider';
import { STAGE_LABEL, STAGE_ORDER } from '@/components/partner/stages';
import { api } from '@/lib/api';

const REJECT_REASONS: [DeliveryRejectReason, string][] = [
  ['vehicle_unavailable', 'Vehicle not available'], ['too_far', 'Too far from my location'], ['shift_ending', 'My shift is ending'],
  ['personal_emergency', 'Personal emergency'], ['other', 'Other reason'],
];
const ISSUE_REASONS: [DeliveryIssueReason, string][] = [
  ['customer_not_available', 'Customer not available'], ['customer_phone_unreachable', 'Customer phone unreachable'],
  ['incorrect_address', 'Address is incorrect'], ['customer_refused', 'Customer refused the order'], ['payment_issue', 'Payment problem'], ['other', 'Other problem'],
];

function useCountdown(until: string | null | undefined) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!until) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [until]);
  if (!until) return null;
  return Math.max(0, Math.floor((new Date(until).getTime() - now) / 1000));
}

export default function PartnerOrderPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { toast, refreshProfile } = usePartner();
  const [detail, setDetail] = useState<PartnerOrderDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [otp, setOtp] = useState('');
  const [cash, setCash] = useState('');
  const [panel, setPanel] = useState<'none' | 'reject' | 'issue'>('none');
  const [rejectReason, setRejectReason] = useState<DeliveryRejectReason>('vehicle_unavailable');
  const [issueReason, setIssueReason] = useState<DeliveryIssueReason>('customer_not_available');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const secondsLeft = useCountdown(detail?.otp?.expiresAt);

  const load = useCallback(async () => {
    try { setDetail(await api.partner.order(id)); setMissing(false); }
    catch (err) { if ((err as { status?: number }).status === 404) setMissing(true); else toast(partnerError(err), 'error'); }
  }, [id, toast]);
  useEffect(() => { void load(); }, [load]);

  /** Run one workflow step, then reload the authoritative order state from the server. */
  const run = async (work: () => Promise<unknown>, success?: string) => {
    setBusy(true); setError('');
    try {
      await work();
      if (success) toast(success, 'success');
      await load(); void refreshProfile().catch(() => undefined);
      return true;
    } catch (err) { setError(partnerError(err)); await load(); return false; }
    finally { setBusy(false); }
  };

  if (missing) return (
    <div className="partner"><main className="partner-main">
      <p className="empty-state">This order is no longer assigned to you.</p>
      <Link className="btn btn-primary" href="/partner">Back to orders</Link>
    </main></div>
  );
  if (!detail) return <div className="partner"><p className="empty-state" role="status">Loading order…</p></div>;

  const { order, assignment, customer, items, payment } = detail;
  const stage = assignment.stage;
  const active = assignment.status === 'assigned';
  const stageIndex = STAGE_ORDER.indexOf(stage);
  const steps = STAGE_ORDER.filter(step => step !== 'awaiting_cod' || payment.method === 'cod');
  const mapsUrl = customer.fullAddress ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(customer.fullAddress)}` : null;

  const submitOtp = (event: FormEvent) => {
    event.preventDefault();
    if (!/^\d{6}$/.test(otp)) { setError('Enter the 6-digit code the customer reads out.'); return; }
    void run(async () => {
      const result = await api.partner.verifyDeliveryOtp(order.id, otp);
      setOtp('');
      if (result.requiresCod) toast(`Code verified. Collect ₹${result.codAmount ?? payment.codAmount} in cash.`, 'success');
      else toast('Delivered. Thank you!', 'success');
    });
  };
  const submitCash = (event: FormEvent) => {
    event.preventDefault();
    if (!/^\d{1,8}(\.\d{1,2})?$/.test(cash.trim())) { setError('Enter the amount you collected, for example 266 or 266.50.'); return; }
    void run(() => api.partner.collectCod(order.id, cash.trim()), 'Cash recorded. Order delivered.');
  };
  const submitReject = (event: FormEvent) => {
    event.preventDefault();
    if (rejectReason === 'other' && !note.trim()) { setError('Tell the store why you cannot take this order.'); return; }
    void run(async () => { await api.partner.reject(order.id, rejectReason, note.trim() || undefined); toast('Order returned to the store for reassignment.', 'info'); router.replace('/partner'); });
  };
  const submitIssue = (event: FormEvent) => {
    event.preventDefault();
    if (issueReason === 'other' && !note.trim()) { setError('Describe the problem.'); return; }
    void run(async () => {
      await api.partner.reportIssue(order.id, { reason: issueReason, ...(note.trim() ? { description: note.trim() } : {}), clientRequestId: crypto.randomUUID() });
      setPanel('none'); setNote('');
    }, 'Problem reported. The store will contact you.');
  };

  return (
    <div className="partner">
      <header className="partner-top">
        <Link href="/partner" className="icon-btn" aria-label="Back to orders"><ArrowLeft size={20} /></Link>
        <div className="title"><strong>Order #{order.orderNumber}</strong><small>{STAGE_LABEL[stage]}</small></div>
      </header>
      <main className="partner-main">
        <div className="stage" aria-label="Delivery progress">
          {steps.map(step => {
            const index = STAGE_ORDER.indexOf(step);
            return <span key={step} className={index < stageIndex ? 'done' : index === stageIndex ? 'now' : ''}>{STAGE_LABEL[step]}</span>;
          })}
        </div>
        {order.deliveryException && <div className="alert alert-warning" role="status">The store is reviewing a problem with this delivery.</div>}
        {error && <div className="alert alert-danger" role="alert">{error}</div>}

        {active && stage === 'awaiting_acceptance' && (
          <section className="card" aria-label="Accept order">
            <h2>New delivery</h2>
            <p className="muted" style={{ margin: 0 }}>Accept to confirm you will deliver this order, or return it to the store.</p>
            <button type="button" className="btn btn-primary btn-lg" disabled={busy} onClick={() => void run(() => api.partner.accept(order.id), 'Order accepted.')}>Accept order</button>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => { setPanel(panel === 'reject' ? 'none' : 'reject'); setNote(''); setError(''); }}>I cannot take this order</button>
          </section>
        )}

        {active && stage === 'awaiting_pickup' && (
          <section className="card" aria-label="Pick up">
            <h2>Pick up from the store</h2>
            {assignment.readyForPickup ? (
              <>
                <p className="muted" style={{ margin: 0 }}>Check the items below, then start the delivery. The customer receives a delivery code.</p>
                <button type="button" className="btn btn-primary btn-lg" disabled={busy} onClick={() => void run(async () => {
                  const result = await api.partner.pickup(order.id);
                  toast(result.otpSent ? 'Out for delivery. The customer has been sent their code.' : 'Out for delivery. The SMS failed; the customer can see the code in their order.', result.otpSent ? 'success' : 'info');
                })}>Picked up, start delivery</button>
              </>
            ) : <div className="alert alert-info">The store is still packing this order. You can pick it up once it is packed.</div>}
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => { setPanel(panel === 'reject' ? 'none' : 'reject'); setNote(''); setError(''); }}>I cannot deliver this order</button>
          </section>
        )}

        {active && panel === 'reject' && (stage === 'awaiting_acceptance' || stage === 'awaiting_pickup') && (
          <form className="card" onSubmit={submitReject} aria-label="Return order to store">
            <h2>Return to the store</h2>
            <label className="field"><span>Reason</span>
              <select className="select" value={rejectReason} onChange={event => setRejectReason(event.target.value as DeliveryRejectReason)}>
                {REJECT_REASONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label className="field"><span>Note {rejectReason === 'other' ? '(required)' : '(optional)'}</span>
              <textarea className="textarea" maxLength={500} value={note} onChange={event => setNote(event.target.value)} />
            </label>
            <button className="btn btn-outline" disabled={busy}>Return order to store</button>
          </form>
        )}

        {active && stage === 'out_for_delivery' && (
          <form className="card" onSubmit={submitOtp} aria-label="Customer delivery code">
            <h2>Customer delivery code</h2>
            <p className="muted" style={{ margin: 0 }}>Ask the customer for the 6-digit code shown in their order or sent by SMS. Hand over the items only after it is verified.</p>
            <input id="delivery-otp" className="input otp-entry" inputMode="numeric" autoComplete="off" maxLength={6} aria-label="Delivery code" value={otp} onChange={event => setOtp(event.target.value.replace(/\D/g, ''))} />
            {detail.otp && (
              <p className="field-hint" style={{ margin: 0 }}>
                {secondsLeft && secondsLeft > 0 ? `Code valid for ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}` : 'The code has expired. Send a new code.'}
                {' · '}{detail.otp.attemptsRemaining} attempt{detail.otp.attemptsRemaining === 1 ? '' : 's'} left
              </p>
            )}
            <button className="btn btn-primary btn-lg" disabled={busy}>Verify code</button>
            <button type="button" className="btn btn-ghost" disabled={busy || (detail.otp?.sendsRemaining ?? 0) <= 0} onClick={() => void run(async () => {
              const result = await api.partner.resendOtp(order.id);
              toast(result.otpSent ? 'A new code was sent. The previous code no longer works.' : 'A new code was created; the SMS failed. The customer can see it in their order.', 'info');
            })}>Send a new code{detail.otp ? ` (${detail.otp.sendsRemaining} left)` : ''}</button>
          </form>
        )}

        {active && stage === 'awaiting_cod' && (
          <form className="card" onSubmit={submitCash} aria-label="Collect cash">
            <h2>Collect cash</h2>
            <p className="due" aria-label="Amount due">₹{payment.codAmount}</p>
            <label className="field"><span>Amount collected (₹)</span>
              <input id="cod-amount" className="input" inputMode="decimal" value={cash} onChange={event => setCash(event.target.value.replace(/[^\d.]/g, ''))} placeholder={payment.codAmount ?? ''} />
            </label>
            <button className="btn btn-primary btn-lg" disabled={busy}>Cash collected, complete delivery</button>
          </form>
        )}

        {stage === 'delivered' && (
          <section className="card" aria-label="Delivered">
            <h2>Delivered</h2>
            <p className="muted" style={{ margin: 0 }}>
              {assignment.deliveredAt ? `Completed ${new Date(assignment.deliveredAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}.` : 'Completed.'}
              {payment.collection ? ` Cash collected: ₹${payment.collection.amount}.` : ''}
            </p>
            <Link className="btn btn-primary" href="/partner">Back to orders</Link>
          </section>
        )}

        <section className="card" aria-label="Customer">
          <h2>Customer</h2>
          <dl className="kv"><dt>Name</dt><dd>{customer.name}</dd><dt>Address</dt><dd>{customer.fullAddress}</dd>
            {customer.address?.landmark && <><dt>Instructions</dt><dd>{customer.address.landmark}</dd></>}
          </dl>
          {active && (
            <div className="contact-actions">
              {customer.phone ? <a className="btn btn-outline" href={`tel:${customer.phone}`}><Phone size={18} /> Call</a> : <span />}
              {mapsUrl && <a className="btn btn-outline" href={mapsUrl} target="_blank" rel="noopener noreferrer"><MapPin size={18} /> Map</a>}
            </div>
          )}
        </section>

        <section className="card" aria-label="Items">
          <h2>Items ({order.itemCount})</h2>
          <ul className="items">{items.map(item => <li key={item.id}><span>{item.name}{item.variant ? ` · ${item.variant}` : ''}</span><strong>× {item.quantity}</strong></li>)}</ul>
          <dl className="kv"><dt>Payment</dt><dd>{payment.method === 'cod' ? (payment.status === 'paid' ? 'Cash collected' : 'Cash on delivery') : 'Prepaid'}</dd><dt>Order total</dt><dd>₹{payment.total}</dd></dl>
        </section>

        {active && stage !== 'awaiting_acceptance' && stage !== 'delivered' && (
          panel === 'issue' ? (
            <form className="card" onSubmit={submitIssue} aria-label="Report a problem">
              <h2>Report a problem</h2>
              <label className="field"><span>Problem</span>
                <select className="select" value={issueReason} onChange={event => setIssueReason(event.target.value as DeliveryIssueReason)}>
                  {ISSUE_REASONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
              <label className="field"><span>Details {issueReason === 'other' ? '(required)' : '(optional)'}</span>
                <textarea className="textarea" maxLength={1000} value={note} onChange={event => setNote(event.target.value)} />
              </label>
              <button className="btn btn-outline" disabled={busy}>Send to store</button>
              <button type="button" className="btn btn-ghost" onClick={() => setPanel('none')}>Cancel</button>
            </form>
          ) : <button type="button" className="btn btn-ghost" onClick={() => { setPanel('issue'); setNote(''); setError(''); }}>Report a delivery problem</button>
        )}
        {detail.issues.length > 0 && (
          <section className="card" aria-label="Reported problems">
            <h2>Reported problems</h2>
            <ul className="items">{detail.issues.map(issue => <li key={issue.id}><span>{ISSUE_REASONS.find(([value]) => value === issue.reason)?.[1] ?? issue.reason}</span><span className="badge badge-neutral">{issue.status.replace('_', ' ')}</span></li>)}</ul>
          </section>
        )}
      </main>
    </div>
  );
}
