// Service worker: que la app abra rapido y, sin señal, siga mostrando lo que ya
// se vio (el mapa, los paises y departamentos abiertos alguna vez).
//
//   - El cascaron (HTML, JS, CSS, vendor, iconos): primero la red, y si no hay,
//     lo guardado. Asi un cambio publicado se ve al recargar.
//   - Los mapas de CloudFront: primero lo guardado. Van en carpetas por version
//     y nunca cambian; una version nueva es otra URL.
//   - Los mosaicos del mapa de fondo (OpenFreeMap): primero lo guardado, con un
//     tope de MAX_TILES para no llenar el telefono.
//   - /api, las fotos (URL firmadas que vencen) y lo demas: siempre de la red.
//     Los datos de la cuenta no se guardan en el telefono.

const SHELL_CACHE = 'tt-shell-v1';
const GEO_CACHE = 'tt-geo-v1';
const TILE_CACHE = 'tt-tiles-v1';
const MAX_TILES = 3000;
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];
const KEEP = [SHELL_CACHE, GEO_CACHE, TILE_CACHE];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !KEEP.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(req, name = SHELL_CACHE) {
  const cache = await caches.open(name);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch {
    // Sin señal: lo guardado, y si es una navegacion que no estaba, la app (el index).
    return (await cache.match(req)) ?? (req.mode === 'navigate' ? cache.match('/index.html') : Response.error());
  }
}

async function cacheFirst(req, name, max) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) {
    await cache.put(req, res.clone()).catch(() => {});
    if (max) trim(cache, max);
  }
  return res;
}

// Los mas viejos primero: cache.keys() devuelve en orden de insercion.
let trimming = false;
async function trim(cache, max) {
  if (trimming) return;
  trimming = true;
  try {
    const keys = await cache.keys();
    for (const k of keys.slice(0, Math.max(0, keys.length - max))) await cache.delete(k);
  } finally {
    trimming = false;
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === location.origin) {
    if (url.pathname.startsWith('/api/')) return; // datos: siempre de la red
    // geo/ local (en desarrollo) va con ?v=: igual que CloudFront, nunca cambia.
    if (url.pathname.startsWith('/geo/') && url.searchParams.has('v')) return e.respondWith(cacheFirst(req, GEO_CACHE));
    if (url.pathname === '/geo/version.json') return; // siempre preguntar
    return e.respondWith(networkFirst(req));
  }
  if (url.hostname.endsWith('.cloudfront.net')) {
    if (url.pathname.endsWith('/version.json')) return; // siempre preguntar
    return e.respondWith(cacheFirst(req, GEO_CACHE));
  }
  if (url.hostname === 'tiles.openfreemap.org') {
    // Los mosaicos (.pbf) y las fuentes/iconos no cambian. El estilo y el TileJSON
    // si: apuntan a la edicion del dia del planeta, y guardarlos para siempre
    // dejaria el mapa pidiendo una edicion que ya no existe.
    if (/\.(pbf|png|json)$/.test(url.pathname) && !url.pathname.startsWith('/styles/')) {
      return e.respondWith(cacheFirst(req, TILE_CACHE, MAX_TILES));
    }
    return e.respondWith(networkFirst(req, TILE_CACHE));
  }
});
