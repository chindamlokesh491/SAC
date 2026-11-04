/** Fail closed when a checkout expiry is absent or invalid. */
export function isCheckoutSessionExpired(expiresAt: Date | string | null | undefined, now = Date.now()): boolean {
  if (expiresAt === null || expiresAt === undefined) return true;
  const expiry = expiresAt instanceof Date ? expiresAt.getTime() : Date.parse(expiresAt);
  return !Number.isFinite(expiry) || expiry <= now;
}

/** Only non-terminal provider payment records may reuse a hosted checkout session. */
export function isReusablePaymentStatus(status: unknown): boolean {
  return status === 'created' || status === 'pending';
}
