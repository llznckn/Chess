/* Service Worker:离线可玩 + 秒开缓存
 * 只在 https / localhost 环境生效;file:// 打开时不会注册。 */
const CACHE = 'chess-v1';
const CORE = [
  './',
  './index.html',
  './css/style.css',
  './js/chess.js',
  './js/ai.js',
  './js/ai-worker.js',
  './js/ui.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon.svg'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(CORE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || req.url.startsWith('chrome-extension:')) return;
  // 同源静态资源:缓存优先,网络未命中再回退
  e.respondWith(
    caches.match(req).then(hit =>
      hit || fetch(req).then(res => {
        if (res && res.ok && req.url.startsWith(self.location.origin)) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => caches.match('./index.html'))
    )
  );
});
