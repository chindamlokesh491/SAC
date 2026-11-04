import { createApiClient } from '@sac/api-client';
import { API_URL } from './config';
import { secureStorage, TOKEN_KEY } from './storage';

let unauthorizedHandler: (() => void) | null = null;
export function onUnauthorized(handler: () => void) { unauthorizedHandler = handler; }

/** Mobile API client: bearer token from SecureStore; the API scopes every record to that user. */
export const api = createApiClient({
  baseUrl: API_URL,
  auth: { kind: 'bearer', getToken: () => secureStorage.get(TOKEN_KEY) },
  onUnauthorized: () => unauthorizedHandler?.(),
});
