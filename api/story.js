// "Escríbelo por mí": un borrador del relato de una visita, escrito por Claude.
//
//  GET  /api/story                  -> { ready, left } si esta disponible y cuantos quedan hoy
//  POST /api/story?visit=12  { notes?, tone? }  -> { blocks, left }
//       tone: cercano | guia | poetico. No guarda nada: el editor muestra el
//       borrador y la persona decide si lo usa.
//
// Solo para visitas propias. Cupo diario por persona (DRAFTS_PER_DAY): cada
// borrador cuesta, y mas con fotos.

import { db, ensureSchema, nowIso } from './_lib/db.js';
import { readJson, cleanText, parseId } from './_lib/http.js';
import { currentUser, deny, notYours } from './_lib/auth.js';
import { signedUrl, imagesReady } from './_lib/images.js';
import { parseStory } from './_lib/story.js';
import { aiReady, buildPrompt, draftStory, toEditorBlocks, DRAFTS_PER_DAY, MAX_PHOTOS, TONES } from './_lib/ai.js';

const today = () => nowIso().slice(0, 10);

async function usedToday(userId) {
  const r = await db.execute({ sql: 'SELECT n FROM ai_usage WHERE userId = ? AND day = ?', args: [userId, today()] });
  return Number(r.rows[0]?.n ?? 0);
}

export default async function handler(req, res) {
  try {
    await ensureSchema();
    const me = await currentUser(req);
    if (!me) return deny(res);
    const q = req.query ?? {};

    if (req.method === 'GET') {
      return res.status(200).json({ ready: aiReady(), left: Math.max(0, DRAFTS_PER_DAY - (await usedToday(me.id))) });
    }

    if (req.method === 'POST') {
      if (!aiReady()) return res.status(503).json({ error: 'La escritura con IA no está configurada todavía.' });
      const id = parseId(q.visit);
      const visit = id && (await db.execute({ sql: 'SELECT * FROM visits WHERE id = ? AND userId = ?', args: [id, me.id] })).rows[0];
      if (!visit) return notYours(res);
      const used = await usedToday(me.id);
      if (used >= DRAFTS_PER_DAY) {
        return res.status(429).json({ error: `Ya usaste los ${DRAFTS_PER_DAY} borradores de hoy. Mañana hay más.` });
      }
      const body = await readJson(req);
      const notes = cleanText(body.notes, 2000);
      const tone = Object.hasOwn(TONES, body.tone) ? body.tone : 'cercano';

      const [photos, pins, trip] = await Promise.all([
        db.execute({
          sql: "SELECT id, cfId, caption, takenAt FROM photos WHERE visitId = ? AND status = 'ready' ORDER BY position, id LIMIT ?",
          args: [id, MAX_PHOTOS],
        }),
        db.execute({ sql: 'SELECT id, name, kind, note FROM pins WHERE visitId = ? ORDER BY id', args: [id] }),
        visit.tripId ? db.execute({ sql: 'SELECT title FROM trips WHERE id = ?', args: [visit.tripId] }) : null,
      ]);
      const photoRows = imagesReady()
        ? photos.rows.map((p) => ({ id: Number(p.id), caption: p.caption ?? null, takenAt: p.takenAt ?? null, url: signedUrl(p.cfId, 'ttcard') }))
        : [];
      const pinRows = pins.rows.map((p) => ({ id: Number(p.id), name: p.name, kind: p.kind, note: p.note ?? null }));

      // El cupo se cuenta antes de llamar: dos pestañas a la vez no se lo saltan.
      await db.execute({
        sql: `INSERT INTO ai_usage (userId, day, n) VALUES (?, ?, 1)
              ON CONFLICT(userId, day) DO UPDATE SET n = n + 1`,
        args: [me.id, today()],
      });
      let raw;
      try {
        raw = await draftStory(buildPrompt({ visit, photos: photoRows, pins: pinRows, trip: trip?.rows[0]?.title, notes, tone }));
      } catch (err) {
        console.error('[api/story] claude:', err.status ?? '', err.message);
        // Si fallo Claude, el intento no cuenta.
        await db.execute({ sql: 'UPDATE ai_usage SET n = MAX(0, n - 1) WHERE userId = ? AND day = ?', args: [me.id, today()] });
        return res.status(502).json({ error: 'No se pudo escribir el borrador ahora. Intenta de nuevo en un rato.' });
      }
      const blocks = toEditorBlocks(raw, { photoIds: new Set(photoRows.map((p) => p.id)), pinIds: new Set(pinRows.map((p) => p.id)) });
      // La misma limpieza que cualquier relato: lo que escribio Claude no entra crudo.
      const story = parseStory({ blocks });
      if (!story.ok || !story.value) return res.status(502).json({ error: 'El borrador salió vacío. Intenta de nuevo.' });
      return res.status(200).json({ blocks: JSON.parse(story.value).blocks, left: Math.max(0, DRAFTS_PER_DAY - used - 1) });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Método no permitido.' });
  } catch (err) {
    console.error('[api/story]', err);
    return res.status(500).json({ error: 'Algo falló en el servidor.' });
  }
}
