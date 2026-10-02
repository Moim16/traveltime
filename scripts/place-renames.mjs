// Que id nuevo le toca a cada lugar cuando cambian los mapas (un nombre
// corregido, comunas que se fundieron en una ciudad, un departamento que ya no
// se parte). Compara dos carpetas geo/ y escribe { idViejo: idNuevo } solo con
// lo que cambio. Despues, scripts/migrate-place-ids.mjs lo aplica a la base.
//
//   node scripts/place-renames.mjs <geo-viejo> [geo-nuevo=geo] > renames.json
//
// El cruce es por ubicacion, no por nombre: el punto del nombre del lugar viejo
// (lx, ly) ¿dentro de que lugar nuevo cae? Asi "Providencia" -> "Santiago".

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const [, , oldDir, newDir = 'geo'] = process.argv;
if (!oldDir) {
  console.error('Uso: node scripts/place-renames.mjs <geo-viejo> [geo-nuevo]');
  process.exit(1);
}
const read = (f) => JSON.parse(readFileSync(f, 'utf8'));

const polys = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates);
function inRing(r, x, y) {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i];
    const [xj, yj] = r[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
const contains = (f, x, y) => f.geometry && polys(f.geometry).some((p) => inRing(p[0], x, y) && !p.slice(1).some((h) => inRing(h, x, y)));

const citiesOf = (dir, adm1Id) => {
  const f = join(dir, adm1Id.split('.')[0], 'c', `${adm1Id.split('.')[1]}.json`);
  return existsSync(f) ? read(f).features : [];
};

const out = {};
for (const iso of readdirSync(oldDir)) {
  const oldAdm1File = join(oldDir, iso, 'adm1.json');
  const newAdm1File = join(newDir, iso, 'adm1.json');
  if (!existsSync(oldAdm1File) || !existsSync(newAdm1File)) continue;
  const newAdm1 = read(newAdm1File).features;
  for (const a of read(oldAdm1File).features) {
    const { id, lx, ly } = a.properties;
    const na = newAdm1.find((n) => n.properties.id === id) ?? (lx != null && newAdm1.find((n) => contains(n, lx, ly)));
    if (!na) continue;
    if (na.properties.id !== id) out[id] = na.properties.id;
    const newCities = citiesOf(newDir, na.properties.id);
    for (const c of citiesOf(oldDir, id)) {
      const p = c.properties;
      // Departamento que ya no se parte: la ciudad pasa a ser el departamento.
      const nc = newCities.length === 0 ? na : newCities.find((n) => n.properties.id === p.id) ?? (p.lx != null && newCities.find((n) => contains(n, p.lx, p.ly)));
      if (nc && nc.properties.id !== p.id) out[p.id] = nc.properties.id;
    }
  }
}
console.log(JSON.stringify(out, null, 1));
