'use client';

import { type CategoryNode, type ProductCard } from '@sac/contracts';
import { formatRupees } from '@sac/shared';
import { ChevronDown, Heart, LogOut, MapPin, Package, Search, Settings, ShoppingCart, User as UserIcon, MapPinned, Truck, ShieldCheck, CreditCard } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { PincodeChecker, useDeviceLocation } from './LocationTools';
import { MobileMenu } from './MobileMenu';
import { openAssistant } from './ShoppingAssistant';
import { useStore } from './StoreProvider';

export function TopBar() {
  return (
    <div className="topbar">
      <div className="container">
        <div className="topbar-promises">
          <span><Truck size={16} /> <span>15-30 Minute <br />Delivery in Tirupati</span></span>
          <span><ShieldCheck size={16} /> <span>100% Authentic <br />Products</span></span>
          <span><CreditCard size={16} /> <span>Trusted by <br />Devotees</span></span>
        </div>
        <nav className="topbar-links" aria-label="Help">
          <Link href="/about">About Us</Link>
          <Link href="/contact">Help</Link>
          <Link href="/track-order">Track Order</Link>
          <button type="button" className="topbar-assistant" onClick={openAssistant}>Shopping Assistant</button>
        </nav>
      </div>
    </div>
  );
}

function useClickOutside(onOutside: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (event: MouseEvent) => { if (ref.current && !ref.current.contains(event.target as Node)) onOutside(); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') onOutside(); };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('mousedown', handler); document.removeEventListener('keydown', escape); };
  }, [onOutside]);
  return ref;
}

