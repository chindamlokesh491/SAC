// Password hashing shared by the API and the staff:grant command (plain JS so both can import it).
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const N = 32768;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const MAX_MEMORY = 128 * N * R * 2;

/** Returns "scrypt$N$r$p$salt$hash" with a random 16-byte salt. */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, { N, r: R, p: P, maxmem: MAX_MEMORY });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const parts = typeof stored === 'string' ? stored.split('$') : [];
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  if (![n, r, p].every(Number.isSafeInteger) || n > 1 << 20 || r > 32 || p > 16) return false;
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  if (salt.length < 16 || expected.length !== KEY_LENGTH) return false;
  const actual = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, { N: n, r, p, maxmem: 128 * n * r * 2 });
  return timingSafeEqual(actual, expected);
}

/** Readable temporary password: 4 groups of 4 from an unambiguous alphabet (~93 bits), with letters and digits. */
export function temporaryPassword() {
  // 56 symbols; rejection sampling keeps every symbol equally likely.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  for (;;) {
    const chars = [];
    while (chars.length < 16) {
      for (const byte of randomBytes(32)) if (byte < 224 && chars.length < 16) chars.push(alphabet[byte % alphabet.length]);
    }
    const candidate = [0, 4, 8, 12].map(start => chars.slice(start, start + 4).join('')).join('-');
    if (/[A-Za-z]/.test(candidate) && /[0-9]/.test(candidate)) return candidate;
  }
}

/** Returns a reason the password is too weak, or null when it is acceptable. */
export function passwordProblem(password, phoneE164) {
  if (typeof password !== 'string' || password.length < 10) return 'Use at least 10 characters';
  if (password.length > 128) return 'Use at most 128 characters';
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) return 'Use both letters and numbers';
  const digits = (phoneE164 ?? '').replace(/^\+91/, '');
  if (digits && password.replace(/\D/g, '').includes(digits)) return 'Do not use your mobile number in the password';
  if (/^(password|admin|sriananth|anantha)/i.test(password)) return 'Choose a less guessable password';
  return null;
}
