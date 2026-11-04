import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import sharp from 'sharp';
import { thumbOf } from '../src/catalog/queries.js';
import { loadConfig } from '../src/config.js';
import { supabaseMediaStore } from '../src/media/store.js';
import { createHarness, skipReason, type Harness } from './support/harness.js';

const SUPABASE = 'https://abcdefghijklmnop.supabase.co';
const KEY = 'service-role-test-key-not-a-real-secret-0123456789';

/** Records Storage API calls and keeps uploaded objects in memory. */
function fakeStorage() {
  const objects = new Map<string, { type: string; bytes: number; data: Buffer }>();
  const calls: { method: string; path: string; auth: string | null; apikey: string | null; upsert: string | null }[] = [];
  const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers);
    calls.push({ method: init.method ?? 'GET', path: url.pathname, auth: headers.get('authorization'), apikey: headers.get('apikey'), upsert: headers.get('x-upsert') });
    const path = url.pathname.replace('/storage/v1/object/', '');
    if (init.method === 'POST') {
      if (objects.has(path)) return new Response('{"error":"Duplicate"}', { status: 409 });
      const data = Buffer.from(init.body as Uint8Array);
      objects.set(path, { type: headers.get('content-type') ?? '', bytes: data.byteLength, data });
      return new Response('{}', { status: 200 });
    }
    if (init.method === 'GET') {
      const found = objects.get(path);
      return found ? new Response(found.data, { status: 200, headers: { 'content-type': found.type } }) : new Response('not found', { status: 404 });
    }
    if (init.method === 'DELETE') {
      for (const name of JSON.parse(String(init.body)).prefixes as string[]) objects.delete(`${path}/${name}`);
      return new Response('[]', { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
  return { objects, calls, fetchImpl };
}

describe('Supabase media store', () => {
  it('uploads with the service key server-side, never overwrites, and builds public URLs', async () => {
    const storage = fakeStorage();
    const store = supabaseMediaStore({ url: SUPABASE, serviceRoleKey: KEY, fetchImpl: storage.fetchImpl });
    const id = randomUUID();
    await store.put('product-images', `${id}.webp`, Buffer.from('x'), 'image/webp');
    assert.deepEqual(storage.calls[0], { method: 'POST', path: `/storage/v1/object/product-images/${id}.webp`, auth: `Bearer ${KEY}`, apikey: KEY, upsert: 'false' });
    await assert.rejects(store.put('product-images', `${id}.webp`, Buffer.from('x'), 'image/webp'), /HTTP 409/);
    const url = store.publicUrl('product-images', `${id}.webp`);
    assert.equal(url, `${SUPABASE}/storage/v1/object/public/product-images/${id}.webp`);
    assert.deepEqual(store.locate(url), { bucket: 'product-images', id });
    assert.equal(store.locate(`https://evil.example/storage/v1/object/public/product-images/${id}.webp`), null);
    assert.equal(store.locate(`${SUPABASE}/storage/v1/object/public/private-files/${id}.webp`), null, 'private files are never treated as public media');
    const privateName = `${randomUUID()}.webp`;
    await store.putPrivate(privateName, Buffer.from('private-evidence'), 'image/webp');
    assert.equal(storage.objects.has(`private-files/${privateName}`), true);
    assert.deepEqual(await store.getPrivate(privateName), Buffer.from('private-evidence'));
    await store.removePrivate([privateName]);
    assert.equal(await store.getPrivate(privateName), null);
    assert.equal(thumbOf(url), url.replace('.webp', '-sm.webp'));
  });

  it('configuration refuses a missing key or a non-Supabase URL', () => {
    const base = { NODE_ENV: 'test', SESSION_SECRET: 'x'.repeat(40), MEDIA_STORAGE: 'supabase' };
    assert.throws(() => loadConfig({ ...base, SUPABASE_URL: SUPABASE }), /SUPABASE_SERVICE_ROLE_KEY/);
    assert.throws(() => loadConfig({ ...base, SUPABASE_URL: 'http://abc.supabase.co', SUPABASE_SERVICE_ROLE_KEY: KEY }), /SUPABASE_URL/);
    assert.throws(() => loadConfig({ ...base, SUPABASE_URL: 'https://storage.evil.example', SUPABASE_SERVICE_ROLE_KEY: KEY }), /SUPABASE_URL/);
    assert.equal(loadConfig({ ...base, SUPABASE_URL: SUPABASE, SUPABASE_SERVICE_ROLE_KEY: KEY }).mediaStorage, 'supabase');
    assert.throws(() => loadConfig({ NODE_ENV: 'test', SESSION_SECRET: 'x'.repeat(40), MEDIA_STORAGE: 's3' }), /MEDIA_STORAGE/);
  });
});

describe('admin uploads to Supabase Storage (integration)', { skip: skipReason }, () => {
  let h: Harness;
  const storage = fakeStorage();
  before(async () => { h = await createHarness({ mediaStore: supabaseMediaStore({ url: SUPABASE, serviceRoleKey: KEY, fetchImpl: storage.fetchImpl }) }); });
  after(async () => { await h?.close(); });

  const upload = async (token: string, purpose?: string) => {
    const boundary = `----sac${randomUUID().replaceAll('-', '')}`;
    const png = await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#c0392b' } }).png().toBuffer();
    const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`), png, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    return h.app.inject({ method: 'POST', url: `/api/v1/admin/media${purpose ? `?purpose=${purpose}` : ''}`, headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${token}` }, payload });
  };

  it('stores three WebP sizes in the right bucket and records the object in PostgreSQL', async () => {
    const admin = await h.login('9700000301', 'admin');
    const response = await upload(admin.token, 'category');
    assert.equal(response.statusCode, 201, response.body);
    const { url, thumb_url } = JSON.parse(response.body).data;
    assert.match(url, new RegExp(`^${SUPABASE}/storage/v1/object/public/category-images/[0-9a-f-]{36}\\.webp$`));
    assert.equal(thumb_url, url.replace('.webp', '-sm.webp'));
    const id = /([0-9a-f-]{36})\.webp$/.exec(url)![1];
    assert.deepEqual([...storage.objects.keys()].sort(), [`category-images/${id}-md.webp`, `category-images/${id}-sm.webp`, `category-images/${id}.webp`]);
    assert.ok([...storage.objects.values()].every(object => object.type === 'image/webp'));
    const row = (await h.pool.query('SELECT storage, bucket, public_url, width FROM media_assets WHERE file_name = $1', [`${id}.webp`])).rows[0];
    assert.deepEqual(row, { storage: 'supabase', bucket: 'category-images', public_url: url, width: 1200 });
  });

  it('only admins can upload; unknown purposes are refused', async () => {
    const customer = await h.login('9700000302');
    const operator = await h.login('9700000303', 'operator');
    const before = storage.objects.size;
    assert.equal((await upload(customer.token)).statusCode, 403);
    assert.equal((await upload(operator.token)).statusCode, 403);
    const admin = await h.login('9700000304', 'admin');
    assert.equal((await upload(admin.token, 'private')).statusCode, 400);
    assert.equal(storage.objects.size, before, 'nothing reached storage');
  });

  it('removing an unused image deletes all three sizes from the bucket', async () => {
    const admin = await h.login('9700000305', 'admin');
    const { url } = JSON.parse((await upload(admin.token, 'category')).body).data;
    const id = /([0-9a-f-]{36})\.webp$/.exec(url)![1]!;
    const categoryId = await h.seed.category('Storage cleanup');
    assert.equal((await h.request('PATCH', `/api/v1/admin/categories/${categoryId}`, { token: admin.token, body: { image_url: url } })).status, 200);
    assert.equal((await h.request('DELETE', `/api/v1/admin/categories/${categoryId}`, { token: admin.token })).status, 204);
    assert.ok(![...storage.objects.keys()].some(key => key.includes(id)), 'all sizes removed');
  });
});
