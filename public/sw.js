// Çevrimdışı çalışma + telefondan "Paylaş → STLOgi" ile dosya alma.
// Yollar göreli: uygulama kökte de alt klasörde de çalışır (ROOT = servis çalışanının kapsamı).
const CACHE = 'stlogi-v7';
const SHARE = 'stlogi-share';
const ROOT = self.registration.scope;

self.addEventListener('install', (e) => {
  // Sayfayı ve sayfanın kullandığı tüm dosyaları (JS, CSS, ikonlar) önceden önbelleğe al
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    const res = await fetch(ROOT, { cache: 'reload' });
    const html = await res.clone().text();
    await c.put(ROOT, res);
    const urls = [...html.matchAll(/(?:src|href)="(\.?\/?[^"#:]+)"/g)].map((m) => new URL(m[1], ROOT).href);
    const extra = ['icon-192.png', 'icon-512.png', 'manifest.webmanifest'].map((p) => new URL(p, ROOT).href);
    await c.addAll([...new Set([...urls, ...extra])]);
  })());
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== SHARE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // Telefondan Paylaş → STLOgi: dosyaları geçici olarak sakla, sayfaya yönlendir (sayfa okuyup açar)
  if (req.method === 'POST' && url.href === new URL('share-target', ROOT).href) {
    e.respondWith((async () => {
      try {
        const form = await req.formData();
        const files = form.getAll('files').filter((f) => typeof f !== 'string');
        const c = await caches.open(SHARE);
        for (const k of await c.keys()) await c.delete(k);
        let i = 0;
        for (const f of files) {
          await c.put(new URL(`shared/${i++}/${encodeURIComponent(f.name || 'model.stl')}`, ROOT).href, new Response(f));
        }
        return Response.redirect(`${ROOT}?shared=${i}`, 303);
      } catch (err) {
        return Response.redirect(ROOT, 303);
      }
    })());
    return;
  }

  if (req.method !== 'GET') return;

  // Sayfa: önce ağ (güncel sürüm), olmazsa önbellek
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(ROOT, copy)); } return res; })
        .catch(() => caches.match(ROOT, { ignoreSearch: true }))
    );
    return;
  }

  // Diğer dosyalar (adları içerikle değişir): önce önbellek
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }))
  );
});
