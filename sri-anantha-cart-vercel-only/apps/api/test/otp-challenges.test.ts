import test from 'node:test';
import assert from 'node:assert/strict';
import { issueOtpChallenge } from '../src/auth/otp-challenges.js';

const unusedPool = {} as never;
const validPhone = '+919876543210';
const validHash = 'a'.repeat(64);

test('OTP challenge issuance rejects an unnormalized phone before database access', async () => {
  await assert.rejects(issueOtpChallenge(unusedPool, '9876543210', validHash, 300, 60), /Invalid normalized phone/);
});

test('OTP challenge issuance rejects malformed OTP hashes before database access', async () => {
  await assert.rejects(issueOtpChallenge(unusedPool, validPhone, 'not-a-hash', 300, 60), /Invalid OTP hash/);
});

test('OTP challenge issuance rejects unsafe TTL and cooldown values before database access', async () => {
  await assert.rejects(issueOtpChallenge(unusedPool, validPhone, validHash, 0, 60), /Invalid OTP TTL/);
  await assert.rejects(issueOtpChallenge(unusedPool, validPhone, validHash, 300, 0), /Invalid OTP cooldown/);
});
