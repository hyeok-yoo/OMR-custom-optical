/* 서비스 워커 — 앱 셸 오프라인 캐시, 폰트 캐시, 공유 대상(share target) */
const VERSION = 'omr-v2.0.0';
const ASSETS = [
  './', 'index.html', 'css/app.css',
  'js/omr-engine.js', 'js/worker.js', 'js/store.js', 'js/grading.js', 'js/gemini.js',
  'js/ui.js', 'js/camera.js', 'js/keys.js', 'js/history.js', 'js/app.js',
  'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png'
];
const FONT_HOSTS = ['cdn.jsdelivr.net'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== 'omr-fonts' && k !== 'omr-share').map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  // 갤러리 '공유'로 받은 사진
  if (req.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith((async () => {
      try {
        const form = await req.formData();
        const file = form.get('image');
        if (file) { const c = await caches.open('omr-share'); await c.put('shared-image', new Response(file)); }
      } catch (err) { /* 무시 */ }
      return Response.redirect('./?shared=1', 303);
    })());
    return;
  }
  if (req.method !== 'GET') return;
  // 글꼴: 캐시 우선
  if (FONT_HOSTS.includes(url.host)) {
    e.respondWith(caches.open('omr-fonts').then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      try { const res = await fetch(req); if (res.ok || res.type === 'opaque') c.put(req, res.clone()); return res; }
      catch (err) { return hit || Response.error(); }
    }));
    return;
  }
  if (url.origin !== self.location.origin) return; // Gemini API 등은 그대로
  // 앱 파일: 네트워크 우선(최신), 실패하면 캐시
  e.respondWith(fetch(req).then(res => {
    if (res && res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('index.html'))));
});
