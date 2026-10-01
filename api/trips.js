// Viajes: visitas agrupadas, propias y de compañeros.
//
//  GET    /api/trips                    -> { trips } donde soy dueño o compañero
//  GET    /api/trips?invites=1          -> { invites } las invitaciones que me esperan
//  GET    /api/trips?id=3               -> { trip } con sus visitas en orden y sus compañeros
//  POST   /api/trips   { title, summary, visitId? }   visitId: la mete de una vez
//  POST   /api/trips?id=3&invite=1  { name }        invitar por usuario (solo el dueño)
//  POST   /api/trips?id=3&respond=1 { accept }      aceptar o rechazar una invitacion
//  PUT    /api/trips?id=3  { title, summary }       (solo el dueño)
//  PUT    /api/trips?id=3&publish=1  { published }  (solo el dueño)
//  PUT    /api/trips?id=3&visit=12  { in: true|false }  meter o sacar una visita MIA
//                                    (dueño o compañero; nadie mueve visitas ajenas)
//  DELETE /api/trips?id=3&member=pepe   el dueño saca a un compañero, o uno se sale
//                                    (sus visitas quedan suyas, fuera del viaje)
//  DELETE /api/trips?id=3               (solo el dueño; las visitas quedan, sueltas)
//
// Un compañero que acepto ve todas las visitas del viaje (de lectura) y mete las
// suyas. No renombra, no publica y no borra el viaje. Quien no es nada en el
// viaje recibe 404, igual que si no existiera.

import { db, ensureSchema, nowIso } from './_lib/db.js';
import { readJson, clean, cleanText, parseId } from './_lib/http.js';
import { currentUser, deny, notYours } from './_lib/auth.js';
import { TRIP_SELECT, tripCard, tripVisits, tripRole } from './_lib/trips.js';

const TITLE_MAX = 120;
const SUMMARY_MAX = 2000;
const MEMBERS_MAX = 20;

const tripRow = async (id) => (await db.execute({ sql: `${TRIP_SELECT} WHERE t.id = ?`, args: [id] })).rows[0] ?? null;

async function members(tripId) {
  const rs = await db.execute({
    sql: `SELECT u.name, 'owner' role, 'accepted' status FROM trips t JOIN users u ON u.id = t.userId WHERE t.id = ?
          UNION ALL
          SELECT u.name, 'member', m.status FROM trip_members m JOIN users u ON u.id = m.userId WHERE m.tripId = ?`,
    args: [tripId, tripId],
  });
  return rs.rows.map((r) => ({ name: r.name, role: r.role, status: r.status }));
}

async function fullTrip(id, me) {
  const t = await tripRow(id);
  return {
    ...tripCard(t),
    role: await tripRole(me.id, id),
    members: await members(id),
    visits: await tripVisits(id, { viewerId: me.id }),
  };
}

