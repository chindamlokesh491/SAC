import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export type GoogleIdentity = { sub: string; email: string | null; emailVerified: boolean; name: string | null };

const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
let remoteKeys: JWTVerifyGetKey | null = null;

function googleKeys(): JWTVerifyGetKey {
  remoteKeys ??= createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
  return remoteKeys;
}

/**
 * Verifies a Google Identity Services ID token: signature (Google JWKS), issuer,
 * audience (our OAuth client IDs) and expiry. Never trust unverified token claims.
 */
export async function verifyGoogleIdToken(idToken: string, clientIds: string[], keys: JWTVerifyGetKey = googleKeys()): Promise<GoogleIdentity> {
  if (!clientIds.length) throw new Error('GOOGLE_NOT_CONFIGURED');
  if (typeof idToken !== 'string' || idToken.length < 20 || idToken.length > 4096) throw new Error('INVALID_GOOGLE_TOKEN');
  const { payload } = await jwtVerify(idToken, keys, { issuer: GOOGLE_ISSUERS, audience: clientIds, clockTolerance: 30 });
  if (typeof payload.sub !== 'string' || !payload.sub) throw new Error('INVALID_GOOGLE_TOKEN');
  return {
    sub: payload.sub,
    email: typeof payload.email === 'string' ? payload.email.toLowerCase() : null,
    emailVerified: payload.email_verified === true,
    name: typeof payload.name === 'string' ? payload.name.slice(0, 100) : null,
  };
}
