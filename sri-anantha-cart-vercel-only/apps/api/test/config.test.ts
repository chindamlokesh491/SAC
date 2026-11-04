import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

const base = {
  NODE_ENV: 'production',
  SESSION_SECRET: 'staging-test-secret-that-is-long-enough-123456',
  COOKIE_SECURE: 'true',
};

test('production Node mode permits dev OTP only with explicit staging identity and opt-in', () => {
  assert.throws(() => loadConfig({
    ...base, DEPLOYMENT_ENV: 'production', OTP_PROVIDER: 'dev-outbox', OTP_DEV_OUTBOX: '/tmp/sac-otp.jsonl',
  }), /OTP_PROVIDER must be http/);

  const config = loadConfig({
    ...base,
    DEPLOYMENT_ENV: 'staging',
    ALLOW_DEV_OTP: 'true',
    OTP_PROVIDER: 'dev-outbox',
    OTP_DEV_OUTBOX: '/tmp/sac-otp.jsonl',
  });
  assert.equal(config.nodeEnv, 'production');
  assert.equal(config.deploymentEnvironment, 'staging');
  assert.equal(config.allowDevOtp, true);
  assert.equal(config.otpProvider, 'dev-outbox');
});

test('development OTP opt-in is rejected outside staging or without dev-outbox', () => {
  assert.throws(() => loadConfig({
    ...base, DEPLOYMENT_ENV: 'production', ALLOW_DEV_OTP: 'true', OTP_PROVIDER: 'http',
  }), /only with DEPLOYMENT_ENV=staging/);
  assert.throws(() => loadConfig({
    ...base, DEPLOYMENT_ENV: 'staging', ALLOW_DEV_OTP: 'true', OTP_PROVIDER: 'http',
  }), /only with DEPLOYMENT_ENV=staging/);
});

test('production defaults and production OTP requirements remain unchanged', () => {
  const config = loadConfig({ ...base, OTP_PROVIDER: 'http' });
  assert.equal(config.deploymentEnvironment, 'production');
  assert.equal(config.allowDevOtp, false);
  assert.equal(config.onlinePaymentsEnabled, false);
});

test('services refuse to start when staging or development requests live Razorpay', () => {
  const staging = { ...base, DEPLOYMENT_ENV: 'staging', OTP_PROVIDER: 'http' };
  assert.throws(() => loadConfig({ ...staging, RAZORPAY_MODE: 'live', RAZORPAY_KEY_ID: 'rzp_live_abc' }), /RAZORPAY_LIVE_APPROVED/);
  assert.throws(() => loadConfig({ ...staging, RAZORPAY_MODE: 'live', RAZORPAY_KEY_ID: 'rzp_live_abc', RAZORPAY_LIVE_APPROVED: 'true' }), /DEPLOYMENT_ENV=production/);
  assert.throws(() => loadConfig({ ...staging, RAZORPAY_MODE: 'test', RAZORPAY_KEY_ID: 'rzp_live_abc' }), /rzp_live_/);
  assert.throws(() => loadConfig({ NODE_ENV: 'development', RAZORPAY_MODE: 'live', RAZORPAY_KEY_ID: 'rzp_live_abc' }), /RAZORPAY_LIVE_APPROVED/);
  // Production without the explicit approval flag is also refused.
  assert.throws(() => loadConfig({ ...base, DEPLOYMENT_ENV: 'production', OTP_PROVIDER: 'http', RAZORPAY_MODE: 'live', RAZORPAY_KEY_ID: 'rzp_live_abc' }), /RAZORPAY_LIVE_APPROVED/);
  // Test mode in staging starts normally.
  assert.equal(loadConfig({ ...staging, RAZORPAY_MODE: 'test', RAZORPAY_KEY_ID: 'rzp_test_abc' }).deploymentEnvironment, 'staging');
  // Approved production starts.
  assert.equal(loadConfig({ ...base, DEPLOYMENT_ENV: 'production', OTP_PROVIDER: 'http', RAZORPAY_MODE: 'live', RAZORPAY_KEY_ID: 'rzp_live_abc', RAZORPAY_LIVE_APPROVED: 'true' }).deploymentEnvironment, 'production');
});
