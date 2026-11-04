'use client';

import type { PartnerOrderSummary } from '@sac/contracts';
import { LogOut, Phone, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { partnerError, usePartner } from '@/components/partner/PartnerProvider';
import { STAGE_BADGE, STAGE_LABEL } from '@/components/partner/stages';
import { api } from '@/lib/api';

type Tab = 'assigned' | 'in_progress' | 'completed';
const TABS: [Tab, string][] = [['assigned', 'New'], ['in_progress', 'In progress'], ['completed', 'Done']];

export default function PartnerHome() {
  const { profile, refreshProfile, toast, signOut } = usePartner();
  const [tab, setTab] = useState<Tab>('assigned');
  const [orders, setOrders] = useState<PartnerOrderSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [toggling, setToggling] = useState(false);

  const load = useCallback(async (which: Tab) => {
    setLoading(true);
    try { setOrders((await api.partner.orders(which)).orders); }
    catch (error) { toast(partnerError(error, 'Could not load orders.'), 'error'); }
    finally { setLoading(false); }
  }, [toast]);

  useEffect(() => { setOrders(null); void load(tab); }, [tab, load]);
  // New assignments arrive from the store; refresh while the app is open and visible.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') { void load(tab); void refreshProfile().catch(() => undefined); }
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [tab, load, refreshProfile]);

  const toggleOnline = async () => {
    if (!profile) return;
    setToggling(true);
    try { await api.partner.setAvailability(!profile.partner.online); await refreshProfile(); }
    catch (error) { toast(partnerError(error), 'error'); }
    finally { setToggling(false); }
  };

  if (!profile) return null;
  const { partner, summary, support } = profile;
  return (
    <div className="partner">
      <header className="partner-top">
        <div className="title"><strong>{partner.name}</strong><small>{partner.partnerCode ?? 'Delivery partner'}</small></div>
        <button type="button" className="icon-btn" aria-label="Refresh" onClick={() => { void load(tab); void refreshProfile(); }}><RefreshCw size={20} /></button>
        <button type="button" className="icon-btn" aria-label="Sign out" onClick={() => void signOut()}><LogOut size={20} /></button>
      </header>
      <main className="partner-main">
        <section className="card partner-online" aria-label="Availability">
          <span className="state"><span className={`dot${partner.online ? ' on' : ''}`} />{partner.online ? 'You are online' : 'You are offline'}</span>
          <button type="button" className={`btn ${partner.online ? 'btn-ghost' : 'btn-primary'}`} disabled={toggling} onClick={() => void toggleOnline()}>{partner.online ? 'Go offline' : 'Go online'}</button>
        </section>
        <section className="partner-summary" aria-label="Today">
          <div><strong>{summary.assigned}</strong><span>New</span></div>
          <div><strong>{summary.inProgress}</strong><span>In progress</span></div>
          <div><strong>{summary.completedToday}</strong><span>Delivered today</span></div>
        </section>
        <div className="partner-tabs" role="tablist" aria-label="Orders">
          {TABS.map(([value, label]) => <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)}>{label}</button>)}
        </div>
        <section aria-live="polite" aria-busy={loading} style={{ display: 'grid', gap: 10 }}>
          {orders === null ? <p className="empty-state">Loading orders…</p>
            : orders.length === 0 ? <p className="empty-state">{tab === 'assigned' ? 'No new orders. The store assigns orders to you here.' : tab === 'in_progress' ? 'Nothing in progress.' : 'No deliveries in the last 7 days.'}</p>
              : orders.map(order => (
                <Link key={order.orderId} href={`/partner/orders/${order.orderId}`} className="partner-order" data-order-id={order.orderId}>
                  <div className="row"><span className="num">#{order.orderNumber}</span><span className={`badge ${STAGE_BADGE[order.stage]}`}>{STAGE_LABEL[order.stage]}</span></div>
                  <div>{order.customerName} · {order.itemCount} item{order.itemCount === 1 ? '' : 's'}</div>
                  <div className="addr">{order.addressSummary || 'Address in order details'}</div>
                  <div className="row"><span className="muted">{order.paymentMethod === 'cod' ? 'Cash on delivery' : 'Prepaid'}</span><strong>₹{order.totalAmount}</strong></div>
                  {order.deliveryException && <span className="badge badge-danger">Store is reviewing a problem</span>}
                </Link>
              ))}
        </section>
        {support.phone && <a className="btn btn-ghost" href={`tel:${support.phone}`}><Phone size={18} /> Call the store</a>}
      </main>
    </div>
  );
}
