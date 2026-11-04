import type { NextConfig } from 'next';
import { apiRewrites, securityHeaders } from '@sac/config/next-security';

const apiOrigin = process.env.API_SERVER_ORIGIN ?? 'http://127.0.0.1:4000';
const isDev = process.env.NODE_ENV !== 'production';
// Staff who type /admin on the shop domain are sent to the admin app (a separate deployment).
const adminUrl = process.env.ADMIN_APP_URL?.replace(/\/$/, '');

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: ['@sac/contracts', '@sac/api-client', '@sac/shared', '@sac/ui-web'],
  async rewrites() { return apiRewrites(apiOrigin); },
  async redirects() {
    return adminUrl ? [{ source: '/admin/:path*', destination: `${adminUrl}/admin/:path*`, permanent: false }] : [];
  },
  async headers() {
    return [{
      source: '/:path*',
      // Google sign-in, Razorpay checkout, and "use my location" for addresses.
      headers: securityHeaders({
        isDev, mediaOrigin: process.env.MEDIA_PUBLIC_ORIGIN?.replace(/\/$/, '') ?? '', googleSignIn: true,
        formActions: ['https://api.razorpay.com'], geolocation: true, razorpayCheckout: true,
      }),
    }];
  },
};

export default nextConfig;
