// Lo publicado: se lee sin cuenta. Solo GET.
//
//  GET /api/public?home=1           -> { recommendations, places, cities, stats } para la portada
//  GET /api/public?feed=1&before=…  -> { visits, next } mas recomendaciones (paginado)
//  GET /api/public?visit=12         -> { visit } una visita publicada completa
//  GET /api/public?user=moim16      -> { profile, visits } perfil publico: "Sobre mi" y lo publicado
//  GET /api/public?trip=3           -> { trip } un viaje publicado, con sus visitas publicadas
//  GET /api/public?under=NIC        -> { pins } los lugares publicados dentro de un lugar
//                                      (para verlos en el mapa)
//
// Que sale y que no lo decide api/_lib/public.js.
// El CDN de Vercel guarda las respuestas un minuto: las URL de las fotos vienen
// firmadas por 4 horas, asi que no quedan vencidas. El navegador no las guarda.

import { db, ensureSchema } from './_lib/db.js';
import { parseId, parsePlace } from './_lib/http.js';
import { CARD_SELECT, publicCard, publishedVisit } from './_lib/public.js';
import { tripVisits } from './_lib/trips.js';
import { publicProfile } from './_lib/profile.js';
import { signedUrl, imagesReady } from './_lib/images.js';

const PAGE = 12;

const likeUnder = (place) => `${place.replace(/[\\%_]/g, '\\$&')}.%`;

async function recentPlaces(limit) {
  const rs = await db.execute({
    sql: `SELECT p.id, p.name, p.kind, p.lat, p.lng, p.visitId, v.placeId, v.placeName, v.title visitTitle, u.name author
          FROM pins p JOIN visits v ON v.id = p.visitId JOIN users u ON u.id = v.userId
          WHERE v.publishedAt IS NOT NULL ORDER BY p.id DESC LIMIT ?`,
    args: [limit],
  });
  return rs.rows.map((p) => ({
    id: Number(p.id), name: p.name, kind: p.kind, lat: Number(p.lat), lng: Number(p.lng),
    visitId: Number(p.visitId), placeId: p.placeId, placeName: p.placeName, visitTitle: p.visitTitle, author: p.author,
  }));
}

