// Borrar fotos, en Cloudflare y en la base. Lo usan api/photos.js (una foto) y
// api/visits.js (todas las de una visita que se borra).

import { db } from './db.js';
import { deleteImage } from './images.js';

// Primero Cloudflare: si falla, la fila queda y se puede reintentar. Al reves
// quedaria una imagen huerfana ocupando cupo de la cuenta, sin forma de verla.
export async function removePhotos(rows) {
  for (const p of rows) {
    await deleteImage(p.cfId);
    await db.execute({ sql: 'DELETE FROM photos WHERE id = ?', args: [p.id] });
  }
}
