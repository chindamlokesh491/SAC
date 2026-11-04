import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { parseOrReply } from '../lib/http.js';

export type ReverseAddress = { postal_code: string | null; line1: string | null; locality: string | null; city: string | null; state: string | null; display: string };
type Fetch = typeof fetch;

const CACHE_LIMIT = 1000;
const MIN_GAP_MS = 1100;

/**
 * "Use my location": turns device coordinates into an editable address via a Nominatim-compatible
 * geocoder. Runs on the server so the browser only ever talks to our own origin. Coordinates are
 * rounded to ~100 m, never logged or stored, and lookups are cached and paced to one per second.
 */
export async function registerGeoRoutes(app: FastifyInstance, deps: { config: AppConfig; fetchImpl?: Fetch }): Promise<void> {
  const cache = new Map<string, ReverseAddress>();
  let queue: Promise<unknown> = Promise.resolve();
  let last = 0;
  const paced = <T>(task: () => Promise<T>) => {
    const run = queue.then(async () => {
      const wait = last + MIN_GAP_MS - Date.now();
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
      last = Date.now();
      return task();
    });
    queue = run.catch(() => undefined);
    return run;
  };

  app.get('/api/v1/geo/reverse', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    // Coordinates are personal data: keep them out of request logs.
    logLevel: 'warn',
  }, async (request, reply) => {
    const query = parseOrReply(z.object({ lat: z.coerce.number().min(-90).max(90), lon: z.coerce.number().min(-180).max(180) }).strict(), request.query, reply);
    if (!query) return;
    if (!deps.config.geocoderUrl) return reply.code(503).send({ error: 'GEOCODER_DISABLED', message: 'Location lookup is not available. Please type your PIN code.' });
    // India only (generous bounding box).
    if (query.lat < 6 || query.lat > 37.5 || query.lon < 68 || query.lon > 97.5) {
      return reply.code(422).send({ error: 'OUTSIDE_INDIA', message: 'Your location appears to be outside India. Please type your PIN code.' });
    }
    const lat = Math.round(query.lat * 1000) / 1000;
    const lon = Math.round(query.lon * 1000) / 1000;
    const key = `${lat},${lon}`;
    const cached = cache.get(key);
    if (cached) return { data: cached };

    let payload: { address?: Record<string, string>; display_name?: string };
    try {
      payload = await paced(async () => {
        const url = new URL(deps.config.geocoderUrl);
        url.searchParams.set('format', 'jsonv2');
        url.searchParams.set('lat', String(lat));
        url.searchParams.set('lon', String(lon));
        url.searchParams.set('zoom', '18');
        url.searchParams.set('addressdetails', '1');
        url.searchParams.set('accept-language', 'en');
        if (deps.config.geocoderContact) url.searchParams.set('email', deps.config.geocoderContact);
        const response = await (deps.fetchImpl ?? fetch)(url, {
          headers: { 'user-agent': `SriAnanthaCart/1.0${deps.config.geocoderContact ? ` (${deps.config.geocoderContact})` : ''}`, accept: 'application/json' },
          signal: AbortSignal.timeout(6000),
        });
        if (!response.ok) throw new Error(`geocoder ${response.status}`);
        return response.json() as Promise<{ address?: Record<string, string>; display_name?: string }>;
      });
    } catch (error) {
      request.log.warn({ err: error instanceof Error ? error.message : 'unknown' }, 'Reverse geocoding failed');
      return reply.code(502).send({ error: 'GEOCODER_UNAVAILABLE', message: 'Could not find your address right now. Please type your PIN code.' });
    }
    const a = payload.address ?? {};
    const postcode = (a.postcode ?? '').replace(/\s/g, '');
    const result: ReverseAddress = {
      postal_code: /^[1-9][0-9]{5}$/.test(postcode) ? postcode : null,
      line1: [a.house_number, a.road].filter(Boolean).join(', ') || null,
      locality: a.suburb ?? a.neighbourhood ?? a.quarter ?? a.village ?? a.hamlet ?? null,
      city: a.city ?? a.town ?? a.municipality ?? a.city_district ?? a.county ?? a.state_district ?? null,
      state: a.state ?? null,
      display: String(payload.display_name ?? '').slice(0, 300),
    };
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
    cache.set(key, result);
    return { data: result };
  });
}
