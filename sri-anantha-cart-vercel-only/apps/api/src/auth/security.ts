import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function newOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashOtp(phone: string, code: string, secret: string): string {
  // Domain-separate OTP hashes from other application secrets/tokens.
  return createHash('sha256').update(`sac:otp:v1:${secret}:${phone}:${code}`, 'utf8').digest('hex');
}

export function safeEqualHex(a: string, b: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(a) || !/^[a-f0-9]{64}$/i.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/**
 * Normalises an Indian mobile number to E.164 (+91XXXXXXXXXX). A bare 10-digit number is always
 * treated as the subscriber number, so mobiles that begin with "91" are not mistaken for a country code.
 */
export function normalizeIndianPhone(input: string): string | null {
  const digits = input.replace(/[\s()-]/g, '').replace(/^\+91(?=\d{10}$)/, '').replace(/^91(?=\d{10}$)/, '').replace(/^0(?=\d{10}$)/, '');
  return /^[6-9]\d{9}$/.test(digits) ? `+91${digits}` : null;
}
