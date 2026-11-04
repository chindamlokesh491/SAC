'use client';

import { Heart, LogOut, MapPin, Package, UserCog } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useStore } from '@/components/store/StoreProvider';

const LINKS = [
  { href: '/account/orders', label: 'My Orders', icon: Package },
  { href: '/account/addresses', label: 'My Addresses', icon: MapPin },
  { href: '/account/wishlist', label: 'Wishlist', icon: Heart },
  { href: '/account/settings', label: 'Account Settings', icon: UserCog },
];

export default function AccountLayout({ children }: { children: React.ReactNode }) {
  const { user, ready, askSignOut } = useStore();
  const router = useRouter();
  const pathname = usePathname();
  useEffect(() => { if (ready && !user) router.replace(`/login?next=${encodeURIComponent(pathname)}`); }, [ready, user, router, pathname]);
  if (pathname.endsWith('/invoice')) return <>{children}</>;
  return (
    <div className="container account">
      <nav className="account-nav" aria-label="My account">
        <h2>My Account</h2>
        {LINKS.map(({ href, label, icon: Icon }) => (
          <Link key={href} href={href} className={pathname.startsWith(href) ? 'active' : ''} aria-current={pathname === href ? 'page' : undefined}><Icon size={20} /> {label}</Link>
        ))}
        <button type="button" onClick={askSignOut}><LogOut size={20} /> Logout</button>
      </nav>
      <section>{ready && user ? children : <div className="skeleton" style={{ height: 300 }} />}</section>
    </div>
  );
}
