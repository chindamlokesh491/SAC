/**
 * Public build-time configuration. EXPO_PUBLIC_* values are compiled into the app and are
 * NOT secret — never put API keys, merchant salts or session secrets here.
 */
export const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? 'http://10.0.2.2:4000').replace(/\/$/, '');
export const WEB_URL = (process.env.EXPO_PUBLIC_WEB_URL ?? 'https://sriananthacart.in').replace(/\/$/, '');
export const GOOGLE_ANDROID_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID ?? '';
export const GOOGLE_WEB_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ?? '';

/** Media paths from the API are relative (/media/...); resolve them against the API origin. */
export function mediaUrl(path: string | null | undefined): string | undefined {
  if (!path) return undefined;
  return path.startsWith('/') ? `${API_URL}${path}` : path;
}

/**
 * In-app online payment needs the native Razorpay SDK and is intentionally disabled until the client
 * provides gateway credentials. Until then the app offers only Cash on Delivery, even if the
 * API reports online methods as available.
 */
export const ONLINE_PAYMENTS_IN_APP = process.env.EXPO_PUBLIC_ONLINE_PAYMENTS_IN_APP === 'true';
