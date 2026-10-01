// Viajes: visitas agrupadas.
//
//  GET    /api/trips                    -> { trips } mios, con fechas, conteos y portada
//  GET    /api/trips?id=3               -> { trip } con sus visitas en orden
//  POST   /api/trips   { title, summary, visitId? }   visitId: la mete de una vez
//  PUT    /api/trips?id=3  { title, summary }
//  PUT    /api/trips?id=3&publish=1  { published }
//  PUT    /api/trips?id=3&visit=12  { in: true|false }  meter o sacar una visita
//  DELETE /api/trips?id=3               (las visitas quedan, sueltas)
//
// Las fechas del viaje no se guardan: salen de la primera y la ultima visita.

import { db, ensureSchema, nowIso } from './_lib/db.js';
import { readJson, clean, cleanText, parseId } from './_lib/http.js';
import { currentUser, deny, notYours } from './_lib/auth.js';
import { TRIP_SELECT, tripCard, tripVisits } from './_lib/trips.js';

const TITLE_MAX = 120;
const SUMMARY_MAX = 2000;

const mine = async (userId, id) =>
  (await db.execute({ sql: `${TRIP_SELECT} WHERE t.id = ? AND t.userId = ?`, args: [id, userId] })).rows[0] ?? null;

export default async function handler(req, res) {
  try {
    await ensureSchema();
    const me = await currentUser(req);
    if (!me) return deny(res);
    const q = req.query ?? {};

    if (req.method === 'GET' && q.id) {
      const t = await mine(me.id, parseId(q.id));
      if (!t) return notYours(res);
      return res.status(200).json({ trip: { ...tripCard(t), visits: await tripVisits(t.id) } });
    }

    if (req.method === 'GET') {
      const rs = await db.execute({ sql: `${TRIP_SELECT} WHERE t.userId = ? ORDER BY t.id DESC`, args: [me.id] });
      const trips = rs.rows.map(tripCard).sort((a, b) => (b.startDay ?? '').localeCompare(a.startDay ?? ''));
      return res.status(200).json({ trips });
    }

    if (req.method === 'POST') {
      const body = await readJson(req);
      const title = clean(body.title, TITLE_MAX);
      if (!title) return res.status(400).json({ error: 'Ponle un nombre al viaje.' });
      const visitId = parseId(body.visitId);
      if (visitId && !(await db.execute({ sql: 'SELECT 1 FROM visits WHERE id = ? AND userId = ?', args: [visitId, me.id] })).rows.length) {
        return notYours(res);
      }
      const now = nowIso();
      const ins = await db.execute({
        sql: 'INSERT INTO trips (userId, title, summary, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)',
        args: [me.id, title, cleanText(body.summary, SUMMARY_MAX), now, now],
      });
      const id = Number(ins.lastInsertRowid);
      if (visitId) await db.execute({ sql: 'UPDATE visits SET tripId = ? WHERE id = ? AND userId = ?', args: [id, visitId, me.id] });
      return res.status(201).json({ trip: tripCard(await mine(me.id, id)) });
    }

    if (req.method === 'PUT') {
      const t = await mine(me.id, parseId(q.id));
      if (!t) return notYours(res);
      const body = await readJson(req);

      if (q.visit) {
        const visitId = parseId(q.visit);
        // Una visita esta en un solo viaje: meterla aqui la saca del anterior.
        const upd = await db.execute({
          sql: body.in
            ? 'UPDATE visits SET tripId = ? WHERE id = ? AND userId = ?'
            : 'UPDATE visits SET tripId = NULL WHERE id = ? AND userId = ? AND tripId = ?',
          args: body.in ? [t.id, visitId, me.id] : [visitId, me.id, t.id],
        });
        if (!upd.rowsAffected) return notYours(res);
        return res.status(200).json({ trip: tripCard(await mine(me.id, t.id)) });
      }

      if (q.publish) {
        const on = Boolean(body.published);
        await db.execute({ sql: 'UPDATE trips SET publishedAt = ? WHERE id = ?', args: [on ? t.publishedAt ?? nowIso() : null, t.id] });
        return res.status(200).json({ trip: tripCard(await mine(me.id, t.id)) });
      }

      const title = clean(body.title ?? t.title, TITLE_MAX);
      if (!title) return res.status(400).json({ error: 'Ponle un nombre al viaje.' });
      const summary = 'summary' in body ? cleanText(body.summary, SUMMARY_MAX) : t.summary;
      await db.execute({ sql: 'UPDATE trips SET title = ?, summary = ?, updatedAt = ? WHERE id = ?', args: [title, summary, nowIso(), t.id] });
      return res.status(200).json({ trip: tripCard(await mine(me.id, t.id)) });
    }

    if (req.method === 'DELETE') {
      const t = await mine(me.id, parseId(q.id));
      if (!t) return notYours(res);
      await db.execute({ sql: 'UPDATE visits SET tripId = NULL WHERE tripId = ? AND userId = ?', args: [t.id, me.id] });
      await db.execute({ sql: 'DELETE FROM trips WHERE id = ?', args: [t.id] });
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST, PUT, DELETE');
    return res.status(405).json({ error: 'Método no permitido.' });
  } catch (err) {
    console.error('[api/trips]', err);
    return res.status(500).json({ error: 'Algo falló en el servidor.' });
  }
}
