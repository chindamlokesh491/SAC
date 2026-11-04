import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type {} from '@fastify/multipart';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import sharp from 'sharp';
import { requireRole } from '../auth/session.js';
import { audit } from '../lib/http.js';
import type { MediaStore, PublicBucket } from './store.js';

// Vercel Functions cap incoming request bodies at about 4.5 MB. Leave room for multipart overhead.
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const ACCEPTED_FORMATS = new Set(['jpeg', 'png', 'webp', 'avif']);
const FILE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(-sm|-md)?\.webp$/;

/**
 * Decodes the upload with sharp and re-encodes it as WebP in three sizes (1200, 720 and 400 px).
 * Re-encoding discards anything that is not pixel data (EXIF/GPS metadata, embedded scripts,
 * polyglots), and the decoder rejects files that are not genuine images.
 */
export async function storeImage(store: MediaStore, bucket: PublicBucket, input: Buffer): Promise<{ id: string; url: string; thumbUrl: string; bytes: number; width: number; height: number }> {
  const image = sharp(input, { limitInputPixels: 40_000_000, failOn: 'error' });
  const metadata = await image.metadata();
  if (!metadata.format || !ACCEPTED_FORMATS.has(metadata.format)) throw new Error('UNSUPPORTED_IMAGE');
  const id = randomUUID();
  const resize = (size: number, quality: number, alphaQuality: number) => sharp(input, { limitInputPixels: 40_000_000 }).rotate()
    .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
    .webp({ quality, alphaQuality }).toBuffer({ resolveWithObject: true });
  const [main, medium, thumb] = await Promise.all([resize(1200, 82, 90), resize(720, 80, 88), resize(400, 78, 85)]);
  const files: [string, Buffer][] = [[`${id}.webp`, main.data], [`${id}-md.webp`, medium.data], [`${id}-sm.webp`, thumb.data]];
  const written: string[] = [];
  try {
    for (const [name, data] of files) { await store.put(bucket, name, data, 'image/webp'); written.push(name); }
  } catch (error) {
    await store.remove(bucket, written).catch(() => undefined); // no half-uploaded images left behind
    throw error;
  }
  return { id, url: store.publicUrl(bucket, `${id}.webp`), thumbUrl: store.publicUrl(bucket, `${id}-sm.webp`), bytes: main.data.length, width: main.info.width, height: main.info.height };
}

const PURPOSE_BUCKET: Record<string, PublicBucket> = { product: 'product-images', category: 'category-images', banner: 'banners' };

export async function registerMediaRoutes(app: FastifyInstance, pool: Pool, options: { mediaDir: string; media: MediaStore }): Promise<void> {
  // Local-disk images (development, and any not yet moved to Supabase Storage).
  app.get<{ Params: { file: string } }>('/media/:file', async (request, reply) => {
    const { file } = request.params;
    if (!FILE_PATTERN.test(file)) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Resource not found' });
    const path = join(options.mediaDir, file);
    try {
      const info = await stat(path);
      if (!info.isFile()) throw new Error('not a file');
      return reply
        .header('content-type', 'image/webp')
        .header('content-length', info.size)
        .header('cache-control', 'public, max-age=31536000, immutable')
        .header('cross-origin-resource-policy', 'cross-origin')
        .send(createReadStream(path));
    } catch {
      return reply.code(404).send({ error: 'NOT_FOUND', message: 'Resource not found' });
    }
  });

  app.post<{ Querystring: { purpose?: string } }>('/api/v1/admin/media', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const user = await requireRole(pool, request, reply, ['admin']);
    if (!user) return;
    const bucket = PURPOSE_BUCKET[request.query.purpose ?? 'product'];
    if (!bucket) return reply.code(400).send({ error: 'INVALID_PURPOSE', message: 'purpose must be product, category or banner' });
    if (!request.isMultipart()) return reply.code(415).send({ error: 'MULTIPART_REQUIRED', message: 'Upload the image as multipart/form-data' });
    let file;
    try {
      file = await request.file({ limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });
    } catch {
      return reply.code(400).send({ error: 'INVALID_UPLOAD', message: 'Could not read the uploaded file' });
    }
    if (!file) return reply.code(400).send({ error: 'FILE_REQUIRED', message: 'Choose an image to upload' });
    const buffer = await file.toBuffer().catch(() => null);
    if (!buffer || file.file.truncated) return reply.code(413).send({ error: 'FILE_TOO_LARGE', message: 'Images must be 4 MB or smaller' });
    let stored;
    try {
      stored = await storeImage(options.media, bucket, buffer);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Supabase Storage')) {
        request.log.error({ err: error }, 'Image storage failed');
        return reply.code(502).send({ error: 'STORAGE_UNAVAILABLE', message: 'The image could not be saved. Please try again.' });
      }
      return reply.code(400).send({ error: 'UNSUPPORTED_IMAGE', message: 'Upload a JPG, PNG, WebP or AVIF image' });
    }
    await pool.query(
      `INSERT INTO media_assets (file_name, content_type, byte_size, width, height, created_by, storage, bucket, public_url)
       VALUES ($1, 'image/webp', $2, $3, $4, $5, $6, $7, $8)`,
      [`${stored.id}.webp`, stored.bytes, stored.width, stored.height, user.id, options.media.kind, options.media.kind === 'supabase' ? bucket : null, stored.url],
    );
    await audit(pool, user.id, 'media.uploaded', 'media', stored.id, { bytes: stored.bytes, bucket });
    return reply.code(201).send({ data: { url: stored.url, thumb_url: stored.thumbUrl, width: stored.width, height: stored.height } });
  });
}
