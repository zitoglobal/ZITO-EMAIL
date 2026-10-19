/* ZITO Mail service worker — 缓存壳 + Web Push */
const CACHE = 'zm-shell-v3';
const SHELL = ['/', '/manifest.webmanifest', '/favicon-180.png', '/zito-icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('message', (event) => {
  if (event?.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  // 导航：网络优先，失败回退壳
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('/', copy));
          return res;
        })
        .catch(() => caches.match('/') || caches.match(req))
    );
    return;
  }
  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok && (url.pathname.startsWith('/assets/') || url.pathname.endsWith('.png') || url.pathname.endsWith('.svg'))) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    }))
  );
});

self.addEventListener('push', (event) => {
  let data = { title: 'ZITO 智能邮箱', body: '你有新的邮件动态', url: '/' };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {
    try {
      data.body = event.data.text();
    } catch {
      /* default */
    }
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'ZITO 智能邮箱', {
      body: data.body || '',
      icon: '/favicon-180.png',
      badge: '/favicon-180.png',
      tag: data.tag || 'zm-push',
      data: { url: data.url || '/' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const raw = event.notification.data?.url || '/';
  const url = new URL(raw, self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clientList) => {
      for (const c of clientList) {
        if (c.url.startsWith(self.location.origin) && 'focus' in c) {
          await c.focus();
          try {
            c.postMessage({ type: 'zm-open', url });
          } catch {
            /* ignore */
          }
          if (typeof c.navigate === 'function') {
            try {
              await c.navigate(url);
            } catch {
              /* postMessage 已足够 */
            }
          }
          return;
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
