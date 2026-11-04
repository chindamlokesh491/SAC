import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { verifyGoogleIdToken } from '../src/auth/google.js';

const CLIENT = 'web-client.apps.googleusercontent.com';

async function setup() {
  const google = await generateKeyPair('RS256');
  const attacker = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(google.publicKey)), kid: 'k1', alg: 'RS256' };
  const keys = createLocalJWKSet({ keys: [jwk] });
  const sign = (claims: Record<string, unknown>, key = google.privateKey, expiresIn = '10m') =>
    new SignJWT({ email: 'Devotee@Example.com', email_verified: true, name: 'Devotee', ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(String(claims.iss ?? 'https://accounts.google.com'))
      .setAudience(String(claims.aud ?? CLIENT)).setSubject('google-sub-1').setIssuedAt().setExpirationTime(expiresIn).sign(key);
  return { keys, sign, attacker };
}

test('accepts a genuine Google ID token for our client ID', async () => {
  const { keys, sign } = await setup();
  const identity = await verifyGoogleIdToken(await sign({}), [CLIENT], keys);
  assert.deepEqual(identity, { sub: 'google-sub-1', email: 'devotee@example.com', emailVerified: true, name: 'Devotee' });
});

test('rejects forged, foreign, expired and misissued tokens', async () => {
  const { keys, sign, attacker } = await setup();
  await assert.rejects(verifyGoogleIdToken(await sign({}, attacker.privateKey), [CLIENT], keys), 'signed by another key');
  await assert.rejects(verifyGoogleIdToken(await sign({ aud: 'someone-elses-app' }), [CLIENT], keys), 'issued to another app');
  await assert.rejects(verifyGoogleIdToken(await sign({ iss: 'https://evil.example' }), [CLIENT], keys), 'wrong issuer');
  await assert.rejects(verifyGoogleIdToken(await sign({}, undefined, '-5m'), [CLIENT], keys), 'expired');
  await assert.rejects(verifyGoogleIdToken(await sign({}), [], keys), /GOOGLE_NOT_CONFIGURED/);
});

test('preserves an unverified email claim so auth routes can reject it', async () => {
  const { keys, sign } = await setup();
  const identity = await verifyGoogleIdToken(await sign({ email_verified: false }), [CLIENT], keys);
  assert.equal(identity.emailVerified, false);
});