// Las ciudades de las visitas recien publicadas, una vez cada una (la visita mas
// nueva de cada lugar): para "Ultimos lugares" aunque nadie haya marcado pines.
async function recentCities(limit) {
  const rs = await db.execute({
    sql: `SELECT v.id visitId, v.placeId, v.placeName, v.title visitTitle, u.name author, v.publishedAt,
                 (SELECT p.cfId FROM photos p WHERE p.visitId = v.id AND p.status = 'ready' ORDER BY p.position, p.id LIMIT 1) coverCfId
          FROM visits v JOIN users u ON u.id = v.userId
          WHERE v.publishedAt IS NOT NULL
            AND v.publishedAt = (SELECT MAX(v2.publishedAt) FROM visits v2 WHERE v2.placeId = v.placeId AND v2.publishedAt IS NOT NULL)
          ORDER BY v.publishedAt DESC LIMIT ?`,
    args: [limit],
  });
  return rs.rows.map((v) => ({
    placeId: v.placeId, placeName: v.placeName, visitId: Number(v.visitId), visitTitle: v.visitTitle, author: v.author,
    cover: v.coverCfId && imagesReady() ? signedUrl(v.coverCfId, 'ttthumb') : null,
  }));
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ error: 'Método no permitido.' });
    }
    await ensureSchema();
    const q = req.query ?? {};
    // Dos caches distintas, con dos cabeceras distintas:
    //  - El navegador NO guarda (no-cache). Con stale-while-revalidate en
    //    Cache-Control, Chrome mostraba una visita ya despublicada hasta 5
    //    minutos mientras revalidaba por detras.
    //  - El CDN de Vercel si guarda 20 s (Vercel-CDN-Cache-Control solo lo lee
    //    el CDN y no llega al navegador): un cambio se ve en todos lados en
    //    menos de medio minuto. Quien acaba de cambiar algo lo ve al momento:
    //    sus lecturas llevan ?fresh= y no pegan en el CDN (js/api.js).
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Vercel-CDN-Cache-Control', 'max-age=20, stale-while-revalidate=10');

    if (q.user) {
      const name = String(q.user).slice(0, 40);
      const profile = await publicProfile(name);
      if (!profile) {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
        return res.status(404).json({ error: 'Este viajero no existe.' });
      }
      const rs = await db.execute({
        sql: `${CARD_SELECT} WHERE v.userId = ? AND v.publishedAt IS NOT NULL ORDER BY v.publishedAt DESC LIMIT 60`,
        args: [profile.id],
      });
      const { id: _id, ...shown } = profile;
      return res.status(200).json({ profile: shown, visits: rs.rows.map(publicCard) });
    }

    if (q.visit) {
      const v = await publishedVisit(parseId(q.visit));
      if (!v) {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Vercel-CDN-Cache-Control', 'no-store'); // un 404 guardado ocultaria una visita recien publicada
        return res.status(404).json({ error: 'Esta visita no existe o ya no está publicada.' });
      }
      return res.status(200).json({ visit: v });
    }

    if (q.trip) {
      const t = (await db.execute({
        sql: `SELECT t.id, t.title, t.summary, t.publishedAt, u.name author FROM trips t JOIN users u ON u.id = t.userId
              WHERE t.id = ? AND t.publishedAt IS NOT NULL`,
        args: [parseId(q.trip)],
      })).rows[0];
      if (!t) {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
        return res.status(404).json({ error: 'Este viaje no existe o ya no está publicado.' });
      }
      // Solo las visitas publicadas, y la tarjeta (fechas, paises, portada) sale
      // de ellas: con las privadas se filtraria cuando y donde estuvo.
      const visits = await tripVisits(t.id, { onlyPublished: true });
      const days = visits.flatMap((v) => [v.startDay, v.endDay]).filter(Boolean).sort();
      return res.status(200).json({
        trip: {
          id: Number(t.id), title: t.title, summary: t.summary ?? null, author: t.author, publishedAt: t.publishedAt,
          startDay: days[0] ?? null, endDay: days.length > 1 ? days[days.length - 1] : null,
          visitCount: visits.length, countryCount: new Set(visits.map((v) => v.placeId.slice(0, 3))).size,
          cover: visits.find((v) => v.cover)?.cover ?? null,
          visits,
        },
      });
    }

    if (q.home) {
      const [recs, places, stats, cities] = await Promise.all([
        db.execute({ sql: `${CARD_SELECT} WHERE v.publishedAt IS NOT NULL ORDER BY v.publishedAt DESC LIMIT ?`, args: [PAGE] }),
        recentPlaces(16),
        db.execute(`SELECT COUNT(*) visits, COUNT(DISTINCT substr(placeId, 1, 3)) countries, COUNT(DISTINCT userId) authors
                    FROM visits WHERE publishedAt IS NOT NULL`),
        recentCities(12),
      ]);
      const s = stats.rows[0];
      return res.status(200).json({
        recommendations: recs.rows.map(publicCard),
        places,
        cities,
        stats: { visits: Number(s.visits), countries: Number(s.countries), authors: Number(s.authors) },
      });
    }

    if (q.feed) {
      const before = q.before ? String(q.before) : null;
      const rs = await db.execute({
        sql: `${CARD_SELECT} WHERE v.publishedAt IS NOT NULL ${before ? 'AND v.publishedAt < ?' : ''} ORDER BY v.publishedAt DESC LIMIT ?`,
        args: before ? [before, PAGE + 1] : [PAGE + 1],
      });
      const rows = rs.rows.slice(0, PAGE);
      return res.status(200).json({
        visits: rows.map(publicCard),
        next: rs.rows.length > PAGE ? rows[rows.length - 1].publishedAt : null,
      });
    }

    if (q.under) {
      const under = parsePlace(q.under);
      if (!under) return res.status(400).json({ error: 'Lugar inválido.' });
      const rs = await db.execute({
        sql: `SELECT p.id, p.name, p.kind, p.lat, p.lng, p.note, p.visitId, v.placeId, v.title visitTitle, u.name author
              FROM pins p JOIN visits v ON v.id = p.visitId JOIN users u ON u.id = v.userId
              WHERE v.publishedAt IS NOT NULL AND (v.placeId = ? OR v.placeId LIKE ? ESCAPE '\\') ORDER BY p.id DESC LIMIT 500`,
        args: [under, likeUnder(under)],
      });
      return res.status(200).json({
        pins: rs.rows.map((p) => ({
          id: Number(p.id), name: p.name, kind: p.kind, lat: Number(p.lat), lng: Number(p.lng), note: p.note ?? null,
          visitId: Number(p.visitId), placeId: p.placeId, visitTitle: p.visitTitle, author: p.author,
        })),
      });
    }

    return res.status(400).json({ error: 'Falta qué pedir.' });
  } catch (err) {
    console.error('[api/public]', err);
    res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Vercel-CDN-Cache-Control', 'no-store'); // un 404 guardado ocultaria una visita recien publicada
    return res.status(500).json({ error: 'Algo falló en el servidor.' });
  }
}
