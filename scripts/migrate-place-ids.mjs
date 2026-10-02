// Aplica a la base los ids de lugar que cambiaron con los mapas (la salida de
// scripts/place-renames.mjs): lo marcado, las visitas y "Quiero ir". El nombre
// del lugar que guardan las visitas y los deseos se rehace con los mapas nuevos.
//
//   node --env-file=.env scripts/migrate-place-ids.mjs renames.json            solo muestra
//   node --env-file=.env scripts/migrate-place-ids.mjs renames.json --apply    escribe
//
// Dos marcas que pasan a ser el mismo lugar (Providencia y Santiago -> Santiago)
// quedan en una: la clave de marks es (usuario, lugar).

import { readFileSync } from 'node:fs';
import { createClient } from '@libsql/client';

const [, , file, flag] = process.argv;
if (!file) {
  console.error('Uso: node --env-file=.env scripts/migrate-place-ids.mjs renames.json [--apply]');
  process.exit(1);
}
const apply = flag === '--apply';
const renames = JSON.parse(readFileSync(file, 'utf8'));
const db = createClient({ url: process.env.TURSO_DATABASE_URL ?? 'file:./data/traveltime.db', authToken: process.env.TURSO_AUTH_TOKEN });

// Los nombres de los mapas nuevos, para rehacer "Santiago, Metropolitana de Santiago, Chile".
const names = new Map();
for (const rows of Object.values(JSON.parse(readFileSync('geo/search.json', 'utf8')))) for (const [id, n] of rows) names.set(id, n);
for (const f of JSON.parse(readFileSync('geo/world.json', 'utf8')).features) names.set(f.properties.iso, f.properties.name);
const placeName = (id) => {
  const p = id.split('.');
  return p.map((_, i) => names.get(p.slice(0, i + 1).join('.'))).reverse().filter(Boolean).join(', ');
};

const used = (await db.execute('SELECT placeId FROM marks UNION SELECT placeId FROM visits UNION SELECT placeId FROM wishes')).rows.map((r) => r.placeId);
const todo = used.filter((id) => renames[id]);
if (!todo.length) {
  console.log('Nada que cambiar: ningun lugar guardado cambio de id.');
  process.exit(0);
}
for (const id of todo) console.log(`${id}\n  -> ${renames[id]}  (${placeName(renames[id])})`);

const stmts = [];
for (const id of todo) {
  const to = renames[id];
  stmts.push(
    { sql: 'UPDATE OR IGNORE marks SET placeId = ? WHERE placeId = ?', args: [to, id] },
    // Las que no se movieron chocaban con una marca que ya estaba en el lugar nuevo.
    { sql: 'DELETE FROM marks WHERE placeId = ?', args: [id] },
    { sql: 'UPDATE visits SET placeId = ?, placeName = ? WHERE placeId = ?', args: [to, placeName(to), id] },
    { sql: 'UPDATE wishes SET placeId = ?, placeName = ? WHERE placeId = ?', args: [to, placeName(to), id] },
  );
}
if (!apply) {
  console.log(`\n${todo.length} lugares, ${stmts.length} sentencias. Nada escrito: agrega --apply para aplicarlo.`);
  process.exit(0);
}
await db.batch(stmts, 'write');
console.log(`\nListo: ${todo.length} lugares migrados.`);
