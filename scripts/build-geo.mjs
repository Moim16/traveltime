// Prepara los mapas estaticos que sirve la app:
//
//   geo/world.json              paises (Natural Earth 1:50m), con nombre en espanol
//   geo/countries.json          que paises tienen divisiones, cuantas y como se llaman
//   geo/<ISO>/adm1.json         primer nivel (departamentos, regiones, estados...)
//   geo/<ISO>/c/<adm1>.json     las "ciudades" de UN departamento
//   geo/search.json             solo nombres, para buscar sin bajar poligonos
//
// Las ciudades van partidas por departamento porque Brasil tiene 5.570
// municipios y Espana 8.205: al abrir un departamento se baja solo lo suyo.
//
// Los limites salen de geoBoundaries (licencia abierta, version simplificada).
// Las ciudades no traen a que departamento pertenecen: se cruzan por la mayor
// superficie compartida.
//
//   node scripts/build-geo.mjs            todo el mundo
//   node scripts/build-geo.mjs NIC CRI    solo esos paises (el resto no se toca)

import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import mapshaper from 'mapshaper';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GEO = join(ROOT, 'geo');
const CACHE = join(ROOT, '.geo-cache');
const PARALLEL = 4;

// El nivel de geoBoundaries que es la "ciudad" cambia por pais: en Nicaragua el
// municipio es ADM2, pero en Chile ADM2 son provincias y la comuna es ADM3.
// Sin entrada aqui: ADM1 y ADM2, con nombres genericos.
// names: correcciones a mano de lo que viene mal escrito o en ingles en la fuente.
const COUNTRIES = {
  NIC: {
    labels: ['Departamento', 'Municipio'],
    names: {
      Leon: 'León',
      'Rio San Juan': 'Río San Juan',
      'North Carribean Coast Autonomous Region': 'Costa Caribe Norte',
      'South Atlantic Autonomous Region': 'Costa Caribe Sur',
      'Ciudad Darco': 'Ciudad Darío',
      'San Nicolas': 'San Nicolás',
      'San Ramon': 'San Ramón',
      Sebaco: 'Sébaco',
      'Desembocadura de Cruz Río Grande': 'Desembocadura de la Cruz de Río Grande',
    },
  },
  CRI: { labels: ['Provincia', 'Cantón'] },
  HND: { labels: ['Departamento', 'Municipio'] },
  SLV: { labels: ['Departamento', 'Municipio'] },
  GTM: { labels: ['Departamento', 'Municipio'] },
  PAN: { labels: ['Provincia', 'Distrito'] },
  MEX: { labels: ['Estado', 'Municipio'] },
  COL: { labels: ['Departamento', 'Municipio'] },
  VEN: { labels: ['Estado', 'Municipio'] },
  ECU: { labels: ['Provincia', 'Cantón'] },
  PER: { labels: ['Región', 'Provincia'] },
  BOL: { labels: ['Departamento', 'Provincia'] },
  CHL: { city: 'ADM3', labels: ['Región', 'Comuna'] },
  ARG: { labels: ['Provincia', 'Departamento'] },
  URY: { labels: ['Departamento', 'Municipio'] },
  PRY: { labels: ['Departamento', 'Distrito'] },
  BRA: {
    labels: ['Estado', 'Municipio'],
    names: {
      'Rio Granda do Norte': 'Rio Grande do Norte',
      'Rio de Jeneiro': 'Rio de Janeiro',
      'Sao Paulo': 'São Paulo',
      Para: 'Pará',
      Amapa: 'Amapá',
      Maranhao: 'Maranhão',
      Ceara: 'Ceará',
      Paraiba: 'Paraíba',
      Piaui: 'Piauí',
      Rondonia: 'Rondônia',
      Goias: 'Goiás',
      'Espirito Santo': 'Espírito Santo',
      Parana: 'Paraná',
    },
  },
  DOM: { labels: ['Provincia', 'Municipio'] },
  CUB: { labels: ['Provincia', 'Municipio'] },
  ESP: { city: 'ADM3', labels: ['Comunidad', 'Municipio'] },
  USA: { labels: ['Estado', 'Condado'] },
  CAN: { labels: ['Provincia', 'División'] },
  FRA: { labels: ['Región', 'Departamento'] },
  ITA: { adm1: 'ADM2', city: 'ADM3', labels: ['Región', 'Provincia'] },
  DEU: { labels: ['Estado', 'Distrito'] },
  PRT: { labels: ['Distrito', 'Municipio'] },
};
const DEFAULT_LABELS = ['Región', 'Ciudad'];

