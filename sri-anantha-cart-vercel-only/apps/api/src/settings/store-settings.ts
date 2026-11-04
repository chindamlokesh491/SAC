import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

const optionalUrl = z.union([z.literal(''), z.string().url().max(300).regex(/^https:\/\//, 'Use an https:// link')]);

export const settingsSchemas = {
  store: z.object({
    // Brand name and tagline are fixed; they are accepted for compatibility but never changed here.
    name: z.string().trim().min(2).max(80).optional(),
    tagline: z.string().trim().max(80).optional(),
    support_phone: z.union([z.literal(''), z.string().regex(/^\+?[0-9 ]{8,16}$/, 'Enter a valid phone number')]),
    support_email: z.union([z.literal(''), z.string().email().max(254)]),
    whatsapp: z.union([z.literal(''), z.string().regex(/^\+?[0-9 ]{8,16}$/, 'Enter a valid WhatsApp number')]),
    gstin: z.union([z.literal(''), z.string().regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'Enter a valid 15-character GSTIN')]),
    legal_name: z.string().trim().max(120),
    address: z.string().trim().max(300),
    state_code: z.string().regex(/^[0-9]{2}$/),
    instagram_url: optionalUrl,
    facebook_url: optionalUrl,
    youtube_url: optionalUrl,
  }).strict(),
  payments: z.object({
    upi: z.boolean(),
    card: z.boolean(),
    net_banking: z.boolean(),
    wallet: z.boolean(),
    cod: z.boolean(),
    cod_limit_paise: z.number().int().min(0).max(10_000_000),
  }).strict(),
  delivery: z.object({
    free_delivery_threshold_paise: z.number().int().min(0).max(10_000_000),
    express_enabled: z.boolean(),
    scheduled_days_ahead: z.number().int().min(0).max(7),
    scheduled_lead_minutes: z.number().int().min(0).max(24 * 60),
  }).strict(),
  tax: z.object({
    show_breakup_on_invoice: z.boolean(),
  }).strict(),
};

export type SettingsKey = keyof typeof settingsSchemas;
export type StoreSettings = { [K in SettingsKey]: z.infer<(typeof settingsSchemas)[K]> };

export const defaultSettings: StoreSettings = {
  store: { name: 'Sri Anantha Cart', tagline: 'Your Pooja Essentials', support_phone: '', support_email: '', whatsapp: '', gstin: '', legal_name: '', address: 'Tirupati, Andhra Pradesh', state_code: '37', instagram_url: '', facebook_url: '', youtube_url: '' },
  payments: { upi: true, card: true, net_banking: true, wallet: false, cod: true, cod_limit_paise: 200000 },
  delivery: { free_delivery_threshold_paise: 49900, express_enabled: true, scheduled_days_ahead: 2, scheduled_lead_minutes: 60 },
  tax: { show_breakup_on_invoice: true },
};

/** Reads all settings, falling back to defaults for missing or invalid stored values. */
export async function loadSettings(db: Pool | PoolClient): Promise<StoreSettings> {
  const result = await db.query<{ key: string; value: unknown }>('SELECT key, value FROM store_settings');
  const settings = structuredClone(defaultSettings) as Record<SettingsKey, unknown>;
  for (const row of result.rows) {
    if (!(row.key in settingsSchemas)) continue;
    const key = row.key as SettingsKey;
    const merged = { ...(defaultSettings[key] as object), ...(row.value as object) };
    const parsed = settingsSchemas[key].safeParse(merged);
    if (parsed.success) settings[key] = parsed.data;
  }
  return settings as StoreSettings;
}

/** Fields safe to show on the storefront (no internal toggles beyond what customers need). */
export function publicSettings(settings: StoreSettings, onlinePaymentsAvailable: boolean) {
  const { store, payments, delivery } = settings;
  return {
    store: {
      name: store.name, tagline: store.tagline, support_phone: store.support_phone, support_email: store.support_email,
      whatsapp: store.whatsapp, address: store.address, instagram_url: store.instagram_url, facebook_url: store.facebook_url, youtube_url: store.youtube_url,
    },
    payments: {
      upi: payments.upi && onlinePaymentsAvailable,
      card: payments.card && onlinePaymentsAvailable,
      net_banking: payments.net_banking && onlinePaymentsAvailable,
      wallet: payments.wallet && onlinePaymentsAvailable,
      cod: payments.cod,
      cod_limit_paise: payments.cod_limit_paise,
      online_available: onlinePaymentsAvailable,
    },
    delivery: { free_delivery_threshold_paise: delivery.free_delivery_threshold_paise, express_enabled: delivery.express_enabled },
  };
}
