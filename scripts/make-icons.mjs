// Genera los iconos de la app: un globo blanco sobre el degradado coral.
//
//   node scripts/make-icons.mjs
//
// Chrome en Android no ofrece instalar la app si el manifest solo trae un SVG:
// exige un PNG de 192. Se dibuja pixel a pixel (con suavizado) y se codifica el
// PNG a mano con zlib, que ya viene en Node: cero dependencias de imagen.
// Mismo enfoque que deudas/scripts/make-icons.mjs.

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Los colores de --accent y --accent-2 (tema claro).
const A = [0xf2, 0x54, 0x5b];
const B = [0xff, 0x9a, 0x62];
const WHITE = [255, 255, 255];

// Todo en un lienzo de 512. El globo: un circulo, el ecuador, dos paralelos y
// dos meridianos (elipses). Trazos gruesos: a 48 px tiene que seguir leyendose.
const C = 256;
const R = 150;
const STROKE = 20;

// Distancia del punto al trazo mas cercano del globo (negativa = adentro del trazo).
function globe(x, y) {
  const dx = x - C;
  const dy = y - C;
  const r = Math.hypot(dx, dy);
  let d = Math.abs(r - R) - STROKE / 2; // contorno
  if (r < R) {
    d = Math.min(d, Math.abs(dy) - STROKE / 2); // ecuador
    for (const py of [-R * 0.52, R * 0.52]) {
      // paralelos: rectos, cortados por el circulo
      d = Math.min(d, Math.abs(dy - py) - STROKE * 0.4);
    }
    for (const k of [0.42, 0]) {
      // meridianos: elipses de semieje k*R (k=0: la linea vertical)
      const a = k * R;
      const md = a === 0 ? Math.abs(dx) : Math.abs(Math.hypot(dx / a, dy / R) - 1) * Math.min(a, R) * 0.9;
      d = Math.min(d, md - STROKE / 2);
    }
  }
  return d;
}

// Esquina redondeada del icono "any" (el "maskable" llena todo: el sistema recorta).
function insideRounded(x, y, size, radius) {
  const cx = Math.max(radius, Math.min(x, size - radius));
  const cy = Math.max(radius, Math.min(y, size - radius));
  return Math.hypot(x - cx, y - cy) - radius;
}

function render(size, { maskable }) {
  const s = size / 512;
  // El maskable deja zona segura (el sistema puede recortar hasta un 20 %).
  const scale = maskable ? 0.78 : 1;
  const px = Buffer.alloc(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = i + 0.5;
      const y = j + 0.5;
      const t = (x + y) / (2 * size);
      const bg = A.map((v, k) => Math.round(v + (B[k] - v) * t));
      // Coordenadas del lienzo de 512, con la escala del maskable centrada.
      const gx = (x / s - C) / scale + C;
      const gy = (y / s - C) / scale + C;
      const g = Math.max(0, Math.min(1, 0.5 - globe(gx, gy) * s * scale)); // suavizado de ~1 px
      const color = bg.map((v, k) => Math.round(v + (WHITE[k] - v) * g));
      const edge = maskable ? 1 : Math.max(0, Math.min(1, 0.5 - insideRounded(x, y, size, size * 0.22)));
      const o = (j * size + i) * 4;
      px[o] = color[0];
      px[o + 1] = color[1];
      px[o + 2] = color[2];
      px[o + 3] = Math.round(255 * edge);
    }
  }
  return png(size, px);
}

// PNG RGBA 8 bits, un IDAT, filtro 0 por fila.
function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let j = 0; j < size; j++) rgba.copy(raw, j * (size * 4 + 1) + 1, j * size * 4, (j + 1) * size * 4);
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bits
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-maskable-512.png', 512, true],
  ['apple-touch-icon.png', 180, true], // iOS pone sus propias esquinas
  ['favicon-48.png', 48, false],
];
for (const [name, size, maskable] of out) {
  writeFileSync(join(ROOT, name), render(size, { maskable }));
  console.log(name);
}
