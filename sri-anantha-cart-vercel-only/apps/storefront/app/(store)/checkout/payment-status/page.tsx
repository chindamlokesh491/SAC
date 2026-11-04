'use client';

import type { OrderDetail } from '@sac/contracts';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { api } from '@/lib/api';

/** Payment status is always read from the verified server-side order record. */
function PaymentStatus() {
  const search = useSearchParams();
  const router = useRouter();
  const orderId = search.get('order') ?? '';
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [attempts, setAttempts] = useState(0);
  const valid = /^[0-9a-f-]{36}$/i.test(orderId);

  useEffect(() => {
    if (!valid) return;
    let stop = false;
    const poll = async (count: number) => {
      try {
        const current = await api.order(orderId);
        if (stop) return;
        setOrder(current);
        if (current.payment_status === 'paid') { router.replace(`/orders/${orderId}/confirmation`); return; }
        if (current.status === 'pending_payment' && count < 15) { setAttempts(count + 1); window.setTimeout(() => void poll(count + 1), 2000); }
      } catch { if (count < 3) window.setTimeout(() => void poll(count + 1), 2000); }
    };
    void poll(0);
    return () => { stop = true; };
  }, [orderId, valid, router]);

  if (!valid) return <div className="empty"><h2>Payment status unavailable</h2><Link href="/account/orders" className="btn btn-primary">My Orders</Link></div>;
  if (!order || (order.status === 'pending_payment' && attempts < 15)) {
    return <div className="empty"><span className="spinner" style={{ margin: '0 auto 12px', display: 'block' }} /><h2>Confirming your payment…</h2><p>Please do not close this page.</p></div>;
  }
  if (order.payment_status === 'failed' || order.status === 'cancelled') {
    return <div className="empty"><h2>Payment was not completed</h2><p>No money was taken. If an amount was debited, it will be reversed automatically by your bank.</p><Link href="/cart" className="btn btn-primary">Back to Cart</Link></div>;
  }
  return <div className="empty"><h2>Payment is being verified</h2><p>We will update your order as soon as the payment gateway confirms it. You can check its status in My Orders.</p><Link href={`/account/orders/${orderId}`} className="btn btn-primary">View Order</Link></div>;
}

export default function PaymentStatusPage() {
  return <div className="container" style={{ maxWidth: 640, padding: '50px 24px' }}><Suspense fallback={null}><PaymentStatus /></Suspense></div>;
}
