import type { NextConfig } from 'next';
import { apiRewrites, securityHeaders } from '@sac/config/next-security';

const apiOrigin = process.env.API_SERVER_ORIGIN ?? 'http://127.0.0.1:4000';
const isDev = process.env.NODE_ENV !== 'production';

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: ['@sac/contracts', '@sac/api-client', '@sac/shared', '@sac/ui-web'],
  async rewrites() { return apiRewrites(apiOrigin); },
  async redirects() { return [{ source: '/', destination: '/admin', permanent: false }]; },
  async headers() {
    // Staff sign in with a password: no third-party scripts, no frames, no location, never indexed.
    // Google Identity Services is allowed only when staff Google sign-in is configured for this build.
    const googleSignIn = Boolean(process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID?.trim());
    return [{ source: '/:path*', headers: securityHeaders({ isDev, mediaOrigin: process.env.MEDIA_PUBLIC_ORIGIN?.replace(/\/$/, '') ?? '', noIndex: true, googleSignIn }) }];
  },
};

export default nextConfig;
