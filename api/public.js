// Lo publicado: se lee sin cuenta. Solo GET.
//
//  GET /api/public?home=1           -> { recommendations, places, stats } para la portada
//  GET /api/public?feed=1&before=…  -> { visits, next } mas recomendaciones (paginado)
//  GET /api/public?visit=12         -> { visit } una visita publicada completa
//  GET /api/public?under=NIC        -> { pins } los lugares publicados dentro de un lugar
//                                      (para verlos en el mapa)
//
// Que sale y que no lo decide api/_lib/public.js.
// Las respuestas se cachean 60 s en el CDN de Vercel: las URL de las fotos
// vienen firmadas por 4 horas, asi que un minuto de cache no las deja vencidas.

import { db, ensureSchema } from './_lib/db.js';
import { parseId, parsePlace } from './_lib/http.js';
import { CARD_SELECT, publicCard, publishedVisit } from './_lib/public.js';

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

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ error: 'Método no permitido.' });
    }
    await ensureSchema();
    const q = req.query ?? {};
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');

    if (q.visit) {
      const v = await publishedVisit(parseId(q.visit));
      if (!v) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(404).json({ error: 'Esta visita no existe o ya no está publicada.' });
      }
      return res.status(200).json({ visit: v });
    }

    if (q.home) {
      const [recs, places, stats] = await Promise.all([
        db.execute({ sql: `${CARD_SELECT} WHERE v.publishedAt IS NOT NULL ORDER BY v.publishedAt DESC LIMIT ?`, args: [PAGE] }),
        recentPlaces(16),
        db.execute(`SELECT COUNT(*) visits, COUNT(DISTINCT substr(placeId, 1, 3)) countries, COUNT(DISTINCT userId) authors
                    FROM visits WHERE publishedAt IS NOT NULL`),
      ]);
      const s = stats.rows[0];
      return res.status(200).json({
        recommendations: recs.rows.map(publicCard),
        places,
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
    return res.status(500).json({ error: 'Algo falló en el servidor.' });
  }
}