export default async function handler(req, res) {
  try {
    await ensureSchema();
    const me = await currentUser(req);
    if (!me) return deny(res);
    const q = req.query ?? {};
    const id = parseId(q.id);

    if (req.method === 'GET' && q.invites) {
      const rs = await db.execute({
        sql: `SELECT t.id, t.title, u.name invitedBy FROM trip_members m JOIN trips t ON t.id = m.tripId JOIN users u ON u.id = m.invitedBy
              WHERE m.userId = ? AND m.status = 'invited' ORDER BY m.createdAt DESC`,
        args: [me.id],
      });
      return res.status(200).json({ invites: rs.rows.map((r) => ({ tripId: Number(r.id), title: r.title, invitedBy: r.invitedBy })) });
    }

    if (req.method === 'GET' && id) {
      if (!(await tripRole(me.id, id))) return notYours(res);
      return res.status(200).json({ trip: await fullTrip(id, me) });
    }

    if (req.method === 'GET') {
      const rs = await db.execute({
        sql: `${TRIP_SELECT} WHERE t.userId = ? OR EXISTS (SELECT 1 FROM trip_members m WHERE m.tripId = t.id AND m.userId = ? AND m.status = 'accepted')
              ORDER BY t.id DESC`,
        args: [me.id, me.id],
      });
      const trips = rs.rows
        .map((t) => ({ ...tripCard(t), role: Number(t.userId) === me.id ? 'owner' : 'member' }))
        .sort((a, b) => (b.startDay ?? '').localeCompare(a.startDay ?? ''));
      return res.status(200).json({ trips });
    }

    if (req.method === 'POST' && q.invite) {
      if ((await tripRole(me.id, id)) !== 'owner') return notYours(res);
      const body = await readJson(req);
      const name = (body.name ?? '').toString().trim().replace(/^@/, '');
      const u = (await db.execute({ sql: 'SELECT id, name FROM users WHERE name = ? COLLATE NOCASE', args: [name] })).rows[0];
      if (!u) return res.status(404).json({ error: `No hay nadie con el usuario @${name}.` });
      if (Number(u.id) === me.id) return res.status(400).json({ error: 'Ya eres el dueño de este viaje.' });
      const n = Number((await db.execute({ sql: 'SELECT COUNT(*) c FROM trip_members WHERE tripId = ?', args: [id] })).rows[0].c);
      if (n >= MEMBERS_MAX) return res.status(409).json({ error: `Un viaje puede tener hasta ${MEMBERS_MAX} compañeros.` });
      const ins = await db.execute({
        sql: "INSERT OR IGNORE INTO trip_members (tripId, userId, status, invitedBy, createdAt) VALUES (?, ?, 'invited', ?, ?)",
        args: [id, u.id, me.id, nowIso()],
      });
      if (!ins.rowsAffected) return res.status(409).json({ error: `@${u.name} ya está invitado a este viaje.` });
      return res.status(201).json({ members: await members(id) });
    }

    if (req.method === 'POST' && q.respond) {
      const accept = Boolean((await readJson(req)).accept);
      const upd = await db.execute({
        sql: accept
          ? "UPDATE trip_members SET status = 'accepted' WHERE tripId = ? AND userId = ? AND status = 'invited'"
          : "DELETE FROM trip_members WHERE tripId = ? AND userId = ? AND status = 'invited'",
        args: [id, me.id],
      });
      if (!upd.rowsAffected) return notYours(res);
      return res.status(200).json(accept ? { trip: await fullTrip(id, me) } : { ok: true });
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
      const newId = Number(ins.lastInsertRowid);
      if (visitId) await db.execute({ sql: 'UPDATE visits SET tripId = ? WHERE id = ? AND userId = ?', args: [newId, visitId, me.id] });
      return res.status(201).json({ trip: { ...tripCard(await tripRow(newId)), role: 'owner' } });
    }

    if (req.method === 'PUT') {
      const role = await tripRole(me.id, id);
      if (!role) return notYours(res);
      const body = await readJson(req);

      if (q.visit) {
        const visitId = parseId(q.visit);
        // Solo mis visitas: el WHERE userId = me lo asegura. Una visita esta en un
        // solo viaje: meterla aqui la saca del anterior.
        const upd = await db.execute({
          sql: body.in
            ? 'UPDATE visits SET tripId = ? WHERE id = ? AND userId = ?'
            : 'UPDATE visits SET tripId = NULL WHERE id = ? AND userId = ? AND tripId = ?',
          args: body.in ? [id, visitId, me.id] : [visitId, me.id, id],
        });
        if (!upd.rowsAffected) return notYours(res);
        return res.status(200).json({ trip: { ...tripCard(await tripRow(id)), role } });
      }

      if (role !== 'owner') return res.status(403).json({ error: 'Solo quien creó el viaje puede cambiarlo.' });
      const t = await tripRow(id);

      if (q.publish) {
        const on = Boolean(body.published);
        await db.execute({ sql: 'UPDATE trips SET publishedAt = ? WHERE id = ?', args: [on ? t.publishedAt ?? nowIso() : null, id] });
        return res.status(200).json({ trip: { ...tripCard(await tripRow(id)), role } });
      }

      const title = clean(body.title ?? t.title, TITLE_MAX);
      if (!title) return res.status(400).json({ error: 'Ponle un nombre al viaje.' });
      const summary = 'summary' in body ? cleanText(body.summary, SUMMARY_MAX) : t.summary;
      await db.execute({ sql: 'UPDATE trips SET title = ?, summary = ?, updatedAt = ? WHERE id = ?', args: [title, summary, nowIso(), id] });
      return res.status(200).json({ trip: { ...tripCard(await tripRow(id)), role } });
    }

    if (req.method === 'DELETE' && q.member) {
      const role = await tripRole(me.id, id);
      const u = (await db.execute({ sql: 'SELECT id FROM users WHERE name = ? COLLATE NOCASE', args: [String(q.member).replace(/^@/, '')] })).rows[0];
      // El dueño saca a cualquiera; un compañero (o un invitado) solo se saca a si mismo.
      const self = u && Number(u.id) === me.id;
      const invitedSelf = self && (await db.execute({ sql: 'SELECT 1 FROM trip_members WHERE tripId = ? AND userId = ?', args: [id, me.id] })).rows.length;
      if (!u || !(role === 'owner' || invitedSelf)) return notYours(res);
      const del = await db.execute({ sql: 'DELETE FROM trip_members WHERE tripId = ? AND userId = ?', args: [id, u.id] });
      if (!del.rowsAffected) return notYours(res);
      // Sus visitas son suyas: solo salen del viaje.
      await db.execute({ sql: 'UPDATE visits SET tripId = NULL WHERE tripId = ? AND userId = ?', args: [id, u.id] });
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'DELETE') {
      if ((await tripRole(me.id, id)) !== 'owner') return notYours(res);
      // Las visitas de todos quedan sueltas; los compañeros, fuera.
      await db.execute({ sql: 'UPDATE visits SET tripId = NULL WHERE tripId = ?', args: [id] });
      await db.execute({ sql: 'DELETE FROM trip_members WHERE tripId = ?', args: [id] });
      await db.execute({ sql: 'DELETE FROM trips WHERE id = ?', args: [id] });
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST, PUT, DELETE');
    return res.status(405).json({ error: 'Método no permitido.' });
  } catch (err) {
    console.error('[api/trips]', err);
    return res.status(500).json({ error: 'Algo falló en el servidor.' });
  }
}
