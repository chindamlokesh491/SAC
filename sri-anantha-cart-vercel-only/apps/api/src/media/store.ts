import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Where image files live. Local disk for development; Supabase Storage for deployment.
 * The service-role key remains server-side. Return evidence uses private operations only.
 */
export const PUBLIC_BUCKETS = ['product-images', 'category-images', 'banners', 'public-assets'] as const;
export type PublicBucket = (typeof PUBLIC_BUCKETS)[number];
const ID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const PRIVATE_NAME = new RegExp('^' + ID + '\\.webp$', 'i');
export const VARIANT_SUFFIXES = ['', '-md', '-sm'] as const;

export type MediaStore = {
  readonly kind: 'local' | 'supabase';
  put(bucket: PublicBucket, name: string, data: Buffer, contentType: string): Promise<void>;
  remove(bucket: PublicBucket | null, names: string[]): Promise<void>;
  publicUrl(bucket: PublicBucket, name: string): string;
  locate(url: string): { bucket: PublicBucket | null; id: string } | null;
  putPrivate(name: string, data: Buffer, contentType: 'image/webp'): Promise<void>;
  getPrivate(name: string): Promise<Buffer | null>;
  removePrivate(names: string[]): Promise<void>;
};

export function localMediaStore(mediaDir: string): MediaStore {
  const pattern = new RegExp('^/media/(' + ID + ')\\.webp$');
  return {
    kind: 'local',
    async put(_bucket, name, data) {
      await mkdir(mediaDir, { recursive: true });
      await writeFile(join(mediaDir, name), data, { flag: 'wx', mode: 0o644 });
    },
    async remove(_bucket, names) {
      for (const name of names) await unlink(join(mediaDir, name)).catch(() => undefined);
    },
    async putPrivate(name, data) {
      if (!PRIVATE_NAME.test(name)) throw new Error('Invalid private media name');
      const directory = join(mediaDir, '.private');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(join(directory, name), data, { flag: 'wx', mode: 0o600 });
    },
    async getPrivate(name) {
      if (!PRIVATE_NAME.test(name)) return null;
      try { return await readFile(join(mediaDir, '.private', name)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    },
    async removePrivate(names) {
      for (const name of names) if (PRIVATE_NAME.test(name)) {
        await unlink(join(mediaDir, '.private', name)).catch(() => undefined);
      }
    },
    publicUrl: (_bucket, name) => '/media/' + name,
    locate(url) {
      const match = pattern.exec(url);
      return match ? { bucket: null, id: match[1]! } : null;
    },
  };
}

export function supabaseMediaStore(options: { url: string; serviceRoleKey: string; fetchImpl?: typeof fetch; timeoutMs?: number }): MediaStore {
  const base = options.url.replace(/\/$/, '');
  const doFetch = options.fetchImpl ?? fetch;
  const headers = { authorization: 'Bearer ' + options.serviceRoleKey, apikey: options.serviceRoleKey };
  const call = async (path: string, init: RequestInit) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
    try {
      const response = await doFetch(base + '/storage/v1/' + path, {
        ...init,
        headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error('Supabase Storage ' + (init.method ?? 'GET') + ' failed with HTTP ' + response.status);
      return response;
    } finally { clearTimeout(timer); }
  };
  return {
    kind: 'supabase',
    async put(bucket, name, data, contentType) {
      await call('object/' + bucket + '/' + name, {
        method: 'POST', body: new Uint8Array(data),
        headers: { 'content-type': contentType, 'cache-control': 'max-age=31536000, immutable', 'x-upsert': 'false' },
      });
    },
    async remove(bucket, names) {
      if (!bucket || !names.length) return;
      await call('object/' + bucket, { method: 'DELETE', body: JSON.stringify({ prefixes: names }), headers: { 'content-type': 'application/json' } });
    },
    async putPrivate(name, data, contentType) {
      if (!PRIVATE_NAME.test(name)) throw new Error('Invalid private media name');
      await call('object/private-files/' + name, {
        method: 'POST', body: new Uint8Array(data),
        headers: { 'content-type': contentType, 'cache-control': 'no-store', 'x-upsert': 'false' },
      });
    },
    async getPrivate(name) {
      if (!PRIVATE_NAME.test(name)) return null;
      try {
        const response = await call('object/private-files/' + name, { method: 'GET' });
        return Buffer.from(await response.arrayBuffer());
      } catch (error) {
        if (error instanceof Error && /HTTP 404/.test(error.message)) return null;
        throw error;
      }
    },
    async removePrivate(names) {
      const safe = names.filter(name => PRIVATE_NAME.test(name));
      if (safe.length) await call('object/private-files', { method: 'DELETE', body: JSON.stringify({ prefixes: safe }), headers: { 'content-type': 'application/json' } });
    },
    publicUrl: (bucket, name) => base + '/storage/v1/object/public/' + bucket + '/' + name,
    locate(url) {
      try {
        const parsed = new URL(url, base);
        if (parsed.origin !== new URL(base).origin) return null;
        const match = new RegExp('^/storage/v1/object/public/(' + PUBLIC_BUCKETS.join('|') + ')/(' + ID + ')\\.webp$').exec(parsed.pathname);
        return match ? { bucket: match[1] as PublicBucket, id: match[2]! } : null;
      } catch { return null; }
    },
  };
}

export function createMediaStore(config: { mediaStorage: 'local' | 'supabase'; mediaDir: string; supabaseUrl: string | null; supabaseServiceRoleKey: string | null }): MediaStore {
  if (config.mediaStorage === 'supabase') {
    if (!config.supabaseUrl || !config.supabaseServiceRoleKey) throw new Error('MEDIA_STORAGE=supabase needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
    return supabaseMediaStore({ url: config.supabaseUrl, serviceRoleKey: config.supabaseServiceRoleKey });
  }
  return localMediaStore(config.mediaDir);
}

/** URL of a smaller version ("-sm" 400 px, "-md" 720 px) of an uploaded image, or the URL itself otherwise. */
export function variantUrl(url: string | null, suffix: '-sm' | '-md'): string | null {
  if (!url) return null;
  return new RegExp('/' + ID + '\\.webp$').test(url) ? url.replace(/\.webp$/, suffix + '.webp') : url;
}
