import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { requireRole } from '../../auth/session.js';
import { audit, parseOrReply, withTransaction } from '../../lib/http.js';
import { loadSettings, settingsSchemas, type SettingsKey } from '../../settings/store-settings.js';
import { razorpayConfig } from '../../payments/razorpay.js';

export async function registerAdminSettingsRoutes(app: FastifyInstance, pool: Pool, deps: { onlinePaymentsAvailable: () => boolean }): Promise<void> {
  app.get('/api/v1/admin/settings', async (request, reply) => {
    const user = await requireRole(pool, request, reply, ['admin', 'operator']);
    if (!user) return;
    const staff = user.role === 'admin'
      ? (await pool.query(`SELECT id, display_name, phone_e164, role FROM users WHERE role IN ('admin','operator') ORDER BY role, created_at`)).rows
      : [];
    return {
      data: await loadSettings(pool),
      staff,
      integrations: {
        online_payments_available: deps.onlinePaymentsAvailable(),
        razorpay_configured: razorpayConfig() !== null,
        sms_configured: process.env.OTP_PROVIDER === 'smsgatewayhub'
          ? Boolean(process.env.SMSGH_API_KEY && process.env.SMSGH_SENDER_ID && process.env.SMSGH_ENTITY_ID && process.env.SMSGH_OTP_TEMPLATE_ID && process.env.SMSGH_OTP_TEMPLATE_TEXT)
          : Boolean(process.env.OTP_SEND_URL && process.env.OTP_API_KEY),
        sms_delivery_template_configured: process.env.OTP_PROVIDER === 'smsgatewayhub' && Boolean(process.env.SMSGH_DELIVERY_TEMPLATE_ID && process.env.SMSGH_DELIVERY_TEMPLATE_TEXT),
        google_sign_in_configured: Boolean(process.env.GOOGLE_CLIENT_IDS || process.env.GOOGLE_CLIENT_ID),
      },
    };
  });

  app.put<{ Params: { key: string } }>('/api/v1/admin/settings/:key', async (request, reply) => {
    const user = await requireRole(pool, request, reply, ['admin']);
    if (!user) return;
    if (!(request.params.key in settingsSchemas)) return reply.code(404).send({ error: 'UNKNOWN_SETTING', message: 'Unknown settings section' });
    const key = request.params.key as SettingsKey;
    const parsed = parseOrReply(settingsSchemas[key], request.body, reply);
    if (!parsed) return;
    const current = await loadSettings(pool);
    const value = key === 'store' ? { ...parsed, name: current.store.name, tagline: current.store.tagline } : parsed;
    await withTransaction(pool, async client => {
      await client.query(
        `INSERT INTO store_settings(key, value, updated_by, updated_at) VALUES ($1, $2::jsonb, $3, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [key, JSON.stringify(value), user.id],
      );
      await audit(client, user.id, 'settings.updated', 'settings', key, { value });
    });
    return { data: (await loadSettings(pool))[key] };
  });
}
