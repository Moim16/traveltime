// Lo que se muestra de una visita publicada. Un solo lugar decide que sale a
// la luz, para que no se cuele un campo nuevo por descuido en algun endpoint.
//
// SALE: titulo, lugar, fechas, relato, fotos (URL firmada), lugares (pines),
//       y el usuario (@nombre) de quien la escribio.
// NO SALE: el GPS ni la hora exacta de las fotos, el correo ni el nombre
//          completo, el id del usuario, ni nada de sus visitas sin publicar.

import { db } from './db.js';
import { imagesReady, signedUrl } from './images.js';
import { readStory, excerpt } from './story.js';

export const publicPhoto = (p) => ({
  id: Number(p.id),
  width: p.width == null ? null : Number(p.width),
  height: p.height == null ? null : Number(p.height),
  caption: p.caption ?? null,
  // Solo el dia: la hora y el lugar exactos de una foto dicen demasiado.
  takenOn: p.takenAt ? String(p.takenAt).slice(0, 10) : null,
  urls: imagesReady()
    ? { thumb: signedUrl(p.cfId, 'ttthumb'), card: signedUrl(p.cfId, 'ttcard'), full: signedUrl(p.cfId, 'ttfull') }
    : null,
});

export const publicPin = (p) => ({
  id: Number(p.id),
  visitId: Number(p.visitId),
  name: p.name,
  kind: p.kind,
  lat: Number(p.lat),
  lng: Number(p.lng),
  note: p.note ?? null,
});

// Tarjeta de una visita publicada (la portada, sin el relato completo).
export const publicCard = (v) => ({
  id: Number(v.id),
  title: v.title,
  placeId: v.placeId,
  placeName: v.placeName ?? null,
  startDay: v.startDay ?? null,
  endDay: v.endDay ?? null,
  author: v.authorName,
  excerpt: excerpt(readStory(v.body)),
  cover: v.coverCfId && imagesReady() ? signedUrl(v.coverCfId, 'ttcard') : null,
  photoCount: Number(v.photoCount ?? 0),
  pinCount: Number(v.pinCount ?? 0),
  publishedAt: v.publishedAt,
});

// Las columnas de una tarjeta: autor, portada y conteos en una sola consulta.
export const CARD_SELECT = `
  SELECT v.id, v.title, v.placeId, v.placeName, v.startDay, v.endDay, v.body, v.publishedAt,
         u.name authorName,
         (SELECT COUNT(*) FROM photos p WHERE p.visitId = v.id AND p.status = 'ready') photoCount,
         (SELECT COUNT(*) FROM pins x WHERE x.visitId = v.id) pinCount,
         (SELECT p.cfId FROM photos p WHERE p.visitId = v.id AND p.status = 'ready' ORDER BY p.position, p.id LIMIT 1) coverCfId
  FROM visits v JOIN users u ON u.id = v.userId`;

// Una visita publicada completa, o null si no existe o no esta publicada.
export async function publishedVisit(id) {
  const v = (await db.execute({ sql: `${CARD_SELECT} WHERE v.id = ? AND v.publishedAt IS NOT NULL`, args: [id] })).rows[0];
  if (!v) return null;
  const [photos, pins] = await Promise.all([
    db.execute({ sql: "SELECT * FROM photos WHERE visitId = ? AND status = 'ready' ORDER BY position, id", args: [id] }),
    db.execute({ sql: 'SELECT * FROM pins WHERE visitId = ? ORDER BY id', args: [id] }),
  ]);
  return {
    ...publicCard(v),
    body: readStory(v.body),
    photos: photos.rows.map(publicPhoto),
    pins: pins.rows.map(publicPin),
  };
}
