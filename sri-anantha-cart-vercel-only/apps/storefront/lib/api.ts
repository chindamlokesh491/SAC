'use client';
import { createApiClient } from '@sac/api-client';

/** Browser API client: same-origin requests through the Next.js rewrite, HttpOnly session cookie + CSRF header. */
export const api = createApiClient({ baseUrl: '', auth: { kind: 'cookie' } });
