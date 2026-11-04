import type { FastifyReply } from 'fastify';
import type { PoolClient, Pool } from 'pg';
import { z, type ZodTypeAny } from 'zod';

export const uuidSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, 'Invalid identifier');
export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const slugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and hyphens').max(120);
export const paiseSchema = z.number().int().min(0).max(99_999_999);
export const phoneSchema = z.string().regex(/^\+[1-9][0-9]{7,14}$/, 'Use an international phone number such as +919876543210');
export const postalCodeSchema = z.string().regex(/^[1-9][0-9]{5}$/, 'Enter a valid six-digit PIN code');
export const emailSchema = z.string().trim().toLowerCase().max(254).email('Enter a valid email address');
export const mediaUrlSchema = z.string().max(2048).regex(/^(https:\/\/|\/media\/)[^\s"'<>]+$/, 'Use an uploaded image or an https:// URL');

/** Parse a request payload with a strict schema; replies 400 with field messages on failure. */
export function parseOrReply<S extends ZodTypeAny>(schema: S, value: unknown, reply: FastifyReply): z.infer<S> | null {
  const result = schema.safeParse(value ?? {});
  if (result.success) return result.data;
  const fields: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.join('.') || '_';
    if (!fields[key]) fields[key] = issue.message;
  }
  void reply.code(400).send({ error: 'VALIDATION_FAILED', message: Object.values(fields)[0] ?? 'Invalid request', fields });
  return null;
}

export function paging(query: { limit?: string | undefined; offset?: string | undefined }, defaultLimit = 25, maxLimit = 100) {
  const limit = Math.min(Math.max(Number.parseInt(query.limit ?? String(defaultLimit), 10) || defaultLimit, 1), maxLimit);
  const offset = Math.min(Math.max(Number.parseInt(query.offset ?? '0', 10) || 0, 0), 100_000);
  return { limit, offset };
}

/** Escape LIKE wildcards in user search text. */
export function likePattern(search: string): string {
  return `%${search.trim().slice(0, 100).replace(/[\\%_]/g, '\\$&')}%`;
}

export async function withTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Thrown inside a transaction to roll back and reply with a client error. */
export class HttpError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string, message?: string, public readonly extra: Record<string, unknown> = {}) {
    super(message ?? code);
  }
}

export const FEATURED_LIMIT = 8;

/** Maps the database's featured-limit trigger to a friendly 409. */
export function featuredLimitError(error: unknown): HttpError | null {
  const pgError = error as { code?: string; constraint?: string };
  if (pgError?.code !== '23514' || !pgError.constraint?.endsWith('_featured_limit')) return null;
  const what = pgError.constraint.startsWith('products') ? 'products' : 'categories';
  return new HttpError(409, 'FEATURED_LIMIT', `You cannot feature more than ${FEATURED_LIMIT} ${what}. Remove another one to add this.`);
}

export function sendHttpError(reply: FastifyReply, error: HttpError) {
  return reply.code(error.statusCode).send({ error: error.code, message: error.message, ...error.extra });
}

export async function audit(client: PoolClient | Pool, actorId: string, action: string, resourceType: string, resourceId: string | null, metadata: Record<string, unknown> = {}) {
  await client.query(
    `INSERT INTO admin_audit_logs (actor_user_id, action, resource_type, resource_id, metadata)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [actorId, action, resourceType, resourceId, JSON.stringify(metadata)],
  );
}
