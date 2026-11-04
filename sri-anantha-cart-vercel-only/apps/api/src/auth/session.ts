import type {} from '@fastify/cookie';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { newOpaqueToken, sha256 } from './security.js';

export type UserRole = 'customer' | 'admin' | 'operator' | 'delivery_partner';
export const STAFF_ROLES: UserRole[] = ['admin', 'operator', 'delivery_partner'];
export type AuthenticatedUser = { id: string; role: UserRole; phone_e164: string | null; must_change_password: boolean };
declare module 'fastify' {
  interface FastifyRequest { authUser?: AuthenticatedUser }
}

/** Header that browsers cannot send cross-site without a CORS preflight (which this API never grants). */
export const CSRF_HEADER = 'x-sac-csrf';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CUSTOMER_SESSION_HOURS = 24 * 30;
const STAFF_SESSION_HOURS = 12;

let cookieSecure = false;
export function configureSessionCookies(options: { secure: boolean }) { cookieSecure = options.secure; }
/** __Host- cookies are bound to the exact origin over HTTPS; plain name only for local HTTP development. */
export function sessionCookieName(): string { return cookieSecure ? '__Host-sac_session' : 'sac_session'; }

type TokenSource = { token: string; via: 'bearer' | 'cookie' };

function readToken(request: FastifyRequest): TokenSource | null | 'malformed' {
  const header = request.headers.authorization;
  if (typeof header === 'string' && header.length > 0) {
    const match = /^Bearer ([A-Za-z0-9_-]{40,})$/.exec(header);
    return match ? { token: match[1]!, via: 'bearer' } : 'malformed';
  }
  const cookie = (request as FastifyRequest & { cookies?: Record<string, string | undefined> }).cookies?.[sessionCookieName()];
  if (typeof cookie === 'string' && /^[A-Za-z0-9_-]{40,}$/.test(cookie)) return { token: cookie, via: 'cookie' };
  return null;
}

/** Returns the signed-in user without replying when absent (for optional personalisation). */
export async function optionalAuth(pool: Pool, request: FastifyRequest): Promise<AuthenticatedUser | null> {
  const source = readToken(request);
  if (!source || source === 'malformed') return null;
  return lookupSession(pool, source.token);
}

async function lookupSession(pool: Pool, token: string): Promise<AuthenticatedUser | null> {
  const result = await pool.query<AuthenticatedUser>(
    `SELECT u.id, u.role, u.phone_e164, u.must_change_password
       FROM auth_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.is_active = TRUE
      LIMIT 1`, [sha256(token)],
  );
  return result.rows[0] ?? null;
}

export async function requireAuth(pool: Pool, request: FastifyRequest, reply: FastifyReply): Promise<AuthenticatedUser | null> {
  const source = readToken(request);
  if (!source || source === 'malformed') {
    await reply.code(401).send({ error: 'UNAUTHENTICATED', message: 'Sign-in is required' });
    return null;
  }
  // Cookie sessions are ambient credentials, so state-changing requests must prove
  // they came from our own pages (custom header => same-origin or preflighted).
  if (source.via === 'cookie' && !SAFE_METHODS.has(request.method) && request.headers[CSRF_HEADER] !== '1') {
    await reply.code(403).send({ error: 'CSRF_CHECK_FAILED', message: 'Request could not be verified. Refresh the page and try again.' });
    return null;
  }
  const user = await lookupSession(pool, source.token);
  if (!user) {
    await reply.code(401).send({ error: 'UNAUTHENTICATED', message: 'Session is invalid or expired' });
    return null;
  }
  request.authUser = user;
  return user;
}

export async function requireRole(pool: Pool, request: FastifyRequest, reply: FastifyReply, roles: AuthenticatedUser['role'][]): Promise<AuthenticatedUser | null> {
  const user = await requireAuth(pool, request, reply);
  if (!user) return null;
  if (!roles.includes(user.role)) {
    await reply.code(403).send({ error: 'FORBIDDEN', message: 'You do not have permission to perform this action' });
    return null;
  }
  // A temporary password only unlocks the change-password step, enforced here rather than in the UI.
  // Delivery-partner portal routes are exempt: partners authenticate there with an SMS code, never a
  // password, yet staff provisioning (admin Staff screen and staff:grant) still issues them a temporary
  // password. Routes open to any other role keep the gate.
  const partnerPortalRoute = roles.length === 1 && roles[0] === 'delivery_partner';
  if (user.must_change_password && !partnerPortalRoute) {
    await reply.code(403).send({ error: 'PASSWORD_CHANGE_REQUIRED', message: 'Set a new password before continuing' });
    return null;
  }
  return user;
}

export async function createSession(client: PoolClient | Pool, userId: string, role: UserRole): Promise<{ token: string; expiresInSeconds: number }> {
  const token = newOpaqueToken();
  const hours = role === 'customer' ? CUSTOMER_SESSION_HOURS : STAFF_SESSION_HOURS;
  await client.query(
    `INSERT INTO auth_sessions(user_id, token_hash, expires_at) VALUES ($1, $2, now() + ($3 * interval '1 hour'))`,
    [userId, sha256(token), hours],
  );
  return { token, expiresInSeconds: hours * 3600 };
}

/** Web clients receive an HttpOnly cookie instead of a readable token. */
export function wantsCookieSession(request: FastifyRequest): boolean {
  return request.headers['x-sac-client'] === 'web';
}

export function setSessionCookie(reply: FastifyReply, token: string, maxAgeSeconds: number) {
  void reply.setCookie(sessionCookieName(), token, {
    httpOnly: true, secure: cookieSecure, sameSite: 'lax', path: '/', maxAge: maxAgeSeconds,
  });
}

export function clearSessionCookie(reply: FastifyReply) {
  void reply.clearCookie(sessionCookieName(), { path: '/', httpOnly: true, secure: cookieSecure, sameSite: 'lax' });
}

export function currentToken(request: FastifyRequest): string | null {
  const source = readToken(request);
  return source && source !== 'malformed' ? source.token : null;
}
