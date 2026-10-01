// Visitas: lo que hiciste en un lugar, en unas fechas.
//
//  GET    /api/visits?under=NIC        -> { visits } mias en ese lugar o dentro de el,
//                                         las mas recientes primero (sin el texto)
//  GET    /api/visits?id=12            -> { visit } con el texto
//  POST   /api/visits                  { placeId, placeName, title, startDay, endDay, body }
//  PUT    /api/visits?id=12            { title, startDay, endDay, body } (placeId no
//                                         cambia: mover una visita es borrarla y crearla)
//  DELETE /api/visits?id=12              (se lleva sus fotos, tambien de Cloudflare)
//
// La lista trae de cada visita cuantas fotos tiene y la primera como portada.
//
// Todo es de quien lo escribio: una visita de otra persona responde 404, igual
// que una que no existe. Compartir llega en la fase 3.

import { db, ensureSchema, nowIso } from './_lib/db.js';
import { readJson, clean, cleanText, parseDay, parseId, parsePlace } from './_lib/http.js';
import { currentUser, deny, notYours } from './_lib/auth.js';
import { imagesReady, signedUrl } from './_lib/images.js';
import { removePhotos } from './_lib/photos.js';

const TITLE_MAX = 120;

const publicVisit = (v, withBody) => ({
  id: Number(v.id),
  placeId: v.placeId,
  placeName: v.placeName ?? null,
  title: v.title,
  startDay: v.startDay ?? null,
  endDay: v.endDay ?? null,
  ...(withBody ? { body: v.body ?? null } : {}),
  ...('photoCount' in v
    ? { photoCount: Number(v.photoCount), cover: v.coverCfId && imagesReady() ? signedUrl(v.coverCfId, 'ttcard') : null }
    : {}),
  createdAt: v.createdAt,
  updatedAt: v.updatedAt,
});

// Valida titulo y fechas. Devuelve { ok, value } o { ok:false, error }.
function parseFields(body) {
  const title = clean(body.title, TITLE_MAX);
  if (!title) return { ok: false, error: 'Ponle un título a la visita.' };
  const startDay = body.startDay ? parseDay(body.startDay) : null;
  const endDay = body.endDay ? parseDay(body.endDay) : null;
  if (body.startDay && !startDay) return { ok: false, error: 'La fecha de inicio no es válida.' };
  if (body.endDay && !endDay) return { ok: false, error: 'La fecha de fin no es válida.' };
  if (endDay && !startDay) return { ok: false, error: 'Si pones fecha de fin, pon también la de inicio.' };
  if (startDay && endDay && endDay < startDay) return { ok: false, error: 'La visita no puede terminar antes de empezar.' };
  return { ok: true, value: { title, startDay, endDay, body: cleanText(body.body) } };
}

async function mine(userId, id) {
  const rs = await db.execute({ sql: 'SELECT * FROM visits WHERE id = ? AND userId = ?', args: [id, userId] });
  return rs.rows[0] ?? null;
}

export default async function handler(req, res) {
  try {
    await ensureSchema();
    const me = await currentUser(req);
    if (!me) return deny(res);
    const q = req.query ?? {};

    if (req.method === 'GET' && q.id) {
      const v = await mine(me.id, parseId(q.id));
      return v ? res.status(200).json({ visit: publicVisit(v, true) }) : notYours(res);
    }

    if (req.method === 'GET') {
      const under = parsePlace(q.under);
      if (!under) return res.status(400).json({ error: 'Lugar inválido.' });
      // "Dentro de" es por prefijo del id: NIC.granada contiene NIC.granada.granada.
      // El LIKE escapa los guiones bajos por las dudas, aunque los ids no los usan.
      const rs = await db.execute({
        sql: `SELECT v.*,
                (SELECT COUNT(*) FROM photos p WHERE p.visitId = v.id AND p.status = 'ready') photoCount,
                (SELECT p.cfId FROM photos p WHERE p.visitId = v.id AND p.status = 'ready'
                  ORDER BY p.position, p.id LIMIT 1) coverCfId
              FROM visits v WHERE v.userId = ? AND (v.placeId = ? OR v.placeId LIKE ? ESCAPE '\\')
              ORDER BY COALESCE(v.startDay, substr(v.createdAt, 1, 10)) DESC, v.id DESC LIMIT 200`,
        args: [me.id, under, `${under.replace(/[\\%_]/g, '\\$&')}.%`],
      });
      return res.status(200).json({ visits: rs.rows.map((v) => publicVisit(v, false)) });
    }

    if (req.method === 'POST') {
      const body = await readJson(req);
      const placeId = parsePlace(body.placeId);
      if (!placeId) return res.status(400).json({ error: 'Lugar inválido.' });
      const f = parseFields(body);
      if (!f.ok) return res.status(400).json({ error: f.error });
      const now = nowIso();
      const ins = await db.execute({
        sql: `INSERT INTO visits (userId, placeId, placeName, title, startDay, endDay, body, createdAt, updatedAt)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [me.id, placeId, clean(body.placeName, 200), f.value.title, f.value.startDay, f.value.endDay, f.value.body, now, now],
      });
      return res.status(201).json({ visit: publicVisit(await mine(me.id, Number(ins.lastInsertRowid)), true) });
    }

    if (req.method === 'PUT') {
      const id = parseId(q.id);
      if (!id || !(await mine(me.id, id))) return notYours(res);
      const f = parseFields(await readJson(req));
      if (!f.ok) return res.status(400).json({ error: f.error });
      await db.execute({
        sql: 'UPDATE visits SET title = ?, startDay = ?, endDay = ?, body = ?, updatedAt = ? WHERE id = ? AND userId = ?',
        args: [f.value.title, f.value.startDay, f.value.endDay, f.value.body, nowIso(), id, me.id],
      });
      return res.status(200).json({ visit: publicVisit(await mine(me.id, id), true) });
    }

    if (req.method === 'DELETE') {
      const id = parseId(q.id);
      if (!id || !(await mine(me.id, id))) return notYours(res);
      // Las fotos primero, y de a una en Cloudflare: el ON DELETE CASCADE borraria
      // las filas pero dejaria las imagenes alla, ocupando cupo para siempre.
      const photos = await db.execute({ sql: 'SELECT id, cfId FROM photos WHERE visitId = ? AND userId = ?', args: [id, me.id] });
      await removePhotos(photos.rows);
      // Explicito: en Turso las FOREIGN KEY no siempre se aplican (el PRAGMA es
      // por conexion y el cliente web no la mantiene), asi que no hay cascada segura.
      await db.execute({ sql: 'DELETE FROM pins WHERE visitId = ? AND userId = ?', args: [id, me.id] });
      await db.execute({ sql: 'DELETE FROM visits WHERE id = ? AND userId = ?', args: [id, me.id] });
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST, PUT, DELETE');
    return res.status(405).json({ error: 'Método no permitido.' });
  } catch (err) {
    console.error('[api/visits]', err);
    return res.status(500).json({ error: 'Algo falló en el servidor.' });
  }
}
