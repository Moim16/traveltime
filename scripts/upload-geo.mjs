// Sube los mapas de geo/ a S3, detras de CloudFront.
//
//   node --env-file=.env scripts/upload-geo.mjs           sube la version actual
//   node --env-file=.env scripts/upload-geo.mjs --prune   ademas borra las viejas
//                                                         (deja la actual y la anterior)
//
// Cada generacion de mapas va a su propia carpeta, geo/<version>/..., con cache
// de un año: esos archivos no cambian nunca, cambia la carpeta. geo/version.json
// se sube AL FINAL y sin cache, asi la app pasa a la version nueva solo cuando
// ya estan arriba todos los archivos (nadie ve una version a medias).
//
// Necesita en .env: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, GEO_BUCKET.

import { readFile, readdir } from 'node:fs/promises';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GEO = join(ROOT, 'geo');
const PARALLEL = 16;
const KEEP_VERSIONS = 2;

const { AWS_REGION, GEO_BUCKET: Bucket, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY } = process.env;
if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY || !AWS_REGION || !Bucket) {
  console.error('Faltan AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION o GEO_BUCKET en el .env.');
  console.error('Corre:  node --env-file=.env scripts/upload-geo.mjs');
  process.exit(1);
}
const s3 = new S3Client({ region: AWS_REGION });

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

const put = (Key, Body, CacheControl) =>
  s3.send(new PutObjectCommand({ Bucket, Key, Body, ContentType: 'application/json; charset=utf-8', CacheControl }));

const { v } = JSON.parse(await readFile(join(GEO, 'version.json'), 'utf8'));
const files = [];
for await (const f of walk(GEO)) {
  const rel = relative(GEO, f).split(sep).join('/');
  if (rel !== 'version.json') files.push(rel);
}
console.log(`Version ${v}: ${files.length} archivos a s3://${Bucket}/geo/${v}/`);

let done = 0;
let i = 0;
const started = Date.now();
await Promise.all(
  Array.from({ length: PARALLEL }, async () => {
    while (i < files.length) {
      const rel = files[i++];
      for (let attempt = 1; ; attempt++) {
        try {
          await put(`geo/${v}/${rel}`, await readFile(join(GEO, rel)), 'public, max-age=31536000, immutable');
          break;
        } catch (e) {
          if (attempt === 3) throw new Error(`${rel}: ${e.message}`);
          await new Promise((r) => setTimeout(r, 1000 * attempt));
        }
      }
      if (++done % 250 === 0 || done === files.length) {
        console.log(`  ${done}/${files.length} (${Math.round((Date.now() - started) / 1000)} s)`);
      }
    }
  }),
);

// Recien ahora: la app empieza a pedir la version nueva.
await put('geo/version.json', JSON.stringify({ v }) + '\n', 'no-cache');
console.log('version.json actualizado: la app ya usa esta version.');

if (process.argv.includes('--prune')) {
  const versions = new Set();
  let token;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket, Prefix: 'geo/', Delimiter: '/', ContinuationToken: token }));
    for (const p of r.CommonPrefixes ?? []) versions.add(p.Prefix.slice(4, -1));
    token = r.NextContinuationToken;
  } while (token);
  // Los nombres son Date.now() en base 36: ordenarlos como numeros los ordena por fecha.
  const old = [...versions].sort((a, b) => parseInt(b, 36) - parseInt(a, 36)).slice(KEEP_VERSIONS);
  for (const ver of old) {
    let removed = 0;
    let t;
    do {
      const r = await s3.send(new ListObjectsV2Command({ Bucket, Prefix: `geo/${ver}/`, ContinuationToken: t }));
      const keys = (r.Contents ?? []).map((o) => ({ Key: o.Key }));
      if (keys.length) await s3.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: keys } }));
      removed += keys.length;
      t = r.NextContinuationToken;
    } while (t);
    console.log(`Borrada la version ${ver} (${removed} archivos)`);
  }
}
console.log('Listo');
