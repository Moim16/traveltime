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

// Las visitas de un viaje, en orden de viaje, de todos sus compañeros (cada una
// con su autor). onlyPublished: para la pagina publica. viewerId: marca las mias.
export async function tripVisits(tripId, { onlyPublished = false, viewerId = null } = {}) {
  const rs = await db.execute({
    sql: `SELECT v.id, v.userId, v.placeId, v.placeName, v.title, v.startDay, v.endDay, v.publishedAt, u.name author,
            (SELECT COUNT(*) FROM photos p WHERE p.visitId = v.id AND p.status = 'ready') photoCount,
            (SELECT p.cfId FROM photos p WHERE p.visitId = v.id AND p.status = 'ready' ORDER BY p.position, p.id LIMIT 1) coverCfId
          FROM visits v JOIN users u ON u.id = v.userId WHERE v.tripId = ? ${onlyPublished ? 'AND v.publishedAt IS NOT NULL' : ''}
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
    author: v.author,
    photoCount: Number(v.photoCount),
    cover: v.coverCfId && imagesReady() ? signedUrl(v.coverCfId, 'ttcard') : null,
    ...(onlyPublished ? {} : { publishedAt: v.publishedAt ?? null }),
    ...(viewerId ? { mine: Number(v.userId) === viewerId } : {}),
  }));
}

// Que es esta persona en el viaje: 'owner', 'member' (compañero que acepto) o
// null (nada: ni siquiera sabe que existe; los endpoints responden 404).
export async function tripRole(userId, tripId) {
  if (!userId || !tripId) return null;
  const rs = await db.execute({
    sql: `SELECT CASE WHEN t.userId = ? THEN 'owner'
                 WHEN EXISTS (SELECT 1 FROM trip_members m WHERE m.tripId = t.id AND m.userId = ? AND m.status = 'accepted') THEN 'member'
            END role
          FROM trips t WHERE t.id = ?`,
    args: [userId, userId, tripId],
  });
  return rs.rows[0]?.role ?? null;
}

// La visita, si esta persona la puede LEER: es suya, o es de un viaje donde la
// persona es dueña o compañera aceptada. Escribir sigue siendo solo del autor.
// Devuelve { visit, mine } o null.
export async function readableVisit(userId, visitId) {
  if (!userId || !visitId) return null;
  const v = (await db.execute({ sql: 'SELECT v.*, u.name author FROM visits v JOIN users u ON u.id = v.userId WHERE v.id = ?', args: [visitId] })).rows[0];
  if (!v) return null;
  if (Number(v.userId) === userId) return { visit: v, mine: true };
  if (v.tripId && (await tripRole(userId, Number(v.tripId)))) return { visit: v, mine: false };
  return null;
}
