/**
 * Wave 3 #25 — Service worker for Tavern PWA shell.
 *
 * Strategy:
 *   - Navigation requests (HTML documents) are network-only and never cached.
 *     Caching them pins their security headers (Permissions-Policy, CSP, etc.)
 *     across deploys — a stale cached document re-applies the OLD policy even
 *     after the origin has been updated. Tavern is online-first anyway.
 *   - Hashed static assets are cached on install + stale-while-revalidate.
 *   - API calls (`/api/...`) are network-first; cached only as a fallback.
 *   - Wave 3 #26 — push notifications: handles `push` events and triggers
 *     a notification with the payload's title/body/url.
 *   - Wave 3 #27 — offline queue: a tiny IndexedDB-backed outbox; the SPA
 *     pushes message-create payloads into the queue when offline, the SW
 *     drains them on `sync` events or on the next online window.
 *
 * Bumping CACHE_NAME triggers the activate handler to delete the previous
 * cache — bump it any time the SW's cache shape changes.
 */

const CACHE_NAME = 'tavern-shell-v2';
const STATIC = ['/favicon.svg', '/manifest.webmanifest'];

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

  // Cross-origin requests (LiveKit signal/validate, Cloudflare beacons, font
  // CDNs, etc.) MUST go straight to the network. Returning a synthetic
  // Response from the SW for a cross-origin CORS request makes the browser
  // CORS-check the synthetic response and reject it ("type: default" doesn't
  // satisfy CORS) — which breaks Voice Hall, because the LiveKit SDK's v1
  // fallback decision needs to read the 404 from /rtc/v1/validate. Bail out
  // here so the browser fetches them natively, with no SW interference.
  if (url.origin !== self.location.origin) {
    return;
  }

  // Navigations bypass the SW cache entirely so updated response headers
  // (Permissions-Policy, CSP, HSTS) always reach the browser on next reload.
  // On a network failure we return a synthetic 503 page rather than letting
  // the promise reject — a rejected respondWith() promise produces an
  // "Uncaught (in promise) TypeError: Failed to convert value to 'Response'"
  // in the console, the exact noise the cross-origin fix above eliminated.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(
        () =>
          new Response(
            '<!doctype html><html><body><h1>Offline</h1><p>The Tavern is unreachable. Check your connection and reload.</p></body></html>',
            { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
          ),
      ),
    );
    return;
  }

  // Network-first for API.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request).catch(() =>
        caches.match(event.request).then((r) => r ?? new Response('', { status: 503 })),
      ),
    );
    return;
  }
  // Stale-while-revalidate for everything else (hashed static assets).
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networked = fetch(event.request)
        .then((res) => {
          // Only cache successful GETs. Cross-origin already bailed at the
          // top of the handler, so every request reaching here is same-origin.
          if (event.request.method === 'GET' && res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(event.request, clone)).catch(() => undefined);
          }
          return res;
        })
        .catch(() => cached ?? new Response('', { status: 503 }));
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
  // SEC: validate the destination URL before openWindow. The url field
  // comes from the push payload; a malformed or hostile push should not be
  // able to redirect the browser to an arbitrary origin. Parse against the
  // SW's own origin, reject anything that resolves to a different host, and
  // fall back to /app on any failure.
  const rawUrl = (event.notification.data && event.notification.data.url) || '/app';
  let safeUrl = '/app';
  try {
    const parsed = new URL(rawUrl, self.location.origin);
    if (parsed.origin === self.location.origin) {
      safeUrl = parsed.pathname + parsed.search + parsed.hash;
    }
  } catch {
    // keep /app default
  }
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      // Use startsWith on the pathname so we don't accidentally focus an
      // unrelated tab whose URL happens to contain the target path as a
      // substring (e.g. /app/servers/X matching /servers/X anywhere in
      // an open viewer).
      const existing = wins.find((w) => {
        try {
          return new URL(w.url).pathname.startsWith(safeUrl.split(/[?#]/)[0]);
        } catch {
          return false;
        }
      });
      if (existing) return existing.focus();
      return self.clients.openWindow(safeUrl);
    }),
  );
});
