// Security headers shared by the storefront and admin Next.js apps.
// Plain ESM (not TypeScript) so next.config.ts can import it without a build step.

/**
 * @param {{
 *   isDev: boolean,
 *   mediaOrigin?: string,          // https://<project-ref>.supabase.co when images live in Supabase Storage
 *   googleSignIn?: boolean,        // storefront: allow Google Identity Services
 *   formActions?: string[],        // extra hosts a form may post to (payment gateways)
 *   geolocation?: boolean,         // storefront: "use my location" for addresses
 *   razorpayCheckout?: boolean,    // storefront: allow hosted Razorpay Standard Checkout
 *   noIndex?: boolean,             // admin: never indexed by search engines
 * }} options
 */
export function securityHeaders({ isDev, mediaOrigin = '', googleSignIn = false, formActions = [], geolocation = false, razorpayCheckout = false, noIndex = false }) {
  if (mediaOrigin && !/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(mediaOrigin)) {
    throw new Error('MEDIA_PUBLIC_ORIGIN must be https://<project-ref>.supabase.co');
  }
  const google = googleSignIn ? ' https://accounts.google.com/gsi/client' : '';
  const razorpayScript = razorpayCheckout ? ' https://checkout.razorpay.com' : '';
  const razorpayConnect = razorpayCheckout ? ' https://checkout.razorpay.com https://api.razorpay.com' : '';
  const razorpayFrames = razorpayCheckout ? ' https://checkout.razorpay.com https://api.razorpay.com' : '';
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${google}${razorpayScript}${isDev ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' 'unsafe-inline'${googleSignIn ? ' https://accounts.google.com/gsi/style' : ''}${razorpayScript}`,
    `img-src 'self' data: blob: https://raw.githubusercontent.com${googleSignIn ? ' https://*.googleusercontent.com' : ''}${mediaOrigin ? ` ${mediaOrigin}` : ''}`,
    "font-src 'self' data:",
    `connect-src 'self'${googleSignIn ? ' https://accounts.google.com' : ''}${razorpayConnect}${isDev ? ' ws: http://localhost:*' : ''}`,
    `frame-src${googleSignIn ? ' https://accounts.google.com' : ''}${razorpayFrames || (googleSignIn ? '' : " 'none'")}`,
    `form-action 'self'${formActions.length ? ` ${formActions.join(' ')}` : ''}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
    ...(isDev ? [] : ['upgrade-insecure-requests']),
  ].join('; ');
  return [
    { key: 'Content-Security-Policy', value: csp },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Permissions-Policy', value: `camera=(), microphone=(), geolocation=${geolocation ? '(self)' : '()'}, payment=(self)` },
    ...(noIndex ? [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }] : []),
    ...(isDev ? [] : [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' }]),
  ];
}

/** Both apps reach the API through same-origin rewrites, so session cookies stay first-party. */
export function apiRewrites(apiOrigin) {
  const origin = apiOrigin.replace(/\/$/, '');
  return [
    { source: '/api/:path*', destination: `${origin}/api/:path*` },
    { source: '/media/:path*', destination: `${origin}/media/:path*` },
  ];
}
