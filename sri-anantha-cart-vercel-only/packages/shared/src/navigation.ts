/** Only allow same-site relative redirects after sign-in (prevents open redirects). */
export function safeNextPath(value: string | null | undefined, fallback = '/'): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\') || value.includes('://')) return fallback;
  if (value.startsWith('/login')) return fallback;
  return value.slice(0, 300);
}
