// Subir fotos: leer fecha y GPS, achicar en el telefono y mandar directo a
// Cloudflare. La foto nunca pasa por nuestro servidor.
//
// El orden importa: el EXIF se lee del archivo ORIGINAL, porque al redibujarla
// en un canvas se pierde. Y que se pierda es bueno: la foto que sube no lleva
// el GPS adentro; viaja aparte y se guarda en la base, bajo control del dueño.

import { api, ApiError } from './api.js';

const MAX_SIDE = 2560; // lo mismo que la variante ttfull: mas grande no se ve
const QUALITY = 0.86;
const PARALLEL = 3;

// ---------- EXIF (solo JPEG; lo justo: fecha y GPS) ----------

function readExif(buf) {
  const v = new DataView(buf);
  if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return {};
  let off = 2;
  while (off + 4 < v.byteLength) {
    const marker = v.getUint16(off);
    const size = v.getUint16(off + 2);
    if (marker === 0xffe1 && v.getUint32(off + 4) === 0x45786966) return parseTiff(v, off + 10); // "Exif"
    if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) break; // empezo la imagen: no hay EXIF
    off += 2 + size;
  }
  return {};
}

function parseTiff(v, start) {
  const little = v.getUint16(start) === 0x4949;
  const u16 = (o) => v.getUint16(start + o, little);
  const u32 = (o) => v.getUint32(start + o, little);
  const entries = (ifd) => {
    const out = new Map();
    if (!ifd || start + ifd + 2 > v.byteLength) return out;
    const n = u16(ifd);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      out.set(u16(e), { type: u16(e + 2), count: u32(e + 4), at: e + 8 });
    }
    return out;
  };
  const value = (t) => (t.type === 3 ? u16(t.at) : u32(t.at));
  const ascii = (t) => {
    const at = t.count > 4 ? u32(t.at) : t.at;
    let s = '';
    for (let i = 0; i < t.count - 1; i++) s += String.fromCharCode(v.getUint8(start + at + i));
    return s;
  };
  const rationals = (t) => {
    const at = u32(t.at);
    return Array.from({ length: t.count }, (_, i) => u32(at + i * 8) / (u32(at + i * 8 + 4) || 1));
  };

  const ifd0 = entries(u32(4));
  const out = {};
  const exifPtr = ifd0.get(0x8769);
  if (exifPtr) {
    const date = entries(value(exifPtr)).get(0x9003) ?? ifd0.get(0x0132); // DateTimeOriginal, o DateTime
    if (date) out.takenAt = ascii(date);
  }
  const gpsPtr = ifd0.get(0x8825);
  if (gpsPtr) {
    const g = entries(value(gpsPtr));
    const deg = (t) => (t ? rationals(t).reduce((acc, x, i) => acc + x / 60 ** i, 0) : null);
    const lat = deg(g.get(2));
    const lng = deg(g.get(4));
    if (lat != null && lng != null && (lat || lng)) {
      out.lat = ascii(g.get(1) ?? { count: 2, at: 0 }) === 'S' ? -lat : lat;
      out.lng = ascii(g.get(3) ?? { count: 2, at: 0 }) === 'W' ? -lng : lng;
    }
  }
  return out;
}

// ---------- Preparar ----------

// -> { blob, width, height, takenAt, lat, lng }, o lanza un Error con mensaje legible.
export async function prepare(file) {
  let exif = {};
  try {
    exif = readExif(await file.slice(0, 256 * 1024).arrayBuffer());
  } catch {
    // Un EXIF roto no impide subir la foto: solo se queda sin fecha ni lugar.
  }
  let bitmap;
  try {
    // from-image: respeta la rotacion del EXIF (la foto vertical del telefono).
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error(/hei[cf]/i.test(file.type || file.name) ? `${file.name}: este navegador no abre fotos HEIC. Pásala a JPG o súbela desde el teléfono.` : `${file.name}: no es una imagen que se pueda abrir.`);
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', QUALITY));
  if (!blob) throw new Error(`${file.name}: no se pudo preparar la foto.`);
  return { blob, width, height, ...exif };
}

// ---------- Subir ----------

async function uploadOne(visitId, file, onState) {
  onState('preparando');
  const p = await prepare(file);
  onState('subiendo');
  const { photo, uploadURL } = await api('photos', {
    method: 'POST',
    query: { upload: 1 },
    body: { visitId, width: p.width, height: p.height, takenAt: p.takenAt, lat: p.lat, lng: p.lng },
  });
  const form = new FormData();
  form.set('file', p.blob, 'foto.jpg');
  let res;
  try {
    res = await fetch(uploadURL, { method: 'POST', body: form });
  } catch {
    throw new ApiError(0, `${file.name}: se cortó la conexión al subir.`);
  }
  if (!res.ok) throw new ApiError(res.status, `${file.name}: Cloudflare rechazó la foto.`);
  return (await api('photos', { method: 'POST', query: { confirm: 1, id: photo.id } })).photo;
}

// Sube varias de a PARALLEL. onProgress(i, estado) por cada archivo; estado es
// 'esperando' | 'preparando' | 'subiendo' | 'lista' | 'error'.
// Devuelve { done: [photo], errors: [mensaje] }: una que falla no frena a las demas.
export async function uploadAll(visitId, files, onProgress) {
  const done = [];
  const errors = [];
  let next = 0;
  files.forEach((_, i) => onProgress(i, 'esperando'));
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL, files.length) }, async () => {
      while (next < files.length) {
        const i = next++;
        try {
          done.push(await uploadOne(visitId, files[i], (s) => onProgress(i, s)));
          onProgress(i, 'lista');
        } catch (e) {
          errors.push(e.message);
          onProgress(i, 'error');
          // Sin cupo no tiene sentido seguir intentando con el resto.
          if (e.status === 409) next = files.length;
        }
      }
    }),
  );
  return { done, errors };
}
