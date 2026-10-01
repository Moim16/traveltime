// "Quiero ir": lugares pendientes.
//
//  GET    /api/wishes                  -> { wishes } los mios
//  POST   /api/wishes  { fromPinId }   -> desde un lugar de una recomendacion publicada
//  POST   /api/wishes  { placeId, placeName, name } -> un municipio entero, a mano
//  DELETE /api/wishes?id=5
//  DELETE /api/wishes?placeId=…        -> todos los de un lugar (al marcarlo visitado)
//
// De una recomendacion se copian SOLO el nombre, el tipo y la ubicacion del
// lugar: el relato y las fotos son de quien la escribio y se quedan alla.

import { db, ensureSchema, nowIso } from './_lib/db.js';
import { readJson, clean, parseId, parsePlace } from './_lib/http.js';
import { currentUser, deny, notYours } from './_lib/auth.js';

const WISHES_MAX = 1000;

const publicWish = (w) => ({
  id: Number(w.id),
  placeId: w.placeId,
  placeName: w.placeName ?? null,
  name: w.name,
  kind: w.kind,
  lat: w.lat == null ? null : Number(w.lat),
  lng: w.lng == null ? null : Number(w.lng),
  sourcePinId: w.sourcePinId == null ? null : Number(w.sourcePinId),
  sourceVisitId: w.sourceVisitId == null ? null : Number(w.sourceVisitId),
  createdAt: w.createdAt,
});

export default async function handler(req, res) {
  try {
    await ensureSchema();
    const me = await currentUser(req);
    if (!me) return deny(res);
    const q = req.query ?? {};

    if (req.method === 'GET') {
      const rs = await db.execute({ sql: 'SELECT * FROM wishes WHERE userId = ? ORDER BY id DESC', args: [me.id] });
      return res.status(200).json({ wishes: rs.rows.map(publicWish) });
    }

    if (req.method === 'POST') {
      const body = await readJson(req);
      const n = Number((await db.execute({ sql: 'SELECT COUNT(*) c FROM wishes WHERE userId = ?', args: [me.id] })).rows[0].c);
      if (n >= WISHES_MAX) return res.status(409).json({ error: `Tu lista "Quiero ir" puede tener hasta ${WISHES_MAX} lugares.` });

      let w;
      if (body.fromPinId) {
        const p = (await db.execute({
          sql: `SELECT p.id, p.name, p.kind, p.lat, p.lng, v.id visitId, v.placeId, v.placeName FROM pins p JOIN visits v ON v.id = p.visitId
                WHERE p.id = ? AND (v.publishedAt IS NOT NULL OR v.userId = ?)`,
          args: [parseId(body.fromPinId), me.id],
        })).rows[0];
        if (!p) return notYours(res);
        // Tocar "Quiero ir" dos veces no lo agrega dos veces.
        const dup = (await db.execute({ sql: 'SELECT * FROM wishes WHERE userId = ? AND sourcePinId = ?', args: [me.id, p.id] })).rows[0];
        if (dup) return res.status(200).json({ wish: publicWish(dup), already: true });
        w = { placeId: p.placeId, placeName: p.placeName, name: p.name, kind: p.kind, lat: p.lat, lng: p.lng, sourcePinId: p.id, sourceVisitId: p.visitId };
      } else {
        const placeId = parsePlace(body.placeId);
        const name = clean(body.name, 120) ?? clean(body.placeName, 200)?.split(',')[0];
        if (!placeId || !name) return res.status(400).json({ error: 'Falta el lugar.' });
        const dup = (await db.execute({ sql: 'SELECT * FROM wishes WHERE userId = ? AND placeId = ? AND sourcePinId IS NULL AND lat IS NULL', args: [me.id, placeId] })).rows[0];
        if (dup) return res.status(200).json({ wish: publicWish(dup), already: true });
        w = { placeId, placeName: clean(body.placeName, 200), name, kind: 'other', lat: null, lng: null, sourcePinId: null, sourceVisitId: parseId(body.sourceVisitId) };
      }
      const ins = await db.execute({
        sql: `INSERT INTO wishes (userId, placeId, placeName, name, kind, lat, lng, sourcePinId, sourceVisitId, createdAt)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [me.id, w.placeId, w.placeName, w.name, w.kind, w.lat, w.lng, w.sourcePinId, w.sourceVisitId, nowIso()],
      });
      const row = (await db.execute({ sql: 'SELECT * FROM wishes WHERE id = ?', args: [Number(ins.lastInsertRowid)] })).rows[0];
      return res.status(201).json({ wish: publicWish(row) });
    }

    if (req.method === 'DELETE') {
      if (q.placeId) {
        const placeId = parsePlace(q.placeId);
        if (!placeId) return res.status(400).json({ error: 'Lugar inválido.' });
        await db.execute({ sql: 'DELETE FROM wishes WHERE userId = ? AND placeId = ?', args: [me.id, placeId] });
        return res.status(200).json({ ok: true });
      }
      const del = await db.execute({ sql: 'DELETE FROM wishes WHERE id = ? AND userId = ?', args: [parseId(q.id), me.id] });
      return del.rowsAffected ? res.status(200).json({ ok: true }) : notYours(res);
    }

    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: 'Método no permitido.' });
  } catch (err) {
    console.error('[api/wishes]', err);
    return res.status(500).json({ error: 'Algo falló en el servidor.' });
  }
}
