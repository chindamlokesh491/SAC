import type { Metadata, Viewport } from 'next';
import { PartnerProvider } from '@/components/partner/PartnerProvider';
import '@/styles/partner.css';

export const metadata: Metadata = {
  title: { default: 'Deliveries', template: '%s · Delivery Partner · Sri Anantha Cart' },
  robots: { index: false, follow: false },
  manifest: '/partner-manifest.webmanifest',
  appleWebApp: { capable: true, title: 'SAC Delivery', statusBarStyle: 'black-translucent' },
  icons: { icon: [{ url: '/icons/icon-192.png', sizes: '192x192' }], apple: '/icons/apple-touch-icon.png' },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover', themeColor: '#7c1300' };

export default function PartnerLayout({ children }: { children: React.ReactNode }) {
  return <PartnerProvider>{children}</PartnerProvider>;
}
