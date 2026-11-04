import { isAbsolute, resolve } from 'node:path';
import { razorpayLiveViolation } from './payments/razorpay.js';

/**
 * Centralised, validated runtime configuration. Production refuses to start with
 * unsafe settings instead of silently running with insecure defaults.
 */
export type AppConfig = {
  nodeEnv: 'development' | 'test' | 'production';
  sessionSecret: string;
  cookieSecure: boolean;
  /** Fastify trustProxy: false, true, or number of trusted hops. */
  trustProxy: boolean | number;
  otpProvider: 'http' | 'smsgatewayhub' | 'dev-outbox' | 'none';
  smsGatewayHubApiKey: string | null;
  smsGatewayHubSenderId: string | null;
  smsGatewayHubEntityId: string | null;
  smsGatewayHubOtpTemplateId: string | null;
  smsGatewayHubOtpTemplateText: string | null;
  /** Separate DLT template for customer delivery codes. Unset: delivery codes are shown in-app only, never sent on the login template. */
  smsGatewayHubDeliveryTemplateId: string | null;
  smsGatewayHubDeliveryTemplateText: string | null;
  smsGatewayHubRoute: string | null;
  smsGatewayHubChannel: '2' | 'OTP';
  otpDevOutboxPath: string | null;
  deploymentEnvironment: 'development' | 'staging' | 'production';
  allowDevOtp: boolean;
  googleClientIds: string[];
  mediaDir: string;
  /** Where uploaded images are stored: local disk (development) or Supabase Storage. */
  mediaStorage: 'local' | 'supabase';
  /** https://<project-ref>.supabase.co — public, not a secret. */
  supabaseUrl: string | null;
  /** Server-only secret used for Storage uploads and deletes. Never logged, never sent to clients. */
  supabaseServiceRoleKey: string | null;
  publicWebUrl: string | null;
  checkoutEnabled: boolean;
  onlinePaymentsEnabled: boolean;
  /** Local automation only; refused in production. */
  rateLimitDisabled: boolean;
  /** Shared with the web server only; exempts its cached catalogue reads from per-IP rate limits. */
  internalApiToken: string | null;
  /** Nominatim-compatible reverse geocoder for "use my location"; empty string disables the feature. */
  geocoderUrl: string;
  /** Contact sent with geocoder requests (required by the OpenStreetMap usage policy). */
  geocoderContact: string;
};

