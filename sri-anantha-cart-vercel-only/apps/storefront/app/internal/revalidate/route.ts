import { timingSafeEqual } from 'node:crypto';
import { revalidateTag } from 'next/cache';
import { CATALOG_TAG } from '@/lib/server-api';

// Called by the background worker after admin catalogue changes, so the storefront shows them at once
// instead of after the 60-second cache window. Server-to-server only: requires REVALIDATE_TOKEN.
const TOKEN = process.env.REVALIDATE_TOKEN ?? '';

function authorised(header: string | null): boolean {
  if (TOKEN.length < 32 || !header) return false;
  const given = Buffer.from(header);
  const expected = Buffer.from(TOKEN);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function POST(request: Request) {
  if (!authorised(request.headers.get('x-revalidate-token'))) return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  revalidateTag(CATALOG_TAG);
  return Response.json({ revalidated: [CATALOG_TAG] }, { headers: { 'cache-control': 'no-store' } });
}