// geoBoundaries y Natural Earth no siempre usan el mismo codigo.
const ISO_ALIAS = { XKX: 'KOS' };

const WORLD_URL =
  'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson';

// Sobre la version ya simplificada de geoBoundaries, cuanto mas se conserva.
const SIMPLIFY = { world: '12%', adm1: '35%', city: '35%' };

// "El Viejo (Municipio)", "Municipio de Jinotega", "Matagalpa (Departemento)": la
// fuente mezcla el tipo de division con el nombre, y a veces con faltas.
const KIND = '(?:municipio|muncipio|departamento|departemento|provincia|region|región|comuna|canton|cantón)';
function cleanName(raw, fixes) {
  const name = String(raw ?? '')
    .replace(new RegExp(`\\s*\\(${KIND}\\)\\s*$`, 'i'), '')
    .replace(new RegExp(`^${KIND}\\s+(?:de\\s+)?`, 'i'), '')
    .trim();
  return fixes[name] ?? name;
}

// El id es el nombre, no el shapeID de geoBoundaries: ese cambia entre versiones
// y con el se perderian las visitas guardadas al actualizar los mapas.
const slug = (s) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x';

// Dos divisiones con el mismo nombre dentro del mismo padre: la segunda lleva -2.
function uniqueId(base, seen) {
  let id = base;
  for (let n = 2; seen.has(id); n++) id = `${base}-${n}`;
  seen.add(id);
  return id;
}

async function download(url, name) {
  const file = join(CACHE, name);
  if (existsSync(file)) return file;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} al bajar ${url}`);
      await writeFile(file, Buffer.from(await res.arrayBuffer()));
      return file;
    } catch (e) {
      if (attempt === 3) throw e;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

async function catalog(level) {
  const file = await download(`https://www.geoboundaries.org/api/current/gbOpen/ALL/${level}/`, `catalog-${level}.json`);
  return Object.fromEntries(JSON.parse(await readFile(file, 'utf8')).map((r) => [r.boundaryISO, r]));
}

const run = (cmd) => mapshaper.runCommands(cmd);

async function readFeatures(file) {
  return JSON.parse(await readFile(file, 'utf8')).features;
}

async function buildWorld() {
  console.log('Mundo');
  const src = await download(WORLD_URL, 'world.geojson');
  // ISO_A3 viene como -99 para Francia y Noruega; ADM0_A3 siempre esta.
  await run(
    `-i "${src}" ` +
      `-each "iso = ISO_A3 !== '-99' ? ISO_A3 : ADM0_A3, name = NAME_ES || NAME" ` +
      `-filter "iso !== 'ATA'" ` +
      `-filter-fields iso,name ` +
      `-simplify ${SIMPLIFY.world} keep-shapes ` +
      `-o "${join(GEO, 'world.json')}" format=geojson precision=0.001`,
  );
}

// El punto mas adentro de cada poligono, para poner el nombre (el centroide de
// una forma de media luna cae afuera). Va en las propiedades: lx, ly.
async function withLabelPoints(file) {
  const pts = join(CACHE, `pts-${Math.random().toString(36).slice(2)}.json`);
  await run(`-i "${file}" -points inner -o "${pts}" format=geojson precision=0.0001`);
  const at = new Map((await readFeatures(pts)).map((f) => [f.properties.gbid, f.geometry?.coordinates]));
  await rm(pts, { force: true });
  return at;
}

