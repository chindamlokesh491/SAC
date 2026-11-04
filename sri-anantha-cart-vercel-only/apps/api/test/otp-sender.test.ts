import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { createOtpSender } from '../src/auth/otp-sender.js';

const env = {
  NODE_ENV: 'test',
  OTP_PROVIDER: 'smsgatewayhub',
  SMSGH_API_KEY: 'test-api-key-never-log',
  SMSGH_SENDER_ID: 'RRSMSG',
  SMSGH_ENTITY_ID: '1234567890123456789',
  SMSGH_OTP_TEMPLATE_ID: '12345678901234567890',
  SMSGH_OTP_TEMPLATE_TEXT: 'Your Sri Anantha Cart OTP is {#var#}. Do not share it.',
  SMSGH_CHANNEL: '2',
  SMSGH_ROUTE: '1',
};

test('SMS Gateway Hub sends DLT OTP by HTTPS form POST and returns provider message ID', async () => {
  const config = loadConfig(env);
  const originalFetch = globalThis.fetch;
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requestUrl = String(input);
    requestInit = init;
    return new Response(JSON.stringify({
      ErrorCode: '000',
      ErrorMessage: 'Success',
      JobId: '20047',
      MessageData: [{ Number: '919876543210', MessageId: 'provider-message-123' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const sender = createOtpSender(config);
    const result = await sender('+919876543210', '123456');
    assert.equal(requestUrl, 'https://www.smsgatewayhub.com/api/mt/SendSMS');
    assert.equal(requestInit?.method, 'POST');
    assert.match(String(requestInit?.headers && (requestInit.headers as Record<string, string>)['content-type']), /application\/x-www-form-urlencoded/);
    const body = new URLSearchParams(String(requestInit?.body));
    assert.equal(body.get('APIKey'), 'test-api-key-never-log');
    assert.equal(body.get('senderid'), 'RRSMSG');
    assert.equal(body.get('channel'), '2');
    assert.equal(body.get('number'), '919876543210');
    assert.equal(body.get('text'), 'Your Sri Anantha Cart OTP is 123456. Do not share it.');
    assert.equal(body.get('EntityId'), '1234567890123456789');
    assert.equal(body.get('dlttemplateid'), '12345678901234567890');
    assert.equal(body.get('route'), '1');
    assert.equal(new URL(requestUrl).search, '', 'API key must never be placed in the URL');
    assert.deepEqual(result, { providerMessageId: 'provider-message-123' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('SMS Gateway Hub rejects provider errors and never treats them as successful OTP delivery', async () => {
  const config = loadConfig(env);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    ErrorCode: '007', ErrorMessage: 'Invalid DLT template',
  }), { status: 200 })) as typeof fetch;
  try {
    await assert.rejects(createOtpSender(config)('+919876543210', '123456'), /rejected the DLT message/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('SMS Gateway Hub requires complete approved DLT configuration before production starts', () => {
  assert.throws(() => loadConfig({
    NODE_ENV: 'production',
    SESSION_SECRET: 'a'.repeat(48),
    COOKIE_SECURE: 'true',
    OTP_PROVIDER: 'smsgatewayhub',
    SMSGH_API_KEY: 'test-api-key',
  }), /SMSGH_SENDER_ID/);
  assert.throws(() => loadConfig({
    NODE_ENV: 'production',
    SESSION_SECRET: 'a'.repeat(48),
    COOKIE_SECURE: 'true',
    OTP_PROVIDER: 'smsgatewayhub',
    ...env,
    SMSGH_OTP_TEMPLATE_TEXT: 'OTP is sent securely.',
  }), /exactly one approved DLT variable placeholder/);
});

test('delivery codes use their own DLT template and are never sent on the sign-in template', async () => {
  const originalFetch = globalThis.fetch;
  const bodies: URLSearchParams[] = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(new URLSearchParams(String(init?.body)));
    return new Response(JSON.stringify({ ErrorCode: '000', MessageData: [{ MessageId: 'm-1' }] }), { status: 200 });
  }) as typeof fetch;
  try {
    // Without a delivery template: refuse before calling the provider.
    await assert.rejects(createOtpSender(loadConfig(env))('+919876543210', '654321', 'delivery'), /delivery-code DLT template is not configured/);
    assert.equal(bodies.length, 0);
    const withDelivery = loadConfig({ ...env, SMSGH_DELIVERY_TEMPLATE_ID: '99999999999999999999', SMSGH_DELIVERY_TEMPLATE_TEXT: 'Your Sri Anantha Cart delivery code is {#var#}. Share it only on delivery.' });
    await createOtpSender(withDelivery)('+919876543210', '654321', 'delivery');
    await createOtpSender(withDelivery)('+919876543210', '111222', 'login');
    assert.equal(bodies[0]!.get('dlttemplateid'), '99999999999999999999');
    assert.equal(bodies[0]!.get('text'), 'Your Sri Anantha Cart delivery code is 654321. Share it only on delivery.');
    assert.equal(bodies[1]!.get('dlttemplateid'), env.SMSGH_OTP_TEMPLATE_ID);
  } finally { globalThis.fetch = originalFetch; }
});

test('delivery template configuration is validated', () => {
  assert.throws(() => loadConfig({ ...env, SMSGH_DELIVERY_TEMPLATE_ID: 'abc', SMSGH_DELIVERY_TEMPLATE_TEXT: 'x {#var#}' }), /SMSGH_DELIVERY_TEMPLATE_ID/);
  assert.throws(() => loadConfig({ ...env, SMSGH_DELIVERY_TEMPLATE_ID: '99999999999999999999', SMSGH_DELIVERY_TEMPLATE_TEXT: 'no placeholder' }), /SMSGH_DELIVERY_TEMPLATE_TEXT/);
  assert.throws(() => loadConfig({ ...env, SMSGH_DELIVERY_TEMPLATE_ID: env.SMSGH_OTP_TEMPLATE_ID, SMSGH_DELIVERY_TEMPLATE_TEXT: 'x {#var#}' }), /must differ/);
});
