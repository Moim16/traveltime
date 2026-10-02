// Visitas: lo que hiciste en un lugar, en unas fechas.
//
//  GET    /api/visits?under=NIC        -> { visits } mias en ese lugar o dentro de el,
//                                         las mas recientes primero (sin el texto)
//  GET    /api/visits?id=12            -> { visit } con el texto
//  POST   /api/visits                  { placeId, placeName, title, startDay, endDay, body, fromPinId }
//                                         fromPinId: "ya estuve" desde una recomendacion; la visita
//                                         nueva lleva ese lugar (solo nombre, tipo y ubicacion)
//  PUT    /api/visits?id=12            { title, startDay, endDay, body } (placeId no
//                                         cambia: mover una visita es borrarla y crearla).
//                                         Sin body, el relato queda como estaba.
//  PUT    /api/visits?id=12&publish=1  { published } publicar o dejar de publicar
//  DELETE /api/visits?id=12              (se lleva sus fotos, tambien de Cloudflare)
//
// La lista trae de cada visita cuantas fotos tiene y la primera como portada.
//
// Todo es de quien lo escribio: una visita de otra persona responde 404, igual
// que una que no existe. Lo que se ve de una visita publicada lo decide api/_lib/public.js.

import { db, ensureSchema, nowIso } from './_lib/db.js';
import { readJson, clean, parseDay, parseId, parsePlace } from './_lib/http.js';
import { currentUser, deny, notYours } from './_lib/auth.js';
import { imagesReady, signedUrl } from './_lib/images.js';
import { removePhotos } from './_lib/photos.js';
import { parseStory, readStory } from './_lib/story.js';
import { readableVisit } from './_lib/trips.js';

const TITLE_MAX = 120;

const ownVisit = (v, withBody) => ({
  id: Number(v.id),
  placeId: v.placeId,
  placeName: v.placeName ?? null,
  title: v.title,
  startDay: v.startDay ?? null,
  endDay: v.endDay ?? null,
  // body: { v, blocks } (ver api/_lib/story.js). Un relato de la fase 1, en texto, sale ya convertido.
  ...(withBody ? { body: readStory(v.body) } : {}),
  ...('photoCount' in v
    ? { photoCount: Number(v.photoCount), cover: v.coverCfId && imagesReady() ? signedUrl(v.coverCfId, 'ttcard') : null }
    : {}),
  publishedAt: v.publishedAt ?? null,
  tripId: v.tripId == null ? null : Number(v.tripId),
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
  const story = parseStory(body.body);
  if (!story.ok) return { ok: false, error: story.error };
  return { ok: true, value: { title, startDay, endDay, body: story.value } };
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
      // Mia, o de un viaje donde soy compañero (de lectura: mine=false).
      const r = await readableVisit(me.id, parseId(q.id));
      if (!r) return notYours(res);
      return res.status(200).json({ visit: { ...ownVisit(r.visit, true), author: r.visit.author, mine: r.mine } });
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
      return res.status(200).json({ visits: rs.rows.map((v) => ownVisit(v, false)) });
    }

    if (req.method === 'POST') {
      const body = await readJson(req);
      // Ya estuve: el lugar de una recomendacion publicada (o uno mio). Se copia
      // solo lo que es del lugar; el relato, las fotos y las fechas son mios.
      let fromPin = null;
      if (body.fromPinId) {
        fromPin = (await db.execute({
          sql: 'SELECT p.name, p.kind, p.lat, p.lng, v.placeId, v.placeName FROM pins p JOIN visits v ON v.id = p.visitId WHERE p.id = ? AND (v.publishedAt IS NOT NULL OR v.userId = ?)',
          args: [parseId(body.fromPinId), me.id],
        })).rows[0];
        if (!fromPin) return notYours(res);
      }
      const placeId = parsePlace(body.placeId) ?? fromPin?.placeId ?? null;
      if (!placeId) return res.status(400).json({ error: 'Lugar inválido.' });
      const f = parseFields(body);
      if (!f.ok) return res.status(400).json({ error: f.error });
      const now = nowIso();
      const ins = await db.execute({
        sql: `INSERT INTO visits (userId, placeId, placeName, title, startDay, endDay, body, createdAt, updatedAt)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [me.id, placeId, clean(body.placeName, 200) ?? fromPin?.placeName ?? null, f.value.title, f.value.startDay, f.value.endDay, f.value.body, now, now],
      });
      const newId = Number(ins.lastInsertRowid);
      if (fromPin) {
        await db.execute({
          sql: 'INSERT INTO pins (userId, visitId, name, kind, lat, lng, note, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)',
          args: [me.id, newId, fromPin.name, fromPin.kind, fromPin.lat, fromPin.lng, now, now],
        });
      }
      return res.status(201).json({ visit: ownVisit(await mine(me.id, newId), true) });
    }

    if (req.method === 'PUT' && q.publish) {
      const id = parseId(q.id);
      const v = id && (await mine(me.id, id));
      if (!v) return notYours(res);
      const on = Boolean((await readJson(req)).published);
      // Si ya estaba publicada, conserva su fecha: tocar el boton otra vez no la sube al tope.
      await db.execute({
        sql: "UPDATE visits SET publishedAt = ?, privacy = ? WHERE id = ? AND userId = ?",
        args: [on ? v.publishedAt ?? nowIso() : null, on ? 'public' : 'private', id, me.id],
      });
      return res.status(200).json({ visit: ownVisit(await mine(me.id, id), true) });
    }

    if (req.method === 'PUT') {
      const id = parseId(q.id);
      const v = id && (await mine(me.id, id));
      if (!v) return notYours(res);
      const input = await readJson(req);
      const f = parseFields(input);
      if (!f.ok) return res.status(400).json({ error: f.error });
      // Sin "body" no se toca el relato: la app cambia el titulo o las fechas sin
      // mandarlo, y un relato no se borra por omision. Borrarlo es mandar null.
      const body = 'body' in input ? f.value.body : v.body;
      await db.execute({
        sql: 'UPDATE visits SET title = ?, startDay = ?, endDay = ?, body = ?, updatedAt = ? WHERE id = ? AND userId = ?',
        args: [f.value.title, f.value.startDay, f.value.endDay, body, nowIso(), id, me.id],
      });
      return res.status(200).json({ visit: ownVisit(await mine(me.id, id), true) });
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
