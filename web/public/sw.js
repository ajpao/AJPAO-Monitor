/* AJPAO-Monitor service worker — เปิดให้ติดตั้งเป็น PWA + ใช้งานออฟไลน์ได้บางส่วน
 * กลยุทธ์:
 *   • HTML / app.js  → network-first (เห็นอัปเดตเสมอ) แล้ว fallback cache ตอนเน็ตหลุด
 *   • icons / manifest → cache-first
 *   • /api, /ws และ cross-origin (cdn/fonts/firestore) → ไม่แตะ ปล่อยไปเน็ตปกติ (ข้อมูลต้องสด)
 * เพิ่มเลข VER ทุกครั้งที่อยากบังคับล้าง cache เก่า
 */
const VER = 'ajpao-v2';
const SHELL = [
  './', './index.html', './app.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png',
  './icons/apple-touch-icon.png', './favicon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(VER)
      .then(c => Promise.allSettled(SHELL.map(u => c.add(u))))  // ไฟล์ไหนพลาดก็ไม่ล้มทั้งชุด
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== VER).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;                       // cross-origin: ปล่อยผ่าน
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/ws')) return;  // ข้อมูลสด: ไม่แตะ

  const isShell = req.mode === 'navigate'
    || url.pathname === '/' || url.pathname.endsWith('.html') || url.pathname.endsWith('.js');

  if (isShell) {
    // network-first
    e.respondWith(
      fetch(req)
        .then(res => { const cp = res.clone(); caches.open(VER).then(c => c.put(req, cp)); return res; })
        .catch(() => caches.match(req).then(m => m || caches.match('./index.html')))
    );
    return;
  }

  // อื่น ๆ (icons/manifest/รูป) → cache-first
  e.respondWith(
    caches.match(req).then(m => m || fetch(req).then(res => {
      const cp = res.clone(); caches.open(VER).then(c => c.put(req, cp)); return res;
    }))
  );
});
