import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { deliveryOptions, findZone } from '../orders/pricing.js';
import { loadSettings } from '../settings/store-settings.js';

/** Public delivery availability is derived from active zones only; no customer data is returned. */
export async function registerDeliveryRoutes(app: FastifyInstance, pool: Pool) {
  app.get<{ Querystring: { postal_code?: string } }>('/api/v1/delivery/availability', async (request, reply) => {
    const postalCode = request.query.postal_code?.trim() ?? '';
    if (!/^[1-9][0-9]{5}$/.test(postalCode)) {
      return reply.code(400).send({ error: 'INVALID_POSTAL_CODE', message: 'Enter a valid six-digit PIN code.' });
    }
    const zone = await findZone(pool, postalCode);
    if (!zone) return { data: { serviceable: false, postal_code: postalCode, message: 'Delivery is not currently available for this PIN code.', express: null, scheduled: [] } };
    const settings = await loadSettings(pool);
    const options = await deliveryOptions(pool, zone, settings);
    return {
      data: {
        serviceable: true,
        postal_code: postalCode,
        zone: {
          name: zone.name, delivery_fee_paise: Number(zone.delivery_fee_paise), minimum_order_paise: Number(zone.minimum_order_paise),
          estimated_minutes: Number(zone.estimated_minutes), cod_enabled: zone.cod_enabled,
        },
        free_delivery_threshold_paise: settings.delivery.free_delivery_threshold_paise,
        express: options.express,
        scheduled: options.scheduled,
      },
    };
  });
}
