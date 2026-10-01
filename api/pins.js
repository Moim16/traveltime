// Lugares puntuales de una visita.
//
//  GET    /api/pins?under=NIC.granada  -> { pins } mios en visitas de ese lugar o
//                                         de lo que tiene adentro (para el mapa)
//  GET    /api/pins?visit=12           -> { pins } de una visita
//  POST   /api/pins                    { visitId, name, kind, lat, lng, note }
//  PUT    /api/pins?id=5               { name, kind, lat, lng, note }
//  DELETE /api/pins?id=5
//
// Un pin cuelga de una visita: quien no es dueño de la visita recibe 404.
// No se valida que el punto caiga dentro del municipio de la visita: un mirador
// en el limite, o la playa del municipio vecino, siguen siendo parte del viaje.

import { db, ensureSchema, nowIso, PIN_KINDS } from './_lib/db.js';
import { readJson, clean, cleanText, parseId, parsePlace } from './_lib/http.js';
import { currentUser, deny, notYours } from './_lib/auth.js';
import { readableVisit } from './_lib/trips.js';

const NAME_MAX = 120;
const NOTE_MAX = 1000;
const PINS_POR_VISITA = 100;

const publicPin = (p) => ({
  id: Number(p.id),
  visitId: Number(p.visitId),
  name: p.name,
  kind: p.kind,
  lat: Number(p.lat),
  lng: Number(p.lng),
  note: p.note ?? null,
  ...(p.visitTitle !== undefined ? { visitTitle: p.visitTitle, placeId: p.placeId } : {}),
});

const coord = (v, max) => {
  const n = Number(v);
  return v !== null && v !== '' && Number.isFinite(n) && Math.abs(n) <= max ? Math.round(n * 1e6) / 1e6 : null;
};

function parseFields(body) {
  const name = clean(body.name, NAME_MAX);
  if (!name) return { ok: false, error: 'Ponle un nombre al lugar.' };
  const lat = coord(body.lat, 90);
  const lng = coord(body.lng, 180);
  if (lat === null || lng === null) return { ok: false, error: 'Falta la ubicación del lugar en el mapa.' };
  const kind = PIN_KINDS.includes(body.kind) ? body.kind : 'other';
  return { ok: true, value: { name, kind, lat, lng, note: cleanText(body.note, NOTE_MAX) } };
}

const visitOf = async (userId, visitId) =>
  (await db.execute({ sql: 'SELECT id FROM visits WHERE id = ? AND userId = ?', args: [visitId, userId] })).rows[0] ?? null;
const pinOf = async (userId, id) =>
  (await db.execute({ sql: 'SELECT * FROM pins WHERE id = ? AND userId = ?', args: [id, userId] })).rows[0] ?? null;

export default async function handler(req, res) {
  try {
    await ensureSchema();
    const me = await currentUser(req);
    if (!me) return deny(res);
    const q = req.query ?? {};

    if (req.method === 'GET' && q.visit) {
      const visitId = parseId(q.visit);
      // Mia, o de un viaje donde soy compañero (los lugares son la gracia de viajar juntos).
      if (!(await readableVisit(me.id, visitId))) return notYours(res);
      const rs = await db.execute({ sql: 'SELECT * FROM pins WHERE visitId = ? ORDER BY id', args: [visitId] });
      return res.status(200).json({ pins: rs.rows.map(publicPin) });
    }

    if (req.method === 'GET') {
      const under = parsePlace(q.under);
      if (!under) return res.status(400).json({ error: 'Lugar inválido.' });
      const rs = await db.execute({
        sql: `SELECT p.*, v.title visitTitle, v.placeId FROM pins p JOIN visits v ON v.id = p.visitId
              WHERE p.userId = ? AND (v.placeId = ? OR v.placeId LIKE ? ESCAPE '\\') ORDER BY p.id LIMIT 2000`,
        args: [me.id, under, `${under.replace(/[\\%_]/g, '\\$&')}.%`],
      });
      return res.status(200).json({ pins: rs.rows.map(publicPin) });
    }

    if (req.method === 'POST') {
      const body = await readJson(req);
      const visitId = parseId(body.visitId);
      if (!visitId || !(await visitOf(me.id, visitId))) return notYours(res);
      const f = parseFields(body);
      if (!f.ok) return res.status(400).json({ error: f.error });
      const n = Number((await db.execute({ sql: 'SELECT COUNT(*) c FROM pins WHERE visitId = ?', args: [visitId] })).rows[0].c);
      if (n >= PINS_POR_VISITA) return res.status(409).json({ error: `Una visita puede tener hasta ${PINS_POR_VISITA} lugares.` });
      const now = nowIso();
      const ins = await db.execute({
        sql: `INSERT INTO pins (userId, visitId, name, kind, lat, lng, note, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [me.id, visitId, f.value.name, f.value.kind, f.value.lat, f.value.lng, f.value.note, now, now],
      });
      return res.status(201).json({ pin: publicPin(await pinOf(me.id, Number(ins.lastInsertRowid))) });
    }

    if (req.method === 'PUT') {
      const p = await pinOf(me.id, parseId(q.id));
      if (!p) return notYours(res);
      const f = parseFields({ ...publicPin(p), ...(await readJson(req)) });
      if (!f.ok) return res.status(400).json({ error: f.error });
      await db.execute({
        sql: 'UPDATE pins SET name = ?, kind = ?, lat = ?, lng = ?, note = ?, updatedAt = ? WHERE id = ?',
        args: [f.value.name, f.value.kind, f.value.lat, f.value.lng, f.value.note, nowIso(), p.id],
      });
      return res.status(200).json({ pin: publicPin(await pinOf(me.id, p.id)) });
    }

    if (req.method === 'DELETE') {
      const p = await pinOf(me.id, parseId(q.id));
      if (!p) return notYours(res);
      await db.execute({ sql: 'DELETE FROM pins WHERE id = ?', args: [p.id] });
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST, PUT, DELETE');
    return res.status(405).json({ error: 'Método no permitido.' });
  } catch (err) {
    console.error('[api/pins]', err);
    return res.status(500).json({ error: 'Algo falló en el servidor.' });
  }
}
