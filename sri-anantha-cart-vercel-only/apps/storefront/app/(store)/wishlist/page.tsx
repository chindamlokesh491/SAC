import type { Metadata } from 'next';
import { Breadcrumbs } from '@/components/store/Breadcrumbs';
import { WishlistView } from '@/components/store/WishlistView';

export const metadata: Metadata = { title: 'My Wishlist', robots: { index: false } };

/** Works without signing in: guests see the products saved on this device. */
export default function WishlistPage() {
  return (
    <div className="container" style={{ paddingBottom: 48 }}>
      <Breadcrumbs items={[{ label: 'Wishlist' }]} />
      <WishlistView />
    </div>
  );
}