async function buildCountry(src, cfg, cat) {
  const iso = ISO_ALIAS[src] ?? src;
  const fixes = cfg.names ?? {};
  const l1 = cfg.adm1 ?? 'ADM1';
  const lc = cfg.city ?? 'ADM2';
  const dir = join(GEO, iso);
  await rm(dir, { recursive: true, force: true });
  await mkdir(join(dir, 'c'), { recursive: true });

  const adm1Src = await download(cat[l1][src].simplifiedGeometryGeoJSON, `${src}-${l1}.geojson`);
  const adm1Tmp = join(CACHE, `${src}-adm1-out.json`);
  await run(
    `-i "${adm1Src}" -each "gbid = shapeID, name = shapeName" -filter-fields gbid,name ` +
      `-simplify ${SIMPLIFY.adm1} keep-shapes -o "${adm1Tmp}" format=geojson precision=0.0001`,
  );
  const adm1 = await readFeatures(adm1Tmp);
  const adm1Label = await withLabelPoints(adm1Tmp);
  const seen1 = new Set();
  const adm1Id = new Map();
  for (const f of adm1) {
    const name = cleanName(f.properties.name, fixes);
    const id = uniqueId(`${iso}.${slug(name)}`, seen1);
    adm1Id.set(f.properties.gbid, id);
    const [lx, ly] = adm1Label.get(f.properties.gbid) ?? [null, null];
    f.properties = { id, name, lx, ly, cities: 0 };
  }

  const byParent = new Map();
  let cityCount = 0;
  const cityRow = cat[lc]?.[src];
  if (cityRow) {
    const citySrc = await download(cityRow.simplifiedGeometryGeoJSON, `${src}-${lc}.geojson`);
    const cityTmp = join(CACHE, `${src}-city-out.json`);
    // largest-overlap y no point-method: un municipio costero puede tener su punto
    // interior en una isla que el departamento simplificado ya no tiene.
    await run(
      `-i "${citySrc}" -each "gbid = shapeID, name = shapeName" -filter-fields gbid,name ` +
        `-join "${adm1Tmp}" largest-overlap fields=gbid prefix=p_ ` +
        `-simplify ${SIMPLIFY.city} keep-shapes -o "${cityTmp}" format=geojson precision=0.0001`,
    );
    const cityLabel = await withLabelPoints(cityTmp);
    const seen = new Set();
    for (const f of await readFeatures(cityTmp)) {
      if (!f.geometry) continue;
      const parent = adm1Id.get(f.properties.p_gbid);
      if (!parent) continue; // cae fuera de todo departamento: islas lejanas, aguas
      const name = cleanName(f.properties.name, fixes);
      const id = uniqueId(`${parent}.${slug(name)}`, seen);
      const [lx, ly] = cityLabel.get(f.properties.gbid) ?? [null, null];
      f.properties = { id, name, parent, lx, ly };
      if (!byParent.has(parent)) byParent.set(parent, []);
      byParent.get(parent).push(f);
      cityCount++;
    }
  }

  for (const f of adm1) {
    const list = byParent.get(f.properties.id) ?? [];
    f.properties.cities = list.length;
    if (list.length) {
      await writeFile(
        join(dir, 'c', `${f.properties.id.split('.')[1]}.json`),
        JSON.stringify({ type: 'FeatureCollection', features: list }),
      );
    }
  }
  await writeFile(join(dir, 'adm1.json'), JSON.stringify({ type: 'FeatureCollection', features: adm1 }));

  const search = [
    ...adm1.map((f) => [f.properties.id, f.properties.name]),
    ...[...byParent.values()].flat().map((f) => [f.properties.id, f.properties.name]),
  ];
  return {
    iso,
    info: { labels: cfg.labels ?? DEFAULT_LABELS, adm1: adm1.length, cities: cityCount },
    search,
  };
}

async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const item = items[i++];
        try {
          out.push(await fn(item));
        } catch (e) {
          console.warn(`  ${item}: ${e.message}`);
        }
      }
    }),
  );
  return out;
}

await mkdir(CACHE, { recursive: true });
await mkdir(GEO, { recursive: true });

const only = process.argv.slice(2).map((s) => s.toUpperCase());
if (!only.length) await buildWorld();

const cat = { ADM1: await catalog('ADM1'), ADM2: await catalog('ADM2'), ADM3: await catalog('ADM3') };
const todo = Object.keys(cat.ADM1).filter((iso) => !only.length || only.includes(ISO_ALIAS[iso] ?? iso)).sort();

const indexFile = join(GEO, 'countries.json');
const searchFile = join(GEO, 'search.json');
const index = existsSync(indexFile) && only.length ? JSON.parse(await readFile(indexFile, 'utf8')) : {};
const search = existsSync(searchFile) && only.length ? JSON.parse(await readFile(searchFile, 'utf8')) : {};

let done = 0;
const built = await pool(todo, PARALLEL, async (src) => {
  const r = await buildCountry(src, COUNTRIES[ISO_ALIAS[src] ?? src] ?? {}, cat);
  console.log(`${++done}/${todo.length} ${r.iso}: ${r.info.adm1} + ${r.info.cities}`);
  return r;
});
for (const r of built) {
  index[r.iso] = r.info;
  search[r.iso] = r.search;
}
const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
await writeFile(indexFile, JSON.stringify(sorted(index), null, 1) + '\n');
await writeFile(searchFile, JSON.stringify(sorted(search)));
// Los mapas se cachean un dia: la app pide todo con ?v=<esto>, asi que al
// regenerar cualquier pais el navegador vuelve a bajar lo nuevo.
await writeFile(join(GEO, 'version.json'), JSON.stringify({ v: Date.now().toString(36) }) + '\n');
console.log('Listo');
