import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { configureSessionCookies } from './auth/session.js';
import { createOtpSender, type OtpSender } from './auth/otp-sender.js';
import type { AppConfig } from './config.js';
import { MAX_UPLOAD_BYTES, registerMediaRoutes } from './media/media.js';
import { registerAccountRoutes } from './routes/account.js';
import { registerAddressRoutes } from './routes/addresses.js';
import { registerAdminRoutes } from './routes/admin/index.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerStaffAuthRoutes } from './routes/staff-auth.js';
import { registerStaffGoogleAuthRoute } from './routes/staff-google-auth.js';
import { registerCartRoutes } from './routes/cart.js';
import { registerCatalogRoutes } from './routes/catalog.js';
import { registerDeliveryRoutes } from './routes/delivery.js';
import { registerDeliveryPartnerAuthRoutes } from './routes/delivery-partner-auth.js';
import { registerDeliveryPartnerOrderRoutes } from './routes/delivery-partner-orders.js';
import { registerCustomerDeliveryOtpRoutes } from './routes/customer-delivery-otp.js';
import { registerGeoRoutes } from './routes/geo.js';
import { onlinePaymentsReady, registerOrderRoutes } from './routes/orders.js';
import { registerRazorpayWebhookRoute } from './routes/razorpay-webhook.js';
import { registerStoreRoutes } from './routes/store.js';
import { registerReturnRoutes } from './routes/returns.js';
import { recordOutboxEvent } from './jobs/queue.js';
import { createMediaStore, type MediaStore } from './media/store.js';

export type BuildOptions = { config: AppConfig; pool: Pool; logger?: boolean; sendOtp?: OtpSender; rateLimit?: boolean; onRoute?: (route: { method: string | string[]; url: string }) => void; geoFetch?: typeof fetch; mediaStore?: MediaStore };

