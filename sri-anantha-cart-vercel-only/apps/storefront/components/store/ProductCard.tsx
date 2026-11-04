'use client';

import { type ProductCard as Product } from '@sac/contracts';
import { discountPercent, formatRupees } from '@sac/shared';
import { Heart, ShoppingCart } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { CartStepper } from './ProductPurchase';
import { useStore } from './StoreProvider';

export function ProductCard({ product, showSubtitle = true }: { product: Product; showSubtitle?: boolean }) {
  const { addToCart, wishlist, toggleWishlist, lineFor } = useStore();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const saved = wishlist.has(product.id);
  const off = discountPercent(product.price_paise, product.mrp_paise);
  const outOfStock = product.stock_status === 'out_of_stock';

  const onAdd = async () => {
    // Products with size/pack options need a choice on the product page first.
    if (product.has_variants) { router.push(`/products/${product.slug}`); return; }
    setBusy(true);
    await addToCart(product.id, 1);
    setBusy(false);
  };

  return (
    <article className="product-card">
      <Link href={`/products/${product.slug}`} className="product-media" aria-label={product.name}>
        {product.thumb_url && <img src={product.thumb_url} alt={product.name} loading="lazy" width={400} height={258} />}
        {product.stock_status === 'low_stock' && <span className="badge badge-warning tag">Only a few left</span>}
        {outOfStock && <span className="badge badge-neutral tag">Out of stock</span>}
      </Link>
      <button type="button" className="wish-btn" onClick={() => void toggleWishlist(product.id)} aria-pressed={saved} aria-label={saved ? `Remove ${product.name} from wishlist` : `Save ${product.name} to wishlist`}>
        <Heart size={18} fill={saved ? 'currentColor' : 'none'} />
      </button>
      <div className="product-body">
        <h3><Link href={`/products/${product.slug}`}>{product.name}</Link></h3>
        {showSubtitle && <p className="product-sub">{product.short_description ?? product.category_name}</p>}
        <div className="product-price">
          <span className="price">{product.has_variants ? 'From ' : ''}{formatRupees(product.price_paise)}</span>
          {off > 0 && <><span className="mrp">{formatRupees(product.mrp_paise)}</span><span className="off">{off}% off</span></>}
        </div>
        {outOfStock
          ? <p className="oos-note">Out of stock</p>
          : !product.has_variants && lineFor(product.id) ? <CartStepper productId={product.id} name={product.name} />
          : (
            <button type="button" className="btn btn-outline" onClick={() => void onAdd()} disabled={busy}>
              <ShoppingCart size={18} /> {product.has_variants ? 'Choose Option' : 'Add to Cart'}
            </button>
          )}
      </div>
    </article>
  );
}
