'use client';

import { type OrderSummary } from '@sac/contracts';
import { formatDateTime, formatRupees } from '@sac/shared';
import { Package } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { StatusBadge } from '@/components/store/StatusBadge';
import { api } from '@/lib/api';

const TABS = [['', 'All'], ['processing', 'Processing'], ['delivered', 'Delivered'], ['cancelled', 'Cancelled']] as const;

export default function OrdersPage() {
  const [tab, setTab] = useState('');
  const [orders, setOrders] = useState<OrderSummary[] | null>(null);
  useEffect(() => { setOrders(null); api.orders(tab || undefined).then(setOrders).catch(() => setOrders([])); }, [tab]);
  return (
    <>
      <div className="account-head"><h1>My Orders</h1></div>
      <div className="tabbar" role="tablist">
        {TABS.map(([value, label]) => <button key={label} type="button" role="tab" aria-selected={tab === value} className={tab === value ? 'active' : ''} onClick={() => setTab(value)}>{label}</button>)}
      </div>
      {orders === null ? <div className="skeleton" style={{ height: 220 }} /> : orders.length === 0 ? (
        <div className="empty"><Package size={42} style={{ margin: '0 auto 10px', color: 'var(--saffron)' }} /><h2>No orders here yet</h2><Link href="/categories" className="btn btn-primary">Start Shopping</Link></div>
      ) : orders.map(order => (
        <div key={order.id} className="order-row">
          {order.thumbs[0] ? <img src={order.thumbs[0]} alt="" width={48} height={48} /> : <Package size={40} color="var(--saffron)" />}
          <div><h3>Order #{order.display_number}</h3><p>{formatDateTime(order.created_at)}</p></div>
          <StatusBadge status={order.status} />
          <div className="amount">{order.item_count} {order.item_count === 1 ? 'item' : 'items'}<strong>{formatRupees(order.total_paise)}</strong></div>
          <Link href={`/account/orders/${order.id}`} className="btn btn-outline btn-sm">View Details</Link>
        </div>
      ))}
    </>
  );
}
