'use client';

import { ChevronDown, Bell, Boxes, CreditCard, FileBarChart, House, LayoutGrid, LogOut, Menu, Package, ClipboardList, Search, Settings, Truck, Users, ExternalLink, KeyRound, ScrollText } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useAdmin } from './AdminProvider';

// The storefront is a separate app (and domain); set NEXT_PUBLIC_STOREFRONT_URL in production.
const STOREFRONT_URL = process.env.NEXT_PUBLIC_STOREFRONT_URL ?? 'http://localhost:3000';
import { ConfirmDialog } from './ConfirmDialog';

const NAV = [
  { href: '/admin', label: 'Dashboard', icon: House, exact: true },
  { href: '/admin/products', label: 'Products', icon: Package },
  { href: '/admin/categories', label: 'Categories', icon: LayoutGrid },
  { href: '/admin/orders', label: 'Orders', icon: ClipboardList, badge: 'orders' as const },
  { href: '/admin/returns', label: 'Returns', icon: Package, badge: 'returns' as const },
  { href: '/admin/customers', label: 'Customers', icon: Users },
  { href: '/admin/inventory', label: 'Inventory', icon: Boxes },
  { href: '/admin/payments', label: 'Payments & Refunds', icon: CreditCard },
  { href: '/admin/delivery', label: 'Delivery Settings', icon: Truck },
  { href: '/admin/reports', label: 'Reports', icon: FileBarChart, adminOnly: true },
  { href: '/admin/audit', label: 'Audit Log', icon: ScrollText, adminOnly: true },
  { href: '/admin/settings', label: 'Settings', icon: Settings },
];

export function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, isAdmin, notifications, signOut } = useAdmin();
  const [menuOpen, setMenuOpen] = useState(false);
  const [userOpen, setUserOpen] = useState(false);
  const [bellOpen, setBellOpen] = useState(false);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [query, setQuery] = useState('');
  const sideRef = useRef<HTMLElement>(null);
  useEffect(() => { setMenuOpen(false); setUserOpen(false); setBellOpen(false); }, [pathname]);

  const alerts = notifications ? notifications.pending_orders + notifications.return_requests + notifications.low_stock + notifications.payments_need_review : 0;
  const search = (event: FormEvent) => { event.preventDefault(); if (query.trim().length >= 2) router.push(`/admin/search?q=${encodeURIComponent(query.trim())}`); };
  const initial = (user?.name ?? 'Admin').charAt(0).toUpperCase();

  return (
    <div className="admin-shell">
      <aside className={`admin-side${menuOpen ? ' open' : ''}`} ref={sideRef} aria-label="Admin navigation">
        <Link href="/admin" className="admin-brand">
          <img src="/brand/lotus.png" alt="" width={58} height={45} />
          <span><strong>Sri Anantha Cart</strong><small>ADMIN PANEL</small></span>
        </Link>
        <nav className="admin-nav">
          {NAV.filter(item => !item.adminOnly || isAdmin).map(({ href, label, icon: Icon, exact, badge }) => {
            const active = exact ? pathname === href : pathname.startsWith(href);
            return (
              <Link key={href} href={href} className={active ? 'active' : ''} aria-current={active ? 'page' : undefined}>
                <Icon size={22} strokeWidth={1.8} /> {label}
                {badge === 'orders' && notifications && notifications.pending_orders > 0 && <span className="count">{notifications.pending_orders}</span>}
                {badge === 'returns' && notifications && notifications.return_requests > 0 && <span className="count">{notifications.return_requests}</span>}
              </Link>
            );
          })}
        </nav>
        <div className="admin-side-foot">
          <strong><img src="/brand/lotus.png" alt="" width={24} height={19} /> Sri Anantha Cart</strong>
          <p>Bringing Divine Essentials to Your Doorstep in Tirupati</p>
        </div>
      </aside>
      <div className="admin-main">
        <header className="admin-top">
          <button type="button" className="icon-btn admin-menu-btn" onClick={() => setMenuOpen(!menuOpen)} aria-label="Toggle menu"><Menu size={22} /></button>
          <form className="admin-search" onSubmit={search} role="search">
            <Search size={18} />
            <input type="search" placeholder="Search orders, products, customers..." value={query} onChange={event => setQuery(event.target.value)} aria-label="Search admin" maxLength={80} />
          </form>
          <div className="admin-top-actions">
            <div style={{ position: 'relative' }}>
              <button type="button" className="bell" onClick={() => setBellOpen(!bellOpen)} aria-label={`${alerts} notifications`} aria-expanded={bellOpen}>
                <Bell size={24} />{alerts > 0 && <span className="dot">{alerts > 99 ? '99+' : alerts}</span>}
              </button>
              {bellOpen && notifications && (
                <div className="dropdown" style={{ minWidth: 280 }}>
                  <p className="dropdown-title">Needs attention</p>
                  <Link href="/admin/orders?status=placed"><ClipboardList size={18} /> {notifications.pending_orders} orders awaiting acceptance</Link>
                  <Link href="/admin/returns"><Package size={18} /> {notifications.return_requests} return requests</Link>
                  <Link href="/admin/inventory?stock=low"><Boxes size={18} /> {notifications.low_stock} low / out of stock items</Link>
                  {notifications.payments_need_review > 0 && <Link href="/admin/payments"><CreditCard size={18} /> {notifications.payments_need_review} payments need review</Link>}
                  {notifications.open_refunds > 0 && <Link href="/admin/payments?tab=refunds"><CreditCard size={18} /> {notifications.open_refunds} refunds in progress</Link>}
                </div>
              )}
            </div>
            <div style={{ position: 'relative' }}>
              <button type="button" className="admin-user" onClick={() => setUserOpen(!userOpen)} aria-expanded={userOpen}>
                <span className="avatar">{initial}</span><span>{user?.name ?? (isAdmin ? 'Admin' : 'Operator')}</span><ChevronDown size={18} />
              </button>
              {userOpen && (
                <div className="dropdown">
                  <p className="dropdown-title">{user?.phone} · {user?.role}</p>
                  <Link href="/admin/account"><KeyRound size={18} /> My account &amp; password</Link>
                  <a href={STOREFRONT_URL} target="_blank" rel="noopener"><ExternalLink size={18} /> View storefront</a>
                  <button type="button" onClick={() => { setUserOpen(false); setConfirmSignOut(true); }}><LogOut size={18} /> Sign out</button>
                </div>
              )}
            </div>
          </div>
        </header>
        <main className="admin-content" id="main">{children}</main>
      </div>
      {confirmSignOut && (
        <ConfirmDialog title="Sign out?" confirmLabel="Sign out" onClose={() => setConfirmSignOut(false)} onConfirm={async () => { await signOut(); setConfirmSignOut(false); }}>
          <p>Would you like to sign out of the admin panel? You will need your mobile number and password to sign in again.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
