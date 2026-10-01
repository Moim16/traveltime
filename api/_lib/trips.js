// Lo que comparten api/trips.js (los mios) y api/public.js (los publicados).

import { db } from './db.js';
import { imagesReady, signedUrl } from './images.js';

// Fechas, conteos y portada en una consulta: lo que necesita una tarjeta.
export const TRIP_SELECT = `
  SELECT t.*,
    (SELECT MIN(COALESCE(v.startDay, substr(v.createdAt, 1, 10))) FROM visits v WHERE v.tripId = t.id) startDay,
    (SELECT MAX(COALESCE(v.endDay, v.startDay, substr(v.createdAt, 1, 10))) FROM visits v WHERE v.tripId = t.id) endDay,
    (SELECT COUNT(*) FROM visits v WHERE v.tripId = t.id) visitCount,
    (SELECT COUNT(DISTINCT substr(v.placeId, 1, 3)) FROM visits v WHERE v.tripId = t.id) countryCount,
    (SELECT p.cfId FROM photos p JOIN visits v ON v.id = p.visitId WHERE v.tripId = t.id AND p.status = 'ready'
      ORDER BY COALESCE(v.startDay, v.createdAt), p.position, p.id LIMIT 1) coverCfId
  FROM trips t`;

export const tripCard = (t) => ({
  id: Number(t.id),
  title: t.title,
  summary: t.summary ?? null,
  startDay: t.startDay ?? null,
  endDay: t.endDay && t.endDay !== t.startDay ? t.endDay : null,
  visitCount: Number(t.visitCount ?? 0),
  countryCount: Number(t.countryCount ?? 0),
  cover: t.coverCfId && imagesReady() ? signedUrl(t.coverCfId, 'ttcard') : null,
  publishedAt: t.publishedAt ?? null,
});

// Las visitas de un viaje, en orden de viaje. onlyPublished: para la pagina publica.
export async function tripVisits(tripId, { onlyPublished = false } = {}) {
  const rs = await db.execute({
    sql: `SELECT v.id, v.placeId, v.placeName, v.title, v.startDay, v.endDay, v.publishedAt,
            (SELECT COUNT(*) FROM photos p WHERE p.visitId = v.id AND p.status = 'ready') photoCount,
            (SELECT p.cfId FROM photos p WHERE p.visitId = v.id AND p.status = 'ready' ORDER BY p.position, p.id LIMIT 1) coverCfId
          FROM visits v WHERE v.tripId = ? ${onlyPublished ? 'AND v.publishedAt IS NOT NULL' : ''}
          ORDER BY COALESCE(v.startDay, substr(v.createdAt, 1, 10)), v.id`,
    args: [tripId],
  });
  return rs.rows.map((v) => ({
    id: Number(v.id),
    placeId: v.placeId,
    placeName: v.placeName ?? null,
    title: v.title,
    startDay: v.startDay ?? null,
    endDay: v.endDay ?? null,
    photoCount: Number(v.photoCount),
    cover: v.coverCfId && imagesReady() ? signedUrl(v.coverCfId, 'ttcard') : null,
    ...(onlyPublished ? {} : { publishedAt: v.publishedAt ?? null }),
  }));
}
