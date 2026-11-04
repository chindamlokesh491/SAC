'use client';

import { type ProductDetail } from '@sac/contracts';
import { discountPercent, formatRupees } from '@sac/shared';
import { Clock, Flame, Heart, Leaf, Minus, Plus, Share2, ShieldCheck, ShoppingCart, Sparkles, Flower2, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { imageSrcSet, PRODUCT_IMAGE_SIZES } from '@/lib/images';
import { useStore } from './StoreProvider';

const HIGHLIGHT_ICONS = [Flower2, Clock, ShieldCheck, Sparkles, Leaf, Flame];

export function QuantityStepper({ value, max, onChange, small = false, label = 'Quantity' }: { value: number; max: number; onChange: (value: number) => void; small?: boolean; label?: string }) {
  return (
    <div className={`qty${small ? ' sm' : ''}`} role="group" aria-label={label}>
      <button type="button" onClick={() => onChange(value - 1)} disabled={value <= 1} aria-label="Decrease quantity"><Minus size={small ? 14 : 18} /></button>
      <output aria-live="polite">{value}</output>
      <button type="button" onClick={() => onChange(value + 1)} disabled={value >= max} aria-label="Increase quantity"><Plus size={small ? 14 : 18} /></button>
    </div>
  );
}

/** Shown once an item is in the cart: − quantity +. Going below 1 removes it. */
export function CartStepper({ productId, variantId = null, name, block = false }: { productId: string; variantId?: string | null; name: string; block?: boolean }) {
  const { lineFor, setQuantity } = useStore();
  const [busy, setBusy] = useState(false);
  const line = lineFor(productId, variantId);
  if (!line) return null;
  const change = async (quantity: number) => { setBusy(true); await setQuantity(productId, variantId, quantity); setBusy(false); };
  const atMax = line.quantity >= Math.max(1, line.max_quantity);
  return (
    <div className={`cart-stepper${block ? ' block' : ''}`} role="group" aria-label={`${name} in cart`} aria-busy={busy}>
      <button type="button" onClick={() => void change(line.quantity - 1)} disabled={busy} aria-label={line.quantity === 1 ? `Remove ${name} from cart` : `One less ${name}`}>
        {line.quantity === 1 ? <Trash2 size={16} /> : <Minus size={16} />}
      </button>
      <output aria-live="polite"><strong>{line.quantity}</strong><small>in cart</small></output>
      <button type="button" onClick={() => void change(line.quantity + 1)} disabled={busy || atMax} aria-label={`One more ${name}`} title={atMax ? `Only ${line.max_quantity} available` : undefined}><Plus size={16} /></button>
    </div>
  );
}

export function ProductGallery({ product }: { product: ProductDetail }) {
  const [active, setActive] = useState(0);
  const image = product.images[active];
  return (
    <div>
      <div className="gallery-main">{image ? <img src={image.url} srcSet={imageSrcSet(image.url)} sizes={PRODUCT_IMAGE_SIZES} alt={image.alt_text ?? product.name} width={600} height={540} fetchPriority="high" /> : null}</div>
      {product.images.length > 1 && (
        <div className="gallery-thumbs">
          {product.images.map((item, index) => (
            <button key={item.url} type="button" aria-pressed={index === active} onClick={() => setActive(index)} aria-label={`Show image ${index + 1}`}>
              <img src={item.thumb_url ?? item.url} alt="" width={70} height={70} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function ProductPurchase({ product }: { product: ProductDetail }) {
  const { addToCart, wishlist, toggleWishlist, toast, lineFor } = useStore();
  const router = useRouter();
  const firstAvailable = product.variants.find(variant => variant.max_quantity > 0) ?? product.variants[0];
  const [variantId, setVariantId] = useState<string | null>(firstAvailable?.id ?? null);
  const [quantity, setQuantity] = useState(1);
  const [busy, setBusy] = useState(false);
  const variant = product.variants.find(item => item.id === variantId) ?? null;
  const price = variant?.price_paise ?? product.price_paise;
  const mrp = variant?.mrp_paise ?? product.mrp_paise;
  const max = variant ? variant.max_quantity : product.max_quantity;
  const stock = variant ? variant.stock_status : product.stock_status;
  const off = discountPercent(price, mrp);
  const saved = wishlist.has(product.id);
  const inCart = lineFor(product.id, variantId);
  const gstText = useMemo(() => (product.gst_rate_basis_points ? `Inclusive of ${product.gst_rate_basis_points / 100}% GST` : 'Inclusive of all taxes'), [product.gst_rate_basis_points]);

  const add = async (goToCart: boolean) => {
    setBusy(true);
    const ok = await addToCart(product.id, quantity, variantId);
    setBusy(false);
    if (ok && goToCart) router.push('/cart');
  };
  const share = async () => {
    const url = window.location.href;
    try {
      if (navigator.share) await navigator.share({ title: product.name, url });
      else { await navigator.clipboard.writeText(url); toast('Link copied', 'success'); }
    } catch { /* share sheet dismissed */ }
  };

  return (
    <div className="pdp-info">
      <div className="pdp-title-row">
        <div>
          <h1>{product.name}</h1>
          {product.short_description && <p className="pdp-sub">{product.short_description}</p>}
        </div>
        <span className={`badge ${stock === 'out_of_stock' ? 'badge-danger' : stock === 'low_stock' ? 'badge-warning' : 'badge-success'}`} style={{ fontSize: 14, padding: '7px 14px' }}>
          {stock === 'out_of_stock' ? 'Out of Stock' : stock === 'low_stock' ? 'Only a few left' : 'In Stock'}
        </span>
      </div>
      <div className="pdp-price">
        <span className="price">{formatRupees(price)}</span>
        {off > 0 && <><span className="mrp">MRP {formatRupees(mrp)}</span><span className="off">{off}% off</span></>}
      </div>
      <p className="tax-note">{gstText}</p>
      {product.description && <p className="pdp-desc">{product.description.split('. ').slice(0, 2).join('. ').replace(/\.?$/, '.')}</p>}

      {product.variants.length > 0 && (
        <>
          <p className="field-label" style={{ margin: '0 0 8px' }}>Choose pack size</p>
          <div className="variant-row">
            {product.variants.map(item => (
              <button key={item.id} type="button" className="variant" aria-pressed={item.id === variantId} disabled={item.max_quantity === 0}
                onClick={() => { setVariantId(item.id); setQuantity(1); }}>
                <strong>{item.label}</strong><small>{item.max_quantity === 0 ? 'Out of stock' : formatRupees(item.price_paise)}</small>
              </button>
            ))}
          </div>
        </>
      )}

      <div className="pdp-cta">
        {inCart ? (
          <>
            <CartStepper productId={product.id} variantId={variantId} name={product.name} block />
            <Link href="/cart" className="btn btn-primary btn-lg"><ShoppingCart size={20} /> Go to Cart</Link>
          </>
        ) : (
          <>
            <QuantityStepper value={quantity} max={Math.max(1, max)} onChange={value => setQuantity(Math.min(Math.max(1, value), Math.max(1, max)))} />
            <button type="button" className="btn btn-primary btn-lg" onClick={() => void add(false)} disabled={busy || max === 0}>
              <ShoppingCart size={20} /> {max === 0 ? 'Out of Stock' : 'Add to Cart'}
            </button>
            {max > 0 && <button type="button" className="btn btn-outline" onClick={() => void add(true)} disabled={busy}>Buy Now</button>}
          </>
        )}
        <div className="pdp-secondary">
          <button type="button" onClick={() => void toggleWishlist(product.id)} aria-pressed={saved}><Heart size={20} fill={saved ? 'currentColor' : 'none'} /> {saved ? 'Saved to Wishlist' : 'Add to Wishlist'}</button>
          <button type="button" onClick={() => void share()}><Share2 size={20} /> Share</button>
        </div>
      </div>
    </div>
  );
}

export function ProductHighlights({ highlights }: { highlights: string[] }) {
  if (!highlights.length) return null;
  return (
    <div className="highlights">
      {highlights.map((text, index) => {
        const Icon = HIGHLIGHT_ICONS[index % HIGHLIGHT_ICONS.length]!;
        return <div key={text}><Icon size={30} strokeWidth={1.6} />{text}</div>;
      })}
    </div>
  );
}

export function ProductTabs({ product }: { product: ProductDetail }) {
  const [tab, setTab] = useState<'description' | 'specs'>('description');
  return (
    <>
      <div className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'description'} onClick={() => setTab('description')}>Description</button>
        <button type="button" role="tab" aria-selected={tab === 'specs'} onClick={() => setTab('specs')}>Specifications</button>
      </div>
      <div className="tab-panel" role="tabpanel">
        {tab === 'description' ? <p style={{ margin: 0 }}>{product.description}</p> : (
          <table className="spec-table">
            <tbody>
              <tr><th>SKU</th><td>{product.sku}</td></tr>
              {product.category && <tr><th>Category</th><td>{product.category.name}{product.subcategory ? ` › ${product.subcategory.name}` : ''}</td></tr>}
              {product.weight_grams && <tr><th>Net weight</th><td>{product.weight_grams >= 1000 ? `${product.weight_grams / 1000} kg` : `${product.weight_grams} g`}</td></tr>}
              {product.variants.length > 0 && <tr><th>Pack sizes</th><td>{product.variants.map(item => item.label).join(', ')}</td></tr>}
              {product.hsn_code && <tr><th>HSN code</th><td>{product.hsn_code}</td></tr>}
              <tr><th>GST</th><td>{product.gst_rate_basis_points / 100}% (included in price)</td></tr>
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
