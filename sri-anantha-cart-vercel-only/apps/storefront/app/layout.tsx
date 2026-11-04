import type { Metadata, Viewport } from 'next';
import '@sac/ui-web/styles/fonts.css';
import '@sac/ui-web/styles/tokens.css';
import '@sac/ui-web/styles/shared.css';


const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: 'Sri Anantha Cart | Pooja Essentials Delivered in 15-30 Minutes in Tirupati', template: '%s | Sri Anantha Cart' },
  description: 'Shop authentic pooja items — agarbatti, kumkum, haldi, diyas, flowers and pooja kits — delivered to your doorstep in 15-30 minutes in Tirupati.',
  applicationName: 'Sri Anantha Cart',
  icons: { icon: [{ url: '/icons/favicon-32.png', sizes: '32x32' }, { url: '/icons/favicon-64.png', sizes: '64x64' }], apple: '/icons/apple-touch-icon.png' },
  openGraph: { type: 'website', siteName: 'Sri Anantha Cart', locale: 'en_IN', images: ['/icons/icon-512.png'] },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#7c1300' };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en-IN">
      <body>{children}</body>
    </html>
  );
}
