import type { Metadata, Viewport } from 'next';
import '@sac/ui-web/styles/fonts.css';
import '@sac/ui-web/styles/tokens.css';
import '@sac/ui-web/styles/shared.css';


export const metadata: Metadata = {
  title: { default: 'Admin', template: '%s · Admin · Sri Anantha Cart' },
  robots: { index: false, follow: false },
  icons: { icon: [{ url: '/icons/favicon-32.png', sizes: '32x32' }, { url: '/icons/favicon-64.png', sizes: '64x64' }], apple: '/icons/apple-touch-icon.png' },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#7c1300' };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en-IN">
      <body>{children}</body>
    </html>
  );
}
