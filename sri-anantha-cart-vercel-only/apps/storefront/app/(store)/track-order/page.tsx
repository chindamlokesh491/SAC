'use client';

import { type OrderDetail } from '@sac/contracts';
import { formatDateTime } from '@sac/shared';
import { Headphones } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState, type FormEvent } from 'react';
import { StatusBadge } from '@/components/store/StatusBadge';
import { errorMessage, useStore } from '@/components/store/StoreProvider';
import { Tracker } from '@/components/store/Tracker';
import { api } from '@/lib/api';

function TrackOrder() {
  const search = useSearchParams();
  const router = useRouter();
  const { user, ready } = useStore();
  const [reference, setReference] = useState(search.get('order') ?? '');
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const track = useCallback(async (value: string) => {
    setError(''); setBusy(true);
    try { const { order_id } = await api.trackOrder(value.trim()); setOrder(await api.order(order_id)); }
    catch (err) { setOrder(null); setError(errorMessage(err, 'We could not find that order')); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { const initial = search.get('order'); if (user && initial) void track(initial); }, [user, search, track]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!user) { router.push(`/login?next=${encodeURIComponent(`/track-order?order=${reference.trim()}`)}`); return; }
    void track(reference);
  };

  return (
    <div className="container" style={{ maxWidth: 960 }}>
      <div className="track-head">
        <div><h1>Track Order</h1><p>Enter your order ID to track your order</p></div>
        <form className="track-form" onSubmit={submit}>
          <label htmlFor="order-ref" className="sr-only">Order ID</label>
          <input id="order-ref" className="input" placeholder="Enter Order ID (e.g. SA12345)" value={reference} onChange={event => setReference(event.target.value.toUpperCase())} maxLength={20} required />
          <button type="submit" className="btn btn-primary" disabled={busy}>Track Order</button>
        </form>
      </div>
      {ready && !user && <div className="alert alert-info">Please <Link href="/login?next=/track-order" className="link-red">sign in</Link> to track your orders.</div>}
      {error && <div className="alert alert-danger" role="alert">{error}</div>}
      {order && (
        <div className="track-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start' }}>
            <div><h2 style={{ fontFamily: 'var(--font-sans)', fontSize: 19 }}>Order #{order.display_number}</h2><p className="muted" style={{ margin: '2px 0 0' }}>{formatDateTime(order.created_at)}</p></div>
            <StatusBadge status={order.status} />
          </div>
          <Tracker order={order} />
          <Link href={`/account/orders/${order.id}`} className="link-red">View order details →</Link>
        </div>
      )}
      <div className="support-card">
        <div><Headphones size={44} /><div><strong>Contact Support</strong><p>Need help with your order?<br />We&apos;re here to assist you.</p></div></div>
        <Link href="/contact" className="btn btn-outline btn-lg">Contact Us</Link>
      </div>
    </div>
  );
}

export default function TrackOrderPage() { return <Suspense fallback={null}><TrackOrder /></Suspense>; }