/** Builds the HTTP application. Background workers are started separately by server.ts. */
export async function buildApp({ config, pool, logger = true, sendOtp, rateLimit: enableRateLimit = true, onRoute, geoFetch, mediaStore }: BuildOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: logger ? { redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]', '*.password', '*.otp', '*.code', '*.salt', '*.apiKey', '*.token', '*.phone_e164', '*.id_token'] } : false,
    // Allow bounded multipart image uploads; JSON parsers below retain their own 1 MB limit.
    bodyLimit: MAX_UPLOAD_BYTES + 256 * 1024,
    // A hop count trusts only that many proxies in front of the API (e.g. the platform load balancer).
    trustProxy: typeof config.trustProxy === 'number' ? ((_address: string, hop: number) => hop < (config.trustProxy as number)) : config.trustProxy,
  });
  configureSessionCookies({ secure: config.cookieSecure });
  if (onRoute) app.addHook('onRoute', route => onRoute({ method: route.method, url: route.url }));

  // A successful admin change to what the storefront shows records "catalog.changed"; the worker then
  // revalidates the storefront cache. If recording fails, cached pages still expire within 60 seconds.
  const CATALOG_WRITES = /^\/api\/v1\/admin\/(products|categories|inventory|settings)(\/|$)/;
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.method === 'GET' || reply.statusCode >= 300 || !CATALOG_WRITES.test(request.routeOptions.url ?? '')) return payload;
    try { await recordOutboxEvent(pool, 'catalog.changed', { route: request.routeOptions.url }); } catch (error) {
      request.log.warn({ err: error }, 'Could not record catalog.changed');
    }
    return payload;
  });

  await app.register(helmet, {
    // The API serves JSON and images only; nothing here should ever be framed or execute scripts.
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], imgSrc: ["'self'"] } },
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 5 } });
  if (enableRateLimit) {
    // The web server's cached catalogue reads all come from one address; it identifies itself with a
    // server-only token so shoppers do not share its budget. The token grants nothing else.
    const internal = config.internalApiToken ? Buffer.from(config.internalApiToken) : null;
    const isInternalRead = (request: FastifyRequest) => {
      const presented = request.headers['x-sac-internal'];
      if (!internal || request.method !== 'GET' || typeof presented !== 'string') return false;
      const candidate = Buffer.from(presented);
      return candidate.length === internal.length && timingSafeEqual(candidate, internal);
    };
    await app.register(rateLimit, { max: 300, timeWindow: '1 minute', allowList: request => isInternalRead(request) });
  }
  // Keep the exact JSON bytes for Razorpay webhook HMAC verification while still
  // exposing the parsed object to normal Fastify handlers. Re-serializing JSON
  // changes whitespace/key order and invalidates the provider signature.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 1_048_576 }, (request, body, done) => {
    try {
      (request as FastifyRequest & { rawBody?: Buffer }).rawBody = Buffer.from(body as Buffer);
      done(null, JSON.parse((body as Buffer).toString('utf8')));
    } catch {
      done(Object.assign(new Error('Invalid JSON request body'), { statusCode: 400 }));
    }
  });

  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 65_536 }, (_request, body, done) => {
    try {
      done(null, Object.fromEntries(new URLSearchParams(body as string).entries()));
    } catch {
      done(new Error('Invalid form-encoded request body'));
    }
  });

  const onlinePaymentsAvailable = () => onlinePaymentsReady(config.onlinePaymentsEnabled);
  const deps = { onlinePaymentsAvailable };

  app.get('/health', async () => ({ status: 'ok', service: 'sri-anantha-cart-api' }));
  await registerAuthRoutes(app, pool, { config, sendOtp: sendOtp ?? createOtpSender(config) });
  await registerStaffAuthRoutes(app, pool);
  await registerStaffGoogleAuthRoute(app, pool, config);
  await registerAccountRoutes(app, pool);
  await registerAddressRoutes(app, pool);
  await registerCatalogRoutes(app, pool);
  await registerStoreRoutes(app, pool, deps);
  await registerCartRoutes(app, pool, deps);
  await registerDeliveryRoutes(app, pool);
  await registerDeliveryPartnerAuthRoutes(app, pool, { config, sendOtp: sendOtp ?? createOtpSender(config) });
  await registerDeliveryPartnerOrderRoutes(app, pool, { config, sendOtp: sendOtp ?? createOtpSender(config) });
  await registerCustomerDeliveryOtpRoutes(app, pool, { config, sendOtp: sendOtp ?? createOtpSender(config) });
  await registerGeoRoutes(app, { config, ...(geoFetch ? { fetchImpl: geoFetch } : {}) });
  await registerOrderRoutes(app, pool, { checkoutEnabled: () => config.checkoutEnabled, onlinePaymentsAvailable });
  await registerRazorpayWebhookRoute(app, pool);
  const media = mediaStore ?? createMediaStore(config);
  await registerReturnRoutes(app, pool, media);
  await registerAdminRoutes(app, pool, { ...deps, media });
  await registerMediaRoutes(app, pool, { mediaDir: config.mediaDir, media });

  app.setNotFoundHandler(async (_request, reply) => reply.code(404).send({ error: 'NOT_FOUND', message: 'Resource not found' }));
  app.setErrorHandler(async (error, request, reply) => {
    const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
    const isClientError = statusCode >= 400 && statusCode < 500;
    if (isClientError) request.log.warn({ err: error }, 'Client request rejected');
    else request.log.error({ err: error }, 'Request failed');
    // Never leak internal error details (SQL, stack traces) to clients.
    return reply.code(isClientError ? statusCode : 500).send({
      error: isClientError ? (statusCode === 429 ? 'RATE_LIMITED' : 'REQUEST_ERROR') : 'INTERNAL_ERROR',
      message: isClientError ? (statusCode === 429 ? 'Too many requests. Please slow down and try again.' : error instanceof Error ? error.message : 'Bad request') : 'Something went wrong. Please try again.',
    });
  });
  return app;
}
