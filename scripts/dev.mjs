// Servidor local: sirve los estaticos con las mismas cabeceras de vercel.json
// (asi la CSP falla aqui igual que fallaria en produccion) y enruta /api/<x>
// a api/<x>.js como Vercel.
//
//   node scripts/dev.mjs                      http://localhost:3100 (base local data/traveltime.db)
//   node --env-file=.env scripts/dev.mjs      igual, pero contra Turso y con las claves del .env

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 3100;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const vercel = JSON.parse(await readFile(join(ROOT, 'vercel.json'), 'utf8'));
function headersFor(path) {
  const out = {};
  for (const rule of vercel.headers) {
    const re = new RegExp('^' + rule.source.replace('(.*)', '.*') + '$');
    if (re.test(path)) for (const h of rule.headers) out[h.key] = h.value;
  }
  return out;
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = decodeURIComponent(url.pathname);
  for (const [k, v] of Object.entries(headersFor(path))) res.setHeader(k, v);

  if (path.startsWith('/api/')) {
    const name = path.slice(5).replace(/\/$/, '');
    const file = join(ROOT, 'api', name + '.js');
    if (!/^[a-z0-9-]+$/.test(name) || !existsSync(file)) return void res.writeHead(404).end();
    // La misma interfaz que da Vercel a los handlers.
    req.query = Object.fromEntries(url.searchParams);
    res.status = (c) => ((res.statusCode = c), res);
    res.json = (data) => {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(data));
      return res;
    };
    // Los handlers se importan una vez: si tocas api/ (o api/_lib/), reinicia el servidor.
    const { default: handler } = await import(pathToFileURL(file).href);
    await handler(req, res);
    console.log(`${req.method} ${path}${url.search} -> ${res.statusCode}`);
    return;
  }

  const file = normalize(join(ROOT, path === '/' ? 'index.html' : path));
  if (!file.startsWith(ROOT) || file.includes('node_modules') || file.includes(join(ROOT, 'data'))) {
    return void res.writeHead(403).end();
  }
  try {
    if (!(await stat(file)).isFile()) throw new Error();
    // En local nada se cachea salvo los mapas (que van versionados): asi un
    // cambio en js/ se ve con recargar, sin pelear con la cache del navegador.
    if (!path.startsWith('/geo/')) res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', TYPES[extname(file)] ?? 'application/octet-stream');
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end();
  }
}).listen(PORT, () => {
  console.log(`\n  TravelTime -> http://localhost:${PORT}`);
  console.log(`  Base de datos: ${process.env.TURSO_DATABASE_URL ? 'Turso (remota)' : 'data/traveltime.db (local)'}\n`);
});
