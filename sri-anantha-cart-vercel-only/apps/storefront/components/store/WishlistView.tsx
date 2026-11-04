'use client';

import type { ProductCard as Product } from '@sac/contracts';
import { Heart } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ProductCard } from './ProductCard';
import { useStore } from './StoreProvider';
import { api } from '@/lib/api';

/** Saved products, for signed-in customers (from the account) and guests (from this device). */
export function WishlistView({ heading = 'h1' }: { heading?: 'h1' | 'h2' }) {
  const { user, ready, wishlist } = useStore();
  const [items, setItems] = useState<Product[] | null>(null);
  const ids = [...wishlist].sort().join(',');
  useEffect(() => {
    if (!ready) return;
    const load = user ? api.wishlist().then(result => result.items) : api.productsByIds(ids ? ids.split(',') : []);
    load.then(setItems).catch(() => setItems([]));
  }, [ready, user, ids]);
  const visible = items?.filter(item => wishlist.has(item.id)) ?? null;
  const Heading = heading;
  return (
    <>
      <div className="account-head"><Heading className="page-title" style={{ margin: 0 }}>My Wishlist <small className="muted" style={{ fontSize: 16, fontFamily: 'var(--font-sans)', fontWeight: 500 }}>({visible?.length ?? 0} {visible?.length === 1 ? 'item' : 'items'})</small></Heading></div>
      {!user && ready && <p className="alert alert-info" style={{ margin: '0 0 16px' }}>Saved on this device. <Link href="/login?next=/wishlist" className="link-red">Sign in</Link> to keep your wishlist on every device.</p>}
      {visible === null ? <div className="skeleton" style={{ height: 260 }} /> : visible.length === 0 ? (
        <div className="empty"><Heart size={40} style={{ margin: '0 auto 10px', color: 'var(--red)' }} /><h2>Your wishlist is empty</h2><p>Tap the heart on any product to save it here.</p><Link href="/categories" className="btn btn-primary">Browse Products</Link></div>
      ) : <div className="product-grid">{visible.map(product => <ProductCard key={product.id} product={product} />)}</div>}
    </>
  );
}
