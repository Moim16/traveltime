// Lo visitado.
//
//  GET /api/marks                     -> { marks: [placeId…] } lo marcado + lo que
//                                        tiene visitas (una visita ya dice "estuve")
//  PUT /api/marks  { placeId, on }    -> marca o desmarca un lugar
//
// Desmarcar un lugar que tiene visitas no lo borra del mapa: las visitas siguen
// ahi. Para que deje de contar hay que borrar las visitas.

import { db, ensureSchema, nowIso } from './_lib/db.js';
import { readJson, parsePlace } from './_lib/http.js';
import { currentUser, deny } from './_lib/auth.js';

export async function marksOf(userId) {
  const rs = await db.execute({
    sql: `SELECT placeId FROM marks WHERE userId = ?
          UNION SELECT placeId FROM visits WHERE userId = ?`,
    args: [userId, userId],
  });
  return rs.rows.map((r) => r.placeId);
}

export default async function handler(req, res) {
  try {
    await ensureSchema();
    const me = await currentUser(req);
    if (!me) return deny(res);

    if (req.method === 'GET') return res.status(200).json({ marks: await marksOf(me.id) });

    if (req.method === 'PUT') {
      const body = await readJson(req);
      const placeId = parsePlace(body.placeId);
      if (!placeId) return res.status(400).json({ error: 'Lugar inválido.' });
      if (body.on) {
        await db.execute({
          sql: 'INSERT OR IGNORE INTO marks (userId, placeId, createdAt) VALUES (?, ?, ?)',
          args: [me.id, placeId, nowIso()],
        });
      } else {
        await db.execute({ sql: 'DELETE FROM marks WHERE userId = ? AND placeId = ?', args: [me.id, placeId] });
      }
      return res.status(200).json({ marks: await marksOf(me.id) });
    }

    res.setHeader('Allow', 'GET, PUT');
    return res.status(405).json({ error: 'Método no permitido.' });
  } catch (err) {
    console.error('[api/marks]', err);
    return res.status(500).json({ error: 'Algo falló en el servidor.' });
  }
}