function parseTrustProxy(value: string | undefined): boolean | number {
  if (!value || value === 'false') return false;
  if (value === 'true') return true;
  const hops = Number(value);
  if (Number.isInteger(hops) && hops >= 1 && hops <= 5) return hops;
  throw new Error('TRUST_PROXY must be false, true, or a hop count from 1 to 5');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV === 'production' ? 'production' : env.NODE_ENV === 'test' ? 'test' : 'development';
  const sessionSecret = env.SESSION_SECRET ?? '';
  const deploymentEnvironment = (env.DEPLOYMENT_ENV || (nodeEnv === 'production' ? 'production' : 'development')) as AppConfig['deploymentEnvironment'];
  if (!['development', 'staging', 'production'].includes(deploymentEnvironment)) throw new Error('DEPLOYMENT_ENV must be development, staging or production');
  const allowDevOtp = env.ALLOW_DEV_OTP === 'true';
  const otpProvider = (env.OTP_PROVIDER || (nodeEnv === 'production' ? 'http' : 'none')) as AppConfig['otpProvider'];
  if (!['http', 'smsgatewayhub', 'dev-outbox', 'none'].includes(otpProvider)) throw new Error('OTP_PROVIDER must be http, smsgatewayhub, dev-outbox or none');
  const smsGatewayHubChannel = (env.SMSGH_CHANNEL || '2') as AppConfig['smsGatewayHubChannel'];
  if (!['2', 'OTP'].includes(smsGatewayHubChannel)) throw new Error('SMSGH_CHANNEL must be 2 or OTP');
  const smsGatewayHubOtpTemplateText = env.SMSGH_OTP_TEMPLATE_TEXT || null;
  if (otpProvider === 'smsgatewayhub') {
    if (!env.SMSGH_API_KEY) throw new Error('SMSGH_API_KEY is required when OTP_PROVIDER=smsgatewayhub');
    if (!/^[A-Za-z0-9]{6}$/.test(env.SMSGH_SENDER_ID || '')) throw new Error('SMSGH_SENDER_ID must be the approved 6-character sender ID');
    if (!env.SMSGH_ENTITY_ID) throw new Error('SMSGH_ENTITY_ID is required when OTP_PROVIDER=smsgatewayhub');
    if (!/^\d{8,25}$/.test(env.SMSGH_OTP_TEMPLATE_ID || '')) throw new Error('SMSGH_OTP_TEMPLATE_ID must be the approved DLT template ID');
    const variables = smsGatewayHubOtpTemplateText?.match(/\{#(?:var|numeric|alphanumeric)#\}/g) ?? [];
    if (variables.length !== 1) throw new Error('SMSGH_OTP_TEMPLATE_TEXT must contain exactly one approved DLT variable placeholder');
    if (env.SMSGH_DELIVERY_TEMPLATE_ID || env.SMSGH_DELIVERY_TEMPLATE_TEXT) {
      if (!/^\d{8,25}$/.test(env.SMSGH_DELIVERY_TEMPLATE_ID || '')) throw new Error('SMSGH_DELIVERY_TEMPLATE_ID must be the approved DLT template ID for delivery codes');
      const deliveryVariables = env.SMSGH_DELIVERY_TEMPLATE_TEXT?.match(/\{#(?:var|numeric|alphanumeric)#\}/g) ?? [];
      if (deliveryVariables.length !== 1) throw new Error('SMSGH_DELIVERY_TEMPLATE_TEXT must contain exactly one approved DLT variable placeholder');
      if (env.SMSGH_DELIVERY_TEMPLATE_ID === env.SMSGH_OTP_TEMPLATE_ID) throw new Error('Delivery codes need their own DLT template; SMSGH_DELIVERY_TEMPLATE_ID must differ from SMSGH_OTP_TEMPLATE_ID');
    }
  }

  const config: AppConfig = {
    nodeEnv,
    sessionSecret,
    cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : nodeEnv === 'production',
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    otpProvider,
    smsGatewayHubApiKey: env.SMSGH_API_KEY || null,
    smsGatewayHubSenderId: env.SMSGH_SENDER_ID || null,
    smsGatewayHubEntityId: env.SMSGH_ENTITY_ID || null,
    smsGatewayHubOtpTemplateId: env.SMSGH_OTP_TEMPLATE_ID || null,
    smsGatewayHubOtpTemplateText,
    smsGatewayHubDeliveryTemplateId: env.SMSGH_DELIVERY_TEMPLATE_ID || null,
    smsGatewayHubDeliveryTemplateText: env.SMSGH_DELIVERY_TEMPLATE_TEXT || null,
    smsGatewayHubRoute: env.SMSGH_ROUTE || null,
    smsGatewayHubChannel,
    otpDevOutboxPath: env.OTP_DEV_OUTBOX ? resolve(env.OTP_DEV_OUTBOX) : null,
    deploymentEnvironment,
    allowDevOtp,
    googleClientIds: (env.GOOGLE_CLIENT_IDS ?? env.GOOGLE_CLIENT_ID ?? '').split(',').map(id => id.trim()).filter(Boolean),
    mediaDir: env.MEDIA_DIR ? (isAbsolute(env.MEDIA_DIR) ? env.MEDIA_DIR : resolve(env.MEDIA_DIR)) : resolve('var/media'),
    mediaStorage: env.MEDIA_STORAGE === 'supabase' ? 'supabase' : 'local',
    supabaseUrl: env.SUPABASE_URL ? env.SUPABASE_URL.replace(/\/$/, '') : null,
    supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY || null,
    publicWebUrl: env.PUBLIC_WEB_URL ? env.PUBLIC_WEB_URL.replace(/\/$/, '') : null,
    checkoutEnabled: env.CHECKOUT_ENABLED === 'true',
    onlinePaymentsEnabled: env.ONLINE_PAYMENTS_ENABLED === 'true',
    rateLimitDisabled: env.DEV_DISABLE_RATE_LIMIT === 'true',
    internalApiToken: env.INTERNAL_API_TOKEN || null,
    geocoderUrl: env.GEOCODER_URL ?? 'https://nominatim.openstreetmap.org/reverse',
    geocoderContact: env.GEOCODER_CONTACT ?? '',
  };

  if (env.MEDIA_STORAGE && !['local', 'supabase'].includes(env.MEDIA_STORAGE)) throw new Error('MEDIA_STORAGE must be local or supabase');
  if (config.mediaStorage === 'supabase') {
    if (!config.supabaseUrl || !/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(config.supabaseUrl)) throw new Error('SUPABASE_URL must be https://<project-ref>.supabase.co when MEDIA_STORAGE=supabase');
    if (!config.supabaseServiceRoleKey || config.supabaseServiceRoleKey.length < 30) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required when MEDIA_STORAGE=supabase');
  }

  if (config.nodeEnv === 'production') {
    const problems: string[] = [];
    if (sessionSecret.length < 32) problems.push('SESSION_SECRET must be at least 32 characters');
    if (!config.cookieSecure) problems.push('COOKIE_SECURE must be true');
    if (!['http', 'smsgatewayhub'].includes(config.otpProvider) && !(deploymentEnvironment === 'staging' && allowDevOtp && config.otpProvider === 'dev-outbox')) problems.push('OTP_PROVIDER must be http or smsgatewayhub except for explicitly enabled staging development OTP');
    if (config.publicWebUrl && !config.publicWebUrl.startsWith('https://')) problems.push('PUBLIC_WEB_URL must use https');
    if (config.rateLimitDisabled) problems.push('DEV_DISABLE_RATE_LIMIT must not be set');
    if (config.internalApiToken && config.internalApiToken.length < 32) problems.push('INTERNAL_API_TOKEN must be at least 32 characters');
    if (config.geocoderUrl && !config.geocoderUrl.startsWith('https://')) problems.push('GEOCODER_URL must use https');
    if (env.DATABASE_SSL_REJECT_UNAUTHORIZED === 'false') problems.push('DATABASE_SSL_REJECT_UNAUTHORIZED=false is not allowed (provide DATABASE_SSL_CA instead)');
    if (problems.length) throw new Error(`Unsafe production configuration: ${problems.join('; ')}`);
  }
  // Real-money payments: refuse to start rather than run a staging/dev service against live Razorpay.
  const razorpayViolation = razorpayLiveViolation(env);
  if (razorpayViolation) throw new Error(razorpayViolation);
  if (config.otpProvider === 'dev-outbox' && nodeEnv === 'production' && !(deploymentEnvironment === 'staging' && allowDevOtp)) throw new Error('Development OTP in production Node mode requires DEPLOYMENT_ENV=staging and ALLOW_DEV_OTP=true');
  if (allowDevOtp && (deploymentEnvironment !== 'staging' || config.otpProvider !== 'dev-outbox')) throw new Error('ALLOW_DEV_OTP is permitted only with DEPLOYMENT_ENV=staging and OTP_PROVIDER=dev-outbox');
  if (config.otpProvider === 'dev-outbox' && !config.otpDevOutboxPath) {
    throw new Error('OTP_DEV_OUTBOX is required when OTP_PROVIDER=dev-outbox');
  }
  return config;
}
