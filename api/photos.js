// Fotos de una visita.
//
//  GET    /api/photos?visit=12              -> { photos } listas, con URL firmadas
//  POST   /api/photos?upload=1              { visitId, width, height, takenAt, lat, lng }
//                                            -> { photo, uploadURL }: el navegador sube
//                                            el archivo a uploadURL (directo a Cloudflare)
//  POST   /api/photos?confirm=1&id=5        -> la marca lista si Cloudflare ya la tiene
//  PUT    /api/photos?id=5                  { caption }
//  DELETE /api/photos?id=5
//
// Las fotos cuelgan de la visita: quien no es dueño de la visita recibe 404.
// Cupos (FOTOS_POR_USUARIO, FOTOS_POR_VISITA): las 100.000 imagenes de la cuenta
// de Cloudflare son de todos los usuarios; sin tope, uno solo las acaba.

import { db, ensureSchema, nowIso } from './_lib/db.js';
import { readJson, clean, parseId } from './_lib/http.js';
import { currentUser, deny, notYours } from './_lib/auth.js';
import { imagesReady, directUpload, isUploaded, signedUrl } from './_lib/images.js';
import { removePhotos } from './_lib/photos.js';
import { readableVisit } from './_lib/trips.js';

const FOTOS_POR_USUARIO = 2000;
const FOTOS_POR_VISITA = 150;
// Una subida que no se confirmo en este tiempo se abandono (se cerro la pestaña,
// se cayo la red): se borra para que no ocupe cupo.
const PENDING_MAX_MS = 60 * 60 * 1000;
const CAPTION_MAX = 300;

const publicPhoto = (p) => ({
  id: Number(p.id),
  visitId: Number(p.visitId),
  width: p.width == null ? null : Number(p.width),
  height: p.height == null ? null : Number(p.height),
  takenAt: p.takenAt ?? null,
  lat: p.lat == null ? null : Number(p.lat),
  lng: p.lng == null ? null : Number(p.lng),
  caption: p.caption ?? null,
  urls: { thumb: signedUrl(p.cfId, 'ttthumb'), card: signedUrl(p.cfId, 'ttcard'), full: signedUrl(p.cfId, 'ttfull') },
});

const num = (v, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
};
// "2025:04:17 10:32:05" (EXIF) o ISO -> "2025-04-17T10:32:05". Sin zona: es la
// hora que marcaba la camara donde se tomo la foto, que es la que importa.
const parseTakenAt = (v) => {
  const m = (v ?? '').toString().match(/^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}` : null;
};

async function visitOf(userId, visitId) {
  const rs = await db.execute({ sql: 'SELECT id FROM visits WHERE id = ? AND userId = ?', args: [visitId, userId] });
  return rs.rows[0] ?? null;
}

async function photoOf(userId, id) {
  const rs = await db.execute({ sql: 'SELECT * FROM photos WHERE id = ? AND userId = ?', args: [id, userId] });
  return rs.rows[0] ?? null;
}

async function dropStalePending(userId) {
  const cutoff = new Date(Date.now() - PENDING_MAX_MS).toISOString();
  const rs = await db.execute({
    sql: "SELECT id, cfId FROM photos WHERE userId = ? AND status = 'pending' AND createdAt < ?",
    args: [userId, cutoff],
  });
  if (rs.rows.length) await removePhotos(rs.rows);
}

export default async function handler(req, res) {
  try {
    await ensureSchema();
    const me = await currentUser(req);
    if (!me) return deny(res);
    if (!imagesReady()) return res.status(503).json({ error: 'Las fotos no están configuradas en el servidor.' });
    const q = req.query ?? {};

    if (req.method === 'GET') {
      const visitId = parseId(q.visit);
      const r = await readableVisit(me.id, visitId);
      if (!r) return notYours(res);
      const rs = await db.execute({
        sql: "SELECT * FROM photos WHERE visitId = ? AND status = 'ready' ORDER BY position, COALESCE(takenAt, createdAt), id",
        args: [visitId],
      });
      // Un compañero ve las fotos, pero el GPS sigue siendo solo del dueño.
      return res.status(200).json({ photos: rs.rows.map((p) => (r.mine ? publicPhoto(p) : { ...publicPhoto(p), lat: null, lng: null })) });
    }

    if (req.method === 'POST' && q.upload) {
      const body = await readJson(req);
      const visitId = parseId(body.visitId);
      if (!visitId || !(await visitOf(me.id, visitId))) return notYours(res);
      await dropStalePending(me.id);

      const counts = (await db.execute({
        sql: 'SELECT COUNT(*) total, SUM(visitId = ?) inVisit FROM photos WHERE userId = ?',
        args: [visitId, me.id],
      })).rows[0];
      if (Number(counts.total) >= FOTOS_POR_USUARIO) {
        return res.status(409).json({ error: `Llegaste al máximo de ${FOTOS_POR_USUARIO} fotos en tu cuenta.` });
      }
      if (Number(counts.inVisit ?? 0) >= FOTOS_POR_VISITA) {
        return res.status(409).json({ error: `Una visita puede tener hasta ${FOTOS_POR_VISITA} fotos.` });
      }

      const { cfId, uploadURL } = await directUpload({ app: 'traveltime', userId: me.id, visitId });
      const pos = (await db.execute({
        sql: 'SELECT COALESCE(MAX(position), 0) + 1 p FROM photos WHERE visitId = ?',
        args: [visitId],
      })).rows[0].p;
      const lat = num(body.lat, -90, 90);
      const lng = num(body.lng, -180, 180);
      const ins = await db.execute({
        sql: `INSERT INTO photos (userId, visitId, cfId, status, width, height, takenAt, lat, lng, position, createdAt)
              VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          me.id, visitId, cfId,
          num(body.width, 1, 20000), num(body.height, 1, 20000),
          parseTakenAt(body.takenAt),
          // Coordenadas a medias no sirven: o las dos o ninguna.
          lat != null && lng != null ? lat : null, lat != null && lng != null ? lng : null,
          Number(pos), nowIso(),
        ],
      });
      return res.status(201).json({ photo: { id: Number(ins.lastInsertRowid) }, uploadURL });
    }

    if (req.method === 'POST' && q.confirm) {
      const p = await photoOf(me.id, parseId(q.id));
      if (!p) return notYours(res);
      if (p.status !== 'ready') {
        if (!(await isUploaded(p.cfId))) return res.status(409).json({ error: 'La foto todavía no terminó de subir.' });
        await db.execute({ sql: "UPDATE photos SET status = 'ready' WHERE id = ?", args: [p.id] });
        p.status = 'ready';
      }
      return res.status(200).json({ photo: publicPhoto(p) });
    }

    if (req.method === 'PUT') {
      const p = await photoOf(me.id, parseId(q.id));
      if (!p) return notYours(res);
      const caption = clean((await readJson(req)).caption, CAPTION_MAX);
      await db.execute({ sql: 'UPDATE photos SET caption = ? WHERE id = ?', args: [caption, p.id] });
      return res.status(200).json({ photo: publicPhoto({ ...p, caption }) });
    }

    if (req.method === 'DELETE') {
      const p = await photoOf(me.id, parseId(q.id));
      if (!p) return notYours(res);
      await removePhotos([p]);
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST, PUT, DELETE');
    return res.status(405).json({ error: 'Método no permitido.' });
  } catch (err) {
    console.error('[api/photos]', err);
    return res.status(500).json({ error: 'Algo falló en el servidor.' });
  }
}
