export type HeaderEntry = { key: string; value: string };
export function securityHeaders(options: {
  isDev: boolean;
  mediaOrigin?: string;
  googleSignIn?: boolean;
  formActions?: string[];
  geolocation?: boolean;
  razorpayCheckout?: boolean;
  noIndex?: boolean;
}): HeaderEntry[];
export function apiRewrites(apiOrigin: string): { source: string; destination: string }[];
