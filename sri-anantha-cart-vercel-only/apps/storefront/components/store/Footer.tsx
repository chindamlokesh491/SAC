import type { CategoryNode, StoreConfig } from '@sac/contracts';
import { Heart } from 'lucide-react';
import Link from 'next/link';
import { TourLink } from './FirstVisit';

const icons = {
  instagram: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5" /><circle cx="12" cy="12" r="4" /><circle cx="17.5" cy="6.5" r="1" fill="currentColor" /></svg>,
  facebook: <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-1.6 19.9v-7H7.9V12h2.5V9.8c0-2.5 1.5-3.9 3.8-3.9 1.1 0 2.2.2 2.2.2v2.5h-1.3c-1.2 0-1.6.8-1.6 1.6V12h2.8l-.4 2.9h-2.4v7A10 10 0 0 0 12 2Z" /></svg>,
  youtube: <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M23 7.2a3 3 0 0 0-2.1-2.1C19 4.6 12 4.6 12 4.6s-7 0-8.9.5A3 3 0 0 0 1 7.2 31 31 0 0 0 .5 12a31 31 0 0 0 .5 4.8 3 3 0 0 0 2.1 2.1c1.9.5 8.9.5 8.9.5s7 0 8.9-.5a3 3 0 0 0 2.1-2.1 31 31 0 0 0 .5-4.8 31 31 0 0 0-.5-4.8ZM9.7 15.1V8.9L15.5 12l-5.8 3.1Z" /></svg>,
};

export function Footer({ categories, config }: { categories: CategoryNode[]; config: StoreConfig | null }) {
  const store = config?.store;
  const socials = [
    ['Instagram', store?.instagram_url, icons.instagram],
    ['Facebook', store?.facebook_url, icons.facebook],
    ['YouTube', store?.youtube_url, icons.youtube],
  ] as const;
  const apkUrl = process.env.NEXT_PUBLIC_ANDROID_APK_URL;
  return (
    <footer className="site-footer">
      <div className="container footer-grid">
        <div>
          <Link href="/" className="footer-brand">
            <img src="/brand/lotus.png" alt="" width={58} height={45} />
            <span><strong>Sri Anantha Cart</strong><small>Your Pooja Essentials</small></span>
          </Link>
          <p className="footer-about">Your one-stop destination for authentic pooja items. Fast delivery in Tirupati.</p>
          <div className="footer-social">
            {socials.map(([label, url, icon]) => url
              ? <a key={label} href={url} target="_blank" rel="noopener noreferrer" aria-label={label}>{icon}</a>
              : <span key={label} className="footer-social-disabled" aria-hidden="true" style={{ opacity: .85, display: 'grid', placeItems: 'center', width: 34, height: 34 }}>{icon}</span>)}
          </div>
        </div>
        <nav className="footer-col" aria-label="Quick links">
          <h3>Quick Links</h3>
          <ul>
            <li><Link href="/about">About Us</Link></li>
            <li><Link href="/contact">Contact Us</Link></li>
            <li><Link href="/track-order">Track Order</Link></li>
            <li><Link href="/faq">FAQ</Link></li>
            <li><TourLink /></li>
          </ul>
        </nav>
        <nav className="footer-col" aria-label="Categories">
          <h3>Categories</h3>
          <ul>
            {categories.slice(0, 6).map(category => <li key={category.id}><Link href={`/c/${category.slug}`}>{category.name}</Link></li>)}
          </ul>
        </nav>
        <nav className="footer-col" aria-label="Policies">
          <h3>Policies</h3>
          <ul>
            <li><Link href="/shipping-delivery">Shipping &amp; Delivery</Link></li>
            <li><Link href="/refund-return-policy">Cancellation &amp; Refund</Link></li>
            <li><Link href="/privacy">Privacy Policy</Link></li>
            <li><Link href="/terms">Terms &amp; Conditions</Link></li>
          </ul>
        </nav>
        {apkUrl && <div className="footer-col"><h3>Android App</h3><p>Get the Android app for convenient shopping.</p><p className="note"><a className="footer-apk" href={apkUrl} rel="noopener">Download APK</a></p></div>}
      </div>
      <div className="container footer-bottom">
        <span>© {new Date().getFullYear()} Sri Anantha Cart. All rights reserved.</span>
        <span>Made with <Heart className="heart" size={16} fill="currentColor" /> in Tirupati</span>
      </div>
    </footer>
  );
}
