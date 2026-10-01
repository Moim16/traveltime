// Los mapas estaticos de /geo y las cuentas que salen de ellos.
// Ids: pais = "NIC", departamento = "NIC.granada", municipio = "NIC.granada.granada".
// Un id es prefijo de todo lo que tiene adentro: eso hace que "visitaste algo
// de Nicaragua" sea comparar prefijos, sin guardar el arbol aparte.

import { GEO_BASE, GEO_REMOTE } from './config.js';

// version.json no se cachea (se revalida siempre) y cambia cada vez que se
// regeneran los mapas. Sin esto, un pais regenerado seguia saliendo con el
// archivo viejo que el navegador tenia guardado.
//   - En S3 la version es una carpeta: <base>/<v>/NIC/adm1.json, con cache de un año.
//   - En local va en la query: /geo/NIC/adm1.json?v=<v>.
// Sin señal se usa la ultima version conocida: es la que el service worker
// tiene guardada (sw.js), y con ella el mapa ya visto se puede abrir offline.
const VKEY = 'tt.geoVersion';
const lastVersion = () => {
  try {
    return localStorage.getItem(VKEY) || '0';
  } catch {
    return '0';
  }
};
const version = fetch(`${GEO_BASE}/version.json`, { cache: 'no-cache' })
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
  .then((j) => {
    try {
      localStorage.setItem(VKEY, j.v);
    } catch {}
    return j.v;
  })
  .catch(lastVersion);

const urlOf = (path, v) => (GEO_REMOTE ? `${GEO_BASE}/${v}/${path}` : `${GEO_BASE}/${path}?v=${v}`);

const cache = new Map();
async function getJson(path) {
  if (!cache.has(path)) {
    cache.set(path, version.then((v) => fetch(urlOf(path, v))).then((r) => {
      if (!r.ok) throw new Error(`${r.status} ${path}`);
      return r.json();
    }));
  }
  return cache.get(path);
}

export const world = () => getJson('world.json');
export const countries = () => getJson('countries.json');
export const searchIndex = () => getJson('search.json');

// El pais trae solo su primer nivel; las ciudades se bajan por departamento,
// porque Brasil tiene 5.570 municipios y Espana 8.205.
export const country = (iso) => getJson(`${iso}/adm1.json`);
export const cities = (adm1Id) => {
  const [iso, slug] = adm1Id.split('.');
  return getJson(`${iso}/c/${slug}.json`);
};

// Donde va el nombre de cada division: el build guarda en lx/ly el punto mas
// adentro del poligono.
export function labelPoints(features, level) {
  return features
    .filter((f) => f.properties.lx != null)
    .map((f) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [f.properties.lx, f.properties.ly] },
      properties: { id: f.properties.id, name: f.properties.name, parent: f.properties.parent ?? null, level },
    }));
}

export const isoOf = (id) => id.split('.')[0];
export const depth = (id) => id.split('.').length - 1; // 0 pais, 1 adm1, 2 municipio
export const inside = (id, area) => id === area || id.startsWith(area + '.');

// Caja [[oeste, sur], [este, norte]] de un conjunto de features. Rusia o Fiji
// cruzan el antimeridiano y su caja daria la vuelta al mundo: en ese caso se usa
// la del poligono mas grande, que es donde uno espera aterrizar.
export function bbox(features) {
  const boxes = [];
  for (const f of features) {
    const g = f.geometry;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    for (const p of polys) {
      let w = 180, s = 90, e = -180, n = -90;
      for (const [x, y] of p[0]) {
        if (x < w) w = x; if (x > e) e = x;
        if (y < s) s = y; if (y > n) n = y;
      }
      boxes.push([w, s, e, n]);
    }
  }
  const all = boxes.reduce((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]);
  if (all[2] - all[0] <= 180) return [[all[0], all[1]], [all[2], all[3]]];
  const area = (b) => (b[2] - b[0]) * (b[3] - b[1]);
  const big = boxes.reduce((a, b) => (area(b) > area(a) ? b : a));
  return [[big[0], big[1]], [big[2], big[3]]];
}

// Un punto para ubicar un lugar en el mapa (la ruta de un viaje): el de su
// nombre en las ciudades y departamentos, el centro de su caja en los paises.
// [lng, lat] o null si el mapa ya no tiene ese id.
export async function placePoint(placeId) {
  const parts = placeId.split('.');
  try {
    if (parts.length >= 2) {
      const fc = parts.length === 3 ? await cities(parts.slice(0, 2).join('.')) : await country(parts[0]);
      const f = fc.features.find((x) => x.properties.id === placeId);
      if (f?.properties.lx != null) return [f.properties.lx, f.properties.ly];
    }
    const w = (await world()).features.filter((x) => x.properties.iso === parts[0]);
    if (!w.length) return null;
    const [[a, b], [c, d]] = bbox(w);
    return [(a + c) / 2, (b + d) / 2];
  } catch {
    return null;
  }
}

// "Granada" y "granada" y "Grānada" son lo mismo para quien busca.
export const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
