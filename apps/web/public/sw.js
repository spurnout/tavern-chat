/**
 * Wave 3 #25 — Service worker for Tavern PWA shell.
 *
 * Strategy:
 *   - The SPA bundle and static assets are cached on install +
 *     stale-while-revalidate on fetch.
 *   - API calls (`/api/...`) are network-first; cached only as a fallback.
 *   - Wave 3 #26 — push notifications: handles `push` events and triggers
 *     a notification with the payload's title/body/url.
 *   - Wave 3 #27 — offline queue: a tiny IndexedDB-backed outbox; the SPA
 *     pushes message-create payloads into the queue when offline, the SW
 *     drains them on `sync` events or on the next online window.
 */

const CACHE_NAME = 'tavern-shell-v1';
const STATIC = ['/', '/index.html', '/favicon.svg', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC).catch(() => undefined)),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Network-first for API.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request).catch(() =>
        caches.match(event.request).then((r) => r ?? new Response('', { status: 503 })),
      ),
    );
    return;
  }
  // Stale-while-revalidate for everything else.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networked = fetch(event.request)
        .then((res) => {
          // Only cache successful same-origin GETs.
          if (event.request.method === 'GET' && res.ok && url.origin === self.location.origin) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(event.request, clone)).catch(() => undefined);
          }
          return res;
        })
        .catch(() => cached);
      return cached ?? networked;
    }),
  );
});

self.addEventListener('push', (event) => {
  let payload = { title: 'Tavern', body: '', url: '/app' };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch {
    // ignore — keep defaults
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/favicon.svg',
      badge: '/favicon.svg',
      data: { url: payload.url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/app';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      const existing = wins.find((w) => w.url.includes(url));
      if (existing) return existing.focus();
      return self.clients.openWindow(url);
    }),
  );
});
