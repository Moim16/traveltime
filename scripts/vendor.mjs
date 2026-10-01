// Copia MapLibre de node_modules a vendor/: la app no carga scripts de otros
// dominios (CSP 'self'), asi que la libreria se sirve desde el propio sitio.
//
//   node scripts/vendor.mjs     despues de actualizar maplibre-gl

import { mkdir, copyFile, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'node_modules', 'maplibre-gl', 'dist');
const DST = join(ROOT, 'vendor', 'maplibre');

// El modulo principal arranca el worker con import.meta.url: los tres van juntos.
const FILES = ['maplibre-gl.mjs', 'maplibre-gl-shared.mjs', 'maplibre-gl-worker.mjs', 'maplibre-gl.css'];

await mkdir(DST, { recursive: true });
for (const f of FILES) await copyFile(join(SRC, f), join(DST, f));
const { version } = JSON.parse(await readFile(join(ROOT, 'node_modules', 'maplibre-gl', 'package.json'), 'utf8'));
console.log(`MapLibre ${version} copiado a vendor/maplibre`);
