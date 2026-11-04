'use client';

import { type OrderDetail } from '@sac/contracts';
import { formatDateTime, formatRupees, PAYMENT_METHOD_LABELS } from '@sac/shared';
import { Check, PackageSearch } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Tracker } from '@/components/store/Tracker';
import { useStore } from '@/components/store/StoreProvider';
import { api } from '@/lib/api';

const CONFETTI = [['#f4b400', -60, -30], ['#2fae55', 70, -40], ['#e5781c', -80, 30], ['#2fae55', 90, 20], ['#f4b400', -30, -70], ['#e5781c', 40, -75], ['#2fae55', -95, -5], ['#f4b400', 100, -10]] as const;

export default function ConfirmationPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { user, ready } = useStore();
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [error, setError] = useState('');

  useEffect(() => { if (ready && !user) router.replace(`/login?next=/orders/${id}/confirmation`); }, [ready, user, router, id]);
  useEffect(() => {
    if (!user) return;
    api.order(id).then(setOrder).catch(() => setError('We could not find this order.'));
  }, [user, id]);

  if (error) return <div className="container confirm"><div className="empty"><h2>{error}</h2><Link href="/account/orders" className="btn btn-primary">My Orders</Link></div></div>;
  if (!order) return <div className="container confirm"><div className="skeleton" style={{ height: 380 }} /></div>;

  const express = order.delivery_mode === 'express';
  return (
    <div className="container confirm">
      <div className="confirm-burst" aria-hidden="true">
        {CONFETTI.map(([color, x, y], index) => <i key={index} style={{ background: color, left: 44 + x, top: 44 + y, transform: `rotate(${index * 40}deg)` }} />)}
        <div className="check"><Check size={54} strokeWidth={3} /></div>
      </div>
      <h1>Order Placed Successfully!</h1>
      <p>
        {express
          ? <>Your pooja items are on the way and will be delivered in 15-30 minutes in Tirupati.</>
          : <>Your order is confirmed for your selected delivery slot{order.delivery_slot_start ? ` on ${formatDateTime(order.delivery_slot_start)}` : ''}.</>}
        {order.payment_method === 'cod' && <> Please keep <strong>{formatRupees(order.total_paise)}</strong> ready to pay in cash on delivery.</>}
      </p>
      <div className="order-card">
        <div>
          <h2>Order #{order.display_number}</h2>
          <p>{formatDateTime(order.created_at)} · {order.payment_method ? PAYMENT_METHOD_LABELS[order.payment_method] : ''} · {formatRupees(order.total_paise)}</p>
        </div>
        <Link href={`/account/orders/${order.id}`} className="btn btn-outline">View Order</Link>
      </div>
      <Tracker order={order} />
      <div className="confirm-actions">
        <Link href={`/track-order?order=${order.display_number}`} className="btn btn-primary btn-lg"><PackageSearch size={20} /> Track Order</Link>
        <Link href="/" className="btn btn-outline btn-lg">Continue Shopping</Link>
      </div>
    </div>
  );
}
