// "Tu año en viajes": el resumen de un año, como un Wrapped. Todo sale de lo que
// la persona registro: visitas (por su fecha, o la de creacion si no tiene),
// lo marcado ese año, fotos, lugares, viajes y compañeros. Solo lo ve el dueño.
//
// Los kilometros no se calculan aqui: el servidor no tiene los mapas. Van las
// visitas en orden con su placeId, y la web y la app suman con el punto de cada
// lugar (js/geo.js placePoint, GeoService.placePoint).

import { db } from './db.js';
import { signedUrl, imagesReady } from './images.js';

const DAY = "COALESCE(v.startDay, substr(v.createdAt, 1, 10))";
const MOSAIC = 9;

/** Los años que tienen algo, del mas nuevo al mas viejo. */
export async function travelYears(userId) {
  const rs = await db.execute({
    sql: `SELECT DISTINCT substr(${DAY}, 1, 4) y FROM visits v WHERE v.userId = ?
          UNION SELECT DISTINCT substr(createdAt, 1, 4) FROM marks WHERE userId = ?
          ORDER BY y DESC`,
    args: [userId, userId],
  });
  return rs.rows.map((r) => Number(r.y)).filter(Boolean);
}

const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000) + 1;

export async function yearInTravel(userId, year) {
  const y = String(year);
  const [visits, marks, photos, pins, mosaic] = await Promise.all([
    db.execute({
      sql: `SELECT v.id, v.placeId, v.placeName, v.title, v.startDay, v.endDay, v.publishedAt, v.tripId, ${DAY} day,
                   (SELECT COUNT(*) FROM photos p WHERE p.visitId = v.id AND p.status = 'ready') photoCount,
                   (SELECT p.cfId FROM photos p WHERE p.visitId = v.id AND p.status = 'ready' ORDER BY p.position, p.id LIMIT 1) coverCfId
            FROM visits v WHERE v.userId = ? AND substr(${DAY}, 1, 4) = ? ORDER BY day, v.id`,
      args: [userId, y],
    }),
    db.execute({ sql: 'SELECT placeId FROM marks WHERE userId = ? AND substr(createdAt, 1, 4) = ?', args: [userId, y] }),
    db.execute({
      sql: `SELECT COUNT(*) n FROM photos p JOIN visits v ON v.id = p.visitId
            WHERE v.userId = ? AND p.status = 'ready' AND substr(${DAY}, 1, 4) = ?`,
      args: [userId, y],
    }),
    db.execute({
      sql: `SELECT COUNT(*) n FROM pins p JOIN visits v ON v.id = p.visitId WHERE v.userId = ? AND substr(${DAY}, 1, 4) = ?`,
      args: [userId, y],
    }),
    // El mosaico: fotos repartidas entre las visitas (la primera de cada una, y despues mas).
    db.execute({
      sql: `SELECT p.cfId, p.visitId FROM photos p JOIN visits v ON v.id = p.visitId
            WHERE v.userId = ? AND p.status = 'ready' AND substr(${DAY}, 1, 4) = ?
            ORDER BY p.position, ${DAY} LIMIT 60`,
      args: [userId, y],
    }),
  ]);

  const list = visits.rows.map((v) => ({
    id: Number(v.id),
    placeId: v.placeId,
    placeName: v.placeName ?? null,
    title: v.title,
    day: v.day,
    startDay: v.startDay ?? null,
    endDay: v.endDay ?? null,
    photoCount: Number(v.photoCount),
    cover: v.coverCfId && imagesReady() ? signedUrl(v.coverCfId, 'ttcard') : null,
    published: Boolean(v.publishedAt),
  }));

  // Lugares del año: los de las visitas y lo marcado ese año.
  const places = new Set([...list.map((v) => v.placeId), ...marks.rows.map((m) => m.placeId)]);
  const countries = [...new Set([...places].map((p) => p.split('.')[0]))];
  const cities = [...places].filter((p) => p.split('.').length === 3);

  // El pais con mas visitas.
  const perCountry = new Map();
  for (const v of list) perCountry.set(v.placeId.split('.')[0], (perCountry.get(v.placeId.split('.')[0]) ?? 0) + 1);
  const [topCountry, topCountryVisits] = [...perCountry.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];

  // Visitas por mes (de las que tienen fecha de verdad).
  const months = Array(12).fill(0);
  for (const v of list) if (v.startDay) months[Number(v.startDay.slice(5, 7)) - 1]++;

  // Dias de viaje: cada visita con fechas cuenta sus dias (sin contar dos veces un dia).
  const days = new Set();
  let longest = null;
  for (const v of list) {
    if (!v.startDay) continue;
    const n = v.endDay ? daysBetween(v.startDay, v.endDay) : 1;
    for (let i = 0; i < Math.min(n, 366); i++) days.add(new Date(Date.parse(`${v.startDay}T12:00:00Z`) + i * 86400000).toISOString().slice(0, 10));
    if (!longest || n > longest.days) longest = { id: v.id, title: v.title, placeName: v.placeName, days: n };
  }

  // Viajes y compañeros de esas visitas.
  const tripIds = [...new Set(visits.rows.map((v) => v.tripId).filter(Boolean).map(Number))];
  let trips = [];
  let companions = [];
  if (tripIds.length) {
    const qs = tripIds.map(() => '?').join(',');
    const [t, c] = await Promise.all([
      db.execute({ sql: `SELECT id, title FROM trips WHERE id IN (${qs})`, args: tripIds }),
      db.execute({
        sql: `SELECT DISTINCT u.name FROM users u WHERE u.id != ? AND (
                u.id IN (SELECT userId FROM trips WHERE id IN (${qs}))
                OR u.id IN (SELECT userId FROM trip_members WHERE status = 'accepted' AND tripId IN (${qs})))`,
        args: [userId, ...tripIds, ...tripIds],
      }),
    ]);
    trips = t.rows.map((r) => ({ id: Number(r.id), title: r.title }));
    companions = c.rows.map((r) => r.name);
  }

  // Mosaico: primero una foto por visita, despues las demas, hasta 9.
  const seen = new Set();
  const first = [];
  const rest = [];
  for (const p of mosaic.rows) (seen.has(p.visitId) ? rest : (seen.add(p.visitId), first)).push(p);
  const photosOut = imagesReady() ? [...first, ...rest].slice(0, MOSAIC).map((p) => signedUrl(p.cfId, 'ttthumb')) : [];

  return {
    year: Number(year),
    visits: list,
    countries,
    cities: cities.length,
    places: places.size,
    topCountry: topCountry ? { iso: topCountry, visits: topCountryVisits } : null,
    months,
    travelDays: days.size,
    longest,
    photos: Number(photos.rows[0].n),
    pins: Number(pins.rows[0].n),
    published: list.filter((v) => v.published).length,
    trips,
    companions,
    mosaic: photosOut,
  };
}
