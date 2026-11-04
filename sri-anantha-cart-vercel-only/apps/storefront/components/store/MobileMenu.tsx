'use client';

import type { CategoryNode } from '@sac/contracts';
import { ChevronDown, CircleHelp, Heart, LogIn, LogOut, MapPinned, Menu, MessageCircle, Package, Truck, UserRound, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { TourLink } from './FirstVisit';
import { PincodeChecker } from './LocationTools';
import { openAssistant } from './ShoppingAssistant';
import { useStore } from './StoreProvider';

/** Phone navigation: a ☰ button that opens a drawer with categories, delivery check and account links. */
export function MobileMenu({ categories }: { categories: Pick<CategoryNode, 'id' | 'name' | 'slug' | 'children'>[] }) {
  const { user, pincode, askSignOut } = useStore();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [pinOpen, setPinOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => { setOpen(false); }, [pathname]);
  useEffect(() => {
    if (!open) return;
    document.body.style.overflow = 'hidden';
    panel.current?.querySelector<HTMLElement>('button, a')?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    const trigger = button.current;
    return () => { document.body.style.overflow = ''; document.removeEventListener('keydown', onKey); trigger?.focus(); };
  }, [open]);

  return (
    <>
      <button ref={button} type="button" className="menu-btn" onClick={() => setOpen(true)} aria-label="Open menu" aria-expanded={open}><Menu size={24} /></button>
      {open && (
        <div className="drawer-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setOpen(false); }}>
          <div className="drawer" role="dialog" aria-modal="true" aria-label="Menu" ref={panel}>
            <div className="drawer-head">
              <img src="/brand/logo-full.webp" alt="Sri Anantha Cart" width={170} height={40} />
              <button type="button" className="icon-btn" onClick={() => setOpen(false)} aria-label="Close menu"><X size={22} /></button>
            </div>
            {user
              ? <p className="drawer-hello">Hello{user.name ? `, ${user.name.split(' ')[0]}` : ''}</p>
              : <Link href={`/login?next=${encodeURIComponent(pathname ?? '/')}`} className="btn btn-primary btn-block"><LogIn size={18} /> Sign in / Create account</Link>}

            <div className="drawer-section">
              <button type="button" className="drawer-row" onClick={() => setPinOpen(!pinOpen)} aria-expanded={pinOpen}>
                <MapPinned size={20} /><span>Delivering to <strong>{pincode || 'Tirupati'}</strong></span><ChevronDown size={18} className={pinOpen ? 'rot' : ''} />
              </button>
              {pinOpen && <div className="drawer-pin"><PincodeChecker /></div>}
            </div>

            <nav className="drawer-section" aria-label="Categories">
              <p className="drawer-label">Shop by category</p>
              {categories.map(category => (
                <div key={category.id}>
                  <div className="drawer-cat">
                    <Link href={`/c/${category.slug}`}>{category.name}</Link>
                    {category.children.length > 0 && (
                      <button type="button" className="icon-btn" onClick={() => setExpanded(expanded === category.id ? null : category.id)} aria-expanded={expanded === category.id} aria-label={`Show ${category.name} subcategories`}>
                        <ChevronDown size={18} className={expanded === category.id ? 'rot' : ''} />
                      </button>
                    )}
                  </div>
                  {expanded === category.id && (
                    <div className="drawer-sub">{category.children.map(child => <Link key={child.id} href={`/c/${child.slug}`}>{child.name}</Link>)}</div>
                  )}
                </div>
              ))}
              <Link href="/categories" className="drawer-all">View all categories</Link>
            </nav>

            <nav className="drawer-section" aria-label="Account">
              {user && <Link href="/account" className="drawer-row"><UserRound size={20} /> My Account</Link>}
              {user && <Link href="/account/orders" className="drawer-row"><Package size={20} /> My Orders</Link>}
              <Link href={user ? '/account/wishlist' : '/wishlist'} className="drawer-row"><Heart size={20} /> Wishlist</Link>
              <Link href="/track-order" className="drawer-row"><Truck size={20} /> Track Order</Link>
              {user && <Link href="/account/addresses" className="drawer-row"><MapPinned size={20} /> My Addresses</Link>}
              <Link href="/faq" className="drawer-row"><CircleHelp size={20} /> Help &amp; FAQ</Link>
              <button type="button" className="drawer-row" onClick={() => { setOpen(false); openAssistant(); }}><MessageCircle size={20} /> Shopping Assistant</button>
              <TourLink className="drawer-row"><CircleHelp size={20} /> How to use this store</TourLink>
              {user && <button type="button" className="drawer-row" onClick={() => { setOpen(false); askSignOut(); }}><LogOut size={20} /> Logout</button>}
            </nav>
          </div>
        </div>
      )}
    </>
  );
}
