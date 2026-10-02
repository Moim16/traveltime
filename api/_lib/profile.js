// El "Sobre mi" del perfil, como en un perfil de viajero: bio, donde vive, que
// idiomas habla, que le gusta de viajar y a donde sueña ir. Todo opcional, todo
// lo escribe la persona sabiendo que se ve en su perfil publico (#/u/usuario).
//
// En la base: texto plano, y languages / interests como JSON de una lista.

import { db } from './db.js';
import { clean } from './http.js';
import { avatarOf } from './avatar.js';

// Las mismas claves en la web y la app (js/profile.js, la app Flutter).
export const INTERESTS = [
  'beach', 'mountain', 'cities', 'food', 'history', 'nature', 'adventure', 'photo',
  'culture', 'nightlife', 'backpacking', 'roadtrip', 'museums', 'coffee', 'wildlife', 'slow',
];
const MAX_LANGS = 6;

const list = (raw) => {
  try {
    const v = JSON.parse(raw ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

/** Lo que se muestra del "Sobre mi". */
export const aboutOf = (u) => ({
  bio: u.bio ?? null,
  livesIn: u.livesIn ?? null,
  languages: list(u.languages),
  interests: list(u.interests).filter((k) => INTERESTS.includes(k)),
  dream: u.dream ?? null,
});

/** Lo que pide la persona -> columnas a guardar, o { error }. Solo lo que viene. */
export function parseAbout(body) {
  const cols = {};
  const text = (key, max) => {
    if (body[key] === undefined) return;
    const v = clean(body[key], max);
    cols[key] = v || null;
  };
  text('livesIn', 60);
  text('dream', 80);
  if (body.bio !== undefined) {
    // La bio admite saltos de linea; clean() los aplasta.
    const bio = String(body.bio ?? '').replace(/\r\n?/g, '\n').replace(/[^\S\n]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    if (bio.length > 500) return { error: `La presentación puede tener hasta 500 caracteres (tiene ${bio.length}).` };
    cols.bio = bio || null;
  }
  if (body.languages !== undefined) {
    if (!Array.isArray(body.languages)) return { error: 'Idiomas inválidos.' };
    const langs = [...new Set(body.languages.map((l) => clean(l, 24)).filter(Boolean))];
    if (langs.length > MAX_LANGS) return { error: `Hasta ${MAX_LANGS} idiomas.` };
    cols.languages = JSON.stringify(langs);
  }
  if (body.interests !== undefined) {
    if (!Array.isArray(body.interests)) return { error: 'Intereses inválidos.' };
    cols.interests = JSON.stringify(INTERESTS.filter((k) => body.interests.includes(k)));
  }
  return { cols };
}

const isoOfPlace = 'substr(placeId, 1, 3)';

/** Las cifras de MI perfil (lo privado incluido: solo las ve el dueño). */
export async function myStats(userId) {
  const [places, visits, photos, wishes] = await Promise.all([
    db.execute({
      sql: `SELECT COUNT(DISTINCT ${isoOfPlace}) countries,
                   COUNT(DISTINCT CASE WHEN length(placeId) - length(replace(placeId, '.', '')) = 2 THEN placeId END) cities
            FROM (SELECT placeId FROM marks WHERE userId = ? UNION SELECT placeId FROM visits WHERE userId = ?)`,
      args: [userId, userId],
    }),
    db.execute({ sql: 'SELECT COUNT(*) n, COUNT(publishedAt) published FROM visits WHERE userId = ?', args: [userId] }),
    db.execute({ sql: "SELECT COUNT(*) n FROM photos p JOIN visits v ON v.id = p.visitId WHERE v.userId = ? AND p.status = 'ready'", args: [userId] }),
    db.execute({ sql: 'SELECT COUNT(*) n FROM wishes WHERE userId = ?', args: [userId] }),
  ]);
  return {
    countries: Number(places.rows[0].countries),
    cities: Number(places.rows[0].cities),
    visits: Number(visits.rows[0].n),
    published: Number(visits.rows[0].published),
    photos: Number(photos.rows[0].n),
    wishes: Number(wishes.rows[0].n),
  };
}

/** El perfil publico de alguien: solo lo publicado y su "Sobre mi". null si no existe. */
export async function publicProfile(name) {
  const u = (await db.execute({ sql: 'SELECT * FROM users WHERE name = ? COLLATE NOCASE', args: [name] })).rows[0];
  if (!u) return null;
  const s = (await db.execute({
    sql: `SELECT COUNT(*) published, COUNT(DISTINCT ${isoOfPlace}) countries,
                 (SELECT COUNT(*) FROM photos p JOIN visits v2 ON v2.id = p.visitId
                   WHERE v2.userId = ? AND v2.publishedAt IS NOT NULL AND p.status = 'ready') photos
          FROM visits WHERE userId = ? AND publishedAt IS NOT NULL`,
    args: [u.id, u.id],
  })).rows[0];
  return {
    id: Number(u.id),
    name: u.name,
    fullName: u.fullName ?? null,
    avatar: avatarOf(u),
    verified: Boolean(u.googleSub),
    since: u.createdAt,
    about: aboutOf(u),
    stats: { published: Number(s.published), countries: Number(s.countries), photos: Number(s.photos) },
  };
}
