// Sri Anantha Cart service worker.
// Only immutable Next.js build assets use cache-first. Public product/brand imagery
// is network-first so admin image replacements become visible without a stale PWA cache.
// HTML and every API request remain network-only: never cache private or live commerce data.
const STATIC_CACHE = 'sac-static-v2';
const OFFLINE_URL = '/offline.html';

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then(cache =>
      cache.addAll([OFFLINE_URL, '/brand/logo-full.webp', '/brand/lotus.png', '/icons/icon-192.png'])
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(key => key !== STATIC_CACHE).map(key => caches.delete(key)))
    )
  );
  self.clients.claim();
});

async function networkFirst(request) {
  const cache = await caches.open(STATIC_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') {
      await cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw new Error('Asset unavailable offline');
  }
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match(OFFLINE_URL)));
    return;
  }

  // Next.js build output is content-hashed and safe to retain until the next worker version.
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(
      caches.open(STATIC_CACHE).then(async cache => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) await cache.put(request, response.clone());
        return response;
      })
    );
    return;
  }

  // Public images can be replaced at the same URL; prefer the latest network response.
  if (
    url.pathname.startsWith('/media/') ||
    url.pathname.startsWith('/brand/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname.startsWith('/images/')
  ) {
    event.respondWith(networkFirst(request).catch(() => new Response('', { status: 503 })));
  }
});
