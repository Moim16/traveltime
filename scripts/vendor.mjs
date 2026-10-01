// Copia las librerias del navegador de node_modules a vendor/: la app no carga
// scripts de otros dominios (CSP 'self'), asi que se sirven desde el propio sitio.
//
//   npm run vendor     despues de actualizar maplibre-gl o @editorjs/*

import { mkdir, copyFile, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NM = join(ROOT, 'node_modules');

// [paquete, archivos de dist/, carpeta destino en vendor/, nombre destino opcional]
const LIBS = [
  // El modulo principal arranca el worker con import.meta.url: los tres van juntos.
  ['maplibre-gl', ['maplibre-gl.mjs', 'maplibre-gl-shared.mjs', 'maplibre-gl-worker.mjs', 'maplibre-gl.css'], 'maplibre'],
  // El editor del relato. Se carga solo al abrir el modo escritura.
  ['@editorjs/editorjs', ['editorjs.mjs'], 'editorjs'],
  ['@editorjs/header', ['header.mjs'], 'editorjs'],
  ['@editorjs/list', ['editorjs-list.mjs'], 'editorjs', 'list.mjs'],
  ['@editorjs/quote', ['quote.mjs'], 'editorjs'],
  ['@editorjs/delimiter', ['delimiter.mjs'], 'editorjs'],
  ['@editorjs/marker', ['marker.mjs'], 'editorjs'],
];

for (const [pkg, files, dest, rename] of LIBS) {
  const dir = join(ROOT, 'vendor', dest);
  await mkdir(dir, { recursive: true });
  for (const f of files) await copyFile(join(NM, pkg, 'dist', f), join(dir, rename ?? f));
  const { version } = JSON.parse(await readFile(join(NM, pkg, 'package.json'), 'utf8'));
  console.log(`${pkg} ${version} -> vendor/${dest}`);
}
