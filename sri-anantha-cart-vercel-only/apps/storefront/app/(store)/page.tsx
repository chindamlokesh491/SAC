import { ArrowRight, CreditCard, Flower2, Headphones, Leaf, ShieldCheck, Truck, BadgeCheck } from 'lucide-react';
import Link from 'next/link';
import { connection } from 'next/server';
import { preload } from 'react-dom';
import { ProductCard } from '@/components/store/ProductCard';
import { getHome } from '@/lib/server-api';


function LotusIcon({ size = 48 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinejoin="round" aria-hidden="true">
      <path d="M32 10c6 7 8 15 0 30-8-15-6-23 0-30Z" /><path d="M32 40c-4-9-12-14-20-14 0 9 7 15 20 14Z" /><path d="M32 40c4-9 12-14 20-14 0 9-7 15-20 14Z" />
      <path d="M32 40C24 33 14 32 6 35c4 6 14 8 26 5Z" /><path d="M32 40c8-7 18-8 26-5-4 6-14 8-26 5Z" /><path d="M14 46h36" />
    </svg>
  );
}

/** Tablet columns that divide the tiles into full rows where possible (6 → 3 or 6, 8 → 4, 5 → 5). */
function tabletColumns(count: number): number {
  if (count <= 6) return Math.max(1, count);
  return count % 4 === 0 ? 4 : count % 3 === 0 ? 3 : 4;
}

export default async function HomePage() {
  // Rendered per request so builds never need a reachable API. The catalogue data itself comes from
  // Next's data cache (60 s, plus immediate invalidation on admin changes), not a fresh API call.
  await connection();
  // The hero photo is the largest element on screen: fetch it early instead of after the CSS.
  preload('/images/hero-temple.webp', { as: 'image', fetchPriority: 'high' });
  const home = await getHome();
  const categories = home?.featured_categories?.length ? home.featured_categories : (home?.categories ?? []).slice(0, 8);
  return (
    <>
      <section className="hero" aria-labelledby="hero-title">
        <div className="hero-art" aria-hidden="true"><img src="/images/hero-temple.webp" alt="" width={916} height={462} fetchPriority="high" decoding="async" /></div>
        <div className="container">
          <h1 id="hero-title">Everything for your Pooja,<br />Now at Your Doorstep</h1>
          <p className="hero-sub">Pure. Traditional. Authentic.<br />Delivered in 15-30 minutes in Tirupati.</p>
          <Link href="/categories" className="btn btn-primary">Shop Now <ArrowRight size={18} /></Link>
          <ul className="hero-points">
            <li><Truck size={24} /> 15-30 Min<br />Delivery</li>
            <li><ShieldCheck size={24} /> Authentic<br />Products</li>
            <li><Leaf size={24} /> Pure &amp; Traditional</li>
            <li><span style={{ color: 'var(--saffron)' }}><LotusIcon size={26} /></span> Trusted in<br />Tirupati</li>
          </ul>
        </div>
      </section>

      <section className="section container" aria-labelledby="shop-by-category">
        <div className="section-head">
          <h2 id="shop-by-category">Shop by Category</h2>
          <Link href="/categories" className="link-red">View All<span className="hide-xs"> Categories</span> <ArrowRight size={16} /></Link>
        </div>
        <div className="cat-strip" style={{ '--cat-cols': Math.max(1, Math.min(8, categories.length)), '--cat-cols-tablet': tabletColumns(categories.length) } as React.CSSProperties}>
          {categories.map(category => (
            <Link key={category.id} href={`/c/${category.slug}`} className="cat-tile">
              {category.thumb_url ? <img src={category.thumb_url} alt="" width={116} height={100} loading="lazy" /> : <Flower2 size={56} />}
              <span>{category.name}</span>
            </Link>
          ))}
        </div>
      </section>

      <section className="section container" aria-labelledby="popular-products">
        <div className="section-head">
          <h2 id="popular-products">Popular Products</h2>
          <Link href="/search?sort=popular" className="link-red">View All<span className="hide-xs"> Products</span> <ArrowRight size={16} /></Link>
        </div>
        {home?.popular.length ? (
          <div className="product-grid">{home.popular.map(product => <ProductCard key={product.id} product={product} />)}</div>
        ) : <p className="empty">Products will appear here soon.</p>}

        <div className="feature-strip">
          <div><Truck size={34} strokeWidth={1.6} /><span><strong>15-30 Minute Delivery</strong><small>In Tirupati</small></span></div>
          <div><BadgeCheck size={34} strokeWidth={1.6} /><span><strong>Quality Products</strong><small>Authentic &amp; Trusted Brands</small></span></div>
          <div><CreditCard size={34} strokeWidth={1.6} /><span><strong>Secure Payments</strong><small>UPI, Cards, Netbanking, COD</small></span></div>
          <div><Headphones size={34} strokeWidth={1.6} /><span><strong>Customer Support</strong><small>We&apos;re here to help</small></span></div>
        </div>
      </section>

      {home?.kits.length ? (
        <section className="section container" aria-labelledby="best-kits">
          <div className="section-head">
            <h2 id="best-kits">Best Selling Pooja Kits</h2>
            <Link href="/c/pooja-kits" className="link-red">View All <ArrowRight size={16} /></Link>
          </div>
          <div className="product-grid">{home.kits.map(product => <ProductCard key={product.id} product={product} showSubtitle={false} />)}</div>
        </section>
      ) : null}

      <section className="why" aria-labelledby="why-us">
        <div className="container">
          <h2 id="why-us">Why Choose Sri Anantha Cart?</h2>
          <div className="why-grid">
            <div><LotusIcon size={54} /><strong>Authentic &amp; Pure</strong><p>Sourced from trusted<br />brands and suppliers</p></div>
            <div><Truck size={50} strokeWidth={1.6} /><strong>Fast Delivery</strong><p>15-30 minutes<br />in Tirupati</p></div>
            <div><Flower2 size={50} strokeWidth={1.6} /><strong>Wide Range</strong><p>Everything for your<br />spiritual needs</p></div>
            <div><Headphones size={50} strokeWidth={1.6} /><strong>Customer Support</strong><p>Dedicated support<br />for a seamless experience</p></div>
          </div>
        </div>
      </section>
    </>
  );
}