function SearchBox() {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<{ products: ProductCard[]; categories: { name: string; slug: string }[] }>({ products: [], categories: [] });
  const ref = useClickOutside(() => setOpen(false));

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setResults({ products: [], categories: [] }); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      api.suggest(q, controller.signal).then(setResults).catch(() => undefined);
    }, 180);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const q = query.trim();
    if (!q) return;
    setOpen(false);
    router.push(`/search?q=${encodeURIComponent(q)}`);
  };
  const hasResults = results.products.length > 0 || results.categories.length > 0;

  return (
    <div className="search" ref={ref}>
      <form role="search" onSubmit={submit}>
        <label htmlFor="site-search" className="sr-only">Search products</label>
        <input id="site-search" type="search" placeholder="Search for pooja items, brands, or occasions..." value={query} autoComplete="off"
          onChange={event => { setQuery(event.target.value); setOpen(true); }} onFocus={() => setOpen(true)} maxLength={100} />
        <button type="submit" aria-label="Search"><Search size={20} /></button>
      </form>
      {open && query.trim().length >= 2 && (
        <div className="suggest" role="listbox" aria-label="Search suggestions">
          {!hasResults && <p className="suggest-heading">No matches yet — press Enter to search</p>}
          {results.categories.length > 0 && <p className="suggest-heading">Categories</p>}
          {results.categories.map(category => (
            <Link key={category.slug} href={`/c/${category.slug}`} onClick={() => setOpen(false)}>{category.name}</Link>
          ))}
          {results.products.length > 0 && <p className="suggest-heading">Products</p>}
          {results.products.map(product => (
            <Link key={product.id} href={`/products/${product.slug}`} onClick={() => setOpen(false)}>
              {product.thumb_url && <img src={product.thumb_url} alt="" width={38} height={38} />}
              <span><strong>{product.name}</strong><small>{formatRupees(product.price_paise)}</small></span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function DeliveryPin() {
  const { pincode, ready, setPincode } = useStore();
  const location = useDeviceLocation();
  const [open, setOpen] = useState(false);
  const [detecting, setDetecting] = useState(false);
  useEffect(() => {
    if (!ready || pincode) return;
    let cancelled = false;
    setDetecting(true);
    void (async () => {
      try {
        const found = await location.detect();
        if (!found?.postal_code || cancelled) return;
        const availability = await api.deliveryAvailability(found.postal_code);
        if (!cancelled) setPincode(availability.postal_code);
      } catch { /* The PIN remains unset; the customer can retry from the location control. */ }
      finally { if (!cancelled) setDetecting(false); }
    })();
    return () => { cancelled = true; };
  }, [ready, pincode, location.detect, setPincode]);
  const ref = useClickOutside(() => setOpen(false));
  return (
    <div style={{ position: 'relative' }} ref={ref}>
      <button type="button" className="header-action pin-action" onClick={() => setOpen(!open)} aria-expanded={open}>
        <MapPin size={24} strokeWidth={1.8} />
        <span><small>Delivering at</small><strong>{pincode || (detecting ? 'Detecting location…' : 'Set delivery PIN')} <ChevronDown size={14} /></strong></span>
      </button>
      {open && (
        <div className="dropdown pin-popover">
          <strong>Check delivery to your area</strong>
          <PincodeChecker autoFocus />
        </div>
      )}
    </div>
  );
}

function WishlistLink() {
  const { user, wishlist } = useStore();
  const count = wishlist.size;
  return (
    <Link href={user ? '/account/wishlist' : '/wishlist'} className="header-icon-link" aria-label={`Wishlist, ${count} items`}>
      <Heart size={24} strokeWidth={1.8} />
      {count > 0 && <span className="cart-count">{count}</span>}
    </Link>
  );
}

function AccountMenu() {
  const { user, ready, askSignOut } = useStore();
  const [open, setOpen] = useState(false);
  const ref = useClickOutside(() => setOpen(false));
  if (!ready || !user) {
    return (
      <Link className="header-action account-action" href="/login">
        <UserIcon size={24} strokeWidth={1.8} />
        <span><small>Sign In</small><strong><span className="label-long">Account</span> <ChevronDown size={14} /></strong></span>
      </Link>
    );
  }
  const first = user.name?.split(' ')[0];
  return (
    <div className="account-action" style={{ position: 'relative' }} ref={ref}>
      <button type="button" className="header-action" onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="menu">
        <UserIcon size={24} strokeWidth={1.8} />
        <span><small>{first ? `Hello, ${first}` : 'My'}</small><strong><span className="label-long">Account</span> <ChevronDown size={14} /></strong></span>
      </button>
      {open && (
        <div className="dropdown" role="menu" onClick={() => setOpen(false)}>
          <p className="dropdown-title">{user.phone ?? user.email}</p>
          <Link href="/account/orders" role="menuitem"><Package size={18} /> My Orders</Link>
          <Link href="/account/addresses" role="menuitem"><MapPinned size={18} /> My Addresses</Link>
          <Link href={user ? "/account/wishlist" : "/wishlist"} role="menuitem"><Heart size={18} /> Wishlist</Link>
          <Link href="/account/settings" role="menuitem"><Settings size={18} /> Account Settings</Link>
          {(user.role === 'admin' || user.role === 'operator') && <Link href="/admin" role="menuitem"><Settings size={18} /> Admin Panel</Link>}
          <hr />
          <button type="button" role="menuitem" onClick={askSignOut}><LogOut size={18} /> Logout</button>
        </div>
      )}
    </div>
  );
}

export function Header({ categories = [] }: { categories?: CategoryNode[] }) {
  const { cart } = useStore();
  const count = cart?.item_count ?? 0;
  return (
    <header className="site-header">
      <div className="container header-row">
        <MobileMenu categories={categories} />
        <Link href="/" className="brand-logo" aria-label="Sri Anantha Cart home">
          <img src="/brand/logo-full.webp" alt="Sri Anantha Cart — Your Pooja Essentials" width={214} height={50} />
        </Link>
        <SearchBox />
        <div className="header-actions">
          <DeliveryPin />
          <AccountMenu />
          <WishlistLink />
          <Link href="/cart" className="cart-link" aria-label={`Cart, ${count} items`}>
            <ShoppingCart size={28} strokeWidth={1.8} />
            {count > 0 && <span className="cart-count">{count}</span>}
          </Link>
        </div>
      </div>
    </header>
  );
}
